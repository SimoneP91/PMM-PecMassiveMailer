import { describe, expect, it } from 'vitest';

import { SmtpFailure } from '../../../src/modules/sending/smtp/smtp-client';
import { classifySmtpFailure } from '../../../src/modules/sending/smtp/smtp-outcome';

function failure(
  fields: Partial<{
    code: string;
    command: string;
    responseCode: number;
    response: string;
    dataAccepted: boolean;
    finalReplyReceived: boolean;
  }>,
): SmtpFailure {
  return new SmtpFailure(
    'failed',
    fields.code,
    fields.command,
    fields.responseCode,
    fields.response,
    fields.dataAccepted ?? false,
    fields.finalReplyReceived ?? false,
  );
}

describe('classifySmtpFailure', () => {
  it('suspends the mailbox when the login is refused', () => {
    expect(
      classifySmtpFailure(failure({ code: 'EAUTH', command: 'AUTH PLAIN', responseCode: 535 })).kind,
    ).toBe('suspend');
    expect(classifySmtpFailure(failure({ code: 'EAUTH', command: 'API' })).kind).toBe('suspend');
    expect(classifySmtpFailure(failure({ code: 'ENOAUTH' })).kind).toBe('suspend');
  });

  it('marks STUCK when the connection dies after the server took the data', () => {
    const outcome = classifySmtpFailure(failure({ code: 'ETIMEDOUT', command: 'CONN', dataAccepted: true }));

    expect(outcome.kind).toBe('stuck');
    expect(outcome.code).toBe('SMTP_NO_FINAL_REPLY');
    expect(
      classifySmtpFailure(failure({ code: 'ECONNECTION', command: 'CONN', dataAccepted: true })).kind,
    ).toBe('stuck');
  });

  it('retries transient failures and 4xx replies', () => {
    expect(classifySmtpFailure(failure({ code: 'ETIMEDOUT', command: 'CONN' })).kind).toBe('retry');
    expect(classifySmtpFailure(failure({ code: 'ECONNECTION', command: 'CONN' })).kind).toBe('retry');
    expect(classifySmtpFailure(failure({ code: 'EDNS', command: 'CONN' })).kind).toBe('retry');
    expect(
      classifySmtpFailure(failure({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 450 })).kind,
    ).toBe('retry');
    expect(
      classifySmtpFailure(
        failure({ code: 'EMESSAGE', command: 'DATA', responseCode: 452, dataAccepted: true }),
      ).kind,
    ).toBe('retry');
  });

  it('fails the message on 5xx replies to the envelope or the data', () => {
    expect(
      classifySmtpFailure(failure({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550 })),
    ).toMatchObject({ kind: 'fail', code: 'SMTP_550' });
    expect(
      classifySmtpFailure(
        failure({ code: 'EMESSAGE', command: 'DATA', responseCode: 552, dataAccepted: true }),
      ).kind,
    ).toBe('fail');
    expect(classifySmtpFailure(failure({ code: 'EMESSAGE', command: 'MAIL FROM' })).kind).toBe('fail');
  });

  it('retries a 5xx at connection level (the server, not the message)', () => {
    expect(
      classifySmtpFailure(failure({ code: 'ECONNECTION', command: 'CONN', responseCode: 554 })).kind,
    ).toBe('retry');
    expect(classifySmtpFailure(failure({ code: 'EPROTOCOL', command: 'EHLO', responseCode: 502 })).kind).toBe(
      'retry',
    );
  });

  it('retries anything it does not recognise', () => {
    expect(classifySmtpFailure(failure({})).kind).toBe('retry');
  });
});
