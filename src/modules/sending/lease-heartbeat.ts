import type { PinoLogger } from 'nestjs-pino';

import type { Clock } from '../../common/time/clock';
import type { MailboxLeaseService } from './mailbox-lease.service';

export interface LeaseHeartbeatDeps {
  readonly leases: MailboxLeaseService;
  readonly clock: Clock;
  readonly workerId: string;
  readonly logger: PinoLogger;
}

/**
 * Keeps a lease alive on a timer of its own: the loop that holds it may
 * legitimately wait longer than a renewal period (a paced minute, a large
 * upload, a slow IMAP fetch), and a lease that lapses meanwhile would let a
 * second worker in. `onBeat` runs after each successful renewal.
 */
export class LeaseHeartbeat {
  private lost = false;
  private lastRenewed: number;
  private busy = false;
  private readonly timer: NodeJS.Timeout;

  public constructor(
    private readonly key: string,
    private readonly ttlMs: number,
    private readonly deps: LeaseHeartbeatDeps,
    private readonly onBeat?: (now: Date) => Promise<void>,
  ) {
    this.lastRenewed = deps.clock.now().getTime();
    this.timer = setInterval(
      () => {
        void this.beat();
      },
      Math.max(1_000, Math.floor(ttlMs / 3)),
    );
    this.timer.unref();
  }

  /** A method, not a field: it flips asynchronously, between two awaits of the loop. */
  public isLost(): boolean {
    return this.lost;
  }

  public stop(): void {
    clearInterval(this.timer);
  }

  private async beat(): Promise<void> {
    if (this.busy || this.lost) {
      return;
    }
    this.busy = true;
    const now = this.deps.clock.now();
    try {
      if (!(await this.deps.leases.renew(this.key, this.deps.workerId, this.ttlMs, now))) {
        this.lost = true;
        this.deps.logger.warn({ lease: this.key }, 'lease lost');

        return;
      }
      this.lastRenewed = now.getTime();
      await this.onBeat?.(now);
    } catch (error: unknown) {
      this.deps.logger.warn({ err: error, lease: this.key }, 'lease renewal failed');
      if (now.getTime() - this.lastRenewed >= this.ttlMs) {
        // Could not prove ownership for a whole TTL: assume someone else has it.
        this.lost = true;
      }
    } finally {
      this.busy = false;
    }
  }
}
