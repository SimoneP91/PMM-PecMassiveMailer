import { createTransport, type NodemailerError, type Transporter } from 'nodemailer';
import type { SMTPSentMessageInfo } from 'nodemailer/lib/smtp-transport';

import type { ResolvedMailbox } from '../../../config/config';

export interface SmtpSendInput {
  readonly from: string;
  readonly to: string;
  /** The whole message, exactly as it will be transmitted. */
  readonly raw: Buffer;
}

export interface SmtpSendResult {
  /** The server's final reply, e.g. "250 2.0.0 Ok: queued as ..." */
  readonly response: string;
  readonly accepted: readonly string[];
}

/**
 * What the sender needs to know about a failed attempt. `dataAccepted` is
 * the crucial bit: once the server has answered 354 to DATA and taken the
 * message, a lost connection no longer means "not sent".
 */
export class SmtpFailure extends Error {
  public constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly command: string | undefined,
    public readonly responseCode: number | undefined,
    public readonly response: string | undefined,
    public readonly dataAccepted: boolean,
    public readonly finalReplyReceived: boolean,
  ) {
    super(message);
    this.name = 'SmtpFailure';
  }
}

export interface SmtpClient {
  send(input: SmtpSendInput): Promise<SmtpSendResult>;
  /** Connects and authenticates without sending: the probe command and the readiness of a mailbox. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface SmtpClientFactory {
  create(mailbox: ResolvedMailbox): SmtpClient;
}

/**
 * Watches the SMTP dialogue through nodemailer's transaction log, which is
 * the only place the client/server exchange is visible from outside the
 * connection. Reset before each message; one message at a time per client.
 */
class ProtocolObserver {
  public dataAccepted = false;
  public finalReplyReceived = false;

  public reset(): void {
    this.dataAccepted = false;
    this.finalReplyReceived = false;
  }

  public readonly logger = {
    trace: (): void => undefined,
    info: (): void => undefined,
    warn: (): void => undefined,
    error: (): void => undefined,
    fatal: (): void => undefined,
    debug: (entry: unknown, line: unknown): void => {
      if (typeof line !== 'string' || (entry as { tnx?: unknown } | undefined)?.tnx !== 'server') {
        return;
      }
      if (line.startsWith('354')) {
        this.dataAccepted = true;
      } else if (this.dataAccepted && /^\d{3}[ -]/.test(line)) {
        this.finalReplyReceived = true;
      }
    },
  };
}

class NodemailerSmtpClient implements SmtpClient {
  private readonly observer = new ProtocolObserver();
  private readonly transporter: Transporter<SMTPSentMessageInfo>;

  public constructor(mailbox: ResolvedMailbox) {
    const timeoutMs = mailbox.smtp.timeoutSeconds * 1000;
    this.transporter = createTransport({
      pool: true,
      maxConnections: 1,
      maxMessages: 100,
      host: mailbox.smtp.host,
      port: mailbox.smtp.port,
      secure: mailbox.smtp.security === 'tls',
      requireTLS: mailbox.smtp.security === 'starttls',
      ignoreTLS: mailbox.smtp.security === 'none',
      auth: { user: mailbox.smtp.username, pass: mailbox.smtp.password.reveal() },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      // transactionLog (not debug): commands and replies, never the message body.
      transactionLog: true,
      logger: this.observer.logger,
      name: 'pecmailer',
    });
  }

  public async send(input: SmtpSendInput): Promise<SmtpSendResult> {
    this.observer.reset();
    try {
      const info = await this.transporter.sendMail({
        envelope: { from: input.from, to: [input.to] },
        raw: input.raw,
      });

      return { response: info.response ?? '', accepted: info.accepted };
    } catch (error: unknown) {
      throw this.toFailure(error);
    }
  }

  public async verify(): Promise<void> {
    try {
      await this.transporter.verify();
    } catch (error: unknown) {
      throw this.toFailure(error);
    }
  }

  public close(): Promise<void> {
    this.transporter.close();

    return Promise.resolve();
  }

  private toFailure(error: unknown): SmtpFailure {
    const e = (error ?? {}) as NodemailerError;

    return new SmtpFailure(
      e.message || 'SMTP failure',
      e.code,
      e.command,
      typeof e.responseCode === 'number' ? e.responseCode : undefined,
      e.response,
      this.observer.dataAccepted,
      this.observer.finalReplyReceived,
    );
  }
}

export class NodemailerSmtpClientFactory implements SmtpClientFactory {
  public create(mailbox: ResolvedMailbox): SmtpClient {
    return new NodemailerSmtpClient(mailbox);
  }
}
