import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiKey } from '../../src/common/security/hash';
import { startTestStack, type TestStack } from '../helpers/test-stack';

/** The HTTP surface that does not involve a batch: health, docs, auth, mailboxes. */
let stack: TestStack;

beforeAll(async () => {
  stack = await startTestStack();
});

afterAll(async () => {
  await stack.stop();
});

describe('health', () => {
  it('GET /health/live answers without authentication', async () => {
    const response = await stack.app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready reports mongodb and storage up', async () => {
    const response = await stack.app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { mongodb: 'up', storage: 'up' } });
  });
});

describe('docs', () => {
  it('serves Swagger UI and the OpenAPI document openly', async () => {
    const ui = await stack.app.inject({ method: 'GET', url: '/docs' });
    expect(ui.statusCode).toBe(200);
    expect(ui.headers['content-type']).toContain('text/html');

    const doc = await stack.app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(doc.statusCode).toBe(200);
    const openapi = doc.json<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { securitySchemes: unknown; schemas: Record<string, unknown> };
    }>();
    expect(openapi.openapi).toMatch(/^3\./);
    expect(Object.keys(openapi.paths)).toEqual(
      expect.arrayContaining(['/health/live', '/health/ready', '/v1/mailboxes', '/v1/batches']),
    );
    expect(openapi.components.securitySchemes).toHaveProperty('apiKey');
    expect(Object.keys(openapi.components.schemas)).toEqual(
      expect.arrayContaining(['BatchRequestDto', 'BatchAcceptedDto', 'DryRunResultDto', 'ProblemDetailsDto']),
    );
  });
});

describe('authentication', () => {
  it('refuses /v1 without a key, as a problem document', async () => {
    const response = await stack.app.inject({ method: 'GET', url: '/v1/mailboxes' });

    expect(response.statusCode).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.json()).toMatchObject({
      status: 401,
      code: 'UNAUTHORIZED',
      type: 'urn:pecmailer:error:unauthorized',
    });
  });

  it('refuses an unknown key with the same answer', async () => {
    const response = await stack.app.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${generateApiKey().key}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('echoes a well-formed X-Request-Id and replaces a hostile one', async () => {
    const good = await stack.app.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(good.json()).toMatchObject({ requestId: 'abc-123' });

    const bad = await stack.app.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { 'x-request-id': '<script>alert(1)</script>' },
    });
    expect(bad.json<{ requestId: string }>().requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('GET /v1/mailboxes', () => {
  it('lists the mailboxes of the calling tenant only', async () => {
    const response = await stack.app.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${stack.serfin.key}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      items: [
        {
          mailbox: 'serfin-aruba',
          from: { address: 'solleciti@pec.serfin.example', name: 'Serfin' },
          provider: 'aruba',
          status: 'ACTIVE',
          archivesSentCopy: true,
          limits: { perMinute: 60, perDay: 0, maxMessageBytes: 31457280 },
        },
      ],
    });
    expect(JSON.stringify(response.json())).not.toMatch(/pw|aruba\.it|username/);
  });

  it('shows the other tenant only its own mailbox', async () => {
    const response = await stack.app.inject({
      method: 'GET',
      url: '/v1/mailboxes',
      headers: { authorization: `Bearer ${stack.iqera.key}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: { mailbox: string }[] }>().items.map((item) => item.mailbox)).toEqual([
      'iqera-legalmail',
    ]);
  });
});

describe('unknown routes', () => {
  it('answer with a 404 problem document', async () => {
    const response = await stack.app.inject({
      method: 'GET',
      url: '/v1/nothing',
      headers: { authorization: `Bearer ${stack.serfin.key}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({ code: 'NOT_FOUND' });
  });
});
