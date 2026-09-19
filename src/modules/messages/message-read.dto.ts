import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { commaList, cursorParam, dateParam, limitParam, repeatedList } from '../../common/http/list-query';
import { messageStatusSchema } from '../batches/batch-response.dto';

const settlementSchema = z
  .enum(['PENDING', 'SETTLED', 'TIMED_OUT'])
  .describe('Receipts: PENDING until the final receipt arrives or the wait times out (stage 5)');

const messageCore = {
  messageId: z.string(),
  batchId: z.string(),
  ref: z.string(),
  to: z.string(),
  toName: z.string().optional(),
  subTenant: z.string().optional(),
  subject: z.string(),
  status: messageStatusSchema,
  settlement: settlementSchema,
  attemptCount: z.number().int().describe('Delivery attempts made (a refused mailbox login is not counted)'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  sentAt: z.iso.datetime().optional(),
};

export const messageListItemSchema = z.object({
  ...messageCore,
  lastErrorCode: z.string().optional(),
});

export const messageListSchema = z.object({
  items: z.array(messageListItemSchema),
  nextCursor: z.string().optional().describe('Present when there are more items: pass it back as ?cursor='),
});

export const attemptSchema = z.object({
  n: z.number().int().describe('Order of the entry'),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime(),
  outcome: z
    .enum(['SENT', 'RETRY_SCHEDULED', 'FAILED', 'STUCK', 'MAILBOX_SUSPENDED'])
    .describe(
      'MAILBOX_SUSPENDED: the mailbox login was refused; the message went back to the queue, not counted',
    ),
  code: z.string().optional(),
  smtpCode: z.number().int().optional(),
  detail: z.string().optional().describe("The provider's reply, or what went wrong"),
});

export const receiptTypeSchema = z
  .enum([
    'ACCEPTANCE',
    'NON_ACCEPTANCE',
    'TAKING_CHARGE',
    'DELIVERY',
    'NON_DELIVERY',
    'NON_DELIVERY_WARNING',
    'VIRUS_DETECTED',
  ])
  .describe(
    'ACCEPTANCE (ricevuta di accettazione), DELIVERY (avvenuta consegna), NON_DELIVERY (mancata consegna), ' +
      'NON_DELIVERY_WARNING (preavviso, informational), VIRUS_DETECTED, NON_ACCEPTANCE, TAKING_CHARGE (presa in carico, informational)',
  );

const digestSchema = z.object({
  sha256: z.string().describe('Hex digest of the file'),
  size: z.number().int(),
});

export const receiptSchema = z.object({
  receiptId: z.string(),
  messageId: z.string(),
  type: receiptTypeSchema,
  issuedAt: z.iso.datetime().describe('When the provider issued it (from daticert.xml)'),
  receivedAt: z.iso.datetime().describe('When this service read it'),
  provider: z.string().optional().describe('gestore-emittente'),
  recipient: z.string().optional(),
  errorCode: z.string().optional().describe('daticert errore: no-dest, no-dominio, virus, altro'),
  errorDetail: z.string().optional().describe('daticert errore-esteso'),
  eml: digestSchema.describe('The receipt as received, signed by the provider: GET /v1/receipts/{id}/eml'),
  daticert: digestSchema.optional().describe('GET /v1/receipts/{id}/daticert'),
});

export const receiptListSchema = z.object({ items: z.array(receiptSchema) });

export const messageDetailSchema = z.object({
  ...messageCore,
  mailbox: z.string(),
  dedupKey: z.string().optional(),
  recipientCheck: z
    .enum(['PEC', 'UNVERIFIED'])
    .describe('UNVERIFIED = accepted with options.unverifiedRecipients = "send"'),
  rfcMessageId: z
    .string()
    .optional()
    .describe(
      'Message-ID header of the PEC as sent; the receipts quote it, and it finds the message in the mailbox',
    ),
  attachments: z.array(
    z.object({
      filename: z.string(),
      contentType: z.string(),
      size: z.number().int(),
      sha256: z.string().describe('Hex digest of the file as received'),
    }),
  ),
  inlineImages: z.array(z.object({ cid: z.string(), contentType: z.string() })),
  eml: z
    .object({
      sha256: z.string().describe('Hex digest of the exact bytes transmitted'),
      size: z.number().int(),
    })
    .optional()
    .describe('Present once the message was transmitted (or may have been, when STUCK): GET .../eml'),
  sentCopy: z
    .enum(['PENDING', 'ARCHIVED', 'FAILED', 'DISABLED'])
    .describe("Copy filed in the mailbox's Sent folder"),
  nextAttemptAt: z.iso.datetime().optional().describe('When RETRY_SCHEDULED: the next try'),
  lastError: z.object({ code: z.string(), detail: z.string(), at: z.iso.datetime() }).optional(),
  attempts: z.array(attemptSchema),
  deliveryError: z
    .object({ code: z.string(), detail: z.string() })
    .optional()
    .describe('From the non-delivery receipt, when NOT_DELIVERED'),
  receipts: z
    .array(z.object({ receiptId: z.string(), type: receiptTypeSchema, issuedAt: z.iso.datetime() }))
    .describe('Receipts read so far, oldest first; the full detail is in /receipts'),
  operatorActions: z
    .array(
      z.object({
        at: z.iso.datetime(),
        action: z.enum(['MARKED_SENT', 'REQUEUED', 'MARKED_FAILED']),
      }),
    )
    .describe('Decisions taken by an operator on a STUCK message'),
  timeline: z.object({
    createdAt: z.iso.datetime(),
    sendingStartedAt: z.iso.datetime().optional(),
    sentAt: z.iso.datetime().optional(),
    failedAt: z.iso.datetime().optional(),
    stuckAt: z.iso.datetime().optional(),
    cancelledAt: z.iso.datetime().optional(),
    acceptedAt: z.iso.datetime().optional(),
    deliveredAt: z.iso.datetime().optional(),
    notDeliveredAt: z.iso.datetime().optional(),
    settledAt: z.iso.datetime().optional(),
  }),
});

export const renderedSchema = z.object({
  messageId: z.string(),
  subject: z.string(),
  html: z.string().describe('The body exactly as rendered from the template and the values of this row'),
});

const filters = {
  status: commaList(messageStatusSchema)
    .optional()
    .describe(`One or more of ${messageStatusSchema.options.join(', ')}; comma separated`),
  ref: repeatedList(z.string().min(1).max(200))
    .optional()
    .describe('Exact ref; repeat the parameter for several'),
  to: repeatedList(z.string().min(3).max(254))
    .optional()
    .describe('Recipient address, exact and case-insensitive; repeat the parameter for several'),
  subject: z.string().min(1).max(200).optional().describe('Case-insensitive "contains"'),
  subTenant: commaList(z.string().min(1).max(64))
    .optional()
    .describe('Exact subTenant values, comma separated'),
  createdFrom: dateParam.optional().describe('ISO 8601, inclusive'),
  createdBefore: dateParam.optional().describe('ISO 8601, exclusive'),
  limit: limitParam,
  cursor: cursorParam,
};

export const batchMessagesQuerySchema = z.strictObject(filters);

export const messageSearchQuerySchema = z.strictObject({
  ...filters,
  batchId: repeatedList(z.string().min(1).max(40)).optional().describe('Limit the search to these batches'),
});

export class MessageListDto extends createZodDto(messageListSchema) {}
export class MessageDetailDto extends createZodDto(messageDetailSchema) {}
export class RenderedMessageDto extends createZodDto(renderedSchema) {}
export class ReceiptListDto extends createZodDto(receiptListSchema) {}
export class BatchMessagesQueryDto extends createZodDto(batchMessagesQuerySchema) {}
export class MessageSearchQueryDto extends createZodDto(messageSearchQuerySchema) {}

export type BatchMessagesQuery = z.output<typeof batchMessagesQuerySchema>;
export type MessageSearchQuery = z.output<typeof messageSearchQuerySchema>;
