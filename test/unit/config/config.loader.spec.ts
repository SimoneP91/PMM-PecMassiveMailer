import { describe, expect, it } from 'vitest';

import { Secret } from '../../../src/common/security/secret';
import {
  ConfigLoadError,
  parseConfigFile,
  passwordEnvName,
  resolveConfig,
} from '../../../src/config/config.loader';
import { parseEnv } from '../../../src/config/env.schema';
import { pecmailerConfigSchema, type PecmailerConfigFile } from '../../../src/config/pecmailer-config.schema';

const HASH = 'a'.repeat(64);

function file(overrides: Partial<PecmailerConfigFile['mailboxes'][number]> = {}): PecmailerConfigFile {
  return pecmailerConfigSchema.parse({
    tenants: [
      {
        id: 't_serfin',
        externalId: '195',
        name: 'Serfin',
        apiKeys: [{ id: 'key_1', sha256: HASH }],
        webhook: { url: 'https://crm.example/hook', secretEnv: 'WEBHOOK_SERFIN_SECRET' },
      },
    ],
    mailboxes: [
      {
        code: 'serfin-aruba',
        tenant: 't_serfin',
        provider: 'aruba',
        from: { address: 'x@pec.example', name: 'Serfin' },
        smtp: { username: 'x@pec.example' },
        ...overrides,
      },
    ],
  });
}

const env = parseEnv({ MONGODB_URI: 'mongodb://localhost/pecmailer' });
const secrets = { MAILBOX_SERFIN_ARUBA_PASSWORD: 'pw', WEBHOOK_SERFIN_SECRET: 'hmac' };

describe('passwordEnvName', () => {
  it('upper-cases the code and normalises punctuation', () => {
    expect(passwordEnvName('serfin-aruba')).toBe('MAILBOX_SERFIN_ARUBA_PASSWORD');
    expect(passwordEnvName('a.b--c')).toBe('MAILBOX_A_B_C_PASSWORD');
  });
});

describe('resolveConfig', () => {
  it('applies the provider preset and wraps secrets', () => {
    const resolved = resolveConfig(file(), env, secrets);
    const mailbox = resolved.mailboxes[0]!;

    expect(mailbox.smtp).toMatchObject({ host: 'smtps.pec.aruba.it', port: 465, security: 'tls' });
    expect(mailbox.imap).toMatchObject({
      host: 'imaps.pec.aruba.it',
      port: 993,
      sentFolder: 'INBOX.Inviata',
    });
    expect(mailbox.smtp.password).toBeInstanceOf(Secret);
    expect(mailbox.smtp.password.reveal()).toBe('pw');
    expect(resolved.tenants[0]?.webhook?.secret.reveal()).toBe('hmac');
  });

  it('never exposes a secret through serialisation', () => {
    const resolved = resolveConfig(file(), env, secrets);

    expect(JSON.stringify(resolved)).not.toContain('pw');
    expect(JSON.stringify(resolved)).not.toContain('hmac');
    expect(JSON.stringify(resolved)).toContain('[redacted]');
  });

  it('lets an explicit value win over the preset', () => {
    const resolved = resolveConfig(file({ imap: { enabled: true, sentFolder: 'INBOX.Sent' } }), env, secrets);

    expect(resolved.mailboxes[0]?.imap?.sentFolder).toBe('INBOX.Sent');
    expect(resolved.mailboxes[0]?.imap?.host).toBe('imaps.pec.aruba.it');
  });

  it('lets a local override win over the preset but not over an explicit value', () => {
    const local = parseEnv({
      MONGODB_URI: 'mongodb://localhost/pecmailer',
      PECMAILER_SMTP_OVERRIDE_HOST: 'greenmail',
      PECMAILER_SMTP_OVERRIDE_PORT: '3025',
      PECMAILER_SMTP_OVERRIDE_SECURITY: 'none',
    });
    const resolved = resolveConfig(
      file({ smtp: { username: 'u', port: 2525, timeoutSeconds: 30 } }),
      local,
      secrets,
    );

    expect(resolved.mailboxes[0]?.smtp).toMatchObject({ host: 'greenmail', port: 2525, security: 'none' });
  });

  it('turns imap off when the mailbox says so', () => {
    const resolved = resolveConfig(file({ imap: { enabled: false } }), env, secrets);

    expect(resolved.mailboxes[0]?.imap).toBeNull();
  });

  it('stops when a mailbox password is missing from the environment', () => {
    expect(() => resolveConfig(file(), env, { WEBHOOK_SERFIN_SECRET: 'x' })).toThrow(ConfigLoadError);
    expect(() => resolveConfig(file(), env, { WEBHOOK_SERFIN_SECRET: 'x' })).toThrow(
      /MAILBOX_SERFIN_ARUBA_PASSWORD/,
    );
  });

  it('treats an empty password as missing', () => {
    expect(() => resolveConfig(file(), env, { ...secrets, MAILBOX_SERFIN_ARUBA_PASSWORD: '' })).toThrow(
      ConfigLoadError,
    );
  });

  it('honours passwordEnv when given', () => {
    const resolved = resolveConfig(file({ passwordEnv: 'MY_PW' }), env, { ...secrets, MY_PW: 'other' });

    expect(resolved.mailboxes[0]?.smtp.password.reveal()).toBe('other');
  });

  it('stops when the webhook secret is missing', () => {
    expect(() => resolveConfig(file(), env, { MAILBOX_SERFIN_ARUBA_PASSWORD: 'pw' })).toThrow(
      /WEBHOOK_SERFIN_SECRET/,
    );
  });
});

describe('parseConfigFile', () => {
  it('reports invalid yaml with the file name', () => {
    expect(() => parseConfigFile('tenants: [', 'x.yaml')).toThrow(/x\.yaml: not valid YAML/);
  });

  it('reports schema violations with their path', () => {
    expect(() => parseConfigFile('tenants: []\nmailboxes: []\n', 'x.yaml')).toThrow(/tenants/);
  });

  it('refuses an empty file', () => {
    expect(() => parseConfigFile('', 'x.yaml')).toThrow(ConfigLoadError);
  });
});
