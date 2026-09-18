import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

import { WorkerModule } from './app/worker.module';
import { WorkerRunner } from './app/worker-runner';
import { ensureWritableDirectory } from './common/fs/ensure-dir';
import { loadConfig } from './config/config.loader';
import { parseEnv } from './config/env.schema';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const config = await loadConfig(env, process.env);
  await ensureWritableDirectory(env.STORAGE_DIR);

  const app = await NestFactory.createApplicationContext(WorkerModule.forRoot(env, config), {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  // SIGTERM / SIGINT -> onApplicationShutdown on every provider, then close.
  app.enableShutdownHooks();
  await app.init();

  await app.get(WorkerRunner).waitUntilStopped();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`pecmailer worker failed to start\n${message}\n`);
  process.exitCode = 1;
});
