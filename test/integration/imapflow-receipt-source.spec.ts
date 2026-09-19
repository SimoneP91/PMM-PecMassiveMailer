import { randomBytes } from 'node:crypto';

import { ImapFlow } from 'imapflow';
import { afterEach, describe, expect, it } from 'vitest';

import { Secret } from '../../src/common/security/secret';
import type { ResolvedImap } from '../../src/config/config';
import { mayBeReceipt } from '../../src/modules/receipts/receipt-parser';
import { ImapflowReceiptSourceFactory, type ReadPosition } from '../../src/modules/receipts/receipt-source';
import { testMailbox } from '../helpers/mailbox';
import { buildEnvelope, buildReceipt } from '../helpers/receipts';

/**
 * The real IMAP reader against Greenmail (docker-compose.test.yml, IMAP on
 * 13143, any login accepted). Every test works in a mailbox of its own, so
 * the suite can run again without a restart of the container.
 */
const HOST = process.env['GREENMAIL_HOST'] ?? '127.0.0.1';
const PORT = Number(process.env['GREENMAIL_IMAP_PORT'] ?? '13143');
const DAY = 24 * 3_600_000;

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

interface Read {
  readonly uidValidity: string | undefined;
  readonly mails: { uid: number; headers: string; raw: Buffer | undefined; internalDate: Date | undefined }[];
}

/** Reads like the worker does: the body only when the headers say it may be a receipt. */
async function read(imap: ResolvedImap, position: Partial<ReadPosition> = {}): Promise<Read> {
  const source = new ImapflowReceiptSourceFactory().create(testMailbox(), imap);
  let uidValidity: string | undefined;
  const mails: Read['mails'] = [];
  await source.read(
    {
      afterUid: 0,
      uidValidity: undefined,
      since: new Date(Date.now() - DAY),
      max: 10,
      ...position,
    },
    async (mail, validity) => {
      uidValidity = validity;
      mails.push({
        uid: mail.uid,
        headers: mail.headers,
        internalDate: mail.internalDate,
        raw: mayBeReceipt(mail.headers) ? await mail.body() : undefined,
      });

      return true;
    },
  );

  return { uidValidity, mails };
}

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

    const first = await read(imapFor(user), { max: 2 });
    expect(first.mails).toHaveLength(2);
    expect(first.mails[0]?.raw?.equals(raws[0]!)).toBe(true);
    expect(first.mails[1]?.raw?.equals(raws[1]!)).toBe(true);
    expect(first.mails[0]?.internalDate).toBeInstanceOf(Date);

    const position = { afterUid: first.mails[1]?.uid ?? 0, uidValidity: first.uidValidity };
    const second = await read(imapFor(user), position);
    expect(second.mails.map((mail) => mail.raw?.equals(raws[2]!))).toEqual([true]);

    // Past the end: "N:*" would match the last mail again, the reader must not.
    const third = await read(imapFor(user), { ...position, afterUid: second.mails[0]?.uid ?? 0 });
    expect(third.mails).toEqual([]);
  });

  it('returns only the two header lines that tell a receipt apart, and fetches nothing else', async () => {
    const user = newUser();
    const drop = await provider(user);
    await drop.append('INBOX', buildEnvelope(receipt(1)));
    await drop.append('INBOX', receipt(2));

    const { mails } = await read(imapFor(user));

    expect(mails.map((mail) => mayBeReceipt(mail.headers))).toEqual([false, true]);
    expect(mails[0]?.headers).toMatch(/^X-Trasporto:/im);
    expect(mails[0]?.headers).not.toMatch(/^Subject:/im);
    expect(mails[0]?.raw).toBeUndefined();
  });

  it('without a usable cursor, starts from the mails received since the given day', async () => {
    const user = newUser();
    const drop = await provider(user);
    await drop.append('INBOX', receipt(1), [], new Date(Date.now() - 10 * DAY));
    await drop.append('INBOX', receipt(2));

    const fresh = await read(imapFor(user));
    expect(fresh.mails.map((mail) => mail.raw?.toString('utf8').includes('m_it2@'))).toEqual([true]);

    // Another UIDVALIDITY (the folder was recreated): the same rule applies.
    const recreated = await read(imapFor(user), { afterUid: 999, uidValidity: 'another-folder' });
    expect(recreated.mails).toHaveLength(1);

    // With a cursor, the date plays no part.
    const resumed = await read(imapFor(user), { afterUid: 0, uidValidity: fresh.uidValidity });
    expect(resumed.mails).toHaveLength(2);
  });

  it('leaves the mailbox untouched: nothing marked as read, nothing moved', async () => {
    const user = newUser();
    const drop = await provider(user);
    await drop.append('INBOX', receipt(1));

    await read(imapFor(user));

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

    const { mails } = await read(imapFor(user, 'Ricevute'));

    expect(mails).toHaveLength(1);
    expect(mails[0]?.raw?.toString('utf8')).toContain('m_it1@');
  });
});
