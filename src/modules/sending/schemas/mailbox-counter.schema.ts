import { Schema } from 'mongoose';

import type { MailboxCode } from '../../../common/types/branded';

export const MAILBOX_COUNTER_MODEL = 'MailboxCounter';

/**
 * What was sent through a mailbox in the current minute and the current day,
 * so pacing survives a worker restart and a lease moving to another replica.
 * Written only by the lease holder, which is why plain read-modify-write is
 * enough.
 */
export interface MailboxCounterDocument {
  readonly _id: MailboxCode;
  readonly minuteStart: Date;
  readonly minuteCount: number;
  /** UTC calendar day, YYYY-MM-DD */
  readonly day: string;
  readonly dayCount: number;
  readonly updatedAt: Date;
}

export const mailboxCounterSchema = new Schema<MailboxCounterDocument>(
  {
    _id: { type: String, required: true },
    minuteStart: { type: Date, required: true },
    minuteCount: { type: Number, required: true },
    day: { type: String, required: true },
    dayCount: { type: Number, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'mailbox_counters', versionKey: false },
);
