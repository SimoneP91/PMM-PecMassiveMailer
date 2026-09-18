import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { AppError } from '../../common/errors/app-error';
import { CLOCK, type Clock } from '../../common/time/clock';
import type { TenantId } from '../../common/types/branded';
import { TenantRegistry } from '../tenants/tenant.registry';

interface Window {
  startedAt: number;
  count: number;
}

const WINDOW_MS = 60_000;

/**
 * requestsPerMinute per tenant, fixed window, counted in this process.
 * With several API replicas the effective limit is N times the configured
 * one, which is fine for what this protects against: a client stuck in a
 * retry loop, not a distributed attack. Runs after ApiKeyGuard, so a public
 * route or a rejected key never reaches it.
 */
@Injectable()
export class TenantRateLimitGuard implements CanActivate {
  private readonly windows = new Map<TenantId, Window>();

  public constructor(
    private readonly tenants: TenantRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const tenantId = request.tenantContext?.tenantId;
    if (tenantId === undefined) {
      return true;
    }
    const limit = this.tenants.get(tenantId)?.limits.requestsPerMinute;
    if (limit === undefined) {
      return true;
    }

    const now = this.clock.now().getTime();
    let window = this.windows.get(tenantId);
    if (window === undefined || now - window.startedAt >= WINDOW_MS) {
      window = { startedAt: now, count: 0 };
      this.windows.set(tenantId, window);
    }
    window.count += 1;
    if (window.count > limit) {
      const retryAfter = Math.max(1, Math.ceil((window.startedAt + WINDOW_MS - now) / 1000));
      throw AppError.tooManyRequests(
        `more than ${String(limit)} requests per minute for this tenant`,
        retryAfter,
      );
    }

    return true;
  }
}
