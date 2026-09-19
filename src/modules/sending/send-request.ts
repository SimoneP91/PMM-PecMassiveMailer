import { z } from 'zod';

import type { FieldError } from '../../common/field-error';
import { checkAttachmentType, detectKind } from '../attachments/attachment-type';
import type { RecipientVerification } from '../recipients/recipient-verifier';
import { checkHtmlPolicy } from '../templates/html-policy';
import type { OutgoingPec } from './mime/eml-builder';

/**
 * A PEC as it arrives in the input queue (docs/asyncapi.yaml, SendRequest),
 * and the checks it must pass before anything is sent. Every problem found
 * is reported, not just the first, so the sender fixes a message once.
 */

export const MAX_HTML_BYTES = 512 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
const CONTROL = /[\u0000-\u001f\u007f]/;

const noControl = (value: string): boolean => !CONTROL.test(value);
const filename = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => noControl(value) && !/[\\/]/.test(value), 'a file name, without path separators');
const content = z
  .string()
  .transform((value) => value.replace(/\s+/g, ''))
  .refine((value) => BASE64.test(value), 'base64 content')
  .transform((value) => Buffer.from(value, 'base64'));

export const sendRequestSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().regex(ID, 'letters, digits, ".", "_" and "-", up to 64 characters'),
  reference: z.string().min(1).max(200).optional(),
  batch: z.string().min(1).max(200).optional(),
  to: z.strictObject({
    address: z.email().max(254),
    name: z.string().min(1).max(200).refine(noControl, 'no line breaks or control characters').optional(),
  }),
  subject: z.string().min(1).max(500).refine(noControl, 'no line breaks or control characters'),
  html: z
    .string()
    .min(1)
    .refine((value) => Buffer.byteLength(value) <= MAX_HTML_BYTES, `at most ${String(MAX_HTML_BYTES)} bytes`),
  attachments: z.array(z.strictObject({ filename, content })).max(50).default([]),
  inlineImages: z
    .array(
      z.strictObject({
        cid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/, 'letters, digits, ".", "_" and "-"'),
        filename: filename.optional(),
        content,
      }),
    )
    .max(20)
    .default([]),
  options: z.strictObject({ unverifiedRecipient: z.enum(['reject', 'send']).optional() }).optional(),
});

/** What identifies a PEC in its outcome events: known even when the rest of the message is wrong. */
export interface PecLabels {
  readonly id: string;
  readonly reference?: string;
  readonly batch?: string;
}

/** The labels of a message, when it has a usable id; undefined when it cannot be answered at all. */
export function labelsOf(body: unknown): PecLabels | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const { id, reference, batch } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !ID.test(id)) {
    return undefined;
  }
  const label = (value: unknown): string | undefined =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined;
  const referenceLabel = label(reference);
  const batchLabel = label(batch);

  return {
    id,
    ...(referenceLabel === undefined ? {} : { reference: referenceLabel }),
    ...(batchLabel === undefined ? {} : { batch: batchLabel }),
  };
}

export type CheckedRequest =
  | { readonly ok: true; readonly pec: OutgoingPec; readonly warnings: readonly FieldError[] }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

function pathOf(path: readonly PropertyKey[]): string {
  return path.reduce<string>(
    (text, key) =>
      typeof key === 'number'
        ? `${text}[${String(key)}]`
        : text === ''
          ? String(key)
          : `${text}.${String(key)}`,
    '',
  );
}

const IMAGE_TYPES: Readonly<Record<string, { readonly extension: string; readonly contentType: string }>> = {
  png: { extension: 'png', contentType: 'image/png' },
  jpeg: { extension: 'jpg', contentType: 'image/jpeg' },
  gif: { extension: 'gif', contentType: 'image/gif' },
};

export class SendRequestChecker {
  public constructor(
    private readonly recipients: { verify(address: string): Promise<RecipientVerification> },
    private readonly unverifiedDefault: 'reject' | 'send',
  ) {}

  public async check(body: unknown): Promise<CheckedRequest> {
    const parsed = sendRequestSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((issue) => ({
          path: pathOf(issue.path),
          code: 'INVALID_MESSAGE',
          detail: issue.message,
        })),
      };
    }
    const request = parsed.data;
    const errors: FieldError[] = [];
    const warnings: FieldError[] = [];

    const html = checkHtmlPolicy(request.html, 'html');
    errors.push(...html.errors);

    const attachments: OutgoingPec['attachments'][number][] = [];
    request.attachments.forEach((attachment, i) => {
      const type = checkAttachmentType(attachment.filename, attachment.content);
      if (type.ok) {
        attachments.push({
          filename: attachment.filename,
          contentType: type.contentType,
          content: attachment.content,
        });
      } else {
        errors.push({ path: `attachments[${String(i)}]`, code: type.code, detail: type.detail });
      }
    });

    const inlineImages: OutgoingPec['inlineImages'][number][] = [];
    request.inlineImages.forEach((image, i) => {
      const type = IMAGE_TYPES[detectKind(image.content)];
      if (type === undefined) {
        errors.push({
          path: `inlineImages[${String(i)}]`,
          code: 'INLINE_IMAGE_NOT_IMAGE',
          detail: `"${image.cid}" is not a PNG, JPEG or GIF image`,
        });

        return;
      }
      inlineImages.push({
        cid: image.cid,
        filename: image.filename ?? `${image.cid}.${type.extension}`,
        contentType: type.contentType,
        content: image.content,
      });
    });
    const declared = new Set(request.inlineImages.map((image) => image.cid));
    for (const cid of html.cidReferences) {
      if (!declared.has(cid)) {
        errors.push({
          path: 'html',
          code: 'UNDECLARED_INLINE_IMAGE',
          detail: `cid:${cid} is not among the inline images`,
        });
      }
    }
    for (const cid of declared) {
      if (!html.cidReferences.has(cid)) {
        warnings.push({
          path: 'inlineImages',
          code: 'UNUSED_INLINE_IMAGE',
          detail: `"${cid}" is never used in the HTML`,
        });
      }
    }

    const verdict = await this.recipients.verify(request.to.address);
    const unverified = request.options?.unverifiedRecipient ?? this.unverifiedDefault;
    if (verdict.verdict === 'NOT_PEC') {
      errors.push({ path: 'to.address', code: 'RECIPIENT_NOT_PEC', detail: verdict.detail });
    } else if (verdict.verdict === 'UNDETERMINED' && unverified === 'reject') {
      errors.push({ path: 'to.address', code: 'RECIPIENT_UNVERIFIED', detail: verdict.detail });
    }

    if (errors.length > 0) {
      return { ok: false, errors };
    }

    return {
      ok: true,
      warnings,
      pec: {
        id: request.id,
        to:
          request.to.name === undefined
            ? { address: request.to.address }
            : { address: request.to.address, name: request.to.name },
        subject: request.subject,
        html: request.html,
        attachments,
        inlineImages,
      },
    };
  }
}
