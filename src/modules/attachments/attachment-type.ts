/**
 * Minimal but real type checking for attachments. The service is a dispatcher,
 * not a malware scanner: it refuses what is plainly wrong (an executable named
 * .pdf, an extension nobody sends by PEC) and lets documents through.
 *
 * The decision uses the file's first bytes, never the declared content type.
 */

export type ContentKind =
  'pdf' | 'png' | 'jpeg' | 'gif' | 'zip' | 'ole' | 'der' | 'pem' | 'xml' | 'text' | 'executable' | 'binary';

interface Signature {
  readonly kind: ContentKind;
  readonly bytes: readonly number[];
  readonly offset?: number;
}

const SIGNATURES: readonly Signature[] = [
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { kind: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { kind: 'gif', bytes: [0x47, 0x49, 0x46, 0x38] }, // GIF8
  { kind: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { kind: 'zip', bytes: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { kind: 'ole', bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { kind: 'executable', bytes: [0x4d, 0x5a] }, // MZ: exe, dll, msi stubs
  { kind: 'executable', bytes: [0x7f, 0x45, 0x4c, 0x46] }, // ELF
  { kind: 'executable', bytes: [0xcf, 0xfa, 0xed, 0xfe] }, // Mach-O
  { kind: 'executable', bytes: [0xce, 0xfa, 0xed, 0xfe] },
  { kind: 'executable', bytes: [0xfe, 0xed, 0xfa, 0xce] },
  { kind: 'executable', bytes: [0xfe, 0xed, 0xfa, 0xcf] },
  { kind: 'executable', bytes: [0x23, 0x21] }, // #! script
];

export function detectKind(head: Buffer): ContentKind {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (
      head.length >= offset + signature.bytes.length &&
      signature.bytes.every((byte, i) => head[offset + i] === byte)
    ) {
      return signature.kind;
    }
  }

  const text = head.toString('latin1');
  if (text.startsWith('-----BEGIN ')) {
    return 'pem';
  }
  // DER SEQUENCE with a long-form length: what a CMS/PKCS#7 envelope starts with.
  if (head.length >= 2 && head[0] === 0x30 && (head[1] ?? 0) >= 0x80) {
    return 'der';
  }
  // A UTF-8 BOM read as latin1 is the three bytes EF BB BF.
  if (/^(\xEF\xBB\xBF)?\s*<\?xml/i.test(text) || /^\s*<[A-Za-z]/.test(text)) {
    return 'xml';
  }
  if (!head.includes(0)) {
    return 'text';
  }

  return 'binary';
}

interface AllowedExtension {
  readonly contentType: string;
  readonly kinds: readonly ContentKind[];
}

const ALLOWED_EXTENSIONS: Readonly<Record<string, AllowedExtension>> = {
  pdf: { contentType: 'application/pdf', kinds: ['pdf'] },
  png: { contentType: 'image/png', kinds: ['png'] },
  jpg: { contentType: 'image/jpeg', kinds: ['jpeg'] },
  jpeg: { contentType: 'image/jpeg', kinds: ['jpeg'] },
  gif: { contentType: 'image/gif', kinds: ['gif'] },
  p7m: { contentType: 'application/pkcs7-mime', kinds: ['der', 'pem'] },
  xml: { contentType: 'application/xml', kinds: ['xml', 'text'] },
  txt: { contentType: 'text/plain', kinds: ['text', 'xml'] },
  csv: { contentType: 'text/csv', kinds: ['text'] },
  rtf: { contentType: 'application/rtf', kinds: ['text'] },
  eml: { contentType: 'message/rfc822', kinds: ['text'] },
  zip: { contentType: 'application/zip', kinds: ['zip'] },
  docx: {
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    kinds: ['zip'],
  },
  xlsx: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kinds: ['zip'] },
  pptx: {
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    kinds: ['zip'],
  },
  odt: { contentType: 'application/vnd.oasis.opendocument.text', kinds: ['zip'] },
  ods: { contentType: 'application/vnd.oasis.opendocument.spreadsheet', kinds: ['zip'] },
  doc: { contentType: 'application/msword', kinds: ['ole'] },
  xls: { contentType: 'application/vnd.ms-excel', kinds: ['ole'] },
  ppt: { contentType: 'application/vnd.ms-powerpoint', kinds: ['ole'] },
};

export const INLINE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(['png', 'jpg', 'jpeg', 'gif']);

export type AttachmentTypeResult =
  | {
      readonly ok: true;
      readonly extension: string;
      readonly contentType: string;
      readonly kind: ContentKind;
    }
  | {
      readonly ok: false;
      readonly code: 'EXTENSION_NOT_ALLOWED' | 'EXECUTABLE' | 'CONTENT_MISMATCH';
      readonly detail: string;
    };

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');

  return dot <= 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function checkAttachmentType(filename: string, head: Buffer): AttachmentTypeResult {
  const extension = extensionOf(filename);
  const allowed = ALLOWED_EXTENSIONS[extension];
  if (allowed === undefined) {
    return {
      ok: false,
      code: 'EXTENSION_NOT_ALLOWED',
      detail: `"${filename}": extension ${extension === '' ? '(none)' : `.${extension}`} is not accepted; allowed: ${Object.keys(
        ALLOWED_EXTENSIONS,
      )
        .map((e) => `.${e}`)
        .join(' ')}`,
    };
  }

  const kind = detectKind(head);
  if (kind === 'executable') {
    return { ok: false, code: 'EXECUTABLE', detail: `"${filename}" is an executable or a script` };
  }
  if (!allowed.kinds.includes(kind)) {
    return {
      ok: false,
      code: 'CONTENT_MISMATCH',
      detail: `"${filename}": the content (${kind}) does not match a .${extension} file`,
    };
  }

  return { ok: true, extension, contentType: allowed.contentType, kind };
}
