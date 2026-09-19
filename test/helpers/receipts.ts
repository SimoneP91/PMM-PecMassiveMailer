import { randomBytes } from 'node:crypto';

import type { ResolvedImap, ResolvedMailbox } from '../../src/config/config';
import type {
  ReadPosition,
  ReceiptSource,
  ReceiptSourceFactory,
  SourceMail,
} from '../../src/modules/receipts/receipt-source';
import { ImapAuthError } from '../../src/modules/sending/imap/imap-auth-error';

export type RicevutaKind =
  | 'accettazione'
  | 'avvenuta-consegna'
  | 'errore-consegna'
  | 'preavviso-errore-consegna'
  | 'non-accettazione'
  | 'rilevazione-virus'
  | 'presa-in-carico';

export interface ReceiptSpec {
  readonly kind: RicevutaKind;
  /** The Message-ID of the message the receipt is about, with angle brackets. */
  readonly ref: string;
  readonly subject?: string;
  readonly from?: string;
  readonly recipient?: string;
  readonly errore?: string;
  readonly erroreEsteso?: string;
  readonly provider?: string;
  readonly issued?: { readonly giorno: string; readonly ora: string; readonly zona: string };
  /** The receipt's own Message-ID; random when omitted. */
  readonly messageId?: string;
  /** Omit the X-Riferimento-Message-ID header (daticert msgid remains). */
  readonly withoutReferenceHeader?: boolean;
}

const PREFIX: Readonly<Record<RicevutaKind, string>> = {
  accettazione: 'ACCETTAZIONE',
  'avvenuta-consegna': 'CONSEGNA',
  'errore-consegna': 'AVVISO DI MANCATA CONSEGNA',
  'preavviso-errore-consegna': 'AVVISO DI MANCATA CONSEGNA',
  'non-accettazione': 'AVVISO DI NON ACCETTAZIONE',
  'rilevazione-virus': 'PROBLEMA DI SICUREZZA',
  'presa-in-carico': 'PRESA IN CARICO',
};

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function daticertXml(spec: ReceiptSpec): string {
  const issued = spec.issued ?? { giorno: '19/09/2026', ora: '10:15:03', zona: '+0200' };
  const recipient = spec.recipient ?? 'mario.rossi@pec.it';

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE postacert SYSTEM "Postacert.dtd">',
    `<postacert tipo="${spec.kind}" errore="${spec.errore ?? 'nessuno'}">`,
    '  <intestazione>',
    `    <mittente>${escapeXml(spec.from ?? 'solleciti@pec.serfin.example')}</mittente>`,
    `    <destinatari tipo="certificato">${escapeXml(recipient)}</destinatari>`,
    `    <risposte>${escapeXml(spec.from ?? 'solleciti@pec.serfin.example')}</risposte>`,
    `    <oggetto>${escapeXml(spec.subject ?? 'Sollecito')}</oggetto>`,
    '  </intestazione>',
    '  <dati>',
    `    <gestore-emittente>${escapeXml(spec.provider ?? 'ARUBA PEC S.p.A.')}</gestore-emittente>`,
    `    <data zona="${issued.zona}"><giorno>${issued.giorno}</giorno><ora>${issued.ora}</ora></data>`,
    `    <identificativo>opec21.${randomBytes(6).toString('hex')}@pec.aruba.it</identificativo>`,
    `    <msgid>${escapeXml(spec.ref)}</msgid>`,
    spec.kind === 'avvenuta-consegna' ? '    <ricevuta tipo="completa"/>' : '',
    spec.kind === 'avvenuta-consegna' ? `    <consegna>${escapeXml(recipient)}</consegna>` : '',
    spec.erroreEsteso === undefined
      ? ''
      : `    <errore-esteso>${escapeXml(spec.erroreEsteso)}</errore-esteso>`,
    '  </dati>',
    '</postacert>',
  ]
    .filter((line) => line !== '')
    .join('\r\n');
}

/**
 * A receipt as a provider delivers it: multipart/signed (S/MIME) around a
 * multipart/mixed with the human-readable text and daticert.xml. The
 * signature part is filler: the service keeps it, it does not verify it.
 */
export function buildReceipt(spec: ReceiptSpec): Buffer {
  const outer = `----=_signed_${randomBytes(6).toString('hex')}`;
  const inner = `----=_mixed_${randomBytes(6).toString('hex')}`;
  const subject = `${PREFIX[spec.kind]}: ${spec.subject ?? 'Sollecito'}`;
  const messageId = spec.messageId ?? `<opec21.${randomBytes(8).toString('hex')}@pec.aruba.it>`;
  const daticert = Buffer.from(daticertXml(spec), 'utf8').toString('base64');

  return Buffer.from(
    [
      'Return-Path: <posta-certificata@pec.aruba.it>',
      `Message-ID: ${messageId}`,
      'Date: Sat, 19 Sep 2026 10:15:03 +0200',
      'From: "Per conto di: solleciti@pec.serfin.example" <posta-certificata@pec.aruba.it>',
      'To: solleciti@pec.serfin.example',
      `Subject: ${subject}`,
      `X-Ricevuta: ${spec.kind}`,
      ...(spec.withoutReferenceHeader === true ? [] : [`X-Riferimento-Message-ID: ${spec.ref}`]),
      'X-VerificaSicurezza: ok',
      'MIME-Version: 1.0',
      `Content-Type: multipart/signed; protocol="application/x-pkcs7-signature"; micalg=sha-256; boundary="${outer}"`,
      '',
      `--${outer}`,
      `Content-Type: multipart/mixed; boundary="${inner}"`,
      '',
      `--${inner}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 8bit',
      '',
      `${PREFIX[spec.kind]}: il messaggio "${spec.subject ?? 'Sollecito'}" ...`,
      '',
      `--${inner}`,
      'Content-Type: application/xml; name="daticert.xml"',
      'Content-Disposition: inline; filename="daticert.xml"',
      'Content-Transfer-Encoding: base64',
      '',
      daticert,
      '',
      `--${inner}--`,
      '',
      `--${outer}`,
      'Content-Type: application/x-pkcs7-signature; name="smime.p7s"',
      'Content-Disposition: attachment; filename="smime.p7s"',
      'Content-Transfer-Encoding: base64',
      '',
      randomBytes(256).toString('base64'),
      '',
      `--${outer}--`,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

/** A message another PEC user sent to the mailbox: wrapped in a transport envelope by the provider. */
export function buildEnvelope(
  innerRaw: Buffer,
  kind: 'posta-certificata' | 'errore' = 'posta-certificata',
): Buffer {
  const boundary = `----=_env_${randomBytes(6).toString('hex')}`;

  return Buffer.from(
    [
      `Message-ID: <opec.${randomBytes(8).toString('hex')}@pec.aruba.it>`,
      'From: "Per conto di: someone@pec.it" <posta-certificata@pec.aruba.it>',
      'To: solleciti@pec.serfin.example',
      `Subject: ${kind === 'errore' ? 'ANOMALIA MESSAGGIO' : 'POSTA CERTIFICATA'}: hello`,
      `X-Trasporto: ${kind}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: message/rfc822; name="postacert.eml"',
      'Content-Disposition: attachment; filename="postacert.eml"',
      '',
      innerRaw.toString('utf8'),
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    'utf8',
  );
}

/** The mailbox's receipts folder, in memory: mails get increasing UIDs per mailbox. */
export class FakeReceiptSourceFactory implements ReceiptSourceFactory {
  public readonly folders = new Map<string, { uid: number; raw: Buffer; internalDate: Date }[]>();
  public uidValidity = '1';
  public refuseLogin = false;
  /** Passes over the folder. */
  public fetches = 0;
  /** Whole mails downloaded: only what may be a receipt should be. */
  public bodies = 0;
  /** UIDs whose download always fails, like a mail the server cannot serve. */
  public readonly broken = new Set<number>();

  /** Drops a mail in the folder; returns its UID. */
  public deliver(mailbox: string, raw: Buffer, internalDate = new Date()): number {
    const folder = this.folders.get(mailbox) ?? [];
    const uid = (folder.at(-1)?.uid ?? 0) + 1;
    folder.push({ uid, raw, internalDate });
    this.folders.set(mailbox, folder);

    return uid;
  }

  public create(mailbox: ResolvedMailbox, _imap: ResolvedImap): ReceiptSource {
    return {
      read: async (
        position: ReadPosition,
        handle: (mail: SourceMail, uidValidity: string) => Promise<boolean>,
      ): Promise<void> => {
        this.fetches += 1;
        if (this.refuseLogin) {
          throw new ImapAuthError();
        }
        const resume = position.uidValidity === this.uidValidity;
        const mails = (this.folders.get(mailbox.code) ?? [])
          .filter((mail) => (resume ? mail.uid > position.afterUid : mail.internalDate >= position.since))
          .slice(0, position.max);
        for (const mail of mails) {
          const headerEnd = mail.raw.indexOf('\r\n\r\n');
          const next = await handle(
            {
              uid: mail.uid,
              internalDate: mail.internalDate,
              headers: mail.raw.subarray(0, headerEnd < 0 ? mail.raw.length : headerEnd).toString('utf8'),
              body: () => {
                this.bodies += 1;
                if (this.broken.has(mail.uid)) {
                  return Promise.reject(new Error(`mail ${String(mail.uid)} cannot be served`));
                }

                return Promise.resolve(mail.raw);
              },
            },
            this.uidValidity,
          );
          if (!next) {
            break;
          }
        }
      },
    };
  }
}
