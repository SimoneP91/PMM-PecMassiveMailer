import { describe, expect, it } from 'vitest';

import { pecmailerConfigSchema } from '../../../src/config/pecmailer-config.schema';

const HASH = 'a'.repeat(64);

function validFile(): Record<string, unknown> {
  return {
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
      },
    ],
  };
}

function issuesOf(input: unknown): string[] {
  const result = pecmailerConfigSchema.safeParse(input);

  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

describe('pecmailerConfigSchema', () => {
  it('accepts the reference file and fills the defaults', () => {
    const result = pecmailerConfigSchema.parse(validFile());

    expect(result.tenants[0]?.limits).toEqual({
      maxMessagesPerBatch: 2500,
      maxRequestBytes: 50 * 1024 * 1024,
      requestsPerMinute: 120,
    });
    expect(result.mailboxes[0]?.limits).toEqual({
      perMinute: 60,
      perDay: 0,
      maxMessageBytes: 30 * 1024 * 1024,
    });
    expect(result.mailboxes[0]?.imap.enabled).toBe(true);
    expect(result.mailboxes[0]?.smtp.timeoutSeconds).toBe(30);
  });

  it('rejects a mailbox pointing at an unknown tenant', () => {
    const file = validFile();
    (file['mailboxes'] as Record<string, unknown>[])[0]!['tenant'] = 't_nobody';

    expect(issuesOf(file)).toEqual([expect.stringContaining('unknown tenant "t_nobody"')]);
  });

  it('rejects duplicate mailbox codes and tenant ids', () => {
    const file = validFile();
    const mailboxes = file['mailboxes'] as Record<string, unknown>[];
    mailboxes.push({ ...mailboxes[0] });
    const tenants = file['tenants'] as Record<string, unknown>[];
    tenants.push({ ...tenants[0], apiKeys: [{ id: 'key_2', sha256: 'b'.repeat(64) }] });

    const issues = issuesOf(file);
    expect(issues).toContainEqual(expect.stringContaining('duplicate mailbox code'));
    expect(issues).toContainEqual(expect.stringContaining('duplicate tenant id'));
  });

  it('rejects the same api key declared twice, even across tenants', () => {
    const file = validFile();
    const tenants = file['tenants'] as Record<string, unknown>[];
    tenants.push({ ...tenants[0], id: 't_other', apiKeys: [{ id: 'key_2', sha256: HASH }] });

    expect(issuesOf(file)).toContainEqual(expect.stringContaining('declared twice'));
  });

  it('rejects a webhook that is not https', () => {
    const file = validFile();
    (file['tenants'] as Record<string, unknown>[])[0]!['webhook'] = {
      url: 'http://crm.example/hook',
      secretEnv: 'WEBHOOK_SERFIN_SECRET',
    };

    expect(issuesOf(file)).toEqual([expect.stringMatching(/^tenants\.0\.webhook\.url/)]);
  });

  it('rejects an api key that is not a sha256 hex digest', () => {
    const file = validFile();
    (file['tenants'] as Record<string, unknown>[])[0]!['apiKeys'] = [{ id: 'key_1', sha256: 'pm_plain-key' }];

    expect(issuesOf(file)).toEqual([expect.stringMatching(/^tenants\.0\.apiKeys\.0\.sha256/)]);
  });

  it('requires every transport value when the provider is custom', () => {
    const file = validFile();
    (file['mailboxes'] as Record<string, unknown>[])[0]!['provider'] = 'custom';

    const issues = issuesOf(file);
    expect(issues).toContainEqual(expect.stringMatching(/^mailboxes\.0\.smtp\.host/));
    expect(issues).toContainEqual(expect.stringMatching(/^mailboxes\.0\.imap\.sentFolder/));
  });

  it('rejects unknown keys, which are almost always typos', () => {
    const file = validFile();
    (file['mailboxes'] as Record<string, unknown>[])[0]!['pasword'] = 'oops';

    expect(issuesOf(file)).toEqual([expect.stringMatching(/pasword/)]);
  });

  it('rejects identifiers with upper-case letters or spaces', () => {
    const file = validFile();
    (file['mailboxes'] as Record<string, unknown>[])[0]!['code'] = 'Serfin Aruba';

    expect(issuesOf(file)).toEqual([expect.stringMatching(/^mailboxes\.0\.code/)]);
  });
});
