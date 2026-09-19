import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { commaList, cursorParam, dateParam, limitParam, repeatedList } from '../../common/http/list-query';
import { batchStatusSchema, rejectedMessageSchema, warningSchema } from './batch-response.dto';

export const countersSchema = z
  .object({
    total: z.number().int(),
    pending: z.number().int(),
    sending: z.number().int(),
    retryScheduled: z.number().int(),
    sent: z.number().int(),
    accepted: z.number().int(),
    delivered: z.number().int(),
    notDelivered: z.number().int(),
    failed: z.number().int(),
    stuck: z
      .number()
      .int()
      .describe('Outcome unknown, an operator is on it; the batch stays SENDING meanwhile'),
    cancelled: z.number().int(),
  })
  .describe('Messages per status; always sums to total');

export const settlementCountersSchema = z
  .object({
    pending: z.number().int().describe('Sent and still waiting for the final receipt (or not sent yet)'),
    settled: z.number().int().describe('Final word known: delivered, not delivered, failed or cancelled'),
    timedOut: z
      .number()
      .int()
      .describe('No final receipt within the settlement window (receipts.settleAfterHours)'),
  })
  .describe('Messages per settlement state; sums to counters.total');

const batchCore = {
  batchId: z.string(),
  status: batchStatusSchema,
  mailbox: z.string(),
  reference: z.string().optional(),
  subTenant: z.string().optional(),
  messageCount: z.number().int().describe('Rows accepted into the batch'),
  rejected: z.number().int().describe('Rows refused at submission'),
  counters: countersSchema,
  settlement: settlementCountersSchema,
  createdAt: z.iso.datetime(),
  sentAt: z.iso.datetime().optional().describe('When the last open message left, failed or was cancelled'),
  settledAt: z.iso.datetime().optional().describe('When every message had its final word (status SETTLED)'),
};

export const batchDetailSchema = z.object({
  ...batchCore,
  rejectedMessages: z.array(rejectedMessageSchema),
  warnings: z.array(warningSchema),
  sendingStartedAt: z.iso.datetime().optional(),
  cancelRequestedAt: z.iso.datetime().optional(),
  cancelledAt: z.iso.datetime().optional().describe('Set when the cancel left nothing that had been sent'),
});

export const batchListSchema = z.object({
  items: z.array(z.object(batchCore)),
  nextCursor: z.string().optional().describe('Present when there are more items: pass it back as ?cursor='),
});

export const batchSummarySchema = z.object({
  batchId: z.string(),
  groupBy: z.literal('subTenant'),
  groups: z.array(
    z.object({
      subTenant: z.string().nullable().describe('null = messages without a subTenant'),
      counters: countersSchema,
    }),
  ),
});

export const cancelResultSchema = z.object({
  batchId: z.string(),
  status: batchStatusSchema,
  cancelled: z.number().int().describe('Messages cancelled by this call (0 when repeated)'),
  counters: countersSchema,
});

export const batchListQuerySchema = z.strictObject({
  status: commaList(batchStatusSchema)
    .optional()
    .describe(`One or more of ${batchStatusSchema.options.join(', ')}; comma separated`),
  reference: repeatedList(z.string().min(1).max(200))
    .optional()
    .describe('Exact reference; repeat the parameter for several'),
  subTenant: commaList(z.string().min(1).max(64))
    .optional()
    .describe('Exact subTenant values, comma separated'),
  mailbox: z.string().min(1).max(64).optional(),
  createdFrom: dateParam.optional().describe('ISO 8601, inclusive'),
  createdBefore: dateParam.optional().describe('ISO 8601, exclusive'),
  limit: limitParam,
  cursor: cursorParam,
});

export const batchSummaryQuerySchema = z.strictObject({
  groupBy: z.literal('subTenant').describe('The only grouping offered today'),
});

export class BatchDetailDto extends createZodDto(batchDetailSchema) {}
export class BatchListDto extends createZodDto(batchListSchema) {}
export class BatchSummaryDto extends createZodDto(batchSummarySchema) {}
export class CancelResultDto extends createZodDto(cancelResultSchema) {}
export class BatchListQueryDto extends createZodDto(batchListQuerySchema) {}
export class BatchSummaryQueryDto extends createZodDto(batchSummaryQuerySchema) {}

export type BatchListQuery = z.output<typeof batchListQuerySchema>;
