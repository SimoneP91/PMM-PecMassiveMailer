import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { EventsModule } from '../events/events.module';
import { BatchLifecycle } from './batch-lifecycle';
import { BATCH_MODEL, batchSchema } from './schemas/batch.schema';
import { MESSAGE_MODEL, messageSchema } from './schemas/message.schema';

/** Shared by the API (cancel), the worker (sending, receipts, settlement) and nothing else. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MESSAGE_MODEL, schema: messageSchema },
      { name: BATCH_MODEL, schema: batchSchema },
    ]),
    EventsModule,
  ],
  providers: [BatchLifecycle],
  exports: [BatchLifecycle],
})
export class BatchLifecycleModule {}
