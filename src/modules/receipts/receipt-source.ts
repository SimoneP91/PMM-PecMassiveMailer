import { ImapFlow } from 'imapflow';

import type { ResolvedImap, ResolvedMailbox } from '../../config/config';

/** One mail of the folder, before its body is downloaded. */
export interface SourceMail {
  readonly uid: number;
  readonly internalDate: Date | undefined;
  /**
   * The mail's top-level X-Ricevuta and X-Trasporto header lines, as the
   * server returned them: enough to tell that a mail cannot be a receipt.
   */
  readonly headers: string;
  /** The whole mail, byte for byte. Fetched only when asked for. */
  body(): Promise<Buffer>;
}

export interface ReadPosition {
  /** Last UID handled; 0 when there is no cursor yet. */
  readonly afterUid: number;
  /** The UIDVALIDITY the cursor belongs to; undefined when there is no cursor yet. */
  readonly uidValidity: string | undefined;
  /**
   * Where to start when the cursor cannot be used (first read of the folder,
   * or the folder was recreated): the mails received since this day. A
   * mailbox that has been in use for years is not read from its first mail.
   */
  readonly since: Date;
  readonly max: number;
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
   * Hands the mails after the position to `handle`, oldest first, at most
   * `max`, one at a time: the next is fetched once `handle` is done with the
   * previous, so a folder full of large receipts (a complete delivery
   * receipt carries the whole original message) never sits in memory.
   * `handle` gets the folder's UIDVALIDITY with each mail and returns false
   * to stop.
   */
  read(
    position: ReadPosition,
    handle: (mail: SourceMail, uidValidity: string) => Promise<boolean>,
  ): Promise<void>;
}

export interface ReceiptSourceFactory {
  create(mailbox: ResolvedMailbox, imap: ResolvedImap): ReceiptSource;
}

class ImapflowReceiptSource implements ReceiptSource {
  public constructor(private readonly imap: ResolvedImap) {}

  public async read(
    position: ReadPosition,
    handle: (mail: SourceMail, uidValidity: string) => Promise<boolean>,
  ): Promise<void> {
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
        const resume = uidValidity === position.uidValidity;
        const found = await client.search(
          resume ? { uid: `${String(position.afterUid + 1)}:*` } : { since: position.since },
          { uid: true },
        );
        const uids = (Array.isArray(found) ? found : [])
          // "N:*" also matches the last message when N is past the end: filter.
          .filter((uid) => !resume || uid > position.afterUid)
          .sort((a, b) => a - b)
          .slice(0, position.max);

        for (const uid of uids) {
          const head = await client.fetchOne(
            String(uid),
            { headers: ['x-ricevuta', 'x-trasporto'], internalDate: true },
            { uid: true },
          );
          if (head === false || head === undefined) {
            continue; // expunged meanwhile
          }
          const date = head.internalDate;
          const mail: SourceMail = {
            uid,
            internalDate: date === undefined ? undefined : new Date(date),
            headers: head.headers?.toString('utf8') ?? '',
            body: async () => {
              const full = await client.fetchOne(String(uid), { source: true }, { uid: true });
              if (full === false || full?.source === undefined) {
                throw new Error(`mail ${String(uid)} disappeared while it was being read`);
              }

              return full.source;
            },
          };
          if (!(await handle(mail, uidValidity))) {
            break;
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {
        client.close();
      });
    }
  }
}

export class ImapflowReceiptSourceFactory implements ReceiptSourceFactory {
  public create(_mailbox: ResolvedMailbox, imap: ResolvedImap): ReceiptSource {
    return new ImapflowReceiptSource(imap);
  }
}
