import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';

import type { ResolvedImap, ResolvedMailbox } from '../../config/config.loader';

export interface FetchedMail {
  readonly uid: number;
  readonly raw: Buffer;
  readonly internalDate: Date | undefined;
}

export interface FetchedBatch {
  readonly uidValidity: string;
  readonly mails: readonly FetchedMail[];
}

/** The login was refused: the mailbox must be suspended, not retried. */
export class ReceiptSourceAuthError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReceiptSourceAuthError';
  }
}

/**
 * Where receipts are read from. Behind an interface so the reading loop is
 * tested without an IMAP server; the imapflow implementation is tested
 * against Greenmail.
 */
export interface ReceiptSource {
  /**
   * Mails with a UID above `afterUid`, oldest first, at most `max`. When the
   * folder's UIDVALIDITY differs from `knownUidValidity`, reading starts from
   * the beginning.
   */
  fetchAfter(afterUid: number, max: number, knownUidValidity: string | undefined): Promise<FetchedBatch>;
  close(): Promise<void>;
}

export interface ReceiptSourceFactory {
  create(mailbox: ResolvedMailbox, imap: ResolvedImap): ReceiptSource;
}

export const RECEIPT_SOURCE_FACTORY = Symbol('RECEIPT_SOURCE_FACTORY');

class ImapflowReceiptSource implements ReceiptSource {
  public constructor(private readonly imap: ResolvedImap) {}

  public async fetchAfter(
    afterUid: number,
    max: number,
    knownUidValidity: string | undefined,
  ): Promise<FetchedBatch> {
    const client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.security === 'tls',
      auth: { user: this.imap.username, pass: this.imap.password.reveal() },
      logger: false,
      emitLogs: false,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error: unknown) {
      if ((error as { authenticationFailed?: unknown }).authenticationFailed === true) {
        throw new ReceiptSourceAuthError('IMAP login refused');
      }
      throw error;
    }

    try {
      // Read-only (EXAMINE) and BODY.PEEK: the client's mailbox is left exactly as it was.
      const lock = await client.getMailboxLock(this.imap.receiptsFolder, { readOnly: true });
      try {
        const opened = client.mailbox;
        const uidValidity = opened === false ? '0' : String(opened.uidValidity);
        const from = uidValidity === knownUidValidity ? afterUid : 0;
        const found = await client.search({ uid: `${String(from + 1)}:*` }, { uid: true });
        // "N:*" also matches the last message when N is past the end: filter.
        const uids = (Array.isArray(found) ? found : [])
          .filter((uid) => uid > from)
          .sort((a, b) => a - b)
          .slice(0, max);

        const mails: FetchedMail[] = [];
        for (const uid of uids) {
          const message = await client.fetchOne(
            String(uid),
            { source: true, internalDate: true },
            { uid: true },
          );
          if (message !== false && message?.source !== undefined) {
            const date = message.internalDate;
            mails.push({
              uid,
              raw: message.source,
              internalDate: date === undefined ? undefined : new Date(date),
            });
          }
        }

        return { uidValidity, mails };
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {
        client.close();
      });
    }
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}

@Injectable()
export class ImapflowReceiptSourceFactory implements ReceiptSourceFactory {
  public create(_mailbox: ResolvedMailbox, imap: ResolvedImap): ReceiptSource {
    return new ImapflowReceiptSource(imap);
  }
}
