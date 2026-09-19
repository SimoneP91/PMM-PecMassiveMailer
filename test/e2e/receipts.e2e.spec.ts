import { createHash } from 'node:crypto';

import { MongoClient, type Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asMailboxCode, asMessageId, asTenantId } from '../../src/common/types/branded';
import { EventOutbox } from '../../src/modules/events/event-outbox';
import { MailboxStateStore } from '../../src/modules/mailboxes/mailbox-state.store';
import { SettlementJob } from '../../src/modules/receipts/settlement-job';
import { MessageQueueRepository } from '../../src/modules/sending/message-queue.repository';
import { verifySignature } from '../../src/modules/webhooks/signature';
import { FakeSmtpServer } from '../helpers/fake-smtp';
import { FakeWebhookTransport } from '../helpers/fake-webhook';
import { containing } from '../helpers/matchers';
import { buildEnvelope, buildReceipt, FakeReceiptSourceFactory } from '../helpers/receipts';
import { row, SIMPLE_TEMPLATE, submitBatch } from '../helpers/submit';
import {
  startTestStack,
  startTestWorker,
  waitFor,
  type TestStack,
  type TestWorker,
} from '../helpers/test-stack';

/**
 * Stage 5 end to end: the worker sends through an SMTP server in the test
 * process, the "provider" drops receipts in the mailbox (a fake IMAP folder),
 * the worker reads them, settles the batch and notifies the client through a
 * fake HTTP transport that checks every signature.
 */
let smtp: FakeSmtpServer;
let stack: TestStack;
let worker: TestWorker;
let db: MongoClient;
const receipts = new FakeReceiptSourceFactory();
const webhooks = new FakeWebhookTransport();
const MAILBOX = 'serfin-aruba';
const SECRET = 'whsec-serfin-0123456789abcdef0123456789abcdef';

const messages = (): Collection => db.db().collection('messages');

function get(url: string): ReturnType<TestStack['app']['inject']> {
  return stack.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${stack.serfin.key}` } });
}

async function messageView(id: string): Promise<Record<string, unknown>> {
  return (await get(`/v1/messages/${id}`)).json<Record<string, unknown>>();
}

async function waitForMessage(
  id: string,
  status: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const view = await waitFor(
    () => messageView(id),
    (m) => m['status'] === status,
    timeoutMs,
  );
  expect(view['status'], JSON.stringify(view['lastError'])).toBe(status);

  return view;
}

async function batchView(id: string): Promise<Record<string, unknown>> {
  return (await get(`/v1/batches/${id}`)).json<Record<string, unknown>>();
}

interface Delivered {
  readonly type: string;
  readonly body: { eventId: string; type: string; occurredAt: string; data: Record<string, unknown> };
  readonly headers: Readonly<Record<string, string>>;
}

async function webhook(type: string, match: (data: Record<string, unknown>) => boolean): Promise<Delivered> {
  const found = await waitFor(
    () =>
      Promise.resolve(
        webhooks
          .ofType(type)
          .map((request) => ({
            type,
            headers: request.headers,
            body: JSON.parse(request.body) as Delivered['body'],
            raw: request.body,
          }))
          .find((entry) => match(entry.body.data)),
      ),
    (entry) => entry !== undefined,
  );
  expect(found, `webhook ${type}`).toBeDefined();
  const entry = found!;
  // Every notification is signed over "<timestamp>.<body>".
  const timestamp = Number(entry.headers['x-pecmailer-timestamp']);
  expect(
    verifySignature(
      SECRET,
      timestamp,
      entry.raw,
      entry.headers['x-pecmailer-signature'] ?? '',
      Math.floor(Date.now() / 1000),
    ),
  ).toBe(true);
  expect(entry.headers['x-pecmailer-event-id']).toBe(entry.body.eventId);

  return entry;
}

async function sendAll(
  refs: string[],
): Promise<{ batchId: string; ids: Map<string, string>; rfc: Map<string, string> }> {
  const { batchId, ids } = await submitBatch(stack, stack.serfin.key, {
    mailbox: MAILBOX,
    reference: `ref-${refs.join('-')}`,
    template: SIMPLE_TEMPLATE,
    messages: refs.map((ref) => row(ref)),
  });
  const rfc = new Map<string, string>();
  for (const [ref, id] of ids) {
    const view = await waitForMessage(id, 'SENT');
    rfc.set(ref, view['rfcMessageId'] as string);
  }

  return { batchId, ids: new Map(ids), rfc };
}

beforeAll(async () => {
  smtp = new FakeSmtpServer();
  await smtp.start();
  stack = await startTestStack({
    webhook: true,
    smtp: { host: '127.0.0.1', port: smtp.port },
    smtpTimeoutSeconds: 5,
    perMinute: 0,
    sending: {
      pollIntervalMs: 100,
      retryBackoffSeconds: [1],
      leaseTtlSeconds: 10,
      suspendedRecheckSeconds: 5,
    },
    receipts: { pollIntervalSeconds: 1, settleAfterHours: 30 },
    webhooks: { pollIntervalMs: 100, backoffSeconds: [1], retryForHours: 1 },
  });
  db = await MongoClient.connect(stack.mongoUri);
  worker = await startTestWorker(stack, { receipts, webhooks });
});

afterAll(async () => {
  await worker.stop();
  await db.close();
  await stack.stop();
  await smtp.stop();
});

describe('receipts and settlement', () => {
  it('reads the receipts, settles the batch after the wait window, and notifies both closings', async () => {
    const { batchId, ids, rfc } = await sendAll(['a', 'b', 'c']);

    const sent = await webhook('batch.sent', (data) => data['batchId'] === batchId);
    expect(sent.body.data).toMatchObject({
      batchId,
      mailbox: MAILBOX,
      reference: 'ref-a-b-c',
      counters: { total: 3, sent: 3 },
    });
    // Ids and counters only: no recipient ever travels in a notification.
    expect(JSON.stringify(sent.body)).not.toMatch(/@pec\.it/);

    const deliveryRaw = buildReceipt({
      kind: 'avvenuta-consegna',
      ref: rfc.get('a') ?? '',
      recipient: 'a@pec.it',
    });
    for (const ref of ['a', 'b', 'c']) {
      receipts.deliver(MAILBOX, buildReceipt({ kind: 'accettazione', ref: rfc.get(ref) ?? '' }));
    }
    receipts.deliver(MAILBOX, deliveryRaw);
    receipts.deliver(
      MAILBOX,
      buildReceipt({
        kind: 'errore-consegna',
        ref: rfc.get('b') ?? '',
        errore: 'no-dest',
        erroreEsteso: '5.1.1 casella inesistente',
      }),
    );

    const a = await waitForMessage(ids.get('a') ?? '', 'DELIVERED');
    const b = await waitForMessage(ids.get('b') ?? '', 'NOT_DELIVERED');
    const c = await waitForMessage(ids.get('c') ?? '', 'ACCEPTED');

    expect(a).toMatchObject({
      settlement: 'SETTLED',
      receipts: [{ type: 'ACCEPTANCE' }, { type: 'DELIVERY' }],
      timeline: { acceptedAt: containing('T'), deliveredAt: containing('T'), settledAt: containing('T') },
    });
    expect(b).toMatchObject({
      settlement: 'SETTLED',
      deliveryError: { code: 'no-dest', detail: '5.1.1 casella inesistente' },
      timeline: { notDeliveredAt: containing('T') },
    });
    expect(c).toMatchObject({ settlement: 'PENDING' });
    expect(await batchView(batchId)).toMatchObject({
      status: 'SENT',
      counters: { delivered: 1, notDelivered: 1, accepted: 1 },
      settlement: { settled: 2, pending: 1, timedOut: 0 },
    });

    // The receipts endpoint and the downloads: the receipt byte for byte, with its digest.
    const list = (await get(`/v1/messages/${ids.get('a') ?? ''}/receipts`)).json<{
      items: {
        receiptId: string;
        type: string;
        provider: string;
        recipient: string;
        eml: { sha256: string };
      }[];
    }>();
    expect(list.items.map((item) => item.type)).toEqual(['ACCEPTANCE', 'DELIVERY']);
    const delivery = list.items[1]!;
    expect(delivery).toMatchObject({ provider: 'ARUBA PEC S.p.A.', recipient: 'a@pec.it' });
    const eml = await get(`/v1/receipts/${delivery.receiptId}/eml`);
    expect(eml.statusCode).toBe(200);
    expect(eml.rawPayload.equals(deliveryRaw)).toBe(true);
    const digest = createHash('sha256').update(deliveryRaw).digest();
    expect(eml.headers['repr-digest']).toBe(`sha-256=:${digest.toString('base64')}:`);
    expect(delivery.eml.sha256).toBe(digest.toString('hex'));
    const daticert = await get(`/v1/receipts/${delivery.receiptId}/daticert`);
    expect(daticert.headers['content-type']).toContain('application/xml');
    expect(daticert.body).toContain('<postacert tipo="avvenuta-consegna"');

    // Thirty-one hours later, "c" has had no final receipt: it times out and the batch settles.
    await messages().updateOne(
      { _id: ids.get('c') as never },
      { $set: { sentAt: new Date(Date.now() - 31 * 3_600_000) } },
    );
    expect((await worker.module.get(SettlementJob).runOnce()).timedOut).toBe(1);
    expect(await messageView(ids.get('c') ?? '')).toMatchObject({
      status: 'ACCEPTED',
      settlement: 'TIMED_OUT',
    });
    const settledBatch = await batchView(batchId);
    expect(settledBatch).toMatchObject({
      status: 'SETTLED',
      settlement: { settled: 2, timedOut: 1, pending: 0 },
    });
    expect(settledBatch['settledAt']).toBeDefined();

    const settled = await webhook('batch.settled', (data) => data['batchId'] === batchId);
    expect(settled.body.data).toMatchObject({
      counters: { delivered: 1, notDelivered: 1, accepted: 1 },
      settlement: { settled: 2, timedOut: 1 },
    });
    expect(webhooks.ofType('batch.settled').filter((r) => r.body.includes(batchId))).toHaveLength(1);
  });

  it('stores each receipt once and ignores envelopes and receipts about other messages', async () => {
    const { ids, rfc } = await sendAll(['d']);
    const acceptance = buildReceipt({ kind: 'accettazione', ref: rfc.get('d') ?? '' });
    receipts.deliver(MAILBOX, acceptance);
    await waitForMessage(ids.get('d') ?? '', 'ACCEPTED');

    const before = await db.db().collection('receipts').countDocuments();
    const bodies = receipts.bodies;
    receipts.deliver(MAILBOX, acceptance);
    receipts.deliver(MAILBOX, Buffer.from('From: a@pec.it\r\nTo: b@pec.it\r\nSubject: hi\r\n\r\nhello\r\n'));
    receipts.deliver(
      MAILBOX,
      buildEnvelope(buildReceipt({ kind: 'errore-consegna', ref: rfc.get('d') ?? '' })),
    );
    const last = receipts.deliver(
      MAILBOX,
      buildReceipt({ kind: 'avvenuta-consegna', ref: '<m_unknown000000001@pec.serfin.example>' }),
    );
    // Done when this mailbox's cursor is past the last mail (the pass counter is shared by every mailbox).
    await waitFor(
      () =>
        db
          .db()
          .collection('imap_cursors')
          .findOne({ _id: `${MAILBOX}:INBOX` as never }),
      (cursor) => Number(cursor?.['lastUid'] ?? 0) >= last,
    );

    expect(await db.db().collection('receipts').countDocuments()).toBe(before);
    expect(await messageView(ids.get('d') ?? '')).toMatchObject({ status: 'ACCEPTED' });
    // Only the two receipts were downloaded: the envelope and the plain mail were judged by their headers.
    expect(receipts.bodies - bodies).toBe(2);
  });

  it('re-applies a receipt stored before a crash that left its message behind', async () => {
    const { ids, rfc } = await sendAll(['crash']);
    const id = ids.get('crash') ?? '';
    const message = await messages().findOne({ _id: id as never });
    const receiptMessageId = '<opec21.crash.1@pec.aruba.it>';
    // What a crash between the two writes leaves: the receipt stored, the message still SENT.
    await db
      .db()
      .collection('receipts')
      .insertOne({
        _id: 'r_CrashReceipt0001' as never,
        tenantId: message?.['tenantId'] as string,
        batchId: message?.['batchId'] as string,
        messageId: id,
        mailbox: MAILBOX,
        type: 'ACCEPTANCE',
        dedupKey: receiptMessageId,
        refMessageId: rfc.get('crash') ?? '',
        issuedAt: new Date(),
        receivedAt: new Date(),
        emlPath: 'nowhere.eml',
        emlSha256: 'a'.repeat(64),
        emlSize: 1,
        createdAt: new Date(),
      });

    receipts.deliver(
      MAILBOX,
      buildReceipt({ kind: 'accettazione', ref: rfc.get('crash') ?? '', messageId: receiptMessageId }),
    );

    await waitForMessage(id, 'ACCEPTED');
    expect(await db.db().collection('receipts').countDocuments({ messageId: id })).toBe(1);
  });

  it('skips a mail that keeps failing, so the receipts after it still arrive', async () => {
    const { ids, rfc } = await sendAll(['after-poison']);
    const poison = receipts.deliver(
      MAILBOX,
      buildReceipt({ kind: 'accettazione', ref: '<m_poison0000000001@pec.serfin.example>' }),
    );
    receipts.broken.add(poison);
    receipts.deliver(MAILBOX, buildReceipt({ kind: 'accettazione', ref: rfc.get('after-poison') ?? '' }));

    await waitForMessage(ids.get('after-poison') ?? '', 'ACCEPTED', 15_000);
  });

  it('takes a STUCK message out of limbo on its acceptance receipt, without sending it again', async () => {
    smtp.behaviour = { kind: 'hangAfterData' };
    const { batchId, ids } = await submitBatch(stack, stack.serfin.key, {
      mailbox: MAILBOX,
      template: SIMPLE_TEMPLATE,
      messages: [row('limbo')],
    });
    const id = ids.get('limbo') ?? '';
    const stuck = await waitForMessage(id, 'STUCK', 15_000);
    smtp.behaviour = { kind: 'accept' };
    const sentBefore = smtp.received.length;
    expect(await batchView(batchId)).toMatchObject({ status: 'SENDING', counters: { stuck: 1 } });

    receipts.deliver(MAILBOX, buildReceipt({ kind: 'accettazione', ref: stuck['rfcMessageId'] as string }));

    await waitForMessage(id, 'ACCEPTED');
    // The batch closes in its own transaction, just after the message moves.
    const batch = await waitFor(
      () => batchView(batchId),
      (b) => b['status'] === 'SENT',
    );
    expect(batch).toMatchObject({ status: 'SENT', counters: { stuck: 0, accepted: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(smtp.received.length).toBe(sentBefore);
  });
});

describe('receipts against resends', () => {
  it('resolves a requeued message from its acceptance while the mailbox is paused: no second send', async () => {
    smtp.behaviour = { kind: 'hangAfterData' };
    const { ids } = await submitBatch(stack, stack.serfin.key, {
      mailbox: MAILBOX,
      template: SIMPLE_TEMPLATE,
      messages: [row('requeued')],
    });
    const id = ids.get('requeued') ?? '';
    const stuck = await waitForMessage(id, 'STUCK', 15_000);
    smtp.behaviour = { kind: 'accept' };
    const sentBefore = smtp.received.length;

    // An operator pauses the mailbox (sending stops, reading goes on) and requeues the message.
    const states = worker.module.get(MailboxStateStore);
    await states.suspend(asMailboxCode(MAILBOX), 'OPERATOR', 'paused for the test', new Date());
    const queue = worker.module.get(MessageQueueRepository);
    expect(await queue.resolveStuck(asMessageId(id), 'requeue', 'test', new Date())).toBe(true);
    expect(await messageView(id)).toMatchObject({ status: 'PENDING' });

    // The acceptance of the first attempt arrives before the resend.
    receipts.deliver(MAILBOX, buildReceipt({ kind: 'accettazione', ref: stuck['rfcMessageId'] as string }));
    await waitForMessage(id, 'ACCEPTED');

    await states.activate(asMailboxCode(MAILBOX), new Date());
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(smtp.received.length).toBe(sentBefore);
  });
});

describe('webhooks', () => {
  it('retries a failed delivery with the same event id, then delivers', async () => {
    const outbox = worker.module.get(EventOutbox);
    webhooks.answer('b_retry', 500, new Error('socket hang up'));
    await outbox.record({
      tenantId: asTenantId('t_serfin'),
      type: 'batch.sent',
      dedupKey: 'test:retry',
      occurredAt: new Date(),
      data: { batchId: 'b_retry' },
    });

    const delivered = await waitFor(
      () => Promise.resolve(webhooks.requests.filter((r) => r.body.includes('b_retry'))),
      (list) => list.length >= 3,
      15_000,
    );
    expect(delivered.map((r) => r.headers['x-pecmailer-delivery-attempt'])).toEqual(['1', '2', '3']);
    expect(new Set(delivered.map((r) => r.headers['x-pecmailer-event-id'])).size).toBe(1);
    const stored = await waitFor(
      () => db.db().collection('webhook_events').findOne({ dedupKey: 'test:retry' }),
      (event) => event?.['status'] === 'DELIVERED',
    );
    expect(stored).toMatchObject({ status: 'DELIVERED', attempts: 3, lastStatusCode: 200 });

    // The same fact recorded again is not a second event.
    await outbox.record({
      tenantId: asTenantId('t_serfin'),
      type: 'batch.sent',
      dedupKey: 'test:retry',
      occurredAt: new Date(),
      data: { batchId: 'b_retry' },
    });
    expect(await db.db().collection('webhook_events').countDocuments({ dedupKey: 'test:retry' })).toBe(1);
  });

  it('gives up after the retry window', async () => {
    webhooks.answer('b_giveup', 503);
    await worker.module.get(EventOutbox).record({
      tenantId: asTenantId('t_serfin'),
      type: 'batch.sent',
      dedupKey: 'test:giveup',
      occurredAt: new Date(Date.now() - 2 * 3_600_000),
      data: { batchId: 'b_giveup' },
    });

    const stored = await waitFor(
      () => db.db().collection('webhook_events').findOne({ dedupKey: 'test:giveup' }),
      (event) => event?.['status'] === 'FAILED',
    );
    expect(stored).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
    });
  });

  it('notifies mailbox.suspended once when the IMAP login is refused', async () => {
    receipts.refuseLogin = true;
    const event = await webhook('mailbox.suspended', (data) => data['cause'] === 'IMAP_AUTH_REFUSED');
    expect(event.body.data).toMatchObject({ mailbox: MAILBOX, cause: 'IMAP_AUTH_REFUSED' });

    const list = (await get('/v1/mailboxes')).json<{ items: Record<string, unknown>[] }>();
    expect(list.items[0]).toMatchObject({ status: 'SUSPENDED', suspensionCause: 'IMAP_AUTH_REFUSED' });

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(
      webhooks.ofType('mailbox.suspended').filter((r) => r.body.includes('IMAP_AUTH_REFUSED')),
    ).toHaveLength(1);
    receipts.refuseLogin = false;
  });
});
