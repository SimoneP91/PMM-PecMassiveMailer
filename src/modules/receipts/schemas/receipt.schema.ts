import { Schema } from 'mongoose';

import type { BatchId, MailboxCode, MessageId, ReceiptId, TenantId } from '../../../common/types/branded';
import type { ReceiptType } from '../receipt-parser';

export const RECEIPT_MODEL = 'Receipt';

/**
 * A PEC receipt read from a mailbox and matched to one of our messages. The
 * original mail (signed by the provider: the legal proof) and its
 * daticert.xml are kept on disk, with their digests here.
 */
export interface ReceiptDocument {
  readonly _id: ReceiptId;
  readonly tenantId: TenantId;
  readonly batchId: BatchId;
  readonly messageId: MessageId;
  readonly mailbox: MailboxCode;
  readonly type: ReceiptType;
  /** The receipt's own Message-ID, or the SHA-256 of its bytes: one receipt, stored once. */
  readonly dedupKey: string;
  readonly refMessageId: string;
  readonly issuedAt: Date;
  /** When this service read it. */
  readonly receivedAt: Date;
  readonly provider?: string;
  readonly recipient?: string;
  readonly errorCode?: string;
  readonly errorDetail?: string;
  readonly providerId?: string;
  readonly emlPath: string;
  readonly emlSha256: string;
  readonly emlSize: number;
  readonly daticertPath?: string;
  readonly daticertSha256?: string;
  readonly daticertSize?: number;
  readonly createdAt: Date;
}

export const receiptSchema = new Schema<ReceiptDocument>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    batchId: { type: String, required: true },
    messageId: { type: String, required: true },
    mailbox: { type: String, required: true },
    type: { type: String, required: true },
    dedupKey: { type: String, required: true },
    refMessageId: { type: String, required: true },
    issuedAt: { type: Date, required: true },
    receivedAt: { type: Date, required: true },
    provider: { type: String },
    recipient: { type: String },
    errorCode: { type: String },
    errorDetail: { type: String },
    providerId: { type: String },
    emlPath: { type: String, required: true },
    emlSha256: { type: String, required: true },
    emlSize: { type: Number, required: true },
    daticertPath: { type: String },
    daticertSha256: { type: String },
    daticertSize: { type: Number },
  },
  { collection: 'receipts', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);

receiptSchema.index({ mailbox: 1, dedupKey: 1 }, { unique: true });
receiptSchema.index({ tenantId: 1, messageId: 1, issuedAt: 1 });
