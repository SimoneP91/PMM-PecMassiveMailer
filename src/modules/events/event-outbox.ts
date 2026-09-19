import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { ClientSession } from 'mongoose';
import { Model } from 'mongoose';

import { newEventId } from '../../common/ids/id';
import type { TenantId } from '../../common/types/branded';
import { PECMAILER_CONFIG } from '../../config/config.module';
import type { ResolvedConfig } from '../../config/config.loader';
import { TenantRegistry } from '../tenants/tenant.registry';
import { WEBHOOK_EVENT_MODEL, type EventType, type WebhookEventDocument } from './webhook-event.schema';

export interface NewEvent {
  readonly tenantId: TenantId;
  readonly type: EventType;
  readonly dedupKey: string;
  readonly occurredAt: Date;
  readonly data: Record<string, unknown>;
}

/**
 * Records events for later delivery. Pass the session of the transaction
 * that makes the fact true, so the event exists if and only if the fact does.
 * A tenant without a webhook gets nothing recorded.
 */
@Injectable()
export class EventOutbox {
  public constructor(
    @InjectModel(WEBHOOK_EVENT_MODEL) private readonly events: Model<WebhookEventDocument>,
    private readonly tenants: TenantRegistry,
    @Inject(PECMAILER_CONFIG) private readonly config: ResolvedConfig,
  ) {}

  public async record(event: NewEvent, session?: ClientSession): Promise<void> {
    if ((this.tenants.get(event.tenantId)?.webhook ?? null) === null) {
      return;
    }
    const eventId = newEventId();
    const payload = {
      eventId,
      type: event.type,
      occurredAt: event.occurredAt.toISOString(),
      data: event.data,
    };
    // An upsert on the dedup key: recording the same fact again is a no-op rather
    // than a duplicate-key error, which inside a transaction would abort it.
    await this.events.updateOne(
      { tenantId: event.tenantId, dedupKey: event.dedupKey },
      {
        $setOnInsert: {
          _id: eventId,
          type: event.type,
          occurredAt: event.occurredAt,
          payload,
          status: 'PENDING',
          attempts: 0,
          nextAttemptAt: event.occurredAt,
          giveUpAt: new Date(event.occurredAt.getTime() + this.config.webhooks.retryForHours * 3_600_000),
        },
      },
      { upsert: true, ...(session === undefined ? {} : { session }) },
    );
  }
}
