import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model } from 'mongoose';

import type { MessageId, TenantId } from '../../common/types/branded';
import { BATCH_MODEL, type BatchDocument } from './schemas/batch.schema';
import { MESSAGE_MODEL, type MessageDocument } from './schemas/message.schema';

const INSERT_CHUNK = 500;

/**
 * The only code that writes batches and messages. Reads and writes always
 * carry the tenant, never a bare id.
 */
@Injectable()
export class BatchRepository {
  public constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(BATCH_MODEL) private readonly batches: Model<BatchDocument>,
    @InjectModel(MESSAGE_MODEL) private readonly messages: Model<MessageDocument>,
  ) {}

  /** Which of these keys this tenant already used, and by which message. */
  public async findUsedDedupKeys(
    tenantId: TenantId,
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, MessageId>> {
    if (keys.length === 0) {
      return new Map();
    }
    const found = await this.messages
      .find({ tenantId, dedupKey: { $in: [...keys] } }, { _id: 1, dedupKey: 1 })
      .lean();

    return new Map(found.map((doc) => [doc.dedupKey ?? '', doc._id]));
  }

  /**
   * Batch and messages appear together or not at all: a crash half-way must
   * not leave PENDING messages the worker would pick up for a batch that
   * does not exist.
   */
  public async createBatch(
    batch: Omit<BatchDocument, 'createdAt' | 'updatedAt'>,
    messages: readonly Omit<MessageDocument, 'createdAt' | 'updatedAt'>[],
  ): Promise<void> {
    await this.connection.transaction(async (session) => {
      await this.batches.create([batch], { session });
      for (let i = 0; i < messages.length; i += INSERT_CHUNK) {
        await this.messages.insertMany(messages.slice(i, i + INSERT_CHUNK), { session, ordered: true });
      }
    });
  }
}
