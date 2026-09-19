import { ConfigError, describeConfig, loadConfig } from '../config/config';
import { ImapflowSentArchiverFactory } from '../modules/sending/imap/sent-archiver';
import { NodemailerSmtpClientFactory } from '../modules/sending/smtp/smtp-client';

/** Prints the configuration the container would run with, secrets excluded. */
export function runConfigCheck(source: NodeJS.ProcessEnv): number {
  try {
    for (const line of describeConfig(loadConfig(source))) {
      console.log(line);
    }
    console.log('configuration ok');

    return 0;
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      console.error(error.message);

      return 1;
    }
    throw error;
  }
}

/**
 * Logs in to the provider with the configured credentials, sending nothing:
 * SMTP authentication, then IMAP and the Sent folder. What to run after
 * changing a password, before starting the container.
 */
export async function runProbe(source: NodeJS.ProcessEnv): Promise<number> {
  const { mailbox } = loadConfig(source);
  let failed = false;

  const smtp = new NodemailerSmtpClientFactory().create(mailbox);
  try {
    await smtp.verify();
    console.log(
      `smtp ${mailbox.smtp.host}:${String(mailbox.smtp.port)} (${mailbox.smtp.security}): login ok`,
    );
  } catch (error: unknown) {
    failed = true;
    console.error(`smtp ${mailbox.smtp.host}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await smtp.close();
  }

  if (mailbox.imap !== null) {
    const archiver = new ImapflowSentArchiverFactory().create(mailbox, mailbox.imap);
    try {
      const found = await archiver.verify();
      const where = `imap ${mailbox.imap.host}:${String(mailbox.imap.port)}`;
      console.log(
        found
          ? `${where}: login ok, Sent folder "${mailbox.imap.sentFolder}" found`
          : `${where}: login ok, but there is no folder "${mailbox.imap.sentFolder}". The first copy ` +
              'would create it: on a real provider, check PECMAILER_IMAP_SENT_FOLDER first.',
      );
    } catch (error: unknown) {
      failed = true;
      console.error(`imap ${mailbox.imap.host}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await archiver.close();
    }
  }

  return failed ? 1 : 0;
}
