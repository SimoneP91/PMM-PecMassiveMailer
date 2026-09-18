import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { MailboxCode } from '../../common/types/branded';
import { MAILBOX_STATE_MODEL, type MailboxStateDocument, type MailboxStatus } from './mailbox-state.schema';

export interface MailboxState {
  readonly status: MailboxStatus;
  readonly reason: string | undefined;
}

const ACTIVE: MailboxState = { status: 'ACTIVE', reason: undefined };

@Injectable()
export class MailboxStateStore {
  public constructor(@InjectModel(MAILBOX_STATE_MODEL) private readonly model: Model<MailboxStateDocument>) {}

  public async get(code: MailboxCode): Promise<MailboxState> {
    const doc = await this.model.findById(code).lean();

    return doc === null ? ACTIVE : { status: doc.status, reason: doc.reason };
  }

  public async getMany(codes: readonly MailboxCode[]): Promise<ReadonlyMap<MailboxCode, MailboxState>> {
    const docs = await this.model.find({ _id: { $in: [...codes] } }).lean();
    const states = new Map<MailboxCode, MailboxState>(codes.map((code) => [code, ACTIVE]));
    for (const doc of docs) {
      states.set(doc._id, { status: doc.status, reason: doc.reason });
    }

    return states;
  }

  public async set(
    code: MailboxCode,
    status: MailboxStatus,
    reason: string | undefined,
    at: Date,
  ): Promise<void> {
    await this.model.updateOne(
      { _id: code },
      {
        $set: { status, changedAt: at, ...(reason === undefined ? {} : { reason }) },
        ...(reason === undefined ? { $unset: { reason: 1 } } : {}),
      },
      { upsert: true },
    );
  }
}
