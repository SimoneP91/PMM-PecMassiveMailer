import type { IncomingMessage, ServerResponse } from 'node:http';

import { RequestMethod } from '@nestjs/common';
import type { Params } from 'nestjs-pino';

import type { Env } from '../../config/env.schema';

/**
 * Structured JSON on stdout, one line per event: the platform collects it.
 * Pretty printing is a development convenience and is never on in production.
 *
 * Redaction is belt and braces: secrets travel inside Secret wrappers and never
 * reach a log object, but a request header or a config dump copied into a log
 * call by mistake must still come out as "[redacted]".
 */
const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  '*.password',
  '*.*.password',
  'secret',
  '*.secret',
  '*.*.secret',
  'apiKey',
  '*.apiKey',
];

export function buildLoggerParams(env: Env): Params {
  return {
    // Fields added with PinoLogger.assign() (the tenant, once authenticated)
    // also land on the "request completed" line.
    assignResponse: true,
    // Probes fire every few seconds; a line each would be most of the log.
    exclude: [{ path: 'health/(.*)', method: RequestMethod.GET }],
    pinoHttp: {
      level: env.LOG_LEVEL,
      // Never in production: pino-pretty is a dev dependency and is not in the image.
      ...(env.LOG_PRETTY && env.NODE_ENV !== 'production'
        ? {
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
            },
          }
        : {}),
      redact: { paths: [...REDACTED_PATHS], censor: '[redacted]' },
      autoLogging: {
        ignore: (req: IncomingMessage): boolean => (req.url ?? '').startsWith('/health'),
      },
      serializers: {
        req: (req: IncomingMessage & { id?: unknown }): Record<string, unknown> => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: ServerResponse): Record<string, unknown> => ({ statusCode: res.statusCode }),
      },
    },
  };
}
