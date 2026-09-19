import type { INestApplicationContext } from '@nestjs/common';

import { asMailboxCode } from '../common/types/branded';
import { MailboxRegistry } from '../modules/mailboxes/mailbox.registry';
import { MailboxStateStore } from '../modules/mailboxes/mailbox-state.store';
import { SENT_ARCHIVER_FACTORY, type SentArchiverFactory } from '../modules/sending/imap/sent-archiver';
import { MailboxLeaseService } from '../modules/sending/mailbox-lease.service';
import { SMTP_CLIENT_FACTORY, type SmtpClientFactory } from '../modules/sending/smtp/smtp-client';

export async function runMailboxList(app: INestApplicationContext): Promise<number> {
  const registry = app.get(MailboxRegistry);
  const states = app.get(MailboxStateStore);
  const leases = app.get(MailboxLeaseService);
  const mailboxes = registry.all();
  const stateOf = await states.getMany(mailboxes.map((mailbox) => mailbox.code));

  for (const mailbox of mailboxes) {
    const state = stateOf.get(mailbox.code);
    const lease = await leases.holder(mailbox.code);
    const held =
      lease === null || lease.expiresAt.getTime() < Date.now() ? 'no worker' : `worker ${lease.owner}`;
    console.log(
      `${mailbox.code.padEnd(24)} tenant=${mailbox.tenantId.padEnd(12)} ${(state?.status ?? 'ACTIVE').padEnd(9)} ${held}` +
        (state?.cause === undefined ? '' : `  ${state.cause}`) +
        (state?.reason === undefined ? '' : `: ${state.reason}`),
    );
  }

  return 0;
}

export async function runMailboxActivate(app: INestApplicationContext, code: string): Promise<number> {
  const registry = app.get(MailboxRegistry);
  if (registry.get(asMailboxCode(code)) === undefined) {
    console.error(`unknown mailbox "${code}"`);

    return 1;
  }
  await app.get(MailboxStateStore).activate(asMailboxCode(code), new Date());
  console.log(`${code}: ACTIVE (the worker resumes within a minute)`);

  return 0;
}

export async function runMailboxSuspend(
  app: INestApplicationContext,
  code: string,
  reason: string | undefined,
): Promise<number> {
  const registry = app.get(MailboxRegistry);
  if (registry.get(asMailboxCode(code)) === undefined) {
    console.error(`unknown mailbox "${code}"`);

    return 1;
  }
  await app
    .get(MailboxStateStore)
    .suspend(asMailboxCode(code), 'OPERATOR', reason ?? 'suspended by an operator', new Date());
  console.log(`${code}: SUSPENDED`);

  return 0;
}

/** Logs in over SMTP and IMAP with the configured credentials; sends nothing. */
export async function runMailboxProbe(app: INestApplicationContext, code: string): Promise<number> {
  const mailbox = app.get(MailboxRegistry).get(asMailboxCode(code));
  if (mailbox === undefined) {
    console.error(`unknown mailbox "${code}"`);

    return 1;
  }
  let failed = false;

  const smtp = app.get<SmtpClientFactory>(SMTP_CLIENT_FACTORY).create(mailbox);
  try {
    await smtp.verify();
    console.log(
      `smtp ${mailbox.smtp.host}:${String(mailbox.smtp.port)} (${mailbox.smtp.security}): login ok`,
    );
  } catch (error: unknown) {
    failed = true;
    console.log(
      `smtp ${mailbox.smtp.host}:${String(mailbox.smtp.port)}: FAILED - ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await smtp.close();
  }

  if (mailbox.imap === null) {
    console.log('imap: disabled for this mailbox');
  } else {
    const archiver = app.get<SentArchiverFactory>(SENT_ARCHIVER_FACTORY).create(mailbox, mailbox.imap);
    try {
      await archiver.verify();
      console.log(
        `imap ${mailbox.imap.host}:${String(mailbox.imap.port)} folder "${mailbox.imap.sentFolder}": ok`,
      );
    } catch (error: unknown) {
      failed = true;
      console.log(
        `imap ${mailbox.imap.host}:${String(mailbox.imap.port)}: FAILED - ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await archiver.close();
    }
  }

  return failed ? 1 : 0;
}
