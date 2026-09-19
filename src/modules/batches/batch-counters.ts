import type { ClientSession, Model } from 'mongoose';

import type { BatchId } from '../../common/types/branded';
import type { MessageStatus } from './batch-response.dto';
import type { MessageDocument, SettlementState } from './schemas/message.schema';

/**
 * Per-status counters of a batch, always derived from its messages (index
 * { batchId, status }): nothing to keep in sync, nothing that can drift after
 * a crash. They sum to `total` by construction.
 */
export interface StatusCounters {
  readonly total: number;
  readonly pending: number;
  readonly sending: number;
  readonly retryScheduled: number;
  readonly sent: number;
  readonly accepted: number;
  readonly delivered: number;
  readonly notDelivered: number;
  readonly failed: number;
  readonly stuck: number;
  readonly cancelled: number;
}

/** Whether each message has its final word: a definitive receipt, a failure, a cancel, or a timeout. */
export interface SettlementCounters {
  readonly pending: number;
  readonly settled: number;
  readonly timedOut: number;
}

export interface BatchTally {
  readonly counters: StatusCounters;
  readonly settlement: SettlementCounters;
}

const KEY_OF: Readonly<Record<MessageStatus, Exclude<keyof StatusCounters, 'total'>>> = {
  PENDING: 'pending',
  SENDING: 'sending',
  RETRY_SCHEDULED: 'retryScheduled',
  SENT: 'sent',
  ACCEPTED: 'accepted',
  DELIVERED: 'delivered',
  NOT_DELIVERED: 'notDelivered',
  FAILED: 'failed',
  STUCK: 'stuck',
  CANCELLED: 'cancelled',
};

const SETTLEMENT_KEY_OF: Readonly<Record<SettlementState, keyof SettlementCounters>> = {
  PENDING: 'pending',
  SETTLED: 'settled',
  TIMED_OUT: 'timedOut',
};

/** Still to be decided by the worker or by an operator. */
export const OPEN_STATUSES: readonly MessageStatus[] = ['PENDING', 'SENDING', 'RETRY_SCHEDULED', 'STUCK'];
/** The message reached the provider, or was refused for good. */
export const LEFT_STATUSES: readonly MessageStatus[] = [
  'SENT',
  'ACCEPTED',
  'DELIVERED',
  'NOT_DELIVERED',
  'FAILED',
];

export function emptyCounters(): StatusCounters {
  return {
    total: 0,
    pending: 0,
    sending: 0,
    retryScheduled: 0,
    sent: 0,
    accepted: 0,
    delivered: 0,
    notDelivered: 0,
    failed: 0,
    stuck: 0,
    cancelled: 0,
  };
}

export function emptyTally(): BatchTally {
  return { counters: emptyCounters(), settlement: { pending: 0, settled: 0, timedOut: 0 } };
}

export interface StatusCountRow {
  readonly status: string;
  readonly settlement?: string;
  readonly count: number;
}

export function countersFrom(rows: readonly StatusCountRow[]): StatusCounters {
  return tallyFrom(rows).counters;
}

export function tallyFrom(rows: readonly StatusCountRow[]): BatchTally {
  const counters: Record<keyof StatusCounters, number> = { ...emptyCounters() };
  const settlement: Record<keyof SettlementCounters, number> = { pending: 0, settled: 0, timedOut: 0 };
  for (const row of rows) {
    const key = KEY_OF[row.status as MessageStatus] as keyof StatusCounters | undefined;
    if (key !== undefined) {
      counters[key] += row.count;
    }
    counters.total += row.count;
    const settled = SETTLEMENT_KEY_OF[(row.settlement ?? 'PENDING') as SettlementState] as
      keyof SettlementCounters | undefined;
    if (settled !== undefined) {
      settlement[settled] += row.count;
    }
  }

  return { counters, settlement };
}

interface GroupedRow {
  readonly _id: { readonly batchId: string; readonly status: string; readonly settlement: string };
  readonly count: number;
}

/** Counters of several batches in one aggregation (a page of GET /v1/batches). */
export async function tallyByBatch(
  messages: Model<MessageDocument>,
  batchIds: readonly BatchId[],
  session?: ClientSession,
): Promise<ReadonlyMap<string, BatchTally>> {
  if (batchIds.length === 0) {
    return new Map();
  }
  const aggregation = messages.aggregate<GroupedRow>([
    { $match: { batchId: { $in: [...batchIds] } } },
    {
      $group: {
        _id: { batchId: '$batchId', status: '$status', settlement: '$settlement' },
        count: { $sum: 1 },
      },
    },
  ]);
  const rows = await (session === undefined ? aggregation : aggregation.session(session));
  const perBatch = new Map<string, StatusCountRow[]>();
  for (const row of rows) {
    const list = perBatch.get(row._id.batchId) ?? [];
    list.push({ status: row._id.status, settlement: row._id.settlement, count: row.count });
    perBatch.set(row._id.batchId, list);
  }

  return new Map(batchIds.map((id) => [id, tallyFrom(perBatch.get(id) ?? [])]));
}

export async function tallyBatch(
  messages: Model<MessageDocument>,
  batchId: BatchId,
  session?: ClientSession,
): Promise<BatchTally> {
  return (await tallyByBatch(messages, [batchId], session)).get(batchId) ?? emptyTally();
}
