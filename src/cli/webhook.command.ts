import type { INestApplicationContext } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { asEventId } from '../common/types/branded';
import { PECMAILER_CONFIG } from '../config/config.module';
import type { ResolvedConfig } from '../config/config.loader';
import {
  WEBHOOK_EVENT_MODEL,
  type DeliveryStatus,
  type WebhookEventDocument,
} from '../modules/events/webhook-event.schema';

const STATUSES: readonly DeliveryStatus[] = ['PENDING', 'DELIVERING', 'DELIVERED', 'FAILED'];

export async function runWebhookList(
  app: INestApplicationContext,
  status: string | undefined,
): Promise<number> {
  if (status !== undefined && !STATUSES.includes(status as DeliveryStatus)) {
    console.error(`--status must be one of: ${STATUSES.join(', ')}`);

    return 1;
  }
  const events = app.get<Model<WebhookEventDocument>>(getModelToken(WEBHOOK_EVENT_MODEL));
  const filter: Record<string, unknown> =
    status === undefined ? { status: { $ne: 'DELIVERED' } } : { status };
  const list = await events.find(filter).sort({ createdAt: -1 }).limit(100).lean();
  if (list.length === 0) {
    console.log(status === undefined ? 'nothing waiting or failed' : `no ${status} event`);

    return 0;
  }
  for (const event of list) {
    console.log(
      `${event._id}  ${event.status.padEnd(10)} ${event.type.padEnd(18)} tenant=${event.tenantId}  attempts=${String(event.attempts)}` +
        `  created=${event.createdAt.toISOString()}` +
        (event.lastError === undefined ? '' : `\n    last error: ${event.lastError}`),
    );
  }

  return 0;
}

/** Puts a FAILED (or PENDING) event back in the queue for a new retry window. */
export async function runWebhookRetry(app: INestApplicationContext, id: string): Promise<number> {
  const events = app.get<Model<WebhookEventDocument>>(getModelToken(WEBHOOK_EVENT_MODEL));
  const config = app.get<ResolvedConfig>(PECMAILER_CONFIG);
  const now = new Date();
  const result = await events.updateOne(
    { _id: asEventId(id), status: { $in: ['FAILED' as const, 'PENDING' as const] } },
    {
      $set: {
        status: 'PENDING',
        nextAttemptAt: now,
        giveUpAt: new Date(now.getTime() + config.webhooks.retryForHours * 3_600_000),
      },
    },
  );
  if (result.matchedCount === 0) {
    console.error(`no FAILED or PENDING event "${id}"`);

    return 1;
  }
  console.log(`${id}: queued again, the worker delivers it within seconds`);

  return 0;
}
