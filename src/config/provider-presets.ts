import type { ProviderName, TransportSecurity } from './config';

export interface TransportPreset {
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
}

export interface ProviderPreset {
  readonly displayName: string;
  readonly smtp: TransportPreset;
  readonly imap: TransportPreset & { readonly sentFolder: string };
  /** What the provider expects as SMTP/IMAP login: the address, or an account code. */
  readonly usernameHint: string;
}

/**
 * Conventions of the accredited providers, as verified with real sends by the
 * legacy project (18 September 2026). They differ in ways no documentation
 * lists - the Sent folder name, the separator, whether the login is the
 * address or a code - which is why they are data and overridable per mailbox.
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
    smtp: { host: 'sendm.cert.legalmail.it', port: 25, security: 'starttls' },
    imap: { host: 'mbox.cert.legalmail.it', port: 993, security: 'tls', sentFolder: 'INBOX/Spedite' },
    usernameHint: 'the M... account code, not the address',
  },
  infocert: {
    displayName: 'InfoCert PEC',
    smtp: { host: 'smtp.sicurezzapostale.it', port: 465, security: 'tls' },
    imap: { host: 'mbox.sicurezzapostale.it', port: 993, security: 'tls', sentFolder: 'INBOX.Sent' },
    usernameHint: 'the PEC address',
  },
};

export function presetFor(provider: ProviderName): ProviderPreset | undefined {
  return provider === 'custom' ? undefined : PROVIDER_PRESETS[provider];
}
