import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { AppError } from '../../common/errors/app-error';
import {
  afterCreatedAt,
  createdAtKeys,
  decodeCursor,
  encodeCursor,
  type CursorKey,
} from '../../common/http/cursor';
import { createdRange, escapeRegex } from '../../common/http/list-query';
import { looksLikeId } from '../../common/ids/id';
import { asBatchId, asMessageId, asReceiptId, type TenantId } from '../../common/types/branded';
import { AttachmentStore } from '../attachments/attachment-store';
import { BATCH_MODEL, type BatchDocument } from '../batches/schemas/batch.schema';
import { MESSAGE_MODEL, type MessageDocument } from '../batches/schemas/message.schema';
import { RECEIPT_MODEL, type ReceiptDocument } from '../receipts/schemas/receipt.schema';
import type {
  BatchMessagesQuery,
  MessageDetailDto,
  MessageListDto,
  MessageSearchQuery,
  ReceiptListDto,
  RenderedMessageDto,
} from './message-read.dto';

const SEARCH = 'messages';
const IN_BATCH = 'batch-messages';

/** Everything a list shows; the body, the files and the history stay out. */
const LIST_PROJECTION = {
  _id: 1,
  batchId: 1,
  position: 1,
  ref: 1,
  to: 1,
  toName: 1,
  subTenant: 1,
  subject: 1,
  status: 1,
  settlement: 1,
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
  sentAt: 1,
  'lastError.code': 1,
} as const;

type ListedMessage = Pick<
  MessageDocument,
  | '_id'
  | 'batchId'
  | 'position'
  | 'ref'
  | 'to'
  | 'toName'
  | 'subTenant'
  | 'subject'
  | 'status'
  | 'settlement'
  | 'attempts'
  | 'createdAt'
  | 'updatedAt'
  | 'sentAt'
  | 'lastError'
>;

export interface FileDownload {
  readonly stream: Readable;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * The read side of messages. Every query starts from the tenant: an id of
 * another tenant is indistinguishable from an id that does not exist.
 */
@Injectable()
export class MessageQueryService {
  public constructor(
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
    @InjectModel(BATCH_MODEL) private readonly batches: Model<BatchDocument>,
    @InjectModel(RECEIPT_MODEL) private readonly receipts: Model<ReceiptDocument>,
    private readonly store: AttachmentStore,
  ) {}

  /** The messages of one batch, in the order the client submitted them. */
  public async listInBatch(
    tenantId: TenantId,
    rawBatchId: string,
    query: BatchMessagesQuery,
  ): Promise<MessageListDto> {
    const exists = looksLikeId(rawBatchId, 'b')
      ? await this.batches.exists({ _id: asBatchId(rawBatchId), tenantId }).lean()
      : null;
    if (exists === null) {
      throw AppError.notFound('BATCH_NOT_FOUND', 'Batch not found');
    }

    const filter: Record<string, unknown> = { ...this.filters(tenantId, query), batchId: rawBatchId };
    if (query.cursor !== undefined) {
      const [position] = decodeCursor(IN_BATCH, query.cursor);
      if (typeof position !== 'number') {
        throw AppError.badRequest('INVALID_CURSOR', 'Invalid cursor');
      }
      filter['position'] = { $gt: position };
    }

    const found = await this.messages
      .find(filter, LIST_PROJECTION)
      .sort({ position: 1 })
      .limit(query.limit + 1)
      .lean<ListedMessage[]>();

    return this.page(found, query.limit, IN_BATCH, (last) => [last.position]);
  }

  /** Search across every batch of the tenant, newest first. */
  public async search(tenantId: TenantId, query: MessageSearchQuery): Promise<MessageListDto> {
    const filter: Record<string, unknown> = {
      ...this.filters(tenantId, query),
      ...(query.batchId === undefined ? {} : { batchId: { $in: query.batchId } }),
    };
    if (query.cursor !== undefined) {
      const { createdAt, id } = createdAtKeys(decodeCursor(SEARCH, query.cursor));
      Object.assign(filter, afterCreatedAt(createdAt, id));
    }

    const found = await this.messages
      .find(filter, LIST_PROJECTION)
      .sort({ createdAt: -1, _id: -1 })
      .limit(query.limit + 1)
      .lean<ListedMessage[]>();

    return this.page(found, query.limit, SEARCH, (last) => [last.createdAt.toISOString(), last._id]);
  }

  public async get(tenantId: TenantId, rawId: string): Promise<MessageDetailDto> {
    const m = await this.find(tenantId, rawId);
    const receipts = await this.receipts
      .find({ tenantId, messageId: m._id }, { _id: 1, type: 1, issuedAt: 1 })
      .sort({ issuedAt: 1 })
      .lean();

    return {
      ...this.core(m),
      mailbox: m.mailbox,
      ...(m.dedupKey === undefined ? {} : { dedupKey: m.dedupKey }),
      recipientCheck: m.recipientCheck,
      ...(m.messageIdHeader === undefined ? {} : { rfcMessageId: m.messageIdHeader }),
      attachments: m.attachments.map((a) => ({
        filename: a.filename,
        contentType: a.contentType,
        size: a.size,
        sha256: a.sha256,
      })),
      inlineImages: m.inlineImages.map((image) => ({ cid: image.cid, contentType: image.contentType })),
      ...(m.emlSha256 === undefined || m.emlSize === undefined
        ? {}
        : { eml: { sha256: m.emlSha256, size: m.emlSize } }),
      sentCopy: m.sentCopy,
      ...(m.status === 'RETRY_SCHEDULED' ? { nextAttemptAt: m.nextAttemptAt.toISOString() } : {}),
      ...(m.lastError === undefined
        ? {}
        : {
            lastError: {
              code: m.lastError.code,
              detail: m.lastError.detail,
              at: m.lastError.at.toISOString(),
            },
          }),
      attempts: m.attemptLog.map((entry, i) => ({
        n: i + 1,
        startedAt: entry.startedAt.toISOString(),
        endedAt: entry.endedAt.toISOString(),
        outcome: entry.outcome,
        ...(entry.code === undefined ? {} : { code: entry.code }),
        ...(entry.smtpCode === undefined ? {} : { smtpCode: entry.smtpCode }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      })),
      ...(m.deliveryError === undefined
        ? {}
        : { deliveryError: { code: m.deliveryError.code, detail: m.deliveryError.detail } }),
      receipts: receipts.map((r) => ({ receiptId: r._id, type: r.type, issuedAt: r.issuedAt.toISOString() })),
      operatorActions: m.operatorLog.map((entry) => ({ at: entry.at.toISOString(), action: entry.action })),
      timeline: {
        createdAt: m.createdAt.toISOString(),
        ...(m.sendingStartedAt === undefined ? {} : { sendingStartedAt: m.sendingStartedAt.toISOString() }),
        ...(m.sentAt === undefined ? {} : { sentAt: m.sentAt.toISOString() }),
        ...(m.failedAt === undefined ? {} : { failedAt: m.failedAt.toISOString() }),
        ...(m.stuckAt === undefined ? {} : { stuckAt: m.stuckAt.toISOString() }),
        ...(m.cancelledAt === undefined ? {} : { cancelledAt: m.cancelledAt.toISOString() }),
        ...(m.acceptedAt === undefined ? {} : { acceptedAt: m.acceptedAt.toISOString() }),
        ...(m.deliveredAt === undefined ? {} : { deliveredAt: m.deliveredAt.toISOString() }),
        ...(m.notDeliveredAt === undefined ? {} : { notDeliveredAt: m.notDeliveredAt.toISOString() }),
        ...(m.settledAt === undefined ? {} : { settledAt: m.settledAt.toISOString() }),
      },
    };
  }

  public async rendered(tenantId: TenantId, rawId: string): Promise<RenderedMessageDto> {
    const m = await this.find(tenantId, rawId);

    return { messageId: m._id, subject: m.subject, html: m.html };
  }

  /**
   * The EML exactly as transmitted, with the digest recorded when it was
   * written: the client verifies the file against it, so a file altered on
   * disk afterwards shows up as a mismatch instead of being vouched for.
   */
  public async eml(tenantId: TenantId, rawId: string): Promise<FileDownload> {
    const m = await this.find(tenantId, rawId);
    if (m.emlPath === undefined || m.emlSha256 === undefined) {
      throw AppError.conflict('EML_NOT_AVAILABLE', 'The message has not been transmitted', {
        detail: `status ${m.status}: the EML exists once the message was handed to the provider`,
      });
    }
    return this.file(m.emlPath, `${m._id}.eml`, 'message/rfc822', m.emlSha256);
  }

  public async listReceipts(tenantId: TenantId, rawMessageId: string): Promise<ReceiptListDto> {
    const m = await this.find(tenantId, rawMessageId);
    const receipts = await this.receipts.find({ tenantId, messageId: m._id }).sort({ issuedAt: 1 }).lean();

    return {
      items: receipts.map((r) => ({
        receiptId: r._id,
        messageId: r.messageId,
        type: r.type,
        issuedAt: r.issuedAt.toISOString(),
        receivedAt: r.receivedAt.toISOString(),
        ...(r.provider === undefined ? {} : { provider: r.provider }),
        ...(r.recipient === undefined ? {} : { recipient: r.recipient }),
        ...(r.errorCode === undefined ? {} : { errorCode: r.errorCode }),
        ...(r.errorDetail === undefined ? {} : { errorDetail: r.errorDetail }),
        eml: { sha256: r.emlSha256, size: r.emlSize },
        ...(r.daticertSha256 === undefined || r.daticertSize === undefined
          ? {}
          : { daticert: { sha256: r.daticertSha256, size: r.daticertSize } }),
      })),
    };
  }

  /** The receipt exactly as the provider delivered it, signature included: the legal proof. */
  public async receiptEml(tenantId: TenantId, rawId: string): Promise<FileDownload> {
    const r = await this.findReceipt(tenantId, rawId);

    return this.file(r.emlPath, `${r._id}.eml`, 'message/rfc822', r.emlSha256);
  }

  public async receiptDaticert(tenantId: TenantId, rawId: string): Promise<FileDownload> {
    const r = await this.findReceipt(tenantId, rawId);
    if (r.daticertPath === undefined || r.daticertSha256 === undefined) {
      throw AppError.notFound('DATICERT_NOT_FOUND', 'This receipt carries no daticert.xml');
    }

    return this.file(r.daticertPath, `${r._id}.daticert.xml`, 'application/xml', r.daticertSha256);
  }

  private async findReceipt(tenantId: TenantId, rawId: string): Promise<ReceiptDocument> {
    const receipt = looksLikeId(rawId, 'r')
      ? await this.receipts.findOne({ _id: asReceiptId(rawId), tenantId }).lean()
      : null;
    if (receipt === null) {
      throw AppError.notFound('RECEIPT_NOT_FOUND', 'Receipt not found');
    }

    return receipt;
  }

  private async file(
    relativePath: string,
    filename: string,
    contentType: string,
    sha256: string,
  ): Promise<FileDownload> {
    const path = this.store.absolute(relativePath);
    const info = await stat(path);

    return { stream: createReadStream(path), filename, contentType, size: info.size, sha256 };
  }

  private async find(tenantId: TenantId, rawId: string): Promise<MessageDocument> {
    const message = looksLikeId(rawId, 'm')
      ? await this.messages.findOne({ _id: asMessageId(rawId), tenantId }).lean()
      : null;
    if (message === null) {
      throw AppError.notFound('MESSAGE_NOT_FOUND', 'Message not found');
    }

    return message;
  }

  private filters(tenantId: TenantId, query: BatchMessagesQuery): Record<string, unknown> {
    return {
      tenantId,
      ...(query.status === undefined ? {} : { status: { $in: query.status } }),
      ...(query.ref === undefined ? {} : { ref: { $in: query.ref } }),
      ...(query.to === undefined ? {} : { toLower: { $in: query.to.map((to) => to.toLowerCase()) } }),
      ...(query.subTenant === undefined ? {} : { subTenant: { $in: query.subTenant } }),
      ...(query.subject === undefined
        ? {}
        : { subject: { $regex: escapeRegex(query.subject), $options: 'i' } }),
      ...createdRange(query.createdFrom, query.createdBefore),
    };
  }

  private page(
    found: readonly ListedMessage[],
    limit: number,
    list: string,
    keysOf: (last: ListedMessage) => readonly CursorKey[],
  ): MessageListDto {
    const page = found.slice(0, limit);
    const last = page.at(-1);

    return {
      items: page.map((m) => ({
        ...this.core(m),
        ...(m.lastError === undefined ? {} : { lastErrorCode: m.lastError.code }),
      })),
      ...(found.length > limit && last !== undefined ? { nextCursor: encodeCursor(list, keysOf(last)) } : {}),
    };
  }

  private core(m: ListedMessage): MessageListDto['items'][number] {
    return {
      messageId: m._id,
      batchId: m.batchId,
      ref: m.ref,
      to: m.to,
      ...(m.toName === undefined ? {} : { toName: m.toName }),
      ...(m.subTenant === undefined ? {} : { subTenant: m.subTenant }),
      subject: m.subject,
      status: m.status,
      settlement: m.settlement,
      attemptCount: m.attempts,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      ...(m.sentAt === undefined ? {} : { sentAt: m.sentAt.toISOString() }),
    };
  }
}
