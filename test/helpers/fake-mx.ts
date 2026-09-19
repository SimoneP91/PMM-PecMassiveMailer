import type { MxRecord, MxResolver } from '../../src/modules/recipients/recipient-verifier';

/** A DNS answered by the test: MX records per domain, or an error code. */
export class FakeMxResolver implements MxResolver {
  public readonly answers = new Map<string, readonly MxRecord[] | string>();
  public readonly lookups: string[] = [];

  public mx(domain: string, ...exchanges: string[]): this {
    this.answers.set(
      domain,
      exchanges.map((exchange, i) => ({ exchange, priority: 10 * (i + 1) })),
    );

    return this;
  }

  public fail(domain: string, code: string): this {
    this.answers.set(domain, code);

    return this;
  }

  public resolveMx(domain: string): Promise<readonly MxRecord[]> {
    this.lookups.push(domain);
    const answer = this.answers.get(domain);
    if (answer === undefined) {
      return Promise.reject(Object.assign(new Error(`queryMx ENOTFOUND ${domain}`), { code: 'ENOTFOUND' }));
    }
    if (typeof answer === 'string') {
      return Promise.reject(Object.assign(new Error(`queryMx ${answer} ${domain}`), { code: answer }));
    }

    return Promise.resolve(answer);
  }
}
