import { z } from 'zod';

/**
 * Shape of config/pecmailer.yaml: who the tenants are, which mailboxes they own,
 * and the hashes of their API keys. It carries no secret by construction: the
 * only place a password or a signing secret can appear is the environment,
 * which this file references by variable name.
 *
 * Cross-references (a mailbox pointing at a tenant that does not exist,
 * duplicated codes) are checked here as well, so a broken file is refused at
 * boot with a precise message rather than discovered by the first request.
 */

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lower-case letters, digits, "_" and "-" only');

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lower-case hex SHA-256');

const envVariableName = z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must look like an environment variable name');

const httpsUrl = z
  .url({ protocol: /^https$/ })
  .describe('webhook endpoint; https only, because the payload is signed and the target is verified');

export const apiKeyConfigSchema = z.strictObject({
  id: identifier,
  label: z.string().min(1).max(100).optional(),
  sha256: sha256Hex,
});

export const tenantLimitsSchema = z.strictObject({
  maxMessagesPerBatch: z.number().int().min(1).max(5000).default(2500),
  maxRequestBytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(512 * 1024 * 1024)
    .default(50 * 1024 * 1024),
  requestsPerMinute: z.number().int().min(1).max(10_000).default(120),
});

export const webhookConfigSchema = z.strictObject({
  url: httpsUrl,
  secretEnv: envVariableName,
  /**
   * Off by default: the host must resolve to a public address, so the
   * service cannot be turned against the internal network (SSRF). An
   * operator turns it on, knowingly, for a client that lives on the VPN.
   */
  allowPrivateNetwork: z.boolean().default(false),
});

export const tenantConfigSchema = z.strictObject({
  id: identifier,
  externalId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  apiKeys: z.array(apiKeyConfigSchema).min(1),
  webhook: webhookConfigSchema.optional(),
  limits: tenantLimitsSchema.prefault({}),
});

export const providerNameSchema = z.enum(['aruba', 'legalmail', 'infocert', 'custom']);
export const transportSecuritySchema = z.enum(['none', 'starttls', 'tls']);

const port = z.number().int().min(1).max(65_535);

export const mailboxConfigSchema = z.strictObject({
  code: identifier,
  tenant: identifier,
  provider: providerNameSchema,
  from: z.strictObject({
    address: z.email(),
    name: z.string().min(1).max(200),
  }),
  smtp: z.strictObject({
    username: z.string().min(1),
    host: z.string().min(1).optional(),
    port: port.optional(),
    security: transportSecuritySchema.optional(),
    timeoutSeconds: z.number().int().min(5).max(300).default(30),
  }),
  imap: z
    .strictObject({
      host: z.string().min(1).optional(),
      port: port.optional(),
      security: transportSecuritySchema.optional(),
      username: z.string().min(1).optional(),
      sentFolder: z.string().min(1).optional(),
      /** Where the provider delivers the receipts; read-only, nothing is moved or flagged. */
      receiptsFolder: z.string().min(1).default('INBOX'),
      // false = do not file a copy in Sent and do not read receipts from this mailbox
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  limits: z
    .strictObject({
      perMinute: z.number().int().min(0).max(10_000).default(60),
      perDay: z.number().int().min(0).default(0),
      maxMessageBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .default(30 * 1024 * 1024),
    })
    .prefault({}),
  passwordEnv: envVariableName.optional(),
});

const domainName = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    'must be a lower-case domain name',
  );

/**
 * Extends the built-in knowledge of PEC providers (see
 * modules/recipients/pec-providers.ts) without a release.
 */
export const recipientsConfigSchema = z.strictObject({
  pecDomains: z.array(domainName).default([]),
  pecMxSuffixes: z.array(domainName).default([]),
  nonPecDomains: z.array(domainName).default([]),
  nonPecMxSuffixes: z.array(domainName).default([]),
});

/**
 * How the worker sends. Global: the provider-facing limits live on each
 * mailbox, these are the mechanics of the loop.
 */
export const sendingConfigSchema = z.strictObject({
  /** Attempts before a message with transient failures becomes FAILED. */
  maxAttempts: z.number().int().min(1).max(20).default(5),
  /** Delay before attempt 2, 3, ...; the last value repeats. */
  retryBackoffSeconds: z.array(z.number().int().min(1)).min(1).default([60, 300, 900, 3600, 14400]),
  /**
   * A message SENDING whose worker gave no sign of life (heartbeat, every
   * leaseTtlSeconds/3) for this long is STUCK: the worker died mid-send and
   * nobody knows if it left.
   */
  staleSendingSeconds: z.number().int().min(60).default(600),
  /** How often a mailbox loop looks for work when the queue is empty. */
  pollIntervalMs: z.number().int().min(100).default(5000),
  /** How long a worker owns a mailbox before it must renew (renewed at a third of it). */
  leaseTtlSeconds: z.number().int().min(10).default(60),
  /** How often a suspended mailbox is re-checked for reactivation. */
  suspendedRecheckSeconds: z.number().int().min(5).default(60),
});

/** Reading the PEC receipts and closing batches. */
export const receiptsConfigSchema = z.strictObject({
  /** How often each mailbox's receipts folder is read. */
  pollIntervalSeconds: z.number().int().min(1).default(60),
  /** Messages fetched per read, at most; the next read continues. */
  maxPerPoll: z.number().int().min(1).max(1000).default(200),
  /**
   * A sent message without a final receipt after this long is TIMED_OUT. The
   * PEC rules give providers 24 hours to deliver or to notify the failure.
   */
  settleAfterHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(30),
});

/** Delivering webhook events to the tenants. */
export const webhooksConfigSchema = z.strictObject({
  timeoutSeconds: z.number().int().min(1).max(60).default(10),
  /** Delay before attempt 2, 3, ...; the last value repeats. */
  backoffSeconds: z.array(z.number().int().min(1)).min(1).default([30, 120, 600, 1800, 3600, 7200]),
  /** An event not delivered within this long is FAILED (and listed by the webhook CLI). */
  retryForHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 7)
    .default(24),
  pollIntervalMs: z.number().int().min(100).default(2000),
});

export const pecmailerConfigSchema = z
  .strictObject({
    tenants: z.array(tenantConfigSchema).min(1),
    mailboxes: z.array(mailboxConfigSchema),
    recipients: recipientsConfigSchema.prefault({}),
    sending: sendingConfigSchema.prefault({}),
    receipts: receiptsConfigSchema.prefault({}),
    webhooks: webhooksConfigSchema.prefault({}),
  })
  .superRefine((config, ctx) => {
    const tenantIds = new Set<string>();
    const apiKeyIds = new Set<string>();
    const apiKeyHashes = new Set<string>();

    config.tenants.forEach((tenant, i) => {
      if (tenantIds.has(tenant.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tenants', i, 'id'],
          message: `duplicate tenant id "${tenant.id}"`,
        });
      }
      tenantIds.add(tenant.id);

      tenant.apiKeys.forEach((key, k) => {
        if (apiKeyIds.has(key.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tenants', i, 'apiKeys', k, 'id'],
            message: `duplicate api key id "${key.id}"`,
          });
        }
        apiKeyIds.add(key.id);
        if (apiKeyHashes.has(key.sha256)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tenants', i, 'apiKeys', k, 'sha256'],
            message: 'the same api key is declared twice',
          });
        }
        apiKeyHashes.add(key.sha256);
      });
    });

    const mailboxCodes = new Set<string>();
    config.mailboxes.forEach((mailbox, i) => {
      if (mailboxCodes.has(mailbox.code)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mailboxes', i, 'code'],
          message: `duplicate mailbox code "${mailbox.code}"`,
        });
      }
      mailboxCodes.add(mailbox.code);

      if (!tenantIds.has(mailbox.tenant)) {
        ctx.addIssue({
          code: 'custom',
          path: ['mailboxes', i, 'tenant'],
          message: `mailbox "${mailbox.code}" points at unknown tenant "${mailbox.tenant}"`,
        });
      }

      if (mailbox.provider === 'custom') {
        for (const field of ['host', 'port', 'security'] as const) {
          if (mailbox.smtp[field] === undefined) {
            ctx.addIssue({
              code: 'custom',
              path: ['mailboxes', i, 'smtp', field],
              message: 'required when provider is "custom"',
            });
          }
        }
        if (mailbox.imap.enabled) {
          for (const field of ['host', 'port', 'security', 'sentFolder'] as const) {
            if (mailbox.imap[field] === undefined) {
              ctx.addIssue({
                code: 'custom',
                path: ['mailboxes', i, 'imap', field],
                message: 'required when provider is "custom" and imap is enabled',
              });
            }
          }
        }
      }
    });
  });

export type PecmailerConfigFile = z.output<typeof pecmailerConfigSchema>;
export type TenantConfig = z.output<typeof tenantConfigSchema>;
export type ApiKeyConfig = z.output<typeof apiKeyConfigSchema>;
export type TenantLimits = z.output<typeof tenantLimitsSchema>;
export type MailboxConfig = z.output<typeof mailboxConfigSchema>;
export type RecipientsConfig = z.output<typeof recipientsConfigSchema>;
export type SendingConfig = z.output<typeof sendingConfigSchema>;
export type ReceiptsConfig = z.output<typeof receiptsConfigSchema>;
export type WebhooksConfig = z.output<typeof webhooksConfigSchema>;
export type ProviderName = z.output<typeof providerNameSchema>;
export type TransportSecurity = z.output<typeof transportSecuritySchema>;
