import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { TenantsModule } from '../tenants/tenants.module';
import { ApiKeyGuard } from './api-key.guard';
import { TenantRateLimitGuard } from './tenant-rate-limit.guard';

/** Installs API key authentication, then per-tenant rate limiting, on every route. */
@Module({
  imports: [TenantsModule],
  providers: [
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: TenantRateLimitGuard },
  ],
})
export class AuthModule {}
