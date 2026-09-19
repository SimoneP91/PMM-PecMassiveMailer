import { describe, expect, it } from 'vitest';

import { summarise } from '../../../src/cli/queue-tools';
import { Secret } from '../../../src/common/security/secret';
import { parseBody } from '../../../src/queue/queues';
import { declarations } from '../../../src/queue/rabbit-queues';

describe('parseBody', () => {
  it('reads JSON whatever content type the sender declared', () => {
    expect(parseBody({ id: 'a' })).toEqual({ id: 'a' });
    expect(parseBody(Buffer.from('{"id":"b"}'))).toEqual({ id: 'b' });
    expect(parseBody('{"id":"c"}')).toEqual({ id: 'c' });
  });

  it('gives undefined for a body that is not JSON', () => {
    expect(parseBody(Buffer.from('not json'))).toBeUndefined();
    expect(parseBody('<xml/>')).toBeUndefined();
  });
});

describe('declarations', () => {
  const settings = {
    url: new Secret('amqp://x'),
    tenant: 'serfin',
    mailbox: 'serfin-aruba',
    input: 'p.serfin.serfin-aruba.in',
    output: 'p.serfin.serfin-aruba.out',
    dead: 'p.serfin.serfin-aruba.dead',
    declare: true,
    deliveryLimit: 5,
  };

  it('makes every queue a durable quorum queue', () => {
    const queues = declarations(settings);

    for (const queue of [queues.input, queues.output, queues.dead]) {
      expect(queue).toMatchObject({ durable: true, arguments: { 'x-queue-type': 'quorum' } });
    }
  });

  it('gives the input queue one active consumer, a delivery limit and the dead-letter queue', () => {
    expect(declarations(settings).input.arguments).toEqual({
      'x-queue-type': 'quorum',
      'x-single-active-consumer': true,
      'x-delivery-limit': 5,
      'x-dead-letter-exchange': '',
      'x-dead-letter-routing-key': 'p.serfin.serfin-aruba.dead',
    });
  });
});

describe('summarise', () => {
  it('prints one readable line per event, without the base64 files', () => {
    const line = summarise({
      event: 'receipt',
      id: 'abc',
      receiptType: 'DELIVERY',
      final: true,
      provider: 'ARUBA PEC S.p.A.',
      eml: 'A'.repeat(4096),
    });

    expect(line).toBe('receipt    abc  DELIVERY (final) from ARUBA PEC S.p.A., eml 3 KB');
  });

  it('lists every reason of a rejection', () => {
    expect(
      summarise({
        event: 'rejected',
        id: 'abc',
        errors: [
          { code: 'RECIPIENT_NOT_PEC', field: 'to.address', detail: 'gmail.com is not PEC' },
          { code: 'FORBIDDEN_ELEMENT', field: 'html', detail: '<script> is not allowed' },
        ],
      }),
    ).toBe(
      'rejected   abc  RECIPIENT_NOT_PEC to.address: gmail.com is not PEC; FORBIDDEN_ELEMENT html: <script> is not allowed',
    );
  });
});
