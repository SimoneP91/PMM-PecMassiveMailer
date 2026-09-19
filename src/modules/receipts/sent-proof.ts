import { ImapFlow } from 'imapflow';

import type { ResolvedImap } from '../../config/config';
import { ImapAuthError, isImapAuthFailure } from '../sending/imap/imap-auth-error';
import { parseReceipt, type ReceiptType } from './receipt-parser';

export interface SentProof {
  readonly type: ReceiptType;
  readonly issuedAt: Date | undefined;
}

/**
 * Was this PEC sent? Asked when a message comes back from the queue after an
 * interruption: the previous handling may have sent it, and a PEC must never
 * go out twice. The answer comes from the provider, not from us: a receipt
 * about the Message-ID (normally the acceptance, issued within seconds) is
 * proof that the provider took the message.
 */
export interface ProofLookup {
  find(messageId: string): Promise<SentProof | undefined>;
}

const MAX_CANDIDATES = 10;

export class ImapProofLookup implements ProofLookup {
  public constructor(private readonly imap: ResolvedImap) {}

  public async find(messageId: string): Promise<SentProof | undefined> {
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
      throw isImapAuthFailure(error) ? new ImapAuthError() : error;
    }

    try {
      // Read-only, as everywhere: the client's mailbox is never changed.
      const lock = await client.getMailboxLock(this.imap.receiptsFolder, { readOnly: true });
      try {
        const found = await client.search(
          { header: { 'x-riferimento-message-id': messageId } },
          { uid: true },
        );
        const uids = (Array.isArray(found) ? found : []).slice(-MAX_CANDIDATES);
        for (const uid of uids) {
          const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (message === false || message?.source === undefined) {
            continue;
          }
          // The search matches substrings of any header: the parser decides, with the same trust rules as ever.
          const parsed = await parseReceipt(message.source);
          if (parsed.kind === 'receipt' && parsed.refMessageId === messageId) {
            return { type: parsed.type, issuedAt: parsed.issuedAt };
          }
        }

        return undefined;
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
