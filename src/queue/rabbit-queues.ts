import {
  Connection,
  ConsumerStatus,
  type AsyncMessage,
  type Consumer,
  type Publisher,
} from 'rabbitmq-client';

import type { Logger } from '../common/logger';
import type { QueueSettings } from '../config/config';
import { parseBody, type InputHandler, type OutputEvent, type Queues } from './queues';

type QueueDeclaration = Parameters<Connection['queueDeclare']>[0] & object & { readonly queue: string };

/**
 * The three queues of a container, as RabbitMQ declares them.
 *
 * All are quorum queues: replicated, and a message survives a broker
 * restart. The input queue adds:
 * - x-single-active-consumer: if two containers of the same mailbox run at
 *   once (a rolling update), only one of them takes PECs;
 * - x-delivery-limit and dead-lettering: a message delivered too many times
 *   without an outcome goes to the dead-letter queue instead of looping.
 */
export function declarations(settings: QueueSettings): {
  readonly input: QueueDeclaration;
  readonly output: QueueDeclaration;
  readonly dead: QueueDeclaration;
} {
  const quorum = { 'x-queue-type': 'quorum' as const };

  return {
    dead: { queue: settings.dead, durable: true, arguments: quorum },
    output: { queue: settings.output, durable: true, arguments: quorum },
    input: {
      queue: settings.input,
      durable: true,
      arguments: {
        ...quorum,
        'x-single-active-consumer': true,
        'x-delivery-limit': settings.deliveryLimit,
        'x-dead-letter-exchange': '',
        'x-dead-letter-routing-key': settings.dead,
      },
    },
  };
}

function deliveryCountOf(message: AsyncMessage): number {
  const count: unknown = message.headers?.['x-delivery-count'];

  return typeof count === 'number' ? count : message.redelivered ? 1 : 0;
}

/**
 * RabbitMQ through rabbitmq-client, which reconnects by itself after a broker
 * restart or a network cut and declares the queues again every time it does.
 *
 * The rules that keep a PEC from being lost or sent twice live here:
 * - one message at a time (prefetch 1), acknowledged only after the handler
 *   resolved, i.e. after its outcome is confirmed in the output queue;
 * - a handler that throws leaves the message queued (it comes back marked
 *   "redelivered", and the handler knows it must not resend blindly), after
 *   a pause: RabbitMQ 4 does not count a message given back on purpose
 *   towards the delivery limit, so without the pause a message that keeps
 *   failing would spin at full speed and hold the mailbox;
 * - the delivery limit catches the other case, a container that dies while
 *   handling a message (a crash, an out-of-memory kill): RabbitMQ counts
 *   those returns, and dead-letters the message after a few;
 * - publishing waits for the broker's confirmation (publisher confirms).
 */
export class RabbitQueues implements Queues {
  private readonly connection: Connection;
  private readonly publisher: Publisher;
  private consumer: Consumer | undefined;

  public constructor(
    private readonly settings: QueueSettings,
    private readonly logger: Logger,
    private readonly options: { readonly failurePauseMs: number } = { failurePauseMs: 10_000 },
  ) {
    this.connection = new Connection({
      url: settings.url.reveal(),
      connectionName: `pecmailer ${settings.tenant}/${settings.mailbox}`,
      // Retry quickly at first, then every half minute, for ever: a container outlives a broker restart.
      retryLow: 1000,
      retryHigh: 30_000,
    });
    this.connection.on('error', (error: unknown) => {
      this.logger.error({ err: error }, 'RabbitMQ connection error');
    });
    this.connection.on('connection', () => {
      this.logger.info('RabbitMQ connection established');
    });
    this.connection.on('connection.blocked', (reason: string) => {
      this.logger.warn({ reason }, 'RabbitMQ blocked publishing (resource alarm)');
    });

    const queues = declarations(settings);
    this.publisher = this.connection.createPublisher({
      confirm: true,
      maxAttempts: 3,
      // Declared before the first publish and after every reconnection.
      queues: settings.declare ? [queues.dead, queues.output] : [],
    });
  }

  /** Declares (or, when the infrastructure owns them, checks) the queues now, so a mistake shows at start-up. */
  public async prepare(): Promise<void> {
    const queues = declarations(this.settings);
    for (const queue of [queues.dead, queues.output, queues.input]) {
      await this.connection.queueDeclare(
        this.settings.declare ? queue : { queue: queue.queue, passive: true },
      );
    }
  }

  public async publish(event: OutputEvent): Promise<void> {
    await this.publisher.send(
      {
        routingKey: this.settings.output,
        durable: true,
        messageId: event.eventId,
        type: event.event,
      },
      event,
    );
  }

  public consume(handler: InputHandler): void {
    const queues = declarations(this.settings);
    this.consumer = this.connection.createConsumer(
      {
        queue: this.settings.input,
        queueOptions: this.settings.declare ? queues.input : { passive: true },
        qos: { prefetchCount: 1 },
        concurrency: 1,
        requeue: true,
      },
      async (message: AsyncMessage) => {
        try {
          const verdict = await handler({
            body: parseBody(message.body),
            redelivered: message.redelivered,
            deliveryCount: deliveryCountOf(message),
          });

          return verdict === 'done' ? ConsumerStatus.ACK : ConsumerStatus.DROP;
        } catch (error: unknown) {
          this.logger.error(
            { err: error, redelivered: message.redelivered, pauseMs: this.options.failurePauseMs },
            'handling failed: the message goes back to the queue after a pause',
          );
          await new Promise((resolve) => setTimeout(resolve, this.options.failurePauseMs));

          return ConsumerStatus.REQUEUE;
        }
      },
    );
    this.consumer.on('error', (error: unknown) => {
      this.logger.error({ err: error }, 'input queue consumer error');
    });
  }

  public async returnToQueue(body: unknown): Promise<void> {
    await this.publisher.send({ routingKey: this.settings.input, durable: true }, body);
  }

  public async stopConsuming(): Promise<void> {
    const consumer = this.consumer;
    this.consumer = undefined;
    await consumer?.close();
  }

  public isReady(): boolean {
    return this.connection.ready;
  }

  public async close(): Promise<void> {
    await this.consumer?.close();
    await this.publisher.close();
    await this.connection.close();
  }
}
