import type { Clock } from '../../common/time/clock';
import type { Sleeper } from './sleeper';

/**
 * The mailbox's pace: at most `perMinute` sends a minute, spread evenly (one
 * every 60/perMinute seconds) rather than in bursts, which is what providers
 * tolerate. Kept in memory: one container is the only sender of its mailbox,
 * and forgetting the last send on a restart costs at most one early send.
 */
export class Pace {
  private nextAt = 0;

  public constructor(
    private readonly perMinute: number,
    private readonly clock: Clock,
    private readonly sleeper: Sleeper,
  ) {}

  /** Waits for the next slot. false: interrupted by the signal, nothing may be sent. */
  public async wait(signal: AbortSignal): Promise<boolean> {
    if (this.perMinute > 0) {
      const wait = this.nextAt - this.clock.now().getTime();
      if (wait > 0) {
        await this.sleeper.sleep(wait, signal);
      }
    }
    if (signal.aborted) {
      return false;
    }
    if (this.perMinute > 0) {
      this.nextAt = this.clock.now().getTime() + 60_000 / this.perMinute;
    }

    return true;
  }
}
