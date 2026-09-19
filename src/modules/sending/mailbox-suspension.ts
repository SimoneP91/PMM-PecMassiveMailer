import type { Logger } from '../../common/logger';
import type { Queues } from '../../queue/queues';
import type { OutcomeEvents, SuspensionCause } from './outcome-events';

/**
 * The mailbox stops when the provider refuses its password, whether the
 * sender (SMTP) or the receipt reader (IMAP) finds out first. From then on
 * nothing is sent and nothing is read: more refused logins could get the
 * account locked. It resumes only with a restart, which is what changing the
 * password in the container's environment means anyway.
 *
 * Shared by the sender and the reader, so the mailbox.suspended event is
 * published once, whoever notices.
 */
export class MailboxSuspension {
  private causeOf: SuspensionCause | undefined;

  public constructor(
    private readonly queues: Pick<Queues, 'publish' | 'stopConsuming'>,
    private readonly events: OutcomeEvents,
    private readonly logger: Logger,
  ) {}

  /** Why the mailbox stopped; undefined while it works. What the readiness probe reports. */
  public get cause(): SuspensionCause | undefined {
    return this.causeOf;
  }

  public async suspend(cause: SuspensionCause, detail: string): Promise<void> {
    if (this.causeOf !== undefined) {
      return;
    }
    this.causeOf = cause;
    this.logger.error(
      { cause, detail },
      'the provider refused the login: mailbox suspended until the container restarts',
    );
    // Not awaited: stopping the consumer waits for a handler in progress, which may be the caller.
    void this.queues.stopConsuming().catch((error: unknown) => {
      this.logger.error({ err: error }, 'could not stop taking PECs');
    });
    try {
      await this.queues.publish(this.events.mailboxSuspended(cause, detail));
    } catch (error: unknown) {
      this.logger.error({ err: error }, 'the mailbox.suspended event could not be published');
    }
  }
}
