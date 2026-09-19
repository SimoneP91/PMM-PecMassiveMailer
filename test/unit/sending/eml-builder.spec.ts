import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { simpleParser } from 'mailparser';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Secret } from '../../../src/common/security/secret';
import { asBatchId, asMailboxCode, asMessageId, asTenantId } from '../../../src/common/types/branded';
import type { ResolvedMailbox } from '../../../src/config/config.loader';
import { parseEnv } from '../../../src/config/env.schema';
import { AttachmentStore } from '../../../src/modules/attachments/attachment-store';
import type { MessageDocument } from '../../../src/modules/batches/schemas/message.schema';
import { EmlBuilder } from '../../../src/modules/sending/mime/eml-builder';

let storageDir: string;
let store: AttachmentStore;
let builder: EmlBuilder;

const mailbox: ResolvedMailbox = {
  code: asMailboxCode('serfin-aruba'),
  tenantId: asTenantId('t_serfin'),
  provider: 'aruba',
  from: { address: 'solleciti@pec.serfin.example', name: 'Serfin – Recupero Crediti' },
  smtp: {
    host: 'h',
    port: 25,
    security: 'none',
    username: 'u',
    password: new Secret('p'),
    timeoutSeconds: 30,
  },
  imap: null,
  limits: { perMinute: 60, perDay: 0, maxMessageBytes: 30_000_000 },
};

function message(overrides: Partial<MessageDocument> = {}): MessageDocument {
  return {
    _id: asMessageId('m_test000000000001'),
    tenantId: asTenantId('t_serfin'),
    batchId: asBatchId('b_test000000000001'),
    mailbox: asMailboxCode('serfin-aruba'),
    ref: 'pratica-1',
    to: 'mario.rossi@pec.it',
    toName: 'Mario Rossi',
    subject: 'Sollecito pratica 1 – àèì',
    html: '<html><body><p>Gentile Mario,</p><img src="cid:logo"></body></html>',
    attachments: [
      {
        part: 'doc',
        filename: 'sollecito-1.pdf',
        contentType: 'application/pdf',
        size: 9,
        sha256: 'x',
        path: 'batches/t_serfin/b_test000000000001/parts/doc',
      },
    ],
    inlineImages: [
      {
        cid: 'logo',
        part: 'logo',
        contentType: 'image/png',
        path: 'batches/t_serfin/b_test000000000001/parts/logo',
      },
    ],
    estimatedBytes: 1000,
    recipientCheck: 'PEC',
    status: 'SENDING',
    settlement: 'PENDING',
    attempts: 1,
    nextAttemptAt: new Date(),
    sentCopy: 'PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeAll(async () => {
  storageDir = await mkdtemp(join(tmpdir(), 'pecmailer-eml-'));
  const env = parseEnv({ MONGODB_URI: 'mongodb://unused/x', STORAGE_DIR: storageDir });
  store = new AttachmentStore(env);
  builder = new EmlBuilder(store, { now: () => new Date('2026-09-19T10:00:00Z') });
  const parts = store.absolute('batches/t_serfin/b_test000000000001/parts');
  await rm(parts, { recursive: true, force: true });
  await (await import('node:fs/promises')).mkdir(parts, { recursive: true });
  await writeFile(join(parts, 'doc'), '%PDF-1.4\n');
  await writeFile(
    join(parts, 'logo'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
  );
});

afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('EmlBuilder', () => {
  it('writes a complete MIME message with our Message-ID, attachments and inline images', async () => {
    const built = await builder.build(message(), mailbox);

    expect(built.messageIdHeader).toBe('<m_test000000000001@pec.serfin.example>');
    expect(built.relativePath).toBe('batches/t_serfin/b_test000000000001/eml/m_test000000000001.eml');

    const parsed = await simpleParser(await readFile(built.path));
    expect(parsed.messageId).toBe('<m_test000000000001@pec.serfin.example>');
    expect(parsed.subject).toBe('Sollecito pratica 1 – àèì');
    expect(parsed.from?.text).toBe('"Serfin – Recupero Crediti" <solleciti@pec.serfin.example>');
    expect(parsed.to && 'text' in parsed.to ? parsed.to.text : '').toBe('"Mario Rossi" <mario.rossi@pec.it>');
    expect(parsed.html).toContain('Gentile Mario');
    expect(parsed.headers.get('x-pecmailer-message-id')).toBe('m_test000000000001');
    expect(parsed.headers.get('x-pecmailer-batch-id')).toBe('b_test000000000001');
    expect(parsed.date?.toISOString()).toBe('2026-09-19T10:00:00.000Z');

    const attachments = parsed.attachments.map((a) => ({
      filename: a.filename,
      type: a.contentType,
      cid: a.cid,
      size: a.size,
    }));
    expect(attachments).toEqual(
      expect.arrayContaining([
        { filename: 'sollecito-1.pdf', type: 'application/pdf', cid: undefined, size: 9 },
        { filename: 'logo', type: 'image/png', cid: 'logo', size: 11 },
      ]),
    );
  });

  it('uses the bare address when the recipient has no name', async () => {
    const { toName: _dropped, ...withoutName } = message({ _id: asMessageId('m_test000000000002') });
    const built = await builder.build(withoutName, mailbox);
    const parsed = await simpleParser(await readFile(built.path));

    expect(parsed.to && 'text' in parsed.to ? parsed.to.text : '').toBe('mario.rossi@pec.it');
  });

  it('fails when an attachment file is missing', async () => {
    const broken = message({
      _id: asMessageId('m_test000000000003'),
      attachments: [
        {
          part: 'x',
          filename: 'x.pdf',
          contentType: 'application/pdf',
          size: 1,
          sha256: 'x',
          path: 'batches/t_serfin/b_test000000000001/parts/missing',
        },
      ],
    });

    await expect(builder.build(broken, mailbox)).rejects.toThrow();
  });
});
