import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AttachmentsModule } from '../attachments/attachments.module';
import { BatchesModule } from '../batches/batches.module';
import { RECEIPT_MODEL, receiptSchema } from '../receipts/schemas/receipt.schema';
import { MessageQueryService } from './message-query.service';
import { MessagesController } from './messages.controller';

@Module({
  imports: [
    BatchesModule,
    AttachmentsModule,
    MongooseModule.forFeature([{ name: RECEIPT_MODEL, schema: receiptSchema }]),
  ],
  controllers: [MessagesController],
  providers: [MessageQueryService],
})
export class MessagesModule {}
