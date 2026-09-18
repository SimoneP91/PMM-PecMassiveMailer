import { randomBytes } from 'node:crypto';

import {
  asBatchId,
  asEventId,
  asMessageId,
  asReceiptId,
  type BatchId,
  type EventId,
  type MessageId,
  type ReceiptId,
} from '../types/branded';

/**
 * Opaque identifiers: a short prefix that says what the thing is, then 96 bits
 * of randomness in base64url (16 characters). Not sequential on purpose: an id
 * must not reveal how many batches other tenants have sent, nor be guessable.
 */
function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

export const newBatchId = (): BatchId => asBatchId(newId('b'));
export const newMessageId = (): MessageId => asMessageId(newId('m'));
export const newReceiptId = (): ReceiptId => asReceiptId(newId('r'));
export const newEventId = (): EventId => asEventId(newId('ev'));

const ID_PATTERN = /^[a-z]{1,3}_[A-Za-z0-9_-]{16}$/;

export function looksLikeId(value: string, prefix: string): boolean {
  return ID_PATTERN.test(value) && value.startsWith(`${prefix}_`);
}
