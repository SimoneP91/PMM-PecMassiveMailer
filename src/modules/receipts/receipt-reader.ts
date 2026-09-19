import type { Logger } from '../../common/logger';
import type { Clock } from '../../common/time/clock';
import type { ResolvedImap, ResolvedMailbox } from '../../config/config';
import type { Queues } from '../../queue/queues';
import type { MailboxSuspension } from '../sending/mailbox-suspension';
import { idFromMessageId } from '../sending/mime/eml-builder';
import { LoopPulse } from '../sending/loop-pulse';
import type { OutcomeEvents } from '../sending/outcome-events';
import type { Sleeper } from '../sending/sleeper';
import { mayBeReceipt, parseReceipt } from './receipt-parser';
import { ReceiptSourceAuthError, type ReceiptSourceFactory, type SourceMail } from './receipt-source';

export interface ReceiptReaderDeps {
  readonly mailbox: ResolvedMailbox;
  readonly imap: ResolvedImap;
  readonly sources: ReceiptSourceFactory;
  readonly queues: Pick<Queues, 'publish'>;
  readonly events: OutcomeEvents;
  readonly suspension: MailboxSuspension;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly logger: Logger;
  readonly settings: {
    readonly pollIntervalSeconds: number;
    readonly lookbackHours: number;
    readonly maxPerPoll: number;
  };
  readonly signal: AbortSignal;
}

/**
 * What became of each mail of the folder:
 * - published: a receipt of one of our PECs, now in the output queue;
 * - notOurs: a receipt about a message this service did not send (sent by
 *   hand, or by the old system);
 * - ignored: not a receipt (ordinary PEC, transport envelope, anything else);
 * - skipped: could not be read three times in a row, given up.
 */
export type ReadOutcome = 'published' | 'notOurs' | 'ignored' | 'skipped';

const MAX_FAILURES = 3;

/** Ends a pass early; the mail in hand is read again at the next pass. */
class PassInterrupted extends Error {}

/**
 * Reads the receipts folder of the mailbox and puts every receipt of our PECs
 * in the output queue, whole: the receipt is the legal proof, and this
 * service keeps no copy.
 *
 * - The folder is opened read-only and nothing in it changes.
 * - Only mails whose two top-level headers say "receipt" are downloaded.
 * - A receipt is ours when the Message-ID it quotes is one of ours
 *   (<pm.{id}@...>): the id inside is the sender's, returned in the event.
 * - The cursor (the last UID read) lives in memory. A container keeps
 *   nothing, so at every start the last `lookbackHours` are read again: the
 *   events come out a second time, with the same eventId, and the consumer
 *   discards them.
 * - A receipt that cannot be published (RabbitMQ unreachable) is read again
 *   at the next pass, for as long as it takes: it is never skipped for that.
 */
export class ReceiptReader {
  private cursor: { readonly uidValidity: string | undefined; readonly lastUid: number } = {
    uidValidity: undefined,
    lastUid: 0,
  };
  private readonly failures = new Map<number, number>();
  private readonly pulse: LoopPulse;

  public constructor(private readonly deps: ReceiptReaderDeps) {
    this.pulse = new LoopPulse(deps.clock);
  }

  /** Reads the folder every pollIntervalSeconds, until the signal trips. */
  public async run(): Promise<void> {
    const { signal, sleeper, settings, logger } = this.deps;
    while (!signal.aborted) {
      this.pulse.beat();
      if (this.deps.suspension.cause === undefined) {
        try {
          await this.readOnce();
        } catch (error: unknown) {
          logger.error({ err: error }, 'receipt reading failed; trying again at the next pass');
        }
      }
      await this.pulse.sleep(sleeper, settings.pollIntervalSeconds * 1000, signal);
    }
  }

  /** false when a pass has been stuck for far longer than any legitimate one: the liveness probe restarts. */
  public isAlive(): boolean {
    const stalledAfterMs = (this.deps.settings.pollIntervalSeconds + 15 * 60) * 1000;

    return this.deps.clock.now().getTime() - this.pulse.freshAt().getTime() < stalledAfterMs;
  }

  /** One pass over the new mails of the folder. */
  public async readOnce(): Promise<Record<ReadOutcome, number>> {
    const { sources, mailbox, imap, clock, settings, suspension, signal, logger } = this.deps;
    const counts: Record<ReadOutcome, number> = { published: 0, notOurs: 0, ignored: 0, skipped: 0 };
    const since = new Date(clock.now().getTime() - settings.lookbackHours * 3_600_000);

    try {
      await sources.create(mailbox, imap).read(
        {
          afterUid: this.cursor.lastUid,
          uidValidity: this.cursor.uidValidity,
          since,
          max: settings.maxPerPoll,
        },
        async (mail, uidValidity) => {
          if (signal.aborted || suspension.cause !== undefined) {
            return false;
          }
          this.pulse.beat();
          counts[await this.handle(mail)] += 1;
          this.cursor = { uidValidity, lastUid: mail.uid };

          return true;
        },
      );
    } catch (error: unknown) {
      if (error instanceof ReceiptSourceAuthError) {
        await suspension.suspend('IMAP_AUTH_REFUSED', error.message);
      } else if (!(error instanceof PassInterrupted)) {
        logger.warn({ err: error }, 'the receipts folder could not be read; trying again at the next pass');
      }
    }

    if (counts.published + counts.skipped > 0) {
      logger.info(counts, 'receipts folder read');
    }

    return counts;
  }

  private async handle(mail: SourceMail): Promise<ReadOutcome> {
    const { queues, events, clock, logger } = this.deps;
    if (!mayBeReceipt(mail.headers)) {
      return 'ignored';
    }

    let parsed;
    let raw: Buffer;
    try {
      raw = await mail.body();
      parsed = await parseReceipt(raw);
    } catch (error: unknown) {
      return this.failed(mail.uid, error);
    }
    this.failures.delete(mail.uid);
    if (parsed.kind === 'ignored') {
      return 'ignored';
    }
    const id = idFromMessageId(parsed.refMessageId);
    if (id === undefined) {
      return 'notOurs';
    }

    try {
      await queues.publish(events.receipt(id, parsed, raw, mail.internalDate ?? clock.now()));
    } catch (error: unknown) {
      // RabbitMQ, not the mail: read it again next time, never skip it for this.
      logger.warn(
        { err: error, id, receiptType: parsed.type },
        'receipt not published; reading it again at the next pass',
      );
      throw new PassInterrupted();
    }
    logger.info({ id, receiptType: parsed.type }, 'receipt published');

    return 'published';
  }

  /** A mail that cannot be downloaded or read: retried at the next passes, then given up so it does not hold back the others. */
  private failed(uid: number, error: unknown): ReadOutcome {
    const failures = (this.failures.get(uid) ?? 0) + 1;
    if (failures < MAX_FAILURES) {
      this.failures.set(uid, failures);
      this.deps.logger.warn(
        { err: error, uid, failures },
        'mail of the receipts folder not readable; trying again at the next pass',
      );
      throw new PassInterrupted();
    }
    this.failures.delete(uid);
    this.deps.logger.error(
      { err: error, uid, failures },
      'mail of the receipts folder skipped after repeated failures: if it is a receipt, it is not published',
    );

    return 'skipped';
  }
}
