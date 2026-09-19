import type { PinoLogger } from 'nestjs-pino';

import type { Clock } from '../../common/time/clock';
import type { ResolvedImap, ResolvedMailbox } from '../../config/config.loader';
import type { ReceiptsConfig, SendingConfig } from '../../config/pecmailer-config.schema';
import type { MailboxStateStore } from '../mailboxes/mailbox-state.store';
import { LeaseHeartbeat } from '../sending/lease-heartbeat';
import type { MailboxLeaseService } from '../sending/mailbox-lease.service';
import { LoopPulse } from '../sending/loop-pulse';
import type { Sleeper } from '../sending/sleeper';
import type { ImapCursorStore } from './imap-cursor.store';
import { mayBeReceipt } from './receipt-parser';
import type { ProcessOutcome, ReceiptProcessor } from './receipt-processor';
import { ReceiptSourceAuthError, type ReceiptSourceFactory, type SourceMail } from './receipt-source';

export type ReadOutcome = ProcessOutcome | 'skipped';

const MAX_FAILURES = 3;

/** Ends a pass early, already logged: the mail in hand is retried on the next pass. */
class PassInterrupted extends Error {}

export interface ReceiptReaderDeps {
  readonly processor: ReceiptProcessor;
  readonly cursors: ImapCursorStore;
  readonly sources: ReceiptSourceFactory;
  readonly leases: MailboxLeaseService;
  readonly states: MailboxStateStore;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly receipts: ReceiptsConfig;
  readonly sending: SendingConfig;
  readonly workerId: string;
  readonly logger: PinoLogger;
}

/**
 * Reads the receipts folder of one mailbox, forever, one worker at a time
 * (lease "receipts:<code>", separate from the sending lease so a slow read
 * never delays a send). Each read resumes after the last UID processed.
 */
export class ReceiptReader {
  private readonly pulse: LoopPulse;
  /** Consecutive failures per UID of the folder being read. */
  private readonly failures = new Map<number, number>();

  public constructor(
    private readonly mailbox: ResolvedMailbox,
    private readonly imap: ResolvedImap,
    private readonly deps: ReceiptReaderDeps,
  ) {
    this.pulse = new LoopPulse(deps.clock);
  }

  public get lastTick(): Date {
    return this.pulse.freshAt();
  }

  public async run(signal: AbortSignal): Promise<void> {
    const { leases, sleeper, sending, workerId, logger, clock } = this.deps;
    const key = `receipts:${this.mailbox.code}`;
    const ttlMs = sending.leaseTtlSeconds * 1000;

    while (!signal.aborted) {
      this.pulse.beat();
      if (!(await leases.tryAcquire(key, workerId, ttlMs, clock.now()))) {
        await this.pulse.sleep(sleeper, ttlMs / 2, signal);
        continue;
      }
      const heartbeat = new LeaseHeartbeat(key, ttlMs, this.deps);
      try {
        await this.serve(signal, heartbeat);
      } catch (error: unknown) {
        logger.error(
          { err: error, mailbox: this.mailbox.code },
          'receipt reader failed; releasing the lease',
        );
        await this.pulse.sleep(sleeper, Math.min(ttlMs, 10_000), signal);
      } finally {
        heartbeat.stop();
        await leases.release(key, workerId).catch(() => undefined);
      }
    }
  }

  private async serve(signal: AbortSignal, heartbeat: LeaseHeartbeat): Promise<void> {
    while (!signal.aborted && !heartbeat.isLost()) {
      this.pulse.beat();
      await this.readOnce(heartbeat);
      await this.pulse.sleep(this.deps.sleeper, this.deps.receipts.pollIntervalSeconds * 1000, signal);
    }
  }

  /** One pass over the new mails. Public for tests and for a manual read. */
  public async readOnce(heartbeat?: LeaseHeartbeat): Promise<Record<ReadOutcome, number>> {
    const { cursors, sources, states, clock, logger, receipts } = this.deps;
    const counts: Record<ReadOutcome, number> = {
      stored: 0,
      duplicate: 0,
      unmatched: 0,
      ignored: 0,
      skipped: 0,
    };

    const state = await states.get(this.mailbox.code);
    if (state.status === 'SUSPENDED' && state.cause !== 'OPERATOR') {
      // A refused login: one more attempt could get the account locked by the provider.
      // An operator's pause stops sending only; reading is harmless and keeps outcomes coming.
      return counts;
    }
    const cursorKey = `${this.mailbox.code}:${this.imap.receiptsFolder}`;
    const cursor = await cursors.get(cursorKey);
    // Without a usable cursor, look back over the settlement window (plus a day), not the whole folder.
    const since = new Date(clock.now().getTime() - (receipts.settleAfterHours + 24) * 3_600_000);

    try {
      await sources
        .create(this.mailbox, this.imap)
        .read(
          { afterUid: cursor.lastUid, uidValidity: cursor.uidValidity, since, max: receipts.maxPerPoll },
          async (mail, uidValidity) => {
            if (heartbeat?.isLost() === true) {
              return false;
            }
            this.pulse.beat();
            counts[await this.handle(mail)] += 1;
            await cursors.advance(cursorKey, uidValidity, mail.uid, clock.now());

            return true;
          },
        );
    } catch (error: unknown) {
      if (error instanceof ReceiptSourceAuthError) {
        logger.error({ mailbox: this.mailbox.code }, 'IMAP login refused: suspending the mailbox');
        await states.suspend(this.mailbox.code, 'IMAP_AUTH_REFUSED', error.message, clock.now());
      } else if (!(error instanceof PassInterrupted)) {
        logger.warn({ err: error, mailbox: this.mailbox.code }, 'receipts folder could not be read');
      }
    }

    if (Object.values(counts).some((count) => count > 0)) {
      logger.info({ mailbox: this.mailbox.code, ...counts }, 'receipts folder read');
    }

    return counts;
  }

  /**
   * One mail: a quick look at its top-level headers, the body only for what
   * may be a receipt. A mail that fails MAX_FAILURES passes in a row is
   * skipped with an error in the log, so it cannot hold back every receipt
   * that arrived after it.
   */
  private async handle(mail: SourceMail): Promise<ReadOutcome> {
    if (!mayBeReceipt(mail.headers)) {
      return 'ignored';
    }
    const { processor, logger } = this.deps;
    try {
      const outcome = await processor.process(this.mailbox, await mail.body(), mail.internalDate);
      this.failures.delete(mail.uid);

      return outcome;
    } catch (error: unknown) {
      const failures = (this.failures.get(mail.uid) ?? 0) + 1;
      if (failures < MAX_FAILURES) {
        this.failures.set(mail.uid, failures);
        logger.warn(
          { err: error, mailbox: this.mailbox.code, uid: mail.uid, failures },
          'mail could not be processed; retried on the next pass',
        );
        throw new PassInterrupted();
      }
      this.failures.delete(mail.uid);
      logger.error(
        { err: error, mailbox: this.mailbox.code, uid: mail.uid, failures },
        'mail skipped after repeated failures: if it is a receipt, its outcome is not recorded',
      );

      return 'skipped';
    }
  }
}
