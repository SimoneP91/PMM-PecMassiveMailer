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

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
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
    try {
      await this.events.create(
        [
          {
            _id: eventId,
            tenantId: event.tenantId,
            type: event.type,
            dedupKey: event.dedupKey,
            occurredAt: event.occurredAt,
            payload,
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: event.occurredAt,
            giveUpAt: new Date(event.occurredAt.getTime() + this.config.webhooks.retryForHours * 3_600_000),
          },
        ],
        session === undefined ? {} : { session },
      );
    } catch (error: unknown) {
      // Already recorded: the fact was reported once, which is the point.
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
    }
  }
}
