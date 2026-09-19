import { describe, expect, it } from 'vitest';

import { dateFrom, parseDaticert } from '../../../src/modules/receipts/daticert';
import { daticertXml } from '../../helpers/receipts';

describe('parseDaticert', () => {
  it('reads a delivery receipt', () => {
    const parsed = parseDaticert(
      daticertXml({ kind: 'avvenuta-consegna', ref: '<m_abc@pec.serfin.example>', subject: 'Pratica & co' }),
    );

    expect(parsed).toMatchObject({
      tipo: 'avvenuta-consegna',
      errore: 'nessuno',
      mittente: 'solleciti@pec.serfin.example',
      destinatari: 'mario.rossi@pec.it',
      consegna: 'mario.rossi@pec.it',
      oggetto: 'Pratica & co',
      gestoreEmittente: 'ARUBA PEC S.p.A.',
      msgid: '<m_abc@pec.serfin.example>',
    });
    expect(parsed?.identificativo).toMatch(/^opec21\./);
    expect(parsed?.data?.toISOString()).toBe('2026-09-19T08:15:03.000Z');
  });

  it('reads the error of a non-delivery', () => {
    const parsed = parseDaticert(
      daticertXml({
        kind: 'errore-consegna',
        ref: '<m_x@d>',
        errore: 'no-dest',
        erroreEsteso: '5.1.1 - InfoCert S.p.A. - indirizzo non valido',
      }),
    );

    expect(parsed).toMatchObject({
      tipo: 'errore-consegna',
      errore: 'no-dest',
      erroreEsteso: containingText('indirizzo'),
    });
  });

  it('never expands entities declared in a DOCTYPE', () => {
    const hostile =
      '<?xml version="1.0"?><!DOCTYPE postacert [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;">' +
      '<!ENTITY ext SYSTEM "file:///etc/passwd">]><postacert tipo="accettazione" errore="nessuno">' +
      '<intestazione><oggetto>&b;&ext;</oggetto></intestazione><dati><msgid>&lt;m@d&gt;</msgid></dati></postacert>';

    const parsed = parseDaticert(hostile);

    expect(parsed?.oggetto).toBe('&b;&ext;');
    expect(parsed?.msgid).toBe('<m@d>');
  });

  it('returns undefined when there is no postacert root', () => {
    expect(parseDaticert('<something/>')).toBeUndefined();
    expect(parseDaticert('not xml at all')).toBeUndefined();
  });
});

describe('dateFrom', () => {
  it('applies the zone, with or without a colon', () => {
    expect(dateFrom('01/02/2026', '23:30:00', '+0100')?.toISOString()).toBe('2026-02-01T22:30:00.000Z');
    expect(dateFrom('01/02/2026', '23:30:00', '+01:00')?.toISOString()).toBe('2026-02-01T22:30:00.000Z');
    expect(dateFrom('01/02/2026', '23:30:00', undefined)?.toISOString()).toBe('2026-02-01T23:30:00.000Z');
  });

  it('rejects malformed values', () => {
    expect(dateFrom('2026-02-01', '23:30:00', '+0100')).toBeUndefined();
    expect(dateFrom('01/02/2026', '23:30', '+0100')).toBeUndefined();
    expect(dateFrom('31/02/2026', '23:30:00', '+0100')?.getUTCMonth()).not.toBe(1);
  });
});

function containingText(text: string): string {
  return expect.stringContaining(text) as string;
}
