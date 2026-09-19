import { describe, expect, it } from 'vitest';

import type { Clock } from '../../../src/common/time/clock';
import type { ResolvedConfig } from '../../../src/config/config.loader';
import { RecipientVerifier } from '../../../src/modules/recipients/recipient-verifier';
import { containing } from '../../helpers/matchers';
import { FakeMxResolver } from '../../helpers/fake-mx';
import { defaultSections } from '../../helpers/config-sections';

class FakeClock implements Clock {
  public constructor(public current = new Date('2026-09-19T10:00:00Z')) {}

  public now(): Date {
    return this.current;
  }

  public advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const config: ResolvedConfig = {
  tenants: [],
  mailboxes: [],
  ...defaultSections(),
  recipients: {
    pecDomains: ['pec.custom.example'],
    pecMxSuffixes: ['mx.provider.example'],
    nonPecDomains: [],
    nonPecMxSuffixes: [],
  },
};

function setup(): { verifier: RecipientVerifier; mx: FakeMxResolver; clock: FakeClock } {
  const mx = new FakeMxResolver();
  const clock = new FakeClock();

  return { verifier: new RecipientVerifier(config, clock, mx), mx, clock };
}

describe('RecipientVerifier', () => {
  it('recognises provider domains and their subdomains without DNS', async () => {
    const { verifier, mx } = setup();

    expect((await verifier.verify('a@pec.it')).verdict).toBe('PEC');
    expect((await verifier.verify('a@LEGALMAIL.IT')).verdict).toBe('PEC');
    expect((await verifier.verify('a@sub.pec.custom.example')).verdict).toBe('PEC');
    expect(mx.lookups).toEqual([]);
  });

  it('rejects consumer mail domains without DNS', async () => {
    const { verifier, mx } = setup();

    expect((await verifier.verify('a@gmail.com')).verdict).toBe('NOT_PEC');
    expect((await verifier.verify('a@libero.it')).verdict).toBe('NOT_PEC');
    expect(mx.lookups).toEqual([]);
  });

  it('classifies a custom domain by its mail exchangers', async () => {
    const { verifier, mx } = setup();
    mx.mx('azienda.example', 'mx1.pec.aruba.it.', 'mx2.pec.aruba.it')
      .mx('google.example', 'aspmx.l.google.com', 'alt1.aspmx.l.google.com')
      .mx('mixed.example', 'aspmx.l.google.com', 'mail.mixed.example')
      .mx('custom.example', 'in.mx.provider.example')
      .mx('nomx.example');

    expect(await verifier.verify('a@azienda.example')).toMatchObject({ verdict: 'PEC' });
    expect(await verifier.verify('a@google.example')).toMatchObject({ verdict: 'NOT_PEC' });
    expect(await verifier.verify('a@mixed.example')).toMatchObject({ verdict: 'UNDETERMINED' });
    expect(await verifier.verify('a@custom.example')).toMatchObject({ verdict: 'PEC' });
    expect(await verifier.verify('a@nomx.example')).toMatchObject({ verdict: 'NOT_PEC' });
  });

  it('treats a missing domain as NOT_PEC and a DNS failure as UNDETERMINED', async () => {
    const { verifier, mx } = setup();
    mx.fail('down.example', 'ETIMEOUT');

    expect(await verifier.verify('a@nowhere.example')).toMatchObject({ verdict: 'NOT_PEC' });
    expect(await verifier.verify('a@down.example')).toMatchObject({
      verdict: 'UNDETERMINED',
      detail: containing('ETIMEOUT'),
    });
  });

  it('caches per domain and shares in-flight lookups', async () => {
    const { verifier, mx, clock } = setup();
    mx.mx('azienda.example', 'mx.pec.aruba.it');

    await Promise.all([verifier.verify('a@azienda.example'), verifier.verify('b@azienda.example')]);
    await verifier.verify('c@azienda.example');
    expect(mx.lookups).toEqual(['azienda.example']);

    clock.advance(25 * 60 * 60 * 1000);
    await verifier.verify('d@azienda.example');
    expect(mx.lookups).toEqual(['azienda.example', 'azienda.example']);
  });

  it('keeps an UNDETERMINED answer only briefly', async () => {
    const { verifier, mx, clock } = setup();
    mx.fail('flaky.example', 'ETIMEOUT');

    await verifier.verify('a@flaky.example');
    clock.advance(6 * 60 * 1000);
    mx.mx('flaky.example', 'mx.pec.aruba.it');
    expect((await verifier.verify('a@flaky.example')).verdict).toBe('PEC');
  });
});
