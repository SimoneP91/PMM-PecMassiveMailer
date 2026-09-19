import { readFile } from 'node:fs/promises';

import type { PinoLogger } from 'nestjs-pino';

import type { Clock } from '../../common/time/clock';
import type { ResolvedMailbox } from '../../config/config.loader';
import type { SendingConfig } from '../../config/pecmailer-config.schema';
import type { MessageDocument } from '../batches/schemas/message.schema';
import type { MailboxStateStore } from '../mailboxes/mailbox-state.store';
import type { SentArchiver, SentArchiverFactory } from './imap/sent-archiver';
import type { MailboxLeaseService } from './mailbox-lease.service';
import type { MailboxPacer } from './mailbox-pacer';
import type { MessageQueueRepository } from './message-queue.repository';
import type { EmlBuilder } from './mime/eml-builder';
import type { Sleeper } from './sleeper';
import { SmtpFailure, type SmtpClient, type SmtpClientFactory } from './smtp/smtp-client';
import { classifySmtpFailure } from './smtp/smtp-outcome';

export interface MailboxSenderDeps {
  readonly queue: MessageQueueRepository;
  readonly leases: MailboxLeaseService;
  readonly pacer: MailboxPacer;
  readonly states: MailboxStateStore;
  readonly eml: EmlBuilder;
  readonly smtpFactory: SmtpClientFactory;
  readonly archiverFactory: SentArchiverFactory;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly config: SendingConfig;
  readonly workerId: string;
  readonly logger: PinoLogger;
}

/**
 * The loop that sends one mailbox's messages, one at a time, at the pace the
 * provider allows. It runs only while it holds the mailbox's lease and stops
 * the moment the lease is lost, the mailbox is suspended or the process is
 * asked to shut down. A send in flight is always finished: an SMTP dialogue
 * is never abandoned half-way on purpose.
 */
export class MailboxSender {
  private smtp: SmtpClient | undefined;
  private archiver: SentArchiver | undefined;
  private lastTickAt: Date;

  public constructor(
    private readonly mailbox: ResolvedMailbox,
    private readonly deps: MailboxSenderDeps,
  ) {
    this.lastTickAt = deps.clock.now();
  }

  public get code(): string {
    return this.mailbox.code;
  }

  /** When the loop last did something: what the liveness probe reports. */
  public get lastTick(): Date {
    return this.lastTickAt;
  }

  public async run(signal: AbortSignal): Promise<void> {
    const { leases, sleeper, config, workerId, logger } = this.deps;
    const ttlMs = config.leaseTtlSeconds * 1000;

    while (!signal.aborted) {
      this.tick();
      const acquired = await leases.tryAcquire(this.mailbox.code, workerId, ttlMs, this.deps.clock.now());
      if (!acquired) {
        await sleeper.sleep(ttlMs / 2, signal);
        continue;
      }
      logger.info({ mailbox: this.mailbox.code }, 'mailbox lease acquired');
      try {
        await this.serve(signal, ttlMs);
      } catch (error: unknown) {
        logger.error({ err: error, mailbox: this.mailbox.code }, 'mailbox loop failed; releasing the lease');
        await sleeper.sleep(Math.min(ttlMs, 10_000), signal);
      } finally {
        await this.closeClients();
        await leases.release(this.mailbox.code, workerId).catch(() => undefined);
        logger.info({ mailbox: this.mailbox.code }, 'mailbox lease released');
      }
    }
  }

  private async serve(signal: AbortSignal, ttlMs: number): Promise<void> {
    const { queue, leases, pacer, states, sleeper, config, workerId, clock, logger } = this.deps;
    let renewedAt = clock.now();

    while (!signal.aborted) {
      this.tick();
      const now = clock.now();
      if (now.getTime() - renewedAt.getTime() >= ttlMs / 3) {
        if (!(await leases.renew(this.mailbox.code, workerId, ttlMs, now))) {
          logger.warn({ mailbox: this.mailbox.code }, 'mailbox lease lost');

          return;
        }
        renewedAt = now;
      }

      const state = await states.get(this.mailbox.code);
      if (state.status === 'SUSPENDED') {
        await sleeper.sleep(config.suspendedRecheckSeconds * 1000, signal);
        continue;
      }

      if (!(await queue.hasPending(this.mailbox.code, now))) {
        // Nothing to send: do not hold an idle connection open on the provider.
        await this.closeSmtp();
        await sleeper.sleep(config.pollIntervalMs, signal);
        continue;
      }

      const slot = await pacer.acquireSlot(this.mailbox, signal);
      if (slot === 'aborted') {
        return;
      }
      if (slot === 'dayQuotaReached') {
        const wait = pacer.msUntilNextDay(clock.now());
        logger.warn(
          { mailbox: this.mailbox.code, resumeInMs: wait },
          'daily quota reached; pausing the mailbox',
        );
        await sleeper.sleep(Math.min(wait, config.suspendedRecheckSeconds * 1000), signal);
        continue;
      }

      const message = await queue.claimNext(this.mailbox.code, workerId, clock.now());
      if (message === null) {
        continue;
      }
      await this.sendOne(message);
    }
  }

  private async sendOne(message: MessageDocument): Promise<void> {
    const { queue, eml, clock, logger, states } = this.deps;
    const log = logger.logger.child({
      mailbox: this.mailbox.code,
      messageId: message._id,
      batchId: message.batchId,
      attempt: message.attempts,
    });

    let built;
    try {
      built = await eml.build(message, this.mailbox);
    } catch (error: unknown) {
      const now = clock.now();
      log.error({ err: error }, 'message could not be built');
      await this.scheduleRetryOrFail(message, {
        code: 'EML_BUILD_FAILED',
        detail: errorText(error),
        at: now,
      });

      return;
    }

    const smtp = this.smtpClient();
    let response: string;
    try {
      const result = await smtp.send({
        from: this.mailbox.from.address,
        to: message.to,
        emlPath: built.path,
      });
      response = result.response;
    } catch (error: unknown) {
      const now = clock.now();
      if (!(error instanceof SmtpFailure)) {
        log.error({ err: error }, 'unexpected send failure');
        await this.closeSmtp();
        await this.scheduleRetryOrFail(message, { code: 'SEND_FAILED', detail: errorText(error), at: now });

        return;
      }
      const outcome = classifySmtpFailure(error);
      const record = { code: outcome.code, detail: outcome.detail, at: now };
      await this.closeSmtp();
      switch (outcome.kind) {
        case 'suspend':
          log.error({ smtp: error.response }, 'login refused: suspending the mailbox');
          await states.set(this.mailbox.code, 'SUSPENDED', `SMTP login refused: ${outcome.detail}`, now);
          await queue.releaseToPending(message._id, now);

          return;
        case 'stuck':
          log.error({ smtp: error.response, command: error.command }, 'outcome unknown: message is STUCK');
          await queue.markStuck(message._id, record);

          return;
        case 'fail':
          log.warn({ smtp: error.response, command: error.command }, 'message refused by the server');
          await queue.markFailed(message._id, record);

          return;
        case 'retry':
          log.warn({ smtp: error.response, command: error.command, code: error.code }, 'transient failure');
          await this.scheduleRetryOrFail(message, record);

          return;
      }
    }

    const sentAt = clock.now();
    const archiver = this.mailbox.imap === null ? undefined : this.sentArchiver();
    await queue.markSent(message._id, {
      sentAt,
      messageIdHeader: built.messageIdHeader,
      smtpResponse: response,
      emlPath: built.relativePath,
      sentCopy: archiver === undefined ? 'DISABLED' : 'PENDING',
    });
    log.info({ smtp: response }, 'message sent');

    if (archiver !== undefined) {
      try {
        await archiver.append(await readFile(built.path), sentAt);
        await queue.updateSentCopy(message._id, 'ARCHIVED');
      } catch (error: unknown) {
        log.warn({ err: error }, 'copy not filed in the Sent folder');
        await queue.updateSentCopy(message._id, 'FAILED', errorText(error));
      }
    }
  }

  private async scheduleRetryOrFail(
    message: MessageDocument,
    error: { code: string; detail: string; at: Date },
  ): Promise<void> {
    const { queue, config, logger } = this.deps;
    if (message.attempts >= config.maxAttempts) {
      logger.warn(
        { mailbox: this.mailbox.code, messageId: message._id, attempts: message.attempts },
        'no attempts left: message FAILED',
      );
      await queue.markFailed(message._id, { ...error, code: `${error.code}_MAX_ATTEMPTS` });

      return;
    }
    const backoff = config.retryBackoffSeconds;
    const seconds = backoff[Math.min(message.attempts - 1, backoff.length - 1)] ?? 60;
    await queue.markRetry(message._id, new Date(error.at.getTime() + seconds * 1000), error);
  }

  private smtpClient(): SmtpClient {
    this.smtp ??= this.deps.smtpFactory.create(this.mailbox);

    return this.smtp;
  }

  private sentArchiver(): SentArchiver | undefined {
    if (this.mailbox.imap === null) {
      return undefined;
    }
    this.archiver ??= this.deps.archiverFactory.create(this.mailbox, this.mailbox.imap);

    return this.archiver;
  }

  private async closeSmtp(): Promise<void> {
    const smtp = this.smtp;
    this.smtp = undefined;
    await smtp?.close().catch(() => undefined);
  }

  private async closeClients(): Promise<void> {
    await this.closeSmtp();
    const archiver = this.archiver;
    this.archiver = undefined;
    await archiver?.close().catch(() => undefined);
  }

  private tick(): void {
    this.lastTickAt = this.deps.clock.now();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
