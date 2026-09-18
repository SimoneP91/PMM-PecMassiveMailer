import type { z } from 'zod';

import type { FieldError } from './app-error';

/** ["messages", 3, "to"] -> "messages[3].to" */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      out += `[${String(segment)}]`;
    } else {
      out += out === '' ? String(segment) : `.${String(segment)}`;
    }
  }

  return out;
}

export function zodIssuesToFieldErrors(issues: readonly z.core.$ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    path: formatPath(issue.path),
    code: issue.code.toUpperCase(),
    detail: issue.message,
  }));
}
