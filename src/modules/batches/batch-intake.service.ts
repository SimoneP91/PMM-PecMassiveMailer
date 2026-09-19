import { join } from 'node:path';

import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PinoLogger } from 'nestjs-pino';

import { AppError, type FieldError } from '../../common/errors/app-error';
import { zodIssuesToFieldErrors } from '../../common/errors/zod-errors';
import { newBatchId, newMessageId } from '../../common/ids/id';
import { CLOCK, type Clock } from '../../common/time/clock';
import { asMailboxCode, type BatchId, type MessageId } from '../../common/types/branded';
import type { ResolvedMailbox, ResolvedTenant } from '../../config/config.loader';
import { AttachmentStore, type StagingArea } from '../attachments/attachment-store';
import { checkAttachmentType, extensionOf, INLINE_IMAGE_EXTENSIONS } from '../attachments/attachment-type';
import type { TenantContext } from '../auth/tenant-context';
import { MailboxRegistry } from '../mailboxes/mailbox.registry';
import { MailboxStateStore } from '../mailboxes/mailbox-state.store';
import { RecipientVerifier, type RecipientVerification } from '../recipients/recipient-verifier';
import { TenantRegistry } from '../tenants/tenant.registry';
import { compileTemplate, renderTemplate, type CompiledTemplate } from '../templates/template-compiler';
import {
  batchRequestSchema,
  DRY_RUN_PREVIEW_COUNT,
  type AttachmentRef,
  type BatchRequest,
} from './batch-request.schema';
import type { BatchAcceptedDto, BatchWarning, DryRunResultDto, RejectedMessage } from './batch-response.dto';
import { BatchRepository } from './batch.repository';
import { IDEMPOTENCY_HEADER, IdempotencyService } from './idempotency.service';
import { estimateMessageBytes } from './message-size';
import { receiveMultipart, type ReceivedFile, type ReceivedRequest } from './multipart-intake';
import { requestFingerprint } from './request-fingerprint';
import type { BatchDocument, StoredPart } from './schemas/batch.schema';
import type { MessageAttachment, MessageDocument, MessageInlineImage } from './schemas/message.schema';

export type IntakeOutcome =
  | {
      readonly kind: 'accepted';
      readonly body: BatchAcceptedDto;
      readonly location: string;
      readonly replayed: boolean;
    }
  | { readonly kind: 'dryRun'; readonly body: DryRunResultDto };

interface TypedPart extends ReceivedFile {
  readonly contentType: string;
  readonly extension: string;
}

interface AcceptedRow {
  readonly index: number;
  readonly ref: string;
  readonly to: string;
  readonly toName: string | undefined;
  readonly subTenant: string | undefined;
  readonly dedupKey: string | undefined;
  readonly subject: string;
  readonly html: string;
  readonly attachments: readonly { readonly part: TypedPart; readonly filename: string }[];
  readonly estimatedBytes: number;
  readonly recipientCheck: 'PEC' | 'UNVERIFIED';
}

interface RejectedRow extends RejectedMessage {
  readonly index: number;
  readonly path: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;
}

/**
 * POST /v1/batches, from the first byte of the request to the batch in the
 * database. Batch-level problems (4xx) create nothing; row-level problems
 * are listed in the 202 next to the rows that were accepted.
 */
@Injectable()
export class BatchIntakeService {
  public constructor(
    private readonly store: AttachmentStore,
    private readonly tenants: TenantRegistry,
    private readonly mailboxes: MailboxRegistry,
    private readonly mailboxStates: MailboxStateStore,
    private readonly recipients: RecipientVerifier,
    private readonly idempotency: IdempotencyService,
    private readonly repository: BatchRepository,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(BatchIntakeService.name);
  }

  public async submit(context: TenantContext, request: FastifyRequest): Promise<IntakeOutcome> {
    const tenant = this.tenants.get(context.tenantId);
    if (tenant === undefined) {
      throw new Error(`authenticated tenant ${context.tenantId} is not in the configuration`);
    }
    const headerKey = request.headers[IDEMPOTENCY_HEADER];
    const staging = await this.store.openStaging(request.id);
    let lockedKey: string | undefined;

    try {
      const received = await receiveMultipart(request, this.store, staging, {
        maxRequestBytes: tenant.limits.maxRequestBytes,
      });
      const batch = this.parseBatch(received.batchJson, tenant);
      const dryRun = batch.options.dryRun;
      const key = dryRun ? undefined : IdempotencyService.parseKey(headerKey);

      const mailbox = await this.resolveMailbox(tenant, batch.mailbox);
      const parts = this.checkParts(received);
      this.checkPartReferences(batch, parts);

      if (key !== undefined) {
        const start = await this.idempotency.begin(tenant.id, key, requestFingerprint(received));
        if (start.kind === 'replay') {
          await this.store.discard(staging);

          return {
            kind: 'accepted',
            body: start.response.body as BatchAcceptedDto,
            location: start.response.headers['location'] ?? '',
            replayed: true,
          };
        }
        lockedKey = key;
      }

      const compiled = compileTemplate(batch.template);
      if (!compiled.ok) {
        throw AppError.unprocessable('TEMPLATE_REJECTED', 'Template rejected', {
          detail: 'The template does not follow the rules; nothing was created',
          errors: compiled.errors,
        });
      }
      const warnings: BatchWarning[] = [...compiled.warnings];
      this.checkInlineImages(compiled.template, parts);

      const { accepted, rejected } = await this.processRows(
        tenant,
        mailbox,
        batch,
        compiled.template,
        parts,
        warnings,
      );

      if (batch.options.atomic && rejected.length > 0) {
        throw AppError.unprocessable('BATCH_REJECTED', 'Batch rejected (atomic)', {
          detail: `${String(rejected.length)} of ${String(batch.messages.length)} messages are invalid and options.atomic is true; nothing was created`,
          errors: rejected.map((row) => ({ path: row.path, code: row.code, detail: row.detail })),
        });
      }
      if (accepted.length === 0) {
        throw AppError.unprocessable('ALL_MESSAGES_REJECTED', 'Every message was rejected', {
          detail: 'No message could be queued; nothing was created',
          errors: rejected.map((row) => ({ path: row.path, code: row.code, detail: row.detail })),
        });
      }

      if (dryRun) {
        await this.store.discard(staging);

        return { kind: 'dryRun', body: this.dryRunBody(batch, accepted, rejected, warnings) };
      }

      const outcome = await this.persist(
        context,
        tenant,
        mailbox,
        batch,
        compiled.template,
        parts,
        staging,
        accepted,
        rejected,
        warnings,
        lockedKey ?? '',
        () => {
          // The batch exists from here on: whatever fails next, the key must
          // keep pointing at it, or a retry would create the batch twice.
          lockedKey = undefined;
        },
      );

      return outcome;
    } catch (error: unknown) {
      await this.store.discard(staging).catch(() => undefined);
      if (lockedKey !== undefined) {
        await this.idempotency.abandon(tenant.id, lockedKey).catch(() => undefined);
      }
      throw error;
    }
  }

  private parseBatch(json: string, tenant: ResolvedTenant): BatchRequest {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (error: unknown) {
      throw AppError.badRequest('INVALID_JSON', 'The "batch" part is not valid JSON', {
        detail: error instanceof Error ? error.message : 'syntax error',
      });
    }
    const parsed = batchRequestSchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest('VALIDATION_FAILED', 'The "batch" part is invalid', {
        errors: zodIssuesToFieldErrors(parsed.error.issues),
      });
    }
    const batch = parsed.data;

    if (batch.messages.length === 0) {
      throw AppError.unprocessable('EMPTY_BATCH', 'The batch has no messages');
    }
    const limit = tenant.limits.maxMessagesPerBatch;
    if (batch.messages.length > limit) {
      throw AppError.unprocessable('TOO_MANY_MESSAGES', 'Too many messages in one batch', {
        detail: `${String(batch.messages.length)} messages; at most ${String(limit)} per batch, split it`,
      });
    }
    const refs = new Set<string>();
    const duplicates: FieldError[] = [];
    batch.messages.forEach((message, i) => {
      if (refs.has(message.ref)) {
        duplicates.push({
          path: `messages[${String(i)}].ref`,
          code: 'DUPLICATE_REF',
          detail: `"${message.ref}" is used by an earlier message`,
        });
      }
      refs.add(message.ref);
    });
    if (duplicates.length > 0) {
      throw AppError.unprocessable('DUPLICATE_REF', 'Message refs must be unique within a batch', {
        errors: duplicates,
      });
    }

    return batch;
  }

  private async resolveMailbox(tenant: ResolvedTenant, code: string): Promise<ResolvedMailbox> {
    const mailbox = this.mailboxes.getForTenant(tenant.id, asMailboxCode(code));
    if (mailbox === undefined) {
      throw AppError.forbidden(
        'MAILBOX_NOT_AVAILABLE',
        `mailbox "${code}" is not one of yours (GET /v1/mailboxes lists them)`,
      );
    }
    const state = await this.mailboxStates.get(mailbox.code);
    if (state.status === 'SUSPENDED') {
      throw AppError.locked('MAILBOX_SUSPENDED', 'Mailbox suspended', {
        detail: `mailbox "${code}" is suspended${state.reason === undefined ? '' : `: ${state.reason}`}; nothing is accepted until an operator reactivates it`,
      });
    }

    return mailbox;
  }

  private checkParts(received: ReceivedRequest): ReadonlyMap<string, TypedPart> {
    const parts = new Map<string, TypedPart>();
    const errors: FieldError[] = [];
    for (const file of received.files.values()) {
      const type = checkAttachmentType(file.filename, file.head);
      if (!type.ok) {
        errors.push({ path: `parts.${file.part}`, code: type.code, detail: type.detail });
        continue;
      }
      parts.set(file.part, { ...file, contentType: type.contentType, extension: type.extension });
    }
    if (errors.length > 0) {
      throw AppError.unsupportedMediaType('ATTACHMENT_TYPE_REJECTED', 'A file is not an accepted type', {
        detail: 'The type is detected from the content, not from the name; nothing was created',
        errors,
      });
    }

    return parts;
  }

  private checkPartReferences(batch: BatchRequest, parts: ReadonlyMap<string, TypedPart>): void {
    const referenced = new Set<string>();
    const missing: FieldError[] = [];
    const reference = (part: string, path: string): void => {
      referenced.add(part);
      if (!parts.has(part)) {
        missing.push({ path, code: 'MISSING_PART', detail: `file part "${part}" is not in the request` });
      }
    };

    batch.template.inlineImages.forEach((image, i) => {
      reference(image.part, `template.inlineImages[${String(i)}].part`);
    });
    batch.defaults?.attachments?.forEach((attachment, i) => {
      reference(attachment.part, `defaults.attachments[${String(i)}].part`);
    });
    batch.messages.forEach((message, m) => {
      message.attachments?.forEach((attachment, a) => {
        reference(attachment.part, `messages[${String(m)}].attachments[${String(a)}].part`);
      });
    });

    if (missing.length > 0) {
      throw AppError.badRequest('MISSING_PART', 'A referenced file part is missing', { errors: missing });
    }
    const unreferenced = [...parts.keys()].filter((name) => !referenced.has(name));
    if (unreferenced.length > 0) {
      throw AppError.badRequest('UNREFERENCED_PART', 'A file part is not used by any message', {
        detail:
          'Every file must be referenced by the template, the defaults or a message; a typo in a part name is the usual cause',
        errors: unreferenced.map((name) => ({
          path: `parts.${name}`,
          code: 'UNREFERENCED_PART',
          detail: `file part "${name}" is not referenced`,
        })),
      });
    }
  }

  private checkInlineImages(template: CompiledTemplate, parts: ReadonlyMap<string, TypedPart>): void {
    const errors: FieldError[] = [];
    template.inlineImages.forEach((image, i) => {
      const part = parts.get(image.part);
      if (part !== undefined && !INLINE_IMAGE_EXTENSIONS.has(part.extension)) {
        errors.push({
          path: `template.inlineImages[${String(i)}].part`,
          code: 'INLINE_IMAGE_NOT_IMAGE',
          detail: `"${part.filename}" is not a PNG, JPEG or GIF image`,
        });
      }
    });
    if (errors.length > 0) {
      throw AppError.unprocessable('TEMPLATE_REJECTED', 'Template rejected', { errors });
    }
  }

  private async processRows(
    tenant: ResolvedTenant,
    mailbox: ResolvedMailbox,
    batch: BatchRequest,
    template: CompiledTemplate,
    parts: ReadonlyMap<string, TypedPart>,
    warnings: BatchWarning[],
  ): Promise<{ accepted: AcceptedRow[]; rejected: RejectedRow[] }> {
    const verdicts = await this.verifyRecipients(batch);
    const requestedKeys = batch.messages.flatMap((message) =>
      message.dedupKey === undefined ? [] : [message.dedupKey],
    );
    const usedKeys = await this.repository.findUsedDedupKeys(tenant.id, requestedKeys);
    const keysInBatch = new Map<string, string>();
    const inlineSizes = template.inlineImages.map((image) => parts.get(image.part)?.size ?? 0);
    const unusedVars = new Set<string>();

    const accepted: AcceptedRow[] = [];
    const rejected: RejectedRow[] = [];

    batch.messages.forEach((message, index) => {
      const path = `messages[${String(index)}]`;
      const reject = (code: string, detail: string, field = ''): void => {
        rejected.push({
          index,
          ref: message.ref,
          code,
          detail,
          path: field === '' ? path : `${path}.${field}`,
        });
      };

      const verdict = verdicts.get(message.to.toLowerCase());
      if (verdict === undefined || verdict.verdict === 'NOT_PEC') {
        reject('RECIPIENT_NOT_PEC', verdict?.detail ?? 'not a PEC address', 'to');

        return;
      }
      if (verdict.verdict === 'UNDETERMINED' && batch.options.unverifiedRecipients === 'reject') {
        reject(
          'RECIPIENT_UNVERIFIED',
          `${verdict.detail}; set options.unverifiedRecipients to "send" to accept it`,
          'to',
        );

        return;
      }

      if (message.dedupKey !== undefined) {
        const previous = usedKeys.get(message.dedupKey);
        if (previous !== undefined) {
          reject(
            'DUPLICATE_DEDUP_KEY',
            `dedupKey "${message.dedupKey}" was already used by message ${previous}`,
            'dedupKey',
          );

          return;
        }
        const earlier = keysInBatch.get(message.dedupKey);
        if (earlier !== undefined) {
          reject(
            'DUPLICATE_DEDUP_KEY',
            `dedupKey "${message.dedupKey}" is also used by ref "${earlier}" in this batch`,
            'dedupKey',
          );

          return;
        }
        keysInBatch.set(message.dedupKey, message.ref);
      }

      const values = new Map<string, string>();
      for (const source of [batch.defaults?.vars, message.vars]) {
        for (const [name, value] of Object.entries(source ?? {})) {
          values.set(name, String(value));
        }
      }
      const rendered = renderTemplate(template, values, path);
      if (!rendered.ok) {
        const first = rendered.errors[0];
        reject(first?.code ?? 'RENDER_FAILED', rendered.errors.map((error) => error.detail).join('; '));

        return;
      }
      for (const name of rendered.message.unusedVars) {
        unusedVars.add(name);
      }

      const attachments = this.resolveAttachments(
        [...(batch.defaults?.attachments ?? []), ...(message.attachments ?? [])],
        parts,
      );
      if (!attachments.ok) {
        reject(attachments.code, attachments.detail, 'attachments');

        return;
      }

      const estimatedBytes = estimateMessageBytes({
        subject: rendered.message.subject,
        html: rendered.message.html,
        partSizes: [...inlineSizes, ...attachments.list.map((attachment) => attachment.part.size)],
      });
      if (estimatedBytes > mailbox.limits.maxMessageBytes) {
        reject(
          'MESSAGE_TOO_LARGE',
          `about ${String(estimatedBytes)} bytes once encoded; the mailbox accepts ${String(mailbox.limits.maxMessageBytes)}`,
          'attachments',
        );

        return;
      }

      accepted.push({
        index,
        ref: message.ref,
        to: message.to,
        toName: message.toName,
        subTenant: message.subTenant ?? batch.subTenant,
        dedupKey: message.dedupKey,
        subject: rendered.message.subject,
        html: rendered.message.html,
        attachments: attachments.list,
        estimatedBytes,
        recipientCheck: verdict.verdict === 'PEC' ? 'PEC' : 'UNVERIFIED',
      });
    });

    if (unusedVars.size > 0) {
      warnings.push({
        code: 'UNUSED_VARS',
        detail: `not used by the template: ${[...unusedVars].sort().join(', ')}`,
      });
    }

    return { accepted, rejected };
  }

  private async verifyRecipients(batch: BatchRequest): Promise<ReadonlyMap<string, RecipientVerification>> {
    const addresses = [...new Set(batch.messages.map((message) => message.to.toLowerCase()))];
    const results = await Promise.all(addresses.map((address) => this.recipients.verify(address)));

    return new Map(
      addresses.map((address, i) => [
        address,
        results[i] ?? { verdict: 'UNDETERMINED', detail: 'not verified' },
      ]),
    );
  }

  private resolveAttachments(
    refs: readonly AttachmentRef[],
    parts: ReadonlyMap<string, TypedPart>,
  ):
    | { ok: true; list: { part: TypedPart; filename: string }[] }
    | { ok: false; code: string; detail: string } {
    const list: { part: TypedPart; filename: string }[] = [];
    const filenames = new Set<string>();
    for (const ref of refs) {
      const part = parts.get(ref.part);
      if (part === undefined) {
        return { ok: false, code: 'MISSING_PART', detail: `file part "${ref.part}" is not in the request` };
      }
      const filename = ref.filename ?? part.filename;
      if (extensionOf(filename) !== part.extension) {
        return {
          ok: false,
          code: 'ATTACHMENT_EXTENSION_MISMATCH',
          detail: `"${filename}" must keep the .${part.extension} extension of part "${ref.part}"`,
        };
      }
      const key = filename.toLowerCase();
      if (filenames.has(key)) {
        return {
          ok: false,
          code: 'DUPLICATE_ATTACHMENT_FILENAME',
          detail: `two attachments would be named "${filename}"`,
        };
      }
      filenames.add(key);
      list.push({ part, filename });
    }

    return { ok: true, list };
  }

  private dryRunBody(
    batch: BatchRequest,
    accepted: readonly AcceptedRow[],
    rejected: readonly RejectedRow[],
    warnings: readonly BatchWarning[],
  ): DryRunResultDto {
    return {
      dryRun: true,
      mailbox: batch.mailbox,
      accepted: accepted.length,
      rejected: rejected.length,
      messages: accepted.map((row) => ({ ref: row.ref, to: row.to, estimatedBytes: row.estimatedBytes })),
      rejectedMessages: rejected.map(({ ref, code, detail }) => ({ ref, code, detail })),
      warnings: [...warnings],
      preview: accepted.slice(0, DRY_RUN_PREVIEW_COUNT).map((row) => ({
        ref: row.ref,
        to: row.to,
        subject: row.subject,
        html: row.html,
        attachments: row.attachments.map((attachment) => ({
          filename: attachment.filename,
          contentType: attachment.part.contentType,
          size: attachment.part.size,
        })),
        estimatedBytes: row.estimatedBytes,
      })),
    };
  }

  private async persist(
    context: TenantContext,
    tenant: ResolvedTenant,
    mailbox: ResolvedMailbox,
    batch: BatchRequest,
    template: CompiledTemplate,
    parts: ReadonlyMap<string, TypedPart>,
    staging: StagingArea,
    accepted: readonly AcceptedRow[],
    rejected: readonly RejectedRow[],
    warnings: readonly BatchWarning[],
    idempotencyKey: string,
    committed: () => void,
  ): Promise<IntakeOutcome> {
    const batchId: BatchId = newBatchId();
    const now = this.clock.now();

    const committedDir = await this.store.commit(staging, tenant.id, batchId);
    const pathOf = (part: TypedPart): string => this.store.relative(join(committedDir, part.part));

    const storedParts: StoredPart[] = [...parts.values()].map((part) => ({
      part: part.part,
      filename: part.filename,
      contentType: part.contentType,
      size: part.size,
      sha256: part.sha256,
      path: pathOf(part),
    }));
    const inlineImages: MessageInlineImage[] = template.inlineImages.flatMap((image) => {
      const part = parts.get(image.part);

      return part === undefined
        ? []
        : [{ cid: image.cid, part: part.part, contentType: part.contentType, path: pathOf(part) }];
    });

    const messageIds = new Map<number, MessageId>(accepted.map((row) => [row.index, newMessageId()]));
    const messages: Omit<MessageDocument, 'createdAt' | 'updatedAt'>[] = accepted.map((row) => ({
      _id: messageIds.get(row.index) ?? newMessageId(),
      tenantId: tenant.id,
      batchId,
      mailbox: mailbox.code,
      position: row.index,
      ref: row.ref,
      ...(row.subTenant === undefined ? {} : { subTenant: row.subTenant }),
      to: row.to,
      toLower: row.to.toLowerCase(),
      ...(row.toName === undefined ? {} : { toName: row.toName }),
      ...(row.dedupKey === undefined ? {} : { dedupKey: row.dedupKey }),
      subject: row.subject,
      html: row.html,
      attachments: row.attachments.map((attachment): MessageAttachment => ({
        part: attachment.part.part,
        filename: attachment.filename,
        contentType: attachment.part.contentType,
        size: attachment.part.size,
        sha256: attachment.part.sha256,
        path: pathOf(attachment.part),
      })),
      inlineImages,
      estimatedBytes: row.estimatedBytes,
      recipientCheck: row.recipientCheck,
      status: 'PENDING',
      settlement: 'PENDING',
      attempts: 0,
      nextAttemptAt: now,
      sentCopy: mailbox.imap === null ? 'DISABLED' : 'PENDING',
      attemptLog: [],
      operatorLog: [],
    }));

    const batchDoc: Omit<BatchDocument, 'createdAt' | 'updatedAt'> = {
      _id: batchId,
      tenantId: tenant.id,
      apiKeyId: context.apiKeyId,
      mailbox: mailbox.code,
      ...(batch.reference === undefined ? {} : { reference: batch.reference }),
      ...(batch.subTenant === undefined ? {} : { subTenant: batch.subTenant }),
      status: 'QUEUED',
      template: { subject: template.subject, html: template.html, inlineImages: template.inlineImages },
      options: { atomic: batch.options.atomic, unverifiedRecipients: batch.options.unverifiedRecipients },
      parts: storedParts,
      messageCount: accepted.length,
      rejectedMessages: rejected.map(({ ref, code, detail }) => ({ ref, code, detail })),
      warnings: [...warnings],
      idempotencyKey,
    };

    try {
      await this.repository.createBatch(batchDoc, messages);
    } catch (error: unknown) {
      await this.store.discard({ id: staging.id, dir: committedDir }).catch(() => undefined);
      if (isDuplicateKeyError(error)) {
        throw AppError.conflict('DEDUP_KEY_CONFLICT', 'A dedupKey was used by a concurrent batch', {
          detail:
            'Another batch of yours claimed one of these dedupKeys while this one was being processed; retry without it',
        });
      }
      throw error;
    }
    committed();

    const body: BatchAcceptedDto = {
      batchId,
      status: 'QUEUED',
      mailbox: mailbox.code,
      ...(batch.reference === undefined ? {} : { reference: batch.reference }),
      ...(batch.subTenant === undefined ? {} : { subTenant: batch.subTenant }),
      accepted: accepted.length,
      rejected: rejected.length,
      messages: accepted.map((row) => ({
        ref: row.ref,
        messageId: messageIds.get(row.index) ?? '',
        status: 'PENDING',
      })),
      rejectedMessages: rejected.map(({ ref, code, detail }) => ({ ref, code, detail })),
      warnings: [...warnings],
      createdAt: now.toISOString(),
    };
    const location = `/v1/batches/${batchId}`;
    try {
      await this.idempotency.complete(tenant.id, idempotencyKey, {
        status: 202,
        headers: { location },
        body,
      });
    } catch (error: unknown) {
      // The batch is safe; a retry with this key now gets IDEMPOTENCY_IN_PROGRESS
      // until the lock expires, which is the honest answer.
      this.logger.warn({ err: error, batchId, tenantId: tenant.id }, 'idempotency record not completed');
    }

    this.logger.info(
      {
        tenantId: tenant.id,
        batchId,
        mailbox: mailbox.code,
        accepted: accepted.length,
        rejected: rejected.length,
      },
      'batch accepted',
    );

    return { kind: 'accepted', body, location, replayed: false };
  }
}
