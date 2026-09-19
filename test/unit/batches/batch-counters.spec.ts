import { describe, expect, it } from 'vitest';

import {
  countersFrom,
  emptyCounters,
  LEFT_STATUSES,
  OPEN_STATUSES,
} from '../../../src/modules/batches/batch-counters';
import { messageStatusSchema } from '../../../src/modules/batches/batch-response.dto';

describe('countersFrom', () => {
  it('maps every status to its counter and sums to total', () => {
    const counters = countersFrom([
      { status: 'PENDING', count: 3 },
      { status: 'SENDING', count: 1 },
      { status: 'RETRY_SCHEDULED', count: 2 },
      { status: 'SENT', count: 5 },
      { status: 'NOT_DELIVERED', count: 1 },
      { status: 'STUCK', count: 1 },
      { status: 'CANCELLED', count: 4 },
    ]);

    expect(counters).toEqual({
      ...emptyCounters(),
      total: 17,
      pending: 3,
      sending: 1,
      retryScheduled: 2,
      sent: 5,
      notDelivered: 1,
      stuck: 1,
      cancelled: 4,
    });
  });

  it('still counts an unknown status in the total', () => {
    expect(countersFrom([{ status: 'FUTURE', count: 2 }])).toEqual({ ...emptyCounters(), total: 2 });
  });
});

describe('status sets', () => {
  it('classify every message status exactly once, CANCELLED apart', () => {
    const all = messageStatusSchema.options;
    const classified = [...OPEN_STATUSES, ...LEFT_STATUSES, 'CANCELLED'];

    expect([...classified].sort()).toEqual([...all].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });
});
