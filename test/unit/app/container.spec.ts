import { describe, expect, it } from 'vitest';

import { startContainer } from '../../../src/app/container';
import { createLogger } from '../../../src/common/logger';
import type { ResolvedImap, ResolvedMailbox } from '../../../src/config/config';
import { loadConfig } from '../../../src/config/config';
import type { ReceiptSource, ReceiptSourceFactory } from '../../../src/modules/receipts/receipt-source';
import type { InputHandler, OutputEvent, Queues } from '../../../src/queue/queues';

/** The queues as the container drives them, with the order of the calls. */
class RecordingQueues implements Queues {
  public readonly calls: string[] = [];

  public publish(_event: OutputEvent): Promise<void> {
    return Promise.resolve();
  }

  public consume(_handler: InputHandler): void {
    this.calls.push('consume');
  }

  public returnToQueue(_body: unknown): Promise<void> {
    return Promise.resolve();
  }

  public stopConsuming(): Promise<void> {
    this.calls.push('stopConsuming');

    return Promise.resolve();
  }

  public isReady(): boolean {
    return true;
  }

  public close(): Promise<void> {
    this.calls.push('close');

    return Promise.resolve();
  }
}

/** A receipts folder whose pass lasts until the test lets it end, like a long pass during a campaign. */
class HeldReceiptSources implements ReceiptSourceFactory {
  public passStarted = false;
  private release: () => void = () => undefined;
  private readonly held = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  public constructor(private readonly calls: string[]) {}

  public create(_mailbox: ResolvedMailbox, _imap: ResolvedImap): ReceiptSource {
    return {
      read: async (): Promise<void> => {
        this.passStarted = true;
        await this.held;
        this.calls.push('pass ended');
      },
    };
  }

  public endPass(): void {
    this.release();
  }
}

const config = loadConfig({
  PECMAILER_TENANT: 'serfin',
  PECMAILER_MAILBOX: 'serfin-aruba',
  PECMAILER_PROVIDER: 'aruba',
  PECMAILER_FROM_ADDRESS: 'solleciti@pec.serfin.example',
  PECMAILER_FROM_NAME: 'Serfin',
  PECMAILER_SMTP_PASSWORD: 'x',
  RABBITMQ_URL: 'amqp://test:test@localhost:5672',
});

describe('startContainer: stopping', () => {
  it('stops taking PECs at once, without waiting for the receipt reader to finish its pass', async () => {
    const queues = new RecordingQueues();
    const sources = new HeldReceiptSources(queues.calls);
    const container = await startContainer(config, createLogger({ level: 'silent', pretty: false }), {
      queues,
      receiptSources: sources,
      archiverFactory: null,
      proof: null,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sources.passStarted).toBe(true);

    const stopped = container.stop();
    await new Promise((resolve) => setImmediate(resolve));

    // The pass is still running, and no PEC is taken any more.
    expect(queues.calls).toEqual(['consume', 'stopConsuming']);
    sources.endPass();
    await stopped;
    expect(queues.calls).toEqual(['consume', 'stopConsuming', 'pass ended', 'close']);
  });
});
