import { ImapFlow } from 'imapflow';

import type { ResolvedImap, ResolvedMailbox } from '../../../config/config';
import { ImapAuthError, isImapAuthFailure } from './imap-auth-error';

/**
 * Files a copy of a sent message in the mailbox's Sent folder, so the
 * provider's webmail shows what left - the habit of the legacy sender and
 * what the client's operators expect to find.
 *
 * A failure here never changes the fate of the message: it was sent. It is
 * reported in its sent event (sentCopy = FAILED) and the next message tries a
 * fresh connection; a refused login throws ImapAuthError, which suspends the
 * mailbox.
 */
export interface SentArchiver {
  append(eml: Buffer, sentAt: Date): Promise<void>;
  /** Connects and logs in: true when the Sent folder exists; throws when the login fails. */
  verify(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SentArchiverFactory {
  create(mailbox: ResolvedMailbox, imap: ResolvedImap): SentArchiver;
}

class ImapflowSentArchiver implements SentArchiver {
  private client: ImapFlow | undefined;

  public constructor(private readonly imap: ResolvedImap) {}

  public async append(eml: Buffer, sentAt: Date): Promise<void> {
    const client = await this.connected();
    try {
      await client.append(this.imap.sentFolder, eml, ['\\Seen'], sentAt);
    } catch (error: unknown) {
      // Providers ship the Sent folder; a bare test server may not. Create it
      // once when it is genuinely missing, otherwise give up on this connection.
      if (client.usable && (await this.folderMissing(client))) {
        await client.mailboxCreate(this.imap.sentFolder);
        await client.append(this.imap.sentFolder, eml, ['\\Seen'], sentAt);

        return;
      }
      await this.close();
      throw error;
    }
  }

  private async folderMissing(client: ImapFlow): Promise<boolean> {
    try {
      const folders = await client.list();

      return !folders.some((folder) => folder.path === this.imap.sentFolder);
    } catch {
      return false;
    }
  }

  /** Logs in and looks for the Sent folder. Login problems throw; a missing folder is reported as false. */
  public async verify(): Promise<boolean> {
    const client = await this.connected();
    const folders = await client.list();

    return folders.some((folder) => folder.path === this.imap.sentFolder);
  }

  public async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client === undefined) {
      return;
    }
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }

  private async connected(): Promise<ImapFlow> {
    if (this.client?.usable === true) {
      return this.client;
    }
    this.client = undefined;
    const client = new ImapFlow({
      host: this.imap.host,
      port: this.imap.port,
      secure: this.imap.security === 'tls',
      auth: { user: this.imap.username, pass: this.imap.password.reveal() },
      logger: false,
      emitLogs: false,
    });
    client.on('error', () => {
      // Reported by the operation in flight; the next append reconnects.
      this.client = undefined;
    });
    try {
      await client.connect();
    } catch (error: unknown) {
      throw isImapAuthFailure(error) ? new ImapAuthError() : error;
    }
    this.client = client;

    return client;
  }
}

export class ImapflowSentArchiverFactory implements SentArchiverFactory {
  public create(_mailbox: ResolvedMailbox, imap: ResolvedImap): SentArchiver {
    return new ImapflowSentArchiver(imap);
  }
}
