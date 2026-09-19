import { Schema } from 'mongoose';

export const IMAP_CURSOR_MODEL = 'ImapCursor';

/**
 * How far the receipts folder of a mailbox has been read. The mailbox is
 * never modified (no flag, no move): progress lives here instead. A change of
 * UIDVALIDITY means the server renumbered the folder, so reading starts over
 * and the receipt deduplication absorbs what was already seen.
 */
export interface ImapCursorDocument {
  /** "<mailbox code>:<folder>" */
  readonly _id: string;
  readonly uidValidity: string;
  readonly lastUid: number;
  readonly updatedAt: Date;
}

export const imapCursorSchema = new Schema<ImapCursorDocument>(
  {
    _id: { type: String, required: true },
    uidValidity: { type: String, required: true },
    lastUid: { type: Number, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'imap_cursors', versionKey: false },
);
