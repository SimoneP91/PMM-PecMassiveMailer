import type { FastifyRequest } from 'fastify';

import { AppError } from '../../common/errors/app-error';
import type { AttachmentStore, StagedFile, StagingArea } from '../attachments/attachment-store';

export const BATCH_PART = 'batch';
const MAX_BATCH_JSON_BYTES = 8 * 1024 * 1024;
const PART_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface ReceivedFile extends StagedFile {
  readonly part: string;
  /** File name sent with the part; the default name the recipient sees. */
  readonly filename: string;
}

export interface ReceivedRequest {
  readonly staging: StagingArea;
  /** Raw JSON text of the "batch" part, parsed later so a syntax error is reported precisely. */
  readonly batchJson: string;
  readonly files: ReadonlyMap<string, ReceivedFile>;
  readonly totalBytes: number;
}

export interface IntakeLimits {
  readonly maxRequestBytes: number;
}

/**
 * A field sent with "Content-Type: application/json" reaches us already
 * parsed by the multipart plugin; it is serialised back so that one code path
 * validates it and the idempotency fingerprint sees the same bytes each time.
 */
function fieldText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return JSON.stringify(value);
}

/**
 * Reads a multipart request part by part: the "batch" JSON is kept in memory
 * (it is bounded), every file is streamed to the staging area. Whatever goes
 * wrong, the caller owns the staging area and must discard it.
 */
export async function receiveMultipart(
  request: FastifyRequest,
  store: AttachmentStore,
  staging: StagingArea,
  limits: IntakeLimits,
): Promise<ReceivedRequest> {
  if (!request.isMultipart()) {
    throw AppError.unsupportedMediaType('MULTIPART_REQUIRED', 'multipart/form-data required', {
      detail: 'Send the "batch" JSON as a form part and every attachment as a file part of the same request',
    });
  }

  const files = new Map<string, ReceivedFile>();
  let batchJson: string | undefined;
  let totalBytes = 0;

  const overLimit = (): never => {
    throw AppError.payloadTooLarge('REQUEST_TOO_LARGE', 'Request too large', {
      detail: `the request exceeds ${String(limits.maxRequestBytes)} bytes; split the batch`,
    });
  };

  for await (const part of request.parts({ limits: { fileSize: limits.maxRequestBytes, parts: 6000 } })) {
    const name = part.fieldname;
    if (!PART_NAME.test(name)) {
      throw AppError.badRequest('INVALID_PART_NAME', 'Invalid part name', {
        detail: `part "${name.slice(0, 80)}": letters, digits, ".", "_" and "-" only, up to 64 characters`,
      });
    }

    if (name === BATCH_PART) {
      if (batchJson !== undefined) {
        throw AppError.badRequest('DUPLICATE_PART', 'Duplicate part', {
          detail: 'the "batch" part appears twice',
        });
      }
      batchJson = part.type === 'field' ? fieldText(part.value) : (await part.toBuffer()).toString('utf8');
      totalBytes += Buffer.byteLength(batchJson);
      if (batchJson.length > MAX_BATCH_JSON_BYTES || totalBytes > limits.maxRequestBytes) {
        overLimit();
      }
      continue;
    }

    if (part.type !== 'file') {
      throw AppError.badRequest('UNEXPECTED_FIELD', 'Unexpected form field', {
        detail: `"${name}" is not a file; the only non-file part is "batch"`,
      });
    }
    if (files.has(name)) {
      throw AppError.badRequest('DUPLICATE_PART', 'Duplicate part', {
        detail: `file part "${name}" appears twice`,
      });
    }
    if (part.filename === '') {
      throw AppError.badRequest('FILENAME_REQUIRED', 'File name required', {
        detail: `file part "${name}" has no filename; it is what the recipient will see`,
      });
    }

    const staged = await store.stage(staging, name, part.file, () => part.file.truncated);
    totalBytes += staged.size;
    if (staged.truncated || totalBytes > limits.maxRequestBytes) {
      overLimit();
    }
    files.set(name, { ...staged, part: name, filename: part.filename });
  }

  if (batchJson === undefined) {
    throw AppError.badRequest('MISSING_BATCH_PART', 'Missing "batch" part', {
      detail: 'the request must contain a form part named "batch" with the JSON description of the batch',
    });
  }

  return { staging, batchJson, files, totalBytes };
}
