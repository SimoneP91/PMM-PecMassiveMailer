import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { LightMyRequestResponse } from 'fastify';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { containing } from '../helpers/matchers';
import { EXE, multipart, PDF, PNG, type FilePart } from '../helpers/multipart';
import { startTestStack, type TestStack } from '../helpers/test-stack';

let stack: TestStack;
let db: MongoClient;

const TEMPLATE = {
  subject: 'Sollecito pratica {{practiceNumber}}',
  html: '<html><body><p>Gentile {{customerName}},</p>{{{invoiceTable}}}<p>Saluti</p></body></html>',
};

function baseBatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mailbox: 'serfin-aruba',
    reference: 'solleciti-settembre',
    template: TEMPLATE,
    defaults: { attachments: [{ part: 'privacy', filename: 'informativa.pdf' }] },
    messages: [
      {
        ref: 'pratica-4521',
        to: 'mario.rossi@pec.it',
        toName: 'Mario Rossi',
        vars: {
          customerName: 'Mario <Rossi>',
          practiceNumber: '4521',
          invoiceTable: '<table><tr><td>12</td></tr></table>',
        },
        attachments: [{ part: 'doc-4521', filename: 'sollecito-4521.pdf' }],
        dedupKey: `sollecito:4521:${randomUUID()}`,
      },
      {
        ref: 'pratica-4522',
        to: 'anna.bianchi@pec.custom.example',
        vars: { customerName: 'Anna', practiceNumber: '4522', invoiceTable: '<p>nessuna</p>' },
      },
    ],
    ...overrides,
  };
}

const baseFiles: FilePart[] = [
  { name: 'privacy', filename: 'informativa-privacy.pdf', content: PDF },
  { name: 'doc-4521', filename: 'sollecito.pdf', content: PDF },
];

async function post(
  batch: unknown,
  files: readonly FilePart[] = baseFiles,
  options: { key?: string | null; tenantKey?: string } = {},
): Promise<LightMyRequestResponse> {
  const body = multipart(batch, files);
  const headers: Record<string, string> = {
    ...body.headers,
    authorization: `Bearer ${options.tenantKey ?? stack.serfin.key}`,
  };
  if (options.key !== null) {
    headers['idempotency-key'] = options.key ?? randomUUID();
  }

  return stack.app.inject({ method: 'POST', url: '/v1/batches', headers, payload: body.payload });
}

beforeAll(async () => {
  stack = await startTestStack({ requestsPerMinute: 1000, maxMessageBytes: 2 * 1024 * 1024 });
  db = await MongoClient.connect(stack.mongoUri);
});

afterAll(async () => {
  await db.close();
  await stack.stop();
});

beforeEach(() => {
  stack.mx.answers.clear();
  stack.mx.mx('pec.custom.example', 'mx.pec.aruba.it');
});

describe('POST /v1/batches - accepted', () => {
  it('creates the batch, renders every message and stores the files', async () => {
    const response = await post(baseBatch());

    expect(response.statusCode, response.body).toBe(202);
    const body = response.json<{
      batchId: string;
      status: string;
      accepted: number;
      rejected: number;
      messages: { ref: string; messageId: string; status: string }[];
      rejectedMessages: unknown[];
      warnings: unknown[];
    }>();
    expect(response.headers.location).toBe(`/v1/batches/${body.batchId}`);
    expect(body).toMatchObject({
      status: 'QUEUED',
      mailbox: 'serfin-aruba',
      accepted: 2,
      rejected: 0,
      rejectedMessages: [],
    });
    expect(body.messages.map((m) => m.ref)).toEqual(['pratica-4521', 'pratica-4522']);
    expect(body.messages[0]?.messageId).toMatch(/^m_/);

    const batch = await db
      .db()
      .collection('batches')
      .findOne({ _id: body.batchId as never });
    expect(batch).toMatchObject({ tenantId: 't_serfin', status: 'QUEUED', messageCount: 2 });

    const messages = await db
      .db()
      .collection('messages')
      .find({ batchId: body.batchId })
      .sort({ ref: 1 })
      .toArray();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      tenantId: 't_serfin',
      status: 'PENDING',
      subject: 'Sollecito pratica 4521',
      html: '<html><body><p>Gentile Mario &lt;Rossi&gt;,</p><table><tr><td>12</td></tr></table><p>Saluti</p></body></html>',
      recipientCheck: 'PEC',
    });
    expect(messages[0]?.['attachments']).toEqual([
      expect.objectContaining({
        part: 'privacy',
        filename: 'informativa.pdf',
        contentType: 'application/pdf',
      }),
      expect.objectContaining({
        part: 'doc-4521',
        filename: 'sollecito-4521.pdf',
        contentType: 'application/pdf',
      }),
    ]);
    expect(messages[1]?.['attachments']).toHaveLength(1);

    const partsDir = join(stack.storageDir, 'batches', 't_serfin', body.batchId, 'parts');
    expect((await readdir(partsDir)).sort()).toEqual(['doc-4521', 'privacy']);
    expect((await stat(join(partsDir, 'privacy'))).size).toBe(PDF.length);
    expect(await readdir(join(stack.storageDir, 'staging'))).toEqual([]);
  });

  it('rejects rows individually and keeps the valid ones', async () => {
    stack.mx.mx('unknown.example', 'mail.somewhere.example');
    const batch = baseBatch({
      messages: [
        ...(baseBatch()['messages'] as unknown[]),
        {
          ref: 'gmail',
          to: 'x@gmail.com',
          vars: { customerName: 'X', practiceNumber: '1', invoiceTable: '' },
        },
        { ref: 'missing-var', to: 'y@pec.it', vars: { customerName: 'Y' } },
        {
          ref: 'bad-html',
          to: 'z@pec.it',
          vars: { customerName: 'Z', practiceNumber: '3', invoiceTable: '<script>1</script>' },
        },
        {
          ref: 'unknown-mx',
          to: 'w@unknown.example',
          vars: { customerName: 'W', practiceNumber: '4', invoiceTable: '' },
        },
        {
          ref: 'bad-ext',
          to: 'v@pec.it',
          vars: { customerName: 'V', practiceNumber: '5', invoiceTable: '' },
          attachments: [{ part: 'doc-4521', filename: 'renamed.docx' }],
        },
      ],
    });

    const response = await post(batch);

    expect(response.statusCode, response.body).toBe(202);
    const body = response.json<{
      accepted: number;
      rejected: number;
      rejectedMessages: { ref: string; code: string }[];
    }>();
    expect(body.accepted).toBe(2);
    expect(body.rejected).toBe(5);
    expect(body.rejectedMessages.map((r) => [r.ref, r.code])).toEqual([
      ['gmail', 'RECIPIENT_NOT_PEC'],
      ['missing-var', 'MISSING_PLACEHOLDER'],
      ['bad-html', 'HTML_VALUE_REJECTED'],
      ['unknown-mx', 'RECIPIENT_UNVERIFIED'],
      ['bad-ext', 'ATTACHMENT_EXTENSION_MISMATCH'],
    ]);
  });

  it('accepts an unverified recipient when the batch says so, and marks it', async () => {
    stack.mx.mx('unknown.example', 'mail.somewhere.example');
    const batch = baseBatch({
      options: { unverifiedRecipients: 'send' },
      messages: [
        {
          ref: 'r',
          to: 'w@unknown.example',
          vars: { customerName: 'W', practiceNumber: '4', invoiceTable: '' },
        },
      ],
    });

    const response = await post(batch, [baseFiles[0]!]);

    expect(response.statusCode, response.body).toBe(202);
    const { batchId } = response.json<{ batchId: string }>();
    const message = await db.db().collection('messages').findOne({ batchId });
    expect(message).toMatchObject({ recipientCheck: 'UNVERIFIED' });
  });

  it('warns about a template without placeholders and unused vars', async () => {
    const response = await post(
      baseBatch({
        template: { subject: 'Fisso', html: '<p>Uguale per tutti</p>' },
        messages: [{ ref: 'a', to: 'a@pec.it', vars: { extra: '1' } }],
      }),
      [baseFiles[0]!],
    );

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json<{ warnings: { code: string }[] }>().warnings.map((w) => w.code)).toEqual([
      'TEMPLATE_WITHOUT_PLACEHOLDERS',
      'UNUSED_VARS',
    ]);
  });

  it('refuses a dedupKey already used by a previous batch, naming the message', async () => {
    const dedupKey = `dk:${randomUUID()}`;
    const first = await post(
      baseBatch({
        messages: [
          {
            ref: 'one',
            to: 'a@pec.it',
            vars: { customerName: 'A', practiceNumber: '1', invoiceTable: '' },
            dedupKey,
          },
        ],
      }),
      [baseFiles[0]!],
    );
    expect(first.statusCode).toBe(202);
    const originalId = first.json<{ messages: { messageId: string }[] }>().messages[0]?.messageId ?? '';

    const second = await post(
      baseBatch({
        messages: [
          {
            ref: 'again',
            to: 'a@pec.it',
            vars: { customerName: 'A', practiceNumber: '1', invoiceTable: '' },
            dedupKey,
          },
          {
            ref: 'twin-1',
            to: 'b@pec.it',
            vars: { customerName: 'B', practiceNumber: '2', invoiceTable: '' },
            dedupKey: 'twin',
          },
          {
            ref: 'twin-2',
            to: 'c@pec.it',
            vars: { customerName: 'C', practiceNumber: '3', invoiceTable: '' },
            dedupKey: 'twin',
          },
        ],
      }),
      [baseFiles[0]!],
    );

    expect(second.statusCode, second.body).toBe(202);
    const body = second.json<{
      accepted: number;
      rejectedMessages: { ref: string; code: string; detail: string }[];
    }>();
    expect(body.accepted).toBe(1);
    expect(body.rejectedMessages).toEqual([
      { ref: 'again', code: 'DUPLICATE_DEDUP_KEY', detail: containing(originalId) },
      { ref: 'twin-2', code: 'DUPLICATE_DEDUP_KEY', detail: containing('twin-1') },
    ]);
  });

  it('rejects a message whose encoded size exceeds the mailbox limit', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(1_700_000, 1)]);
    const response = await post(
      baseBatch({
        defaults: {},
        messages: [
          {
            ref: 'big',
            to: 'a@pec.it',
            vars: { customerName: 'A', practiceNumber: '1', invoiceTable: '' },
            attachments: [{ part: 'big' }],
          },
        ],
      }),
      [{ name: 'big', filename: 'big.pdf', content: big }],
    );

    expect(response.statusCode, response.body).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'ALL_MESSAGES_REJECTED',
      errors: [{ code: 'MESSAGE_TOO_LARGE' }],
    });
  });
});

describe('POST /v1/batches - dry run', () => {
  it('validates, renders a preview and creates nothing', async () => {
    const before = await db.db().collection('batches').countDocuments();
    const response = await post(baseBatch({ options: { dryRun: true } }), baseFiles, { key: null });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      dryRun: boolean;
      accepted: number;
      preview: { ref: string; subject: string; html: string; attachments: unknown[] }[];
    }>();
    expect(body.dryRun).toBe(true);
    expect(body.accepted).toBe(2);
    expect(body.preview[0]).toMatchObject({
      ref: 'pratica-4521',
      subject: 'Sollecito pratica 4521',
      html: containing('Gentile Mario &lt;Rossi&gt;'),
    });
    expect(body.preview[0]?.attachments).toHaveLength(2);
    expect(await db.db().collection('batches').countDocuments()).toBe(before);
    expect(await readdir(join(stack.storageDir, 'staging'))).toEqual([]);
  });
});

describe('POST /v1/batches - idempotency', () => {
  it('requires the header', async () => {
    const response = await post(baseBatch(), baseFiles, { key: null });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
  });

  it('replays the original answer for the same key and content', async () => {
    const key = randomUUID();
    const batch = baseBatch();
    const first = await post(batch, baseFiles, { key });
    expect(first.statusCode, first.body).toBe(202);

    const second = await post(batch, baseFiles, { key });
    expect(second.statusCode).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.headers.location).toBe(first.headers.location);
    expect(second.json()).toEqual(first.json());
    expect(await db.db().collection('batches').countDocuments({ idempotencyKey: key })).toBe(1);
  });

  it('refuses the same key with different content', async () => {
    const key = randomUUID();
    expect((await post(baseBatch(), baseFiles, { key })).statusCode).toBe(202);

    const response = await post(baseBatch({ reference: 'other' }), baseFiles, { key });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('lets a key be retried after a failed attempt', async () => {
    const key = randomUUID();
    const broken = await post(
      baseBatch({ template: { subject: 'x', html: '<script>1</script>' } }),
      baseFiles,
      { key },
    );
    expect(broken.statusCode).toBe(422);

    const retry = await post(baseBatch(), baseFiles, { key });
    expect(retry.statusCode, retry.body).toBe(202);
  });
});

describe('POST /v1/batches - batch-level rejections create nothing', () => {
  async function expectNothingCreated(
    fn: () => Promise<LightMyRequestResponse>,
    status: number,
    code: string,
  ): Promise<LightMyRequestResponse> {
    const batches = await db.db().collection('batches').countDocuments();
    const response = await fn();
    expect(response.statusCode, response.body).toBe(status);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code });
    expect(await db.db().collection('batches').countDocuments()).toBe(batches);
    expect(await readdir(join(stack.storageDir, 'staging'))).toEqual([]);

    return response;
  }

  it('415 when the request is not multipart', async () => {
    await expectNothingCreated(
      () =>
        stack.app.inject({
          method: 'POST',
          url: '/v1/batches',
          headers: {
            authorization: `Bearer ${stack.serfin.key}`,
            'content-type': 'application/json',
            'idempotency-key': 'k',
          },
          payload: JSON.stringify(baseBatch()),
        }),
      415,
      'MULTIPART_REQUIRED',
    );
  });

  it('400 when the batch part is missing or not JSON', async () => {
    await expectNothingCreated(() => post(undefined, baseFiles), 400, 'MISSING_BATCH_PART');
    await expectNothingCreated(
      () => {
        const body = multipart('{not json', baseFiles, 'batch', 'text/plain');
        return stack.app.inject({
          method: 'POST',
          url: '/v1/batches',
          headers: { ...body.headers, authorization: `Bearer ${stack.serfin.key}`, 'idempotency-key': 'k' },
          payload: body.payload,
        });
      },
      400,
      'INVALID_JSON',
    );
  });

  it('400 with field errors when the JSON does not match the schema', async () => {
    const response = await expectNothingCreated(
      () => post(baseBatch({ messages: [{ ref: 'a', to: 'not-an-address', extra: 1 }] })),
      400,
      'VALIDATION_FAILED',
    );
    const errors = response.json<{ errors: { path: string }[] }>().errors.map((e) => e.path);
    expect(errors).toEqual(expect.arrayContaining(['messages[0].to', 'messages[0]']));
  });

  it('422 for an empty batch, duplicate refs, too many messages', async () => {
    await expectNothingCreated(() => post(baseBatch({ messages: [] })), 422, 'EMPTY_BATCH');
    const messages = baseBatch()['messages'] as { ref: string }[];
    await expectNothingCreated(
      () => post(baseBatch({ messages: [messages[0], messages[0]] })),
      422,
      'DUPLICATE_REF',
    );
  });

  it('403 for a mailbox of another tenant, even though it exists', async () => {
    await expectNothingCreated(
      () => post(baseBatch({ mailbox: 'iqera-legalmail' })),
      403,
      'MAILBOX_NOT_AVAILABLE',
    );
  });

  it('423 when the mailbox is suspended', async () => {
    await db
      .db()
      .collection('mailbox_states')
      .updateOne(
        { _id: 'serfin-aruba' as never },
        { $set: { status: 'SUSPENDED', reason: 'login refused by the provider', changedAt: new Date() } },
        { upsert: true },
      );
    try {
      const response = await expectNothingCreated(() => post(baseBatch()), 423, 'MAILBOX_SUSPENDED');
      expect(response.json()).toMatchObject({ detail: containing('login refused') });

      const list = await stack.app.inject({
        method: 'GET',
        url: '/v1/mailboxes',
        headers: { authorization: `Bearer ${stack.serfin.key}` },
      });
      expect(list.json<{ items: { status: string }[] }>().items[0]?.status).toBe('SUSPENDED');
    } finally {
      await db
        .db()
        .collection('mailbox_states')
        .deleteOne({ _id: 'serfin-aruba' as never });
    }
  });

  it('400 for a referenced part that is missing and for a part nobody references', async () => {
    await expectNothingCreated(() => post(baseBatch(), [baseFiles[0]!]), 400, 'MISSING_PART');
    await expectNothingCreated(
      () => post(baseBatch(), [...baseFiles, { name: 'orphan', filename: 'x.pdf', content: PDF }]),
      400,
      'UNREFERENCED_PART',
    );
  });

  it('415 for a file whose content is not what its name says, or an executable', async () => {
    const response = await expectNothingCreated(
      () => post(baseBatch(), [baseFiles[0]!, { name: 'doc-4521', filename: 'sollecito.pdf', content: EXE }]),
      415,
      'ATTACHMENT_TYPE_REJECTED',
    );
    expect(response.json()).toMatchObject({ errors: [{ path: 'parts.doc-4521', code: 'EXECUTABLE' }] });

    await expectNothingCreated(
      () => post(baseBatch(), [baseFiles[0]!, { name: 'doc-4521', filename: 'sollecito.pdf', content: PNG }]),
      415,
      'ATTACHMENT_TYPE_REJECTED',
    );
    await expectNothingCreated(
      () =>
        post(baseBatch(), [
          baseFiles[0]!,
          { name: 'doc-4521', filename: 'sollecito.bat', content: 'echo hi' },
        ]),
      415,
      'ATTACHMENT_TYPE_REJECTED',
    );
  });

  it('422 for a template that breaks the rules, listing each problem', async () => {
    const response = await expectNothingCreated(
      () =>
        post(
          baseBatch({
            template: {
              subject: 'x {{{raw}}}',
              html: '<p onclick="x()">a</p><img src="https://t.example/p.png"><iframe></iframe><a href="javascript:1">b</a>',
            },
          }),
        ),
      422,
      'TEMPLATE_REJECTED',
    );
    const codes = response.json<{ errors: { code: string }[] }>().errors.map((e) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'RAW_PLACEHOLDER_IN_SUBJECT',
        'FORBIDDEN_ATTRIBUTE',
        'EXTERNAL_IMAGE',
        'FORBIDDEN_ELEMENT',
        'FORBIDDEN_URL',
      ]),
    );
  });

  it('422 with atomic when one row is bad', async () => {
    const messages = baseBatch()['messages'] as unknown[];
    const response = await expectNothingCreated(
      () =>
        post(
          baseBatch({
            options: { atomic: true },
            messages: [...messages, { ref: 'bad', to: 'x@gmail.com' }],
          }),
        ),
      422,
      'BATCH_REJECTED',
    );
    expect(response.json()).toMatchObject({
      errors: [{ path: 'messages[2].to', code: 'RECIPIENT_NOT_PEC' }],
    });
  });

  it('422 when every row is rejected', async () => {
    await expectNothingCreated(
      () => post(baseBatch({ messages: [{ ref: 'bad', to: 'x@gmail.com' }] }), [baseFiles[0]!]),
      422,
      'ALL_MESSAGES_REJECTED',
    );
  });

  it('inline images must be images declared in the template', async () => {
    const response = await expectNothingCreated(
      () =>
        post(
          baseBatch({
            template: {
              ...TEMPLATE,
              html: `${TEMPLATE.html}<img src="cid:logo">`,
              inlineImages: [{ cid: 'logo', part: 'logo' }],
            },
          }),
          [...baseFiles, { name: 'logo', filename: 'logo.pdf', content: PDF }],
        ),
      422,
      'TEMPLATE_REJECTED',
    );
    expect(response.json()).toMatchObject({ errors: [{ code: 'INLINE_IMAGE_NOT_IMAGE' }] });

    const ok = await post(
      baseBatch({
        template: {
          ...TEMPLATE,
          html: `${TEMPLATE.html}<img src="cid:logo">`,
          inlineImages: [{ cid: 'logo', part: 'logo' }],
        },
      }),
      [...baseFiles, { name: 'logo', filename: 'logo.png', content: PNG }],
    );
    expect(ok.statusCode, ok.body).toBe(202);
    const message = await db
      .db()
      .collection('messages')
      .findOne({ batchId: ok.json<{ batchId: string }>().batchId });
    expect(message?.['inlineImages']).toEqual([
      expect.objectContaining({ cid: 'logo', contentType: 'image/png' }),
    ]);
  });
});

describe('POST /v1/batches - limits', () => {
  it('413 when the request exceeds the tenant limit', async () => {
    const small = await startTestStack({ maxRequestBytes: 1024 * 1024 });
    try {
      const body = multipart(baseBatch(), [
        baseFiles[0]!,
        {
          name: 'doc-4521',
          filename: 'sollecito.pdf',
          content: Buffer.concat([PDF, Buffer.alloc(1_100_000, 1)]),
        },
      ]);
      const response = await small.app.inject({
        method: 'POST',
        url: '/v1/batches',
        headers: { ...body.headers, authorization: `Bearer ${small.serfin.key}`, 'idempotency-key': 'k' },
        payload: body.payload,
      });

      expect(response.statusCode, response.body).toBe(413);
      expect(response.json()).toMatchObject({ code: 'REQUEST_TOO_LARGE' });
      expect(await readdir(join(small.storageDir, 'staging'))).toEqual([]);
    } finally {
      await small.stop();
    }
  });

  it('422 when the batch has more messages than the tenant allows', async () => {
    const tiny = await startTestStack({ maxMessagesPerBatch: 1 });
    try {
      const body = multipart(baseBatch(), baseFiles);
      const response = await tiny.app.inject({
        method: 'POST',
        url: '/v1/batches',
        headers: { ...body.headers, authorization: `Bearer ${tiny.serfin.key}`, 'idempotency-key': 'k' },
        payload: body.payload,
      });

      expect(response.statusCode, response.body).toBe(422);
      expect(response.json()).toMatchObject({ code: 'TOO_MANY_MESSAGES' });
    } finally {
      await tiny.stop();
    }
  });

  it('429 past the tenant request rate, with Retry-After', async () => {
    const limited = await startTestStack({ requestsPerMinute: 2 });
    try {
      const call = (): Promise<LightMyRequestResponse> =>
        limited.app.inject({
          method: 'GET',
          url: '/v1/mailboxes',
          headers: { authorization: `Bearer ${limited.serfin.key}` },
        });
      expect((await call()).statusCode).toBe(200);
      expect((await call()).statusCode).toBe(200);
      const third = await call();
      expect(third.statusCode).toBe(429);
      expect(third.headers['retry-after']).toMatch(/^\d+$/);
      expect(third.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' });

      const other = await limited.app.inject({
        method: 'GET',
        url: '/v1/mailboxes',
        headers: { authorization: `Bearer ${limited.iqera.key}` },
      });
      expect(other.statusCode).toBe(200);
    } finally {
      await limited.stop();
    }
  });
});
