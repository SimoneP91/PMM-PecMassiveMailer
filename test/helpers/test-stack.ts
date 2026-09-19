import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';
import { MongoClient } from 'mongodb';
import { inject } from 'vitest';

import { ApiModule } from '../../src/app/api.module';
import { registerMultipart } from '../../src/app/multipart';
import { setupSwagger } from '../../src/app/swagger';
import { WorkerModule } from '../../src/app/worker.module';
import { WorkerRunner } from '../../src/app/worker-runner';
import { requestIdFrom } from '../../src/common/http/request-id';
import { generateApiKey } from '../../src/common/security/hash';
import { resolveConfig, type ResolvedConfig } from '../../src/config/config.loader';
import { parseEnv, type Env } from '../../src/config/env.schema';
import { pecmailerConfigSchema, type SendingConfig } from '../../src/config/pecmailer-config.schema';
import { MX_RESOLVER } from '../../src/modules/recipients/recipient-verifier';
import { SENT_ARCHIVER_FACTORY } from '../../src/modules/sending/imap/sent-archiver';
import { FakeSentArchiverFactory } from './fake-archiver';
import { FakeMxResolver } from './fake-mx';

/**
 * A complete API stack for HTTP tests: real Nest wiring, real Mongoose
 * against the in-memory replica set started by test/e2e/global-setup.ts
 * (transactions work; each stack gets its own database), a temporary
 * storage directory and a DNS resolver answered by the test.
 */
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
  readonly env: Env;
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
  readonly perMinute?: number;
  /** Points every mailbox at this SMTP server (the in-process fake). */
  readonly smtp?: { readonly host: string; readonly port: number };
  readonly smtpTimeoutSeconds?: number;
  readonly sending?: Partial<SendingConfig>;
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
    WORKER_HEALTH_PORT: '0',
    ...(options.smtp === undefined
      ? {}
      : {
          PECMAILER_SMTP_OVERRIDE_HOST: options.smtp.host,
          PECMAILER_SMTP_OVERRIDE_PORT: String(options.smtp.port),
          PECMAILER_SMTP_OVERRIDE_SECURITY: 'none',
        }),
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
          smtp: {
            username: 'solleciti@pec.serfin.example',
            timeoutSeconds: options.smtpTimeoutSeconds ?? 30,
          },
          limits: {
            perMinute: options.perMinute ?? 60,
            maxMessageBytes: options.maxMessageBytes ?? 30 * 1024 * 1024,
          },
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
      sending: options.sending ?? {},
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
    env,
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

export interface TestWorker {
  readonly module: TestingModule;
  readonly runner: WorkerRunner;
  readonly archiver: FakeSentArchiverFactory;
  stop(): Promise<void>;
}

/** The worker process, in-process, against the same database and storage as the API stack. */
export async function startTestWorker(stack: TestStack): Promise<TestWorker> {
  const archiver = new FakeSentArchiverFactory();
  const module = await Test.createTestingModule({ imports: [WorkerModule.forRoot(stack.env, stack.config)] })
    .overrideProvider(SENT_ARCHIVER_FACTORY)
    .useValue(archiver)
    .compile();
  await module.init();

  return {
    module,
    runner: module.get(WorkerRunner),
    archiver,
    async stop(): Promise<void> {
      await module.close();
    },
  };
}

/** Polls until the predicate holds or the timeout passes; returns the last value either way. */
export async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!predicate(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await read();
  }

  return value;
}
