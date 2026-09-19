import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PinoLogger } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/common/errors/app-error';
import { generateApiKey } from '../../../src/common/security/hash';
import { asApiKeyId, asTenantId } from '../../../src/common/types/branded';
import type { ResolvedConfig } from '../../../src/config/config.loader';
import { ApiKeyGuard, extractBearerToken } from '../../../src/modules/auth/api-key.guard';
import { TenantRegistry } from '../../../src/modules/tenants/tenant.registry';

const serfinKey = generateApiKey();
const otherKey = generateApiKey();

const config: ResolvedConfig = {
  tenants: [
    {
      id: asTenantId('t_serfin'),
      externalId: '195',
      name: 'Serfin',
      apiKeys: [{ id: asApiKeyId('key_serfin'), label: undefined, sha256: serfinKey.sha256 }],
      webhook: null,
      limits: { maxMessagesPerBatch: 2500, maxRequestBytes: 1, requestsPerMinute: 1 },
    },
    {
      id: asTenantId('t_other'),
      externalId: 'x',
      name: 'Other',
      apiKeys: [{ id: asApiKeyId('key_other'), label: undefined, sha256: otherKey.sha256 }],
      webhook: null,
      limits: { maxMessagesPerBatch: 2500, maxRequestBytes: 1, requestsPerMinute: 1 },
    },
  ],
  mailboxes: [],
  recipients: { pecDomains: [], pecMxSuffixes: [], nonPecDomains: [], nonPecMxSuffixes: [] },
  sending: {
    maxAttempts: 5,
    retryBackoffSeconds: [60],
    staleSendingSeconds: 600,
    pollIntervalMs: 5000,
    leaseTtlSeconds: 60,
    suspendedRecheckSeconds: 60,
  },
};

interface FakeRequest {
  headers: Record<string, string | undefined>;
  tenantContext?: unknown;
}

function contextFor(request: FakeRequest, isPublic = false): ExecutionContext {
  const handler = (): void => undefined;
  if (isPublic) {
    Reflect.defineMetadata('pecmailer:isPublic', true, handler);
  }

  return {
    getHandler: () => handler,
    getClass: () => handler,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const assigned: Record<string, unknown>[] = [];
const loggerStub = {
  assign: (fields: Record<string, unknown>): void => void assigned.push(fields),
} as unknown as PinoLogger;
const guard = new ApiKeyGuard(new Reflector(), new TenantRegistry(config), loggerStub);

describe('ApiKeyGuard', () => {
  it('authenticates a known key and stores the tenant on the request', () => {
    const request: FakeRequest = { headers: { authorization: `Bearer ${serfinKey.key}` } };

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.tenantContext).toEqual({
      tenantId: 't_serfin',
      tenantName: 'Serfin',
      apiKeyId: 'key_serfin',
    });
    expect(assigned.at(-1)).toEqual({ tenantId: 't_serfin', apiKeyId: 'key_serfin' });
  });

  it('resolves the second tenant for the second key', () => {
    const request: FakeRequest = { headers: { authorization: `bearer ${otherKey.key}` } };

    guard.canActivate(contextFor(request));
    expect(request.tenantContext).toMatchObject({ tenantId: 't_other' });
  });

  it.each([
    ['missing header', {}],
    ['wrong scheme', { authorization: `Basic ${serfinKey.key}` }],
    ['no prefix', { authorization: 'Bearer not-a-key' }],
    ['unknown key', { authorization: `Bearer ${generateApiKey().key}` }],
    ['truncated key', { authorization: `Bearer ${serfinKey.key.slice(0, -1)}` }],
  ])('rejects %s with 401 and no tenant', (_name, headers) => {
    const request: FakeRequest = { headers };

    expect(() => guard.canActivate(contextFor(request))).toThrow(AppError);
    try {
      guard.canActivate(contextFor(request));
    } catch (error: unknown) {
      expect((error as AppError).status).toBe(401);
    }
    expect(request.tenantContext).toBeUndefined();
  });

  it('lets a @Public() route through without a key', () => {
    const request: FakeRequest = { headers: {} };

    expect(guard.canActivate(contextFor(request, true))).toBe(true);
    expect(request.tenantContext).toBeUndefined();
  });
});

describe('extractBearerToken', () => {
  it('parses the scheme case-insensitively and tolerates extra spaces', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('BEARER   abc')).toBe('abc');
    expect(extractBearerToken('Token abc')).toBeUndefined();
    expect(extractBearerToken(undefined)).toBeUndefined();
  });
});
