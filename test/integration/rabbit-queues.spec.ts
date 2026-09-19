import { randomBytes } from 'node:crypto';

import { Connection, type AsyncMessage, type SyncMessage } from 'rabbitmq-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createLogger } from '../../src/common/logger';
import { Secret } from '../../src/common/security/secret';
import type { QueueSettings } from '../../src/config/config';
import type { InputMessage, OutputEvent } from '../../src/queue/queues';
import { RabbitQueues } from '../../src/queue/rabbit-queues';

/**
 * RabbitQueues against a real RabbitMQ (docker-compose.test.yml, AMQP on
 * 5673). Every test gets queues of its own, so the suite can run again
 * without restarting the broker.
 */
const URL = process.env['RABBITMQ_TEST_URL'] ?? 'amqp://test:test@127.0.0.1:5673';
const logger = createLogger({ level: 'silent', pretty: false });

let admin: Connection;
const open: RabbitQueues[] = [];
const created: string[] = [];

function settings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  const base = `it${randomBytes(4).toString('hex')}.serfin.serfin-aruba`;
  created.push(`${base}.in`, `${base}.out`, `${base}.dead`);

  return {
    url: new Secret(URL),
    tenant: 'serfin',
    mailbox: 'serfin-aruba',
    input: `${base}.in`,
    output: `${base}.out`,
    dead: `${base}.dead`,
    declare: true,
    deliveryLimit: 3,
    ...overrides,
  };
}

const PAUSE_MS = 300;

function queues(config: QueueSettings): RabbitQueues {
  const instance = new RabbitQueues(config, logger, { failurePauseMs: PAUSE_MS });
  open.push(instance);

  return instance;
}

async function take(queue: string): Promise<SyncMessage | undefined> {
  const channel = await admin.acquire();
  try {
    const message = await channel.basicGet({ queue, noAck: true });

    return message;
  } finally {
    await channel.close();
  }
}

async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    value = await read();
  }

  return value;
}

async function depth(queue: string): Promise<number> {
  return (await admin.queueDeclare({ queue, passive: true })).messageCount;
}

async function put(queue: string, body: unknown): Promise<void> {
  const publisher = admin.createPublisher({ confirm: true });
  try {
    await publisher.send({ routingKey: queue, durable: true }, body);
  } finally {
    await publisher.close();
  }
}

function event(overrides: Partial<OutputEvent> = {}): OutputEvent {
  return {
    version: 1,
    event: 'sent',
    eventId: `sent:${randomBytes(4).toString('hex')}`,
    occurredAt: new Date().toISOString(),
    tenant: 'serfin',
    mailbox: 'serfin-aruba',
    ...overrides,
  };
}

beforeAll(() => {
  admin = new Connection({ url: URL, retryLow: 200, retryHigh: 1000 });
});

afterEach(async () => {
  for (const instance of open.splice(0)) {
    await instance.close();
  }
});

afterAll(async () => {
  for (const queue of created) {
    await admin.queueDelete({ queue }).catch(() => undefined);
  }
  await admin.close();
});

describe('RabbitQueues against RabbitMQ', () => {
  it('declares the three queues, and declaring again changes nothing', async () => {
    const config = settings();
    await queues(config).prepare();
    await queues(config).prepare();

    for (const queue of [config.input, config.output, config.dead]) {
      expect(await depth(queue)).toBe(0);
    }
  });

  it('publishes an event as persistent JSON, with its id and type', async () => {
    const config = settings();
    const instance = queues(config);
    await instance.prepare();
    const sent = event();

    await instance.publish(sent);

    const message = await take(config.output);
    expect(message).toMatchObject({
      body: sent,
      messageId: sent.eventId,
      type: 'sent',
      contentType: 'application/json',
      durable: true,
    });
  });

  it('hands over one message at a time and forgets it once done', async () => {
    const config = settings();
    const instance = queues(config);
    await instance.prepare();
    await put(config.input, { id: 'first' });
    await put(config.input, { id: 'second' });
    const seen: InputMessage[] = [];
    let busy = 0;
    let overlap = false;

    instance.consume(async (message) => {
      busy += 1;
      overlap ||= busy > 1;
      seen.push(message);
      await new Promise((resolve) => setTimeout(resolve, 100));
      busy -= 1;

      return 'done';
    });

    await eventually(
      () => Promise.resolve(seen.length),
      (n) => n === 2,
    );
    expect(seen.map((message) => message.body)).toEqual([{ id: 'first' }, { id: 'second' }]);
    expect(seen.every((message) => !message.redelivered)).toBe(true);
    expect(overlap).toBe(false);
    expect(
      await eventually(
        () => depth(config.input),
        (n) => n === 0,
      ),
    ).toBe(0);
  });

  it('gives a message back after a pause, marked as delivered before, when the handler fails', async () => {
    const config = settings();
    const instance = queues(config);
    await instance.prepare();
    await put(config.input, { id: 'flaky' });
    const seen: InputMessage[] = [];
    const at: number[] = [];

    instance.consume((message) => {
      seen.push(message);
      at.push(Date.now());
      if (seen.length === 1) {
        return Promise.reject(new Error('the outcome could not be published'));
      }

      return Promise.resolve('done');
    });

    await eventually(
      () => Promise.resolve(seen.length),
      (n) => n === 2,
    );
    expect(seen[0]).toMatchObject({ redelivered: false, deliveryCount: 0 });
    expect(seen[1]).toMatchObject({ body: { id: 'flaky' }, redelivered: true });
    // No spinning: the second delivery waited for the pause.
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(PAUSE_MS - 20);
  });

  it('gives a failed message back without the pause once it is stopping, so the exit is not delayed', async () => {
    const config = settings();
    const instance = new RabbitQueues(config, logger, { failurePauseMs: 5_000 });
    open.push(instance);
    await instance.prepare();
    await put(config.input, { id: 'last' });
    const stopping: Promise<void>[] = [];

    instance.consume(() => {
      // Like a shutdown while a redelivered PEC's receipt is looked for: stop, and give it back.
      stopping.push(instance.stopConsuming());

      return Promise.reject(new Error('stopping while looking for the receipt'));
    });

    await eventually(
      () => Promise.resolve(stopping.length),
      (n) => n === 1,
    );
    const started = Date.now();
    await stopping[0];
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(
      await eventually(
        () => depth(config.input),
        (n) => n === 1,
      ),
    ).toBe(1);
  });

  it('moves an unreadable message to the dead-letter queue, as it arrived', async () => {
    const config = settings();
    const instance = queues(config);
    await instance.prepare();
    await put(config.input, Buffer.from('this is not JSON'));
    const seen: InputMessage[] = [];

    instance.consume((message) => {
      seen.push(message);

      return Promise.resolve('dead');
    });

    const dead = await eventually(
      () => take(config.dead),
      (message) => message !== undefined,
    );
    expect(seen[0]?.body).toBeUndefined();
    expect(Buffer.isBuffer(dead?.body) ? dead.body.toString() : dead?.body).toBe('this is not JSON');
  });

  it('dead-letters a message whose container keeps dying, after the delivery limit', async () => {
    const config = settings({ deliveryLimit: 2 });
    await queues(config).prepare();
    await put(config.input, { id: 'poison' });

    // Like a container killed while handling it: taken, never acknowledged, connection gone.
    const counts: unknown[] = [];
    for (let crash = 0; crash < 5; crash += 1) {
      const channel = await admin.acquire();
      const message = await new Promise<AsyncMessage | undefined>((resolve) => {
        const timer = setTimeout(() => {
          resolve(undefined);
        }, 2000);
        void channel.basicConsume({ queue: config.input }, (delivered) => {
          clearTimeout(timer);
          resolve(delivered);
        });
      });
      await channel.close();
      if (message === undefined) {
        break;
      }
      counts.push(message.headers?.['x-delivery-count']);
    }

    expect(counts).toEqual([undefined, 1, 2]);
    const dead = await eventually(
      () => take(config.dead),
      (message) => message !== undefined,
    );
    expect(dead?.body).toEqual({ id: 'poison' });
  });

  it('only checks the queues when the infrastructure owns them, and says so when one is missing', async () => {
    const owned = settings({ declare: false });

    await expect(queues(owned).prepare()).rejects.toThrow(/NOT_FOUND|no queue/i);

    await queues({ ...owned, declare: true }).prepare();
    await expect(queues(owned).prepare()).resolves.toBeUndefined();
  });
});
