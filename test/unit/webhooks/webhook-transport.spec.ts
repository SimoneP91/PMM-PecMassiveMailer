import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HttpsWebhookTransport } from '../../../src/modules/webhooks/webhook-transport';

/**
 * The real transport against a local HTTPS server with a certificate made by
 * openssl for this run. Skipped where openssl is not available.
 */
function makeCertificate(): { key: string; cert: string } | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'pecmailer-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=IP:127.0.0.1,DNS:localhost',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );

    return {
      key: readFileSync(join(dir, 'key.pem'), 'utf8'),
      cert: readFileSync(join(dir, 'cert.pem'), 'utf8'),
    };
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const certificate = makeCertificate();
let server: Server;
let port = 0;
const received: { headers: Record<string, unknown>; body: string }[] = [];
let answer = 200;

beforeAll(async () => {
  if (certificate === undefined) {
    return;
  }
  server = createServer({ key: certificate.key, cert: certificate.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(answer, answer === 302 ? { location: 'https://169.254.169.254/' } : {});
      res.end('ignored body');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  if (certificate !== undefined) {
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }
});

describe.skipIf(certificate === undefined)('HttpsWebhookTransport', () => {
  const transport = (): HttpsWebhookTransport => new HttpsWebhookTransport({ ca: certificate?.cert ?? '' });

  it('posts the body and headers when the tenant allows its private network', async () => {
    answer = 204;
    const response = await transport().post({
      url: `https://127.0.0.1:${String(port)}/hook`,
      headers: { 'content-type': 'application/json', 'x-pecmailer-event': 'batch.sent' },
      body: '{"a":1}',
      timeoutMs: 5000,
      allowPrivateNetwork: true,
    });

    expect(response.status).toBe(204);
    expect(received.at(-1)).toMatchObject({
      body: '{"a":1}',
      headers: { 'x-pecmailer-event': 'batch.sent', 'content-length': '7' },
    });
  });

  it('refuses a private address by default, before connecting', async () => {
    const before = received.length;
    for (const host of ['127.0.0.1', 'localhost']) {
      await expect(
        transport().post({
          url: `https://${host}:${String(port)}/hook`,
          headers: {},
          body: '{}',
          timeoutMs: 5000,
          allowPrivateNetwork: false,
        }),
      ).rejects.toThrow(/private or reserved/);
    }
    expect(received.length).toBe(before);
  });

  it('does not follow a redirect: the 3xx is returned as is', async () => {
    answer = 302;
    const response = await transport().post({
      url: `https://127.0.0.1:${String(port)}/hook`,
      headers: {},
      body: '{}',
      timeoutMs: 5000,
      allowPrivateNetwork: true,
    });

    expect(response.status).toBe(302);
  });

  it('refuses plain http and an untrusted certificate', async () => {
    await expect(
      transport().post({
        url: 'http://example.com/hook',
        headers: {},
        body: '{}',
        timeoutMs: 1000,
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(/https/);
    await expect(
      new HttpsWebhookTransport().post({
        url: `https://127.0.0.1:${String(port)}/hook`,
        headers: {},
        body: '{}',
        timeoutMs: 5000,
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(/self[- ]signed|certificate/i);
  });
});
