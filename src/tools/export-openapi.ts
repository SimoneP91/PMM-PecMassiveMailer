import 'reflect-metadata';

import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { MongoMemoryServer } from 'mongodb-memory-server';

import { ApiModule } from '../app/api.module';
import { buildOpenApiDocument } from '../app/swagger';
import type { ResolvedConfig } from '../config/config.loader';
import { parseEnv } from '../config/env.schema';

/**
 * Writes the OpenAPI document to a file: what a client integrator needs
 * before the service exists. The application needs a database to boot, so a
 * throw-away in-memory MongoDB is started for the duration (the binary is
 * downloaded once and cached by mongodb-memory-server).
 *
 *   npm run openapi:export -- [path]     default: ./openapi.json
 */
async function main(): Promise<void> {
  const target = process.argv[2] ?? 'openapi.json';
  const mongo = await MongoMemoryServer.create();
  try {
    const env = parseEnv({
      NODE_ENV: 'production',
      LOG_LEVEL: 'fatal',
      MONGODB_URI: mongo.getUri('pecmailer'),
      STORAGE_DIR: tmpdir(),
    });
    const config: ResolvedConfig = {
      tenants: [],
      mailboxes: [],
      recipients: { pecDomains: [], pecMxSuffixes: [], nonPecDomains: [], nonPecMxSuffixes: [] },
      sending: {
        maxAttempts: 5,
        retryBackoffSeconds: [60],
        staleSendingSeconds: 600,
        pollIntervalMs: 5000,
        leaseTtlSeconds: 60,
        suspendedRecheckSeconds: 60,
      },
    };

    const app = await NestFactory.create<NestFastifyApplication>(
      ApiModule.forRoot(env, config),
      new FastifyAdapter(),
      {
        logger: false,
      },
    );
    await app.init();
    await writeFile(target, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`, 'utf8');
    console.log(`OpenAPI document written to ${target}`);
    await app.close();
  } finally {
    await mongo.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
