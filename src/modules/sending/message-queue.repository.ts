import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { BatchId, MailboxCode, MessageId } from '../../common/types/branded';
import { BATCH_MODEL, type BatchCounts, type BatchDocument } from '../batches/schemas/batch.schema';
import {
  MESSAGE_MODEL,
  type MessageDocument,
  type MessageError,
  type SentCopyState,
} from '../batches/schemas/message.schema';

export interface SentRecord {
  readonly sentAt: Date;
  readonly messageIdHeader: string;
  readonly smtpResponse: string;
  readonly emlPath: string;
  readonly sentCopy: SentCopyState;
}

export type StuckResolution = 'sent' | 'requeue' | 'failed';

type CountKey = keyof BatchCounts;

/**
 * The message state machine, as seen by the worker and the operator:
 *
 *   PENDING / RETRY_SCHEDULED --claim--> SENDING --> SENT | RETRY_SCHEDULED | FAILED | STUCK
 *   STUCK --operator--> SENT | PENDING | FAILED
 *
 * Every transition is one atomic update conditioned on the state it leaves,
 * so a late or duplicate call cannot move a message twice. Batch counters
 * follow each transition; a batch is SENT when nothing is pending and
 * nothing is stuck.
 */
@Injectable()
export class MessageQueueRepository {
  public constructor(
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
    @InjectModel(BATCH_MODEL) private readonly batches: Model<BatchDocument>,
  ) {}

  public async hasPending(mailbox: MailboxCode, now: Date): Promise<boolean> {
    const found = await this.messages
      .exists({ mailbox, status: { $in: ['PENDING', 'RETRY_SCHEDULED'] }, nextAttemptAt: { $lte: now } })
      .lean();

    return found !== null;
  }

  /** Oldest due message of the mailbox, moved to SENDING in the same operation. */
  public async claimNext(mailbox: MailboxCode, workerId: string, now: Date): Promise<MessageDocument | null> {
    const claimed = await this.messages
      .findOneAndUpdate(
        { mailbox, status: { $in: ['PENDING', 'RETRY_SCHEDULED'] }, nextAttemptAt: { $lte: now } },
        { $set: { status: 'SENDING', sendingStartedAt: now, workerId }, $inc: { attempts: 1 } },
        { sort: { nextAttemptAt: 1, createdAt: 1 }, new: true },
      )
      .lean();
    if (claimed === null) {
      return null;
    }
    await this.batches.updateOne(
      { _id: claimed.batchId, status: 'QUEUED' },
      { $set: { status: 'SENDING', sendingStartedAt: now } },
    );

    return claimed;
  }

  public async markSent(id: MessageId, record: SentRecord): Promise<void> {
    const moved = await this.transition(
      id,
      'SENDING',
      {
        $set: {
          status: 'SENT',
          sentAt: record.sentAt,
          messageIdHeader: record.messageIdHeader,
          smtpResponse: record.smtpResponse,
          emlPath: record.emlPath,
          sentCopy: record.sentCopy,
        },
        $unset: { sendingStartedAt: 1, workerId: 1 },
      },
      'pending',
      'sent',
      record.sentAt,
    );
    if (!moved) {
      throw new Error(`message ${id} was not SENDING when marked SENT`);
    }
  }

  public async markRetry(id: MessageId, nextAttemptAt: Date, error: MessageError): Promise<void> {
    await this.messages.updateOne(
      { _id: id, status: 'SENDING' },
      {
        $set: { status: 'RETRY_SCHEDULED', nextAttemptAt, lastError: error },
        $unset: { sendingStartedAt: 1, workerId: 1 },
      },
    );
  }

  public async markFailed(id: MessageId, error: MessageError): Promise<void> {
    await this.transition(
      id,
      'SENDING',
      {
        $set: { status: 'FAILED', failedAt: error.at, lastError: error },
        $unset: { sendingStartedAt: 1, workerId: 1 },
      },
      'pending',
      'failed',
      error.at,
    );
  }

  public async markStuck(id: MessageId, error: MessageError): Promise<void> {
    await this.transition(
      id,
      'SENDING',
      { $set: { status: 'STUCK', stuckAt: error.at, lastError: error }, $unset: { workerId: 1 } },
      'pending',
      'stuck',
      error.at,
    );
  }

  /** The attempt never reached the server (login refused): give the message back untouched. */
  public async releaseToPending(id: MessageId, now: Date): Promise<void> {
    await this.messages.updateOne(
      { _id: id, status: 'SENDING' },
      {
        $set: { status: 'PENDING', nextAttemptAt: now },
        $inc: { attempts: -1 },
        $unset: { sendingStartedAt: 1, workerId: 1 },
      },
    );
  }

  public async updateSentCopy(id: MessageId, state: SentCopyState, error?: string): Promise<void> {
    await this.messages.updateOne(
      { _id: id },
      error === undefined
        ? { $set: { sentCopy: state }, $unset: { sentCopyError: 1 } }
        : { $set: { sentCopy: state, sentCopyError: error } },
    );
  }

  /**
   * Messages SENDING since before `olderThan`: their worker died without
   * saying whether the message left. Nobody may resend them; an operator
   * checks the provider's webmail and resolves each one.
   */
  public async recoverStale(olderThan: Date, now: Date): Promise<readonly MessageDocument[]> {
    const stale = await this.messages
      .find(
        { status: 'SENDING', sendingStartedAt: { $lt: olderThan } },
        { _id: 1, batchId: 1, mailbox: 1, ref: 1, workerId: 1 },
      )
      .lean();
    const recovered: MessageDocument[] = [];
    for (const message of stale) {
      const moved = await this.transition(
        message._id,
        'SENDING',
        {
          $set: {
            status: 'STUCK',
            stuckAt: now,
            lastError: {
              code: 'STALE_SENDING',
              detail: `sending since ${message.sendingStartedAt?.toISOString() ?? 'unknown'} by ${message.workerId ?? 'unknown'}; outcome unknown`,
              at: now,
            },
          },
        },
        'pending',
        'stuck',
        now,
      );
      if (moved) {
        recovered.push(message);
      }
    }

    return recovered;
  }

  public async listStuck(limit = 100): Promise<readonly MessageDocument[]> {
    return this.messages.find({ status: 'STUCK' }).sort({ stuckAt: 1 }).limit(limit).lean();
  }

  /** Operator decision on a STUCK message, after checking the provider's Sent folder. */
  public async resolveStuck(
    id: MessageId,
    resolution: StuckResolution,
    by: string,
    now: Date,
  ): Promise<boolean> {
    const note: MessageError = {
      code: `RESOLVED_${resolution.toUpperCase()}`,
      detail: `resolved by ${by}`,
      at: now,
    };
    switch (resolution) {
      case 'sent':
        return this.transition(
          id,
          'STUCK',
          { $set: { status: 'SENT', sentAt: now, lastError: note } },
          'stuck',
          'sent',
          now,
        );
      case 'failed':
        return this.transition(
          id,
          'STUCK',
          { $set: { status: 'FAILED', failedAt: now, lastError: note } },
          'stuck',
          'failed',
          now,
        );
      case 'requeue':
        return this.transition(
          id,
          'STUCK',
          {
            $set: { status: 'PENDING', nextAttemptAt: now, lastError: note },
            $unset: { stuckAt: 1, sendingStartedAt: 1 },
          },
          'stuck',
          'pending',
          now,
        );
    }
  }

  public async findById(id: MessageId): Promise<MessageDocument | null> {
    return this.messages.findById(id).lean();
  }

  private async transition(
    id: MessageId,
    from: MessageDocument['status'],
    update: Record<string, unknown>,
    decrement: CountKey,
    increment: CountKey,
    now: Date,
  ): Promise<boolean> {
    const moved = await this.messages
      .findOneAndUpdate({ _id: id, status: from }, update, { new: true })
      .lean();
    if (moved === null) {
      return false;
    }
    await this.batches.updateOne(
      { _id: moved.batchId },
      { $inc: { [`counts.${decrement}`]: -1, [`counts.${increment}`]: 1 } },
    );
    await this.settleIfDone(moved.batchId, now);

    return true;
  }

  private async settleIfDone(batchId: BatchId, now: Date): Promise<void> {
    await this.batches.updateOne(
      { _id: batchId, status: 'SENDING', 'counts.pending': 0, 'counts.stuck': 0 },
      { $set: { status: 'SENT', sentAt: now } },
    );
  }
}
