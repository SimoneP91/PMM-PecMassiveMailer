import 'reflect-metadata';

import { parseArgs } from 'node:util';

import { runApiKeyGenerate } from './cli/api-key.command';
import { runConfigCheck } from './cli/config-check.command';

const USAGE = `pecmailer admin commands

  api-key generate [--label <text>]   generate an API key: prints it once and the hash for the config file
  config check                        load environment and configuration, report what was resolved (no secrets)
  help

Exit codes: 0 ok, 1 error.`;

async function main(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      label: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const [group, action] = positionals;
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
