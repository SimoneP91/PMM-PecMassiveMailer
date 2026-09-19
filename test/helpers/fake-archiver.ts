import type { ResolvedImap, ResolvedMailbox } from '../../src/config/config.loader';
import type { SentArchiver, SentArchiverFactory } from '../../src/modules/sending/imap/sent-archiver';

/** Records what the worker would file in the Sent folder; can be told to fail. */
export class FakeSentArchiverFactory implements SentArchiverFactory {
  public readonly appended: { mailbox: string; eml: string; sentAt: Date }[] = [];
  /** The copy of a message whose EML contains this text fails once (scoped, so another message cannot use it up). */
  public failFor: string | undefined;
  public created = 0;

  public create(mailbox: ResolvedMailbox, _imap: ResolvedImap): SentArchiver {
    this.created += 1;

    return {
      append: (eml: Buffer, sentAt: Date): Promise<void> => {
        if (this.failFor !== undefined && eml.includes(this.failFor)) {
          this.failFor = undefined;

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
