import { Schema } from 'mongoose';

import type { MailboxCode } from '../../common/types/branded';

export const MAILBOX_STATE_MODEL = 'MailboxState';

export type MailboxStatus = 'ACTIVE' | 'SUSPENDED';

/**
 * Operational state of a mailbox, the one thing about a mailbox that lives
 * in the database: the configuration says what it is, this says whether it
 * currently works. Written by the worker (a refused login suspends it) and
 * by an operator (reactivation); absent = ACTIVE.
 */
export interface MailboxStateDocument {
  readonly _id: MailboxCode;
  readonly status: MailboxStatus;
  readonly reason?: string;
  readonly changedAt: Date;
}

export const mailboxStateSchema = new Schema<MailboxStateDocument>(
  {
    _id: { type: String, required: true },
    status: { type: String, required: true },
    reason: { type: String },
    changedAt: { type: Date, required: true },
  },
  { collection: 'mailbox_states', versionKey: false },
);
