import { Module } from '@nestjs/common';

import { TenantRegistry } from './tenant.registry';

@Module({
  providers: [TenantRegistry],
  exports: [TenantRegistry],
})
export class TenantsModule {}
