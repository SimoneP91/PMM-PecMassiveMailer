import type { Schema } from 'mongoose';

import { BATCH_MODEL, batchSchema } from '../modules/batches/schemas/batch.schema';
import { IDEMPOTENCY_MODEL, idempotencySchema } from '../modules/batches/schemas/idempotency.schema';
import { MESSAGE_MODEL, messageSchema } from '../modules/batches/schemas/message.schema';
import { WEBHOOK_EVENT_MODEL, webhookEventSchema } from '../modules/events/webhook-event.schema';
import { MAILBOX_STATE_MODEL, mailboxStateSchema } from '../modules/mailboxes/mailbox-state.schema';
import { IMAP_CURSOR_MODEL, imapCursorSchema } from '../modules/receipts/schemas/imap-cursor.schema';
import { RECEIPT_MODEL, receiptSchema } from '../modules/receipts/schemas/receipt.schema';
import {
  MAILBOX_COUNTER_MODEL,
  mailboxCounterSchema,
} from '../modules/sending/schemas/mailbox-counter.schema';
import { MAILBOX_LEASE_MODEL, mailboxLeaseSchema } from '../modules/sending/schemas/mailbox-lease.schema';

/**
 * Every collection the service owns, in one place: what `db sync-indexes`
 * walks. A schema added to a module and not here would never get its
 * indexes in production, where autoIndex is off.
 */
export const ALL_SCHEMAS: readonly { readonly name: string; readonly schema: Schema }[] = [
  { name: BATCH_MODEL, schema: batchSchema },
  { name: MESSAGE_MODEL, schema: messageSchema },
  { name: IDEMPOTENCY_MODEL, schema: idempotencySchema },
  { name: MAILBOX_STATE_MODEL, schema: mailboxStateSchema },
  { name: MAILBOX_LEASE_MODEL, schema: mailboxLeaseSchema },
  { name: MAILBOX_COUNTER_MODEL, schema: mailboxCounterSchema },
  { name: RECEIPT_MODEL, schema: receiptSchema },
  { name: IMAP_CURSOR_MODEL, schema: imapCursorSchema },
  { name: WEBHOOK_EVENT_MODEL, schema: webhookEventSchema },
];
