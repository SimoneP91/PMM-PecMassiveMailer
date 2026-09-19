import { readFile } from 'node:fs/promises';

import { load as parseYaml } from 'js-yaml';
import { z } from 'zod';

import { Secret } from '../common/security/secret';
import {
  asApiKeyId,
  asMailboxCode,
  asTenantId,
  type ApiKeyId,
  type MailboxCode,
  type TenantId,
} from '../common/types/branded';
import { presetFor } from '../modules/mailboxes/provider-presets';
import type { Env } from './env.schema';
import {
  pecmailerConfigSchema,
  type MailboxConfig,
  type PecmailerConfigFile,
  type ProviderName,
  type RecipientsConfig,
  type ReceiptsConfig,
  type SendingConfig,
  type TenantConfig,
  type TenantLimits,
  type TransportSecurity,
  type WebhooksConfig,
} from './pecmailer-config.schema';

/**
 * The configuration the rest of the service works with: the YAML file with
 * every reference resolved - provider presets applied, passwords and signing
 * secrets fetched from the environment, local overrides in place.
 *
 * Resolution happens once, before Nest starts. A mailbox whose password is not
 * in the environment stops the boot: the alternative is a worker that sends an
 * empty password to a provider, repeatedly, until the mailbox gets locked.
 */

export interface ResolvedApiKey {
  readonly id: ApiKeyId;
  readonly label: string | undefined;
  readonly sha256: string;
}

export interface ResolvedWebhook {
  readonly url: string;
  readonly secret: Secret;
  readonly allowPrivateNetwork: boolean;
}

export interface ResolvedTenant {
  readonly id: TenantId;
  readonly externalId: string;
  readonly name: string;
  readonly apiKeys: readonly ResolvedApiKey[];
  readonly webhook: ResolvedWebhook | null;
  readonly limits: TenantLimits;
}

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
  readonly code: MailboxCode;
  readonly tenantId: TenantId;
  readonly provider: ProviderName;
  readonly from: { readonly address: string; readonly name: string };
  readonly smtp: ResolvedSmtp;
  /** null = no Sent copy and no receipt polling for this mailbox */
  readonly imap: ResolvedImap | null;
  readonly limits: MailboxConfig['limits'];
}

export interface ResolvedConfig {
  readonly tenants: readonly ResolvedTenant[];
  readonly mailboxes: readonly ResolvedMailbox[];
  readonly recipients: RecipientsConfig;
  readonly sending: SendingConfig;
  readonly receipts: ReceiptsConfig;
  readonly webhooks: WebhooksConfig;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

export class ConfigLoadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigLoadError';
  }
}

/** MAILBOX_<CODE>_PASSWORD, code upper-cased, anything not alphanumeric becomes "_". */
export function passwordEnvName(mailboxCode: string): string {
  const normalised = mailboxCode
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return `MAILBOX_${normalised}_PASSWORD`;
}

function requireSecret(source: EnvSource, variable: string, purpose: string): Secret {
  const value = source[variable];
  if (value === undefined || value === '') {
    throw new ConfigLoadError(`${purpose}: environment variable ${variable} is missing or empty`);
  }

  return new Secret(value);
}

function resolveTenant(tenant: TenantConfig, source: EnvSource): ResolvedTenant {
  return {
    id: asTenantId(tenant.id),
    externalId: tenant.externalId,
    name: tenant.name,
    apiKeys: tenant.apiKeys.map((key) => ({ id: asApiKeyId(key.id), label: key.label, sha256: key.sha256 })),
    webhook:
      tenant.webhook === undefined
        ? null
        : {
            url: tenant.webhook.url,
            secret: requireSecret(source, tenant.webhook.secretEnv, `tenant "${tenant.id}" webhook secret`),
            allowPrivateNetwork: tenant.webhook.allowPrivateNetwork,
          },
    limits: tenant.limits,
  };
}

function resolveMailbox(mailbox: MailboxConfig, env: Env, source: EnvSource): ResolvedMailbox {
  const preset = presetFor(mailbox.provider);
  const password = requireSecret(
    source,
    mailbox.passwordEnv ?? passwordEnvName(mailbox.code),
    `mailbox "${mailbox.code}" password`,
  );

  // Explicit value > local override > provider preset. The schema guarantees
  // that a "custom" provider carries every value explicitly.
  const smtpHost = mailbox.smtp.host ?? env.PECMAILER_SMTP_OVERRIDE_HOST ?? preset?.smtp.host;
  const smtpPort = mailbox.smtp.port ?? env.PECMAILER_SMTP_OVERRIDE_PORT ?? preset?.smtp.port;
  const smtpSecurity = mailbox.smtp.security ?? env.PECMAILER_SMTP_OVERRIDE_SECURITY ?? preset?.smtp.security;
  if (smtpHost === undefined || smtpPort === undefined || smtpSecurity === undefined) {
    throw new ConfigLoadError(`mailbox "${mailbox.code}": SMTP host, port and security cannot be resolved`);
  }

  let imap: ResolvedImap | null = null;
  if (mailbox.imap.enabled) {
    const host = mailbox.imap.host ?? env.PECMAILER_IMAP_OVERRIDE_HOST ?? preset?.imap.host;
    const port = mailbox.imap.port ?? env.PECMAILER_IMAP_OVERRIDE_PORT ?? preset?.imap.port;
    const security = mailbox.imap.security ?? env.PECMAILER_IMAP_OVERRIDE_SECURITY ?? preset?.imap.security;
    const sentFolder = mailbox.imap.sentFolder ?? preset?.imap.sentFolder;
    if (host === undefined || port === undefined || security === undefined || sentFolder === undefined) {
      throw new ConfigLoadError(
        `mailbox "${mailbox.code}": IMAP host, port, security and sentFolder cannot be resolved`,
      );
    }
    imap = {
      host,
      port,
      security,
      username: mailbox.imap.username ?? mailbox.smtp.username,
      password,
      sentFolder,
      receiptsFolder: mailbox.imap.receiptsFolder,
    };
  }

  return {
    code: asMailboxCode(mailbox.code),
    tenantId: asTenantId(mailbox.tenant),
    provider: mailbox.provider,
    from: mailbox.from,
    smtp: {
      host: smtpHost,
      port: smtpPort,
      security: smtpSecurity,
      username: mailbox.smtp.username,
      password,
      timeoutSeconds: mailbox.smtp.timeoutSeconds,
    },
    imap,
    limits: mailbox.limits,
  };
}

/** Pure: takes an already parsed file, returns the resolved configuration. */
export function resolveConfig(file: PecmailerConfigFile, env: Env, source: EnvSource): ResolvedConfig {
  return Object.freeze({
    tenants: file.tenants.map((tenant) => resolveTenant(tenant, source)),
    mailboxes: file.mailboxes.map((mailbox) => resolveMailbox(mailbox, env, source)),
    recipients: file.recipients,
    sending: file.sending,
    receipts: file.receipts,
    webhooks: file.webhooks,
  });
}

export function parseConfigFile(yamlText: string, fileName: string): PecmailerConfigFile {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error: unknown) {
    throw new ConfigLoadError(
      `${fileName}: not valid YAML (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  const result = pecmailerConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigLoadError(`${fileName}: invalid configuration\n${z.prettifyError(result.error)}`);
  }

  return result.data;
}

export async function loadConfig(env: Env, source: EnvSource): Promise<ResolvedConfig> {
  let text: string;
  try {
    text = await readFile(env.CONFIG_FILE, 'utf8');
  } catch (error: unknown) {
    throw new ConfigLoadError(
      `cannot read CONFIG_FILE "${env.CONFIG_FILE}" (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  return resolveConfig(parseConfigFile(text, env.CONFIG_FILE), env, source);
}
