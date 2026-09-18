import { Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { MailboxRegistry } from '../modules/mailboxes/mailbox.registry';

/**
 * Owns the lifetime of the worker process. Jobs (sending, receipts,
 * notifications) will register here; for now it only proves the process boots
 * with its configuration and stops cleanly on SIGTERM.
 */
@Injectable()
export class WorkerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  private resolveStopped: (() => void) | undefined;
  private readonly stopped = new Promise<void>((resolve) => {
    this.resolveStopped = resolve;
  });

  public constructor(
    private readonly logger: PinoLogger,
    private readonly mailboxes: MailboxRegistry,
  ) {
    this.logger.setContext(WorkerRunner.name);
  }

  public onApplicationBootstrap(): void {
    this.logger.info(
      { mailboxes: this.mailboxes.all().map((mailbox) => mailbox.code) },
      'worker ready (no jobs registered yet)',
    );
  }

  public onApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, 'worker stopping');
    this.resolveStopped?.();
  }

  public waitUntilStopped(): Promise<void> {
    return this.stopped;
  }
}
