import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { MailboxCode, MessageId } from '../../common/types/branded';
import { BatchLifecycle } from '../batches/batch-lifecycle';
import { BATCH_MODEL, type BatchDocument } from '../batches/schemas/batch.schema';
import {
  MAX_LOG_ENTRIES,
  MESSAGE_MODEL,
  type AttemptLogEntry,
  type AttemptOutcome,
  type MessageDocument,
  type MessageError,
  type OperatorAction,
  type SentCopyState,
} from '../batches/schemas/message.schema';

/** What the worker knows about one pass over a message, for the history. */
export interface AttemptReport {
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly code?: string;
  readonly smtpCode?: number;
  readonly detail?: string;
}

/** The file that was (or may have been) transmitted, and its digest. */
export interface EmlRecord {
  readonly messageIdHeader: string;
  readonly emlPath: string;
  readonly emlSha256: string;
  readonly emlSize: number;
}

export interface SentRecord extends EmlRecord {
  readonly sentAt: Date;
  readonly smtpResponse: string;
  readonly sentCopy: SentCopyState;
}

export type StuckResolution = 'sent' | 'requeue' | 'failed';

const DETAIL_MAX = 1000;

function logEntry(outcome: AttemptOutcome, report: AttemptReport): AttemptLogEntry {
  return {
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    outcome,
    ...(report.code === undefined ? {} : { code: report.code }),
    ...(report.smtpCode === undefined ? {} : { smtpCode: report.smtpCode }),
    ...(report.detail === undefined ? {} : { detail: report.detail.slice(0, DETAIL_MAX) }),
  };
}

function pushAttempt(outcome: AttemptOutcome, report: AttemptReport): Record<string, unknown> {
  return { attemptLog: { $each: [logEntry(outcome, report)], $slice: -MAX_LOG_ENTRIES } };
}

const LEAVE_SENDING = { sendingStartedAt: 1, heartbeatAt: 1, workerId: 1 } as const;

/**
 * The message state machine, as seen by the worker and the operator:
 *
 *   PENDING / RETRY_SCHEDULED --claim--> SENDING --> SENT | RETRY_SCHEDULED | FAILED | STUCK
 *   SENDING --login refused--> PENDING (not counted as an attempt)
 *   STUCK --operator--> SENT | PENDING | FAILED
 *   PENDING / RETRY_SCHEDULED --client cancel--> CANCELLED (batches module)
 *
 * Every transition is one atomic update conditioned on the state it leaves,
 * so a late or duplicate call cannot move a message twice. After a terminal
 * transition the batch is closed if nothing in it is open any more.
 */
@Injectable()
export class MessageQueueRepository {
  public constructor(
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
    @InjectModel(BATCH_MODEL) private readonly batches: Model<BatchDocument>,
    private readonly lifecycle: BatchLifecycle,
  ) {}

  public async hasPending(mailbox: MailboxCode, now: Date): Promise<boolean> {
    const found = await this.messages
      .exists({ mailbox, status: { $in: ['PENDING', 'RETRY_SCHEDULED'] }, nextAttemptAt: { $lte: now } })
      .lean();

    return found !== null;
  }

  /** Oldest due message of the mailbox, in the client's row order, moved to SENDING in the same operation. */
  public async claimNext(mailbox: MailboxCode, workerId: string, now: Date): Promise<MessageDocument | null> {
    const claimed = await this.messages
      .findOneAndUpdate(
        { mailbox, status: { $in: ['PENDING', 'RETRY_SCHEDULED'] }, nextAttemptAt: { $lte: now } },
        {
          $set: { status: 'SENDING', sendingStartedAt: now, heartbeatAt: now, workerId },
          $inc: { attempts: 1 },
        },
        { sort: { nextAttemptAt: 1, createdAt: 1, position: 1 }, new: true },
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

  /** The worker is still at it: keeps stale recovery away from a slow but live send. */
  public async heartbeat(id: MessageId, workerId: string, now: Date): Promise<void> {
    await this.messages.updateOne({ _id: id, status: 'SENDING', workerId }, { $set: { heartbeatAt: now } });
  }

  public async markSent(id: MessageId, record: SentRecord, attempt: AttemptReport): Promise<void> {
    const moved = await this.transition(id, 'SENDING', {
      $set: {
        status: 'SENT',
        sentAt: record.sentAt,
        messageIdHeader: record.messageIdHeader,
        smtpResponse: record.smtpResponse,
        emlPath: record.emlPath,
        emlSha256: record.emlSha256,
        emlSize: record.emlSize,
        sentCopy: record.sentCopy,
      },
      $unset: LEAVE_SENDING,
      $push: pushAttempt('SENT', attempt),
    });
    if (!moved) {
      throw new Error(`message ${id} was not SENDING when marked SENT`);
    }
  }

  public async markRetry(
    id: MessageId,
    nextAttemptAt: Date,
    error: MessageError,
    attempt: AttemptReport,
  ): Promise<void> {
    await this.messages.updateOne(
      { _id: id, status: 'SENDING' },
      {
        $set: { status: 'RETRY_SCHEDULED', nextAttemptAt, lastError: error },
        $unset: LEAVE_SENDING,
        $push: pushAttempt('RETRY_SCHEDULED', attempt),
      },
    );
  }

  public async markFailed(id: MessageId, error: MessageError, attempt: AttemptReport): Promise<void> {
    await this.transition(id, 'SENDING', {
      // FAILED is final: there is no receipt to wait for.
      $set: {
        status: 'FAILED',
        failedAt: error.at,
        lastError: error,
        settlement: 'SETTLED',
        settledAt: error.at,
      },
      $unset: LEAVE_SENDING,
      $push: pushAttempt('FAILED', attempt),
    });
  }

  /**
   * The outcome is unknown. The EML that was transmitted is recorded, so an
   * operator can look for its Message-ID and a client can download what may
   * have left.
   */
  public async markStuck(
    id: MessageId,
    error: MessageError,
    attempt: AttemptReport,
    eml: EmlRecord | undefined,
  ): Promise<void> {
    await this.transition(id, 'SENDING', {
      $set: { status: 'STUCK', stuckAt: error.at, lastError: error, ...(eml ?? {}) },
      $unset: LEAVE_SENDING,
      $push: pushAttempt('STUCK', attempt),
    });
  }

  /** The attempt never reached the server (login refused): give the message back, attempt not counted. */
  public async releaseToPending(id: MessageId, now: Date, attempt: AttemptReport): Promise<void> {
    await this.messages.updateOne(
      { _id: id, status: 'SENDING' },
      {
        $set: { status: 'PENDING', nextAttemptAt: now },
        $inc: { attempts: -1 },
        $unset: LEAVE_SENDING,
        $push: pushAttempt('MAILBOX_SUSPENDED', attempt),
      },
    );
  }

  public async updateSentCopy(id: MessageId, state: SentCopyState, error?: string): Promise<void> {
    await this.messages.updateOne(
      { _id: id },
      error === undefined
        ? { $set: { sentCopy: state }, $unset: { sentCopyError: 1 } }
        : { $set: { sentCopy: state, sentCopyError: error.slice(0, DETAIL_MAX) } },
    );
  }

  /**
   * Messages SENDING whose worker stopped proving it is alive before
   * `olderThan`: it died without saying whether the message left. Nobody may
   * resend them; an operator checks the provider's webmail and resolves each.
   */
  public async recoverStale(olderThan: Date, now: Date): Promise<readonly MessageDocument[]> {
    const stale = await this.messages
      .find(
        {
          status: 'SENDING',
          $or: [
            { heartbeatAt: { $lt: olderThan } },
            { heartbeatAt: { $exists: false }, sendingStartedAt: { $lt: olderThan } },
          ],
        },
        { _id: 1, batchId: 1, mailbox: 1, ref: 1, workerId: 1, sendingStartedAt: 1, heartbeatAt: 1 },
      )
      .lean();
    const recovered: MessageDocument[] = [];
    for (const message of stale) {
      const lastSign = message.heartbeatAt ?? message.sendingStartedAt;
      const detail = `no sign of life from ${message.workerId ?? 'unknown worker'} since ${lastSign?.toISOString() ?? 'unknown'}; outcome unknown`;
      const moved = await this.transition(message._id, 'SENDING', {
        $set: { status: 'STUCK', stuckAt: now, lastError: { code: 'STALE_SENDING', detail, at: now } },
        $unset: LEAVE_SENDING,
        $push: pushAttempt('STUCK', {
          startedAt: message.sendingStartedAt ?? now,
          endedAt: now,
          code: 'STALE_SENDING',
          detail,
        }),
      });
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
    const action: OperatorAction =
      resolution === 'sent' ? 'MARKED_SENT' : resolution === 'failed' ? 'MARKED_FAILED' : 'REQUEUED';
    const log = { operatorLog: { $each: [{ at: now, action, by }], $slice: -MAX_LOG_ENTRIES } };

    switch (resolution) {
      case 'sent':
        return this.transition(id, 'STUCK', { $set: { status: 'SENT', sentAt: now }, $push: log });
      case 'failed':
        return this.transition(id, 'STUCK', {
          $set: { status: 'FAILED', failedAt: now, settlement: 'SETTLED', settledAt: now },
          $push: log,
        });
      case 'requeue':
        return this.transition(id, 'STUCK', {
          $set: { status: 'PENDING', nextAttemptAt: now },
          $unset: { stuckAt: 1 },
          $push: log,
        });
    }
  }

  public async findById(id: MessageId): Promise<MessageDocument | null> {
    return this.messages.findById(id).lean();
  }

  private async transition(
    id: MessageId,
    from: MessageDocument['status'],
    update: Record<string, unknown>,
  ): Promise<boolean> {
    const moved = await this.messages
      .findOneAndUpdate({ _id: id, status: from }, update, { new: true })
      .lean();
    if (moved === null) {
      return false;
    }
    await this.lifecycle.completeIfDone(moved.batchId, new Date());

    return true;
  }
}
