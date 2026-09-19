import { createLogger } from '../../src/common/logger';
import type { Clock } from '../../src/common/time/clock';
import type { ResolvedMailbox } from '../../src/config/config';
import type { RecipientVerification } from '../../src/modules/recipients/recipient-verifier';
import type { ProofLookup, SentProof } from '../../src/modules/receipts/sent-proof';
import { ImapAuthError } from '../../src/modules/sending/imap/imap-auth-error';
import { MailboxSuspension } from '../../src/modules/sending/mailbox-suspension';
import { EmlBuilder } from '../../src/modules/sending/mime/eml-builder';
import { OutcomeEvents } from '../../src/modules/sending/outcome-events';
import { Pace } from '../../src/modules/sending/pace';
import { PecSender, type PecSenderDeps } from '../../src/modules/sending/pec-sender';
import { SendRequestChecker } from '../../src/modules/sending/send-request';
import type { Sleeper } from '../../src/modules/sending/sleeper';
import {
  SmtpFailure,
  type SmtpClient,
  type SmtpClientFactory,
  type SmtpSendInput,
  type SmtpSendResult,
} from '../../src/modules/sending/smtp/smtp-client';
import type { OutputEvent, Queues } from '../../src/queue/queues';
import { FakeSentArchiverFactory } from './fake-archiver';
import { testMailbox } from './mailbox';

/** Time that moves only when told, or when something sleeps. */
export class ManualClock implements Clock {
  public at = Date.parse('2026-09-19T10:00:00Z');

  public now(): Date {
    return new Date(this.at);
  }
}

/** Sleeps without waiting: moves the clock and remembers how long it was asked to wait. */
export class InstantSleeper implements Sleeper {
  public readonly waits: number[] = [];
  /** Called on every sleep, e.g. to abort in the middle of one. */
  public onSleep: (ms: number) => void = () => undefined;

  public constructor(private readonly clock: ManualClock) {}

  public sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) {
      return Promise.resolve();
    }
    this.waits.push(ms);
    this.onSleep(ms);
    this.clock.at += ms;

    return Promise.resolve();
  }
}

/** The queue side of the sender: what it published, what it gave back. */
export class FakeQueues implements Pick<Queues, 'publish' | 'returnToQueue' | 'stopConsuming'> {
  public readonly published: OutputEvent[] = [];
  public readonly returned: unknown[] = [];
  public stopped = 0;
  /** Publishing fails while this is true, as with RabbitMQ unreachable. */
  public failPublish = false;

  public publish(event: OutputEvent): Promise<void> {
    if (this.failPublish) {
      return Promise.reject(new Error('RabbitMQ did not confirm'));
    }
    this.published.push(event);

    return Promise.resolve();
  }

  public returnToQueue(body: unknown): Promise<void> {
    this.returned.push(body);

    return Promise.resolve();
  }

  public stopConsuming(): Promise<void> {
    this.stopped += 1;

    return Promise.resolve();
  }

  public events<T extends OutputEvent = OutputEvent & Record<string, unknown>>(event?: string): T[] {
    return this.published.filter((published) => event === undefined || published.event === event) as T[];
  }
}

type SmtpStep = 'ok' | SmtpFailure;

/** An SMTP client that answers from a script: one step per attempt, then "ok". */
export class ScriptedSmtpFactory implements SmtpClientFactory {
  public readonly sent: SmtpSendInput[] = [];
  public readonly script: SmtpStep[] = [];
  public closed = 0;

  public create(_mailbox: ResolvedMailbox): SmtpClient {
    return {
      send: (input: SmtpSendInput): Promise<SmtpSendResult> => {
        const step = this.script.shift() ?? 'ok';
        if (step !== 'ok') {
          return Promise.reject(step);
        }
        this.sent.push(input);

        return Promise.resolve({ response: '250 2.0.0 Ok: queued as FAKE1', accepted: [input.to] });
      },
      verify: () => Promise.resolve(),
      close: () => {
        this.closed += 1;

        return Promise.resolve();
      },
    };
  }
}

/** The SMTP failures of the tests, shaped as nodemailer reports them. */
export const smtpFailure = {
  temporary: (code = 451): SmtpFailure =>
    new SmtpFailure(
      `${String(code)} try later`,
      'EENVELOPE',
      'RCPT TO',
      code,
      `${String(code)} 4.3.0 try later`,
      false,
      true,
    ),
  refused: (code = 550): SmtpFailure =>
    new SmtpFailure(
      `${String(code)} no such user`,
      'EENVELOPE',
      'RCPT TO',
      code,
      `${String(code)} 5.1.1 no such user`,
      false,
      true,
    ),
  authRefused: (): SmtpFailure =>
    new SmtpFailure(
      'Invalid login',
      'EAUTH',
      'AUTH PLAIN',
      535,
      '535 5.7.8 authentication failed',
      false,
      true,
    ),
  lostAfterData: (): SmtpFailure =>
    new SmtpFailure('Connection closed', 'ECONNECTION', 'CONN', undefined, undefined, true, false),
};

/** Receipts "in the mailbox", by Message-ID. */
export class FakeProofLookup implements ProofLookup {
  public readonly proofs = new Map<string, SentProof>();
  public readonly searched: string[] = [];
  public refuseLogin = false;

  public find(messageId: string): Promise<SentProof | undefined> {
    this.searched.push(messageId);
    if (this.refuseLogin) {
      return Promise.reject(new ImapAuthError());
    }

    return Promise.resolve(this.proofs.get(messageId));
  }
}

/** Every domain ending in "pec.example" is PEC, "gmail.com" is not, the rest cannot be told. */
export const recipientsStub = {
  verify(address: string): Promise<RecipientVerification> {
    const domain = address.slice(address.lastIndexOf('@') + 1);
    if (domain.endsWith('pec.example')) {
      return Promise.resolve({ verdict: 'PEC', detail: `${domain} is PEC` });
    }
    if (domain === 'gmail.com') {
      return Promise.resolve({
        verdict: 'NOT_PEC',
        detail: `${domain} is an ordinary mail service, not PEC`,
      });
    }

    return Promise.resolve({ verdict: 'UNDETERMINED', detail: `${domain} could not be classified` });
  },
};

export interface SenderFixture {
  readonly sender: PecSender;
  readonly suspension: MailboxSuspension;
  readonly queues: FakeQueues;
  readonly smtp: ScriptedSmtpFactory;
  readonly archiver: FakeSentArchiverFactory;
  readonly proof: FakeProofLookup;
  readonly clock: ManualClock;
  readonly sleeper: InstantSleeper;
  readonly stop: AbortController;
}

export function senderFixture(overrides: Partial<PecSenderDeps> = {}): SenderFixture {
  const clock = new ManualClock();
  const sleeper = new InstantSleeper(clock);
  const queues = new FakeQueues();
  const smtp = new ScriptedSmtpFactory();
  const archiver = new FakeSentArchiverFactory();
  const proof = new FakeProofLookup();
  const stop = new AbortController();
  const mailbox = testMailbox({
    imap: {
      host: 'imap.example',
      port: 993,
      security: 'tls',
      username: 'u',
      password: testMailbox().smtp.password,
      sentFolder: 'Sent',
      receiptsFolder: 'INBOX',
    },
  });
  const logger = createLogger({ level: 'silent', pretty: false });
  const events = new OutcomeEvents('serfin', 'serfin-aruba', clock);
  const suspension = new MailboxSuspension(queues, events, logger);
  const sender = new PecSender({
    mailbox,
    queues,
    suspension,
    checker: new SendRequestChecker(recipientsStub, 'reject'),
    eml: new EmlBuilder(clock),
    smtpFactory: smtp,
    archiverFactory: archiver,
    proof,
    pace: new Pace(0, clock, sleeper),
    events,
    clock,
    sleeper,
    logger,
    retryBackoffSeconds: [60, 300],
    redeliveryWaitSeconds: 120,
    signal: stop.signal,
    ...overrides,
  });

  return { sender, suspension, queues, smtp, archiver, proof, clock, sleeper, stop };
}

export const PDF = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\n');
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

/** A valid send request, as the CRM would publish it. */
export function sendRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'pec-0001',
    reference: 'pratica-4521',
    batch: 'solleciti-09',
    to: { address: 'destinatario@pec.example', name: 'Mario Rossi' },
    subject: 'Sollecito pratica 4521',
    html: '<p>Gentile Mario Rossi,</p><img src="cid:logo">',
    attachments: [{ filename: 'sollecito.pdf', content: PDF.toString('base64') }],
    inlineImages: [{ cid: 'logo', content: PNG.toString('base64') }],
    ...overrides,
  };
}
