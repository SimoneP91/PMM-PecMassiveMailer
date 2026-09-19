# pecmailer

Multi-tenant microservice that sends PEC (Italian certified e-mail) on behalf of client applications, collects the legal receipts and keeps everything it sent.

> Documentazione in italiano: [README.it.md](README.it.md)

A client submits a **batch**: one template, one mailbox, N recipients with their own placeholder values and attachments, in a single HTTP call. The service validates everything up front, sends at the pace the provider allows, files a copy in the mailbox's Sent folder, reads the acceptance and delivery receipts back, and notifies the client when the batch is sent and when it is settled.

## Status

All five stages are done: batches are accepted, **sent**, **followed** and **settled**. A client submits a template, a mailbox and up to 2,500 recipients with their files in one multipart call; every row is validated, rendered and queued; the worker sends each message once, at the mailbox's pace, archives the exact bytes, files a copy in the Sent folder and never guesses when the outcome is unknown (STUCK, for an operator). It then reads the PEC receipts from the mailbox (read-only), moves each message to ACCEPTED, DELIVERED or NOT_DELIVERED, keeps every receipt as legal proof, and settles the batch when every outcome is known or after 30 hours. The client lists and searches its batches and messages, downloads the exact EML and every receipt with their digests, cancels what has not left, and receives signed webhooks when a batch is sent, when it is settled and when a mailbox is suspended.

| Stage | Scope                                                                                           | State |
| ----- | ----------------------------------------------------------------------------------------------- | ----- |
| 1     | tooling, Docker, configuration, health, Swagger, `GET /v1/mailboxes`                            | done  |
| 2     | `POST /v1/batches`: multipart intake, template rules, PEC recipient check, attachments, dry run | done  |
| 3     | sending worker: mailbox lease, pacing, SMTP, IMAP copy, EML archive, state machine              | done  |
| 4     | read endpoints: batches, messages, search, cancel                                               | done  |
| 5     | receipts, webhooks, settlement                                                                  | done  |

## Stack

Node 24 · TypeScript 5.9 (strict, no `any`) · NestJS 11 on Fastify · MongoDB 8 + Mongoose · Zod (validation and OpenAPI from the same schemas) · nodemailer / imapflow · pino · Vitest · Docker.

## Quick start

```bash
cp .env.example .env                              # then set every change-me: WEBHOOK_*_SECRET wants openssl rand -hex 32
cp config/pecmailer.example.yaml config/pecmailer.yaml
npm install
npm run build
npm run cli -- api-key generate --label "local"   # paste the hash into config/pecmailer.yaml
npm run cli -- config check                       # nothing starts until this passes
docker compose up --build
```

Then:

- Swagger UI: http://localhost:3000/docs
- health: http://localhost:3000/health/ready
- `curl -H "Authorization: Bearer pm_..." http://localhost:3000/v1/mailboxes`
- submit a batch (one call: JSON part + file parts):

  ```bash
  curl -X POST http://localhost:3000/v1/batches \
    -H "Authorization: Bearer pm_..." \
    -H "Idempotency-Key: $(uuidgen)" \
    -F 'batch={"mailbox":"serfin-aruba","template":{"subject":"Pratica {{n}}","html":"<p>Gentile {{name}}</p>"},"messages":[{"ref":"1","to":"x@pec.it","vars":{"n":"1","name":"Rossi"},"attachments":[{"part":"doc"}]}]};type=application/json' \
    -F 'doc=@sollecito.pdf'
  ```

  Add `"options":{"dryRun":true}` to validate and preview without creating anything.

- follow it:

  ```bash
  curl -H "Authorization: Bearer pm_..." http://localhost:3000/v1/batches/b_...                 # state and counters
  curl -H "Authorization: Bearer pm_..." "http://localhost:3000/v1/messages?ref=1"              # find a row by your ref
  curl -H "Authorization: Bearer pm_..." -OJ http://localhost:3000/v1/messages/m_.../eml         # what was sent
  curl -X POST -H "Authorization: Bearer pm_..." http://localhost:3000/v1/batches/b_.../cancel   # stop what has not left
  curl -H "Authorization: Bearer pm_..." http://localhost:3000/v1/messages/m_.../receipts       # acceptance, delivery...
  curl -H "Authorization: Bearer pm_..." -OJ http://localhost:3000/v1/receipts/r_.../eml         # a receipt, the legal proof
  ```

- Greenmail (fake PEC provider) web UI: http://localhost:8080
- worker probes: http://localhost:3001/health/live

Operations (the same image, `node dist/main.cli.js`, or `npm run cli --` locally):

```bash
npm run cli -- db sync-indexes --dry-run    # indexes to create/drop; without --dry-run applies them
npm run cli -- mailbox list                 # state of every mailbox and which worker holds it
npm run cli -- mailbox probe serfin-aruba   # SMTP + IMAP login with the configured credentials
npm run cli -- mailbox activate serfin-aruba
npm run cli -- message stuck                # messages whose outcome is unknown
npm run cli -- message resolve m_... --as sent|requeue|failed
npm run cli -- webhook list                 # events not delivered yet, with the last error
npm run cli -- webhook retry ev_...         # a FAILED event gets a new 24 h retry window
```

## Development

```bash
npm run dev:api          # API with reload
npm run dev:worker       # worker with reload
npm run check            # typecheck + lint + format + unit tests: what CI runs
npm run test:e2e         # HTTP surface against an in-memory MongoDB (binary downloaded once, ~800 MB)
npm run test:integration # real IMAP against Greenmail: docker compose -f docker-compose.test.yml up -d first
npm run openapi:export   # writes openapi.json for client integrators
```

## Configuration

Two sources, both read once at boot; the process refuses to start when either is invalid:

- **environment** ([.env.example](.env.example)): ports, database, paths, and every secret — mailbox passwords as `MAILBOX_<CODE>_PASSWORD`, webhook signing secrets by name.
- **config file** ([config/pecmailer.example.yaml](config/pecmailer.example.yaml)): tenants, their API key hashes, their mailboxes and limits. It contains no secret and is a ConfigMap in Kubernetes.

## Layout

```
src/
  main.api.ts | main.worker.ts | main.cli.ts   entry points, one image
  app/          modules per entry point, Swagger
  config/       environment and config file schemas, loader
  common/       errors (RFC 9457), logging, security, ids, time
  database/     MongoDB connection
  modules/      auth · tenants · mailboxes · batches · messages · templates · recipients · attachments · sending · health
  cli/          admin commands
test/
  unit/ integration/ e2e/ security/
docker/         Dockerfile, mongo init
config/         example configuration
docs/           architecture, API, decisions (en/it)
```

## Deploying a release

1. Build and push the image.
2. Run `node dist/main.cli.js db sync-indexes` once with the new image (a Kubernetes Job): indexes are never built by the API or the worker in production, and some of them carry guarantees (a `dedupKey` used once per tenant).
3. Roll out the API and the worker.

## Security

See [SECURITY.md](SECURITY.md). Short version: API keys are stored hashed, mailbox passwords never leave the environment, every error is a problem document that never carries an internal message, and tenants cannot name each other in any request.
