import { randomUUID } from 'node:crypto';

/**
 * A client may propagate its own correlation id in X-Request-Id; it is
 * honoured only when it looks like an id. Anything else is replaced, so a
 * header cannot inject arbitrary text into the logs or into the error body.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

interface WithHeaders {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export function requestIdFrom(req: WithHeaders): string {
  const header = req.headers['x-request-id'];
  const candidate = typeof header === 'string' ? header : header?.[0];
  if (candidate !== undefined && SAFE_REQUEST_ID.test(candidate)) {
    return candidate;
  }

  return randomUUID();
}
