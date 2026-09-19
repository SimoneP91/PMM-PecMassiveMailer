import { describe, expect, it } from 'vitest';

import { LoopPulse } from '../../../src/modules/sending/loop-pulse';
import type { Sleeper } from '../../../src/modules/sending/sleeper';

class ManualClock {
  public at = Date.parse('2026-09-19T10:00:00Z');

  public now(): Date {
    return new Date(this.at);
  }
}

/** A sleeper that parks until the test lets it go, moving the clock meanwhile. */
class ParkedSleeper implements Sleeper {
  public release: () => void = () => undefined;

  public sleep(): Promise<void> {
    return new Promise((resolve) => {
      this.release = resolve;
    });
  }
}

describe('LoopPulse', () => {
  it('goes stale when the loop stops beating', () => {
    const clock = new ManualClock();
    const pulse = new LoopPulse(clock);
    const start = clock.at;

    clock.at += 60_000;

    expect(pulse.freshAt().getTime()).toBe(start);
  });

  it('stays fresh during a planned sleep, then ages from the planned wake-up', async () => {
    const clock = new ManualClock();
    const sleeper = new ParkedSleeper();
    const pulse = new LoopPulse(clock);
    const start = clock.at;

    const sleeping = pulse.sleep(sleeper, 600_000, new AbortController().signal);
    clock.at += 300_000;
    expect(pulse.freshAt().getTime()).toBe(clock.at);

    // Overslept: the sleep should have ended at +10 min, it is now +15.
    clock.at = start + 900_000;
    expect(pulse.freshAt().getTime()).toBe(start + 600_000);

    sleeper.release();
    await sleeping;
    expect(pulse.freshAt().getTime()).toBe(clock.at);
  });
});
