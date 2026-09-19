import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

import { messageIdFor } from '../../../src/modules/sending/mime/eml-builder';
import type { InputMessage } from '../../../src/queue/queues';
import { testMailbox } from '../../helpers/mailbox';
import { sendRequest, senderFixture, smtpFailure } from '../../helpers/sender-fakes';

const MESSAGE_ID = messageIdFor('pec-0001', 'solleciti@pec.serfin.example');

function fresh(body: unknown): InputMessage {
  return { body, redelivered: false, deliveryCount: 0 };
}

function redelivered(body: unknown): InputMessage {
  return { body, redelivered: true, deliveryCount: 1 };
}

describe('PecSender: a PEC taken for the first time', () => {
  it('sends it, files the copy and reports it sent with everything the sender needs', async () => {
    const { sender, queues, smtp, archiver } = senderFixture();

    expect(await sender.handle(fresh(sendRequest()))).toBe('done');

    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]).toMatchObject({
      from: 'solleciti@pec.serfin.example',
      to: 'destinatario@pec.example',
    });
    const mail = await simpleParser(smtp.sent[0]?.raw ?? Buffer.alloc(0));
    expect(mail.messageId).toBe(MESSAGE_ID);
    expect(mail.attachments.map((a) => a.filename)).toEqual(['logo.png', 'sollecito.pdf']);
    expect(archiver.appended).toHaveLength(1);
    expect(queues.events()).toEqual([
      {
        version: 1,
        event: 'sent',
        eventId: 'sent:pec-0001',
        occurredAt: '2026-09-19T10:00:00.000Z',
        tenant: 'serfin',
        mailbox: 'serfin-aruba',
        id: 'pec-0001',
        reference: 'pratica-4521',
        batch: 'solleciti-09',
        messageId: MESSAGE_ID,
        sentAt: '2026-09-19T10:00:00.000Z',
        confirmedBy: 'SMTP',
        smtpResponse: '250 2.0.0 Ok: queued as FAKE1',
        attempts: 1,
        sentCopy: 'ARCHIVED',
        warnings: [],
      },
    ]);
  });

  it('reports a message that breaks a rule as rejected, and sends nothing', async () => {
    const { sender, queues, smtp } = senderFixture();

    await sender.handle(fresh(sendRequest({ to: { address: 'mario@gmail.com' } })));

    expect(smtp.sent).toEqual([]);
    expect(queues.events('rejected')).toEqual([
      expect.objectContaining({
        eventId: 'rejected:pec-0001',
        id: 'pec-0001',
        reference: 'pratica-4521',
        errors: [{ code: 'RECIPIENT_NOT_PEC', field: 'to.address', detail: expect.any(String) as string }],
      }),
    ]);
  });

  it('rejects a PEC larger than the mailbox accepts once encoded', async () => {
    const { sender, queues, smtp } = senderFixture({
      mailbox: testMailbox({ limits: { perMinute: 0, maxMessageBytes: 500 } }),
    });

    await sender.handle(fresh(sendRequest()));

    expect(smtp.sent).toEqual([]);
    expect(queues.events('rejected')[0]).toMatchObject({
      errors: [
        { code: 'MESSAGE_TOO_LARGE', detail: expect.stringContaining('bytes once encoded') as string },
      ],
    });
  });

  it('sends a message that cannot be answered to the dead-letter queue', async () => {
    const { sender, queues } = senderFixture();

    expect(await sender.handle(fresh(undefined))).toBe('dead');
    expect(await sender.handle(fresh({ subject: 'no id' }))).toBe('dead');
    expect(queues.published).toEqual([]);
  });

  it('retries a temporary failure after the configured waits, then sends', async () => {
    const { sender, queues, smtp, sleeper } = senderFixture();
    smtp.script.push(smtpFailure.temporary(), smtpFailure.temporary(421));

    await sender.handle(fresh(sendRequest()));

    expect(sleeper.waits).toEqual([60_000, 300_000]);
    expect(queues.events('sent')[0]).toMatchObject({ attempts: 3 });
  });

  it('gives up when temporary failures outlast the retries', async () => {
    const { sender, queues, smtp } = senderFixture();
    smtp.script.push(smtpFailure.temporary(), smtpFailure.temporary(), smtpFailure.temporary());

    await sender.handle(fresh(sendRequest()));

    expect(smtp.sent).toEqual([]);
    expect(queues.events('failed')).toEqual([
      expect.objectContaining({
        eventId: 'failed:pec-0001',
        code: 'RETRIES_EXHAUSTED',
        smtpCode: 451,
        detail: expect.stringContaining('SMTP_451') as string,
        attempts: 3,
      }),
    ]);
  });

  it('reports a permanent refusal as failed, without retrying', async () => {
    const { sender, queues, smtp, sleeper } = senderFixture();
    smtp.script.push(smtpFailure.refused());

    await sender.handle(fresh(sendRequest()));

    expect(sleeper.waits).toEqual([]);
    expect(queues.events('failed')[0]).toMatchObject({ code: 'SMTP_550', smtpCode: 550, attempts: 1 });
  });

  it('reports a connection lost after the provider had the message as uncertain, never retried', async () => {
    const { sender, queues, smtp } = senderFixture();
    smtp.script.push(smtpFailure.lostAfterData());

    await sender.handle(fresh(sendRequest()));

    expect(smtp.sent).toEqual([]);
    expect(queues.events('uncertain')).toEqual([
      expect.objectContaining({ reason: 'CONNECTION_LOST_AFTER_DATA', messageId: MESSAGE_ID }),
    ]);
  });

  it('suspends the mailbox on a refused password: the PEC goes back to the queue as new, nothing else is taken', async () => {
    const { sender, suspension, queues, smtp } = senderFixture();
    smtp.script.push(smtpFailure.authRefused());
    const body = sendRequest();

    expect(await sender.handle(fresh(body))).toBe('done');

    expect(queues.returned).toEqual([body]);
    expect(queues.stopped).toBe(1);
    expect(suspension.cause).toBe('SMTP_AUTH_REFUSED');
    expect(queues.events()).toEqual([
      expect.objectContaining({
        event: 'mailbox.suspended',
        eventId: 'mailbox.suspended:serfin-aruba:2026-09-19T10:00:00.000Z',
        cause: 'SMTP_AUTH_REFUSED',
      }),
    ]);

    // A message already on its way to the container is not sent either.
    const next = sendRequest({ id: 'pec-0002' });
    expect(await sender.handle(fresh(next))).toBe('done');
    expect(queues.returned).toEqual([body, next]);
    await expect(sender.handle(redelivered(sendRequest({ id: 'pec-0003' })))).rejects.toThrow(/suspended/);
    expect(smtp.sent).toEqual([]);
  });

  it('suspends the mailbox when the login for the Sent copy is refused; the PEC left, and is reported sent', async () => {
    const { sender, suspension, queues, archiver } = senderFixture();
    archiver.refuseLogin = true;

    expect(await sender.handle(fresh(sendRequest()))).toBe('done');

    expect(suspension.cause).toBe('IMAP_AUTH_REFUSED');
    expect(queues.stopped).toBe(1);
    expect(queues.events().map((event) => event.event)).toEqual(['mailbox.suspended', 'sent']);
    expect(queues.events('sent')[0]).toMatchObject({
      sentCopy: 'FAILED',
      sentCopyError: 'IMAP login refused',
    });
  });

  it('reports the PEC sent even when the copy in the Sent folder fails', async () => {
    const { sender, queues, archiver } = senderFixture();
    archiver.failFor = 'Sollecito pratica 4521';

    await sender.handle(fresh(sendRequest()));

    expect(queues.events('sent')[0]).toMatchObject({
      sentCopy: 'FAILED',
      sentCopyError: 'IMAP APPEND failed (fake)',
    });
  });

  it('carries the warnings of the checks in the sent event', async () => {
    const { sender, queues } = senderFixture();

    await sender.handle(
      fresh(
        sendRequest({
          html: '<p>no image used</p>',
          inlineImages: [
            {
              cid: 'logo',
              content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'),
            },
          ],
        }),
      ),
    );

    expect(queues.events('sent')[0]).toMatchObject({
      warnings: [{ code: 'UNUSED_INLINE_IMAGE', field: 'inlineImages' }],
    });
  });

  it('throws when the outcome cannot be published, so the message stays in the queue', async () => {
    const { sender, queues } = senderFixture();
    queues.failPublish = true;

    await expect(sender.handle(fresh(sendRequest()))).rejects.toThrow(/did not confirm/);
  });

  it('puts the PEC back, unsent, when stopping between two attempts', async () => {
    const { sender, queues, smtp, sleeper, stop } = senderFixture();
    smtp.script.push(smtpFailure.temporary());
    sleeper.onSleep = () => {
      stop.abort();
    };
    const body = sendRequest();

    expect(await sender.handle(fresh(body))).toBe('done');

    expect(queues.returned).toEqual([body]);
    expect(queues.published).toEqual([]);
  });
});

describe('PecSender: a PEC delivered again after an interruption', () => {
  it('never resends it: its acceptance receipt proves it left, so it is reported sent', async () => {
    const { sender, queues, smtp, proof } = senderFixture();
    proof.proofs.set(MESSAGE_ID, { type: 'ACCEPTANCE', issuedAt: new Date('2026-09-19T09:59:58Z') });

    expect(await sender.handle(redelivered(sendRequest()))).toBe('done');

    expect(smtp.sent).toEqual([]);
    expect(queues.events()).toEqual([
      expect.objectContaining({
        event: 'sent',
        eventId: 'sent:pec-0001',
        messageId: MESSAGE_ID,
        sentAt: '2026-09-19T09:59:58.000Z',
        confirmedBy: 'ACCEPTANCE_RECEIPT',
        attempts: 0,
        sentCopy: 'UNKNOWN',
      }),
    ]);
  });

  it('waits for a receipt that arrives late, looking again at intervals', async () => {
    const { sender, queues, proof, sleeper } = senderFixture();
    sleeper.onSleep = () => {
      if (sleeper.waits.length === 2) {
        proof.proofs.set(MESSAGE_ID, { type: 'ACCEPTANCE', issuedAt: undefined });
      }
    };

    await sender.handle(redelivered(sendRequest()));

    expect(proof.searched).toHaveLength(3);
    expect(queues.events()[0]).toMatchObject({ event: 'sent', confirmedBy: 'ACCEPTANCE_RECEIPT' });
  });

  it('reports it uncertain, and sends nothing, when no receipt comes in time', async () => {
    const { sender, queues, smtp, sleeper } = senderFixture();

    await sender.handle(redelivered(sendRequest()));

    expect(smtp.sent).toEqual([]);
    expect(sleeper.waits.reduce((sum, wait) => sum + wait, 0)).toBe(120_000);
    expect(queues.events()).toEqual([
      expect.objectContaining({
        event: 'uncertain',
        eventId: 'uncertain:pec-0001',
        reason: 'REDELIVERED_WITHOUT_ACCEPTANCE',
        messageId: MESSAGE_ID,
      }),
    ]);
  });

  it('reports a message that breaks a rule as rejected: such a message is never sent', async () => {
    const { sender, queues, proof } = senderFixture();

    await sender.handle(redelivered(sendRequest({ html: '<p>ok</p><script>alert(1)</script>' })));

    expect(proof.searched).toEqual([]);
    expect(queues.events()[0]).toMatchObject({ event: 'rejected' });
  });

  it('does not judge the recipient again: a DNS answer that changed cannot turn a PEC that left into rejected', async () => {
    const { sender, queues, proof } = senderFixture();
    // Unclassifiable today (the stub's answer to any unknown domain), but the PEC had left.
    proof.proofs.set(MESSAGE_ID, { type: 'ACCEPTANCE', issuedAt: undefined });

    await sender.handle(redelivered(sendRequest({ to: { address: 'mario@studio-rossi.it' } })));

    expect(queues.events()).toEqual([
      expect.objectContaining({ event: 'sent', confirmedBy: 'ACCEPTANCE_RECEIPT' }),
    ]);
  });

  it('reports it uncertain at once when IMAP is off and nothing can be looked for', async () => {
    const { sender, queues } = senderFixture({ proof: null });

    await sender.handle(redelivered(sendRequest()));

    expect(queues.events()[0]).toMatchObject({
      event: 'uncertain',
      detail: expect.stringContaining('IMAP is off') as string,
    });
  });

  it('suspends the mailbox when the IMAP login is refused, and reports the PEC uncertain', async () => {
    const { sender, suspension, queues, proof } = senderFixture();
    proof.refuseLogin = true;

    await sender.handle(redelivered(sendRequest()));

    expect(suspension.cause).toBe('IMAP_AUTH_REFUSED');
    expect(queues.events().map((event) => event.event)).toEqual(['mailbox.suspended', 'uncertain']);
  });

  it('stays in the queue, still marked as delivered before, when stopping while looking', async () => {
    const { sender, sleeper, stop, queues } = senderFixture();
    sleeper.onSleep = () => {
      stop.abort();
    };

    await expect(sender.handle(redelivered(sendRequest()))).rejects.toThrow(/stopping/);
    expect(queues.returned).toEqual([]);
    expect(queues.published).toEqual([]);
  });
});

describe('PecSender: liveness', () => {
  it('is alive while idle or handling, and stalled when one handling lasts far too long', async () => {
    const { sender, clock, smtp, sleeper } = senderFixture({ retryBackoffSeconds: [36 * 60] });
    smtp.script.push(smtpFailure.temporary());
    let aliveDuringWait: boolean | undefined;
    sleeper.onSleep = (ms) => {
      clock.at += ms;
      aliveDuringWait = sender.isAlive();
      clock.at -= ms;
    };

    expect(sender.isAlive()).toBe(true);
    await sender.handle(fresh(sendRequest()));

    expect(aliveDuringWait).toBe(false);
    expect(sender.isAlive()).toBe(true);
  });
});
