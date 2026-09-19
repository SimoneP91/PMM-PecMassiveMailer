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
import type { ProcessOutcome, ReceiptProcessor } from './receipt-processor';
import { ReceiptSourceAuthError, type ReceiptSourceFactory } from './receipt-source';

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
  public async readOnce(heartbeat?: LeaseHeartbeat): Promise<Record<ProcessOutcome, number>> {
    const { processor, cursors, sources, states, clock, logger, receipts } = this.deps;
    const counts: Record<ProcessOutcome, number> = { stored: 0, duplicate: 0, unmatched: 0, ignored: 0 };

    if ((await states.get(this.mailbox.code)).status === 'SUSPENDED') {
      return counts;
    }
    const cursorKey = `${this.mailbox.code}:${this.imap.receiptsFolder}`;
    const cursor = await cursors.get(cursorKey);
    const source = sources.create(this.mailbox, this.imap);
    try {
      const batch = await source.fetchAfter(cursor.lastUid, receipts.maxPerPoll, cursor.uidValidity);
      for (const mail of batch.mails) {
        if (heartbeat?.isLost() === true) {
          break;
        }
        this.pulse.beat();
        counts[await processor.process(this.mailbox, mail.raw, mail.internalDate)] += 1;
        await cursors.advance(cursorKey, batch.uidValidity, mail.uid, clock.now());
      }
    } catch (error: unknown) {
      if (error instanceof ReceiptSourceAuthError) {
        logger.error({ mailbox: this.mailbox.code }, 'IMAP login refused: suspending the mailbox');
        await states.suspend(this.mailbox.code, 'IMAP_AUTH_REFUSED', error.message, clock.now());

        return counts;
      }
      logger.warn({ err: error, mailbox: this.mailbox.code }, 'receipts folder could not be read');
    } finally {
      await source.close();
    }

    if (counts.stored + counts.duplicate + counts.unmatched + counts.ignored > 0) {
      logger.info({ mailbox: this.mailbox.code, ...counts }, 'receipts folder read');
    }

    return counts;
  }
}
