import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AttachmentsModule } from '../attachments/attachments.module';
import { MailboxesModule } from '../mailboxes/mailboxes.module';
import { RecipientsModule } from '../recipients/recipients.module';
import { TenantsModule } from '../tenants/tenants.module';
import { BatchIntakeService } from './batch-intake.service';
import { BatchRepository } from './batch.repository';
import { BatchesController } from './batches.controller';
import { IdempotencyService } from './idempotency.service';
import { BATCH_MODEL, batchSchema } from './schemas/batch.schema';
import { IDEMPOTENCY_MODEL, idempotencySchema } from './schemas/idempotency.schema';
import { MESSAGE_MODEL, messageSchema } from './schemas/message.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: BATCH_MODEL, schema: batchSchema },
      { name: MESSAGE_MODEL, schema: messageSchema },
      { name: IDEMPOTENCY_MODEL, schema: idempotencySchema },
    ]),
    TenantsModule,
    MailboxesModule,
    RecipientsModule,
    AttachmentsModule,
  ],
  controllers: [BatchesController],
  providers: [BatchIntakeService, BatchRepository, IdempotencyService],
  exports: [BatchRepository],
})
export class BatchesModule {}
