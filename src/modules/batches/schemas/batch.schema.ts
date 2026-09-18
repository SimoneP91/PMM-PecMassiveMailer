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

export interface BatchCounts {
  readonly total: number;
  readonly pending: number;
  readonly sent: number;
  readonly delivered: number;
  readonly failed: number;
  readonly stuck: number;
  readonly cancelled: number;
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
  readonly counts: BatchCounts;
  readonly rejectedMessages: readonly RejectedMessage[];
  readonly warnings: readonly BatchWarning[];
  readonly idempotencyKey: string;
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
    counts: {
      total: { type: Number, required: true },
      pending: { type: Number, required: true },
      sent: { type: Number, required: true },
      delivered: { type: Number, required: true },
      failed: { type: Number, required: true },
      stuck: { type: Number, required: true },
      cancelled: { type: Number, required: true },
    },
    rejectedMessages: {
      type: [new Schema({ ref: String, code: String, detail: String }, { _id: false })],
      required: true,
    },
    warnings: { type: [new Schema({ code: String, detail: String }, { _id: false })], required: true },
    idempotencyKey: { type: String, required: true },
  },
  { collection: 'batches', timestamps: true, versionKey: false, minimize: false },
);

// Every read is tenant-scoped; these serve the list endpoints of stage 4.
batchSchema.index({ tenantId: 1, createdAt: -1 });
batchSchema.index({ tenantId: 1, reference: 1 }, { sparse: true });
batchSchema.index({ tenantId: 1, subTenant: 1, createdAt: -1 }, { sparse: true });
batchSchema.index({ tenantId: 1, status: 1 });
