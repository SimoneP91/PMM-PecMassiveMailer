import { describe, expect, it } from 'vitest';

import { containing } from '../../helpers/matchers';

import {
  checkAttachmentType,
  detectKind,
  extensionOf,
} from '../../../src/modules/attachments/attachment-type';

const b = (...bytes: number[]): Buffer => Buffer.from(bytes);

describe('detectKind', () => {
  it.each([
    ['pdf', Buffer.from('%PDF-1.7\n')],
    ['png', b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0)],
    ['jpeg', b(0xff, 0xd8, 0xff, 0xe0)],
    ['gif', Buffer.from('GIF89a')],
    ['zip', b(0x50, 0x4b, 0x03, 0x04)],
    ['ole', b(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)],
    ['executable', Buffer.from('MZ\x90\x00')],
    ['executable', b(0x7f, 0x45, 0x4c, 0x46)],
    ['executable', Buffer.from('#!/bin/sh\n')],
    ['der', b(0x30, 0x82, 0x01, 0x00)],
    ['pem', Buffer.from('-----BEGIN PKCS7-----')],
    ['xml', Buffer.from('﻿<?xml version="1.0"?>')],
    ['xml', Buffer.from('  <FatturaElettronica>')],
    ['text', Buffer.from('nome;importo\nRossi;12')],
    ['binary', b(0x00, 0x01, 0x02)],
  ])('detects %s', (kind, head) => {
    expect(detectKind(head)).toBe(kind);
  });
});

describe('checkAttachmentType', () => {
  it('accepts matching extension and content', () => {
    expect(checkAttachmentType('fattura.PDF', Buffer.from('%PDF-1.4'))).toMatchObject({
      ok: true,
      contentType: 'application/pdf',
      extension: 'pdf',
    });
    expect(checkAttachmentType('doc.docx', b(0x50, 0x4b, 0x03, 0x04))).toMatchObject({
      ok: true,
      contentType: containing('wordprocessingml'),
    });
    expect(checkAttachmentType('firmato.p7m', b(0x30, 0x82, 0x10))).toMatchObject({
      ok: true,
      contentType: 'application/pkcs7-mime',
    });
    expect(checkAttachmentType('dati.csv', Buffer.from('a;b'))).toMatchObject({ ok: true });
  });

  it('refuses executables whatever their name', () => {
    expect(checkAttachmentType('innocuo.pdf', Buffer.from('MZ\x90'))).toMatchObject({
      ok: false,
      code: 'EXECUTABLE',
    });
    expect(checkAttachmentType('script.txt', Buffer.from('#!/bin/bash'))).toMatchObject({
      ok: false,
      code: 'EXECUTABLE',
    });
  });

  it('refuses extensions outside the list', () => {
    for (const name of ['virus.exe', 'run.bat', 'x.js', 'x.html', 'noext', 'x.']) {
      expect(checkAttachmentType(name, Buffer.from('anything'))).toMatchObject({
        ok: false,
        code: 'EXTENSION_NOT_ALLOWED',
      });
    }
  });

  it('refuses content that contradicts the extension', () => {
    expect(checkAttachmentType('foto.jpg', Buffer.from('%PDF-'))).toMatchObject({
      ok: false,
      code: 'CONTENT_MISMATCH',
    });
    expect(checkAttachmentType('doc.pdf', b(0x00, 0x00))).toMatchObject({
      ok: false,
      code: 'CONTENT_MISMATCH',
    });
    expect(checkAttachmentType('note.txt', b(0x00, 0x01))).toMatchObject({
      ok: false,
      code: 'CONTENT_MISMATCH',
    });
  });
});

describe('extensionOf', () => {
  it('lower-cases and handles edge cases', () => {
    expect(extensionOf('A.PDF')).toBe('pdf');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('none')).toBe('');
  });
});
