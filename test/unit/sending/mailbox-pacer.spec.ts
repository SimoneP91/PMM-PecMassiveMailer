import { describe, expect, it } from 'vitest';

import type { Clock } from '../../../src/common/time/clock';
import { asMailboxCode, asTenantId } from '../../../src/common/types/branded';
import { Secret } from '../../../src/common/security/secret';
import type { ResolvedMailbox } from '../../../src/config/config.loader';
import { MailboxPacer, utcDay } from '../../../src/modules/sending/mailbox-pacer';
import type { MailboxCounterDocument } from '../../../src/modules/sending/schemas/mailbox-counter.schema';
import type { Sleeper } from '../../../src/modules/sending/sleeper';

class FakeClock implements Clock {
  public constructor(public current: Date) {}

  public now(): Date {
    return this.current;
  }
}

/** Sleeping moves the clock instead of waiting. */
class VirtualSleeper implements Sleeper {
  public readonly slept: number[] = [];

  public constructor(private readonly clock: FakeClock) {}

  public sleep(ms: number): Promise<void> {
    this.slept.push(ms);
    this.clock.current = new Date(this.clock.current.getTime() + ms);

    return Promise.resolve();
  }
}

/** The one document the pacer reads and writes. */
class FakeCounters {
  public doc: MailboxCounterDocument | null = null;

  public findById(): { lean: () => Promise<MailboxCounterDocument | null> } {
    return { lean: () => Promise.resolve(this.doc) };
  }

  public updateOne(_filter: unknown, update: { $set: Omit<MailboxCounterDocument, '_id'> }): Promise<void> {
    this.doc = { _id: asMailboxCode('mb'), ...update.$set };

    return Promise.resolve();
  }
}

function mailbox(perMinute: number, perDay: number): ResolvedMailbox {
  return {
    code: asMailboxCode('mb'),
    tenantId: asTenantId('t'),
    provider: 'aruba',
    from: { address: 'a@pec.example', name: 'A' },
    smtp: {
      host: 'h',
      port: 25,
      security: 'none',
      username: 'u',
      password: new Secret('p'),
      timeoutSeconds: 30,
    },
    imap: null,
    limits: { perMinute, perDay, maxMessageBytes: 1 },
  };
}

function setup(perMinute: number, perDay: number, start = '2026-09-19T10:00:00Z') {
  const clock = new FakeClock(new Date(start));
  const sleeper = new VirtualSleeper(clock);
  const counters = new FakeCounters();
  const pacer = new MailboxPacer(counters as never, clock, sleeper);

  return { pacer, clock, sleeper, counters, mailbox: mailbox(perMinute, perDay) };
}

describe('MailboxPacer', () => {
  it('lets perMinute sends through, then waits for the next minute', async () => {
    const { pacer, sleeper, counters, mailbox: mb } = setup(2, 0);

    expect(await pacer.acquireSlot(mb)).toBe('ok');
    expect(await pacer.acquireSlot(mb)).toBe('ok');
    expect(sleeper.slept).toEqual([]);

    expect(await pacer.acquireSlot(mb)).toBe('ok');
    expect(sleeper.slept).toEqual([60_000]);
    expect(counters.doc).toMatchObject({ minuteCount: 1, dayCount: 3 });
  });

  it('counts a partial minute correctly after a restart', async () => {
    const { pacer, clock, sleeper, counters, mailbox: mb } = setup(3, 0);
    counters.doc = {
      _id: asMailboxCode('mb'),
      minuteStart: new Date('2026-09-19T09:59:40Z'),
      minuteCount: 3,
      day: '2026-09-19',
      dayCount: 3,
      updatedAt: clock.current,
    };

    expect(await pacer.acquireSlot(mb)).toBe('ok');
    expect(sleeper.slept).toEqual([40_000]);
  });

  it('stops at the daily quota and resets on the next UTC day', async () => {
    const { pacer, clock, counters, mailbox: mb } = setup(0, 2);

    expect(await pacer.acquireSlot(mb)).toBe('ok');
    expect(await pacer.acquireSlot(mb)).toBe('ok');
    expect(await pacer.acquireSlot(mb)).toBe('dayQuotaReached');
    expect(counters.doc?.dayCount).toBe(2);

    clock.current = new Date('2026-09-20T00:00:01Z');
    expect(await pacer.acquireSlot(mb)).toBe('ok');
    expect(counters.doc).toMatchObject({ day: '2026-09-20', dayCount: 1 });
  });

  it('does not pace when both limits are zero', async () => {
    const { pacer, sleeper, mailbox: mb } = setup(0, 0);
    for (let i = 0; i < 5; i += 1) {
      expect(await pacer.acquireSlot(mb)).toBe('ok');
    }
    expect(sleeper.slept).toEqual([]);
  });

  it('returns aborted when asked to stop', async () => {
    const { pacer, mailbox: mb } = setup(1, 0);
    const controller = new AbortController();
    controller.abort();

    expect(await pacer.acquireSlot(mb, controller.signal)).toBe('aborted');
  });

  it('computes the wait until the next UTC day', () => {
    const { pacer } = setup(0, 0);
    expect(pacer.msUntilNextDay(new Date('2026-09-19T23:59:30Z'))).toBe(30_000);
    expect(utcDay(new Date('2026-09-19T23:59:30Z'))).toBe('2026-09-19');
  });
});
