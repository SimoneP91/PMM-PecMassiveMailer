import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { PinoLogger } from 'nestjs-pino';

import { newReceiptId } from '../../common/ids/id';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { ResolvedMailbox } from '../../config/config.loader';
import { AttachmentStore } from '../attachments/attachment-store';
import type { MessageStatus } from '../batches/batch-response.dto';
import { BatchLifecycle } from '../batches/batch-lifecycle';
import { MESSAGE_MODEL, type MessageDocument } from '../batches/schemas/message.schema';
import { parseReceipt, type ParsedReceipt, type ReceiptType } from './receipt-parser';
import { RECEIPT_MODEL, type ReceiptDocument } from './schemas/receipt.schema';

export type ProcessOutcome = 'stored' | 'duplicate' | 'unmatched' | 'ignored';

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Statuses a receipt may move a message out of. A receipt is proof from the
 * provider, so it also wins over what the worker could not know: a STUCK
 * message, one an operator requeued (PENDING again), or one whose earlier
 * attempt was in fact accepted (RETRY_SCHEDULED, FAILED), is moved to what
 * the receipt says - and the send that would have duplicated it never
 * happens. A PENDING message can only match a receipt after an attempt: its
 * Message-ID exists from the first attempt on. A message being sent right
 * now, or cancelled, is left alone.
 */
const MOVABLE: readonly MessageStatus[] = ['PENDING', 'SENT', 'STUCK', 'RETRY_SCHEDULED', 'FAILED'];

type Effect = 'accepted' | 'delivered' | 'notDelivered' | 'none';

const EFFECT_OF: Readonly<Record<ReceiptType, Effect>> = {
  ACCEPTANCE: 'accepted',
  DELIVERY: 'delivered',
  NON_DELIVERY: 'notDelivered',
  VIRUS_DETECTED: 'notDelivered',
  NON_ACCEPTANCE: 'notDelivered',
  // Informational: the final word comes later.
  TAKING_CHARGE: 'none',
  NON_DELIVERY_WARNING: 'none',
};

@Injectable()
export class ReceiptProcessor {
  public constructor(
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
    @InjectModel(RECEIPT_MODEL) private readonly receipts: Model<ReceiptDocument>,
    private readonly store: AttachmentStore,
    private readonly lifecycle: BatchLifecycle,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ReceiptProcessor.name);
  }

  /**
   * One mail read from a mailbox. Anything that is not a receipt about a
   * message sent from this mailbox is ignored: the mailbox may be shared with
   * people sending by hand.
   */
  public async process(mailbox: ResolvedMailbox, raw: Buffer, internalDate?: Date): Promise<ProcessOutcome> {
    let parsed: Awaited<ReturnType<typeof parseReceipt>>;
    try {
      parsed = await parseReceipt(raw);
    } catch (error: unknown) {
      this.logger.warn({ err: error, mailbox: mailbox.code }, 'unreadable mail in the receipts folder');

      return 'ignored';
    }
    if (parsed.kind === 'ignored') {
      return 'ignored';
    }

    const message = await this.messages
      .findOne({ mailbox: mailbox.code, messageIdHeader: parsed.refMessageId })
      .lean();
    if (message === null) {
      return 'unmatched';
    }

    const dedupKey = parsed.sourceMessageId ?? `sha256:${sha256(raw)}`;
    const known = await this.receipts.findOne({ mailbox: mailbox.code, dedupKey }, { issuedAt: 1 }).lean();
    if (known !== null) {
      // Stored already. Apply it again anyway: a crash between storing a receipt and
      // moving its message must not leave the message behind. Applying is idempotent.
      await this.apply(message, parsed, known.issuedAt);

      return 'duplicate';
    }

    const now = this.clock.now();
    const issuedAt = parsed.issuedAt ?? internalDate ?? now;
    const receipt = await this.save(message, mailbox, parsed, raw, dedupKey, issuedAt, now);
    if (receipt === null) {
      await this.apply(message, parsed, issuedAt);

      return 'duplicate';
    }

    await this.apply(message, parsed, issuedAt);
    this.logger.info(
      { mailbox: mailbox.code, messageId: message._id, receiptId: receipt._id, type: parsed.type },
      'receipt recorded',
    );

    return 'stored';
  }

  private async save(
    message: MessageDocument,
    mailbox: ResolvedMailbox,
    parsed: ParsedReceipt,
    raw: Buffer,
    dedupKey: string,
    issuedAt: Date,
    now: Date,
  ): Promise<ReceiptDocument | null> {
    const receiptId = newReceiptId();
    const base = `batches/${message.tenantId}/${message.batchId}/receipts/${receiptId}`;
    const emlPath = this.store.absolute(`${base}.eml`);
    const daticertPath =
      parsed.daticert === undefined ? undefined : this.store.absolute(`${base}.daticert.xml`);
    await mkdir(dirname(emlPath), { recursive: true });
    await writeFile(emlPath, raw, { flag: 'wx' });
    if (daticertPath !== undefined && parsed.daticert !== undefined) {
      await writeFile(daticertPath, parsed.daticert, { flag: 'wx' });
    }

    const doc: ReceiptDocument = {
      _id: receiptId,
      tenantId: message.tenantId,
      batchId: message.batchId,
      messageId: message._id,
      mailbox: mailbox.code,
      type: parsed.type,
      dedupKey,
      refMessageId: parsed.refMessageId,
      issuedAt,
      receivedAt: now,
      ...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
      ...(parsed.recipient === undefined ? {} : { recipient: parsed.recipient }),
      ...(parsed.errorCode === undefined ? {} : { errorCode: parsed.errorCode }),
      ...(parsed.errorDetail === undefined ? {} : { errorDetail: parsed.errorDetail.slice(0, 2000) }),
      ...(parsed.providerId === undefined ? {} : { providerId: parsed.providerId }),
      emlPath: this.store.relative(emlPath),
      emlSha256: sha256(raw),
      emlSize: raw.length,
      ...(daticertPath === undefined || parsed.daticert === undefined
        ? {}
        : {
            daticertPath: this.store.relative(daticertPath),
            daticertSha256: sha256(parsed.daticert),
            daticertSize: parsed.daticert.length,
          }),
      createdAt: now,
    };
    try {
      await this.receipts.create(doc);

      return doc;
    } catch (error: unknown) {
      await rm(emlPath, { force: true });
      if (daticertPath !== undefined) {
        await rm(daticertPath, { force: true });
      }
      if (isDuplicateKeyError(error)) {
        return null;
      }
      throw error;
    }
  }

  /** Moves the message forward, never back: a late acceptance does not undo a delivery. */
  private async apply(message: MessageDocument, parsed: ParsedReceipt, at: Date): Promise<void> {
    const effect = EFFECT_OF[parsed.type];
    const from = { _id: message._id, status: { $in: [...MOVABLE] } };

    switch (effect) {
      case 'none':
        return;
      case 'accepted': {
        const moved = await this.messages.updateOne(from, {
          $set: { status: 'ACCEPTED', acceptedAt: at, settlement: 'PENDING' },
          $min: { sentAt: at },
          $unset: { settledAt: 1, failedAt: 1, stuckAt: 1 },
        });
        if (moved.modifiedCount === 0) {
          // Already further along (a delivery read first): only complete the timeline.
          await this.messages.updateOne(
            { _id: message._id, acceptedAt: { $exists: false } },
            { $set: { acceptedAt: at } },
          );
        }
        break;
      }
      case 'delivered':
        await this.messages.updateOne(
          { _id: message._id, status: { $in: [...MOVABLE, 'ACCEPTED'] } },
          {
            $set: { status: 'DELIVERED', deliveredAt: at, settlement: 'SETTLED', settledAt: at },
            $min: { sentAt: at },
            $unset: { failedAt: 1, stuckAt: 1 },
          },
        );
        break;
      case 'notDelivered':
        await this.messages.updateOne(
          { _id: message._id, status: { $in: [...MOVABLE, 'ACCEPTED'] } },
          {
            $set: {
              status: 'NOT_DELIVERED',
              notDeliveredAt: at,
              deliveryError: {
                code: parsed.errorCode ?? parsed.type.toLowerCase(),
                detail: (parsed.errorDetail ?? parsed.type).slice(0, 1000),
              },
              settlement: 'SETTLED',
              settledAt: at,
            },
            $min: { sentAt: at },
            $unset: { failedAt: 1, stuckAt: 1 },
          },
        );
        break;
    }

    if (message.status !== 'SENT' && MOVABLE.includes(message.status)) {
      this.logger.warn(
        { messageId: message._id, was: message.status, receipt: parsed.type },
        'receipt proves the message left: status taken from the receipt',
      );
    }
    const now = this.clock.now();
    await this.lifecycle.completeIfDone(message.batchId, now);
    await this.lifecycle.settleIfDone(message.batchId, now);
  }
}
