import { Module } from '@nestjs/common';

import { MX_RESOLVER, RecipientVerifier, SystemMxResolver } from './recipient-verifier';

@Module({
  providers: [{ provide: MX_RESOLVER, useClass: SystemMxResolver }, RecipientVerifier],
  exports: [RecipientVerifier],
})
export class RecipientsModule {}
