import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import type { MailboxCode } from '../../common/types/branded';
import { EventOutbox } from '../events/event-outbox';
import { MailboxRegistry } from './mailbox.registry';
import {
  MAILBOX_STATE_MODEL,
  type MailboxStateDocument,
  type MailboxStatus,
  type SuspensionCause,
} from './mailbox-state.schema';

export interface MailboxState {
  readonly status: MailboxStatus;
  readonly cause: SuspensionCause | undefined;
  readonly reason: string | undefined;
  readonly changedAt: Date | undefined;
}

const ACTIVE: MailboxState = { status: 'ACTIVE', cause: undefined, reason: undefined, changedAt: undefined };

function toState(doc: MailboxStateDocument): MailboxState {
  return { status: doc.status, cause: doc.cause, reason: doc.reason, changedAt: doc.changedAt };
}

@Injectable()
export class MailboxStateStore {
  public constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(MAILBOX_STATE_MODEL) private readonly model: Model<MailboxStateDocument>,
    private readonly registry: MailboxRegistry,
    private readonly outbox: EventOutbox,
  ) {}

  public async get(code: MailboxCode): Promise<MailboxState> {
    const doc = await this.model.findById(code).lean();

    return doc === null ? ACTIVE : toState(doc);
  }

  public async getMany(codes: readonly MailboxCode[]): Promise<ReadonlyMap<MailboxCode, MailboxState>> {
    const docs = await this.model.find({ _id: { $in: [...codes] } }).lean();
    const states = new Map<MailboxCode, MailboxState>(codes.map((code) => [code, ACTIVE]));
    for (const doc of docs) {
      states.set(doc._id, toState(doc));
    }

    return states;
  }

  /**
   * Stops every sending and reading on the mailbox. The client is notified
   * (mailbox.suspended) when the mailbox goes from active to suspended, once:
   * a second refusal while already suspended says nothing new.
   */
  public async suspend(code: MailboxCode, cause: SuspensionCause, reason: string, at: Date): Promise<void> {
    const tenantId = this.registry.get(code)?.tenantId;
    await this.connection.transaction(async (session) => {
      const previous = await this.model
        .findOneAndUpdate(
          { _id: code },
          { $set: { status: 'SUSPENDED', cause, reason: reason.slice(0, 1000), changedAt: at } },
          { upsert: true, returnDocument: 'before', session },
        )
        .lean();
      if (previous?.status === 'SUSPENDED' || tenantId === undefined) {
        return;
      }
      await this.outbox.record(
        {
          tenantId,
          type: 'mailbox.suspended',
          dedupKey: `mailbox.suspended:${code}:${at.toISOString()}`,
          occurredAt: at,
          data: { mailbox: code, cause, suspendedAt: at.toISOString() },
        },
        session,
      );
    });
  }

  public async activate(code: MailboxCode, at: Date): Promise<void> {
    await this.model.updateOne(
      { _id: code },
      { $set: { status: 'ACTIVE', changedAt: at }, $unset: { cause: 1, reason: 1 } },
      { upsert: true },
    );
  }
}
