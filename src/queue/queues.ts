/**
 * What the container needs from a queue system, and nothing more. The rest of
 * the code talks to this interface; RabbitMQ is behind it in rabbit-queues.ts
 * and an in-memory fake stands in for it in tests. Replacing the RabbitMQ
 * library would touch that one file.
 */

/** Every event of the output queue: the fields every consumer can rely on. */
export interface OutputEvent {
  readonly version: 1;
  readonly event: string;
  /** Stable: the same fact always has the same id, so a consumer recognises a copy. */
  readonly eventId: string;
  readonly occurredAt: string;
  readonly tenant: string;
  readonly mailbox: string;
}

/** One message taken from the input queue. */
export interface InputMessage {
  /** The parsed JSON body; undefined when the body is not JSON at all. */
  readonly body: unknown;
  /** The message was delivered before and not acknowledged: its first handling may have sent the PEC. */
  readonly redelivered: boolean;
  /** How many times RabbitMQ delivered it before (quorum queues count them). */
  readonly deliveryCount: number;
}

/**
 * What the handler decided:
 * - `done`: the outcome is published; RabbitMQ forgets the message.
 * - `dead`: unreadable; RabbitMQ moves it to the dead-letter queue as it is.
 * A handler that throws leaves the message in the queue, to be delivered again.
 */
export type HandlerVerdict = 'done' | 'dead';

export type InputHandler = (message: InputMessage) => Promise<HandlerVerdict>;

export interface Queues {
  /** Resolves once the broker has confirmed that the event is stored. */
  publish(event: OutputEvent): Promise<void>;
  /** Starts taking messages from the input queue, one at a time. */
  consume(handler: InputHandler): void;
  /**
   * Puts a message back at the end of the input queue as a new one. Only for
   * a PEC that certainly did not leave (shutdown before sending, mailbox
   * suspended): a message returned the ordinary way comes back marked
   * "redelivered", and would be treated as possibly sent.
   */
  returnToQueue(body: unknown): Promise<void>;
  /** Stops taking messages (a suspended mailbox); the one in hand is finished first. */
  stopConsuming(): Promise<void>;
  /** Connected and able to publish: what the readiness probe reports. */
  isReady(): boolean;
  /** Stops taking messages, waits for the one in hand, closes. */
  close(): Promise<void>;
}

/** The JSON of a message body, whatever the sender declared as content type. */
export function parseBody(body: unknown): unknown {
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    try {
      return JSON.parse(body.toString()) as unknown;
    } catch {
      return undefined;
    }
  }

  return body;
}
