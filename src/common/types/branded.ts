/**
 * Nominal types over strings. A TenantId and a MailboxCode are both strings at
 * runtime, but passing one where the other is expected is a bug the compiler
 * can catch - which matters most for tenant isolation, where the wrong id in a
 * query means showing one client another client's data.
 */
declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, 'TenantId'>;
export type ApiKeyId = Brand<string, 'ApiKeyId'>;
export type MailboxCode = Brand<string, 'MailboxCode'>;
export type BatchId = Brand<string, 'BatchId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ReceiptId = Brand<string, 'ReceiptId'>;
export type EventId = Brand<string, 'EventId'>;

export const asTenantId = (value: string): TenantId => value as TenantId;
export const asApiKeyId = (value: string): ApiKeyId => value as ApiKeyId;
export const asMailboxCode = (value: string): MailboxCode => value as MailboxCode;
export const asBatchId = (value: string): BatchId => value as BatchId;
export const asMessageId = (value: string): MessageId => value as MessageId;
export const asReceiptId = (value: string): ReceiptId => value as ReceiptId;
export const asEventId = (value: string): EventId => value as EventId;
