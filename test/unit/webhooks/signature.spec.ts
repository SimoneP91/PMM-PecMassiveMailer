import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signPayload, verifySignature } from '../../../src/modules/webhooks/signature';

describe('webhook signature', () => {
  const body = '{"eventId":"ev_x","type":"batch.sent"}';

  it('is the documented HMAC over "<timestamp>.<body>"', () => {
    const expected = createHmac('sha256', 'secret').update(`1789800000.${body}`).digest('hex');

    expect(signPayload('secret', 1789800000, body)).toBe(`sha256=${expected}`);
  });

  it('verifies, and refuses a tampered body, another secret or an old timestamp', () => {
    const signature = signPayload('secret', 1789800000, body);

    expect(verifySignature('secret', 1789800000, body, signature, 1789800100)).toBe(true);
    expect(verifySignature('secret', 1789800000, `${body} `, signature, 1789800100)).toBe(false);
    expect(verifySignature('other', 1789800000, body, signature, 1789800100)).toBe(false);
    expect(verifySignature('secret', 1789800000, body, signature, 1789800000 + 301)).toBe(false);
    expect(verifySignature('secret', 1789800000, body, 'sha256=00', 1789800000)).toBe(false);
  });
});
