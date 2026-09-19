import { type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { CliModule } from '../app/cli.module';
import { ConfigLoadError, loadConfig, type EnvSource } from '../config/config.loader';
import { EnvValidationError, parseEnv } from '../config/env.schema';

/** Boots the CLI context for one command and tears it down whatever happens. */
export async function withApp(
  source: EnvSource,
  run: (app: INestApplicationContext) => Promise<number>,
): Promise<number> {
  let app: INestApplicationContext;
  try {
    const env = parseEnv(source);
    const config = await loadConfig(env, source);
    // abortOnError false: a failed boot must reach the catch below and be
    // reported, not end the process silently.
    app = await NestFactory.createApplicationContext(CliModule.forRoot(env, config), {
      logger: false,
      abortOnError: false,
    });
  } catch (error: unknown) {
    if (error instanceof EnvValidationError || error instanceof ConfigLoadError) {
      console.error(error.message);

      return 1;
    }
    throw error;
  }

  try {
    return await run(app);
  } finally {
    await app.close();
  }
}
