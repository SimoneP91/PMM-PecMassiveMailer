/**
 * How a PEC address is told from an ordinary one.
 *
 * Every PEC mailbox is served by a provider accredited by AgID, whatever the
 * domain in the address. A domain is therefore PEC when it belongs to a
 * provider (fast path, no DNS) or when its mail exchangers (MX records) are
 * a provider's servers. Conversely a domain whose MX are Google's or
 * Microsoft's cannot receive PEC.
 *
 * These lists are a starting point compiled from the providers the legacy
 * project and its delivery history dealt with. They are NOT authoritative:
 * the reference is the AgID registry of accredited providers, and both lists
 * can be extended in the configuration file (recipients.pecDomains,
 * recipients.pecMxSuffixes). A domain that matches nothing is UNDETERMINED,
 * never silently PEC.
 */

/** Domains under which providers hand out mailboxes directly. Exact or subdomain match. */
export const DEFAULT_PEC_DOMAINS: readonly string[] = [
  // Aruba
  'pec.it',
  'arubapec.it',
  'mypec.eu',
  'pec.cloud',
  'casellapec.com',
  'gigapec.it',
  // InfoCert (Legalmail)
  'legalmail.it',
  'cert.legalmail.it',
  'legalmailpa.it',
  // Namirial
  'sicurezzapostale.it',
  'pec.namirial.com',
  // Poste Italiane
  'postecert.it',
  'pec.poste.it',
  // TIM
  'telecompost.it',
  'pec.telecompost.it',
  // Register.it
  'pec.register.it',
  'legalmail.registerpec.it',
  // Actalis
  'actaliscertymail.it',
  'pec.actalis.it',
  // Notariato
  'postacertificata.notariato.it',
  // Cedacri
  'cedacricert.it',
  // Intesa (IBM)
  'pec.intesa.it',
  // Sogei / PA
  'pec.gov.it',
];

/** Suffixes of the mail exchangers accredited providers announce for custom domains. */
export const DEFAULT_PEC_MX_SUFFIXES: readonly string[] = [
  'pec.aruba.it',
  'arubapec.it',
  'legalmail.it',
  'sicurezzapostale.it',
  'postecert.it',
  'pec.poste.it',
  'telecompost.it',
  'pec.register.it',
  'actalis.it',
  'notariato.it',
  'cedacricert.it',
  'pec.intesa.it',
  'namirial.com',
  'pec.cloud',
];

/** Consumer and business mail that is certainly not PEC: rejected without a DNS lookup. */
export const DEFAULT_NON_PEC_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.it',
  'outlook.com',
  'outlook.it',
  'live.com',
  'live.it',
  'msn.com',
  'yahoo.com',
  'yahoo.it',
  'icloud.com',
  'me.com',
  'libero.it',
  'virgilio.it',
  'alice.it',
  'tin.it',
  'tiscali.it',
  'fastwebnet.it',
  'email.it',
  'inwind.it',
  'iol.it',
  'aol.com',
  'protonmail.com',
  'proton.me',
];

/** Mail exchangers of ordinary mail services: a domain served by them is not PEC. */
export const DEFAULT_NON_PEC_MX_SUFFIXES: readonly string[] = [
  'google.com',
  'googlemail.com',
  'outlook.com',
  'protection.outlook.com',
  'hotmail.com',
  'yahoodns.net',
  'icloud.com',
  'zoho.com',
  'zoho.eu',
  'mail.ru',
  'gmx.net',
  'protonmail.ch',
  'libero.it',
  'tiscali.it',
  'fastwebnet.it',
  'aruba.it',
  'arubabusiness.it',
  'register.it',
  'ovh.net',
  'mailgun.org',
  'sendgrid.net',
  'pphosted.com',
  'mimecast.com',
];

export function domainMatches(domain: string, list: readonly string[]): boolean {
  return list.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}
