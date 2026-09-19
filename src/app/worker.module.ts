import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { buildLoggerParams } from '../common/logging/logger.options';
import type { ResolvedConfig } from '../config/config.loader';
import { ConfigModule } from '../config/config.module';
import type { Env } from '../config/env.schema';
import { DatabaseModule } from '../database/database.module';
import { MailboxesModule } from '../modules/mailboxes/mailboxes.module';
import { ReceiptsModule } from '../modules/receipts/receipts.module';
import { SendingModule } from '../modules/sending/sending.module';
import { TenantsModule } from '../modules/tenants/tenants.module';
import { WebhooksModule } from '../modules/webhooks/webhooks.module';
import { WorkerRunner } from './worker-runner';

@Module({})
export class WorkerModule {
  public static forRoot(env: Env, config: ResolvedConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        ConfigModule.forRoot(env, config),
        LoggerModule.forRoot(buildLoggerParams(env)),
        DatabaseModule,
        TenantsModule,
        MailboxesModule,
        SendingModule,
        ReceiptsModule,
        WebhooksModule,
      ],
      providers: [WorkerRunner],
      exports: [WorkerRunner],
    };
  }
}
