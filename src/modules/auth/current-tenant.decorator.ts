import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { TenantContext } from './tenant-context';

/**
 * Hands a controller the tenant established by ApiKeyGuard. Missing context
 * on a non-public route is a programming error, not a client error, and is
 * thrown as such.
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.tenantContext === undefined) {
      throw new Error('CurrentTenant used on a route that is not protected by ApiKeyGuard');
    }

    return request.tenantContext;
  },
);
