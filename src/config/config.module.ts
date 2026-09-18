import { type DynamicModule, Global, Module } from '@nestjs/common';

import { CLOCK, SystemClock } from '../common/time/clock';
import type { ResolvedConfig } from './config.loader';
import type { Env } from './env.schema';

/** Injection tokens for the validated environment and the resolved configuration. */
export const ENV = Symbol('ENV');
export const PECMAILER_CONFIG = Symbol('PECMAILER_CONFIG');

/**
 * Both values are produced BEFORE Nest starts (see main.*.ts): a broken
 * environment or config file must fail before any module, connection or port
 * is touched. This module only hands them out.
 */
@Global()
@Module({})
export class ConfigModule {
  public static forRoot(env: Env, config: ResolvedConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [
        { provide: ENV, useValue: env },
        { provide: PECMAILER_CONFIG, useValue: config },
        { provide: CLOCK, useClass: SystemClock },
      ],
      exports: [ENV, PECMAILER_CONFIG, CLOCK],
    };
  }
}
