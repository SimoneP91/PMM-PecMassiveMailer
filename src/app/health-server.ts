import { createServer, type Server } from 'node:http';

export interface HealthChecks {
  /** Liveness: false means the process is wedged and must be restarted. */
  live(): boolean;
  /** Readiness: false means it cannot work right now (broker unreachable, shutting down). */
  ready(): Record<string, boolean>;
}

/**
 * The two Kubernetes probes, on a port of their own. Plain node:http: a
 * container that only reads queues has no reason to carry a web framework.
 *
 *   GET /health/live   200 ok | 503 stalled
 *   GET /health/ready  200 ok | 503 with the failing checks
 */
export function startHealthServer(host: string, port: number, checks: HealthChecks): Promise<Server> {
  const server = createServer((request, response) => {
    let status = 404;
    let body: unknown = { status: 'not found' };

    if (request.url === '/health/live') {
      const alive = checks.live();
      status = alive ? 200 : 503;
      body = { status: alive ? 'ok' : 'stalled' };
    } else if (request.url === '/health/ready') {
      const results = checks.ready();
      const ready = Object.values(results).every(Boolean);
      status = ready ? 200 : 503;
      body = { status: ready ? 'ok' : 'not ready', checks: results };
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
