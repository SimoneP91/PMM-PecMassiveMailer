import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { providerNameSchema } from '../../config/pecmailer-config.schema';

/**
 * What a tenant may know about its mailboxes: identity, provider, state and
 * limits. Never a host name, a username or anything about credentials.
 */
export const mailboxSummarySchema = z.object({
  mailbox: z.string().describe('Mailbox code, the value to put in a batch'),
  from: z.object({
    address: z.email(),
    name: z.string(),
  }),
  provider: providerNameSchema,
  status: z
    .enum(['ACTIVE', 'SUSPENDED'])
    .describe(
      'SUSPENDED = the provider refused the credentials; nothing is sent until an operator reactivates it',
    ),
  suspendedAt: z.iso.datetime().optional(),
  suspensionCause: z
    .enum(['SMTP_AUTH_REFUSED', 'IMAP_AUTH_REFUSED', 'OPERATOR'])
    .optional()
    .describe('Why it is suspended; an operator reactivates it once the password is fixed'),
  archivesSentCopy: z
    .boolean()
    .describe('Whether a copy of each sent message is filed in the Sent folder over IMAP'),
  limits: z.object({
    perMinute: z.number().int().describe('0 = no pacing'),
    perDay: z.number().int().describe('0 = no daily quota'),
    maxMessageBytes: z.number().int().describe('Size of the encoded message the provider accepts'),
  }),
});

export const mailboxListSchema = z.object({
  items: z.array(mailboxSummarySchema),
});

export class MailboxSummaryDto extends createZodDto(mailboxSummarySchema) {}
export class MailboxListDto extends createZodDto(mailboxListSchema) {}
