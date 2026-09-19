import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { APP_NAME, APP_VERSION } from '../../app/version';
import { CLOCK, type Clock } from '../../common/time/clock';
import { PECMAILER_CONFIG } from '../../config/config.module';
import type { ResolvedConfig } from '../../config/config.loader';
import { WEBHOOK_EVENT_MODEL, type WebhookEventDocument } from '../events/webhook-event.schema';
import { LoopPulse } from '../sending/loop-pulse';
import { SLEEPER, type Sleeper } from '../sending/sleeper';
import { TenantRegistry } from '../tenants/tenant.registry';
import { signPayload } from './signature';
import { WEBHOOK_TRANSPORT, type WebhookTransport } from './webhook-transport';

export type DeliveryResult = 'delivered' | 'retry' | 'failed' | 'idle';

/**
 * Delivers the outbox: one event at a time, claimed atomically so several
 * workers never post the same attempt twice, retried with backoff until
 * webhooks.retryForHours, then FAILED. Delivery is at least once (a crash
 * after the POST and before the bookkeeping posts again); receivers
 * deduplicate on the event id.
 */
@Injectable()
export class WebhookDispatcher {
  private readonly pulse: LoopPulse;

  public constructor(
    @InjectModel(WEBHOOK_EVENT_MODEL) private readonly events: Model<WebhookEventDocument>,
    @Inject(WEBHOOK_TRANSPORT) private readonly transport: WebhookTransport,
    private readonly tenants: TenantRegistry,
    @Inject(PECMAILER_CONFIG) private readonly config: ResolvedConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(SLEEPER) private readonly sleeper: Sleeper,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookDispatcher.name);
    this.pulse = new LoopPulse(clock);
  }

  public get lastTick(): Date {
    return this.pulse.freshAt();
  }

  public async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.pulse.beat();
      let result: DeliveryResult = 'idle';
      try {
        result = await this.deliverNext();
      } catch (error: unknown) {
        this.logger.error({ err: error }, 'webhook dispatch failed');
      }
      if (result === 'idle') {
        await this.pulse.sleep(this.sleeper, this.config.webhooks.pollIntervalMs, signal);
      }
    }
  }

  /** Claims and delivers the next due event. Public for tests and for the CLI. */
  public async deliverNext(): Promise<DeliveryResult> {
    const { timeoutSeconds, backoffSeconds } = this.config.webhooks;
    const now = this.clock.now();
    const event = await this.events
      .findOneAndUpdate(
        {
          $or: [
            { status: 'PENDING', nextAttemptAt: { $lte: now } },
            // A dispatcher died mid-delivery: the lock expired, take it over.
            { status: 'DELIVERING', lockedUntil: { $lt: now } },
          ],
        },
        {
          $set: { status: 'DELIVERING', lockedUntil: new Date(now.getTime() + (timeoutSeconds + 30) * 1000) },
          $inc: { attempts: 1 },
        },
        { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
      )
      .lean();
    if (event === null) {
      return 'idle';
    }

    const webhook = this.tenants.get(event.tenantId)?.webhook ?? null;
    if (webhook === null) {
      await this.finish(event, 'FAILED', { lastError: 'the tenant has no webhook configured any more' });

      return 'failed';
    }

    const body = JSON.stringify(event.payload);
    const timestamp = Math.floor(now.getTime() / 1000);
    let status: number | undefined;
    let failure: string | undefined;
    try {
      const response = await this.transport.post({
        url: webhook.url,
        body,
        timeoutMs: timeoutSeconds * 1000,
        allowPrivateNetwork: webhook.allowPrivateNetwork,
        headers: {
          'content-type': 'application/json',
          'user-agent': `${APP_NAME}/${APP_VERSION}`,
          'x-pecmailer-event': event.type,
          'x-pecmailer-event-id': event._id,
          'x-pecmailer-timestamp': String(timestamp),
          'x-pecmailer-signature': signPayload(webhook.secret.reveal(), timestamp, body),
          'x-pecmailer-delivery-attempt': String(event.attempts),
        },
      });
      status = response.status;
      if (status < 200 || status >= 300) {
        failure = `HTTP ${String(status)}`;
      }
    } catch (error: unknown) {
      failure = error instanceof Error ? error.message : String(error);
    }

    const done = this.clock.now();
    if (failure === undefined) {
      await this.finish(event, 'DELIVERED', {
        deliveredAt: done,
        ...(status === undefined ? {} : { lastStatusCode: status }),
      });
      this.logger.info(
        { eventId: event._id, type: event.type, tenantId: event.tenantId },
        'webhook delivered',
      );

      return 'delivered';
    }

    const wait = backoffSeconds[Math.min(event.attempts - 1, backoffSeconds.length - 1)] ?? 60;
    const next = new Date(done.getTime() + wait * 1000);
    const details = {
      lastError: failure.slice(0, 500),
      ...(status === undefined ? {} : { lastStatusCode: status }),
    };
    if (next.getTime() > event.giveUpAt.getTime()) {
      await this.finish(event, 'FAILED', details);
      this.logger.error(
        { eventId: event._id, type: event.type, tenantId: event.tenantId, attempts: event.attempts, failure },
        'webhook given up',
      );

      return 'failed';
    }
    await this.events.updateOne(this.stillMine(event), {
      $set: { status: 'PENDING', nextAttemptAt: next, ...details },
      $unset: { lockedUntil: 1 },
    });
    this.logger.warn(
      { eventId: event._id, type: event.type, tenantId: event.tenantId, attempts: event.attempts, failure },
      'webhook not delivered; will retry',
    );

    return 'retry';
  }

  private async finish(
    event: WebhookEventDocument,
    status: 'DELIVERED' | 'FAILED',
    fields: Partial<Pick<WebhookEventDocument, 'deliveredAt' | 'lastStatusCode' | 'lastError'>>,
  ): Promise<void> {
    await this.events.updateOne(this.stillMine(event), {
      $set: { status, ...fields },
      $unset: { lockedUntil: 1 },
    });
  }

  /**
   * The bookkeeping of a delivery applies only while the claim is still ours:
   * the lock time set by the claim is its fencing token. If this delivery
   * outlived its lock and another dispatcher took the event over, the other
   * one's outcome stands.
   */
  private stillMine(event: WebhookEventDocument): Record<string, unknown> {
    return { _id: event._id, status: 'DELIVERING', lockedUntil: event.lockedUntil };
  }
}
