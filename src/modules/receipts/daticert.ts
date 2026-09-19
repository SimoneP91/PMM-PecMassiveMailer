import { DomUtils, parseDocument } from 'htmlparser2';

/**
 * daticert.xml, the machine-readable part every PEC receipt carries (DPR
 * 68/2005 technical rules). Parsed with htmlparser2 in XML mode: the five
 * predefined entities and numeric references are decoded, anything declared
 * in a DOCTYPE is left as literal text - no entity expansion, no external
 * fetch, whatever a hostile document says.
 */
export interface Daticert {
  /** accettazione, avvenuta-consegna, errore-consegna, ... */
  readonly tipo: string | undefined;
  /** nessuno, no-dest, no-dominio, virus, altro */
  readonly errore: string | undefined;
  readonly mittente: string | undefined;
  readonly destinatari: string | undefined;
  readonly oggetto: string | undefined;
  readonly gestoreEmittente: string | undefined;
  readonly identificativo: string | undefined;
  readonly msgid: string | undefined;
  readonly consegna: string | undefined;
  readonly erroreEsteso: string | undefined;
  readonly data: Date | undefined;
}

const MAX_XML_BYTES = 256 * 1024;

export function parseDaticert(xml: Buffer | string): Daticert | undefined {
  const text = typeof xml === 'string' ? xml : xml.subarray(0, MAX_XML_BYTES).toString('utf8');
  const document = parseDocument(text, { xmlMode: true });
  const root = DomUtils.findOne((element) => element.name === 'postacert', document.children, true);
  if (root === null) {
    return undefined;
  }

  const text$ = (name: string): string | undefined => {
    const element = DomUtils.findOne((candidate) => candidate.name === name, root.children, true);
    const value = element === null ? undefined : DomUtils.textContent(element).trim();

    return value === undefined || value === '' ? undefined : value;
  };
  const dataElement = DomUtils.findOne((candidate) => candidate.name === 'data', root.children, true);

  return {
    tipo: root.attribs['tipo'],
    errore: root.attribs['errore'],
    mittente: text$('mittente'),
    destinatari: text$('destinatari'),
    oggetto: text$('oggetto'),
    gestoreEmittente: text$('gestore-emittente'),
    identificativo: text$('identificativo'),
    msgid: text$('msgid'),
    consegna: text$('consegna'),
    erroreEsteso: text$('errore-esteso'),
    data: dateFrom(text$('giorno'), text$('ora'), dataElement?.attribs['zona']),
  };
}

/** giorno "19/09/2026", ora "10:15:03", zona "+0200" -> a Date; undefined when anything is off. */
export function dateFrom(giorno?: string, ora?: string, zona?: string): Date | undefined {
  const day = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(giorno ?? '');
  const time = /^(\d{2}):(\d{2}):(\d{2})$/.exec(ora ?? '');
  if (day === null || time === null) {
    return undefined;
  }
  const zone = /^([+-])(\d{2}):?(\d{2})$/.exec(zona ?? '+0000');
  const offset = zone === null ? '+00:00' : `${zone[1] ?? '+'}${zone[2] ?? '00'}:${zone[3] ?? '00'}`;
  const date = new Date(
    `${day[3] ?? ''}-${day[2] ?? ''}-${day[1] ?? ''}T${time[1] ?? ''}:${time[2] ?? ''}:${time[3] ?? ''}${offset}`,
  );

  return Number.isNaN(date.getTime()) ? undefined : date;
}
