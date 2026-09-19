import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Inject, Injectable } from '@nestjs/common';
import MailComposer from 'nodemailer/lib/mail-composer';

import { CLOCK, type Clock } from '../../../common/time/clock';
import type { ResolvedMailbox } from '../../../config/config.loader';
import { AttachmentStore } from '../../attachments/attachment-store';
import type { MessageDocument } from '../../batches/schemas/message.schema';

export interface BuiltEml {
  /** Absolute path of the .eml file */
  readonly path: string;
  /** Relative to STORAGE_DIR, what the message record keeps */
  readonly relativePath: string;
  readonly messageIdHeader: string;
  readonly date: Date;
}

/**
 * Turns a stored message into the MIME file that will be sent. The file is
 * written first and sent as-is afterwards: what is archived is byte for byte
 * what left, which is what a legal dispute asks for.
 *
 * The Message-ID is ours and deterministic (<message id>@<sender domain>):
 * the acceptance and delivery receipts of stage 5 quote it, and a resend
 * decided by an operator keeps the same id on purpose.
 */
@Injectable()
export class EmlBuilder {
  public constructor(
    private readonly store: AttachmentStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  public static messageIdFor(
    message: Pick<MessageDocument, '_id'>,
    mailbox: Pick<ResolvedMailbox, 'from'>,
  ): string {
    const domain = mailbox.from.address.slice(mailbox.from.address.lastIndexOf('@') + 1);

    return `<${message._id}@${domain}>`;
  }

  public async build(message: MessageDocument, mailbox: ResolvedMailbox): Promise<BuiltEml> {
    const date = this.clock.now();
    const messageIdHeader = EmlBuilder.messageIdFor(message, mailbox);
    const path = this.store.absolute(`batches/${message.tenantId}/${message.batchId}/eml/${message._id}.eml`);
    await mkdir(dirname(path), { recursive: true });

    const composer = new MailComposer({
      from: { name: mailbox.from.name, address: mailbox.from.address },
      to: message.toName === undefined ? message.to : { name: message.toName, address: message.to },
      subject: message.subject,
      html: message.html,
      messageId: messageIdHeader,
      date,
      headers: {
        'X-PecMailer-Message-Id': message._id,
        'X-PecMailer-Batch-Id': message.batchId,
      },
      attachments: [
        ...message.inlineImages.map((image) => ({
          filename: image.part,
          path: this.store.absolute(image.path),
          contentType: image.contentType,
          cid: image.cid,
          contentDisposition: 'inline',
        })),
        ...message.attachments.map((attachment) => ({
          filename: attachment.filename,
          path: this.store.absolute(attachment.path),
          contentType: attachment.contentType,
        })),
      ],
    });

    await pipeline(composer.compile().createReadStream(), createWriteStream(path, { flags: 'w' }));

    return { path, relativePath: this.store.relative(path), messageIdHeader, date };
  }

  public emlPathFor(message: Pick<MessageDocument, '_id' | 'tenantId' | 'batchId'>): string {
    return join(
      this.store.absolute(`batches/${message.tenantId}/${message.batchId}/eml`),
      `${message._id}.eml`,
    );
  }
}
