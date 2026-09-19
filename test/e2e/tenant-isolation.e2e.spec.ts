import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LightMyRequestResponse } from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PDF } from '../helpers/multipart';
import { row, SIMPLE_TEMPLATE, submitBatch, type Submitted } from '../helpers/submit';
import { startTestStack, type TestStack } from '../helpers/test-stack';

/**
 * OWASP API1 (broken object level authorization): a tenant that knows, or
 * guesses, the ids of another tenant must learn nothing from them - not the
 * data, not even that they exist. Every endpoint that takes an id is called
 * by the wrong tenant and must answer exactly like for an id that does not
 * exist.
 */
let stack: TestStack;
let db: MongoClient;
let serfin: Submitted;
let messageId: string;
const receiptId = 'r_SerfinReceipt001';

function as(key: string, method: 'GET' | 'POST', url: string): Promise<LightMyRequestResponse> {
  return stack.app.inject({ method, url, headers: { authorization: `Bearer ${key}` } });
}

function withoutRequestId(response: LightMyRequestResponse): Record<string, unknown> {
  const { requestId: _ignored, ...rest } = response.json<Record<string, unknown>>();

  return rest;
}

beforeAll(async () => {
  stack = await startTestStack();
  db = await MongoClient.connect(stack.mongoUri);
  serfin = await submitBatch(
    stack,
    stack.serfin.key,
    {
      mailbox: 'serfin-aruba',
      reference: 'serfin-secret-reference',
      subTenant: '1547',
      template: SIMPLE_TEMPLATE,
      messages: [row('pratica-4521', { attachments: [{ part: 'doc' }] }), row('pratica-4522')],
    },
    [{ name: 'doc', filename: 'doc.pdf', content: PDF }],
  );
  messageId = serfin.ids.get('pratica-4521') ?? '';
  // Make the EML path reachable, so a leak would be possible if the check were missing.
  await db
    .db()
    .collection('messages')
    .updateOne(
      { _id: messageId as never },
      { $set: { status: 'SENT', emlPath: 'batches/x.eml', emlSha256: 'a'.repeat(64), emlSize: 1 } },
    );
  // A stored receipt, files included, so its downloads would work for anyone if the check were missing.
  const receiptDir = join('batches', stack.serfin.id, serfin.batchId, 'receipts');
  await mkdir(join(stack.storageDir, receiptDir), { recursive: true });
  await writeFile(join(stack.storageDir, receiptDir, `${receiptId}.eml`), 'serfin receipt');
  await writeFile(join(stack.storageDir, receiptDir, `${receiptId}.daticert.xml`), '<postacert/>');
  await db
    .db()
    .collection('receipts')
    .insertOne({
      _id: receiptId as never,
      tenantId: stack.serfin.id,
      batchId: serfin.batchId,
      messageId,
      mailbox: 'serfin-aruba',
      type: 'DELIVERY',
      dedupKey: '<receipt.1@pec.aruba.it>',
      refMessageId: '<m_x@pec.serfin.example>',
      issuedAt: new Date(),
      receivedAt: new Date(),
      provider: 'ARUBA PEC S.p.A.',
      recipient: 'pratica-4521@pec.it',
      emlPath: `${receiptDir}/${receiptId}.eml`,
      emlSha256: 'b'.repeat(64),
      emlSize: 14,
      daticertPath: `${receiptDir}/${receiptId}.daticert.xml`,
      daticertSha256: 'c'.repeat(64),
      daticertSize: 12,
      createdAt: new Date(),
    });
});

afterAll(async () => {
  await db.close();
  await stack.stop();
});

describe('another tenant', () => {
  it('gets the same 404 as for an id that does not exist, on every endpoint', async () => {
    const cases: { method: 'GET' | 'POST'; url: string; missing: string }[] = [
      { method: 'GET', url: `/v1/batches/${serfin.batchId}`, missing: '/v1/batches/b_AAAAAAAAAAAAAAAA' },
      {
        method: 'GET',
        url: `/v1/batches/${serfin.batchId}/summary?groupBy=subTenant`,
        missing: '/v1/batches/b_AAAAAAAAAAAAAAAA/summary?groupBy=subTenant',
      },
      {
        method: 'GET',
        url: `/v1/batches/${serfin.batchId}/messages`,
        missing: '/v1/batches/b_AAAAAAAAAAAAAAAA/messages',
      },
      {
        method: 'POST',
        url: `/v1/batches/${serfin.batchId}/cancel`,
        missing: '/v1/batches/b_AAAAAAAAAAAAAAAA/cancel',
      },
      { method: 'GET', url: `/v1/messages/${messageId}`, missing: '/v1/messages/m_AAAAAAAAAAAAAAAA' },
      {
        method: 'GET',
        url: `/v1/messages/${messageId}/rendered`,
        missing: '/v1/messages/m_AAAAAAAAAAAAAAAA/rendered',
      },
      {
        method: 'GET',
        url: `/v1/messages/${messageId}/eml`,
        missing: '/v1/messages/m_AAAAAAAAAAAAAAAA/eml',
      },
      {
        method: 'GET',
        url: `/v1/messages/${messageId}/receipts`,
        missing: '/v1/messages/m_AAAAAAAAAAAAAAAA/receipts',
      },
      { method: 'GET', url: `/v1/receipts/${receiptId}/eml`, missing: '/v1/receipts/r_AAAAAAAAAAAAAAAA/eml' },
      {
        method: 'GET',
        url: `/v1/receipts/${receiptId}/daticert`,
        missing: '/v1/receipts/r_AAAAAAAAAAAAAAAA/daticert',
      },
    ];

    for (const { method, url, missing } of cases) {
      const foreign = await as(stack.iqera.key, method, url);
      const absent = await as(stack.iqera.key, method, missing);

      expect(foreign.statusCode, url).toBe(404);
      expect(withoutRequestId(foreign), url).toEqual(withoutRequestId(absent));
      expect(foreign.body, url).not.toMatch(/pratica|serfin|1547|secret/i);
    }
  });

  it('finds nothing in lists and searches, whatever the filter', async () => {
    for (const url of [
      '/v1/batches',
      '/v1/batches?reference=serfin-secret-reference',
      '/v1/batches?subTenant=1547',
      '/v1/messages',
      '/v1/messages?ref=pratica-4521',
      '/v1/messages?to=pratica-4521@pec.it',
      `/v1/messages?batchId=${serfin.batchId}`,
      '/v1/messages?subTenant=1547',
    ]) {
      const response = await as(stack.iqera.key, 'GET', url);
      expect(response.statusCode, url).toBe(200);
      expect(response.json(), url).toEqual({ items: [] });
    }
  });

  it('cannot cancel: the owner still sees every message PENDING', async () => {
    await as(stack.iqera.key, 'POST', `/v1/batches/${serfin.batchId}/cancel`);

    const owner = await as(stack.serfin.key, 'GET', `/v1/batches/${serfin.batchId}`);
    expect(owner.json()).toMatchObject({ status: 'QUEUED', counters: { cancelled: 0 } });
    expect(owner.json<Record<string, unknown>>()['cancelRequestedAt']).toBeUndefined();
  });

  it('while the owner sees everything', async () => {
    expect((await as(stack.serfin.key, 'GET', `/v1/batches/${serfin.batchId}`)).statusCode).toBe(200);
    expect((await as(stack.serfin.key, 'GET', `/v1/messages/${messageId}`)).statusCode).toBe(200);
    expect(
      (await as(stack.serfin.key, 'GET', `/v1/messages/${messageId}/receipts`)).json<{ items: unknown[] }>()
        .items,
    ).toHaveLength(1);
    expect((await as(stack.serfin.key, 'GET', `/v1/receipts/${receiptId}/eml`)).body).toBe('serfin receipt');
    expect((await as(stack.serfin.key, 'GET', `/v1/receipts/${receiptId}/daticert`)).statusCode).toBe(200);
    expect(
      (await as(stack.serfin.key, 'GET', '/v1/messages?ref=pratica-4521')).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
  });
});
