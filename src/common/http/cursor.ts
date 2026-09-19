import { z } from 'zod';

import { AppError } from '../errors/app-error';

/**
 * Keyset pagination. A cursor is the sort key of the last item returned,
 * base64url-encoded JSON, tagged with the list it belongs to. Opaque to the
 * client; not signed, because it cannot widen what a query sees - every
 * query is scoped to the tenant before the cursor is applied.
 */
export type CursorKey = string | number;

const cursorSchema = z.strictObject({
  v: z.literal(1),
  l: z.string().min(1).max(40),
  k: z
    .array(z.union([z.string().max(100), z.number()]))
    .min(1)
    .max(3),
});

export function encodeCursor(list: string, keys: readonly CursorKey[]): string {
  return Buffer.from(JSON.stringify({ v: 1, l: list, k: keys }), 'utf8').toString('base64url');
}

export function decodeCursor(list: string, raw: string): readonly CursorKey[] {
  const invalid = (): AppError =>
    AppError.badRequest('INVALID_CURSOR', 'Invalid cursor', {
      detail: 'Pass back the nextCursor of a previous page of the same list, unchanged',
    });
  if (raw.length > 512) {
    throw invalid();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = cursorSchema.safeParse(decoded);
  if (!parsed.success || parsed.data.l !== list) {
    throw invalid();
  }

  return parsed.data.k;
}

/** Keys of a newest-first list sorted by (createdAt desc, _id desc). */
export function createdAtKeys(keys: readonly CursorKey[]): { createdAt: Date; id: string } {
  const [at, id] = keys;
  const createdAt = typeof at === 'string' ? new Date(at) : undefined;
  if (createdAt === undefined || Number.isNaN(createdAt.getTime()) || typeof id !== 'string') {
    throw AppError.badRequest('INVALID_CURSOR', 'Invalid cursor');
  }

  return { createdAt, id };
}

/** The MongoDB condition "after this item" for a (createdAt desc, _id desc) sort. */
export function afterCreatedAt(createdAt: Date, id: string): Record<string, unknown> {
  return { $or: [{ createdAt: { $lt: createdAt } }, { createdAt, _id: { $lt: id } }] };
}
