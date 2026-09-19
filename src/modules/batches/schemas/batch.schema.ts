import { Schema } from 'mongoose';

import type { ApiKeyId, BatchId, MailboxCode, TenantId } from '../../../common/types/branded';
import type { BatchStatus, BatchWarning, RejectedMessage } from '../batch-response.dto';

export const BATCH_MODEL = 'Batch';

export interface StoredPart {
  readonly part: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
  /** Relative to STORAGE_DIR */
  readonly path: string;
}

export interface BatchDocument {
  readonly _id: BatchId;
  readonly tenantId: TenantId;
  readonly apiKeyId: ApiKeyId;
  readonly mailbox: MailboxCode;
  readonly reference?: string;
  readonly subTenant?: string;
  readonly status: BatchStatus;
  readonly template: {
    readonly subject: string;
    readonly html: string;
    readonly inlineImages: readonly { readonly cid: string; readonly part: string }[];
  };
  readonly options: { readonly atomic: boolean; readonly unverifiedRecipients: 'reject' | 'send' };
  readonly parts: readonly StoredPart[];
  /**
   * Accepted rows. Per-status counters are not stored: they are counted from
   * the messages when asked (see batch-counters.ts), so a crash between two
   * writes can never leave them wrong.
   */
  readonly messageCount: number;
  readonly rejectedMessages: readonly RejectedMessage[];
  readonly warnings: readonly BatchWarning[];
  readonly idempotencyKey: string;
  readonly sendingStartedAt?: Date;
  /** Every message left the queue (sent, failed or cancelled) and none is stuck. */
  readonly sentAt?: Date;
  /** Set by the first cancel request, whatever it found to cancel. */
  readonly cancelRequestedAt?: Date;
  readonly cancelledAt?: Date;
  /** Every message has its final word (stage 5). */
  readonly settledAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const storedPartSchema = new Schema<StoredPart>(
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

export const batchSchema = new Schema<BatchDocument>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    apiKeyId: { type: String, required: true },
    mailbox: { type: String, required: true },
    reference: { type: String },
    subTenant: { type: String },
    status: { type: String, required: true },
    template: {
      subject: { type: String, required: true },
      html: { type: String, required: true },
      inlineImages: { type: [new Schema({ cid: String, part: String }, { _id: false })], required: true },
    },
    options: {
      atomic: { type: Boolean, required: true },
      unverifiedRecipients: { type: String, required: true },
    },
    parts: { type: [storedPartSchema], required: true },
    messageCount: { type: Number, required: true },
    rejectedMessages: {
      type: [new Schema({ ref: String, code: String, detail: String }, { _id: false })],
      required: true,
    },
    warnings: { type: [new Schema({ code: String, detail: String }, { _id: false })], required: true },
    idempotencyKey: { type: String, required: true },
    sendingStartedAt: { type: Date },
    sentAt: { type: Date },
    cancelRequestedAt: { type: Date },
    cancelledAt: { type: Date },
    settledAt: { type: Date },
  },
  { collection: 'batches', timestamps: true, versionKey: false, minimize: false },
);

// Every read is tenant-scoped: GET /v1/batches, newest first, by the filters it offers.
batchSchema.index({ tenantId: 1, createdAt: -1, _id: -1 });
batchSchema.index({ tenantId: 1, reference: 1, createdAt: -1 });
batchSchema.index({ tenantId: 1, subTenant: 1, createdAt: -1 });
batchSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
