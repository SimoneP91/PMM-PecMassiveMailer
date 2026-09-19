import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { CLOCK, type Clock } from '../../common/time/clock';
import type { ResolvedMailbox } from '../../config/config.loader';
import { MAILBOX_COUNTER_MODEL, type MailboxCounterDocument } from './schemas/mailbox-counter.schema';
import { SLEEPER, type Sleeper } from './sleeper';

const MINUTE_MS = 60_000;

export type SlotResult = 'ok' | 'dayQuotaReached' | 'aborted';

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Keeps a mailbox under its perMinute and perDay limits. Counters live in
 * MongoDB so a restart or a lease moving to another replica does not start
 * a fresh minute; only the lease holder calls this, so read-modify-write is
 * safe.
 */
@Injectable()
export class MailboxPacer {
  public constructor(
    @InjectModel(MAILBOX_COUNTER_MODEL) private readonly counters: Model<MailboxCounterDocument>,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SLEEPER) private readonly sleeper: Sleeper,
  ) {}

  /** Waits for the next allowed send and books it. */
  public async acquireSlot(mailbox: ResolvedMailbox, signal?: AbortSignal): Promise<SlotResult> {
    const { perMinute, perDay } = mailbox.limits;

    for (;;) {
      if (signal?.aborted === true) {
        return 'aborted';
      }
      const now = this.clock.now();
      const current = await this.counters.findById(mailbox.code).lean();

      const minute =
        current !== null && now.getTime() - current.minuteStart.getTime() < MINUTE_MS
          ? { start: current.minuteStart, count: current.minuteCount }
          : { start: now, count: 0 };
      const minuteStart = minute.start;
      const minuteCount = minute.count;
      const day = utcDay(now);
      const dayCount = current?.day === day ? current.dayCount : 0;

      if (perDay > 0 && dayCount >= perDay) {
        return 'dayQuotaReached';
      }
      if (perMinute > 0 && minuteCount >= perMinute) {
        await this.sleeper.sleep(minuteStart.getTime() + MINUTE_MS - now.getTime(), signal);
        continue;
      }

      await this.counters.updateOne(
        { _id: mailbox.code },
        { $set: { minuteStart, minuteCount: minuteCount + 1, day, dayCount: dayCount + 1, updatedAt: now } },
        { upsert: true },
      );

      return 'ok';
    }
  }

  /** Milliseconds until the UTC day rolls over: how long a mailbox out of daily quota waits. */
  public msUntilNextDay(now: Date): number {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);

    return Math.max(1_000, next - now.getTime());
  }
}
