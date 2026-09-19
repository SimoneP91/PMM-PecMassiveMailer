import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { mayBeReceipt, parseReceipt } from '../../../src/modules/receipts/receipt-parser';

/**
 * Real receipts from Aruba PEC (anonymised: see test/fixtures/receipts/aruba/README.md).
 * What the synthetic receipts of the other tests cannot prove: that the
 * parser reads what a provider actually sends.
 */
const FIXTURES = join(__dirname, '../../fixtures/receipts/aruba');
const read = (name: string): Buffer => readFileSync(join(FIXTURES, name));
const topHeaders = (raw: Buffer): string => raw.toString('latin1').split(/\r?\n\r?\n/)[0] ?? '';

const MESSAGE_1 = '<m_jQaMqbpy0CRWKphL@pec.it>';
const MESSAGE_2 = '<m_Xbftyw1I-LSDVCM3@pec.it>';

describe('real Aruba receipts', () => {
  it.each([
    ['accettazione.eml', 'ACCEPTANCE', MESSAGE_1, '2026-09-19T13:41:19.000Z'],
    ['avvenuta-consegna.eml', 'DELIVERY', MESSAGE_1, '2026-09-19T13:41:20.000Z'],
    ['accettazione-inesistente.eml', 'ACCEPTANCE', MESSAGE_2, '2026-09-19T13:41:20.000Z'],
    ['errore-consegna.eml', 'NON_DELIVERY', MESSAGE_2, '2026-09-19T13:41:20.000Z'],
  ] as const)('%s is a %s receipt about the right message', async (file, type, ref, issuedAt) => {
    const raw = read(file);

    expect(mayBeReceipt(topHeaders(raw))).toBe(true);
    const parsed = await parseReceipt(raw);

    expect(parsed).toMatchObject({ kind: 'receipt', type, refMessageId: ref, provider: 'ARUBA PEC S.p.A.' });
    if (parsed.kind === 'receipt') {
      expect(parsed.issuedAt?.toISOString()).toBe(issuedAt);
      expect(parsed.sourceMessageId).toMatch(/@pec\.aruba\.it>$/);
      expect(parsed.providerId).toBeDefined();
      expect(parsed.daticert?.toString('utf8')).toContain('<postacert');
    }
  });

  it('reads the delivery address and, for a non-delivery, the reason', async () => {
    const delivery = await parseReceipt(read('avvenuta-consegna.eml'));
    const failure = await parseReceipt(read('errore-consegna.eml'));

    expect(delivery).toMatchObject({ recipient: 'mittente@pec.example', errorCode: undefined });
    // Aruba says "altro" for a mailbox that does not exist: the detail carries the reason.
    expect(failure).toMatchObject({
      recipient: 'collaudo-inesistente-7k2q9@pec.it',
      errorCode: 'altro',
      errorDetail: '5.1.1 - ARUBA PEC S.p.A. - indirizzo non valido',
    });
  });

  it('never takes the transport envelope for a receipt, although it names our message', async () => {
    const raw = read('busta-trasporto.eml');

    expect(topHeaders(raw)).toMatch(/^X-Riferimento-Message-ID: <m_jQaMqbpy0CRWKphL@pec\.it>/m);
    expect(mayBeReceipt(topHeaders(raw))).toBe(false);
    expect(await parseReceipt(raw)).toMatchObject({ kind: 'ignored' });
  });
});
