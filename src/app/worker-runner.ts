import { hostname } from 'node:os';

import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { CLOCK, type Clock } from '../common/time/clock';
import { ENV, PECMAILER_CONFIG } from '../config/config.module';
import type { ResolvedConfig } from '../config/config.loader';
import type { Env } from '../config/env.schema';
import { MailboxRegistry } from '../modules/mailboxes/mailbox.registry';
import { MailboxStateStore } from '../modules/mailboxes/mailbox-state.store';
import { ImapCursorStore } from '../modules/receipts/imap-cursor.store';
import { ReceiptProcessor } from '../modules/receipts/receipt-processor';
import { ReceiptReader } from '../modules/receipts/receipt-reader';
import { RECEIPT_SOURCE_FACTORY, type ReceiptSourceFactory } from '../modules/receipts/receipt-source';
import { SettlementJob } from '../modules/receipts/settlement-job';
import { SENT_ARCHIVER_FACTORY, type SentArchiverFactory } from '../modules/sending/imap/sent-archiver';
import { MailboxLeaseService } from '../modules/sending/mailbox-lease.service';
import { MailboxPacer } from '../modules/sending/mailbox-pacer';
import { MailboxSender } from '../modules/sending/mailbox-sender';
import { MessageQueueRepository } from '../modules/sending/message-queue.repository';
import { EmlBuilder } from '../modules/sending/mime/eml-builder';
import { SLEEPER, type Sleeper } from '../modules/sending/sleeper';
import { SMTP_CLIENT_FACTORY, type SmtpClientFactory } from '../modules/sending/smtp/smtp-client';
import { StuckRecovery } from '../modules/sending/stuck-recovery';
import { WebhookDispatcher } from '../modules/webhooks/webhook-dispatcher';

const SHUTDOWN_GRACE_MS = 45_000;

/**
 * Owns the lifetime of the worker process: per configured mailbox a sending
 * loop and (IMAP enabled) a receipt reader; plus the stale-recovery job, the
 * settlement job and the webhook dispatcher. Every loop shares one abort signal;
 * SIGTERM trips it, the loops finish the message in flight, release their
 * leases and the process exits.
 */
@Injectable()
export class WorkerRunner implements OnApplicationBootstrap, OnApplicationShutdown {
  public readonly workerId: string;
  private readonly abort = new AbortController();
  private readonly senders: MailboxSender[] = [];
  private readonly readers: ReceiptReader[] = [];
  private loops: Promise<void>[] = [];
  private resolveStopped: (() => void) | undefined;
  private readonly stopped = new Promise<void>((resolve) => {
    this.resolveStopped = resolve;
  });

  public constructor(
    @Inject(ENV) env: Env,
    @Inject(PECMAILER_CONFIG) private readonly config: ResolvedConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SLEEPER) private readonly sleeper: Sleeper,
    @Inject(SMTP_CLIENT_FACTORY) private readonly smtpFactory: SmtpClientFactory,
    @Inject(SENT_ARCHIVER_FACTORY) private readonly archiverFactory: SentArchiverFactory,
    private readonly mailboxes: MailboxRegistry,
    private readonly states: MailboxStateStore,
    private readonly queue: MessageQueueRepository,
    private readonly leases: MailboxLeaseService,
    private readonly pacer: MailboxPacer,
    private readonly eml: EmlBuilder,
    private readonly recovery: StuckRecovery,
    private readonly receiptProcessor: ReceiptProcessor,
    private readonly cursors: ImapCursorStore,
    @Inject(RECEIPT_SOURCE_FACTORY) private readonly receiptSources: ReceiptSourceFactory,
    private readonly settlement: SettlementJob,
    private readonly dispatcher: WebhookDispatcher,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkerRunner.name);
    this.workerId = env.WORKER_ID ?? `${hostname()}:${String(process.pid)}`;
  }

  public onApplicationBootstrap(): void {
    for (const mailbox of this.mailboxes.all()) {
      const sender = new MailboxSender(mailbox, {
        queue: this.queue,
        leases: this.leases,
        pacer: this.pacer,
        states: this.states,
        eml: this.eml,
        smtpFactory: this.smtpFactory,
        archiverFactory: this.archiverFactory,
        clock: this.clock,
        sleeper: this.sleeper,
        config: this.config.sending,
        workerId: this.workerId,
        logger: this.logger,
      });
      this.senders.push(sender);
      this.loops.push(sender.run(this.abort.signal));

      if (mailbox.imap !== null) {
        const reader = new ReceiptReader(mailbox, mailbox.imap, {
          processor: this.receiptProcessor,
          cursors: this.cursors,
          sources: this.receiptSources,
          leases: this.leases,
          states: this.states,
          clock: this.clock,
          sleeper: this.sleeper,
          receipts: this.config.receipts,
          sending: this.config.sending,
          workerId: this.workerId,
          logger: this.logger,
        });
        this.readers.push(reader);
        this.loops.push(reader.run(this.abort.signal));
      }
    }
    this.loops.push(this.recovery.run(this.abort.signal));
    this.loops.push(this.settlement.run(this.abort.signal));
    this.loops.push(this.dispatcher.run(this.abort.signal));
    this.logger.info(
      {
        workerId: this.workerId,
        mailboxes: this.senders.map((sender) => sender.code),
        receiptReaders: this.readers.length,
      },
      'worker started',
    );
  }

  public async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'worker stopping: finishing the message in flight');
    this.abort.abort();
    const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref());
    await Promise.race([Promise.allSettled(this.loops), grace]);
    this.loops = [];
    this.resolveStopped?.();
  }

  public waitUntilStopped(): Promise<void> {
    return this.stopped;
  }

  /**
   * The oldest "last activity" among the loops: a probe treats a stale one as
   * dead. A loop sleeping on purpose counts as active until its planned wake-up.
   */
  public lastActivity(): Date {
    return [...this.senders, ...this.readers, this.dispatcher].reduce(
      (oldest, loop) => (loop.lastTick < oldest ? loop.lastTick : oldest),
      this.clock.now(),
    );
  }

  public isStopping(): boolean {
    return this.abort.signal.aborted;
  }
}
