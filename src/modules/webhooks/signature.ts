import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * X-PecMailer-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
 *
 * The timestamp (X-PecMailer-Timestamp, Unix seconds) is part of what is
 * signed, so a captured notification cannot be replayed later: a receiver
 * checks the signature and refuses a timestamp more than a few minutes old.
 */
export function signPayload(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex')}`;
}

/** The receiver's side, as documented for clients; also what the tests use. */
export function verifySignature(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  nowSeconds: number,
  toleranceSeconds = 300,
): boolean {
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return false;
  }
  const expected = Buffer.from(signPayload(secret, timestamp, body));
  const presented = Buffer.from(signature);

  return expected.length === presented.length && timingSafeEqual(expected, presented);
}
