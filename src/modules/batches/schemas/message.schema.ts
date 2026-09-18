import { Schema } from 'mongoose';

import type { BatchId, MailboxCode, MessageId, TenantId } from '../../../common/types/branded';
import type { MessageStatus } from '../batch-response.dto';

export const MESSAGE_MODEL = 'Message';

export interface MessageAttachment {
  readonly part: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
}

export interface MessageInlineImage {
  readonly cid: string;
  readonly part: string;
  readonly contentType: string;
  readonly path: string;
}

export type SettlementState = 'PENDING' | 'SETTLED' | 'TIMED_OUT';

/**
 * One row of a batch, with its subject and body ALREADY rendered: what is
 * stored is exactly what the worker will send, and what the client will be
 * able to read back. The template stays on the batch for reference only.
 */
export interface MessageDocument {
  readonly _id: MessageId;
  readonly tenantId: TenantId;
  readonly batchId: BatchId;
  readonly mailbox: MailboxCode;
  readonly ref: string;
  readonly subTenant?: string;
  readonly to: string;
  readonly toName?: string;
  readonly dedupKey?: string;
  readonly subject: string;
  readonly html: string;
  readonly attachments: readonly MessageAttachment[];
  readonly inlineImages: readonly MessageInlineImage[];
  readonly estimatedBytes: number;
  readonly recipientCheck: 'PEC' | 'UNVERIFIED';
  readonly status: MessageStatus;
  readonly settlement: SettlementState;
  readonly attempts: number;
  /** When the worker may pick it up; moved forward on retry. */
  readonly nextAttemptAt: Date;
  readonly lastError?: { readonly code: string; readonly detail: string; readonly at: Date };
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const attachmentSchema = new Schema<MessageAttachment>(
  {
    part: { type: String, required: true },
    filename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    path: { type: String, required: true },
  },
  { _id: false },
);

const inlineImageSchema = new Schema<MessageInlineImage>(
  {
    cid: { type: String, required: true },
    part: { type: String, required: true },
    contentType: { type: String, required: true },
    path: { type: String, required: true },
  },
  { _id: false },
);

export const messageSchema = new Schema<MessageDocument>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    batchId: { type: String, required: true },
    mailbox: { type: String, required: true },
    ref: { type: String, required: true },
    subTenant: { type: String },
    to: { type: String, required: true },
    toName: { type: String },
    dedupKey: { type: String },
    subject: { type: String, required: true },
    html: { type: String, required: true },
    attachments: { type: [attachmentSchema], required: true },
    inlineImages: { type: [inlineImageSchema], required: true },
    estimatedBytes: { type: Number, required: true },
    recipientCheck: { type: String, required: true },
    status: { type: String, required: true },
    settlement: { type: String, required: true },
    attempts: { type: Number, required: true },
    nextAttemptAt: { type: Date, required: true },
    lastError: { type: new Schema({ code: String, detail: String, at: Date }, { _id: false }) },
  },
  { collection: 'messages', timestamps: true, versionKey: false, minimize: false },
);

messageSchema.index({ tenantId: 1, batchId: 1, createdAt: 1 });
messageSchema.index({ batchId: 1, ref: 1 }, { unique: true });
// The one guarantee the client relies on to never send a row twice.
messageSchema.index(
  { tenantId: 1, dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $type: 'string' } } },
);
// Worker queue: the next PENDING message of a mailbox.
messageSchema.index({ mailbox: 1, status: 1, nextAttemptAt: 1 });
// Stage 4 filters.
messageSchema.index({ tenantId: 1, to: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, ref: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, subTenant: 1, createdAt: -1 }, { sparse: true });
messageSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
