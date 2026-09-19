import { Secret } from '../../src/common/security/secret';
import type { ResolvedMailbox } from '../../src/config/config';

/** A mailbox as the configuration resolves it, pointing nowhere unless told. */
export function testMailbox(overrides: Partial<ResolvedMailbox> = {}): ResolvedMailbox {
  return {
    code: 'serfin-aruba',
    tenant: 'serfin',
    provider: 'aruba',
    from: { address: 'solleciti@pec.serfin.example', name: 'Serfin – Recupero Crediti' },
    smtp: {
      host: '127.0.0.1',
      port: 2525,
      security: 'none',
      username: 'solleciti@pec.serfin.example',
      password: new Secret('test'),
      timeoutSeconds: 5,
    },
    imap: null,
    limits: { perMinute: 0, maxMessageBytes: 30 * 1024 * 1024 },
    ...overrides,
  };
}
