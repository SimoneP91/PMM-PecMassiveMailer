/**
 * The provider refused the IMAP login. Whoever meets it (the receipt reader,
 * the Sent copy, the receipt search of a redelivered PEC) suspends the
 * mailbox instead of trying again: repeated refused logins can get the
 * account locked.
 */
export class ImapAuthError extends Error {
  public constructor(message = 'IMAP login refused') {
    super(message);
    this.name = 'ImapAuthError';
  }
}

/** imapflow marks a refused login with `authenticationFailed`. */
export function isImapAuthFailure(error: unknown): boolean {
  return (error as { authenticationFailed?: unknown } | null | undefined)?.authenticationFailed === true;
}
