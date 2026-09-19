import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { TenantsModule } from '../tenants/tenants.module';
import { EventOutbox } from './event-outbox';
import { WEBHOOK_EVENT_MODEL, webhookEventSchema } from './webhook-event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: WEBHOOK_EVENT_MODEL, schema: webhookEventSchema }]),
    TenantsModule,
  ],
  providers: [EventOutbox],
  exports: [EventOutbox, MongooseModule],
})
export class EventsModule {}
