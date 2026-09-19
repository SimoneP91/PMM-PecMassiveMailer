import { describe, expect, it } from 'vitest';

import { labelsOf, SendRequestChecker } from '../../../src/modules/sending/send-request';
import { PDF, PNG, recipientsStub, sendRequest } from '../../helpers/sender-fakes';

const checker = new SendRequestChecker(recipientsStub, 'reject');

async function problems(body: unknown): Promise<{ code: string; path: string }[]> {
  const checked = await checker.check(body);

  return checked.ok ? [] : checked.errors.map(({ code, path }) => ({ code, path }));
}

describe('SendRequestChecker', () => {
  it('turns a valid request into the PEC to send, files decoded and typed', async () => {
    const checked = await checker.check(sendRequest());

    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.pec).toMatchObject({
        id: 'pec-0001',
        to: { address: 'destinatario@pec.example', name: 'Mario Rossi' },
        subject: 'Sollecito pratica 4521',
        attachments: [{ filename: 'sollecito.pdf', contentType: 'application/pdf', content: PDF }],
        inlineImages: [{ cid: 'logo', filename: 'logo.png', contentType: 'image/png', content: PNG }],
      });
      expect(checked.warnings).toEqual([]);
    }
  });

  it('points at every field that breaks the format, and refuses unknown fields', async () => {
    expect(
      await problems(
        sendRequest({
          version: 2,
          to: { address: 'not-an-address' },
          subject: 'line\nbreak',
          attachments: [{ filename: 'a/b.pdf', content: '***' }],
          colour: 'blue',
        }),
      ),
    ).toEqual([
      { code: 'INVALID_MESSAGE', path: 'version' },
      { code: 'INVALID_MESSAGE', path: 'to.address' },
      { code: 'INVALID_MESSAGE', path: 'subject' },
      { code: 'INVALID_MESSAGE', path: 'attachments[0].filename' },
      { code: 'INVALID_MESSAGE', path: 'attachments[0].content' },
      { code: 'INVALID_MESSAGE', path: '' },
    ]);
  });

  it('applies the HTML rules', async () => {
    expect(
      await problems(sendRequest({ html: '<p onclick="x()">a</p><script>1</script>', inlineImages: [] })),
    ).toEqual([
      { code: 'FORBIDDEN_ATTRIBUTE', path: 'html' },
      { code: 'FORBIDDEN_ELEMENT', path: 'html' },
    ]);
  });

  it('checks every attachment by its content, not its name', async () => {
    expect(
      await problems(
        sendRequest({
          attachments: [
            { filename: 'fattura.pdf', content: Buffer.from('MZ\x90\x00').toString('base64') },
            { filename: 'fattura.exe', content: PDF.toString('base64') },
            { filename: 'fattura.pdf', content: PNG.toString('base64') },
          ],
        }),
      ),
    ).toEqual([
      { code: 'EXECUTABLE', path: 'attachments[0]' },
      { code: 'EXTENSION_NOT_ALLOWED', path: 'attachments[1]' },
      { code: 'CONTENT_MISMATCH', path: 'attachments[2]' },
    ]);
  });

  it('matches the inline images with the cid references of the HTML', async () => {
    expect(await problems(sendRequest({ inlineImages: [] }))).toEqual([
      { code: 'UNDECLARED_INLINE_IMAGE', path: 'html' },
    ]);
    expect(
      await problems(sendRequest({ inlineImages: [{ cid: 'logo', content: PDF.toString('base64') }] })),
    ).toEqual([{ code: 'INLINE_IMAGE_NOT_IMAGE', path: 'inlineImages[0]' }]);

    const unused = await checker.check(
      sendRequest({
        inlineImages: [
          { cid: 'logo', content: PNG.toString('base64') },
          { cid: 'firma', content: PNG.toString('base64') },
        ],
      }),
    );
    expect(unused).toMatchObject({
      ok: true,
      warnings: [{ code: 'UNUSED_INLINE_IMAGE', path: 'inlineImages' }],
    });
  });

  it('refuses a recipient that is not PEC, and one that cannot be told unless the message says so', async () => {
    expect(await problems(sendRequest({ to: { address: 'mario@gmail.com' } }))).toEqual([
      { code: 'RECIPIENT_NOT_PEC', path: 'to.address' },
    ]);
    expect(await problems(sendRequest({ to: { address: 'mario@studio.example.org' } }))).toEqual([
      { code: 'RECIPIENT_UNVERIFIED', path: 'to.address' },
    ]);
    expect(
      await problems(
        sendRequest({
          to: { address: 'mario@studio.example.org' },
          options: { unverifiedRecipient: 'send' },
        }),
      ),
    ).toEqual([]);
  });

  it('refuses HTML over 512 KB', async () => {
    const html = `<p>${'a'.repeat(512 * 1024)}</p>`;

    expect(await problems(sendRequest({ html, inlineImages: [] }))).toEqual([
      { code: 'INVALID_MESSAGE', path: 'html' },
    ]);
  });
});

describe('labelsOf', () => {
  it('finds the id and the labels even in a message that breaks the rules', () => {
    expect(labelsOf({ id: 'pec-1', reference: 'r', batch: 'b', to: 42 })).toEqual({
      id: 'pec-1',
      reference: 'r',
      batch: 'b',
    });
    expect(labelsOf({ id: 'pec-1', reference: 7 })).toEqual({ id: 'pec-1' });
  });

  it('gives nothing to answer to without a usable id', () => {
    expect(labelsOf(undefined)).toBeUndefined();
    expect(labelsOf('text')).toBeUndefined();
    expect(labelsOf({ id: 'with spaces' })).toBeUndefined();
    expect(labelsOf({ reference: 'r' })).toBeUndefined();
  });
});
