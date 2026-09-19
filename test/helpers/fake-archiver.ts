import type { ResolvedImap, ResolvedMailbox } from '../../src/config/config.loader';
import type { SentArchiver, SentArchiverFactory } from '../../src/modules/sending/imap/sent-archiver';

/** Records what the worker would file in the Sent folder; can be told to fail. */
export class FakeSentArchiverFactory implements SentArchiverFactory {
  public readonly appended: { mailbox: string; eml: string; sentAt: Date }[] = [];
  public failNext = false;
  public created = 0;

  public create(mailbox: ResolvedMailbox, _imap: ResolvedImap): SentArchiver {
    this.created += 1;

    return {
      append: (eml: Buffer, sentAt: Date): Promise<void> => {
        if (this.failNext) {
          this.failNext = false;

          return Promise.reject(new Error('IMAP APPEND failed (fake)'));
        }
        this.appended.push({ mailbox: mailbox.code, eml: eml.toString('utf8'), sentAt });

        return Promise.resolve();
      },
      verify: (): Promise<void> => Promise.resolve(),
      close: (): Promise<void> => Promise.resolve(),
    };
  }
}
