import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { multipart, type FilePart } from './multipart';
import type { TestStack } from './test-stack';

export interface Submitted {
  readonly batchId: string;
  /** ref -> messageId */
  readonly ids: ReadonlyMap<string, string>;
}

/** Submits a batch through the real endpoint and expects it accepted. */
export async function submitBatch(
  stack: TestStack,
  apiKey: string,
  batch: Record<string, unknown>,
  files: readonly FilePart[] = [],
): Promise<Submitted> {
  const body = multipart(batch, files);
  const response = await stack.app.inject({
    method: 'POST',
    url: '/v1/batches',
    headers: { ...body.headers, authorization: `Bearer ${apiKey}`, 'idempotency-key': randomUUID() },
    payload: body.payload,
  });
  expect(response.statusCode, response.body).toBe(202);
  const json = response.json<{ batchId: string; messages: { ref: string; messageId: string }[] }>();

  return { batchId: json.batchId, ids: new Map(json.messages.map((m) => [m.ref, m.messageId])) };
}

export function row(ref: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ref, to: `${ref}@pec.it`, vars: { n: ref, name: 'Mario' }, ...overrides };
}

export const SIMPLE_TEMPLATE = { subject: 'Pratica {{n}}', html: '<p>Gentile {{name}}</p>' };
