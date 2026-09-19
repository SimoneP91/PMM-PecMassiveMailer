import { Module } from '@nestjs/common';

import { EventsModule } from '../events/events.module';
import { SendingModule } from '../sending/sending.module';
import { TenantsModule } from '../tenants/tenants.module';
import { WebhookDispatcher } from './webhook-dispatcher';
import { HttpsWebhookTransport, WEBHOOK_TRANSPORT } from './webhook-transport';

@Module({
  imports: [EventsModule, TenantsModule, SendingModule],
  providers: [
    WebhookDispatcher,
    { provide: WEBHOOK_TRANSPORT, useFactory: () => new HttpsWebhookTransport() },
  ],
  exports: [WebhookDispatcher, WEBHOOK_TRANSPORT],
})
export class WebhooksModule {}
