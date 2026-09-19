import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AttachmentsModule } from '../attachments/attachments.module';
import { BatchLifecycleModule } from '../batches/batch-lifecycle.module';
import { BATCH_MODEL, batchSchema } from '../batches/schemas/batch.schema';
import { MESSAGE_MODEL, messageSchema } from '../batches/schemas/message.schema';
import { MailboxesModule } from '../mailboxes/mailboxes.module';
import { SendingModule } from '../sending/sending.module';
import { ImapCursorStore } from './imap-cursor.store';
import { ReceiptProcessor } from './receipt-processor';
import { ImapflowReceiptSourceFactory, RECEIPT_SOURCE_FACTORY } from './receipt-source';
import { IMAP_CURSOR_MODEL, imapCursorSchema } from './schemas/imap-cursor.schema';
import { RECEIPT_MODEL, receiptSchema } from './schemas/receipt.schema';
import { SettlementJob } from './settlement-job';

/** The worker side of receipts: reading, matching, settling. */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MESSAGE_MODEL, schema: messageSchema },
      { name: BATCH_MODEL, schema: batchSchema },
      { name: RECEIPT_MODEL, schema: receiptSchema },
      { name: IMAP_CURSOR_MODEL, schema: imapCursorSchema },
    ]),
    AttachmentsModule,
    BatchLifecycleModule,
    MailboxesModule,
    SendingModule,
  ],
  providers: [
    ReceiptProcessor,
    ImapCursorStore,
    SettlementJob,
    { provide: RECEIPT_SOURCE_FACTORY, useClass: ImapflowReceiptSourceFactory },
  ],
  exports: [ReceiptProcessor, ImapCursorStore, SettlementJob, RECEIPT_SOURCE_FACTORY],
})
export class ReceiptsModule {}
