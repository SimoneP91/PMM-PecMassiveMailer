import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { AppError } from '../../common/errors/app-error';
import { afterCreatedAt, createdAtKeys, decodeCursor, encodeCursor } from '../../common/http/cursor';
import { createdRange } from '../../common/http/list-query';
import { looksLikeId } from '../../common/ids/id';
import { CLOCK, type Clock } from '../../common/time/clock';
import { asBatchId, type TenantId } from '../../common/types/branded';
import { emptyTally, tallyBatch, tallyByBatch, tallyFrom, type BatchTally } from './batch-counters';
import { BatchLifecycle } from './batch-lifecycle';
import type {
  BatchDetailDto,
  BatchListDto,
  BatchListQuery,
  BatchSummaryDto,
  CancelResultDto,
} from './batch-read.dto';
import { BATCH_MODEL, type BatchDocument } from './schemas/batch.schema';
import { MESSAGE_MODEL, type MessageDocument } from './schemas/message.schema';

const LIST = 'batches';

type BatchCore = BatchListDto['items'][number];

/**
 * The read side of batches, plus cancellation. Every query starts from the
 * tenant: an id of another tenant is indistinguishable from an id that does
 * not exist.
 */
@Injectable()
export class BatchQueryService {
  public constructor(
    @InjectModel(BATCH_MODEL) private readonly batches: Model<BatchDocument>,
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly lifecycle: BatchLifecycle,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BatchQueryService.name);
  }

  public async list(tenantId: TenantId, query: BatchListQuery): Promise<BatchListDto> {
    const filter: Record<string, unknown> = {
      tenantId,
      ...(query.status === undefined ? {} : { status: { $in: query.status } }),
      ...(query.reference === undefined ? {} : { reference: { $in: query.reference } }),
      ...(query.subTenant === undefined ? {} : { subTenant: { $in: query.subTenant } }),
      ...(query.mailbox === undefined ? {} : { mailbox: query.mailbox }),
      ...createdRange(query.createdFrom, query.createdBefore),
    };
    if (query.cursor !== undefined) {
      const { createdAt, id } = createdAtKeys(decodeCursor(LIST, query.cursor));
      Object.assign(filter, afterCreatedAt(createdAt, id));
    }

    const found = await this.batches
      .find(filter, { template: 0, parts: 0, warnings: 0 })
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean();
    const page = found.slice(0, query.limit);
    const tallies = await tallyByBatch(
      this.messages,
      page.map((batch) => batch._id),
    );
    const last = page.at(-1);

    return {
      items: page.map((batch) => this.core(batch, tallies.get(batch._id) ?? emptyTally())),
      ...(found.length > query.limit && last !== undefined
        ? { nextCursor: encodeCursor(LIST, [last.createdAt.toISOString(), last._id]) }
        : {}),
    };
  }

  public async get(tenantId: TenantId, rawId: string): Promise<BatchDetailDto> {
    const batch = await this.find(tenantId, rawId);
    const tally = await tallyBatch(this.messages, batch._id);

    return {
      ...this.core(batch, tally),
      rejectedMessages: [...batch.rejectedMessages],
      warnings: [...batch.warnings],
      ...(batch.sendingStartedAt === undefined
        ? {}
        : { sendingStartedAt: batch.sendingStartedAt.toISOString() }),
      ...(batch.cancelRequestedAt === undefined
        ? {}
        : { cancelRequestedAt: batch.cancelRequestedAt.toISOString() }),
      ...(batch.cancelledAt === undefined ? {} : { cancelledAt: batch.cancelledAt.toISOString() }),
    };
  }

  public async summary(tenantId: TenantId, rawId: string): Promise<BatchSummaryDto> {
    const batch = await this.find(tenantId, rawId);
    const rows = await this.messages.aggregate<{
      _id: { subTenant: string | null; status: string };
      count: number;
    }>([
      { $match: { tenantId, batchId: batch._id } },
      {
        $group: {
          _id: { subTenant: { $ifNull: ['$subTenant', null] }, status: '$status' },
          count: { $sum: 1 },
        },
      },
    ]);
    const groups = new Map<string | null, { status: string; count: number }[]>();
    for (const row of rows) {
      const list = groups.get(row._id.subTenant) ?? [];
      list.push({ status: row._id.status, count: row.count });
      groups.set(row._id.subTenant, list);
    }

    return {
      batchId: batch._id,
      groupBy: 'subTenant',
      groups: [...groups.entries()]
        // Named groups in order, messages without a subTenant last.
        .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
        .map(([subTenant, list]) => ({ subTenant, counters: tallyFrom(list).counters })),
    };
  }

  /**
   * Cancels what has not left: PENDING and RETRY_SCHEDULED messages. A
   * message being sent right now is left alone - an SMTP dialogue is never
   * cut - and so is anything already sent. Repeating the call is harmless.
   */
  public async cancel(tenantId: TenantId, rawId: string): Promise<CancelResultDto> {
    const batch = await this.find(tenantId, rawId);
    const now = this.clock.now();

    const result = await this.messages.updateMany(
      { tenantId, batchId: batch._id, status: { $in: ['PENDING', 'RETRY_SCHEDULED'] } },
      // Cancelled is final: nothing to wait for.
      { $set: { status: 'CANCELLED', cancelledAt: now, settlement: 'SETTLED', settledAt: now } },
    );
    await this.batches.updateOne(
      { _id: batch._id, cancelRequestedAt: { $exists: false } },
      { $set: { cancelRequestedAt: now } },
    );
    await this.lifecycle.completeIfDone(batch._id, now);

    const after = await this.batches.findOne({ _id: batch._id, tenantId }, { status: 1 }).lean();
    const { counters } = await tallyBatch(this.messages, batch._id);
    if (result.modifiedCount > 0) {
      this.logger.info(
        { tenantId, batchId: batch._id, cancelled: result.modifiedCount },
        'batch cancelled by the client',
      );
    }

    return {
      batchId: batch._id,
      status: after?.status ?? batch.status,
      cancelled: result.modifiedCount,
      counters,
    };
  }

  private async find(tenantId: TenantId, rawId: string): Promise<BatchDocument> {
    const batch = looksLikeId(rawId, 'b')
      ? await this.batches.findOne({ _id: asBatchId(rawId), tenantId }, { template: 0, parts: 0 }).lean()
      : null;
    if (batch === null) {
      throw AppError.notFound('BATCH_NOT_FOUND', 'Batch not found');
    }

    return batch;
  }

  private core(batch: BatchDocument, tally: BatchTally): BatchCore {
    return {
      batchId: batch._id,
      status: batch.status,
      mailbox: batch.mailbox,
      ...(batch.reference === undefined ? {} : { reference: batch.reference }),
      ...(batch.subTenant === undefined ? {} : { subTenant: batch.subTenant }),
      messageCount: batch.messageCount,
      rejected: batch.rejectedMessages.length,
      counters: tally.counters,
      settlement: tally.settlement,
      createdAt: batch.createdAt.toISOString(),
      ...(batch.sentAt === undefined ? {} : { sentAt: batch.sentAt.toISOString() }),
      ...(batch.settledAt === undefined ? {} : { settledAt: batch.settledAt.toISOString() }),
    };
  }
}
