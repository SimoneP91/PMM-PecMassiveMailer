import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { APP_NAME, APP_VERSION } from './version';

export const DOCS_PATH = 'docs';

const DESCRIPTION = `
Multi-tenant PEC (posta elettronica certificata) sending service.

**Authentication**: every \`/v1\` endpoint requires \`Authorization: Bearer <api key>\`. The key identifies the tenant; nothing in a payload can name a tenant.

**Errors**: every error is an RFC 9457 problem document (\`application/problem+json\`) with a stable \`code\` to branch on and a \`requestId\` to quote.
`.trim();

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle(APP_NAME)
    .setDescription(DESCRIPTION)
    .setVersion(APP_VERSION)
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'Tenant API key (pm_...)' }, 'apiKey')
    .addTag('batches', 'Submit, follow and cancel batches of PEC messages')
    .addTag('messages', 'Find a message, follow it, download what was sent')
    .addTag('receipts', 'The PEC receipts, as the providers delivered them')
    .addTag('mailboxes', 'The mailboxes a tenant may send from')
    .addTag('health', 'Probes for the orchestrator')
    .build();

  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
}

/** Serves Swagger UI on /docs and the raw document on /docs/openapi.json. */
export function setupSwagger(app: INestApplication): void {
  SwaggerModule.setup(DOCS_PATH, app, buildOpenApiDocument(app), {
    jsonDocumentUrl: `${DOCS_PATH}/openapi.json`,
    yamlDocumentUrl: `${DOCS_PATH}/openapi.yaml`,
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });
}
