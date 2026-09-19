import type { Logger } from '../common/logger';
import { SystemClock, type Clock } from '../common/time/clock';
import type { Config } from '../config/config';
import { ReceiptReader } from '../modules/receipts/receipt-reader';
import { ImapflowReceiptSourceFactory, type ReceiptSourceFactory } from '../modules/receipts/receipt-source';
import { ImapProofLookup, type ProofLookup } from '../modules/receipts/sent-proof';
import {
  RecipientVerifier,
  SystemMxResolver,
  type MxResolver,
} from '../modules/recipients/recipient-verifier';
import { ImapflowSentArchiverFactory, type SentArchiverFactory } from '../modules/sending/imap/sent-archiver';
import { MailboxSuspension } from '../modules/sending/mailbox-suspension';
import { EmlBuilder } from '../modules/sending/mime/eml-builder';
import { OutcomeEvents } from '../modules/sending/outcome-events';
import { Pace } from '../modules/sending/pace';
import { PecSender } from '../modules/sending/pec-sender';
import { SendRequestChecker } from '../modules/sending/send-request';
import { SystemSleeper, type Sleeper } from '../modules/sending/sleeper';
import { NodemailerSmtpClientFactory, type SmtpClientFactory } from '../modules/sending/smtp/smtp-client';
import type { Queues } from '../queue/queues';
import { RabbitQueues } from '../queue/rabbit-queues';

/** What tests may replace; everything else is built from the configuration. */
export interface ContainerParts {
  readonly queues: Queues & { prepare?(): Promise<void> };
  readonly smtpFactory: SmtpClientFactory;
  readonly archiverFactory: SentArchiverFactory | null;
  readonly proof: ProofLookup | null;
  readonly receiptSources: ReceiptSourceFactory;
  readonly mx: MxResolver;
  readonly clock: Clock;
  readonly sleeper: Sleeper;
}

export interface Container {
  readonly sender: PecSender;
  /** null when IMAP is off. */
  readonly reader: ReceiptReader | null;
  readonly queues: Queues;
  readonly suspension: MailboxSuspension;
  /** Every loop is working: what the liveness probe reports. */
  isAlive(): boolean;
  /** Stops taking PECs and reading receipts, finishes the PEC in hand, closes the connections. */
  stop(): Promise<void>;
}

/**
 * The whole container, wired by hand: a dozen objects need no framework.
 * main.ts starts it; the integration tests start it too, with fakes where
 * they need them.
 */
export async function startContainer(
  config: Config,
  logger: Logger,
  overrides: Partial<ContainerParts> = {},
): Promise<Container> {
  const { mailbox } = config;
  const clock = overrides.clock ?? new SystemClock();
  const sleeper = overrides.sleeper ?? new SystemSleeper();
  const queues = overrides.queues ?? new RabbitQueues(config.queues, logger);
  await queues.prepare?.();

  const stopping = new AbortController();
  const events = new OutcomeEvents(mailbox.tenant, mailbox.code, clock);
  const suspension = new MailboxSuspension(queues, events, logger);
  const imap = mailbox.imap;

  const sender = new PecSender({
    mailbox,
    queues,
    suspension,
    checker: new SendRequestChecker(
      new RecipientVerifier(config.recipients, clock, overrides.mx ?? new SystemMxResolver()),
      config.sending.unverifiedRecipients,
    ),
    eml: new EmlBuilder(clock),
    smtpFactory: overrides.smtpFactory ?? new NodemailerSmtpClientFactory(),
    archiverFactory:
      overrides.archiverFactory !== undefined
        ? overrides.archiverFactory
        : imap === null
          ? null
          : new ImapflowSentArchiverFactory(),
    proof: overrides.proof !== undefined ? overrides.proof : imap === null ? null : new ImapProofLookup(imap),
    pace: new Pace(mailbox.limits.perMinute, clock, sleeper),
    events,
    clock,
    sleeper,
    logger,
    retryBackoffSeconds: config.sending.retryBackoffSeconds,
    redeliveryWaitSeconds: config.sending.redeliveryWaitSeconds,
    signal: stopping.signal,
  });
  queues.consume((message) => sender.handle(message));

  const reader =
    imap === null
      ? null
      : new ReceiptReader({
          mailbox,
          imap,
          sources: overrides.receiptSources ?? new ImapflowReceiptSourceFactory(),
          queues,
          events,
          suspension,
          clock,
          sleeper,
          logger,
          settings: config.receipts,
          signal: stopping.signal,
        });
  const reading = reader?.run() ?? Promise.resolve();

  return {
    sender,
    reader,
    queues,
    suspension,
    isAlive: () => sender.isAlive() && (reader?.isAlive() ?? true),
    stop: async () => {
      stopping.abort();
      await reading;
      await queues.close();
      await sender.close();
    },
  };
}
