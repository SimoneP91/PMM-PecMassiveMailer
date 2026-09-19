import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { MailboxCode } from '../../common/types/branded';
import { MAILBOX_LEASE_MODEL, type MailboxLeaseDocument } from './schemas/mailbox-lease.schema';

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

@Injectable()
export class MailboxLeaseService {
  public constructor(@InjectModel(MAILBOX_LEASE_MODEL) private readonly model: Model<MailboxLeaseDocument>) {}

  /**
   * Takes the lease when nobody holds it, when it expired, or when this owner
   * already holds it. One atomic upsert: a concurrent taker hits the unique
   * _id and loses.
   */
  public async tryAcquire(code: MailboxCode, owner: string, ttlMs: number, now: Date): Promise<boolean> {
    const expiresAt = new Date(now.getTime() + ttlMs);
    try {
      await this.model.updateOne(
        { _id: code, $or: [{ owner }, { expiresAt: { $lte: now } }] },
        { $set: { owner, expiresAt }, $setOnInsert: { acquiredAt: now } },
        { upsert: true },
      );

      return true;
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  }

  /** false = the lease is no longer ours (expired and taken): stop sending at once. */
  public async renew(code: MailboxCode, owner: string, ttlMs: number, now: Date): Promise<boolean> {
    const result = await this.model.updateOne(
      { _id: code, owner },
      { $set: { expiresAt: new Date(now.getTime() + ttlMs) } },
    );

    return result.matchedCount === 1;
  }

  public async release(code: MailboxCode, owner: string): Promise<void> {
    await this.model.deleteOne({ _id: code, owner });
  }

  public async holder(code: MailboxCode): Promise<MailboxLeaseDocument | null> {
    return this.model.findById(code).lean();
  }
}
