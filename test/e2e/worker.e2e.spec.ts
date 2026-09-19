import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LightMyRequestResponse } from 'fastify';
import { MongoClient, type Collection, type Document } from 'mongodb';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { asMailboxCode, asMessageId } from '../../src/common/types/branded';
import { MailboxStateStore } from '../../src/modules/mailboxes/mailbox-state.store';
import { MailboxLeaseService } from '../../src/modules/sending/mailbox-lease.service';
import { MessageQueueRepository } from '../../src/modules/sending/message-queue.repository';
import { StuckRecovery } from '../../src/modules/sending/stuck-recovery';
import { FakeSmtpServer } from '../helpers/fake-smtp';
import { containing } from '../helpers/matchers';
import { multipart, PDF, PNG } from '../helpers/multipart';
import {
  startTestStack,
  startTestWorker,
  waitFor,
  type TestStack,
  type TestWorker,
} from '../helpers/test-stack';

/**
 * The sending loop against a real SMTP server running in the test process:
 * every outcome of the state machine, driven by what the server answers.
 */
let smtp: FakeSmtpServer;
let stack: TestStack;
let worker: TestWorker;
let db: MongoClient;

const messages = (): Collection => db.db().collection('messages');
const batches = (): Collection => db.db().collection('batches');

async function submit(
  rows: Record<string, unknown>[],
  withFiles = false,
): Promise<{ batchId: string; ids: Map<string, string> }> {
  const batch = {
    mailbox: 'serfin-aruba',
    template: {
      subject: 'Pratica {{n}}',
      html:
        '<html><body><p>Gentile {{name}},</p>' + (withFiles ? '<img src="cid:logo">' : '') + '</body></html>',
      ...(withFiles ? { inlineImages: [{ cid: 'logo', part: 'logo' }] } : {}),
    },
    messages: rows.map((row, i) => ({
      ref: `r-${String(i)}`,
      vars: { n: String(i), name: 'Mario' },
      ...(withFiles ? { attachments: [{ part: 'doc', filename: `sollecito-${String(i)}.pdf` }] } : {}),
      ...row,
    })),
  };
  const body = multipart(
    batch,
    withFiles
      ? [
          { name: 'doc', filename: 'sollecito.pdf', content: PDF },
          { name: 'logo', filename: 'logo.png', content: PNG },
        ]
      : [],
  );
  const response: LightMyRequestResponse = await stack.app.inject({
    method: 'POST',
    url: '/v1/batches',
    headers: {
      ...body.headers,
      authorization: `Bearer ${stack.serfin.key}`,
      'idempotency-key': randomUUID(),
    },
    payload: body.payload,
  });
  expect(response.statusCode, response.body).toBe(202);
  const json = response.json<{ batchId: string; messages: { ref: string; messageId: string }[] }>();

  return { batchId: json.batchId, ids: new Map(json.messages.map((m) => [m.ref, m.messageId])) };
}

async function messageById(id: string): Promise<Document | null> {
  return messages().findOne({ _id: id as never });
}

async function waitForStatus(id: string, status: string, timeoutMs = 10_000): Promise<Document> {
  const doc = await waitFor(
    () => messageById(id),
    (m) => m?.['status'] === status,
    timeoutMs,
  );
  expect(doc?.['status'], JSON.stringify(doc?.['lastError'])).toBe(status);

  return doc!;
}

beforeAll(async () => {
  smtp = new FakeSmtpServer();
  await smtp.start();
  stack = await startTestStack({
    smtp: { host: '127.0.0.1', port: smtp.port },
    smtpTimeoutSeconds: 5,
    perMinute: 0,
    sending: {
      pollIntervalMs: 100,
      retryBackoffSeconds: [1],
      maxAttempts: 2,
      leaseTtlSeconds: 10,
      staleSendingSeconds: 60,
      suspendedRecheckSeconds: 5,
    },
  });
  stack.mx.mx('pec.custom.example', 'mx.pec.aruba.it');
  db = await MongoClient.connect(stack.mongoUri);
  worker = await startTestWorker(stack);
});

afterEach(() => {
  smtp.behaviour = { kind: 'accept' };
  worker.archiver.failNext = false;
});

afterAll(async () => {
  await worker.stop();
  await db.close();
  await stack.stop();
  await smtp.stop();
});

describe('sending', () => {
  it('sends every PENDING message, archives the exact bytes and settles the batch', async () => {
    const { batchId, ids } = await submit(
      [{ to: 'a@pec.it' }, { to: 'b@pec.it', toName: 'B B' }, { to: 'c@pec.custom.example' }],
      true,
    );

    for (const id of ids.values()) {
      await waitForStatus(id, 'SENT');
    }

    expect(smtp.received.map((m) => m.to[0])).toEqual(
      expect.arrayContaining(['a@pec.it', 'b@pec.it', 'c@pec.custom.example']),
    );
    const first = smtp.received.find((m) => m.to[0] === 'b@pec.it');
    expect(first).toMatchObject({
      from: 'solleciti@pec.serfin.example',
      user: 'solleciti@pec.serfin.example',
    });
    expect(first?.raw).toContain(`Message-ID: <${ids.get('r-1') ?? ''}@pec.serfin.example>`);
    // nodemailer normalises header names (X-Pecmailer-Batch-Id); headers are case-insensitive anyway
    expect(first?.raw).toMatch(new RegExp(`^X-PecMailer-Batch-Id: ${batchId}$`, 'im'));
    expect(first?.raw).toMatch(/^To: "?B B"? <b@pec.it>$/m);
    expect(first?.raw).toContain('Content-Type: application/pdf');
    expect(first?.raw).toContain('Content-ID: <logo>');

    const doc = await messageById(ids.get('r-1') ?? '');
    expect(doc).toMatchObject({
      status: 'SENT',
      attempts: 1,
      messageIdHeader: `<${ids.get('r-1') ?? ''}@pec.serfin.example>`,
      smtpResponse: containing('250 2.0.0 Ok'),
      sentCopy: 'ARCHIVED',
    });
    expect(doc?.['sendingStartedAt']).toBeUndefined();
    expect(doc?.['workerId']).toBeUndefined();

    const eml = await readFile(join(stack.storageDir, doc?.['emlPath'] as string), 'utf8');
    expect(eml.replace(/\r\n/g, '\n')).toBe(first?.raw.replace(/\r\n/g, '\n'));
    expect(worker.archiver.appended.find((a) => a.eml === eml)).toBeDefined();

    const batch = await batches().findOne({ _id: batchId as never });
    expect(batch).toMatchObject({
      status: 'SENT',
      counts: { total: 3, pending: 0, sent: 3, failed: 0, stuck: 0 },
    });
    expect(batch?.['sentAt']).toBeInstanceOf(Date);
    expect(batch?.['sendingStartedAt']).toBeInstanceOf(Date);
  });

  it('records a failed Sent-folder copy without touching the message outcome', async () => {
    worker.archiver.failNext = true;
    const { ids } = await submit([{ to: 'copy@pec.it' }]);
    const id = ids.get('r-0') ?? '';

    const doc = await waitFor(
      () => messageById(id),
      (m) => m?.['status'] === 'SENT' && m['sentCopy'] !== 'PENDING',
    );
    expect(doc).toMatchObject({
      status: 'SENT',
      sentCopy: 'FAILED',
      sentCopyError: containing('IMAP APPEND failed'),
    });
  });

  it('fails a message the server refuses permanently (550) and counts it', async () => {
    smtp.behaviour = { kind: 'rejectRecipient', code: 550 };
    const { batchId, ids } = await submit([{ to: 'nobody@pec.it' }]);
    const id = ids.get('r-0') ?? '';

    const doc = await waitForStatus(id, 'FAILED');
    expect(doc['lastError']).toMatchObject({ code: 'SMTP_550', detail: containing('No such user') });
    expect(doc['attempts']).toBe(1);
    const batch = await batches().findOne({ _id: batchId as never });
    expect(batch).toMatchObject({ status: 'SENT', counts: { pending: 0, sent: 0, failed: 1 } });
  });

  it('retries a temporary refusal (450) and succeeds once the server recovers', async () => {
    smtp.behaviour = { kind: 'rejectRecipient', code: 450 };
    const { ids } = await submit([{ to: 'busy@pec.it' }]);
    const id = ids.get('r-0') ?? '';

    const scheduled = await waitForStatus(id, 'RETRY_SCHEDULED');
    expect(scheduled['lastError']).toMatchObject({ code: 'SMTP_450' });
    expect(scheduled['attempts']).toBe(1);
    expect((scheduled['nextAttemptAt'] as Date).getTime()).toBeGreaterThan(Date.now() - 100);

    smtp.behaviour = { kind: 'accept' };
    const sent = await waitForStatus(id, 'SENT');
    expect(sent['attempts']).toBe(2);
  });

  it('gives up after maxAttempts temporary refusals', async () => {
    smtp.behaviour = { kind: 'rejectRecipient', code: 450 };
    const { ids } = await submit([{ to: 'always-busy@pec.it' }]);
    const id = ids.get('r-0') ?? '';

    const doc = await waitForStatus(id, 'FAILED');
    expect(doc['attempts']).toBe(2);
    expect(doc['lastError']).toMatchObject({ code: 'SMTP_450_MAX_ATTEMPTS' });
  });

  it('marks STUCK when the connection dies after the server took the data, never resends, and lets an operator resolve it', async () => {
    smtp.behaviour = { kind: 'hangAfterData' };
    const { batchId, ids } = await submit([{ to: 'limbo@pec.it' }]);
    const id = ids.get('r-0') ?? '';

    const doc = await waitForStatus(id, 'STUCK', 15_000);
    expect(doc['lastError']).toMatchObject({ code: 'SMTP_NO_FINAL_REPLY' });
    expect(doc['stuckAt']).toBeInstanceOf(Date);
    let batch = await batches().findOne({ _id: batchId as never });
    expect(batch).toMatchObject({ status: 'SENDING', counts: { pending: 0, stuck: 1 } });

    smtp.behaviour = { kind: 'accept' };
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await messageById(id))?.['status']).toBe('STUCK');

    const queue = worker.module.get(MessageQueueRepository);
    expect(await queue.resolveStuck(asMessageId(id), 'sent', 'test', new Date())).toBe(true);
    expect(await queue.resolveStuck(asMessageId(id), 'sent', 'test', new Date())).toBe(false);
    batch = await batches().findOne({ _id: batchId as never });
    expect(batch).toMatchObject({ status: 'SENT', counts: { pending: 0, stuck: 0, sent: 1 } });
  });

  it('a STUCK message requeued by an operator is sent again with the same Message-ID', async () => {
    smtp.behaviour = { kind: 'hangAfterData' };
    const { ids } = await submit([{ to: 'again@pec.it' }]);
    const id = ids.get('r-0') ?? '';
    await waitForStatus(id, 'STUCK', 15_000);

    smtp.behaviour = { kind: 'accept' };
    const before = smtp.received.length;
    await worker.module
      .get(MessageQueueRepository)
      .resolveStuck(asMessageId(id), 'requeue', 'test', new Date());
    const sent = await waitForStatus(id, 'SENT');
    expect(sent['messageIdHeader']).toBe(`<${id}@pec.serfin.example>`);
    expect(smtp.received.length).toBe(before + 1);
    expect(smtp.received.at(-1)?.raw).toContain(`Message-ID: <${id}@pec.serfin.example>`);
  });

  it('suspends the mailbox when the login is refused, keeps the message PENDING, and resumes on reactivation', async () => {
    smtp.behaviour = { kind: 'refuseAuth' };
    const { ids } = await submit([{ to: 'later@pec.it' }]);
    const id = ids.get('r-0') ?? '';

    const states = worker.module.get(MailboxStateStore);
    const state = await waitFor(
      () => states.get(asMailboxCode('serfin-aruba')),
      (s) => s.status === 'SUSPENDED',
    );
    expect(state).toMatchObject({ status: 'SUSPENDED', reason: containing('login refused') });
    const doc = await waitForStatus(id, 'PENDING');
    expect(doc['attempts']).toBe(0);

    const list = await stack.app.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${stack.serfin.key}` },
    });
    expect(list.json<{ items: { status: string }[] }>().items[0]?.status).toBe('SUSPENDED');

    smtp.behaviour = { kind: 'accept' };
    await states.set(asMailboxCode('serfin-aruba'), 'ACTIVE', undefined, new Date());
    await waitForStatus(id, 'SENT', 15_000);
  });
});

describe('recovery and leases', () => {
  it('turns a message left SENDING by a dead worker into STUCK', async () => {
    await batches().insertOne({
      _id: 'b_stale00000000001' as never,
      tenantId: 't_serfin',
      apiKeyId: 'k1',
      mailbox: 'serfin-aruba',
      status: 'SENDING',
      template: { subject: 's', html: '<p>x</p>', inlineImages: [] },
      options: { atomic: false, unverifiedRecipients: 'reject' },
      parts: [],
      counts: { total: 1, pending: 1, sent: 0, delivered: 0, failed: 0, stuck: 0, cancelled: 0 },
      rejectedMessages: [],
      warnings: [],
      idempotencyKey: 'stale',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await messages().insertOne({
      _id: 'm_stale00000000001' as never,
      tenantId: 't_serfin',
      batchId: 'b_stale00000000001',
      mailbox: 'serfin-aruba',
      ref: 'stale',
      to: 'x@pec.it',
      subject: 's',
      html: '<p>x</p>',
      attachments: [],
      inlineImages: [],
      estimatedBytes: 1,
      recipientCheck: 'PEC',
      status: 'SENDING',
      settlement: 'PENDING',
      attempts: 1,
      nextAttemptAt: new Date(),
      sentCopy: 'PENDING',
      workerId: 'dead-worker',
      sendingStartedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(await worker.module.get(StuckRecovery).runOnce()).toBe(1);
    expect(await messageById('m_stale00000000001')).toMatchObject({
      status: 'STUCK',
      lastError: { code: 'STALE_SENDING', detail: containing('dead-worker') },
    });
    expect(await batches().findOne({ _id: 'b_stale00000000001' as never })).toMatchObject({
      status: 'SENDING',
      counts: { pending: 0, stuck: 1 },
    });
    expect(await worker.module.get(StuckRecovery).runOnce()).toBe(0);
  });

  it('gives a mailbox to one owner at a time and lets an expired lease be taken over', async () => {
    const leases = worker.module.get(MailboxLeaseService);
    const code = asMailboxCode('lease-test');
    const now = new Date();

    expect(await leases.tryAcquire(code, 'A', 10_000, now)).toBe(true);
    expect(await leases.tryAcquire(code, 'B', 10_000, now)).toBe(false);
    expect(await leases.tryAcquire(code, 'A', 10_000, now)).toBe(true);
    expect(await leases.renew(code, 'B', 10_000, now)).toBe(false);
    expect(await leases.renew(code, 'A', 10_000, now)).toBe(true);

    const later = new Date(now.getTime() + 11_000);
    expect(await leases.tryAcquire(code, 'B', 10_000, later)).toBe(true);
    expect(await leases.renew(code, 'A', 10_000, later)).toBe(false);
    await leases.release(code, 'B');
    expect(await leases.holder(code)).toBeNull();
  });

  it('the running worker holds the lease of every configured mailbox', async () => {
    const leases = worker.module.get(MailboxLeaseService);
    const lease = await waitFor(
      () => leases.holder(asMailboxCode('serfin-aruba')),
      (l) => l !== null,
    );
    expect(lease).toMatchObject({ owner: worker.runner.workerId });
    expect(worker.runner.lastActivity().getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it('releases every lease on shutdown and stops claiming work', async () => {
    const holder = (code: string): Promise<Document | null> =>
      db
        .db()
        .collection('mailbox_leases')
        .findOne({ _id: code as never });
    expect(await holder('serfin-aruba')).not.toBeNull();

    await worker.stop();
    expect(await holder('serfin-aruba')).toBeNull();
    expect(await holder('iqera-legalmail')).toBeNull();

    const { ids } = await submit([{ to: 'nobody-home@pec.it' }]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await messageById(ids.get('r-0') ?? ''))?.['status']).toBe('PENDING');

    worker = await startTestWorker(stack);
    await waitForStatus(ids.get('r-0') ?? '', 'SENT');
  });
});
