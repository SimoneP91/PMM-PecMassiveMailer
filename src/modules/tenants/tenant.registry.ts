import { Inject, Injectable } from '@nestjs/common';

import { sha256Hex, timingSafeEqualHex } from '../../common/security/hash';
import type { ApiKeyId, TenantId } from '../../common/types/branded';
import { PECMAILER_CONFIG } from '../../config/config.module';
import type { ResolvedConfig, ResolvedTenant } from '../../config/config.loader';

export interface AuthenticatedKey {
  readonly tenant: ResolvedTenant;
  readonly apiKeyId: ApiKeyId;
}

interface KeyIndexEntry {
  readonly sha256: string;
  readonly tenant: ResolvedTenant;
  readonly apiKeyId: ApiKeyId;
}

/** Read-only view of the tenants declared in the configuration file. */
@Injectable()
export class TenantRegistry {
  private readonly byId: ReadonlyMap<TenantId, ResolvedTenant>;
  private readonly keyIndex: readonly KeyIndexEntry[];

  public constructor(@Inject(PECMAILER_CONFIG) config: ResolvedConfig) {
    this.byId = new Map(config.tenants.map((tenant) => [tenant.id, tenant]));
    this.keyIndex = config.tenants.flatMap((tenant) =>
      tenant.apiKeys.map((key) => ({ sha256: key.sha256, tenant, apiKeyId: key.id })),
    );
  }

  public all(): readonly ResolvedTenant[] {
    return [...this.byId.values()];
  }

  public get(id: TenantId): ResolvedTenant | undefined {
    return this.byId.get(id);
  }

  /**
   * Every declared hash is compared, in constant time each, and the loop never
   * exits early: with a handful of keys the cost is nil, and the timing of the
   * answer says nothing about which key came close.
   */
  public authenticate(rawKey: string): AuthenticatedKey | undefined {
    const presented = sha256Hex(rawKey);
    let match: KeyIndexEntry | undefined;
    for (const entry of this.keyIndex) {
      if (timingSafeEqualHex(entry.sha256, presented)) {
        match = entry;
      }
    }

    return match === undefined ? undefined : { tenant: match.tenant, apiKeyId: match.apiKeyId };
  }
}
