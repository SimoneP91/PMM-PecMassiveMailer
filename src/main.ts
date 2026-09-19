import type { Server } from 'node:http';

import { startContainer } from './app/container';
import { startHealthServer } from './app/health-server';
import { createLogger } from './common/logger';
import { ConfigError, loadConfig, type Config } from './config/config';

/**
 * The container: one tenant, one mailbox, three queues. Takes PECs from the
 * input queue, sends them, reports each outcome on the output queue.
 *
 * On SIGTERM it stops taking PECs, finishes the one in hand (an SMTP dialogue
 * is never cut on purpose: the provider may already have the message) and
 * exits. The SMTP timeouts bound that wait; give the pod a termination grace
 * period of at least two minutes.
 */
const SHUTDOWN_GRACE_MS = 110_000;

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

  const container = await startContainer(config, logger);
  let health: Server | undefined;
  if (config.health.port !== 0) {
    health = await startHealthServer(config.health.host, config.health.port, {
      live: () => container.isAlive(),
      ready: () => ({
        rabbitmq: container.queues.isReady(),
        mailbox: container.suspension.cause === undefined,
        running: !stopping,
      }),
    });
  }
  logger.info(
    { input: config.queues.input, output: config.queues.output, perMinute: config.mailbox.limits.perMinute },
    'pecmailer started: taking PECs',
  );

  const shutdown = (signal: string): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    logger.info({ signal }, 'stopping: finishing the PEC in hand');
    const grace = setTimeout(() => {
      logger.error('shutdown took too long; exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    grace.unref();
    void container
      .stop()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'error while stopping');
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
