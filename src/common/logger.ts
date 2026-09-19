import { pino, type Logger } from 'pino';

import { APP_NAME, APP_VERSION } from '../app/version';

export type { Logger };

export interface LoggerOptions {
  readonly level: string;
  /** Human-readable output for a terminal; development only (pino-pretty is a dev dependency). */
  readonly pretty: boolean;
  readonly tenant?: string;
  readonly mailbox?: string;
}

/**
 * One JSON object per line on standard output: what a container is expected
 * to write, and what Graylog (or any collector) ingests without parsing
 * rules. Every line carries the tenant and the mailbox, so the logs of many
 * containers can be told apart once collected in one place.
 *
 * Nothing personal is logged on purpose: ids, codes and counts, never a
 * recipient, a subject or a body. The redaction below is the safety net for
 * secrets passed by mistake.
 */
export function createLogger(options: LoggerOptions): Logger {
  return pino({
    level: options.level,
    base: {
      service: APP_NAME,
      version: APP_VERSION,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
      ...(options.mailbox === undefined ? {} : { mailbox: options.mailbox }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: {
      paths: ['password', 'pass', 'url', '*.password', '*.pass', '*.url', 'auth.*'],
      censor: '[redacted]',
    },
    ...(options.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  });
}
