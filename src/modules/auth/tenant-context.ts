import type { ApiKeyId, TenantId } from '../../common/types/branded';

/**
 * Who is calling, as established by the API key guard. It is the ONLY source
 * of the tenant for a request: nothing in a payload, a query string or a path
 * can name a tenant.
 */
export interface TenantContext {
  readonly tenantId: TenantId;
  readonly tenantName: string;
  readonly apiKeyId: ApiKeyId;
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantContext?: TenantContext;
  }
}
