import { createServer, type Server } from 'node:http';

import type { Connection } from 'mongoose';
import { ConnectionStates } from 'mongoose';

import type { WorkerRunner } from './worker-runner';

const STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Two probes on a port of their own, the same contract as the API:
 * /health/live says the loops are alive, /health/ready that MongoDB is
 * reachable and the worker is not shutting down. Plain node:http on purpose:
 * the worker has no reason to carry an HTTP framework.
 */
export function startWorkerHealthServer(
  port: number,
  host: string,
  runner: WorkerRunner,
  mongo: Connection,
  now: () => Date,
): Promise<Server> {
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    let status = 404;
    let body: unknown = { status: 'not found' };

    if (url === '/health/live') {
      const staleFor = now().getTime() - runner.lastActivity().getTime();
      const alive = staleFor < STALE_AFTER_MS;
      status = alive ? 200 : 503;
      body = { status: alive ? 'ok' : 'stalled', lastActivityMsAgo: staleFor };
    } else if (url === '/health/ready') {
      const mongodb = mongo.readyState === ConnectionStates.connected ? 'up' : 'down';
      const ready = mongodb === 'up' && !runner.isStopping();
      status = ready ? 200 : 503;
      body = { status: ready ? 'ok' : 'degraded', checks: { mongodb, stopping: runner.isStopping() } };
    }

    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
