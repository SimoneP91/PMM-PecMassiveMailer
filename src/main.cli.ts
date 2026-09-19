import { runConfigCheck, runProbe } from './cli/mailbox-tools';
import { runOutcomes, runPublish } from './cli/queue-tools';
import { ConfigError, loadQueueSettings, type QueueSettings } from './config/config';

const USAGE = `pecmailer admin and development commands (settings from the environment, as for the container)

  config check                         the configuration the container would run with, no secrets
  probe                                SMTP and IMAP login with the configured credentials, nothing sent

  publish <file.json | ->              put a PEC in the input queue (id and version added when missing;
                                       attachments may give "path" instead of "content")
  outcomes [--follow] [--save <dir>]   print the output queue's events and take them away;
                                       --save writes each event, and each receipt's .eml, to <dir>

  publish and outcomes accept --mailbox <code> to use another mailbox of the same tenant.
  Against the local stack: npm run local:publish -- examples/pec.json, npm run local:outcomes -- --follow
`;

/** The value after a flag, when the flag is there. */
function option(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);

  return at >= 0 ? args[at + 1] : undefined;
}

function queueSettings(args: readonly string[]): QueueSettings {
  const mailbox = option(args, '--mailbox');

  return loadQueueSettings(
    mailbox === undefined ? process.env : { ...process.env, PECMAILER_MAILBOX: mailbox },
  );
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'config':
      if (rest[0] === 'check') {
        return runConfigCheck(process.env);
      }
      break;
    case 'probe':
      return runProbe(process.env);
    case 'publish': {
      const file = rest.find((arg, i) => !arg.startsWith('--') && rest[i - 1] !== '--mailbox');
      if (file !== undefined) {
        return runPublish(queueSettings(rest), file);
      }
      break;
    }
    case 'outcomes': {
      const saveTo = option(rest, '--save');

      return runOutcomes(queueSettings(rest), {
        follow: rest.includes('--follow'),
        ...(saveTo === undefined ? {} : { saveTo }),
      });
    }
    case undefined:
    default:
      break;
  }
  console.error(USAGE);

  return 2;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(
      error instanceof ConfigError ? error.message : error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
