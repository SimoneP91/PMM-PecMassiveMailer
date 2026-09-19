import { Module } from '@nestjs/common';
import { MongooseModule, type MongooseModuleFactoryOptions } from '@nestjs/mongoose';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * One connection for the process.
 *
 * writeConcern majority + journal: a message recorded as SENT must survive a
 * primary failover. A write acknowledged by a primary that then dies before
 * replicating would come back as "still to send", and a PEC sent twice is a
 * second legal delivery. Durability is not a tuning knob here.
 */
@Module({
  imports: [
    MongooseModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env): MongooseModuleFactoryOptions => ({
        uri: env.MONGODB_URI,
        appName: 'pecmailer',
        serverSelectionTimeoutMS: 5_000,
        writeConcern: { w: 'majority', journal: true },
        readPreference: 'primary',
        // Indexes are declared on the schemas; in production they are built by
        // `db sync-indexes` (once per release), not by the first process that boots.
        autoIndex: env.NODE_ENV !== 'production',
        retryAttempts: 5,
        retryDelay: 2_000,
      }),
    }),
  ],
})
export class DatabaseModule {}
