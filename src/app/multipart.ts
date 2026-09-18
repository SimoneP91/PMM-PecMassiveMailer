import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import type { ResolvedConfig } from '../config/config.loader';

/** The Fastify-level ceiling is the largest any tenant is allowed; each tenant's own limit is enforced during intake. */
export function largestRequestBytes(config: ResolvedConfig): number {
  return Math.max(1024 * 1024, ...config.tenants.map((tenant) => tenant.limits.maxRequestBytes));
}

export async function registerMultipart(app: NestFastifyApplication, config: ResolvedConfig): Promise<void> {
  const ceiling = largestRequestBytes(config);
  await app.register(multipart, {
    // Streams only: nothing is attached to the body, the intake reads part by part.
    attachFieldsToBody: false,
    limits: {
      fileSize: ceiling,
      fieldSize: 8 * 1024 * 1024,
      fields: 4,
      files: 6000,
      parts: 6000,
      headerPairs: 64,
    },
  });
}
