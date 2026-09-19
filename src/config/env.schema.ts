import { z } from 'zod';

/**
 * Everything a container reads from its environment, validated once at boot.
 * One container serves one tenant and one mailbox, so there is no
 * configuration file: every setting is a variable, which is how Kubernetes
 * (ConfigMap + Secret) and docker-compose both hand settings to a container.
 *
 * A malformed variable stops the start with a message naming it.
 */
const code = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lower-case letters, digits and "-", up to 63 characters');
const transportSecurity = z.enum(['none', 'starttls', 'tls']);
const port = z.coerce.number().int().min(1).max(65_535);
const optionalText = z.string().min(1).optional();
const commaList = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry !== ''),
  );
const seconds = z.coerce.number().int();

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  // Who this container is.
  PECMAILER_TENANT: code,
  PECMAILER_MAILBOX: code,
  PECMAILER_PROVIDER: z.enum(['aruba', 'legalmail', 'infocert', 'custom']),
  PECMAILER_FROM_ADDRESS: z.email().max(254),
  PECMAILER_FROM_NAME: z.string().min(1).max(200),

  // SMTP: host, port and security come from the provider preset unless set.
  PECMAILER_SMTP_USERNAME: optionalText,
  PECMAILER_SMTP_PASSWORD: z.string().min(1),
  PECMAILER_SMTP_HOST: optionalText,
  PECMAILER_SMTP_PORT: port.optional(),
  PECMAILER_SMTP_SECURITY: transportSecurity.optional(),
  PECMAILER_SMTP_TIMEOUT_SECONDS: seconds.min(5).max(600).default(60),

  // IMAP: the Sent copy and the receipts. Username and password default to the SMTP ones.
  PECMAILER_IMAP_ENABLED: z.stringbool().default(true),
  PECMAILER_IMAP_USERNAME: optionalText,
  PECMAILER_IMAP_PASSWORD: optionalText,
  PECMAILER_IMAP_HOST: optionalText,
  PECMAILER_IMAP_PORT: port.optional(),
  PECMAILER_IMAP_SECURITY: transportSecurity.optional(),
  PECMAILER_IMAP_SENT_FOLDER: optionalText,
  PECMAILER_IMAP_RECEIPTS_FOLDER: z.string().min(1).default('INBOX'),

  // Sending.
  PECMAILER_PER_MINUTE: z.coerce.number().int().min(0).max(10_000).default(60),
  PECMAILER_MAX_MESSAGE_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(30 * 1024 * 1024),
  PECMAILER_RETRY_BACKOFF_SECONDS: z
    .string()
    .default('60,300,900')
    .transform((value, ctx) => {
      const list = value.split(',').map((entry) => Number(entry.trim()));
      if (list.length === 0 || list.some((entry) => !Number.isInteger(entry) || entry < 1)) {
        ctx.addIssue({ code: 'custom', message: 'comma-separated positive whole seconds, e.g. 60,300,900' });

        return z.NEVER;
      }

      return list;
    }),
  PECMAILER_UNVERIFIED_RECIPIENTS: z.enum(['reject', 'send']).default('reject'),
  PECMAILER_PEC_DOMAINS: commaList,
  PECMAILER_PEC_MX_SUFFIXES: commaList,
  PECMAILER_NON_PEC_DOMAINS: commaList,
  PECMAILER_NON_PEC_MX_SUFFIXES: commaList,

  // Receipts.
  PECMAILER_RECEIPTS_POLL_SECONDS: seconds.min(5).max(3600).default(60),
  PECMAILER_RECEIPTS_LOOKBACK_HOURS: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(72),
  PECMAILER_RECEIPTS_MAX_PER_POLL: z.coerce.number().int().min(1).max(1000).default(200),

  // RabbitMQ.
  RABBITMQ_URL: z
    .string()
    .regex(/^amqps?:\/\/.+/, 'must be an amqp:// or amqps:// URL, e.g. amqp://user:password@rabbitmq:5672'),
  PECMAILER_QUEUE_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'lower-case letters, digits, ".", "_" and "-"')
    .default('pecmailer'),
  PECMAILER_DECLARE_QUEUES: z.stringbool().default(true),
  PECMAILER_QUEUE_DELIVERY_LIMIT: z.coerce.number().int().min(1).max(100).default(5),

  // Kubernetes probes.
  HEALTH_HOST: z.string().min(1).default('0.0.0.0'),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
});

export type Env = z.output<typeof envSchema>;
