import type { LightMyRequestResponse } from 'fastify';
import { MongoClient, type Collection } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { containing } from '../helpers/matchers';
import { PDF } from '../helpers/multipart';
import { row, SIMPLE_TEMPLATE, submitBatch, type Submitted } from '../helpers/submit';
import { startTestStack, type TestStack } from '../helpers/test-stack';

/**
 * The read side without a worker: messages stay PENDING unless a test moves
 * them by hand, which keeps every expectation exact.
 */
let stack: TestStack;
let db: MongoClient;
let a: Submitted;
let b: Submitted;

const messages = (): Collection => db.db().collection('messages');

function get(url: string): Promise<LightMyRequestResponse> {
  return stack.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${stack.serfin.key}` } });
}

function post(url: string): Promise<LightMyRequestResponse> {
  return stack.app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${stack.serfin.key}` } });
}

interface ListPage {
  items: { messageId: string; ref: string; batchId: string; status: string; to: string }[];
  nextCursor?: string;
}

async function setStatus(id: string, status: string): Promise<void> {
  await messages().updateOne({ _id: id as never }, { $set: { status } });
}

beforeAll(async () => {
  stack = await startTestStack();
  db = await MongoClient.connect(stack.mongoUri);

  a = await submitBatch(stack, stack.serfin.key, {
    mailbox: 'serfin-aruba',
    reference: 'ref-A',
    template: SIMPLE_TEMPLATE,
    messages: [
      row('r-0', { to: 'Mario.Rossi@PEC.it', subTenant: '1547', vars: { n: 'zero', name: 'Mario <R>' } }),
      row('r-1', { subTenant: '1547' }),
      row('r-2', { subTenant: '1547' }),
      row('r-3', { subTenant: '2384' }),
      row('r-4', { subTenant: '2384' }),
      row('r-5'),
      row('r-6'),
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  b = await submitBatch(
    stack,
    stack.serfin.key,
    {
      mailbox: 'serfin-aruba',
      reference: 'ref-B',
      subTenant: '1547',
      template: SIMPLE_TEMPLATE,
      messages: [row('r-0', { attachments: [{ part: 'doc', filename: 'sollecito.pdf' }] }), row('b-1')],
    },
    [{ name: 'doc', filename: 'doc.pdf', content: PDF }],
  );
});

afterAll(async () => {
  await db.close();
  await stack.stop();
});

describe('GET /v1/batches/{id}', () => {
  it('returns state and counters derived from the messages', async () => {
    const response = await get(`/v1/batches/${a.batchId}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      batchId: a.batchId,
      status: 'QUEUED',
      mailbox: 'serfin-aruba',
      reference: 'ref-A',
      messageCount: 7,
      rejected: 0,
      rejectedMessages: [],
      counters: { total: 7, pending: 7, sending: 0, sent: 0, failed: 0, stuck: 0, cancelled: 0 },
    });
  });

  it('answers 404 for an unknown or malformed id', async () => {
    for (const id of ['b_AAAAAAAAAAAAAAAA', 'nope', 'm_AAAAAAAAAAAAAAAA']) {
      const response = await get(`/v1/batches/${id}`);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'BATCH_NOT_FOUND' });
    }
  });
});

describe('GET /v1/batches', () => {
  it('lists newest first and pages with a cursor', async () => {
    const first = await get('/v1/batches?limit=1');
    expect(first.statusCode, first.body).toBe(200);
    const page1 = first.json<{ items: { batchId: string }[]; nextCursor?: string }>();
    expect(page1.items.map((item) => item.batchId)).toEqual([b.batchId]);
    expect(page1.nextCursor).toBeDefined();

    const second = await get(`/v1/batches?limit=1&cursor=${page1.nextCursor ?? ''}`);
    const page2 = second.json<{
      items: { batchId: string; counters: { total: number } }[];
      nextCursor?: string;
    }>();
    expect(page2.items.map((item) => item.batchId)).toEqual([a.batchId]);
    expect(page2.items[0]?.counters.total).toBe(7);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('filters by reference, subTenant, status and date', async () => {
    const ids = async (query: string): Promise<string[]> =>
      (await get(`/v1/batches?${query}`))
        .json<{ items: { batchId: string }[] }>()
        .items.map((i) => i.batchId);

    expect(await ids('reference=ref-A')).toEqual([a.batchId]);
    expect(await ids('reference=ref-A&reference=ref-B')).toEqual([b.batchId, a.batchId]);
    expect(await ids('subTenant=1547')).toEqual([b.batchId]);
    expect(await ids('status=SENT,CANCELLED')).toEqual([]);
    expect(await ids('status=QUEUED')).toEqual([b.batchId, a.batchId]);
    expect(
      await ids(`createdBefore=${new Date(Date.now() + 60_000).toISOString()}&mailbox=serfin-aruba`),
    ).toHaveLength(2);
    expect(await ids(`createdFrom=${new Date(Date.now() + 60_000).toISOString()}`)).toEqual([]);
  });
});

describe('GET /v1/batches/{id}/messages', () => {
  it('pages through the batch in the order the client wrote it', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await get(
        `/v1/batches/${a.batchId}/messages?limit=3${cursor === undefined ? '' : `&cursor=${cursor}`}`,
      );
      expect(response.statusCode, response.body).toBe(200);
      const page = response.json<ListPage>();
      seen.push(...page.items.map((item) => item.ref));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4', 'r-5', 'r-6']);
  });

  it('filters by status, ref, recipient (case-insensitive), subject and subTenant', async () => {
    const refs = async (query: string): Promise<string[]> => {
      const response = await get(`/v1/batches/${a.batchId}/messages?${query}`);
      expect(response.statusCode, response.body).toBe(200);

      return response.json<ListPage>().items.map((item) => item.ref);
    };
    await setStatus(a.ids.get('r-1') ?? '', 'FAILED');

    expect(await refs('status=FAILED')).toEqual(['r-1']);
    expect(await refs('status=PENDING,FAILED')).toHaveLength(7);
    expect(await refs('ref=r-2&ref=r-3')).toEqual(['r-2', 'r-3']);
    expect(await refs('to=mario.rossi@pec.it')).toEqual(['r-0']);
    expect(await refs('to=MARIO.ROSSI@pec.IT')).toEqual(['r-0']);
    expect(await refs(`subject=${encodeURIComponent('PRATICA r-4')}`)).toEqual(['r-4']);
    expect(await refs(`subject=${encodeURIComponent('(.*)')}`)).toEqual([]);
    expect(await refs('subTenant=1547,2384')).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4']);
    expect(await refs('subTenant=2384&status=PENDING')).toEqual(['r-3', 'r-4']);

    await setStatus(a.ids.get('r-1') ?? '', 'PENDING');
  });

  it('shows the list fields and nothing heavy', async () => {
    const page = (await get(`/v1/batches/${a.batchId}/messages?ref=r-0`)).json<{
      items: Record<string, unknown>[];
    }>();

    expect(page.items[0]).toMatchObject({
      messageId: a.ids.get('r-0'),
      batchId: a.batchId,
      ref: 'r-0',
      to: 'Mario.Rossi@PEC.it',
      subTenant: '1547',
      subject: 'Pratica zero',
      status: 'PENDING',
      settlement: 'PENDING',
      attemptCount: 0,
    });
    expect(page.items[0]).not.toHaveProperty('html');
    expect(page.items[0]).not.toHaveProperty('attempts');
  });
});

describe('GET /v1/messages', () => {
  it('searches across batches, newest first, and narrows by batch', async () => {
    const response = await get('/v1/messages?ref=r-0');
    expect(response.statusCode, response.body).toBe(200);
    const items = response.json<ListPage>().items;
    expect(items.map((item) => item.batchId)).toEqual([b.batchId, a.batchId]);

    const narrowed = (await get(`/v1/messages?ref=r-0&batchId=${a.batchId}`)).json<ListPage>().items;
    expect(narrowed.map((item) => item.messageId)).toEqual([a.ids.get('r-0')]);
  });

  it('pages with its own cursor', async () => {
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = (
        await get(`/v1/messages?limit=4${cursor === undefined ? '' : `&cursor=${cursor}`}`)
      ).json<ListPage>();
      all.push(...page.items.map((item) => item.messageId));
      cursor = page.nextCursor;
    } while (cursor !== undefined);

    expect(all).toHaveLength(9);
    expect(new Set(all).size).toBe(9);
  });

  it('refuses a cursor from another list, a forged cursor and bad parameters', async () => {
    const batchCursor = (await get('/v1/batches?limit=1')).json<{ nextCursor: string }>().nextCursor;
    for (const url of [
      `/v1/messages?cursor=${batchCursor}`,
      '/v1/messages?cursor=not-a-cursor',
      `/v1/messages?cursor=${Buffer.from('{"v":1,"l":"messages","k":[1]}').toString('base64url')}`,
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(400);
      expect(response.json()).toMatchObject({ code: 'INVALID_CURSOR' });
    }

    for (const query of [
      'limit=0',
      'limit=501',
      'limit=abc',
      'status=BOGUS',
      'unknown=1',
      'createdFrom=yesterday',
    ]) {
      const response = await get(`/v1/messages?${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(response.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('GET /v1/messages/{id}', () => {
  it('returns the detail of a message not sent yet', async () => {
    const id = b.ids.get('r-0') ?? '';
    const response = await get(`/v1/messages/${id}`);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      messageId: id,
      batchId: b.batchId,
      mailbox: 'serfin-aruba',
      ref: 'r-0',
      subTenant: '1547',
      status: 'PENDING',
      recipientCheck: 'PEC',
      attemptCount: 0,
      attempts: [],
      operatorActions: [],
      sentCopy: 'PENDING',
      attachments: [
        {
          filename: 'sollecito.pdf',
          contentType: 'application/pdf',
          size: PDF.length,
          sha256: containing(''),
        },
      ],
      timeline: { createdAt: containing('T') },
    });
    expect(body).not.toHaveProperty('eml');
    expect(body).not.toHaveProperty('rfcMessageId');
    expect(JSON.stringify(body)).not.toMatch(/path|workerId|toLower|position/);
  });

  it('returns the rendered content, escaped as it will be sent', async () => {
    const response = await get(`/v1/messages/${a.ids.get('r-0') ?? ''}/rendered`);

    expect(response.json()).toEqual({
      messageId: a.ids.get('r-0'),
      subject: 'Pratica zero',
      html: '<p>Gentile Mario &lt;R&gt;</p>',
    });
  });

  it('has no EML before the message was transmitted', async () => {
    const response = await get(`/v1/messages/${a.ids.get('r-0') ?? ''}/eml`);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'EML_NOT_AVAILABLE', detail: containing('PENDING') });
  });

  it('answers 404 for an unknown or malformed id', async () => {
    for (const url of [
      '/v1/messages/m_AAAAAAAAAAAAAAAA',
      '/v1/messages/x',
      `/v1/messages/${a.batchId}/eml`,
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(response.json()).toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    }
  });
});

describe('GET /v1/batches/{id}/summary', () => {
  it('groups the counters by subTenant, messages without one last', async () => {
    await setStatus(a.ids.get('r-3') ?? '', 'SENT');
    const response = await get(`/v1/batches/${a.batchId}/summary?groupBy=subTenant`);
    await setStatus(a.ids.get('r-3') ?? '', 'PENDING');

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      groups: { subTenant: string | null; counters: Record<string, number> }[];
    }>();
    expect(body.groups.map((g) => [g.subTenant, g.counters['total'], g.counters['sent']])).toEqual([
      ['1547', 3, 0],
      ['2384', 2, 1],
      [null, 2, 0],
    ]);
  });

  it('requires groupBy=subTenant', async () => {
    expect((await get(`/v1/batches/${a.batchId}/summary`)).statusCode).toBe(400);
    expect((await get(`/v1/batches/${a.batchId}/summary?groupBy=status`)).statusCode).toBe(400);
  });
});

describe('POST /v1/batches/{id}/cancel', () => {
  it('cancels everything not yet sent, closes the batch as CANCELLED and is idempotent', async () => {
    const c = await submitBatch(stack, stack.serfin.key, {
      mailbox: 'serfin-aruba',
      template: SIMPLE_TEMPLATE,
      messages: [row('c-0'), row('c-1'), row('c-2')],
    });

    const first = await post(`/v1/batches/${c.batchId}/cancel`);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({
      batchId: c.batchId,
      status: 'CANCELLED',
      cancelled: 3,
      counters: { total: 3, cancelled: 3, pending: 0 },
    });

    const again = await post(`/v1/batches/${c.batchId}/cancel`);
    expect(again.json()).toMatchObject({ status: 'CANCELLED', cancelled: 0, counters: { cancelled: 3 } });

    const detail = (await get(`/v1/batches/${c.batchId}`)).json<Record<string, unknown>>();
    expect(detail['cancelRequestedAt']).toBeDefined();
    expect(detail['cancelledAt']).toBeDefined();
    const message = (await get(`/v1/messages/${c.ids.get('c-0') ?? ''}`)).json<{
      timeline: Record<string, string>;
    }>();
    expect(message.timeline['cancelledAt']).toBeDefined();
  });

  it('leaves what already left and what is in flight, and closes the batch as SENT once the flight lands', async () => {
    const d = await submitBatch(stack, stack.serfin.key, {
      mailbox: 'serfin-aruba',
      template: SIMPLE_TEMPLATE,
      messages: [row('d-0'), row('d-1'), row('d-2'), row('d-3')],
    });
    await db
      .db()
      .collection('batches')
      .updateOne({ _id: d.batchId as never }, { $set: { status: 'SENDING' } });
    await setStatus(d.ids.get('d-0') ?? '', 'SENT');
    await setStatus(d.ids.get('d-1') ?? '', 'SENDING');
    await setStatus(d.ids.get('d-2') ?? '', 'RETRY_SCHEDULED');

    const response = await post(`/v1/batches/${d.batchId}/cancel`);
    expect(response.json()).toMatchObject({
      status: 'SENDING',
      cancelled: 2,
      counters: { total: 4, sent: 1, sending: 1, cancelled: 2, retryScheduled: 0, pending: 0 },
    });

    // The message in flight lands; the next completion check closes the batch.
    await setStatus(d.ids.get('d-1') ?? '', 'SENT');
    const closed = await post(`/v1/batches/${d.batchId}/cancel`);
    expect(closed.json()).toMatchObject({
      status: 'SENT',
      cancelled: 0,
      counters: { sent: 2, cancelled: 2 },
    });
  });

  it('answers 404 for an unknown batch', async () => {
    const response = await post('/v1/batches/b_AAAAAAAAAAAAAAAA/cancel');
    expect(response.statusCode).toBe(404);
  });
});

describe('OpenAPI', () => {
  it('documents every read endpoint with its query parameters', async () => {
    const doc = (await stack.app.inject({ method: 'GET', url: '/docs/openapi.json' })).json<{
      paths: Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>;
    }>();

    for (const path of [
      '/v1/batches',
      '/v1/batches/{batchId}',
      '/v1/batches/{batchId}/summary',
      '/v1/batches/{batchId}/messages',
      '/v1/batches/{batchId}/cancel',
      '/v1/messages',
      '/v1/messages/{messageId}',
      '/v1/messages/{messageId}/rendered',
      '/v1/messages/{messageId}/eml',
    ]) {
      expect(doc.paths, path).toHaveProperty([path]);
    }
    const search = doc.paths['/v1/messages']?.['get']?.parameters?.map((p) => `${p.in}:${p.name}`) ?? [];
    expect(search).toEqual(
      expect.arrayContaining([
        'query:status',
        'query:ref',
        'query:to',
        'query:subject',
        'query:subTenant',
        'query:cursor',
        'query:limit',
      ]),
    );
  });
});
