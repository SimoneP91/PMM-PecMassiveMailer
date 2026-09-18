import { describe, expect, it } from 'vitest';

import { formatPath } from '../../../src/common/errors/zod-errors';
import { batchRequestSchema } from '../../../src/modules/batches/batch-request.schema';
import { base64Size, estimateMessageBytes } from '../../../src/modules/batches/message-size';
import { requestFingerprint } from '../../../src/modules/batches/request-fingerprint';
import type { ReceivedFile, ReceivedRequest } from '../../../src/modules/batches/multipart-intake';

const minimal = {
  mailbox: 'serfin-aruba',
  template: { subject: 's', html: '<p>x</p>' },
  messages: [{ ref: 'a', to: 'a@pec.it' }],
};

const paths = (input: unknown): string[] => {
  const result = batchRequestSchema.safeParse(input);

  return result.success ? [] : result.error.issues.map((issue) => formatPath(issue.path));
};

describe('batchRequestSchema', () => {
  it('fills the defaults', () => {
    const parsed = batchRequestSchema.parse(minimal);

    expect(parsed.options).toEqual({ atomic: false, dryRun: false, unverifiedRecipients: 'reject' });
    expect(parsed.template.inlineImages).toEqual([]);
  });

  it('accepts string, number and boolean vars', () => {
    expect(
      paths({ ...minimal, messages: [{ ref: 'a', to: 'a@pec.it', vars: { s: 'x', n: 1, b: true } }] }),
    ).toEqual([]);
  });

  it.each([
    ['bad address', { ...minimal, messages: [{ ref: 'a', to: 'nope' }] }, 'messages[0].to'],
    ['missing ref', { ...minimal, messages: [{ to: 'a@pec.it' }] }, 'messages[0].ref'],
    [
      'bad var name',
      { ...minimal, messages: [{ ref: 'a', to: 'a@pec.it', vars: { '1x': 'v' } }] },
      'messages[0].vars.1x',
    ],
    [
      'object var',
      { ...minimal, messages: [{ ref: 'a', to: 'a@pec.it', vars: { x: {} } }] },
      'messages[0].vars.x',
    ],
    [
      'bad part name',
      { ...minimal, messages: [{ ref: 'a', to: 'a@pec.it', attachments: [{ part: '../x' }] }] },
      'messages[0].attachments[0].part',
    ],
    [
      'path in filename',
      {
        ...minimal,
        messages: [{ ref: 'a', to: 'a@pec.it', attachments: [{ part: 'p', filename: 'a/b.pdf' }] }],
      },
      'messages[0].attachments[0].filename',
    ],
    [
      'bad cid',
      { ...minimal, template: { ...minimal.template, inlineImages: [{ cid: 'a b', part: 'p' }] } },
      'template.inlineImages[0].cid',
    ],
    [
      'bad option',
      { ...minimal, options: { unverifiedRecipients: 'maybe' } },
      'options.unverifiedRecipients',
    ],
    ['long subTenant', { ...minimal, subTenant: 'x'.repeat(65) }, 'subTenant'],
  ])('rejects %s', (_name, input, path) => {
    expect(paths(input)).toContain(path);
  });

  it('rejects unknown keys, naming them', () => {
    const result = batchRequestSchema.safeParse({ ...minimal, extra: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain('extra');
    }
  });

  it('stops at the hard ceiling of 5000 messages', () => {
    const messages = Array.from({ length: 5001 }, (_, i) => ({ ref: String(i), to: 'a@pec.it' }));
    expect(paths({ ...minimal, messages })).toEqual(['messages']);
  });
});

describe('estimateMessageBytes', () => {
  it('counts base64 expansion and overhead', () => {
    expect(base64Size(3)).toBe(4);
    expect(base64Size(4)).toBe(8);
    const estimate = estimateMessageBytes({ subject: 'x', html: 'a'.repeat(300), partSizes: [3000, 30] });
    expect(estimate).toBeGreaterThan(300 + 3030);
    expect(estimate).toBeLessThan(4096 + 400 + 3 * 1024 + 4000 + 40);
  });
});

describe('requestFingerprint', () => {
  const file = (part: string, sha256: string, size = 10): ReceivedFile => ({
    part,
    filename: `${part}.pdf`,
    path: '',
    size,
    sha256,
    head: Buffer.alloc(0),
    truncated: false,
  });
  const received = (batchJson: string, files: ReceivedFile[]): ReceivedRequest => ({
    staging: { id: 'r', dir: '' },
    batchJson,
    files: new Map(files.map((f) => [f.part, f])),
    totalBytes: 0,
  });

  it('ignores file order but not file content, names or the JSON', () => {
    const a = requestFingerprint(received('{"x":1}', [file('a', '1'), file('b', '2')]));

    expect(requestFingerprint(received('{"x":1}', [file('b', '2'), file('a', '1')]))).toBe(a);
    expect(requestFingerprint(received('{"x":2}', [file('a', '1'), file('b', '2')]))).not.toBe(a);
    expect(requestFingerprint(received('{"x":1}', [file('a', '1'), file('b', '3')]))).not.toBe(a);
    expect(requestFingerprint(received('{"x":1}', [file('a', '1'), file('c', '2')]))).not.toBe(a);
    expect(requestFingerprint(received('{"x":1}', [file('a', '1'), file('b', '2', 11)]))).not.toBe(a);
  });
});

describe('formatPath', () => {
  it('uses brackets for indexes and dots for keys', () => {
    expect(formatPath(['messages', 3, 'attachments', 0, 'part'])).toBe('messages[3].attachments[0].part');
    expect(formatPath([])).toBe('');
    expect(formatPath([2])).toBe('[2]');
  });
});
