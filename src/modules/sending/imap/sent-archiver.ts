import { Injectable } from '@nestjs/common';
import { ImapFlow } from 'imapflow';

import type { ResolvedImap, ResolvedMailbox } from '../../../config/config.loader';

/**
 * Files a copy of a sent message in the mailbox's Sent folder, so the
 * provider's webmail shows what left - the habit of the legacy sender and
 * what the client's operators expect to find.
 *
 * A failure here never changes the fate of the message: it was sent. It is
 * recorded on the message (sentCopy = FAILED) and the next message tries a
 * fresh connection.
 */
export interface SentArchiver {
  append(eml: Buffer, sentAt: Date): Promise<void>;
  /** Connects, logs in and checks the Sent folder exists. */
  verify(): Promise<void>;
  close(): Promise<void>;
}

export interface SentArchiverFactory {
  create(mailbox: ResolvedMailbox, imap: ResolvedImap): SentArchiver;
}

export const SENT_ARCHIVER_FACTORY = Symbol('SENT_ARCHIVER_FACTORY');

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

  public async verify(): Promise<void> {
    const client = await this.connected();
    const status = await client.status(this.imap.sentFolder, { messages: true });
    if (typeof status.messages !== 'number') {
      throw new Error(`folder "${this.imap.sentFolder}" not found`);
    }
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
    await client.connect();
    this.client = client;

    return client;
  }
}

@Injectable()
export class ImapflowSentArchiverFactory implements SentArchiverFactory {
  public create(_mailbox: ResolvedMailbox, imap: ResolvedImap): SentArchiver {
    return new ImapflowSentArchiver(imap);
  }
}
