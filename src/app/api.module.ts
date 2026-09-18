import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ZodValidationPipe } from 'nestjs-zod';

import { ProblemDetailsFilter } from '../common/errors/problem-details.filter';
import { buildLoggerParams } from '../common/logging/logger.options';
import type { ResolvedConfig } from '../config/config.loader';
import { ConfigModule } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../modules/auth/auth.module';
import { BatchesModule } from '../modules/batches/batches.module';
import { HealthModule } from '../modules/health/health.module';
import { MailboxesModule } from '../modules/mailboxes/mailboxes.module';
import { TenantsModule } from '../modules/tenants/tenants.module';

@Module({})
export class ApiModule {
  public static forRoot(env: Env, config: ResolvedConfig): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        ConfigModule.forRoot(env, config),
        LoggerModule.forRoot(buildLoggerParams(env)),
        DatabaseModule,
        TenantsModule,
        MailboxesModule,
        BatchesModule,
        AuthModule,
        HealthModule,
      ],
      providers: [
        { provide: APP_PIPE, useClass: ZodValidationPipe },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
      ],
    };
  }
}
