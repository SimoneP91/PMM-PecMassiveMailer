import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { EventsModule } from '../events/events.module';
import { MAILBOX_STATE_MODEL, mailboxStateSchema } from './mailbox-state.schema';
import { MailboxStateStore } from './mailbox-state.store';
import { MailboxRegistry } from './mailbox.registry';
import { MailboxesController } from './mailboxes.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: MAILBOX_STATE_MODEL, schema: mailboxStateSchema }]),
    EventsModule,
  ],
  controllers: [MailboxesController],
  providers: [MailboxRegistry, MailboxStateStore],
  exports: [MailboxRegistry, MailboxStateStore],
})
export class MailboxesModule {}
