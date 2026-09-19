import type { Server } from 'node:http';

import { startHealthServer } from './app/health-server';
import { createLogger } from './common/logger';
import { ConfigError, loadConfig, type Config } from './config/config';
import { RabbitQueues } from './queue/rabbit-queues';

/**
 * The container: one tenant, one mailbox, three queues.
 *
 * Stage 6, phase 2: the skeleton. It connects to RabbitMQ, declares the
 * queues and answers the probes; taking PECs from the input queue comes
 * with phase 3, reading receipts with phase 4.
 */
const SHUTDOWN_GRACE_MS = 45_000;

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger({
    level: config.log.level,
    pretty: config.log.pretty,
    tenant: config.mailbox.tenant,
    mailbox: config.mailbox.code,
  });
  let stopping = false;

  const queues = new RabbitQueues(config.queues, logger);
  await queues.prepare();
  let health: Server | undefined;
  if (config.health.port !== 0) {
    health = await startHealthServer(config.health.host, config.health.port, {
      live: () => true,
      ready: () => ({ rabbitmq: queues.isReady(), running: !stopping }),
    });
  }
  logger.info(
    { input: config.queues.input, output: config.queues.output },
    'pecmailer started (skeleton: queues declared, not taking PECs yet)',
  );

  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, 'stopping');
    const grace = setTimeout(() => {
      logger.error('shutdown took too long; exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    grace.unref();
    void queues
      .close()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'error while closing the queues');
      })
      .finally(() => {
        health?.close();
        logger.info('stopped');
        process.exit(0);
      });
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `pecmailer failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
