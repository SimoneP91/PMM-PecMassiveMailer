import { z } from 'zod';

/**
 * Everything the process reads from the environment, validated once at boot.
 *
 * A malformed variable stops the start-up with a message naming the variable:
 * discovering a typo in MONGODB_URI from a stack trace at the first request is
 * the kind of thing this file exists to prevent.
 */
const transportSecurity = z.enum(['none', 'starttls', 'tls']);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  LOG_PRETTY: z.stringbool().default(false),

  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SWAGGER_ENABLED: z.stringbool().default(true),

  MONGODB_URI: z
    .string()
    .regex(/^mongodb(\+srv)?:\/\/.+/, 'must be a mongodb:// or mongodb+srv:// connection string'),

  CONFIG_FILE: z.string().min(1).default('./config/pecmailer.yaml'),
  STORAGE_DIR: z.string().min(1).default('./storage'),

  // Worker only: liveness/readiness probes, and the name it signs leases with.
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  WORKER_ID: z.string().min(1).max(100).optional(),

  // Local stack only: every mailbox talks to the same fake provider (Greenmail).
  // Left unset in production, where each mailbox uses its own preset.
  PECMAILER_SMTP_OVERRIDE_HOST: z.string().min(1).optional(),
  PECMAILER_SMTP_OVERRIDE_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  PECMAILER_SMTP_OVERRIDE_SECURITY: transportSecurity.optional(),
  PECMAILER_IMAP_OVERRIDE_HOST: z.string().min(1).optional(),
  PECMAILER_IMAP_OVERRIDE_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  PECMAILER_IMAP_OVERRIDE_SECURITY: transportSecurity.optional(),
});

export type Env = z.output<typeof envSchema>;

export class EnvValidationError extends Error {
  public constructor(public readonly issues: string) {
    super(`Invalid environment:\n${issues}`);
    this.name = 'EnvValidationError';
  }
}

/**
 * @param source usually process.env; injectable so tests never touch the real one
 */
export function parseEnv(source: Readonly<Record<string, string | undefined>>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(z.prettifyError(result.error));
  }

  return result.data;
}
