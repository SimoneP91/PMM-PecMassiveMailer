import { simpleParser } from 'mailparser';

import { parseDaticert, type Daticert } from './daticert';

export const RECEIPT_TYPES = [
  'ACCEPTANCE',
  'NON_ACCEPTANCE',
  'TAKING_CHARGE',
  'DELIVERY',
  'NON_DELIVERY',
  'NON_DELIVERY_WARNING',
  'VIRUS_DETECTED',
] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** X-Ricevuta header value -> our type (technical rules of the PEC system). */
const TYPE_OF: Readonly<Record<string, ReceiptType>> = {
  accettazione: 'ACCEPTANCE',
  'non-accettazione': 'NON_ACCEPTANCE',
  'presa-in-carico': 'TAKING_CHARGE',
  'avvenuta-consegna': 'DELIVERY',
  'errore-consegna': 'NON_DELIVERY',
  'preavviso-errore-consegna': 'NON_DELIVERY_WARNING',
  'rilevazione-virus': 'VIRUS_DETECTED',
};

export interface ParsedReceipt {
  readonly kind: 'receipt';
  readonly type: ReceiptType;
  /** The Message-ID of OUR message the receipt is about, with angle brackets. */
  readonly refMessageId: string;
  /** The receipt's own Message-ID: what makes a re-read of the same receipt a duplicate. */
  readonly sourceMessageId: string | undefined;
  /** When the provider issued it: daticert date, else the Date header. */
  readonly issuedAt: Date | undefined;
  readonly provider: string | undefined;
  readonly recipient: string | undefined;
  /** daticert errore, when it is not "nessuno". */
  readonly errorCode: string | undefined;
  readonly errorDetail: string | undefined;
  readonly providerId: string | undefined;
  readonly daticert: Buffer | undefined;
}

export interface IgnoredMail {
  readonly kind: 'ignored';
  readonly reason: string;
}

export function normaliseMessageId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === '') {
    return undefined;
  }

  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
}

/**
 * A first look at a mail's top-level X-Ricevuta and X-Trasporto header lines,
 * before its body is downloaded: false means it cannot be a receipt (no
 * X-Ricevuta, or a PEC envelope), so a large ordinary PEC is never fetched.
 * The decision itself stays with parseReceipt, on the whole mail.
 */
export function mayBeReceipt(topLevelHeaders: string): boolean {
  return /^x-ricevuta[ \t]*:/im.test(topLevelHeaders) && !/^x-trasporto[ \t]*:/im.test(topLevelHeaders);
}

function headerText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  return undefined;
}

/**
 * Recognises a PEC receipt from the TOP-LEVEL headers of a mail read from the
 * mailbox, and only from them.
 *
 * Why that is enough to trust it: inside the PEC system every message that
 * lands in a mailbox was put there by a provider. Mail sent by a person
 * arrives wrapped in a transport envelope (X-Trasporto: posta-certificata),
 * ordinary mail in an anomaly envelope (X-Trasporto: errore); only receipts
 * carry X-Ricevuta at the top. A forged "receipt" sent by someone is
 * therefore always inside an envelope, and is ignored here. The provider's
 * S/MIME signature is kept intact in the stored EML for legal use; it is not
 * verified by this service.
 */
export async function parseReceipt(raw: Buffer): Promise<ParsedReceipt | IgnoredMail> {
  const mail = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });

  if (mail.headers.has('x-trasporto')) {
    return { kind: 'ignored', reason: 'PEC envelope (message or anomaly), not a receipt' };
  }
  const ricevuta = headerText(mail.headers.get('x-ricevuta'))?.trim().toLowerCase();
  if (ricevuta === undefined) {
    return { kind: 'ignored', reason: 'no X-Ricevuta header' };
  }
  const type = TYPE_OF[ricevuta];
  if (type === undefined) {
    return { kind: 'ignored', reason: `unknown receipt kind "${ricevuta}"` };
  }

  const daticertPart = mail.attachments.find(
    (attachment) => attachment.filename?.toLowerCase() === 'daticert.xml',
  );
  const daticert: Daticert | undefined =
    daticertPart === undefined ? undefined : parseDaticert(daticertPart.content);

  const refMessageId =
    normaliseMessageId(headerText(mail.headers.get('x-riferimento-message-id'))) ??
    normaliseMessageId(daticert?.msgid);
  if (refMessageId === undefined) {
    return { kind: 'ignored', reason: 'receipt without X-Riferimento-Message-ID' };
  }

  const errore = daticert?.errore?.toLowerCase();

  return {
    kind: 'receipt',
    type,
    refMessageId,
    sourceMessageId: normaliseMessageId(mail.messageId),
    issuedAt: daticert?.data ?? mail.date,
    provider: daticert?.gestoreEmittente,
    recipient: daticert?.consegna ?? daticert?.destinatari,
    errorCode: errore === undefined || errore === 'nessuno' ? undefined : errore,
    errorDetail: daticert?.erroreEsteso,
    providerId: daticert?.identificativo,
    daticert: daticertPart?.content,
  };
}
