import 'reflect-metadata';

import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { ApiModule } from './app/api.module';
import { largestRequestBytes, registerMultipart } from './app/multipart';
import { setupSwagger } from './app/swagger';
import { ensureWritableDirectory } from './common/fs/ensure-dir';
import { requestIdFrom } from './common/http/request-id';
import { loadConfig } from './config/config.loader';
import { parseEnv } from './config/env.schema';

async function main(): Promise<void> {
  const env = parseEnv(process.env);
  const config = await loadConfig(env, process.env);
  await ensureWritableDirectory(env.STORAGE_DIR);

  const adapter = new FastifyAdapter({
    bodyLimit: largestRequestBytes(config),
    genReqId: requestIdFrom,
    trustProxy: false,
    disableRequestLogging: true,
  });

  const app = await NestFactory.create<NestFastifyApplication>(ApiModule.forRoot(env, config), adapter, {
    bufferLogs: true,
  });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  // Security headers. CSP is off: this is a JSON API, and Swagger UI's inline
  // scripts would otherwise be blocked on the one HTML page it serves.
  await app.register(helmet, { contentSecurityPolicy: false });
  await registerMultipart(app, config);

  if (env.SWAGGER_ENABLED) {
    setupSwagger(app);
  }

  await app.listen({ port: env.HTTP_PORT, host: env.HTTP_HOST });
}

main().catch((error: unknown) => {
  // The logger may not exist yet: this is the one place stderr is written directly.
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`pecmailer api failed to start\n${message}\n`);
  process.exitCode = 1;
});
