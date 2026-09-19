import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { buildLoggerParams } from '../common/logging/logger.options';
import type { ResolvedConfig } from '../config/config.loader';
import { ConfigModule } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { DatabaseModule } from '../database/database.module';
import { MailboxesModule } from '../modules/mailboxes/mailboxes.module';
import { SendingModule } from '../modules/sending/sending.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';
import { TenantsModule } from '../modules/tenants/tenants.module';

/**
 * Context for the admin commands that touch the database or the providers.
 */
@Module({})
export class CliModule {
  public static forRoot(env: Env, config: ResolvedConfig): DynamicModule {
    return {
      module: CliModule,
      imports: [
        ConfigModule.forRoot(env, config),
        // Warnings only, so the command's own output stays readable. Never force
        // pretty printing: pino-pretty is a dev dependency, absent from the image.
        LoggerModule.forRoot(buildLoggerParams({ ...env, LOG_LEVEL: 'warn' })),
        DatabaseModule,
        TenantsModule,
        MailboxesModule,
        SendingModule,
        WebhooksModule,
      ],
    };
  }
}
