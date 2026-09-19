import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { IMAP_CURSOR_MODEL, type ImapCursorDocument } from './schemas/imap-cursor.schema';

export interface ImapCursor {
  readonly uidValidity: string | undefined;
  readonly lastUid: number;
}

@Injectable()
export class ImapCursorStore {
  public constructor(@InjectModel(IMAP_CURSOR_MODEL) private readonly model: Model<ImapCursorDocument>) {}

  public async get(key: string): Promise<ImapCursor> {
    const doc = await this.model.findById(key).lean();

    return doc === null
      ? { uidValidity: undefined, lastUid: 0 }
      : { uidValidity: doc.uidValidity, lastUid: doc.lastUid };
  }

  /** Written after each mail: a crash re-reads at most the mail in hand, which deduplication absorbs. */
  public async advance(key: string, uidValidity: string, uid: number, at: Date): Promise<void> {
    await this.model.updateOne(
      { _id: key },
      { $set: { uidValidity, lastUid: uid, updatedAt: at } },
      { upsert: true },
    );
  }
}
