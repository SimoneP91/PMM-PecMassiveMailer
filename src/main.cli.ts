import 'reflect-metadata';

import { parseArgs } from 'node:util';

import { runApiKeyGenerate } from './cli/api-key.command';
import { runConfigCheck } from './cli/config-check.command';
import {
  runMailboxActivate,
  runMailboxList,
  runMailboxProbe,
  runMailboxSuspend,
} from './cli/mailbox.command';
import { runMessageResolve, runMessageStuck } from './cli/message.command';
import { withApp } from './cli/with-app';

const USAGE = `pecmailer admin commands

  api-key generate [--label <text>]     generate an API key: prints it once and the hash for the config file
  config check                          load environment and configuration, report what was resolved (no secrets)

  mailbox list                          every mailbox with its state and which worker holds it
  mailbox probe <code>                  log in over SMTP and IMAP with the configured credentials, send nothing
  mailbox activate <code>               reactivate a suspended mailbox (after fixing its password)
  mailbox suspend <code> [--reason ..]  stop sending through a mailbox

  message stuck                         messages whose outcome is unknown and need a decision
  message resolve <id> --as <outcome>   sent | requeue | failed, after checking the provider's Sent folder
  help

Exit codes: 0 ok, 1 error.`;

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      reason: { type: 'string' },
      as: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [group, action, argument] = positionals;
  if (values.help === true || group === undefined || group === 'help') {
    console.log(USAGE);

    return 0;
  }

  if (group === 'api-key' && action === 'generate') {
    return runApiKeyGenerate(values.label);
  }
  if (group === 'config' && action === 'check') {
    return runConfigCheck(process.env);
  }
  if (group === 'mailbox') {
    if (action === 'list') {
      return withApp(process.env, runMailboxList);
    }
    if (argument !== undefined && action === 'probe') {
      return withApp(process.env, (app) => runMailboxProbe(app, argument));
    }
    if (argument !== undefined && action === 'activate') {
      return withApp(process.env, (app) => runMailboxActivate(app, argument));
    }
    if (argument !== undefined && action === 'suspend') {
      return withApp(process.env, (app) => runMailboxSuspend(app, argument, values.reason));
    }
  }
  if (group === 'message') {
    if (action === 'stuck') {
      return withApp(process.env, runMessageStuck);
    }
    if (argument !== undefined && action === 'resolve') {
      return withApp(process.env, (app) => runMessageResolve(app, argument, values.as));
    }
  }

  console.error(`unknown command: ${positionals.join(' ')}\n`);
  console.log(USAGE);

  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
