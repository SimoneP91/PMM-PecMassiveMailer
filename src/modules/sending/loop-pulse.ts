import type { Clock } from '../../common/time/clock';
import type { Sleeper } from './sleeper';

/**
 * What the liveness probe reads for one worker loop.
 *
 * A loop beats when it starts a pass. When it goes to sleep on purpose (the
 * poll interval, a suspended mailbox, a lease held elsewhere) it says until
 * when, and it counts as alive until that moment: a reader polling every ten
 * minutes is not a stalled reader. What goes stale is a loop stuck on an
 * await that never settles, the one failure the probe exists to catch.
 */
export class LoopPulse {
  private beatAt: number;
  private idleUntil = 0;

  public constructor(private readonly clock: Clock) {
    this.beatAt = clock.now().getTime();
  }

  public beat(): void {
    this.beatAt = this.clock.now().getTime();
    this.idleUntil = 0;
  }

  /** Sleeps through the loop's sleeper, fresh for the whole planned wait. */
  public async sleep(sleeper: Sleeper, ms: number, signal: AbortSignal): Promise<void> {
    this.idleUntil = this.clock.now().getTime() + ms;
    try {
      await sleeper.sleep(ms, signal);
    } finally {
      this.beat();
    }
  }

  /** The last moment the loop is known to be alive, never later than now. */
  public freshAt(): Date {
    const now = this.clock.now().getTime();

    return new Date(Math.max(this.beatAt, Math.min(now, this.idleUntil)));
  }
}
