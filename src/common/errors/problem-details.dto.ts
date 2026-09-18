import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** OpenAPI description of the RFC 9457 error body every endpoint may return. */
export const fieldErrorSchema = z.object({
  path: z.string().describe('JSON path into the request, e.g. "messages[37].to"'),
  code: z.string().describe('Stable machine-readable code for this field problem'),
  detail: z.string(),
});

export const problemDetailsSchema = z.object({
  type: z.string().describe('URI identifying the error class: urn:pecmailer:error:<code>'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  code: z.string().describe('Stable machine-readable code, the value integrations branch on'),
  errors: z.array(fieldErrorSchema).optional(),
  requestId: z.string().describe('Quote it when reporting a problem: it is in our logs'),
});

export class ProblemDetailsDto extends createZodDto(problemDetailsSchema) {}
