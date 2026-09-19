import { describe, expect, it } from 'vitest';

import { ConfigError, describeConfig, loadConfig, loadQueueSettings } from '../../../src/config/config';

const SMTP_PASSWORD = 'smtp-secret-value';
const RABBIT_PASSWORD = 'rabbit-secret-value';

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    PECMAILER_TENANT: 'serfin',
    PECMAILER_MAILBOX: 'serfin-aruba',
    PECMAILER_PROVIDER: 'aruba',
    PECMAILER_FROM_ADDRESS: 'solleciti@pec.serfin.example',
    PECMAILER_FROM_NAME: 'Serfin - Recupero Crediti',
    PECMAILER_SMTP_PASSWORD: SMTP_PASSWORD,
    RABBITMQ_URL: `amqp://pecmailer:${RABBIT_PASSWORD}@rabbitmq:5672`,
    ...overrides,
  };
}

function problemsOf(source: Record<string, string | undefined>): readonly string[] {
  try {
    loadConfig(source);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      return error.problems;
    }
    throw error;
  }

  return [];
}

describe('loadConfig', () => {
  it('fills a mailbox from its provider preset and the defaults', () => {
    const config = loadConfig(env());

    expect(config.mailbox).toMatchObject({
      code: 'serfin-aruba',
      tenant: 'serfin',
      provider: 'aruba',
      smtp: {
        host: 'smtps.pec.aruba.it',
        port: 465,
        security: 'tls',
        username: 'solleciti@pec.serfin.example',
      },
      imap: {
        host: 'imaps.pec.aruba.it',
        port: 993,
        security: 'tls',
        username: 'solleciti@pec.serfin.example',
        sentFolder: 'INBOX.Inviata',
        receiptsFolder: 'INBOX',
      },
      limits: { perMinute: 60, maxMessageBytes: 30 * 1024 * 1024 },
    });
    // IMAP logs in with the SMTP credentials unless told otherwise.
    expect(config.mailbox.imap?.password.reveal()).toBe(SMTP_PASSWORD);
    expect(config.sending).toEqual({
      retryBackoffSeconds: [60, 300, 900],
      redeliveryWaitSeconds: 300,
      unverifiedRecipients: 'reject',
    });
    expect(config.receipts).toEqual({ pollIntervalSeconds: 60, lookbackHours: 72, maxPerPoll: 200 });
  });

  it('names the three queues after the tenant and the mailbox', () => {
    expect(loadConfig(env()).queues).toMatchObject({
      input: 'pecmailer.serfin.serfin-aruba.in',
      output: 'pecmailer.serfin.serfin-aruba.out',
      dead: 'pecmailer.serfin.serfin-aruba.dead',
      declare: true,
      deliveryLimit: 5,
    });
    expect(loadConfig(env({ PECMAILER_QUEUE_PREFIX: 'pec' })).queues.input).toBe(
      'pec.serfin.serfin-aruba.in',
    );
  });

  it('lets every setting of the preset be overridden, as the local stack does for Greenmail', () => {
    const config = loadConfig(
      env({
        PECMAILER_SMTP_HOST: 'greenmail',
        PECMAILER_SMTP_PORT: '3025',
        PECMAILER_SMTP_SECURITY: 'none',
        PECMAILER_IMAP_HOST: 'greenmail',
        PECMAILER_IMAP_PORT: '3143',
        PECMAILER_IMAP_SECURITY: 'none',
        PECMAILER_IMAP_PASSWORD: 'other',
      }),
    );

    expect(config.mailbox.smtp).toMatchObject({ host: 'greenmail', port: 3025, security: 'none' });
    expect(config.mailbox.imap).toMatchObject({ host: 'greenmail', port: 3143, security: 'none' });
    expect(config.mailbox.imap?.password.reveal()).toBe('other');
  });

  it('asks for every transport setting of a custom provider', () => {
    expect(problemsOf(env({ PECMAILER_PROVIDER: 'custom' }))).toEqual([
      'PECMAILER_SMTP_HOST: required when PECMAILER_PROVIDER is "custom"',
      'PECMAILER_SMTP_PORT: required when PECMAILER_PROVIDER is "custom"',
      'PECMAILER_SMTP_SECURITY: required when PECMAILER_PROVIDER is "custom"',
      'PECMAILER_IMAP_HOST: required when PECMAILER_PROVIDER is "custom"',
      'PECMAILER_IMAP_PORT: required when PECMAILER_PROVIDER is "custom"',
      'PECMAILER_IMAP_SECURITY: required when PECMAILER_PROVIDER is "custom"',
      'PECMAILER_IMAP_SENT_FOLDER: required when PECMAILER_PROVIDER is "custom"',
    ]);
  });

  it('turns IMAP off when asked: no Sent copy, no receipts', () => {
    expect(loadConfig(env({ PECMAILER_IMAP_ENABLED: 'false' })).mailbox.imap).toBeNull();
  });

  it('names the variable that is wrong', () => {
    expect(problemsOf(env({ PECMAILER_TENANT: 'Serfin SpA' }))).toEqual([
      expect.stringContaining('PECMAILER_TENANT'),
    ]);
    expect(problemsOf(env({ PECMAILER_SMTP_PASSWORD: undefined }))).toEqual([
      expect.stringContaining('PECMAILER_SMTP_PASSWORD'),
    ]);
    expect(problemsOf(env({ RABBITMQ_URL: 'http://rabbitmq' }))).toEqual([
      expect.stringContaining('RABBITMQ_URL'),
    ]);
  });

  it('treats an empty variable as unset', () => {
    expect(loadConfig(env({ PECMAILER_SMTP_HOST: '' })).mailbox.smtp.host).toBe('smtps.pec.aruba.it');
  });

  it("refuses retries that would outlast RabbitMQ's 30-minute consumer timeout", () => {
    expect(problemsOf(env({ PECMAILER_RETRY_BACKOFF_SECONDS: '600,600,600' }))).toEqual([
      expect.stringContaining('add up to 1800 s'),
    ]);
    expect(problemsOf(env({ PECMAILER_RETRY_BACKOFF_SECONDS: '60,abc' }))).toEqual([
      expect.stringContaining('PECMAILER_RETRY_BACKOFF_SECONDS'),
    ]);
    expect(
      loadConfig(env({ PECMAILER_RETRY_BACKOFF_SECONDS: '30, 60' })).sending.retryBackoffSeconds,
    ).toEqual([30, 60]);
  });

  it('never asks for pretty logs in production, where pino-pretty is not installed', () => {
    expect(loadConfig(env({ LOG_PRETTY: 'true' })).log.pretty).toBe(true);
    expect(loadConfig(env({ LOG_PRETTY: 'true', NODE_ENV: 'production' })).log.pretty).toBe(false);
  });

  it('reads the extra PEC domains as lower-case lists', () => {
    expect(
      loadConfig(env({ PECMAILER_PEC_DOMAINS: ' Pec.Custom.example , ,legal.example' })).recipients,
    ).toMatchObject({
      pecDomains: ['pec.custom.example', 'legal.example'],
      nonPecDomains: [],
    });
  });
});

describe('describeConfig', () => {
  it('says everything but the secrets', () => {
    const text = describeConfig(loadConfig(env())).join('\n');

    expect(text).toContain('pecmailer.serfin.serfin-aruba.in');
    expect(text).toContain('smtps.pec.aruba.it');
    expect(text).not.toContain(SMTP_PASSWORD);
    expect(text).not.toContain(RABBIT_PASSWORD);
  });
});

describe('loadQueueSettings', () => {
  it('needs only what the queues need, not the mailbox password', () => {
    const settings = loadQueueSettings({
      PECMAILER_TENANT: 'serfin',
      PECMAILER_MAILBOX: 'serfin-legalmail',
      RABBITMQ_URL: 'amqp://u:p@localhost:5672',
    });

    expect(settings.output).toBe('pecmailer.serfin.serfin-legalmail.out');
    expect(JSON.stringify(settings)).not.toContain('u:p@');
  });
});
