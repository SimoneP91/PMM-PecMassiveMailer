import type { z } from 'zod';

import { Secret } from '../common/security/secret';
import { envSchema, type Env } from './env.schema';
import { presetFor } from './provider-presets';

export type TransportSecurity = 'none' | 'starttls' | 'tls';
export type ProviderName = Env['PECMAILER_PROVIDER'];

export interface ResolvedSmtp {
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
  readonly username: string;
  readonly password: Secret;
  readonly timeoutSeconds: number;
}

export interface ResolvedImap {
  readonly host: string;
  readonly port: number;
  readonly security: TransportSecurity;
  readonly username: string;
  readonly password: Secret;
  readonly sentFolder: string;
  readonly receiptsFolder: string;
}

export interface ResolvedMailbox {
  readonly code: string;
  readonly tenant: string;
  readonly provider: ProviderName;
  readonly from: { readonly address: string; readonly name: string };
  readonly smtp: ResolvedSmtp;
  /** null = no Sent copy and no receipt reading. */
  readonly imap: ResolvedImap | null;
  readonly limits: {
    /** PECs per minute at most; 0 = no pace. */
    readonly perMinute: number;
    /** The encoded message, as the provider counts it. */
    readonly maxMessageBytes: number;
  };
}

export interface QueueSettings {
  readonly url: Secret;
  readonly tenant: string;
  readonly mailbox: string;
  /** PECs to send. */
  readonly input: string;
  /** Outcomes and receipts. */
  readonly output: string;
  /** Input messages that cannot be read, or delivered too many times. */
  readonly dead: string;
  /** Declare the queues at start-up when missing (off when infrastructure creates them). */
  readonly declare: boolean;
  readonly deliveryLimit: number;
}

export interface RecipientLists {
  readonly pecDomains: readonly string[];
  readonly pecMxSuffixes: readonly string[];
  readonly nonPecDomains: readonly string[];
  readonly nonPecMxSuffixes: readonly string[];
}

export interface Config {
  readonly env: Env['NODE_ENV'];
  readonly log: { readonly level: Env['LOG_LEVEL']; readonly pretty: boolean };
  readonly health: { readonly host: string; readonly port: number };
  readonly mailbox: ResolvedMailbox;
  readonly queues: QueueSettings;
  readonly sending: {
    /** Waits before attempt 2, 3, ... of a temporary failure. */
    readonly retryBackoffSeconds: readonly number[];
    readonly unverifiedRecipients: 'reject' | 'send';
  };
  readonly recipients: RecipientLists;
  readonly receipts: {
    readonly pollIntervalSeconds: number;
    /** Without a cursor (a container keeps nothing), each start re-reads this far back. */
    readonly lookbackHours: number;
    readonly maxPerPoll: number;
  };
}

/**
 * RabbitMQ gives up on a consumer that keeps a message unacknowledged for 30
 * minutes (its default consumer timeout). Retries happen while the message is
 * held, so their waits must fit well inside that, sending time included.
 */
export const MAX_RETRY_WINDOW_SECONDS = 25 * 60;

export class ConfigError extends Error {
  public constructor(public readonly problems: readonly string[]) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

type Source = Readonly<Record<string, string | undefined>>;

function parseEnv<T extends z.ZodType>(schema: T, source: Source): z.output<T> {
  // An empty variable counts as unset: docker-compose writes "VAR=" for a blank value.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
  }

  return parsed.data;
}

function queueSettings(env: {
  RABBITMQ_URL: string;
  PECMAILER_TENANT: string;
  PECMAILER_MAILBOX: string;
  PECMAILER_QUEUE_PREFIX: string;
  PECMAILER_DECLARE_QUEUES: boolean;
  PECMAILER_QUEUE_DELIVERY_LIMIT: number;
}): QueueSettings {
  const base = `${env.PECMAILER_QUEUE_PREFIX}.${env.PECMAILER_TENANT}.${env.PECMAILER_MAILBOX}`;

  return {
    url: new Secret(env.RABBITMQ_URL),
    tenant: env.PECMAILER_TENANT,
    mailbox: env.PECMAILER_MAILBOX,
    input: `${base}.in`,
    output: `${base}.out`,
    dead: `${base}.dead`,
    declare: env.PECMAILER_DECLARE_QUEUES,
    deliveryLimit: env.PECMAILER_QUEUE_DELIVERY_LIMIT,
  };
}

/** Only what the queue tools of the CLI need: no mailbox password required. */
export function loadQueueSettings(source: Source): QueueSettings {
  return queueSettings(
    parseEnv(
      envSchema.pick({
        RABBITMQ_URL: true,
        PECMAILER_TENANT: true,
        PECMAILER_MAILBOX: true,
        PECMAILER_QUEUE_PREFIX: true,
        PECMAILER_DECLARE_QUEUES: true,
        PECMAILER_QUEUE_DELIVERY_LIMIT: true,
      }),
      source,
    ),
  );
}

export function loadConfig(source: Source): Config {
  const env = parseEnv(envSchema, source);
  const problems: string[] = [];
  const preset = presetFor(env.PECMAILER_PROVIDER);

  function pick<T>(explicit: T | undefined, fromPreset: T | undefined, variable: string): T {
    const value = explicit ?? fromPreset;
    if (value === undefined) {
      problems.push(`${variable}: required when PECMAILER_PROVIDER is "custom"`);
    }

    return value as T;
  }

  const smtpUsername = env.PECMAILER_SMTP_USERNAME ?? env.PECMAILER_FROM_ADDRESS;
  const smtp: ResolvedSmtp = {
    host: pick(env.PECMAILER_SMTP_HOST, preset?.smtp.host, 'PECMAILER_SMTP_HOST'),
    port: pick(env.PECMAILER_SMTP_PORT, preset?.smtp.port, 'PECMAILER_SMTP_PORT'),
    security: pick(env.PECMAILER_SMTP_SECURITY, preset?.smtp.security, 'PECMAILER_SMTP_SECURITY'),
    username: smtpUsername,
    password: new Secret(env.PECMAILER_SMTP_PASSWORD),
    timeoutSeconds: env.PECMAILER_SMTP_TIMEOUT_SECONDS,
  };
  const imap: ResolvedImap | null = env.PECMAILER_IMAP_ENABLED
    ? {
        host: pick(env.PECMAILER_IMAP_HOST, preset?.imap.host, 'PECMAILER_IMAP_HOST'),
        port: pick(env.PECMAILER_IMAP_PORT, preset?.imap.port, 'PECMAILER_IMAP_PORT'),
        security: pick(env.PECMAILER_IMAP_SECURITY, preset?.imap.security, 'PECMAILER_IMAP_SECURITY'),
        username: env.PECMAILER_IMAP_USERNAME ?? smtpUsername,
        password: new Secret(env.PECMAILER_IMAP_PASSWORD ?? env.PECMAILER_SMTP_PASSWORD),
        sentFolder: pick(
          env.PECMAILER_IMAP_SENT_FOLDER,
          preset?.imap.sentFolder,
          'PECMAILER_IMAP_SENT_FOLDER',
        ),
        receiptsFolder: env.PECMAILER_IMAP_RECEIPTS_FOLDER,
      }
    : null;

  const retryWindow = env.PECMAILER_RETRY_BACKOFF_SECONDS.reduce((sum, wait) => sum + wait, 0);
  if (retryWindow > MAX_RETRY_WINDOW_SECONDS) {
    problems.push(
      `PECMAILER_RETRY_BACKOFF_SECONDS: the waits add up to ${String(retryWindow)} s; at most ` +
        `${String(MAX_RETRY_WINDOW_SECONDS)} s, so a PEC is settled before RabbitMQ's 30-minute consumer timeout`,
    );
  }
  if (problems.length > 0) {
    throw new ConfigError(problems);
  }

  return {
    env: env.NODE_ENV,
    // pino-pretty is a development dependency: never ask for it in production.
    log: { level: env.LOG_LEVEL, pretty: env.LOG_PRETTY && env.NODE_ENV !== 'production' },
    health: { host: env.HEALTH_HOST, port: env.HEALTH_PORT },
    mailbox: {
      code: env.PECMAILER_MAILBOX,
      tenant: env.PECMAILER_TENANT,
      provider: env.PECMAILER_PROVIDER,
      from: { address: env.PECMAILER_FROM_ADDRESS, name: env.PECMAILER_FROM_NAME },
      smtp,
      imap,
      limits: { perMinute: env.PECMAILER_PER_MINUTE, maxMessageBytes: env.PECMAILER_MAX_MESSAGE_BYTES },
    },
    queues: queueSettings(env),
    sending: {
      retryBackoffSeconds: env.PECMAILER_RETRY_BACKOFF_SECONDS,
      unverifiedRecipients: env.PECMAILER_UNVERIFIED_RECIPIENTS,
    },
    recipients: {
      pecDomains: env.PECMAILER_PEC_DOMAINS,
      pecMxSuffixes: env.PECMAILER_PEC_MX_SUFFIXES,
      nonPecDomains: env.PECMAILER_NON_PEC_DOMAINS,
      nonPecMxSuffixes: env.PECMAILER_NON_PEC_MX_SUFFIXES,
    },
    receipts: {
      pollIntervalSeconds: env.PECMAILER_RECEIPTS_POLL_SECONDS,
      lookbackHours: env.PECMAILER_RECEIPTS_LOOKBACK_HOURS,
      maxPerPoll: env.PECMAILER_RECEIPTS_MAX_PER_POLL,
    },
  };
}

/** What `config check` prints: every setting, no secret. */
export function describeConfig(config: Config): string[] {
  const { mailbox, queues } = config;
  const imap = mailbox.imap;

  return [
    `tenant ${mailbox.tenant}, mailbox ${mailbox.code} (${mailbox.provider}), from ${mailbox.from.name} <${mailbox.from.address}>`,
    `smtp ${mailbox.smtp.host}:${String(mailbox.smtp.port)}/${mailbox.smtp.security} as ${mailbox.smtp.username}, password set`,
    imap === null
      ? 'imap disabled: no Sent copy, no receipts'
      : `imap ${imap.host}:${String(imap.port)}/${imap.security} as ${imap.username}, sent folder "${imap.sentFolder}", receipts folder "${imap.receiptsFolder}"`,
    `pace ${mailbox.limits.perMinute === 0 ? 'none' : `${String(mailbox.limits.perMinute)}/min`}, max message ${String(mailbox.limits.maxMessageBytes)} bytes, retries after ${config.sending.retryBackoffSeconds.join(', ')} s`,
    `queues ${queues.input} -> ${queues.output} (dead letters ${queues.dead}), ${queues.declare ? `declared at start, delivery limit ${String(queues.deliveryLimit)}` : 'created by the infrastructure'}`,
    `receipts every ${String(config.receipts.pollIntervalSeconds)} s, ${String(config.receipts.lookbackHours)} h back at start`,
    `health probes on ${config.health.host}:${String(config.health.port)}`,
  ];
}
