# pecmailer

Sends PEC (Italian certified e-mail) for client applications. One container serves one tenant and one of its mailboxes: it takes PECs from an input queue, sends them through the provider, and puts what happened (the outcome, then every receipt) on an output queue. It keeps nothing: whoever fills and empties the queues keeps the records, the attachments and the receipts.

How to use it, in words and with PHP examples: [docs/en/messages.md](docs/en/messages.md) ([Italian](docs/it/messaggi.md)). The formal contract: [docs/asyncapi.yaml](docs/asyncapi.yaml).

## Status

Stage 6, the move from an HTTP API with a database to queues, is in progress. Stages 1 to 5 (HTTP API and MongoDB, version 0.5.1) stay in the git history.

| Phase | Scope                                                                                                 | State |
| ----- | ----------------------------------------------------------------------------------------------------- | ----- |
| 1     | message contract: AsyncAPI document and guides                                                        | done  |
| 2     | cleanup, configuration from the environment, RabbitMQ connection and queues, probes, local stack, CLI | done  |
| 3     | sending: checks, SMTP, Sent copy, pace, retries, outcomes, redelivered PECs                           | done  |
| 4     | receipts: reading the mailbox, receipt events                                                         | done  |
| 5     | documentation and collaudo on real mailboxes                                                          | next  |

## Stack

Node 24 · TypeScript 5.9 (strict, no `any`) · RabbitMQ through rabbitmq-client · nodemailer / imapflow / mailparser · htmlparser2 · Zod · pino · Vitest · Docker. No framework, no database.

## Quick start

```bash
npm install
docker compose up --build
```

- RabbitMQ page: http://localhost:15672 (user `pecmailer`, password `pecmailer`), with three queues per mailbox: `pecmailer.serfin.serfin-aruba.in`, `.out`, `.dead`, and the same for `serfin-legalmail`.
- Greenmail, the fake PEC provider of the local stack only (it does not exist in production): it takes the PECs over SMTP (port 3025) and keeps them in mailboxes you read over IMAP (port 3143, any password). The page on http://localhost:8080 documents its programming interface; the mails of a mailbox are at http://localhost:8080/api/user/destinatario@pec.example/messages/INBOX, or in a mail client pointed at `localhost:3143`.
- Probes: http://localhost:3001/health/ready (serfin-aruba), http://localhost:3002/health/ready (serfin-legalmail)

Play the CRM from this machine, with the settings in [examples/local.env](examples/local.env):

```bash
npm run build
npm run local:publish -- examples/pec.json                       # a PEC with a PDF, in serfin-aruba's input queue
npm run local:publish -- examples/pec.json --mailbox serfin-legalmail
npm run local:outcomes -- --follow                               # what happened, as it arrives (Ctrl+C to stop)
```

The containers send through Greenmail: the PEC lands in the mailbox of `destinatario@pec.example`, its copy in the sender's Sent folder, its outcome in the output queue. Greenmail issues no receipts; to see the receipt events, drop receipts in the sender's inbox (the integration tests do exactly that). `npm run local:outcomes -- --save data/esiti` writes every event, and every receipt's `.eml`, to a folder.

Operations, in a container or with a `.env` (see [.env.example](.env.example)):

```bash
docker compose exec serfin-aruba node dist/main.cli.js config check   # the configuration it runs with, no secrets
docker compose exec serfin-aruba node dist/main.cli.js probe          # SMTP and IMAP login, nothing sent
```

## Development

```bash
npm run check                                         # typecheck + lint + format + unit tests
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration                              # against a real RabbitMQ and Greenmail
```

## Configuration

Environment variables only, all listed with their defaults in [.env.example](.env.example): who the container is (tenant, mailbox, provider, sender), the mailbox credentials, the pace, and `RABBITMQ_URL`. The queues are named `<prefix>.<tenant>.<mailbox>.in`, `.out` and `.dead`. A wrong variable stops the start with a message naming it.

RabbitMQ needs two settings, in [docker/rabbitmq/rabbitmq.conf](docker/rabbitmq/rabbitmq.conf): a maximum message size of 64 MB (a 30 MB PEC becomes about 40 MB inside a message; the default is 16 MB) and the 30-minute consumer timeout the retries are sized on.

## Layout

```
src/
  main.ts        the container: one tenant, one mailbox
  main.cli.ts    admin and development commands
  app/           probes server, version
  config/        environment schema, provider presets
  queue/         the Queues interface and its RabbitMQ implementation
  modules/       recipients (PEC check) · templates (HTML rules) · attachments (type detection)
                 sending (MIME, SMTP, Sent copy) · receipts (parser, daticert, IMAP reader)
  cli/           commands
  common/        logger, secrets, clock
test/            unit/ integration/ helpers/ fixtures/ (real Aruba receipts, anonymised)
docker/          Dockerfile, RabbitMQ settings
docs/            contract, guides, decisions (en/it)
examples/        a PEC and the settings to try the local stack
```

## Deploying

One Deployment per tenant and mailbox, one replica: the input queue lets only one consumer take PECs at a time anyway. Variables from a ConfigMap, and from a Secret for the mailbox password and `RABBITMQ_URL`. Probes `/health/live` and `/health/ready` on port 3001; readiness is false while the mailbox is suspended (a refused password), liveness only when a handling is stuck. `terminationGracePeriodSeconds: 120`: on SIGTERM the container finishes the PEC in hand, and the SMTP timeouts bound that. No volume: the file system can be read-only.

The container declares its queues at start-up. When the infrastructure prefers to create them, it uses the same arguments (see [docs/asyncapi.yaml](docs/asyncapi.yaml)) and sets `PECMAILER_DECLARE_QUEUES=false`.

## Security

See [SECURITY.md](SECURITY.md).
