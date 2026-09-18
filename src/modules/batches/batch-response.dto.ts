import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const batchStatusSchema = z.enum(['QUEUED', 'SENDING', 'SENT', 'SETTLED', 'CANCELLED']);
export const messageStatusSchema = z.enum([
  'PENDING',
  'SENDING',
  'RETRY_SCHEDULED',
  'SENT',
  'ACCEPTED',
  'DELIVERED',
  'NOT_DELIVERED',
  'FAILED',
  'STUCK',
  'CANCELLED',
]);

export const rejectedMessageSchema = z.object({
  ref: z.string(),
  code: z.string().describe('Stable code, e.g. RECIPIENT_NOT_PEC, MISSING_PLACEHOLDER, DUPLICATE_DEDUP_KEY'),
  detail: z.string(),
});

export const warningSchema = z.object({
  code: z.string(),
  detail: z.string().optional(),
});

export const acceptedMessageSchema = z.object({
  ref: z.string(),
  messageId: z.string(),
  status: messageStatusSchema,
});

export const batchAcceptedSchema = z.object({
  batchId: z.string(),
  status: batchStatusSchema,
  mailbox: z.string(),
  reference: z.string().optional(),
  subTenant: z.string().optional(),
  accepted: z.number().int(),
  rejected: z.number().int(),
  messages: z
    .array(acceptedMessageSchema)
    .describe('ref -> messageId, what to store on your side to follow each row'),
  rejectedMessages: z.array(rejectedMessageSchema),
  warnings: z.array(warningSchema),
  createdAt: z.iso.datetime(),
});

export const previewSchema = z.object({
  ref: z.string(),
  to: z.string(),
  subject: z.string(),
  html: z.string(),
  attachments: z.array(z.object({ filename: z.string(), contentType: z.string(), size: z.number().int() })),
  estimatedBytes: z.number().int().describe('Size of the encoded message, as the provider will count it'),
});

export const dryRunResultSchema = z.object({
  dryRun: z.literal(true),
  mailbox: z.string(),
  accepted: z.number().int().describe('Rows that would be queued'),
  rejected: z.number().int(),
  messages: z.array(z.object({ ref: z.string(), to: z.string(), estimatedBytes: z.number().int() })),
  rejectedMessages: z.array(rejectedMessageSchema),
  warnings: z.array(warningSchema),
  preview: z.array(previewSchema).describe('The first rows rendered exactly as they would be sent'),
});

export class BatchAcceptedDto extends createZodDto(batchAcceptedSchema) {}
export class DryRunResultDto extends createZodDto(dryRunResultSchema) {}

export type BatchStatus = z.output<typeof batchStatusSchema>;
export type MessageStatus = z.output<typeof messageStatusSchema>;
export type RejectedMessage = z.output<typeof rejectedMessageSchema>;
export type BatchWarning = z.output<typeof warningSchema>;
