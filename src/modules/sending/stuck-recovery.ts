import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CLOCK, type Clock } from '../../common/time/clock';
import { PECMAILER_CONFIG } from '../../config/config.module';
import type { ResolvedConfig } from '../../config/config.loader';
import { MessageQueueRepository } from './message-queue.repository';
import { SLEEPER, type Sleeper } from './sleeper';

const INTERVAL_MS = 60_000;

/**
 * A worker that dies between "DATA accepted" and "marked SENT" leaves a
 * message in SENDING forever. This job turns such messages into STUCK after
 * staleSendingSeconds, so they show up for an operator instead of being
 * silently resent by the next worker.
 */
@Injectable()
export class StuckRecovery {
  public constructor(
    private readonly queue: MessageQueueRepository,
    @Inject(PECMAILER_CONFIG) private readonly config: ResolvedConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SLEEPER) private readonly sleeper: Sleeper,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StuckRecovery.name);
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runOnce();
      } catch (error: unknown) {
        this.logger.error({ err: error }, 'stale recovery failed');
      }
      await this.sleeper.sleep(INTERVAL_MS, signal);
    }
  }

  public async runOnce(): Promise<number> {
    const now = this.clock.now();
    const olderThan = new Date(now.getTime() - this.config.sending.staleSendingSeconds * 1000);
    const recovered = await this.queue.recoverStale(olderThan, now);
    for (const message of recovered) {
      this.logger.error(
        {
          messageId: message._id,
          batchId: message.batchId,
          mailbox: message.mailbox,
          workerId: message.workerId,
        },
        'message SENDING for too long: marked STUCK, needs an operator',
      );
    }

    return recovered.length;
  }
}
