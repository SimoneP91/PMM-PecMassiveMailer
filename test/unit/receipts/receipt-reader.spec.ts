import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createLogger } from '../../../src/common/logger';
import { ReceiptReader } from '../../../src/modules/receipts/receipt-reader';
import { MailboxSuspension } from '../../../src/modules/sending/mailbox-suspension';
import { messageIdFor } from '../../../src/modules/sending/mime/eml-builder';
import { OutcomeEvents, type ReceiptEvent } from '../../../src/modules/sending/outcome-events';
import { testMailbox } from '../../helpers/mailbox';
import { buildEnvelope, buildReceipt, FakeReceiptSourceFactory } from '../../helpers/receipts';
import { FakeQueues, InstantSleeper, ManualClock } from '../../helpers/sender-fakes';

const IMAP = {
  host: 'imap.example',
  port: 993,
  security: 'tls' as const,
  username: 'solleciti@pec.serfin.example',
  password: testMailbox().smtp.password,
  sentFolder: 'Sent',
  receiptsFolder: 'INBOX',
};
const MAILBOX = testMailbox({ imap: IMAP });
const OURS = messageIdFor('pec-0001', MAILBOX.from.address);
const sha256 = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');

function setup(): {
  readonly reader: () => ReceiptReader;
  readonly source: FakeReceiptSourceFactory;
  readonly queues: FakeQueues;
  readonly suspension: MailboxSuspension;
  readonly clock: ManualClock;
} {
  const clock = new ManualClock();
  const source = new FakeReceiptSourceFactory();
  const queues = new FakeQueues();
  const logger = createLogger({ level: 'silent', pretty: false });
  const events = new OutcomeEvents('serfin', 'serfin-aruba', clock);
  const suspension = new MailboxSuspension(queues, events, logger);

  return {
    source,
    queues,
    suspension,
    clock,
    // A function: each call is a container (re)start, with a fresh in-memory cursor.
    reader: () =>
      new ReceiptReader({
        mailbox: MAILBOX,
        imap: IMAP,
        sources: source,
        queues,
        events,
        suspension,
        clock,
        sleeper: new InstantSleeper(clock),
        logger,
        settings: { pollIntervalSeconds: 60, lookbackHours: 72, maxPerPoll: 200 },
        signal: new AbortController().signal,
      }),
  };
}

describe('ReceiptReader', () => {
  it("publishes a receipt of our PEC whole, with the sender's id read back from the Message-ID", async () => {
    const { reader, source, queues, clock } = setup();
    const raw = buildReceipt({
      kind: 'avvenuta-consegna',
      ref: OURS,
      recipient: 'destinatario@pec.example',
      messageId: '<opec21.delivery.1@pec.aruba.it>',
    });
    source.deliver(MAILBOX.code, raw, new Date(clock.at));

    expect(await reader().readOnce()).toEqual({ published: 1, notOurs: 0, ignored: 0, skipped: 0 });

    const [event] = queues.events<ReceiptEvent>('receipt');
    expect(event).toMatchObject({
      version: 1,
      event: 'receipt',
      eventId: `receipt:${sha256('<opec21.delivery.1@pec.aruba.it>')}`,
      tenant: 'serfin',
      mailbox: 'serfin-aruba',
      id: 'pec-0001',
      messageId: OURS,
      receiptType: 'DELIVERY',
      final: true,
      issuedAt: '2026-09-19T08:15:03.000Z',
      provider: 'ARUBA PEC S.p.A.',
      recipient: 'destinatario@pec.example',
      receiptMessageId: '<opec21.delivery.1@pec.aruba.it>',
      emlSha256: sha256(raw),
    });
    expect(Buffer.from(event?.eml ?? '', 'base64').equals(raw)).toBe(true);
    expect(Buffer.from(event?.daticert ?? '', 'base64').toString('utf8')).toContain(
      '<postacert tipo="avvenuta-consegna"',
    );
    expect(event).not.toHaveProperty('error');
  });

  it('carries the reason of a non-delivery, and says which receipts are final', async () => {
    const { reader, source, queues } = setup();
    source.deliver(MAILBOX.code, buildReceipt({ kind: 'accettazione', ref: OURS }));
    source.deliver(
      MAILBOX.code,
      buildReceipt({
        kind: 'errore-consegna',
        ref: OURS,
        errore: 'altro',
        erroreEsteso: '5.1.1 - indirizzo non valido',
      }),
    );

    await reader().readOnce();

    expect(queues.events('receipt')).toEqual([
      expect.objectContaining({ receiptType: 'ACCEPTANCE', final: false }),
      expect.objectContaining({
        receiptType: 'NON_DELIVERY',
        final: true,
        error: { code: 'altro', detail: '5.1.1 - indirizzo non valido' },
      }),
    ]);
  });

  it('leaves out envelopes, ordinary mail and receipts of messages it did not send, downloading only possible receipts', async () => {
    const { reader, source, queues } = setup();
    source.deliver(MAILBOX.code, buildEnvelope(buildReceipt({ kind: 'avvenuta-consegna', ref: OURS })));
    source.deliver(
      MAILBOX.code,
      Buffer.from('From: a@pec.it\r\nTo: b@pec.it\r\nSubject: hi\r\n\r\nhello\r\n'),
    );
    source.deliver(
      MAILBOX.code,
      buildReceipt({ kind: 'accettazione', ref: '<m_legacy00000001@pec.serfin.example>' }),
    );

    expect(await reader().readOnce()).toEqual({ published: 0, notOurs: 1, ignored: 2, skipped: 0 });
    expect(source.bodies).toBe(1);
    expect(queues.published).toEqual([]);
  });

  it('reads only the new mails at the next pass', async () => {
    const { reader, source, queues } = setup();
    const instance = reader();
    source.deliver(MAILBOX.code, buildReceipt({ kind: 'accettazione', ref: OURS }));
    await instance.readOnce();
    source.deliver(MAILBOX.code, buildReceipt({ kind: 'avvenuta-consegna', ref: OURS }));

    expect(await instance.readOnce()).toMatchObject({ published: 1 });
    expect(queues.events('receipt').map((event) => event['receiptType'])).toEqual(['ACCEPTANCE', 'DELIVERY']);
  });

  it('after a restart reads the last hours again: same events, same ids, for the consumer to discard', async () => {
    const { reader, source, queues, clock } = setup();
    source.deliver(
      MAILBOX.code,
      buildReceipt({ kind: 'accettazione', ref: OURS }),
      new Date(clock.at - 80 * 3_600_000),
    );
    source.deliver(
      MAILBOX.code,
      buildReceipt({ kind: 'avvenuta-consegna', ref: OURS }),
      new Date(clock.at - 3_600_000),
    );

    await reader().readOnce();
    await reader().readOnce();

    // The acceptance is older than the 72-hour window: not read again after a start.
    const ids = queues.events('receipt').map((event) => event.eventId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(queues.events('receipt').map((event) => event['receiptType'])).toEqual(['DELIVERY', 'DELIVERY']);
  });

  it('reads a receipt again at the next pass when it could not be published, however long it takes', async () => {
    const { reader, source, queues } = setup();
    const instance = reader();
    source.deliver(MAILBOX.code, buildReceipt({ kind: 'accettazione', ref: OURS }));
    queues.failPublish = true;
    for (let pass = 0; pass < 5; pass += 1) {
      expect(await instance.readOnce()).toMatchObject({ published: 0, skipped: 0 });
    }

    queues.failPublish = false;
    expect(await instance.readOnce()).toMatchObject({ published: 1 });
  });

  it('gives up a mail that cannot be read three times, so the receipts after it still arrive', async () => {
    const { reader, source, queues } = setup();
    const instance = reader();
    source.broken.add(source.deliver(MAILBOX.code, buildReceipt({ kind: 'accettazione', ref: OURS })));
    source.deliver(MAILBOX.code, buildReceipt({ kind: 'avvenuta-consegna', ref: OURS }));

    expect(await instance.readOnce()).toMatchObject({ published: 0, skipped: 0 });
    expect(await instance.readOnce()).toMatchObject({ published: 0, skipped: 0 });
    expect(await instance.readOnce()).toEqual({ published: 1, notOurs: 0, ignored: 0, skipped: 1 });
    expect(queues.events('receipt').map((event) => event['receiptType'])).toEqual(['DELIVERY']);
  });

  it('suspends the mailbox when the IMAP login is refused', async () => {
    const { reader, source, queues, suspension } = setup();
    source.refuseLogin = true;

    await reader().readOnce();

    expect(suspension.cause).toBe('IMAP_AUTH_REFUSED');
    expect(queues.stopped).toBe(1);
    expect(queues.events()).toEqual([
      expect.objectContaining({ event: 'mailbox.suspended', cause: 'IMAP_AUTH_REFUSED' }),
    ]);
  });

  it('reads nothing while the mailbox is suspended', async () => {
    const { reader, source, queues, suspension } = setup();
    await suspension.suspend('SMTP_AUTH_REFUSED', '535');
    source.deliver(MAILBOX.code, buildReceipt({ kind: 'accettazione', ref: OURS }));

    expect(await reader().readOnce()).toMatchObject({ published: 0 });
    expect(queues.events('receipt')).toEqual([]);
  });
});
