import { randomBytes } from 'node:crypto';

/** Builds a multipart/form-data body by hand, the way a client library would. */
export interface FilePart {
  readonly name: string;
  readonly filename: string;
  readonly content: Buffer | string;
  readonly contentType?: string;
}

export interface MultipartPayload {
  readonly payload: Buffer;
  readonly headers: { readonly 'content-type': string };
}

export function multipart(
  batch: unknown,
  files: readonly FilePart[] = [],
  batchPartName = 'batch',
  batchContentType = 'application/json',
): MultipartPayload {
  const boundary = `----pecmailer${randomBytes(8).toString('hex')}`;
  const chunks: Buffer[] = [];
  const push = (text: string): void => {
    chunks.push(Buffer.from(text, 'utf8'));
  };

  if (batch !== undefined) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${batchPartName}"\r\nContent-Type: ${batchContentType}\r\n\r\n`,
    );
    push(typeof batch === 'string' ? batch : JSON.stringify(batch));
    push('\r\n');
  }
  for (const file of files) {
    push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType ?? 'application/octet-stream'}\r\n\r\n`,
    );
    chunks.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8'));
    push('\r\n');
  }
  push(`--${boundary}--\r\n`);

  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'latin1'),
  randomBytes(64),
]);
export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(32),
]);
export const EXE = Buffer.concat([Buffer.from('MZ'), randomBytes(64)]);
