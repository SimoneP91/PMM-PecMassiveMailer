import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PLACEHOLDER_NAME } from '../templates/placeholders';

/**
 * The "batch" JSON part of POST /v1/batches. Shape and syntax only: what
 * depends on the tenant, the mailbox, the files or the template (limits,
 * ownership, placeholders, recipients) is checked by the intake service,
 * which reports those problems row by row.
 */

/** Absolute ceiling; the tenant's own limit (default 2500) applies on top. */
export const MAX_MESSAGES_HARD_LIMIT = 5000;
export const MAX_TEMPLATE_HTML_BYTES = 512 * 1024;
export const MAX_VAR_VALUE_LENGTH = 200_000;
export const MAX_VARS = 100;
export const MAX_ATTACHMENTS_PER_MESSAGE = 50;
export const MAX_INLINE_IMAGES = 20;
export const DRY_RUN_PREVIEW_COUNT = 5;

const partName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'letters, digits, ".", "_" and "-" only, up to 64 characters')
  .describe('Name of a file part of the same multipart request');

const cid = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, 'letters, digits, ".", "_" and "-" only')
  .describe('Content id, referenced by the template as <img src="cid:...">');

function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) {
      return true;
    }
  }

  return false;
}

const filename = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (value) => !value.includes('/') && !value.includes('\\') && !hasControlCharacter(value),
    'no path separators or control characters',
  )
  .refine((value) => value !== '.' && value !== '..', 'not a valid file name')
  .describe('The name the recipient sees; defaults to the file name of the part');

const subTenant = z
  .string()
  .min(1)
  .max(64)
  .describe(
    'Free grouping label inside the tenant (a sub-company, a product line); exact-match filter later on',
  );

export const varsSchema = z
  .record(
    z
      .string()
      .regex(PLACEHOLDER_NAME, 'placeholder names: letters, digits and "_", not starting with a digit'),
    z.union([z.string().max(MAX_VAR_VALUE_LENGTH), z.number(), z.boolean()]),
  )
  .refine((vars) => Object.keys(vars).length <= MAX_VARS, `at most ${String(MAX_VARS)} variables`)
  .describe(
    'Placeholder values. {{name}} inserts text, {{{name}}} inserts HTML that must pass the same rules as the template',
  );

export const attachmentRefSchema = z.strictObject({
  part: partName,
  filename: filename.optional(),
});

export const inlineImageSchema = z.strictObject({
  cid,
  part: partName,
});

export const templateSchema = z.strictObject({
  subject: z.string().min(1).max(300).describe('Placeholders {{name}} allowed; text only'),
  html: z
    .string()
    .min(1)
    .max(MAX_TEMPLATE_HTML_BYTES)
    .describe(
      'HTML body. Closed list of elements and attributes; <img> only with cid:; no scripts, forms, frames or remote resources',
    ),
  inlineImages: z.array(inlineImageSchema).max(MAX_INLINE_IMAGES).default([]),
});

export const messageSchema = z.strictObject({
  ref: z
    .string()
    .min(1)
    .max(200)
    .describe('Your identifier for this row, unique in the batch; returned in every response'),
  to: z.email().max(254).describe('PEC address of the recipient'),
  toName: z.string().min(1).max(200).optional(),
  subTenant: subTenant.optional(),
  vars: varsSchema.optional(),
  attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
  dedupKey: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Unique per tenant across batches: a row with a key already used is rejected as a duplicate'),
});

export const batchOptionsSchema = z.strictObject({
  atomic: z
    .boolean()
    .default(false)
    .describe('true: one bad row rejects the whole batch; false: valid rows go, bad rows are listed'),
  dryRun: z.boolean().default(false).describe('Validate everything, render a preview, create nothing'),
  unverifiedRecipients: z
    .enum(['reject', 'send'])
    .default('reject')
    .describe('What to do with a recipient whose domain cannot be classified as PEC or not'),
});

export const batchRequestSchema = z.strictObject({
  mailbox: z.string().min(1).max(64).describe('Code of one of your mailboxes (GET /v1/mailboxes)'),
  reference: z.string().min(1).max(200).optional().describe('Your label for the batch'),
  subTenant: subTenant.optional(),
  template: templateSchema,
  defaults: z
    .strictObject({
      vars: varsSchema.optional(),
      attachments: z.array(attachmentRefSchema).max(MAX_ATTACHMENTS_PER_MESSAGE).optional(),
    })
    .optional()
    .describe('Values and attachments shared by every message; a message can override a value'),
  options: batchOptionsSchema.prefault({}),
  messages: z.array(messageSchema).max(MAX_MESSAGES_HARD_LIMIT),
});

export type BatchRequest = z.output<typeof batchRequestSchema>;
export type MessageRequest = z.output<typeof messageSchema>;
export type AttachmentRef = z.output<typeof attachmentRefSchema>;

export class BatchRequestDto extends createZodDto(batchRequestSchema) {}
