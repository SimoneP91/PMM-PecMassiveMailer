import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';

import { AppError } from '../../common/errors/app-error';
import { API_KEY_PREFIX } from '../../common/security/hash';
import { TenantRegistry } from '../tenants/tenant.registry';
import { IS_PUBLIC } from './public.decorator';

const BEARER = /^Bearer\s+(\S+)$/i;

/**
 * Authorization: Bearer <api key>  ->  request.tenantContext
 *
 * Registered globally: a route is protected unless it says @Public(). The
 * failure is always the same 401, whether the header is missing, malformed or
 * carries an unknown key - which one it was is not the client's business.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  public constructor(
    private readonly reflector: Reflector,
    private readonly tenants: TenantRegistry,
    private readonly logger: PinoLogger,
  ) {}

  public canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const rawKey = extractBearerToken(request.headers.authorization);
    if (rawKey?.startsWith(API_KEY_PREFIX) !== true) {
      throw AppError.unauthorized('A valid API key is required in the Authorization header (Bearer)');
    }

    const authenticated = this.tenants.authenticate(rawKey);
    if (authenticated === undefined) {
      throw AppError.unauthorized('Unknown API key');
    }

    request.tenantContext = {
      tenantId: authenticated.tenant.id,
      tenantName: authenticated.tenant.name,
      apiKeyId: authenticated.apiKeyId,
    };
    // From here on every log line of this request, the completion line
    // included, says which tenant it was for.
    this.logger.assign({ tenantId: authenticated.tenant.id, apiKeyId: authenticated.apiKeyId });

    return true;
  }
}

export function extractBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = BEARER.exec(header);

  return match?.[1];
}
