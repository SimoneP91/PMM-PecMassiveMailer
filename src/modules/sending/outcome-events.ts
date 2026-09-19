import { createHash } from 'node:crypto';

import type { FieldError } from '../../common/field-error';
import type { Clock } from '../../common/time/clock';
import type { OutputEvent } from '../../queue/queues';
import type { ParsedReceipt, ReceiptType } from '../receipts/receipt-parser';
import type { PecLabels } from './send-request';

/**
 * The events of the output queue about one PEC and about the mailbox, as
 * docs/asyncapi.yaml describes them. The eventId is derived from the fact,
 * never random: the same outcome published twice (after a crash, say) has
 * the same id, and the consumer recognises the copy.
 */

export interface Problem {
  readonly code: string;
  readonly field?: string;
  readonly detail: string;
}

export type SentCopyState = 'ARCHIVED' | 'FAILED' | 'DISABLED' | 'UNKNOWN';

export interface SentEvent extends OutputEvent, PecLabels {
  readonly event: 'sent';
  readonly messageId: string;
  readonly sentAt: string;
  readonly confirmedBy: 'SMTP' | 'ACCEPTANCE_RECEIPT';
  readonly smtpResponse?: string;
  readonly attempts: number;
  readonly sentCopy: SentCopyState;
  readonly sentCopyError?: string;
  readonly warnings: readonly Problem[];
}

export interface RejectedEvent extends OutputEvent, PecLabels {
  readonly event: 'rejected';
  readonly errors: readonly Problem[];
}

export interface FailedEvent extends OutputEvent, PecLabels {
  readonly event: 'failed';
  readonly code: string;
  readonly smtpCode?: number;
  readonly detail: string;
  readonly attempts: number;
}

export type UncertainReason = 'CONNECTION_LOST_AFTER_DATA' | 'REDELIVERED_WITHOUT_ACCEPTANCE';

export interface UncertainEvent extends OutputEvent, PecLabels {
  readonly event: 'uncertain';
  readonly messageId: string;
  readonly reason: UncertainReason;
  readonly detail: string;
}

export type SuspensionCause = 'SMTP_AUTH_REFUSED' | 'IMAP_AUTH_REFUSED';

export interface MailboxSuspendedEvent extends OutputEvent {
  readonly event: 'mailbox.suspended';
  readonly cause: SuspensionCause;
  readonly detail: string;
}

export interface ReceiptEvent extends OutputEvent {
  readonly event: 'receipt';
  /** The sender's id of the PEC, read back from the Message-ID the receipt quotes. */
  readonly id: string;
  readonly messageId: string;
  readonly receiptType: ReceiptType;
  /** The PEC has its final outcome: delivered, or definitely not. */
  readonly final: boolean;
  readonly issuedAt: string;
  readonly provider?: string;
  readonly recipient?: string;
  readonly error?: Problem;
  readonly providerId?: string;
  readonly receiptMessageId?: string;
  /** The receipt exactly as the provider sent it, signature included, base64: the legal proof. */
  readonly eml: string;
  readonly emlSha256: string;
  readonly daticert?: string;
}

/** Receipts after which nothing more will come for the PEC. */
const FINAL_RECEIPTS: ReadonlySet<ReceiptType> = new Set([
  'DELIVERY',
  'NON_DELIVERY',
  'NON_ACCEPTANCE',
  'VIRUS_DETECTED',
]);

const sha256 = (content: Buffer | string): string => createHash('sha256').update(content).digest('hex');

export function problemOf(error: FieldError): Problem {
  return error.path === ''
    ? { code: error.code, detail: error.detail }
    : { code: error.code, field: error.path, detail: error.detail };
}

/** Builds the events of one container: its tenant, its mailbox, its clock. */
export class OutcomeEvents {
  public constructor(
    private readonly tenant: string,
    private readonly mailbox: string,
    private readonly clock: Clock,
  ) {}

  private base<E extends string>(event: E, eventId: string): OutputEvent & { readonly event: E } {
    return {
      version: 1,
      event,
      eventId,
      occurredAt: this.clock.now().toISOString(),
      tenant: this.tenant,
      mailbox: this.mailbox,
    };
  }

  private labels(labels: PecLabels): PecLabels {
    return {
      id: labels.id,
      ...(labels.reference === undefined ? {} : { reference: labels.reference }),
      ...(labels.batch === undefined ? {} : { batch: labels.batch }),
    };
  }

  public sent(
    labels: PecLabels,
    fields: Omit<SentEvent, keyof OutputEvent | keyof PecLabels | 'event'>,
  ): SentEvent {
    return { ...this.base('sent', `sent:${labels.id}`), ...this.labels(labels), ...fields };
  }

  public rejected(labels: PecLabels, errors: readonly FieldError[]): RejectedEvent {
    return {
      ...this.base('rejected', `rejected:${labels.id}`),
      ...this.labels(labels),
      errors: errors.map(problemOf),
    };
  }

  public failed(
    labels: PecLabels,
    fields: Omit<FailedEvent, keyof OutputEvent | keyof PecLabels | 'event'>,
  ): FailedEvent {
    return { ...this.base('failed', `failed:${labels.id}`), ...this.labels(labels), ...fields };
  }

  public uncertain(
    labels: PecLabels,
    fields: Omit<UncertainEvent, keyof OutputEvent | keyof PecLabels | 'event'>,
  ): UncertainEvent {
    return { ...this.base('uncertain', `uncertain:${labels.id}`), ...this.labels(labels), ...fields };
  }

  /**
   * A receipt of a PEC of ours. Its eventId comes from the receipt itself
   * (its Message-ID, or its bytes), so reading the same receipt again after a
   * restart gives the same event, which the consumer recognises.
   */
  public receipt(id: string, receipt: ParsedReceipt, raw: Buffer, fallbackIssuedAt: Date): ReceiptEvent {
    const identity = receipt.sourceMessageId ?? `bytes:${sha256(raw)}`;
    const error =
      receipt.errorCode === undefined && receipt.errorDetail === undefined
        ? undefined
        : { code: receipt.errorCode ?? 'unknown', detail: receipt.errorDetail ?? '' };

    return {
      ...this.base('receipt', `receipt:${sha256(identity)}`),
      id,
      messageId: receipt.refMessageId,
      receiptType: receipt.type,
      final: FINAL_RECEIPTS.has(receipt.type),
      issuedAt: (receipt.issuedAt ?? fallbackIssuedAt).toISOString(),
      ...(receipt.provider === undefined ? {} : { provider: receipt.provider }),
      ...(receipt.recipient === undefined ? {} : { recipient: receipt.recipient }),
      ...(error === undefined ? {} : { error }),
      ...(receipt.providerId === undefined ? {} : { providerId: receipt.providerId }),
      ...(receipt.sourceMessageId === undefined ? {} : { receiptMessageId: receipt.sourceMessageId }),
      eml: raw.toString('base64'),
      emlSha256: sha256(raw),
      ...(receipt.daticert === undefined ? {} : { daticert: receipt.daticert.toString('base64') }),
    };
  }

  /** One per suspension: the id carries the moment, so a later suspension is a new fact. */
  public mailboxSuspended(cause: SuspensionCause, detail: string): MailboxSuspendedEvent {
    const at = this.clock.now().toISOString();

    return { ...this.base('mailbox.suspended', `mailbox.suspended:${this.mailbox}:${at}`), cause, detail };
  }
}
