import { Module } from '@nestjs/common';

import { AttachmentStore } from './attachment-store';

@Module({
  providers: [AttachmentStore],
  exports: [AttachmentStore],
})
export class AttachmentsModule {}
