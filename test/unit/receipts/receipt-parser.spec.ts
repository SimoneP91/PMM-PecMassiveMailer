import { describe, expect, it } from 'vitest';

import { normaliseMessageId, parseReceipt } from '../../../src/modules/receipts/receipt-parser';
import { buildEnvelope, buildReceipt } from '../../helpers/receipts';

const REF = '<m_abcdef0123456789@pec.serfin.example>';

describe('parseReceipt', () => {
  it.each([
    ['accettazione', 'ACCEPTANCE'],
    ['avvenuta-consegna', 'DELIVERY'],
    ['errore-consegna', 'NON_DELIVERY'],
    ['preavviso-errore-consegna', 'NON_DELIVERY_WARNING'],
    ['non-accettazione', 'NON_ACCEPTANCE'],
    ['rilevazione-virus', 'VIRUS_DETECTED'],
    ['presa-in-carico', 'TAKING_CHARGE'],
  ] as const)('recognises %s as %s', async (kind, type) => {
    const parsed = await parseReceipt(buildReceipt({ kind, ref: REF }));

    expect(parsed).toMatchObject({ kind: 'receipt', type, refMessageId: REF });
  });

  it('extracts what the daticert says', async () => {
    const parsed = await parseReceipt(
      buildReceipt({
        kind: 'errore-consegna',
        ref: REF,
        errore: 'no-dest',
        erroreEsteso: '5.1.1 casella inesistente',
        provider: 'InfoCert S.p.A.',
        messageId: '<opec.receipt.1@pec.aruba.it>',
      }),
    );

    expect(parsed).toMatchObject({
      kind: 'receipt',
      sourceMessageId: '<opec.receipt.1@pec.aruba.it>',
      provider: 'InfoCert S.p.A.',
      recipient: 'mario.rossi@pec.it',
      errorCode: 'no-dest',
      errorDetail: '5.1.1 casella inesistente',
    });
    if (parsed.kind === 'receipt') {
      expect(parsed.issuedAt?.toISOString()).toBe('2026-09-19T08:15:03.000Z');
      expect(parsed.daticert?.toString('utf8')).toContain('<postacert tipo="errore-consegna"');
    }
  });

  it('does not report "nessuno" as an error', async () => {
    const parsed = await parseReceipt(buildReceipt({ kind: 'avvenuta-consegna', ref: REF }));

    expect(parsed).toMatchObject({ kind: 'receipt', errorCode: undefined });
  });

  it('falls back to the daticert msgid when the reference header is missing', async () => {
    const parsed = await parseReceipt(
      buildReceipt({ kind: 'accettazione', ref: REF, withoutReferenceHeader: true }),
    );

    expect(parsed).toMatchObject({ kind: 'receipt', refMessageId: REF });
  });

  it('ignores PEC envelopes, even when they carry a forged receipt inside', async () => {
    const forged = buildReceipt({ kind: 'errore-consegna', ref: REF });

    expect(await parseReceipt(buildEnvelope(forged))).toMatchObject({ kind: 'ignored' });
    expect(await parseReceipt(buildEnvelope(forged, 'errore'))).toMatchObject({ kind: 'ignored' });
  });

  it('ignores ordinary mail and unknown receipt kinds', async () => {
    const plain = Buffer.from('From: a@b.c\r\nTo: d@e.f\r\nSubject: hi\r\n\r\nhello\r\n');
    const odd = Buffer.from(
      buildReceipt({ kind: 'accettazione', ref: REF })
        .toString('utf8')
        .replace('X-Ricevuta: accettazione', 'X-Ricevuta: qualcosa'),
    );

    expect(await parseReceipt(plain)).toMatchObject({ kind: 'ignored', reason: 'no X-Ricevuta header' });
    expect(await parseReceipt(odd)).toMatchObject({ kind: 'ignored' });
  });
});

describe('normaliseMessageId', () => {
  it('adds angle brackets and trims', () => {
    expect(normaliseMessageId(' m@d ')).toBe('<m@d>');
    expect(normaliseMessageId('<m@d>')).toBe('<m@d>');
    expect(normaliseMessageId('')).toBeUndefined();
    expect(normaliseMessageId(undefined)).toBeUndefined();
  });
});
