/**
 * Placeholder syntax of subject and body templates.
 *
 *   {{name}}    the value is inserted as TEXT: HTML-escaped in the body
 *   {{{name}}}  the value is inserted as HTML, and must pass the same policy
 *               as the template itself (checked per message at render time)
 *
 * Rendering is one pass over the template: a value is never re-scanned for
 * placeholders, so a recipient whose name contains "{{x}}" gets exactly that
 * text. This is the strtr() semantics of the legacy implementation.
 */

export const PLACEHOLDER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const TOKEN = /\{\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}\}|\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface Placeholder {
  readonly name: string;
  readonly raw: boolean;
}

export interface PlaceholderParse {
  readonly placeholders: readonly Placeholder[];
  /** Positions of "{{" or "}}" left over after every valid token was removed. */
  readonly malformedAt: readonly number[];
}

export function parsePlaceholders(template: string): PlaceholderParse {
  const seen = new Map<string, Placeholder>();
  const stripped = template.replace(TOKEN, (_match, raw: string | undefined, text: string | undefined) => {
    const name = raw ?? text ?? '';
    const isRaw = raw !== undefined;
    const existing = seen.get(name);
    // The same name used both as {{x}} and {{{x}}} is treated as raw: the
    // stricter validation applies wherever the value lands.
    if (existing === undefined || (isRaw && !existing.raw)) {
      seen.set(name, { name, raw: isRaw });
    }

    return ' ';
  });

  const malformedAt: number[] = [];
  const leftover = /\{\{|\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = leftover.exec(stripped)) !== null) {
    malformedAt.push(match.index);
  }

  return { placeholders: [...seen.values()], malformedAt };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type PlaceholderValues = ReadonlyMap<string, string>;

/**
 * @param escapeText applied to {{name}} values; the body escapes HTML, the
 *   subject only removes line breaks (a header cannot span lines)
 */
export function renderPlaceholders(
  template: string,
  values: PlaceholderValues,
  escapeText: (value: string) => string,
): string {
  return template.replace(TOKEN, (match, raw: string | undefined, text: string | undefined) => {
    const name = raw ?? text ?? '';
    const value = values.get(name);
    if (value === undefined) {
      return match;
    }

    return raw === undefined ? escapeText(value) : value;
  });
}

export function toHeaderText(value: string): string {
  return value
    .replace(/\s*[\r\n\t]+\s*/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}
