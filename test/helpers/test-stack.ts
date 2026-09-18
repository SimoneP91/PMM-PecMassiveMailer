import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { MongoClient } from 'mongodb';
import { inject } from 'vitest';

import { ApiModule } from '../../src/app/api.module';
import { registerMultipart } from '../../src/app/multipart';
import { setupSwagger } from '../../src/app/swagger';
import { requestIdFrom } from '../../src/common/http/request-id';
import { generateApiKey } from '../../src/common/security/hash';
import { resolveConfig, type ResolvedConfig } from '../../src/config/config.loader';
import { parseEnv } from '../../src/config/env.schema';
import { pecmailerConfigSchema } from '../../src/config/pecmailer-config.schema';
import { MX_RESOLVER, type MxRecord, type MxResolver } from '../../src/modules/recipients/recipient-verifier';

/**
 * A complete API stack for HTTP tests: real Nest wiring, real Mongoose
 * against the in-memory replica set started by test/e2e/global-setup.ts
 * (transactions work; each stack gets its own database), a temporary
 * storage directory and a DNS resolver answered by the test.
 */
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

function withDatabase(uri: string, dbName: string): string {
  const url = new URL(uri);
  url.pathname = `/${dbName}`;

  return url.toString();
}

export interface TestTenant {
  readonly id: string;
  readonly key: string;
}

export interface TestStack {
  readonly app: NestFastifyApplication;
  readonly config: ResolvedConfig;
  readonly mx: FakeMxResolver;
  readonly storageDir: string;
  readonly mongoUri: string;
  readonly serfin: TestTenant;
  readonly iqera: TestTenant;
  stop(): Promise<void>;
}

export interface TestStackOptions {
  readonly requestsPerMinute?: number;
  readonly maxMessagesPerBatch?: number;
  readonly maxRequestBytes?: number;
  readonly maxMessageBytes?: number;
}

export async function startTestStack(options: TestStackOptions = {}): Promise<TestStack> {
  const serfinKey = generateApiKey();
  const iqeraKey = generateApiKey();
  const dbName = `pecmailer_${randomBytes(4).toString('hex')}`;
  const mongoUri = withDatabase(inject('mongoUri'), dbName);
  const storageDir = await mkdtemp(join(tmpdir(), 'pecmailer-test-'));

  const env = parseEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    MONGODB_URI: mongoUri,
    STORAGE_DIR: storageDir,
  });

  const config = resolveConfig(
    pecmailerConfigSchema.parse({
      tenants: [
        {
          id: 't_serfin',
          externalId: '195',
          name: 'Serfin',
          apiKeys: [{ id: 'k1', sha256: serfinKey.sha256 }],
          limits: {
            requestsPerMinute: options.requestsPerMinute ?? 1000,
            maxMessagesPerBatch: options.maxMessagesPerBatch ?? 2500,
            maxRequestBytes: options.maxRequestBytes ?? 50 * 1024 * 1024,
          },
        },
        { id: 't_iqera', externalId: 'a1', name: 'iQera', apiKeys: [{ id: 'k2', sha256: iqeraKey.sha256 }] },
      ],
      mailboxes: [
        {
          code: 'serfin-aruba',
          tenant: 't_serfin',
          provider: 'aruba',
          from: { address: 'solleciti@pec.serfin.example', name: 'Serfin' },
          smtp: { username: 'solleciti@pec.serfin.example' },
          limits: { maxMessageBytes: options.maxMessageBytes ?? 30 * 1024 * 1024 },
        },
        {
          code: 'iqera-legalmail',
          tenant: 't_iqera',
          provider: 'legalmail',
          from: { address: 'notifiche@iqera.example', name: 'iQera' },
          smtp: { username: 'notifiche@iqera.example' },
        },
      ],
      recipients: { pecDomains: ['pec.custom.example'] },
    }),
    env,
    { MAILBOX_SERFIN_ARUBA_PASSWORD: 'pw', MAILBOX_IQERA_LEGALMAIL_PASSWORD: 'pw' },
  );

  const mx = new FakeMxResolver();
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule.forRoot(env, config)] })
    .overrideProvider(MX_RESOLVER)
    .useValue(mx)
    .compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ genReqId: requestIdFrom }),
    {
      logger: false,
    },
  );
  await registerMultipart(app, config);
  setupSwagger(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    config,
    mx,
    storageDir,
    mongoUri,
    serfin: { id: 't_serfin', key: serfinKey.key },
    iqera: { id: 't_iqera', key: iqeraKey.key },
    async stop(): Promise<void> {
      await app.close();
      const client = await MongoClient.connect(mongoUri);
      await client.db(dbName).dropDatabase();
      await client.close();
      await rm(storageDir, { recursive: true, force: true });
    },
  };
}
