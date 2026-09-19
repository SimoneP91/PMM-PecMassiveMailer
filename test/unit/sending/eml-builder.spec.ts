import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

import {
  EmlBuilder,
  idFromMessageId,
  messageIdFor,
  type OutgoingPec,
} from '../../../src/modules/sending/mime/eml-builder';
import { testMailbox } from '../../helpers/mailbox';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.4\n');

function pec(overrides: Partial<OutgoingPec> = {}): OutgoingPec {
  return {
    id: '7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f',
    to: { address: 'destinatario@pec.example', name: 'Mario Rossi' },
    subject: 'Sollecito pratica 1 – àèì',
    html: '<p>Gentile Mario,</p><img src="cid:logo">',
    attachments: [{ filename: 'sollecito-1.pdf', contentType: 'application/pdf', content: PDF }],
    inlineImages: [{ cid: 'logo', filename: 'logo.png', contentType: 'image/png', content: PNG }],
    ...overrides,
  };
}

const builder = new EmlBuilder({ now: () => new Date('2026-09-19T10:00:00Z') });

describe('EmlBuilder', () => {
  it('builds the whole MIME message in memory, with our Message-ID, attachments and inline images', async () => {
    const built = await builder.build(pec(), testMailbox());

    expect(built.messageIdHeader).toBe('<pm.7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f@pec.serfin.example>');
    const parsed = await simpleParser(built.raw);
    expect(parsed.messageId).toBe(built.messageIdHeader);
    expect(parsed.subject).toBe('Sollecito pratica 1 – àèì');
    expect(parsed.from?.text).toBe('"Serfin – Recupero Crediti" <solleciti@pec.serfin.example>');
    expect(parsed.to && 'text' in parsed.to ? parsed.to.text : '').toBe(
      '"Mario Rossi" <destinatario@pec.example>',
    );
    expect(parsed.html).toContain('Gentile Mario');
    expect(parsed.date?.toISOString()).toBe('2026-09-19T10:00:00.000Z');

    const files = parsed.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      cid: a.cid,
      inline: a.contentDisposition === 'inline',
      content: a.content,
    }));
    expect(files).toEqual([
      { filename: 'logo.png', contentType: 'image/png', cid: 'logo', inline: true, content: PNG },
      {
        filename: 'sollecito-1.pdf',
        contentType: 'application/pdf',
        cid: undefined,
        inline: false,
        content: PDF,
      },
    ]);
  });

  it('writes a plain address when there is no recipient name', async () => {
    const built = await builder.build(pec({ to: { address: 'destinatario@pec.example' } }), testMailbox());
    const parsed = await simpleParser(built.raw);

    expect(parsed.to && 'text' in parsed.to ? parsed.to.text : '').toBe('destinatario@pec.example');
  });

  it("adds no header that would reveal the sender's labels to the recipient", async () => {
    const built = await builder.build(pec(), testMailbox());
    const headers = built.raw.toString('utf8').split('\r\n\r\n')[0] ?? '';

    expect(headers).not.toMatch(/^x-pecmailer/im);
  });
});

describe('Message-ID', () => {
  it("carries the sender's id and gives it back", () => {
    const messageId = messageIdFor('abc-1.2_3', 'solleciti@pec.serfin.example');

    expect(messageId).toBe('<pm.abc-1.2_3@pec.serfin.example>');
    expect(idFromMessageId(messageId)).toBe('abc-1.2_3');
    expect(idFromMessageId(` ${messageId} `)).toBe('abc-1.2_3');
  });

  it('does not recognise any other message', () => {
    expect(idFromMessageId('<m_test000000000001@pec.serfin.example>')).toBeUndefined();
    expect(idFromMessageId('<opec21.123@pec.aruba.it>')).toBeUndefined();
    expect(idFromMessageId('<pm.@pec.it>')).toBeUndefined();
    expect(idFromMessageId(undefined)).toBeUndefined();
  });
});
