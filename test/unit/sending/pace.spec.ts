import { describe, expect, it } from 'vitest';

import { Pace } from '../../../src/modules/sending/pace';
import { InstantSleeper, ManualClock } from '../../helpers/sender-fakes';

describe('Pace', () => {
  it('spreads the sends evenly: 30 a minute is one every two seconds', async () => {
    const clock = new ManualClock();
    const sleeper = new InstantSleeper(clock);
    const pace = new Pace(30, clock, sleeper);
    const signal = new AbortController().signal;

    expect(await pace.wait(signal)).toBe(true);
    expect(await pace.wait(signal)).toBe(true);
    clock.at += 500;
    expect(await pace.wait(signal)).toBe(true);

    expect(sleeper.waits).toEqual([2000, 1500]);
  });

  it('does not wait at all when the time has already passed, or with no pace', async () => {
    const clock = new ManualClock();
    const sleeper = new InstantSleeper(clock);
    const paced = new Pace(60, clock, sleeper);
    const unpaced = new Pace(0, clock, sleeper);
    const signal = new AbortController().signal;

    await paced.wait(signal);
    clock.at += 5000;
    await paced.wait(signal);
    await unpaced.wait(signal);
    await unpaced.wait(signal);

    expect(sleeper.waits).toEqual([]);
  });

  it('answers false when interrupted: nothing may be sent', async () => {
    const clock = new ManualClock();
    const pace = new Pace(1, clock, new InstantSleeper(clock));
    const stop = new AbortController();

    expect(await pace.wait(stop.signal)).toBe(true);
    stop.abort();
    expect(await pace.wait(stop.signal)).toBe(false);
  });
});
