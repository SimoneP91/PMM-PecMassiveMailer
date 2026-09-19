import { randomBytes } from 'node:crypto';

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { Connection, type AsyncMessage, type SyncMessage } from 'rabbitmq-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { startContainer, type Container } from '../../src/app/container';
import { createLogger } from '../../src/common/logger';
import { loadConfig, type Config } from '../../src/config/config';
import { ImapProofLookup } from '../../src/modules/receipts/sent-proof';
import { messageIdFor } from '../../src/modules/sending/mime/eml-builder';
import { declarations } from '../../src/queue/rabbit-queues';
import { buildEnvelope, buildReceipt } from '../helpers/receipts';
import { PDF, sendRequest } from '../helpers/sender-fakes';

/**
 * The whole container against a real RabbitMQ and a real Greenmail
 * (docker-compose.test.yml): a PEC published in the input queue reaches the
 * recipient's mailbox, its copy lands in the Sent folder, and its outcome in
 * the output queue. Every test has its own queues and its own mailboxes.
 */
const RABBIT = process.env['RABBITMQ_TEST_URL'] ?? 'amqp://test:test@127.0.0.1:5673';
const GREENMAIL = process.env['GREENMAIL_HOST'] ?? '127.0.0.1';
const SMTP_PORT = process.env['GREENMAIL_SMTP_PORT'] ?? '13025';
const IMAP_PORT = Number(process.env['GREENMAIL_IMAP_PORT'] ?? '13143');
const logger = createLogger({ level: 'silent', pretty: false });

let admin: Connection;
const running: Container[] = [];
const queuesToDelete: string[] = [];

function testConfig(): Config {
  const run = randomBytes(4).toString('hex');
  const config = loadConfig({
    PECMAILER_TENANT: 'serfin',
    PECMAILER_MAILBOX: `mbx-${run}`,
    PECMAILER_PROVIDER: 'custom',
    PECMAILER_FROM_ADDRESS: `sender-${run}@pec.example`,
    PECMAILER_FROM_NAME: 'Serfin - Test',
    PECMAILER_SMTP_HOST: GREENMAIL,
    PECMAILER_SMTP_PORT: SMTP_PORT,
    PECMAILER_SMTP_SECURITY: 'none',
    PECMAILER_SMTP_PASSWORD: 'any',
    PECMAILER_SMTP_TIMEOUT_SECONDS: '10',
    PECMAILER_IMAP_HOST: GREENMAIL,
    PECMAILER_IMAP_PORT: String(IMAP_PORT),
    PECMAILER_IMAP_SECURITY: 'none',
    PECMAILER_IMAP_SENT_FOLDER: 'Sent',
    PECMAILER_PER_MINUTE: '0',
    PECMAILER_REDELIVERY_WAIT_SECONDS: '3',
    PECMAILER_RECEIPTS_POLL_SECONDS: '5',
    PECMAILER_PEC_DOMAINS: 'pec.example',
    RABBITMQ_URL: RABBIT,
    PECMAILER_QUEUE_PREFIX: `it${run}`,
    HEALTH_PORT: '0',
  });
  queuesToDelete.push(config.queues.input, config.queues.output, config.queues.dead);

  return config;
}

async function start(config: Config): Promise<Container> {
  const container = await startContainer(config, logger);
  running.push(container);

  return container;
}

async function publish(queue: string, body: unknown): Promise<void> {
  const publisher = admin.createPublisher({ confirm: true });
  try {
    await publisher.send({ routingKey: queue, durable: true }, body);
  } finally {
    await publisher.close();
  }
}

/** The next message of a queue, waiting for it. */
async function next(queue: string, timeoutMs = 20_000): Promise<SyncMessage> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const channel = await admin.acquire();
    const message = await channel.basicGet({ queue, noAck: true });
    await channel.close();
    if (message !== undefined) {
      return message;
    }
    if (Date.now() > until) {
      throw new Error(`nothing arrived in ${queue}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The next event of a given type, passing over the others (receipts and outcomes share the output queue). */
async function eventOf(queue: string, event: string, timeoutMs = 30_000): Promise<SyncMessage> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const message = await next(queue, Math.max(until - Date.now(), 1));
    if (message.type === event) {
      return message;
    }
  }
}

async function imap(user: string): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: GREENMAIL,
    port: IMAP_PORT,
    secure: false,
    auth: { user, pass: 'any' },
    logger: false,
  });
  client.on('error', () => undefined);
  await client.connect();

  return client;
}

async function messagesIn(user: string, folder: string): Promise<Buffer[]> {
  const client = await imap(user);
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const found: Buffer[] = [];
      for await (const message of client.fetch('1:*', { source: true })) {
        if (message.source !== undefined) {
          found.push(message.source);
        }
      }

      return found;
    } finally {
      lock.release();
    }
  } catch {
    return [];
  } finally {
    await client.logout().catch(() => undefined);
  }
}

/** Like a container killed while handling it: the message is taken, never acknowledged, and comes back redelivered. */
async function crashWhileHandling(config: Config): Promise<void> {
  const channel = await admin.acquire();
  await new Promise<AsyncMessage>((resolve) => {
    void channel.basicConsume({ queue: config.queues.input }, resolve);
  });
  await channel.close();
}

beforeAll(() => {
  admin = new Connection({ url: RABBIT, retryLow: 200, retryHigh: 1000 });
});

afterEach(async () => {
  for (const container of running.splice(0)) {
    await container.stop();
  }
});

afterAll(async () => {
  for (const queue of queuesToDelete) {
    await admin.queueDelete({ queue }).catch(() => undefined);
  }
  await admin.close();
});

describe('the container against RabbitMQ and Greenmail', () => {
  it('sends a PEC from the input queue, files its copy and reports it sent', async () => {
    const config = testConfig();
    await start(config);
    const recipient = `dest-${randomBytes(4).toString('hex')}@pec.example`;

    await publish(
      config.queues.input,
      sendRequest({ id: 'it-1', to: { address: recipient, name: 'Mario Rossi' } }),
    );

    const outcome = await eventOf(config.queues.output, 'sent');
    const messageId = messageIdFor('it-1', config.mailbox.from.address);
    expect(outcome).toMatchObject({ type: 'sent', messageId: 'sent:it-1' });
    expect(outcome.body).toMatchObject({
      event: 'sent',
      id: 'it-1',
      reference: 'pratica-4521',
      messageId,
      confirmedBy: 'SMTP',
      smtpResponse: expect.stringMatching(/^250/) as string,
      attempts: 1,
      sentCopy: 'ARCHIVED',
    });

    const delivered = await messagesIn(recipient, 'INBOX');
    expect(delivered).toHaveLength(1);
    const mail = await simpleParser(delivered[0] ?? Buffer.alloc(0));
    expect(mail.messageId).toBe(messageId);
    expect(mail.attachments.find((a) => a.filename === 'sollecito.pdf')?.content.equals(PDF)).toBe(true);
    expect(await messagesIn(config.mailbox.from.address, 'Sent')).toHaveLength(1);
  });

  it('rejects a message that breaks a rule, and sends nothing', async () => {
    const config = testConfig();
    await start(config);

    await publish(config.queues.input, sendRequest({ id: 'it-2', to: { address: 'mario@gmail.com' } }));

    const outcome = await eventOf(config.queues.output, 'rejected');
    expect(outcome.body).toMatchObject({
      event: 'rejected',
      id: 'it-2',
      errors: [{ code: 'RECIPIENT_NOT_PEC', field: 'to.address' }],
    });
    expect(await messagesIn(config.mailbox.from.address, 'Sent')).toHaveLength(0);
  });

  it('moves a message it cannot read to the dead-letter queue', async () => {
    const config = testConfig();
    await start(config);

    await publish(config.queues.input, Buffer.from('not JSON at all'));

    const dead = await next(config.queues.dead);
    expect(Buffer.isBuffer(dead.body) ? dead.body.toString() : dead.body).toBe('not JSON at all');
  });

  it('does not resend a redelivered PEC whose acceptance receipt is in the mailbox', async () => {
    const config = testConfig();
    for (const queue of Object.values(declarations(config.queues))) {
      await admin.queueDeclare(queue);
    }
    const messageId = messageIdFor('it-4', config.mailbox.from.address);
    const recipient = `dest-${randomBytes(4).toString('hex')}@pec.example`;
    await publish(config.queues.input, sendRequest({ id: 'it-4', to: { address: recipient } }));
    // The provider accepted it before the container died: the receipt is in the sender's inbox.
    const inbox = await imap(config.mailbox.from.address);
    await inbox.append('INBOX', buildReceipt({ kind: 'accettazione', ref: messageId }));
    await inbox.logout();
    await crashWhileHandling(config);

    await start(config);

    const outcome = await eventOf(config.queues.output, 'sent');
    expect(outcome.body).toMatchObject({
      event: 'sent',
      id: 'it-4',
      messageId,
      confirmedBy: 'ACCEPTANCE_RECEIPT',
      attempts: 0,
    });
    expect(await messagesIn(recipient, 'INBOX')).toHaveLength(0);
  });

  it('reports a redelivered PEC without any receipt as uncertain, and sends nothing', async () => {
    const config = testConfig();
    for (const queue of Object.values(declarations(config.queues))) {
      await admin.queueDeclare(queue);
    }
    const recipient = `dest-${randomBytes(4).toString('hex')}@pec.example`;
    await publish(config.queues.input, sendRequest({ id: 'it-5', to: { address: recipient } }));
    await crashWhileHandling(config);

    await start(config);

    const outcome = await eventOf(config.queues.output, 'uncertain');
    expect(outcome.body).toMatchObject({
      event: 'uncertain',
      id: 'it-5',
      reason: 'REDELIVERED_WITHOUT_ACCEPTANCE',
    });
    expect(await messagesIn(recipient, 'INBOX')).toHaveLength(0);
  });
});

describe('receipts, from the mailbox to the output queue', () => {
  it("publishes the receipts of its PECs, whole, with the sender's id", async () => {
    const config = testConfig();
    await start(config);
    const recipient = `dest-${randomBytes(4).toString('hex')}@pec.example`;
    await publish(config.queues.input, sendRequest({ id: 'it-6', to: { address: recipient } }));
    const sent = await eventOf(config.queues.output, 'sent');
    const messageId = (sent.body as { messageId: string }).messageId;

    // What the provider would do: an acceptance, then the delivery, in the sender's inbox.
    const inbox = await imap(config.mailbox.from.address);
    const acceptance = buildReceipt({ kind: 'accettazione', ref: messageId });
    await inbox.append('INBOX', acceptance);
    await inbox.append('INBOX', buildReceipt({ kind: 'avvenuta-consegna', ref: messageId, recipient }));
    await inbox.logout();

    const first = await eventOf(config.queues.output, 'receipt');
    const second = await eventOf(config.queues.output, 'receipt');
    expect(first.body).toMatchObject({ id: 'it-6', messageId, receiptType: 'ACCEPTANCE', final: false });
    expect(second.body).toMatchObject({
      id: 'it-6',
      messageId,
      receiptType: 'DELIVERY',
      final: true,
      recipient,
    });
    const eml = Buffer.from((first.body as { eml: string }).eml, 'base64');
    expect(eml.equals(acceptance)).toBe(true);
  }, 60_000);
});

describe('ImapProofLookup against Greenmail', () => {
  it('finds the receipt of a Message-ID, and never takes an envelope for one', async () => {
    const user = `proof-${randomBytes(4).toString('hex')}@pec.example`;
    const messageId = `<pm.proof-1@pec.example>`;
    const client = await imap(user);
    await client.append('INBOX', buildEnvelope(buildReceipt({ kind: 'avvenuta-consegna', ref: messageId })));
    await client.append(
      'INBOX',
      buildReceipt({ kind: 'accettazione', ref: '<pm.someone-else@pec.example>' }),
    );
    await client.logout();
    const lookup = new ImapProofLookup({
      host: GREENMAIL,
      port: IMAP_PORT,
      security: 'none',
      username: user,
      password: testConfig().mailbox.smtp.password,
      sentFolder: 'Sent',
      receiptsFolder: 'INBOX',
    });

    expect(await lookup.find(messageId)).toBeUndefined();

    const again = await imap(user);
    await again.append('INBOX', buildReceipt({ kind: 'accettazione', ref: messageId }));
    await again.logout();

    expect(await lookup.find(messageId)).toMatchObject({ type: 'ACCEPTANCE' });
  });
});
