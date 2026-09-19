import type { Logger } from '../../common/logger';
import type { Clock } from '../../common/time/clock';
import type { ResolvedMailbox } from '../../config/config';
import type { HandlerVerdict, InputMessage, OutputEvent, Queues } from '../../queue/queues';
import type { ProofLookup } from '../receipts/sent-proof';
import { ImapAuthError } from './imap/imap-auth-error';
import type { SentArchiver, SentArchiverFactory } from './imap/sent-archiver';
import { messageIdFor, type EmlBuilder } from './mime/eml-builder';
import type { MailboxSuspension } from './mailbox-suspension';
import { problemOf, type OutcomeEvents, type SentCopyState } from './outcome-events';
import type { Pace } from './pace';
import { labelsOf, type PecLabels, type SendRequestChecker } from './send-request';
import type { Sleeper } from './sleeper';
import { SmtpFailure, type SmtpClient, type SmtpClientFactory } from './smtp/smtp-client';
import { classifySmtpFailure } from './smtp/smtp-outcome';

export interface PecSenderDeps {
  readonly mailbox: ResolvedMailbox;
  readonly queues: Pick<Queues, 'publish' | 'returnToQueue'>;
  /** Shared with the receipt reader: a refused login stops both. */
  readonly suspension: MailboxSuspension;
  readonly checker: SendRequestChecker;
  readonly eml: EmlBuilder;
  readonly smtpFactory: SmtpClientFactory;
  /** null when IMAP is off: no Sent copy. */
  readonly archiverFactory: SentArchiverFactory | null;
  /** null when IMAP is off: a redelivered PEC cannot be checked, it is reported uncertain. */
  readonly proof: ProofLookup | null;
  readonly pace: Pace;
  readonly events: OutcomeEvents;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly logger: Logger;
  readonly retryBackoffSeconds: readonly number[];
  readonly redeliveryWaitSeconds: number;
  /** Trips on shutdown: waits are cut short, a PEC not sent yet goes back to the queue. */
  readonly signal: AbortSignal;
}

/** While looking for the receipt of a redelivered PEC: how often the mailbox is searched. */
const PROOF_POLL_MS = 20_000;
/** Connections to the provider are closed when no PEC came for this long. */
const IDLE_CLOSE_MS = 30_000;
/** Longer than the longest legitimate handling (retries fit in 25 minutes): the handler is stuck. */
const STALLED_AFTER_MS = 35 * 60_000;

/**
 * Handles the PECs of one mailbox, one at a time, and reports each outcome
 * on the output queue. The rules, in the order they apply:
 *
 * - a message that cannot be answered (not JSON, no usable id) goes to the
 *   dead-letter queue;
 * - a message that breaks a rule is `rejected`, and nothing is sent;
 * - a message delivered again after an interruption is never sent blindly:
 *   the provider's receipt is looked for; found = `sent`, else `uncertain`;
 * - otherwise it is sent at the mailbox's pace; a temporary failure is
 *   retried, a permanent one is `failed`, a connection lost after the
 *   provider had the message is `uncertain`;
 * - a refused password suspends the mailbox: the PEC in hand goes back to the
 *   queue and no other is taken until the container restarts.
 *
 * The input message is acknowledged only after its outcome is confirmed by
 * RabbitMQ (the queue layer does that when this handler resolves). If
 * publishing fails, the handler throws and the message comes back
 * "redelivered", to be checked rather than resent.
 */
export class PecSender {
  private handlingSince: number | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private smtp: SmtpClient | undefined;
  private archiver: SentArchiver | undefined;

  public constructor(private readonly deps: PecSenderDeps) {}

  /** false when a handling has lasted far longer than any legitimate one: the liveness probe restarts the container. */
  public isAlive(): boolean {
    return (
      this.handlingSince === undefined ||
      this.deps.clock.now().getTime() - this.handlingSince < STALLED_AFTER_MS
    );
  }

  public async handle(message: InputMessage): Promise<HandlerVerdict> {
    const labels = labelsOf(message.body);
    if (labels === undefined) {
      this.deps.logger.warn(
        { redelivered: message.redelivered },
        'input message without a usable id (or not JSON): moved to the dead-letter queue',
      );

      return 'dead';
    }
    if (this.deps.suspension.cause !== undefined) {
      if (message.redelivered) {
        // It may have left: it must not come back as a new message. It stays in the queue.
        throw new Error('mailbox suspended');
      }
      await this.deps.queues.returnToQueue(message.body);

      return 'done';
    }

    this.cancelIdleClose();
    this.handlingSince = this.deps.clock.now().getTime();
    try {
      return message.redelivered
        ? await this.recover(message.body, labels)
        : await this.deliver(message.body, labels);
    } finally {
      this.handlingSince = undefined;
      this.scheduleIdleClose();
    }
  }

  /** Closes the connections to the provider. */
  public async close(): Promise<void> {
    this.cancelIdleClose();
    await this.closeClients();
  }

  private async deliver(body: unknown, labels: PecLabels): Promise<HandlerVerdict> {
    const { checker, eml, mailbox, events, pace, clock, sleeper, logger, retryBackoffSeconds, signal } =
      this.deps;
    const checked = await checker.check(body);
    if (!checked.ok) {
      await this.publish(events.rejected(labels, checked.errors));
      logger.info({ id: labels.id, codes: checked.errors.map((error) => error.code) }, 'PEC rejected');

      return 'done';
    }
    const built = await eml.build(checked.pec, mailbox);
    if (built.raw.length > mailbox.limits.maxMessageBytes) {
      logger.info({ id: labels.id, codes: ['MESSAGE_TOO_LARGE'] }, 'PEC rejected');
      await this.publish(
        events.rejected(labels, [
          {
            path: '',
            code: 'MESSAGE_TOO_LARGE',
            detail: `the PEC is ${String(built.raw.length)} bytes once encoded; the mailbox accepts ${String(mailbox.limits.maxMessageBytes)}`,
          },
        ]),
      );

      return 'done';
    }

    for (let attempt = 1; ; attempt += 1) {
      if (!(await pace.wait(signal))) {
        return this.putBack(body, labels, 'stopping before sending');
      }
      try {
        const result = await this.smtpClient().send({
          from: mailbox.from.address,
          to: checked.pec.to.address,
          raw: built.raw,
        });
        const sentAt = clock.now();
        const copy = await this.fileCopy(built.raw, sentAt);
        await this.publish(
          events.sent(labels, {
            messageId: built.messageIdHeader,
            sentAt: sentAt.toISOString(),
            confirmedBy: 'SMTP',
            smtpResponse: result.response,
            attempts: attempt,
            ...copy,
            warnings: checked.warnings.map(problemOf),
          }),
        );
        logger.info({ id: labels.id, attempts: attempt, sentCopy: copy.sentCopy }, 'PEC sent');

        return 'done';
      } catch (error: unknown) {
        if (!(error instanceof SmtpFailure)) {
          throw error;
        }
        const outcome = classifySmtpFailure(error);
        switch (outcome.kind) {
          case 'suspend':
            await this.deps.suspension.suspend('SMTP_AUTH_REFUSED', outcome.detail);

            return this.putBack(body, labels, 'mailbox suspended before sending');
          case 'stuck':
            await this.publish(
              events.uncertain(labels, {
                messageId: built.messageIdHeader,
                reason: 'CONNECTION_LOST_AFTER_DATA',
                detail: outcome.detail,
              }),
            );
            logger.error(
              { id: labels.id, code: outcome.code },
              'PEC outcome unknown: the provider had it when the connection dropped',
            );

            return 'done';
          case 'fail':
            await this.publish(
              events.failed(labels, {
                code: outcome.code,
                ...(error.responseCode === undefined ? {} : { smtpCode: error.responseCode }),
                detail: outcome.detail,
                attempts: attempt,
              }),
            );
            logger.info({ id: labels.id, code: outcome.code }, 'PEC refused by the provider');

            return 'done';
          case 'retry': {
            const wait = retryBackoffSeconds[attempt - 1];
            if (wait === undefined) {
              await this.publish(
                events.failed(labels, {
                  code: 'RETRIES_EXHAUSTED',
                  ...(error.responseCode === undefined ? {} : { smtpCode: error.responseCode }),
                  detail: `${outcome.code}: ${outcome.detail}`,
                  attempts: attempt,
                }),
              );
              logger.warn(
                { id: labels.id, code: outcome.code, attempts: attempt },
                'PEC not sent: temporary errors lasted too long',
              );

              return 'done';
            }
            logger.warn(
              { id: labels.id, code: outcome.code, attempt, retryInSeconds: wait },
              'temporary failure; retrying',
            );
            await sleeper.sleep(wait * 1000, signal);
            if (signal.aborted) {
              return this.putBack(body, labels, 'stopping between two attempts');
            }
          }
        }
      }
    }
  }

  /**
   * A message delivered again: the previous handling was interrupted and may
   * have sent it. A message that breaks a rule of its own content was
   * certainly never sent; for the others, the provider's receipt decides.
   *
   * The recipient is not judged again: that verdict depends on DNS and on the
   * lists of the day, and a PEC that did leave could fail it now (a DNS
   * timeout, a list changed by a new version). Reported "rejected", it would
   * be sent a second time.
   */
  private async recover(body: unknown, labels: PecLabels): Promise<HandlerVerdict> {
    const { checker, mailbox, events, proof, clock, sleeper, logger, redeliveryWaitSeconds, signal } =
      this.deps;
    const checked = await checker.check(body, { verifyRecipient: false });
    if (!checked.ok) {
      await this.publish(events.rejected(labels, checked.errors));

      return 'done';
    }
    const messageId = messageIdFor(checked.pec.id, mailbox.from.address);
    const uncertain = (detail: string): OutputEvent =>
      events.uncertain(labels, { messageId, reason: 'REDELIVERED_WITHOUT_ACCEPTANCE', detail });

    if (proof === null) {
      await this.publish(
        uncertain('delivered again after an interruption; IMAP is off, so no receipt could be looked for'),
      );

      return 'done';
    }

    const deadline = clock.now().getTime() + redeliveryWaitSeconds * 1000;
    for (;;) {
      let found;
      try {
        found = await proof.find(messageId);
      } catch (error: unknown) {
        if (error instanceof ImapAuthError) {
          await this.deps.suspension.suspend('IMAP_AUTH_REFUSED', error.message);
          await this.publish(
            uncertain('delivered again after an interruption; the mailbox refused the IMAP login'),
          );

          return 'done';
        }
        logger.warn({ err: error, id: labels.id }, 'receipts folder could not be searched; trying again');
        found = undefined;
      }
      if (found !== undefined) {
        await this.publish(
          events.sent(labels, {
            messageId,
            sentAt: (found.issuedAt ?? clock.now()).toISOString(),
            confirmedBy: 'ACCEPTANCE_RECEIPT',
            attempts: 0,
            sentCopy: 'UNKNOWN',
            warnings: checked.warnings.map(problemOf),
          }),
        );
        logger.info(
          { id: labels.id, receipt: found.type },
          'redelivered PEC had already left: confirmed by its receipt',
        );

        return 'done';
      }
      const remaining = deadline - clock.now().getTime();
      if (remaining <= 0) {
        break;
      }
      await sleeper.sleep(Math.min(PROOF_POLL_MS, remaining), signal);
      if (signal.aborted) {
        // Unanswered and possibly sent: back to the queue as it is, still marked redelivered.
        throw new Error('stopping while looking for the receipt of a redelivered PEC');
      }
    }

    await this.publish(
      uncertain(
        `delivered again after an interruption, and no receipt for ${messageId} arrived within ${String(redeliveryWaitSeconds)} s: it may have left`,
      ),
    );
    logger.error({ id: labels.id }, 'redelivered PEC without a receipt: reported uncertain');

    return 'done';
  }

  private async putBack(body: unknown, labels: PecLabels, reason: string): Promise<HandlerVerdict> {
    await this.deps.queues.returnToQueue(body);
    this.deps.logger.info({ id: labels.id, reason }, 'PEC not sent: back in the queue');

    return 'done';
  }

  private async fileCopy(
    raw: Buffer,
    sentAt: Date,
  ): Promise<{ sentCopy: SentCopyState; sentCopyError?: string }> {
    const archiver = this.archiverClient();
    if (archiver === undefined) {
      return { sentCopy: 'DISABLED' };
    }
    try {
      await archiver.append(raw, sentAt);

      return { sentCopy: 'ARCHIVED' };
    } catch (error: unknown) {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      if (error instanceof ImapAuthError) {
        // The PEC left. The refused login stops the mailbox now, before one
        // attempt per PEC gets the account locked.
        await this.deps.suspension.suspend('IMAP_AUTH_REFUSED', detail);
      } else {
        this.deps.logger.warn({ detail }, 'the copy in the Sent folder failed; the PEC left anyway');
      }

      return { sentCopy: 'FAILED', sentCopyError: detail };
    }
  }

  private async publish(event: OutputEvent): Promise<void> {
    await this.deps.queues.publish(event);
  }

  private smtpClient(): SmtpClient {
    this.smtp ??= this.deps.smtpFactory.create(this.deps.mailbox);

    return this.smtp;
  }

  private archiverClient(): SentArchiver | undefined {
    const { archiverFactory, mailbox } = this.deps;
    if (archiverFactory === null || mailbox.imap === null) {
      return undefined;
    }
    this.archiver ??= archiverFactory.create(mailbox, mailbox.imap);

    return this.archiver;
  }

  private scheduleIdleClose(): void {
    this.idleTimer = setTimeout(() => {
      void this.closeClients();
    }, IDLE_CLOSE_MS);
    this.idleTimer.unref();
  }

  private cancelIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private async closeClients(): Promise<void> {
    const smtp = this.smtp;
    const archiver = this.archiver;
    this.smtp = undefined;
    this.archiver = undefined;
    await smtp?.close().catch(() => undefined);
    await archiver?.close().catch(() => undefined);
  }
}
