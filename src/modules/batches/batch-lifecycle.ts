import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import type { BatchId } from '../../common/types/branded';
import { EventOutbox } from '../events/event-outbox';
import { LEFT_STATUSES, OPEN_STATUSES, tallyBatch } from './batch-counters';
import { BATCH_MODEL, type BatchDocument } from './schemas/batch.schema';
import { MESSAGE_MODEL, type MessageDocument } from './schemas/message.schema';

/**
 * The two closings of a batch, each decided from the messages themselves and
 * committed together with the event that announces it:
 *
 *   QUEUED/SENDING -> SENT       no message open any more      -> batch.sent
 *   QUEUED/SENDING -> CANCELLED  ... and none ever left          (no event: the client asked for it)
 *   SENT -> SETTLED              every message has its final word -> batch.settled
 *
 * Every step is conditioned on the batch still being where it was, so the
 * worker, the receipt reader, the settlement job and the cancel endpoint can
 * all call these at will: the first caller wins, the others do nothing.
 */
@Injectable()
export class BatchLifecycle {
  public constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
    @InjectModel(BATCH_MODEL) private readonly batches: Model<BatchDocument>,
    private readonly outbox: EventOutbox,
  ) {}

  public async completeIfDone(batchId: BatchId, now: Date): Promise<void> {
    const sent = await this.connection.transaction(async (session) => {
      const open = await this.messages
        .exists({ batchId, status: { $in: [...OPEN_STATUSES] } })
        .session(session)
        .lean();
      if (open !== null) {
        return false;
      }
      const left = await this.messages
        .exists({ batchId, status: { $in: [...LEFT_STATUSES] } })
        .session(session)
        .lean();
      const batch = await this.batches
        .findOneAndUpdate(
          { _id: batchId, status: { $in: ['QUEUED', 'SENDING'] } },
          left === null
            ? { $set: { status: 'CANCELLED', cancelledAt: now } }
            : { $set: { status: 'SENT', sentAt: now } },
          { returnDocument: 'after', session },
        )
        .lean();
      if (batch?.status !== 'SENT') {
        return false;
      }
      const tally = await tallyBatch(this.messages, batchId, session);
      await this.outbox.record(
        {
          tenantId: batch.tenantId,
          type: 'batch.sent',
          dedupKey: `batch.sent:${batchId}`,
          occurredAt: now,
          data: { ...this.identity(batch), counters: tally.counters },
        },
        session,
      );

      return true;
    });

    if (sent) {
      // A batch whose messages all failed or were cancelled has nothing to wait for.
      await this.settleIfDone(batchId, now);
    }
  }

  public async settleIfDone(batchId: BatchId, now: Date): Promise<void> {
    await this.connection.transaction(async (session) => {
      const waiting = await this.messages.exists({ batchId, settlement: 'PENDING' }).session(session).lean();
      if (waiting !== null) {
        return;
      }
      const batch = await this.batches
        .findOneAndUpdate(
          { _id: batchId, status: 'SENT' },
          { $set: { status: 'SETTLED', settledAt: now } },
          { returnDocument: 'after', session },
        )
        .lean();
      if (batch === null) {
        return;
      }
      const tally = await tallyBatch(this.messages, batchId, session);
      await this.outbox.record(
        {
          tenantId: batch.tenantId,
          type: 'batch.settled',
          dedupKey: `batch.settled:${batchId}`,
          occurredAt: now,
          data: { ...this.identity(batch), counters: tally.counters, settlement: tally.settlement },
        },
        session,
      );
    });
  }

  /** What identifies a batch in a notification: ids and the client's own labels, never a recipient. */
  private identity(batch: BatchDocument): Record<string, unknown> {
    return {
      batchId: batch._id,
      mailbox: batch.mailbox,
      ...(batch.reference === undefined ? {} : { reference: batch.reference }),
      ...(batch.subTenant === undefined ? {} : { subTenant: batch.subTenant }),
    };
  }
}
