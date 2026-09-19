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

/** Whether the copy the worker files in the mailbox's Sent folder made it there. */
export type SentCopyState = 'PENDING' | 'ARCHIVED' | 'FAILED' | 'DISABLED';

export interface MessageError {
  readonly code: string;
  readonly detail: string;
  readonly at: Date;
}

/** How one pass of the worker over a message ended. */
export type AttemptOutcome = 'SENT' | 'RETRY_SCHEDULED' | 'FAILED' | 'STUCK' | 'MAILBOX_SUSPENDED';

export interface AttemptLogEntry {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly outcome: AttemptOutcome;
  readonly code?: string;
  readonly smtpCode?: number;
  readonly detail?: string;
}

export type OperatorAction = 'MARKED_SENT' | 'REQUEUED' | 'MARKED_FAILED';

export interface OperatorLogEntry {
  readonly at: Date;
  readonly action: OperatorAction;
  /** Internal: who ran the command. Never returned by the API. */
  readonly by: string;
}

/** Bound on the history kept per message; far above maxAttempts, it only guards against a runaway loop. */
export const MAX_LOG_ENTRIES = 50;

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
  /** Row index in the submitted batch: the order the client wrote. */
  readonly position: number;
  readonly ref: string;
  readonly subTenant?: string;
  /** As the client wrote it: what goes in the To header. */
  readonly to: string;
  /** Lower-cased, for search: nobody expects "Mario.Rossi@PEC.it" and "mario.rossi@pec.it" to be two people. */
  readonly toLower: string;
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
  /** Counted attempts (a refused login is not one). */
  readonly attempts: number;
  /** When the worker may pick it up; moved forward on retry. */
  readonly nextAttemptAt: Date;
  readonly lastError?: MessageError;
  /** Set while SENDING: who took it, when, and when it last proved it is still at it. */
  readonly workerId?: string;
  readonly sendingStartedAt?: Date;
  readonly heartbeatAt?: Date;
  readonly sentAt?: Date;
  readonly failedAt?: Date;
  readonly stuckAt?: Date;
  readonly cancelledAt?: Date;
  /** Set by the receipts (stage 5). */
  readonly acceptedAt?: Date;
  readonly deliveredAt?: Date;
  readonly notDeliveredAt?: Date;
  /** Why the recipient's side refused it, from the non-delivery receipt. */
  readonly deliveryError?: { readonly code: string; readonly detail: string };
  /** When settlement stopped being PENDING. */
  readonly settledAt?: Date;
  /** RFC 5322 Message-ID as sent; the receipts of stage 5 refer to it. */
  readonly messageIdHeader?: string;
  readonly smtpResponse?: string;
  /** The exact bytes that were sent, relative to STORAGE_DIR, with their digest. */
  readonly emlPath?: string;
  readonly emlSha256?: string;
  readonly emlSize?: number;
  readonly sentCopy: SentCopyState;
  readonly sentCopyError?: string;
  readonly attemptLog: readonly AttemptLogEntry[];
  readonly operatorLog: readonly OperatorLogEntry[];
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

const attemptLogSchema = new Schema<AttemptLogEntry>(
  {
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
    outcome: { type: String, required: true },
    code: { type: String },
    smtpCode: { type: Number },
    detail: { type: String },
  },
  { _id: false },
);

const operatorLogSchema = new Schema<OperatorLogEntry>(
  {
    at: { type: Date, required: true },
    action: { type: String, required: true },
    by: { type: String, required: true },
  },
  { _id: false },
);

export const messageSchema = new Schema<MessageDocument>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    batchId: { type: String, required: true },
    mailbox: { type: String, required: true },
    position: { type: Number, required: true },
    ref: { type: String, required: true },
    subTenant: { type: String },
    to: { type: String, required: true },
    toLower: { type: String, required: true },
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
    workerId: { type: String },
    sendingStartedAt: { type: Date },
    heartbeatAt: { type: Date },
    sentAt: { type: Date },
    failedAt: { type: Date },
    stuckAt: { type: Date },
    cancelledAt: { type: Date },
    acceptedAt: { type: Date },
    deliveredAt: { type: Date },
    notDeliveredAt: { type: Date },
    deliveryError: { type: new Schema({ code: String, detail: String }, { _id: false }) },
    settledAt: { type: Date },
    messageIdHeader: { type: String },
    smtpResponse: { type: String },
    emlPath: { type: String },
    emlSha256: { type: String },
    emlSize: { type: Number },
    sentCopy: { type: String, required: true },
    sentCopyError: { type: String },
    attemptLog: { type: [attemptLogSchema], default: [] },
    operatorLog: { type: [operatorLogSchema], default: [] },
  },
  { collection: 'messages', timestamps: true, versionKey: false, minimize: false },
);

// Integrity: one row per ref in a batch; a dedupKey once per tenant, ever.
messageSchema.index({ batchId: 1, ref: 1 }, { unique: true });
messageSchema.index(
  { tenantId: 1, dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $type: 'string' } } },
);
// Worker queue: the sort of claimNext is covered, so a claim never sorts in memory.
messageSchema.index({ mailbox: 1, status: 1, nextAttemptAt: 1, createdAt: 1, position: 1 });
// Batch counters, completion and settlement inside one batch.
messageSchema.index({ batchId: 1, status: 1 });
messageSchema.index({ batchId: 1, settlement: 1 });
// Settlement timeout: sent messages still waiting for their final receipt.
messageSchema.index({ settlement: 1, sentAt: 1 });
// Stale recovery.
messageSchema.index({ status: 1, heartbeatAt: 1 });
// Receipts (stage 5) are matched on the Message-ID they quote.
messageSchema.index({ messageIdHeader: 1 }, { sparse: true });
// Read endpoints: the messages of a batch in the client's order, and the
// cross-batch search, newest first, by the filters it offers.
messageSchema.index({ tenantId: 1, batchId: 1, position: 1 });
messageSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
messageSchema.index({ tenantId: 1, toLower: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, ref: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, subTenant: 1, createdAt: -1 });
messageSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
