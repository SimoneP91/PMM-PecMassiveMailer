import { z } from 'zod';

/**
 * Building blocks of the query strings of the list endpoints. Every value
 * arrives as a string (or as an array of strings when the parameter is
 * repeated), so the schemas describe strings and convert them.
 */

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 500;
const MAX_VALUES = 50;

function asList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** `?status=SENT,FAILED` or `?status=SENT&status=FAILED` */
export function commaList<S extends string>(item: z.ZodType<S, string>): z.ZodType<S[], string | string[]> {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((value) =>
      asList(value)
        .flatMap((entry) => entry.split(','))
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    )
    .pipe(z.array(item).min(1).max(MAX_VALUES));
}

/** `?ref=a&ref=b`: values may contain commas, so they are never split. */
export function repeatedList<S extends string>(
  item: z.ZodType<S, string>,
): z.ZodType<S[], string | string[]> {
  return z
    .union([z.string(), z.array(z.string())])
    .transform(asList)
    .pipe(z.array(item).min(1).max(MAX_VALUES));
}

export const limitParam = z
  .string()
  .regex(/^\d{1,4}$/, 'a positive integer')
  .default(String(DEFAULT_PAGE_SIZE))
  .transform(Number)
  .pipe(z.number().int().min(1).max(MAX_PAGE_SIZE))
  .describe(`Page size, 1-${String(MAX_PAGE_SIZE)} (default ${String(DEFAULT_PAGE_SIZE)})`);

export const cursorParam = z
  .string()
  .min(1)
  .max(512)
  .optional()
  .describe('nextCursor of the previous page; omit for the first page');

export const dateParam = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `createdAt` range: from inclusive, before exclusive. */
export function createdRange(from: Date | undefined, before: Date | undefined): Record<string, unknown> {
  if (from === undefined && before === undefined) {
    return {};
  }

  return {
    createdAt: {
      ...(from === undefined ? {} : { $gte: from }),
      ...(before === undefined ? {} : { $lt: before }),
    },
  };
}
