import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Secret } from '../../../src/common/security/secret';
import {
  NodemailerSmtpClientFactory,
  SmtpFailure,
  type SmtpClient,
} from '../../../src/modules/sending/smtp/smtp-client';
import { classifySmtpFailure, type OutcomeKind } from '../../../src/modules/sending/smtp/smtp-outcome';
import { FakeSmtpServer } from '../../helpers/fake-smtp';
import { testMailbox } from '../../helpers/mailbox';

/**
 * The real SMTP client (nodemailer) against a real SMTP server in the test
 * process, answering as told. What matters most is the dialogue itself: a
 * connection lost after the server took the message must come out as
 * "stuck", never as something to retry.
 */
const server = new FakeSmtpServer('solleciti@pec.serfin.example', 'pw');
let client: SmtpClient;

const raw = Buffer.from(
  'From: solleciti@pec.serfin.example\r\nTo: mario@pec.example\r\nSubject: prova\r\n\r\nciao\r\n',
);
const send = (): ReturnType<SmtpClient['send']> =>
  client.send({ from: 'solleciti@pec.serfin.example', to: 'mario@pec.example', raw });

async function failureOf(): Promise<SmtpFailure> {
  const error: unknown = await send().then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(SmtpFailure);

  return error as SmtpFailure;
}

async function outcomeOfFailure(): Promise<OutcomeKind> {
  return classifySmtpFailure(await failureOf()).kind;
}

beforeAll(async () => {
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

beforeEach(() => {
  server.behaviour = { kind: 'accept' };
  const mailbox = testMailbox();
  client = new NodemailerSmtpClientFactory().create({
    ...mailbox,
    smtp: { ...mailbox.smtp, port: server.port, password: new Secret('pw') },
  });
});

afterEach(async () => {
  await client.close();
});

describe('NodemailerSmtpClient against a real SMTP dialogue', () => {
  it('transmits the message byte for byte and returns the final reply', async () => {
    const result = await send();

    expect(result.response).toContain('250 2.0.0 Ok: queued as fake-1');
    expect(server.received.at(-1)?.raw).toBe(raw.toString('utf8'));
  });

  it('reports a connection lost after the server took the message as stuck', async () => {
    server.behaviour = { kind: 'hangAfterData' };

    const failure = await failureOf();

    expect(failure).toMatchObject({ dataAccepted: true, responseCode: undefined });
    expect(classifySmtpFailure(failure).kind).toBe('stuck');
  });

  it('suspends on a refused login', async () => {
    server.behaviour = { kind: 'refuseAuth' };

    expect(await outcomeOfFailure()).toBe('suspend');
  });

  it('fails on a permanent refusal and retries a temporary one, recipient or data alike', async () => {
    server.behaviour = { kind: 'rejectRecipient', code: 550 };
    expect(await outcomeOfFailure()).toBe('fail');

    server.behaviour = { kind: 'rejectRecipient', code: 450 };
    expect(await outcomeOfFailure()).toBe('retry');

    // A reply after DATA is a verdict: the message was not taken, whatever came before.
    server.behaviour = { kind: 'rejectData', code: 552 };
    expect(await outcomeOfFailure()).toBe('fail');

    server.behaviour = { kind: 'rejectData', code: 452 };
    expect(await outcomeOfFailure()).toBe('retry');
  });
});
