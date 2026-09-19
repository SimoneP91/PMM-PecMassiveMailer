import { readFile } from 'node:fs/promises';

import type { PinoLogger } from 'nestjs-pino';

import type { Clock } from '../../common/time/clock';
import type { MessageId } from '../../common/types/branded';
import type { ResolvedMailbox } from '../../config/config.loader';
import type { SendingConfig } from '../../config/pecmailer-config.schema';
import type { MessageDocument, MessageError } from '../batches/schemas/message.schema';
import type { MailboxStateStore } from '../mailboxes/mailbox-state.store';
import type { SentArchiver, SentArchiverFactory } from './imap/sent-archiver';
import { LeaseHeartbeat } from './lease-heartbeat';
import type { MailboxLeaseService } from './mailbox-lease.service';
import type { MailboxPacer } from './mailbox-pacer';
import type { AttemptReport, EmlRecord, MessageQueueRepository } from './message-queue.repository';
import type { BuiltEml, EmlBuilder } from './mime/eml-builder';
import { LoopPulse } from './loop-pulse';
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

/** "250 2.0.0 Ok" -> 250 */
function replyCode(response: string | undefined): number | undefined {
  const match = /^(\d{3})/.exec(response ?? '');

  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emlRecord(built: BuiltEml): EmlRecord {
  return {
    messageIdHeader: built.messageIdHeader,
    emlPath: built.relativePath,
    emlSha256: built.sha256,
    emlSize: built.size,
  };
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
  private readonly pulse: LoopPulse;
  private setInFlight: (id: MessageId | undefined) => void = () => undefined;

  public constructor(
    private readonly mailbox: ResolvedMailbox,
    private readonly deps: MailboxSenderDeps,
  ) {
    this.pulse = new LoopPulse(deps.clock);
  }

  public get code(): string {
    return this.mailbox.code;
  }

  /** When the loop last did something: what the liveness probe reports. */
  public get lastTick(): Date {
    return this.pulse.freshAt();
  }

  public async run(signal: AbortSignal): Promise<void> {
    const { leases, sleeper, config, workerId, logger } = this.deps;
    const ttlMs = config.leaseTtlSeconds * 1000;

    while (!signal.aborted) {
      this.tick();
      const acquired = await leases.tryAcquire(this.mailbox.code, workerId, ttlMs, this.deps.clock.now());
      if (!acquired) {
        await this.pulse.sleep(sleeper, ttlMs / 2, signal);
        continue;
      }
      logger.info({ mailbox: this.mailbox.code }, 'mailbox lease acquired');
      let inFlight: MessageId | undefined;
      // Keeps the lease and, while one is being sent, the message alive.
      const heartbeat = new LeaseHeartbeat(this.mailbox.code, ttlMs, this.deps, async (now) => {
        if (inFlight !== undefined) {
          await this.deps.queue.heartbeat(inFlight, workerId, now);
        }
      });
      this.setInFlight = (id): void => {
        inFlight = id;
      };
      try {
        await this.serve(signal, heartbeat);
      } catch (error: unknown) {
        logger.error({ err: error, mailbox: this.mailbox.code }, 'mailbox loop failed; releasing the lease');
        await this.pulse.sleep(sleeper, Math.min(ttlMs, 10_000), signal);
      } finally {
        heartbeat.stop();
        await this.closeClients();
        // release() only deletes a lease we still own, so it is safe even if it was lost.
        await leases.release(this.mailbox.code, workerId).catch(() => undefined);
        logger.info({ mailbox: this.mailbox.code }, 'mailbox lease released');
      }
    }
  }

  private async serve(signal: AbortSignal, heartbeat: LeaseHeartbeat): Promise<void> {
    const { queue, pacer, states, sleeper, config, workerId, clock, logger } = this.deps;

    while (!signal.aborted && !heartbeat.isLost()) {
      this.tick();
      const now = clock.now();

      const state = await states.get(this.mailbox.code);
      if (state.status === 'SUSPENDED') {
        await this.pulse.sleep(sleeper, config.suspendedRecheckSeconds * 1000, signal);
        continue;
      }

      if (!(await queue.hasPending(this.mailbox.code, now))) {
        // Nothing to send: do not hold an idle connection open on the provider.
        await this.closeSmtp();
        await this.pulse.sleep(sleeper, config.pollIntervalMs, signal);
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
        await this.pulse.sleep(sleeper, Math.min(wait, config.suspendedRecheckSeconds * 1000), signal);
        continue;
      }
      if (heartbeat.isLost()) {
        // The pace wait may have outlived the lease: never claim without it.
        return;
      }

      const message = await queue.claimNext(this.mailbox.code, workerId, clock.now());
      if (message === null) {
        continue;
      }
      this.setInFlight(message._id);
      try {
        await this.sendOne(message);
      } finally {
        this.setInFlight(undefined);
      }
    }
  }

  private async sendOne(message: MessageDocument): Promise<void> {
    const { queue, eml, clock, logger, states } = this.deps;
    const startedAt = message.sendingStartedAt ?? clock.now();
    const log = logger.logger.child({
      mailbox: this.mailbox.code,
      messageId: message._id,
      batchId: message.batchId,
      attempt: message.attempts,
    });

    let built: BuiltEml;
    try {
      built = await eml.build(message, this.mailbox);
    } catch (error: unknown) {
      const now = clock.now();
      log.error({ err: error }, 'message could not be built');
      const failure = { code: 'EML_BUILD_FAILED', detail: errorText(error), at: now };
      await this.scheduleRetryOrFail(message, failure, { startedAt, endedAt: now, ...failure });

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
      await this.closeSmtp();
      if (!(error instanceof SmtpFailure)) {
        log.error({ err: error }, 'unexpected send failure');
        const failure = { code: 'SEND_FAILED', detail: errorText(error), at: now };
        await this.scheduleRetryOrFail(message, failure, { startedAt, endedAt: now, ...failure });

        return;
      }
      const outcome = classifySmtpFailure(error);
      const record: MessageError = { code: outcome.code, detail: outcome.detail, at: now };
      const smtpCode = error.responseCode ?? replyCode(error.response);
      const report: AttemptReport = {
        startedAt,
        endedAt: now,
        code: outcome.code,
        detail: outcome.detail,
        ...(smtpCode === undefined ? {} : { smtpCode }),
      };
      switch (outcome.kind) {
        case 'suspend':
          log.error({ smtp: error.response }, 'login refused: suspending the mailbox');
          await states.suspend(this.mailbox.code, 'SMTP_AUTH_REFUSED', outcome.detail, now);
          await queue.releaseToPending(message._id, now, report);

          return;
        case 'stuck':
          log.error({ smtp: error.response, command: error.command }, 'outcome unknown: message is STUCK');
          await queue.markStuck(message._id, record, report, emlRecord(built));

          return;
        case 'fail':
          log.warn({ smtp: error.response, command: error.command }, 'message refused by the server');
          await queue.markFailed(message._id, record, report);

          return;
        case 'retry':
          log.warn({ smtp: error.response, command: error.command, code: error.code }, 'transient failure');
          await this.scheduleRetryOrFail(message, record, report);

          return;
      }
    }

    const sentAt = clock.now();
    const archiver = this.mailbox.imap === null ? undefined : this.sentArchiver();
    const smtpCode = replyCode(response);
    await queue.markSent(
      message._id,
      {
        ...emlRecord(built),
        sentAt,
        smtpResponse: response,
        sentCopy: archiver === undefined ? 'DISABLED' : 'PENDING',
      },
      { startedAt, endedAt: sentAt, detail: response, ...(smtpCode === undefined ? {} : { smtpCode }) },
    );
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
    error: MessageError,
    report: AttemptReport,
  ): Promise<void> {
    const { queue, config, logger } = this.deps;
    if (message.attempts >= config.maxAttempts) {
      logger.warn(
        { mailbox: this.mailbox.code, messageId: message._id, attempts: message.attempts },
        'no attempts left: message FAILED',
      );
      const code = `${error.code}_MAX_ATTEMPTS`;
      await queue.markFailed(message._id, { ...error, code }, { ...report, code });

      return;
    }
    const backoff = config.retryBackoffSeconds;
    const seconds = backoff[Math.min(message.attempts - 1, backoff.length - 1)] ?? 60;
    await queue.markRetry(message._id, new Date(error.at.getTime() + seconds * 1000), error, report);
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
    this.pulse.beat();
  }
}
