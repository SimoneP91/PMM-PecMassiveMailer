import { randomBytes } from 'node:crypto';

import { ImapFlow } from 'imapflow';
import { afterEach, describe, expect, it } from 'vitest';

import { Secret } from '../../src/common/security/secret';
import { asMailboxCode, asTenantId } from '../../src/common/types/branded';
import type { ResolvedImap, ResolvedMailbox } from '../../src/config/config.loader';
import { ImapflowReceiptSourceFactory } from '../../src/modules/receipts/receipt-source';
import { buildReceipt } from '../helpers/receipts';

/**
 * The real IMAP reader against Greenmail (docker-compose.test.yml, IMAP on
 * 13143, any login accepted). Every test works in a mailbox of its own, so
 * the suite can run again without a restart of the container.
 */
const HOST = process.env['GREENMAIL_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['GREENMAIL_IMAP_PORT'] ?? '13143');

const clients: ImapFlow[] = [];

function imapFor(user: string, folder = 'INBOX'): ResolvedImap {
  return {
    host: HOST,
    port: PORT,
    security: 'none',
    username: user,
    password: new Secret('any'),
    sentFolder: 'Sent',
    receiptsFolder: folder,
  };
}

/** A second, ordinary client: the "provider" that drops receipts in the folder. */
async function provider(user: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: HOST,
    port: PORT,
    secure: false,
    auth: { user, pass: 'any' },
    logger: false,
  });
  client.on('error', () => undefined);
  await client.connect();
  clients.push(client);

  return client;
}

function newUser(): string {
  return `receipts-${randomBytes(4).toString('hex')}@localhost`;
}

function receipt(n: number): Buffer {
  return buildReceipt({ kind: 'accettazione', ref: `<m_it${String(n)}@pec.serfin.example>` });
}

const source = (imap: ResolvedImap): ReturnType<ImapflowReceiptSourceFactory['create']> =>
  new ImapflowReceiptSourceFactory().create(
    { code: asMailboxCode('it'), tenantId: asTenantId('t_it') } as ResolvedMailbox,
    imap,
  );

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.logout().catch(() => undefined);
  }
});

describe('ImapflowReceiptSource against Greenmail', () => {
  it('reads the new mails oldest first, byte for byte, then resumes after the last UID', async () => {
    const user = newUser();
    const drop = await provider(user);
    const raws = [receipt(1), receipt(2), receipt(3)];
    for (const raw of raws) {
      await drop.append('INBOX', raw);
    }

    const first = await source(imapFor(user)).fetchAfter(0, 2, undefined);
    expect(first.mails).toHaveLength(2);
    expect(first.mails[0]?.raw.equals(raws[0]!)).toBe(true);
    expect(first.mails[1]?.raw.equals(raws[1]!)).toBe(true);
    expect(first.mails[0]?.internalDate).toBeInstanceOf(Date);

    const lastUid = first.mails[1]?.uid ?? 0;
    const second = await source(imapFor(user)).fetchAfter(lastUid, 10, first.uidValidity);
    expect(second.mails.map((mail) => mail.raw.equals(raws[2]!))).toEqual([true]);

    // Past the end: "N:*" would match the last mail again, the reader must not.
    const third = await source(imapFor(user)).fetchAfter(second.mails[0]?.uid ?? 0, 10, first.uidValidity);
    expect(third.mails).toEqual([]);
  });

  it('starts over when the folder was recreated (another UIDVALIDITY)', async () => {
    const user = newUser();
    const drop = await provider(user);
    await drop.append('INBOX', receipt(1));

    const read = await source(imapFor(user)).fetchAfter(999, 10, 'a-uidvalidity-from-another-folder');

    expect(read.mails).toHaveLength(1);
  });

  it('leaves the mailbox untouched: nothing marked as read, nothing moved', async () => {
    const user = newUser();
    const drop = await provider(user);
    await drop.append('INBOX', receipt(1));

    await source(imapFor(user)).fetchAfter(0, 10, undefined);

    const lock = await drop.getMailboxLock('INBOX');
    try {
      const message = await drop.fetchOne('*', { flags: true });
      const flags = message === false || message === undefined ? undefined : [...(message.flags ?? [])];
      expect(flags).toEqual([]);
      expect(drop.mailbox === false ? 0 : drop.mailbox.exists).toBe(1);
    } finally {
      lock.release();
    }
  });

  it('reads the folder it is configured for', async () => {
    const user = newUser();
    const drop = await provider(user);
    await drop.mailboxCreate('Ricevute');
    await drop.append('Ricevute', receipt(1));
    await drop.append('INBOX', receipt(2));

    const read = await source(imapFor(user, 'Ricevute')).fetchAfter(0, 10, undefined);

    expect(read.mails).toHaveLength(1);
    expect(read.mails[0]?.raw.toString('utf8')).toContain('m_it1@');
  });
});
