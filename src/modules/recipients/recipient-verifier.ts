import { promises as dns } from 'node:dns';

import { Inject, Injectable } from '@nestjs/common';

import { CLOCK, type Clock } from '../../common/time/clock';
import { PECMAILER_CONFIG } from '../../config/config.module';
import type { ResolvedConfig } from '../../config/config.loader';
import {
  DEFAULT_NON_PEC_DOMAINS,
  DEFAULT_NON_PEC_MX_SUFFIXES,
  DEFAULT_PEC_DOMAINS,
  DEFAULT_PEC_MX_SUFFIXES,
  domainMatches,
} from './pec-providers';

export type RecipientVerdict = 'PEC' | 'NOT_PEC' | 'UNDETERMINED';

export interface RecipientVerification {
  readonly verdict: RecipientVerdict;
  readonly detail: string;
}

export interface MxRecord {
  readonly exchange: string;
  readonly priority: number;
}

/** DNS behind an interface: tests answer by hand instead of reaching the network. */
export interface MxResolver {
  resolveMx(domain: string): Promise<readonly MxRecord[]>;
}

export const MX_RESOLVER = Symbol('MX_RESOLVER');

export class SystemMxResolver implements MxResolver {
  private readonly resolver = new dns.Resolver({ timeout: 3_000, tries: 2 });

  public resolveMx(domain: string): Promise<readonly MxRecord[]> {
    return this.resolver.resolveMx(domain);
  }
}

const CACHE_TTL_MS: Readonly<Record<RecipientVerdict, number>> = {
  PEC: 24 * 60 * 60 * 1000,
  NOT_PEC: 60 * 60 * 1000,
  UNDETERMINED: 5 * 60 * 1000,
};

interface CacheEntry {
  readonly result: RecipientVerification;
  readonly expiresAt: number;
}

/**
 * Classifies the domain of an address. Results are cached per domain: a
 * batch of a thousand rows usually spans a few dozen domains.
 */
@Injectable()
export class RecipientVerifier {
  private readonly pecDomains: readonly string[];
  private readonly pecMxSuffixes: readonly string[];
  private readonly nonPecDomains: readonly string[];
  private readonly nonPecMxSuffixes: readonly string[];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<RecipientVerification>>();
  public constructor(
    @Inject(PECMAILER_CONFIG) config: ResolvedConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(MX_RESOLVER) private readonly resolver: MxResolver,
  ) {
    this.pecDomains = [...DEFAULT_PEC_DOMAINS, ...config.recipients.pecDomains];
    this.pecMxSuffixes = [...DEFAULT_PEC_MX_SUFFIXES, ...config.recipients.pecMxSuffixes];
    this.nonPecDomains = [...DEFAULT_NON_PEC_DOMAINS, ...config.recipients.nonPecDomains];
    this.nonPecMxSuffixes = [...DEFAULT_NON_PEC_MX_SUFFIXES, ...config.recipients.nonPecMxSuffixes];
  }

  public async verify(address: string): Promise<RecipientVerification> {
    const at = address.lastIndexOf('@');
    const domain = address.slice(at + 1).toLowerCase();

    if (domainMatches(domain, this.pecDomains)) {
      return { verdict: 'PEC', detail: `${domain} is a PEC provider domain` };
    }
    if (domainMatches(domain, this.nonPecDomains)) {
      return { verdict: 'NOT_PEC', detail: `${domain} is an ordinary mail service, not PEC` };
    }

    const now = this.clock.now().getTime();
    const cached = this.cache.get(domain);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.result;
    }

    let pending = this.inFlight.get(domain);
    if (pending === undefined) {
      pending = this.classifyByMx(domain).then((result) => {
        this.cache.set(domain, {
          result,
          expiresAt: this.clock.now().getTime() + CACHE_TTL_MS[result.verdict],
        });
        this.inFlight.delete(domain);

        return result;
      });
      this.inFlight.set(domain, pending);
    }

    return pending;
  }

  private async classifyByMx(domain: string): Promise<RecipientVerification> {
    let records: readonly MxRecord[];
    try {
      records = await this.resolver.resolveMx(domain);
    } catch (error: unknown) {
      const code = (error as { code?: unknown }).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') {
        return { verdict: 'NOT_PEC', detail: `${domain} has no mail exchanger` };
      }

      return {
        verdict: 'UNDETERMINED',
        detail: `DNS lookup for ${domain} failed (${typeof code === 'string' ? code : 'error'})`,
      };
    }

    const exchanges = records.map((record) => record.exchange.toLowerCase().replace(/\.$/, ''));
    if (exchanges.length === 0) {
      return { verdict: 'NOT_PEC', detail: `${domain} has no mail exchanger` };
    }
    if (exchanges.some((exchange) => domainMatches(exchange, this.pecMxSuffixes))) {
      return { verdict: 'PEC', detail: `${domain} is served by an accredited PEC provider` };
    }
    if (exchanges.every((exchange) => domainMatches(exchange, this.nonPecMxSuffixes))) {
      return {
        verdict: 'NOT_PEC',
        detail: `${domain} is served by an ordinary mail service (${exchanges[0] ?? ''})`,
      };
    }

    return {
      verdict: 'UNDETERMINED',
      detail: `${domain} is served by an unknown mail exchanger (${exchanges[0] ?? ''})`,
    };
  }
}
