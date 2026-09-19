import type { AddressInfo } from 'node:net';

import { SMTPServer, type SMTPServerAddress, type SMTPServerSession } from 'smtp-server';

/**
 * A real SMTP server in the test process (nodemailer's own smtp-server),
 * with a behaviour knob per scenario: accept, refuse a login, refuse a
 * recipient permanently or temporarily, or take the message and hang up
 * without a final reply - the case that must end up STUCK.
 */
export type SmtpBehaviour =
  | { readonly kind: 'accept' }
  | { readonly kind: 'refuseAuth' }
  | { readonly kind: 'rejectRecipient'; readonly code: 450 | 550 }
  | { readonly kind: 'rejectData'; readonly code: 452 | 552 }
  | { readonly kind: 'hangAfterData' }
  | { readonly kind: 'closeBeforeData' };

export interface ReceivedMail {
  readonly from: string;
  readonly to: readonly string[];
  readonly raw: string;
  readonly user: string | undefined;
}

export class FakeSmtpServer {
  public behaviour: SmtpBehaviour = { kind: 'accept' };
  public readonly received: ReceivedMail[] = [];
  public authAttempts = 0;
  private readonly server: SMTPServer;
  private listeningPort = 0;

  public constructor(
    private readonly expectedUser = 'solleciti@pec.serfin.example',
    private readonly expectedPassword = 'pw',
  ) {
    this.server = new SMTPServer({
      authOptional: false,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onAuth: (auth, _session, callback) => {
        this.authAttempts += 1;
        if (
          this.behaviour.kind === 'refuseAuth' ||
          auth.username !== expectedUser ||
          auth.password !== expectedPassword
        ) {
          callback(
            Object.assign(new Error('535 5.7.8 Authentication credentials invalid'), { responseCode: 535 }),
          );

          return;
        }
        callback(null, { user: auth.username });
      },
      onRcptTo: (address: SMTPServerAddress, _session, callback) => {
        if (this.behaviour.kind === 'rejectRecipient') {
          const text = this.behaviour.code === 550 ? '5.1.1 No such user' : '4.2.1 Mailbox busy, try later';
          callback(
            Object.assign(new Error(`${String(this.behaviour.code)} ${text}`), {
              responseCode: this.behaviour.code,
            }),
          );

          return;
        }
        if (this.behaviour.kind === 'closeBeforeData') {
          callback(null);

          return;
        }
        callback(null);
      },
      onData: (stream, session: SMTPServerSession, callback) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const behaviour = this.behaviour;
          if (behaviour.kind === 'hangAfterData') {
            // The message was fully received (354 was sent), then the connection dies silently.
            setTimeout(() => {
              (session as unknown as { _socket?: { destroy(): void } })._socket?.destroy();
            }, 50);

            return;
          }
          if (behaviour.kind === 'rejectData') {
            const text =
              behaviour.code === 552 ? '5.3.4 Message too big' : '4.3.1 Insufficient system storage';
            callback(
              Object.assign(new Error(`${String(behaviour.code)} ${text}`), { responseCode: behaviour.code }),
            );

            return;
          }
          this.received.push({
            from: session.envelope.mailFrom === false ? '' : session.envelope.mailFrom.address,
            to: session.envelope.rcptTo.map((rcpt) => rcpt.address),
            raw,
            user: session.user,
          });
          callback(null, `250 2.0.0 Ok: queued as fake-${String(this.received.length)}`);
        });
      },
    });
    this.server.on('error', () => undefined);
  }

  public get port(): number {
    return this.listeningPort;
  }

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(0, '127.0.0.1', () => {
        this.listeningPort = (this.server.server.address() as AddressInfo).port;
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}
