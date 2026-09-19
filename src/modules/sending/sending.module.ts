import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AttachmentsModule } from '../attachments/attachments.module';
import { BatchLifecycleModule } from '../batches/batch-lifecycle.module';
import { BATCH_MODEL, batchSchema } from '../batches/schemas/batch.schema';
import { MESSAGE_MODEL, messageSchema } from '../batches/schemas/message.schema';
import { MailboxesModule } from '../mailboxes/mailboxes.module';
import { ImapflowSentArchiverFactory, SENT_ARCHIVER_FACTORY } from './imap/sent-archiver';
import { MailboxLeaseService } from './mailbox-lease.service';
import { MailboxPacer } from './mailbox-pacer';
import { MessageQueueRepository } from './message-queue.repository';
import { EmlBuilder } from './mime/eml-builder';
import { MAILBOX_COUNTER_MODEL, mailboxCounterSchema } from './schemas/mailbox-counter.schema';
import { MAILBOX_LEASE_MODEL, mailboxLeaseSchema } from './schemas/mailbox-lease.schema';
import { SLEEPER, SystemSleeper } from './sleeper';
import { NodemailerSmtpClientFactory, SMTP_CLIENT_FACTORY } from './smtp/smtp-client';
import { StuckRecovery } from './stuck-recovery';

/** Everything the worker and the admin commands need to send and to look after what was sent. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MESSAGE_MODEL, schema: messageSchema },
      { name: BATCH_MODEL, schema: batchSchema },
      { name: MAILBOX_LEASE_MODEL, schema: mailboxLeaseSchema },
      { name: MAILBOX_COUNTER_MODEL, schema: mailboxCounterSchema },
    ]),
    MailboxesModule,
    AttachmentsModule,
    BatchLifecycleModule,
  ],
  providers: [
    MessageQueueRepository,
    MailboxLeaseService,
    MailboxPacer,
    EmlBuilder,
    StuckRecovery,
    { provide: SLEEPER, useClass: SystemSleeper },
    { provide: SMTP_CLIENT_FACTORY, useClass: NodemailerSmtpClientFactory },
    { provide: SENT_ARCHIVER_FACTORY, useClass: ImapflowSentArchiverFactory },
  ],
  exports: [
    MessageQueueRepository,
    MailboxLeaseService,
    MailboxPacer,
    EmlBuilder,
    StuckRecovery,
    SLEEPER,
    SMTP_CLIENT_FACTORY,
    SENT_ARCHIVER_FACTORY,
  ],
})
export class SendingModule {}
