import { ConfigLoadError, loadConfig, type EnvSource } from '../config/config.loader';
import { EnvValidationError, parseEnv } from '../config/env.schema';

/**
 * Same loading path as the api and the worker, so what passes here boots
 * there. Reports what was resolved without printing a single secret: a
 * password is reported as "present", never as a value.
 */
export async function runConfigCheck(source: EnvSource): Promise<number> {
  try {
    const env = parseEnv(source);
    const config = await loadConfig(env, source);

    console.log(`environment : ${env.NODE_ENV}, config file ${env.CONFIG_FILE}`);
    console.log(`mongodb     : ${redactUri(env.MONGODB_URI)}`);
    console.log(`storage     : ${env.STORAGE_DIR}`);
    console.log('');

    console.log(`tenants (${String(config.tenants.length)})`);
    for (const tenant of config.tenants) {
      console.log(
        `  ${tenant.id.padEnd(24)} ${tenant.name.padEnd(24)} externalId=${tenant.externalId} ` +
          `apiKeys=${String(tenant.apiKeys.length)} webhook=${tenant.webhook === null ? 'no' : 'yes'} ` +
          `maxMessagesPerBatch=${String(tenant.limits.maxMessagesPerBatch)}`,
      );
    }
    console.log('');

    console.log(`mailboxes (${String(config.mailboxes.length)})`);
    for (const mailbox of config.mailboxes) {
      const imap =
        mailbox.imap === null
          ? 'imap=off'
          : `imap=${mailbox.imap.host}:${String(mailbox.imap.port)} sent="${mailbox.imap.sentFolder}"`;
      console.log(
        `  ${mailbox.code.padEnd(24)} tenant=${mailbox.tenantId} provider=${mailbox.provider} ` +
          `from=<${mailbox.from.address}> smtp=${mailbox.smtp.host}:${String(mailbox.smtp.port)}/${mailbox.smtp.security} ` +
          `${imap} password=present ${String(mailbox.limits.perMinute)}/min`,
      );
    }

    console.log('\nconfiguration ok');

    return 0;
  } catch (error: unknown) {
    if (error instanceof EnvValidationError || error instanceof ConfigLoadError) {
      console.error(error.message);

      return 1;
    }
    throw error;
  }
}

function redactUri(uri: string): string {
  return uri.replace(/\/\/([^@/]+)@/, '//[redacted]@');
}
