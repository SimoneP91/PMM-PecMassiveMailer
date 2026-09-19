import { Schema } from 'mongoose';

import type { EventId, TenantId } from '../../common/types/branded';

export const WEBHOOK_EVENT_MODEL = 'WebhookEvent';

export const EVENT_TYPES = ['batch.sent', 'batch.settled', 'mailbox.suspended'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type DeliveryStatus = 'PENDING' | 'DELIVERING' | 'DELIVERED' | 'FAILED';

/**
 * The outbox. An event is written in the same transaction as the state
 * change it reports, then delivered by the worker's dispatcher with retries:
 * a crash can delay a notification, never lose it or invent it.
 */
export interface WebhookEventDocument {
  readonly _id: EventId;
  readonly tenantId: TenantId;
  readonly type: EventType;
  /** One event per fact: "batch.sent:b_..." cannot be recorded twice. */
  readonly dedupKey: string;
  readonly occurredAt: Date;
  /** The JSON body sent, frozen when the event is recorded. */
  readonly payload: Record<string, unknown>;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  /** Retries stop after this; the event is then FAILED. */
  readonly giveUpAt: Date;
  readonly lockedUntil?: Date;
  readonly deliveredAt?: Date;
  readonly lastStatusCode?: number;
  readonly lastError?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export const webhookEventSchema = new Schema<WebhookEventDocument>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    type: { type: String, required: true },
    dedupKey: { type: String, required: true },
    occurredAt: { type: Date, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, required: true },
    attempts: { type: Number, required: true },
    nextAttemptAt: { type: Date, required: true },
    giveUpAt: { type: Date, required: true },
    lockedUntil: { type: Date },
    deliveredAt: { type: Date },
    lastStatusCode: { type: Number },
    lastError: { type: String },
  },
  { collection: 'webhook_events', timestamps: true, versionKey: false, minimize: false },
);

webhookEventSchema.index({ tenantId: 1, dedupKey: 1 }, { unique: true });
// Dispatcher: the next due event, and the ones whose dispatcher died mid-delivery.
webhookEventSchema.index({ status: 1, nextAttemptAt: 1 });
webhookEventSchema.index({ status: 1, lockedUntil: 1 });
webhookEventSchema.index({ tenantId: 1, createdAt: -1 });
