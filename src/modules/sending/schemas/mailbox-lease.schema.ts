import { Schema } from 'mongoose';

import type { MailboxCode } from '../../../common/types/branded';

export const MAILBOX_LEASE_MODEL = 'MailboxLease';

/**
 * "One mailbox, one sender at a time." Whoever holds the lease sends; a
 * lease that is not renewed expires and another worker may take it. The
 * provider's connection and rate limits belong to the mailbox, not to the
 * number of replicas, so this is what keeps N worker replicas safe.
 */
export interface MailboxLeaseDocument {
  readonly _id: MailboxCode;
  readonly owner: string;
  readonly acquiredAt: Date;
  readonly expiresAt: Date;
}

export const mailboxLeaseSchema = new Schema<MailboxLeaseDocument>(
  {
    _id: { type: String, required: true },
    owner: { type: String, required: true },
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'mailbox_leases', versionKey: false },
);
