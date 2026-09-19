import { Schema } from 'mongoose';

import type { MailboxCode } from '../../common/types/branded';

export const MAILBOX_STATE_MODEL = 'MailboxState';

export type MailboxStatus = 'ACTIVE' | 'SUSPENDED';

/** Why a mailbox was suspended; the only part of the reason a client is told. */
export type SuspensionCause = 'SMTP_AUTH_REFUSED' | 'IMAP_AUTH_REFUSED' | 'OPERATOR';

/**
 * Operational state of a mailbox, the one thing about a mailbox that lives
 * in the database: the configuration says what it is, this says whether it
 * currently works. Written by the worker (a refused login suspends it) and
 * by an operator (reactivation); absent = ACTIVE.
 */
export interface MailboxStateDocument {
  readonly _id: MailboxCode;
  readonly status: MailboxStatus;
  readonly cause?: SuspensionCause;
  /** Operator-facing detail (the provider's reply); never sent to the client. */
  readonly reason?: string;
  readonly changedAt: Date;
}

export const mailboxStateSchema = new Schema<MailboxStateDocument>(
  {
    _id: { type: String, required: true },
    status: { type: String, required: true },
    cause: { type: String },
    reason: { type: String },
    changedAt: { type: Date, required: true },
  },
  { collection: 'mailbox_states', versionKey: false },
);
