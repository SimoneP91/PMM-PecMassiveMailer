import type { ProviderName, TransportSecurity } from './config';

export interface TransportPreset {
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
}

export interface ProviderPreset {
  readonly displayName: string;
  readonly smtp: TransportPreset;
  /** No sentFolder: not known for this provider, PECMAILER_IMAP_SENT_FOLDER must say it. */
  readonly imap: TransportPreset & { readonly sentFolder?: string };
  /** What the provider expects as SMTP/IMAP login: the address, or an account code. */
  readonly usernameHint: string;
}

/**
 * Conventions of the accredited providers. They differ in ways no
 * documentation lists - the Sent folder name, the separator, whether the
 * login is the address or a code - which is why they are data, and every
 * value can be overridden per mailbox.
 *
 * - Aruba: proven by real sends from this service (19 September 2026).
 * - Legalmail: servers and port as InfoCert publishes them for mail clients
 *   (SMTP 465 with TLS: port 25 is often blocked on the way out of cloud
 *   networks); login and Sent folder from the legacy project. Not yet proven
 *   by a send from this service.
 * - Namirial (sicurezzapostale.it): servers as Namirial publishes them; the
 *   Sent folder is not known, so PECMAILER_IMAP_SENT_FOLDER is required.
 *
 * `npm run cli -- probe` checks a mailbox's settings without sending.
 */
export const PROVIDER_PRESETS: Readonly<Record<Exclude<ProviderName, 'custom'>, ProviderPreset>> = {
  aruba: {
    displayName: 'Aruba PEC',
    smtp: { host: 'smtps.pec.aruba.it', port: 465, security: 'tls' },
    imap: { host: 'imaps.pec.aruba.it', port: 993, security: 'tls', sentFolder: 'INBOX.Inviata' },
    usernameHint: 'the PEC address',
  },
  legalmail: {
    displayName: 'Legalmail (InfoCert)',
    smtp: { host: 'sendm.cert.legalmail.it', port: 465, security: 'tls' },
    imap: { host: 'mbox.cert.legalmail.it', port: 993, security: 'tls', sentFolder: 'INBOX/Spedite' },
    usernameHint: 'the M... account code, not the address',
  },
  namirial: {
    displayName: 'Namirial PEC',
    smtp: { host: 'smtps.sicurezzapostale.it', port: 465, security: 'tls' },
    imap: { host: 'imaps.sicurezzapostale.it', port: 993, security: 'tls' },
    usernameHint: 'the PEC address',
  },
};

export function presetFor(provider: ProviderName): ProviderPreset | undefined {
  return provider === 'custom' ? undefined : PROVIDER_PRESETS[provider];
}
