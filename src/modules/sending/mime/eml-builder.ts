import MailComposer from 'nodemailer/lib/mail-composer';

import type { Clock } from '../../../common/time/clock';
import type { ResolvedMailbox } from '../../../config/config';

/** A PEC as it leaves the queue, validated, with its files decoded. */
export interface OutgoingPec {
  /** The sender's identifier: it becomes part of the Message-ID. */
  readonly id: string;
  readonly to: { readonly address: string; readonly name?: string };
  readonly subject: string;
  readonly html: string;
  readonly attachments: readonly {
    readonly filename: string;
    readonly contentType: string;
    readonly content: Buffer;
  }[];
  readonly inlineImages: readonly {
    readonly cid: string;
    readonly filename: string;
    readonly contentType: string;
    readonly content: Buffer;
  }[];
}

export interface BuiltEml {
  /** The message exactly as it will be transmitted. */
  readonly raw: Buffer;
  readonly messageIdHeader: string;
  readonly date: Date;
}

const OUR_MESSAGE_ID = /^<pm\.([A-Za-z0-9][A-Za-z0-9._-]{0,63})@[^<>@\s]+>$/;

/**
 * The Message-ID of a PEC: `<pm.{id}@{sender domain}>`. Every receipt quotes
 * it, so the sender's id comes back with each receipt, and the container can
 * recognise its own messages among the mails of the mailbox, without keeping
 * anything.
 */
export function messageIdFor(id: string, fromAddress: string): string {
  return `<pm.${id}@${fromAddress.slice(fromAddress.lastIndexOf('@') + 1)}>`;
}

/** The sender's id inside one of our Message-IDs; undefined for any other message. */
export function idFromMessageId(messageId: string | undefined): string | undefined {
  return messageId === undefined ? undefined : OUR_MESSAGE_ID.exec(messageId.trim())?.[1];
}

/**
 * Builds the MIME message of a PEC in memory. The container keeps nothing on
 * disk: the message is composed, transmitted and forgotten; the sender keeps
 * what it needs from the outcome events.
 */
export class EmlBuilder {
  public constructor(private readonly clock: Clock) {}

  public async build(pec: OutgoingPec, mailbox: Pick<ResolvedMailbox, 'from'>): Promise<BuiltEml> {
    const date = this.clock.now();
    const messageIdHeader = messageIdFor(pec.id, mailbox.from.address);
    const composer = new MailComposer({
      from: { name: mailbox.from.name, address: mailbox.from.address },
      to: pec.to.name === undefined ? pec.to.address : { name: pec.to.name, address: pec.to.address },
      subject: pec.subject,
      html: pec.html,
      messageId: messageIdHeader,
      date,
      attachments: [
        ...pec.inlineImages.map((image) => ({
          filename: image.filename,
          content: image.content,
          contentType: image.contentType,
          cid: image.cid,
          contentDisposition: 'inline' as const,
        })),
        ...pec.attachments.map((attachment) => ({
          filename: attachment.filename,
          content: attachment.content,
          contentType: attachment.contentType,
        })),
      ],
    });
    const raw = await new Promise<Buffer>((resolve, reject) => {
      composer.compile().build((error, message) => {
        if (error === null) {
          resolve(message);
        } else {
          reject(error);
        }
      });
    });

    return { raw, messageIdHeader, date };
  }
}
