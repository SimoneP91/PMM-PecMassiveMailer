import type { SmtpFailure } from './smtp-client';

/**
 * What to do after a failed attempt.
 *
 *   suspend  the mailbox's credentials were refused: stop everything for
 *            that mailbox before the provider locks it
 *   retry    nothing left the server side: try again later
 *   fail     the server said no to THIS message: it will never go
 *   stuck    the server took the message and we lost it before its verdict:
 *            it may or may not have left; a person must look
 */
export type OutcomeKind = 'suspend' | 'retry' | 'fail' | 'stuck';

export interface SendOutcome {
  readonly kind: OutcomeKind;
  readonly code: string;
  readonly detail: string;
}

const AUTH_REPLY_CODES = new Set([530, 534, 535]);
const CONNECTION_LEVEL_COMMANDS = new Set(['CONN', 'EHLO', 'HELO', 'STARTTLS']);

export function classifySmtpFailure(failure: SmtpFailure): SendOutcome {
  const detail = failure.response ?? failure.message;
  const command = failure.command ?? '';
  const code = failure.code ?? 'UNKNOWN';

  if (
    code === 'EAUTH' ||
    code === 'ENOAUTH' ||
    (command.startsWith('AUTH') &&
      failure.responseCode !== undefined &&
      AUTH_REPLY_CODES.has(failure.responseCode))
  ) {
    return { kind: 'suspend', code: 'SMTP_AUTH_REFUSED', detail };
  }

  if (failure.dataAccepted && failure.responseCode === undefined) {
    // The server accepted the message data and the connection died before
    // its final reply: the most dangerous case, never retried automatically.
    return {
      kind: 'stuck',
      code: 'SMTP_NO_FINAL_REPLY',
      detail: `connection lost after the message was transmitted (${detail})`,
    };
  }

  if (failure.responseCode !== undefined) {
    if (failure.responseCode >= 400 && failure.responseCode < 500) {
      return { kind: 'retry', code: `SMTP_${String(failure.responseCode)}`, detail };
    }
    if (failure.responseCode >= 500) {
      return CONNECTION_LEVEL_COMMANDS.has(command)
        ? { kind: 'retry', code: `SMTP_${String(failure.responseCode)}`, detail }
        : { kind: 'fail', code: `SMTP_${String(failure.responseCode)}`, detail };
    }
  }

  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return { kind: 'fail', code: `SMTP_${code}`, detail };
  }

  return { kind: 'retry', code: `SMTP_${code}`, detail };
}
