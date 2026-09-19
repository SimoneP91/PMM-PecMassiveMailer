import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { CLOCK, type Clock } from '../../common/time/clock';
import type { BatchId } from '../../common/types/branded';
import { PECMAILER_CONFIG } from '../../config/config.module';
import type { ResolvedConfig } from '../../config/config.loader';
import { BatchLifecycle } from '../batches/batch-lifecycle';
import { BATCH_MODEL, type BatchDocument } from '../batches/schemas/batch.schema';
import { MESSAGE_MODEL, type MessageDocument } from '../batches/schemas/message.schema';
import { SLEEPER, type Sleeper } from '../sending/sleeper';

const INTERVAL_MS = 60_000;
const BATCHES_PER_RUN = 500;
/** A batch left SENDING this long after its last change may have missed its completion (a crash): check it. */
const RECONCILE_AFTER_MS = 5 * 60_000;

export interface SettlementRun {
  readonly timedOut: number;
  readonly batchesChecked: number;
}

/**
 * Closes what receipts cannot close by themselves:
 *
 *  - a sent message with no final receipt after receipts.settleAfterHours
 *    becomes TIMED_OUT (the PEC rules give providers 24 hours);
 *  - batches whose closing was missed - a worker died between the last
 *    message transition and the batch update - are completed and settled.
 *
 * Every replica runs it; every step is idempotent.
 */
@Injectable()
export class SettlementJob {
  public constructor(
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
    @InjectModel(BATCH_MODEL) private readonly batches: Model<BatchDocument>,
    private readonly lifecycle: BatchLifecycle,
    @Inject(PECMAILER_CONFIG) private readonly config: ResolvedConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SLEEPER) private readonly sleeper: Sleeper,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SettlementJob.name);
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        this.logger.error({ err: error }, 'settlement run failed');
      }
      await this.sleeper.sleep(INTERVAL_MS, signal);
    }
  }

  public async runOnce(): Promise<SettlementRun> {
    const now = this.clock.now();
    const cutoff = new Date(now.getTime() - this.config.receipts.settleAfterHours * 3_600_000);
    const waiting = {
      settlement: 'PENDING' as const,
      status: { $in: ['SENT' as const, 'ACCEPTED' as const] },
      sentAt: { $lt: cutoff },
    };

    const expired = await this.messages.aggregate<{ _id: BatchId }>([
      { $match: waiting },
      { $group: { _id: '$batchId' } },
      { $limit: BATCHES_PER_RUN },
    ]);
    let timedOut = 0;
    for (const { _id: batchId } of expired) {
      const result = await this.messages.updateMany(
        { ...waiting, batchId },
        { $set: { settlement: 'TIMED_OUT', settledAt: now } },
      );
      timedOut += result.modifiedCount;
      await this.lifecycle.settleIfDone(batchId, now);
    }

    const stalled = await this.batches
      .find(
        {
          status: { $in: ['QUEUED', 'SENDING', 'SENT'] },
          updatedAt: { $lt: new Date(now.getTime() - RECONCILE_AFTER_MS) },
        },
        { _id: 1, status: 1 },
      )
      .sort({ updatedAt: 1 })
      .limit(BATCHES_PER_RUN)
      .lean();
    for (const batch of stalled) {
      if (batch.status === 'SENT') {
        await this.lifecycle.settleIfDone(batch._id, now);
      } else {
        await this.lifecycle.completeIfDone(batch._id, now);
      }
    }

    if (timedOut > 0) {
      this.logger.info({ timedOut, batches: expired.length }, 'messages without a final receipt timed out');
    }

    return { timedOut, batchesChecked: expired.length + stalled.length };
  }
}
