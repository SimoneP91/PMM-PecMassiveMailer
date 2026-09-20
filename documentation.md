# pecmailer — Technical Documentation

> **Reading guide.** The first part describes what runs today, version 0.6.1: a queue-driven container, no database, no framework. "Stage 6" tells how it was built and reviewed, "What's Next" what is left before production. The last part, "History: versions 0.1 to 0.5.1", keeps the record of the first design (an HTTP API with MongoDB, NestJS and webhooks), from which the domain code (PEC checks, SMTP, receipts) comes.

## Overview

pecmailer sends PEC (Italian certified e-mail) for client applications. One container serves one tenant and one of its mailboxes, and keeps nothing: whoever fills and empties its queues keeps the records, the attachments and the receipts.

```
CRM ──► pecmailer.<tenant>.<mailbox>.in ──► container ──SMTP──► PEC provider
                                              │   ▲
                                              │   └─ IMAP: copy in the Sent folder; receipts, read-only
CRM ◄── pecmailer.<tenant>.<mailbox>.out ◄────┘      (outcomes, then every receipt)
        pecmailer.<tenant>.<mailbox>.dead            (unreadable input, or a message that keeps killing the container)
```

- **Sending** ([src/modules/sending/pec-sender.ts](src/modules/sending/pec-sender.ts)): one PEC at a time; checks (format, HTML rules, attachment types, PEC recipient, size), pace per minute, SMTP, copy in the Sent folder, outcome event (`sent`, `rejected`, `failed`, `uncertain`).
- **Receipts** ([src/modules/receipts/receipt-reader.ts](src/modules/receipts/receipt-reader.ts)): the receipts folder read every minute; every receipt of our PECs published whole (`receipt`).
- **Wiring** ([src/app/container.ts](src/app/container.ts)): a dozen objects built by hand; [src/main.ts](src/main.ts) adds the probes and the shutdown.
- **First run on a new machine**: [docs/en/getting-started.md](docs/en/getting-started.md) ([Italian](docs/it/avvio.md)); [CLAUDE.md](CLAUDE.md) orients an AI assistant working in the repository.
- **Contract**: [docs/asyncapi.yaml](docs/asyncapi.yaml); guides for the CRM with PHP examples: [docs/it/messaggi.md](docs/it/messaggi.md), [docs/en/messages.md](docs/en/messages.md). Decisions: [ADR 0006](docs/en/adr/0006-queues-no-database.md).

---

## Stack Choices

### Node.js 24 & TypeScript 5.9

**What**: Node 24 LTS, TypeScript 5.9 in strict mode, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; ESLint `strict-type-checked` forbids `any`.

**Why**: PEC sending is I/O-bound (SMTP, IMAP, RabbitMQ): Node's async model fits. Strict types catch at build time what would otherwise surface on a live mailbox.

### rabbitmq-client 5

**What**: the AMQP 0-9-1 client for RabbitMQ: a `Consumer` that acknowledges each message when our handler has finished, a `Publisher` that waits for RabbitMQ's confirmation.

**Why**: it reconnects, declares the queues again and resumes consuming by itself after a broker restart; amqplib leaves all of that to the application. It sits behind our `Queues` interface, in one file ([src/queue/rabbit-queues.ts](src/queue/rabbit-queues.ts)). Details and verified RabbitMQ behaviour: Stage 6, phase 2.

### nodemailer 10, imapflow 2, mailparser 3

**What**: nodemailer composes the MIME message and speaks SMTP; imapflow speaks IMAP; mailparser reads the receipts.

**How they are used**: the message is built in memory and sent raw, one pooled connection per mailbox; nodemailer's transaction log (commands and replies, never the body) tells whether the server had accepted the data when a connection drops. imapflow files the copy in the Sent folder and reads the receipts folder read-only (`EXAMINE`, `BODY.PEEK`); it also searches a receipt by `X-Riferimento-Message-ID` for a redelivered PEC.

### htmlparser2 + domhandler

**What**: a forgiving HTML parser and the DOM it produces.

**Why**: the HTML of a PEC is checked against a closed list of elements and attributes, and rejected, never sanitised ([html-policy.ts](src/modules/templates/html-policy.ts)). In XML mode it reads `daticert.xml` without ever expanding DTD entities (no XXE).

### Zod 4

**What**: schemas for the environment ([env.schema.ts](src/config/env.schema.ts)) and for the input message ([send-request.ts](src/modules/sending/send-request.ts)).

**Why**: one definition gives the validation, the TypeScript type and the error messages; `z.strictObject` refuses unknown fields, so a typo in a message does not pass unnoticed.

### pino 9

**What**: JSON logs, one line per event on standard output, with level names, the tenant, the mailbox, the service and its version on every line; `pino-pretty` for a terminal, development only.

**Why**: what a container is expected to write and what Graylog ingests without parsing rules. Secrets are wrapped ([secret.ts](src/common/security/secret.ts)) and the logger redacts `password`, `pass` and `url` fields; nothing personal is logged.

### Vitest 5

**What**: two projects, `unit` and `integration`, with Vitest's default (esbuild) transform: without decorators, no SWC.

### Greenmail and smtp-server (tests and local stack only)

- **Greenmail**: a fake mail provider, SMTP and IMAP, in the local and test stacks; it does not exist in production. With `auth.disabled` any password is accepted and the login is the full address. It issues no PEC receipts.
- **smtp-server**: nodemailer's own SMTP server, run inside the tests with scripted answers ([fake-smtp.ts](test/helpers/fake-smtp.ts)): the real SMTP client is tested against a real dialogue, including a connection cut after the server took the message.

### Docker

**What**: [docker/Dockerfile](docker/Dockerfile), multi-stage on `node:24-bookworm-slim`: production dependencies only, non-root user, health check, one entry point (`dist/main.js`); the commands (`dist/main.cli.js`: `config check`, `probe`) run in the same image.

---

## Architectural Patterns

### One container per tenant and mailbox

Each container is configured by its environment only and serves one mailbox: a mailbox that fails, is suspended or uses too much memory touches no other. Serfin with three mailboxes runs three containers, three sets of queues.

### Configuration: environment only

Every setting is a variable, validated once at start ([.env.example](.env.example) lists them with their defaults). Provider presets (`aruba`, `legalmail`, `namirial`) fill host, port, security and Sent folder; `custom` asks for every one. A wrong variable stops the start with a message naming it. In Kubernetes the variables come from a ConfigMap, the passwords and `RABBITMQ_URL` from a Secret.

### Queues, at least once

- The input message is acknowledged only after its outcome is confirmed by RabbitMQ (publisher confirms): an outcome is never lost, and may arrive twice. Every event has a stable `eventId` (`sent:<id>`, `receipt:<sha256>`...), so the consumer recognises a copy.
- The input queue has one active consumer (a rolling update never has two containers sending), a delivery limit, and dead-lettering at least once.
- A failed handling gives the message back after a 10-second pause (RabbitMQ 4 does not count such returns towards the delivery limit); a PEC certainly not sent (stopping, suspended mailbox) is published again as a new message, not returned as "redelivered".

### No memory, by design

- **Correlation**: the sender's id is inside the Message-ID, `<pm.{id}@sender-domain>`; every receipt quotes it, so receipts find their PEC with nothing stored.
- **Redelivered PEC**: never sent blindly. Its receipt is searched in the mailbox: found = `sent`, not found in time = `uncertain`. Only the rules of the message itself can reject it at that point; the recipient is not judged again.
- **Receipts**: the cursor lives in memory; each start reads the last 24 hours again and publishes the same events with the same `eventId`.
- **Pace**: per minute, in memory.

### Suspension

A refused login, SMTP or IMAP, suspends the mailbox at once ([mailbox-suspension.ts](src/modules/sending/mailbox-suspension.ts), shared by sender and reader): one `mailbox.suspended` event, no PEC taken, no mail read, readiness false, until a restart. Repeated refused logins could get the account locked.

### Interfaces where the outside world begins

`Queues`, `SmtpClientFactory`, `SentArchiverFactory`, `ProofLookup`, `ReceiptSourceFactory`, `MxResolver`, `Clock`, `Sleeper`: the unit tests replace each with a fake; [container.ts](src/app/container.ts) wires the real ones.

---

## Versions & Dependencies

Since stage 6 (see its section below): no framework, no database, no HTTP API.

| Package                    | Version        | Purpose                                                      |
| -------------------------- | -------------- | ------------------------------------------------------------ |
| rabbitmq-client            | 5.0.8          | RabbitMQ: queues, publisher confirms, automatic reconnection |
| nodemailer                 | 10.0.10        | SMTP sending and MIME composition                            |
| imapflow                   | 2.0.5          | IMAP: Sent copy and receipt reading                          |
| mailparser                 | 3.9.28         | Parses PEC receipts                                          |
| htmlparser2 / domhandler   | 12.0.0 / 6.0.1 | HTML safety rules; XML mode for daticert.xml                 |
| zod                        | 4.6.5          | Validation of the environment and of queue messages          |
| pino                       | 9.14.0         | JSON logs on standard output                                 |
| typescript                 | 5.9.3          | Language (dev)                                               |
| vitest                     | 5.0.1          | Tests (dev)                                                  |
| eslint + typescript-eslint | 10.11.0        | Strict type-checked lint (dev)                               |
| smtp-server                | 3.19.13        | SMTP server inside the tests (dev)                           |
| pino-pretty                | 13.1.3         | Readable logs in a terminal, development only (dev)          |

Removed in stage 6: NestJS and its Fastify, Swagger, Mongoose and Zod integrations, mongoose, mongodb-memory-server, js-yaml, pino-http, reflect-metadata, rxjs, @swc/core and unplugin-swc. `npm audit` reports no vulnerability (the two fastify advisories noted in stage 5 went with fastify).

All are free/open-source; `package-lock.json` pins the exact tree.

---

## Known Quirks & Decisions

The quirks of versions up to 0.5.1 (NestJS, nestjs-zod, Mongoose, the YAML configuration) went with them. Those of the queue-based service:

1. **Line endings are LF, enforced by `.gitattributes`** (`* text=auto eol=lf`). Git for Windows ships with `core.autocrlf=true`, which writes CRLF into the working tree on every checkout: after the merge of stage 6 into main, 69 files came out CRLF and `prettier --check` (`endOfLine: lf`) failed. The attribute wins over the machine's setting. Binary files are listed as `binary` because a small PDF with no NUL byte looks like text to git and would be converted; the receipt fixtures stay `-text`, byte for byte. After such a change git lists the files as modified until they are added again (it trusts the old size): their content is identical, and the commit only carries the real changes.

2. **RabbitMQ 4 does not count a message given back on purpose** (nack with requeue) towards the delivery limit, only the returns caused by a lost channel or connection: a handler that keeps failing would spin, hence the 10-second pause (skipped while stopping). Also: `basic.get` is refused on a single-active-consumer quorum queue (tests consume and close instead); quorum queues refuse `delete --if-empty` (check they are empty, then delete); declaring an existing queue with different arguments fails with PRECONDITION_FAILED, so a change of arguments means deleting and declaring again.

3. **rabbitmq-client drops the messages that arrive while a consumer closes**, and RabbitMQ gives them back marked "redelivered": the container therefore stops consuming the moment it is asked to stop (see "Review of stage 6").

4. **Greenmail**: with `auth.disabled` any password is accepted and the user is the full address; it issues no PEC receipts, so tests drop receipts into the sender's inbox themselves.

---

## Deployment Notes

- **Kubernetes**: one Deployment per tenant and mailbox, one replica. Variables from a ConfigMap (tenant, mailbox, provider, sender); `PECMAILER_SMTP_PASSWORD`, the Legalmail account code and `RABBITMQ_URL` from a Secret. Probes `/health/live` and `/health/ready` on port 3001; `terminationGracePeriodSeconds: 120` (the container finishes the PEC in hand); no volume, the file system can be read-only.
- **RabbitMQ**: `max_message_size` 64 MB and `consumer_timeout` 30 minutes ([docker/rabbitmq/rabbitmq.conf](docker/rabbitmq/rabbitmq.conf)); one user per tenant, limited to `pecmailer.<tenant>.*`. The container declares its queues; when the infrastructure creates them, it uses exactly the arguments listed in [docs/asyncapi.yaml](docs/asyncapi.yaml) and sets `PECMAILER_DECLARE_QUEUES=false`. The input queue's arguments changed in 0.6.1: a queue declared by 0.6.0 must be deleted (empty) and declared again.
- **Logs**: standard output, JSON, collected by Graylog. Worth an alert: `mailbox.suspended` events, and any message in a `.dead` queue.
- **Environment files**: npm scripts load `.env` with `node --env-file-if-exists=.env`, never the code. The local Docker stack sets its own values in [docker-compose.yml](docker-compose.yml); `.env` (never committed) holds only local secrets that compose reads for `${...}`.
- **Collaudo on a real mailbox**: a compose override outside git (in `data/`) starts one more container on the local RabbitMQ with the real provider's settings; its password comes from `.env` through compose, or, for credentials that must not be written anywhere, from variables typed in the operator's own terminal session. `probe` first, then two PECs to addresses the operator controls; the container is removed afterwards.

---

## Testing Strategy

- **Unit** (`npm test`, 157 tests, no external service): every rule of the sender and of the reader with fakes (in-memory queue, scripted SMTP, fake Sent folder, fake receipt folder, a clock that moves on demand, a sleeper that does not wait); the real SMTP client against a real SMTP dialogue (smtp-server); the receipt parser against real Aruba receipts, anonymised ([test/fixtures/receipts/aruba](test/fixtures/receipts/aruba/README.md)); configuration, queue declarations, the container's shutdown order.
- **Integration** (`npm run test:integration`, 20 tests): [docker-compose.test.yml](docker-compose.test.yml), a compose project of its own (RabbitMQ on 5673, Greenmail on 13025/13143). RabbitQueues against RabbitMQ (confirms, one consumer at a time, the pause, dead letters, the delivery limit); the whole container (sent, rejected, dead-lettered, redelivered with and without a receipt, receipts published whole); the IMAP receipt source.
- **`npm run check`**: typecheck, lint, formatting, unit tests.
- **Live**: the local stack ([docker-compose.yml](docker-compose.yml)) with `npm run local:publish` and `npm run local:outcomes`; collaudo on a real Aruba mailbox (Stage 6, phase 5 and review).

---

## Stage 6 — From a database to queues (0.6.0 and 0.6.1, 2026-09-19)

Infrastructure asked for a different shape, and the project agreed:

- **One container per tenant and mailbox pair.** Serfin with three mailboxes runs three containers, each configured by its environment only.
- **No database.** The service keeps nothing: no messages, attachments or receipts. Whoever fills and empties the queues keeps the records; logs go to standard output (collected by Graylog).
- **RabbitMQ.** One input queue (PECs to send) and one output queue (outcomes and receipts) per container, plus a dead-letter queue.

Decisions taken with the migration plan:

| Decision                      | Choice                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content                       | The sender sends the final subject and HTML; no templates or placeholders                                                                             |
| Checks kept                   | PEC recipient, HTML safety rules, maximum size: a wrong PEC has legal effect, a rejected one costs nothing                                            |
| Granularity                   | One PEC per queue message; a batch is only an optional label echoed back                                                                              |
| Temporary errors              | Retried inside the container within 25 minutes, waits and attempts included (RabbitMQ takes back a message not acknowledged within 30), then `failed` |
| Redelivered PEC after a crash | Never sent blindly: the acceptance receipt is looked for in the mailbox; found = `sent`, not found = `uncertain`                                      |
| Refused password              | The container stops taking PECs (they wait in the queue) until it is restarted                                                                        |
| Pace                          | Per minute only, kept in memory; no daily quota                                                                                                       |
| Queues                        | Created by the container at start-up when missing                                                                                                     |
| Version                       | 0.6.0                                                                                                                                                 |

### Phase 1: the message contract

**What**: [docs/asyncapi.yaml](docs/asyncapi.yaml) describes the queues and every message, with JSON schemas and examples. Guides in words, with PHP examples for the CRM: [docs/it/messaggi.md](docs/it/messaggi.md), [docs/en/messages.md](docs/en/messages.md).

**Why AsyncAPI**: it is to queues what OpenAPI (Swagger) is to HTTP APIs: an open standard (Linux Foundation) that tools read to render documentation, validate messages and generate code. Version 3.1, validated with the official `@asyncapi/cli` (`npx @asyncapi/cli validate docs/asyncapi.yaml`). It replaces the Swagger page, which goes away with the HTTP API.

**Key rules of the contract**: the sender's `id` of each PEC becomes part of the Message-ID (`<pm.{id}@sender-domain>`), so every receipt finds its way back without any memory in the container; every output event has a stable `eventId` for de-duplication (delivery is at least once); receipts travel whole, in base64, because they are the legal proof and the service keeps no copy.

### Phase 2: cleanup and skeleton

**rabbitmq-client, the RabbitMQ library**

- **What**: the client that speaks AMQP 0-9-1, RabbitMQ's protocol. It offers a `Consumer` that takes messages from a queue and acknowledges each one when our handler has finished, and a `Publisher` that waits for RabbitMQ to confirm that a message is stored.
- **Why this one**: after a broker restart or a network cut it reconnects, declares the queues again and resumes consuming by itself. With amqplib, the most widespread library, all of that is left to the application, and it is where subtle bugs live. It is written in TypeScript, has no dependency, and supports RabbitMQ 4.1 and later from version 5.0.3.
- **The risk**: a smaller community than amqplib, last release December 2025. The library is used in one file, [src/queue/rabbit-queues.ts](src/queue/rabbit-queues.ts), behind our `Queues` interface: replacing it would touch that file only.

**No more NestJS**: it served the HTTP API and wired objects together. A container that reads one queue has a dozen objects, now built by hand in [src/main.ts](src/main.ts). Gone with it: decorators, `reflect-metadata`, and the SWC transform the tests needed for decorator metadata (Vitest now uses its default).

**What RabbitMQ does, verified on 4.3**:

| Behaviour                                                                                        | Consequence in the code                                                                                                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Default maximum message size: 16 MB                                                              | The local and test stacks set 64 MB ([docker/rabbitmq/rabbitmq.conf](docker/rabbitmq/rabbitmq.conf)); production needs the same |
| A message not acknowledged within 30 minutes is taken back (consumer timeout)                    | Retries of temporary errors must fit in 25 minutes; the configuration refuses longer waits                                      |
| A message given back on purpose (nack with requeue) is **not** counted toward the delivery limit | A handler that fails gives the message back after a pause (10 s), or a failing message would spin at full speed                 |
| A message returned because its consumer died (channel or connection closed) **is** counted       | The delivery limit (5) dead-letters a message that keeps killing the container                                                  |
| `basic.get` is refused on a quorum queue with a single active consumer                           | The tests take messages with a consumer, not with a get                                                                         |

**Configuration**: environment only ([.env.example](.env.example)), validated at start ([src/config/env.schema.ts](src/config/env.schema.ts)). Provider presets fill host, port, security and Sent folder; IMAP credentials default to the SMTP ones; queue names derive from prefix, tenant and mailbox.

**Local stack** ([docker-compose.yml](docker-compose.yml)): RabbitMQ 4.3 with its management page, Greenmail, and two containers (serfin-aruba, serfin-legalmail). The test stack ([docker-compose.test.yml](docker-compose.test.yml)) is a separate compose project, so the two never see each other's containers.

**Commands** ([src/main.cli.ts](src/main.cli.ts)): `config check`, `probe`, and for development `publish` (a PEC from a JSON file; attachments may give a `path`) and `outcomes` (prints and takes the events of the output queue). `npm run local:publish` and `npm run local:outcomes` use [examples/local.env](examples/local.env).

**In this phase the container connects, declares its queues and answers the probes; it does not take PECs yet** (phase 3).

See [docs/en/adr/0006-queues-no-database.md](docs/en/adr/0006-queues-no-database.md) for the reasoning.

### Phase 3: sending

**How a PEC is handled** ([src/modules/sending/pec-sender.ts](src/modules/sending/pec-sender.ts)), one at a time:

1. No usable `id`, or not JSON: dead-letter queue (nobody to answer to).
2. **Checks** ([send-request.ts](src/modules/sending/send-request.ts)): the format (strict: unknown fields refused), the HTML rules, the inline images against the `cid:` references, each attachment's type from its bytes, the recipient's PEC domain, then the encoded size. Any problem: `rejected` with every reason, nothing sent.
3. **Pace** ([pace.ts](src/modules/sending/pace.ts)): one PEC every 60/`PECMAILER_PER_MINUTE` seconds, in memory.
4. **SMTP**, classified as before ([smtp-outcome.ts](src/modules/sending/smtp/smtp-outcome.ts)): accepted = copy in the Sent folder, then `sent`; permanent refusal = `failed`; temporary = retried after `PECMAILER_RETRY_BACKOFF_SECONDS`, then `failed` with `RETRIES_EXHAUSTED`; connection lost after the provider had the message = `uncertain`, never retried; refused login = mailbox suspended.
5. The input message is acknowledged when the outcome is confirmed by RabbitMQ. If publishing fails, the handler throws: the message comes back later marked redelivered.

**A redelivered PEC** (the container died, or could not publish the outcome) is never sent again blindly. The container searches the receipts folder for a receipt quoting the PEC's Message-ID ([src/modules/receipts/sent-proof.ts](src/modules/receipts/sent-proof.ts): IMAP `SEARCH HEADER X-Riferimento-Message-ID`, read-only, then the same receipt parser and trust rules). The acceptance normally arrives within seconds; the search is repeated every 20 s for `PECMAILER_REDELIVERY_WAIT_SECONDS`. Found: `sent` confirmed by the receipt. Not found: `uncertain`. A redelivered message that breaks a rule of its own content was certainly never sent: `rejected` (since 0.6.1 the recipient is not judged again at that point: see the review).

**Putting a PEC back as a new message**: when the container stops between two attempts, or the mailbox is suspended, the PEC certainly did not leave. Returning it the ordinary way would mark it redelivered, and it would come back as "possibly sent". It is published again at the end of the input queue instead, and the original acknowledged.

**Suspension**: a refused SMTP login (or IMAP: looking for a receipt, reading the receipts, and since 0.6.1 filing the Sent copy) publishes `mailbox.suspended` once, stops the consumer, and turns readiness false. The PECs wait in the queue; a restart with the right password resumes.

**Connections**: SMTP and IMAP are opened on the first PEC and closed after 30 seconds without one.

**Liveness**: false only when one handling has lasted more than 35 minutes (retries fit in 25): the container is stuck and Kubernetes restarts it.

**Verified**: unit tests for each rule with fakes (in-memory queue, scripted SMTP, a clock that moves on demand), and since 0.6.1 the real SMTP client against a real SMTP dialogue; integration tests of the whole container against RabbitMQ and Greenmail, including a crash simulated while handling and the receipt found by the IMAP search; live on the local stack, both mailboxes.

### Phase 4: receipts

**How the folder is read** ([src/modules/receipts/receipt-reader.ts](src/modules/receipts/receipt-reader.ts)), every `PECMAILER_RECEIPTS_POLL_SECONDS`:

1. The folder is opened read-only; the mails after the last UID read come one at a time ([receipt-source.ts](src/modules/receipts/receipt-source.ts), unchanged since stage 5's review).
2. The two top-level headers `X-Ricevuta` and `X-Trasporto` decide whether a mail may be a receipt; only then is it downloaded and parsed with the same trust rules as before (a transport envelope is never a receipt).
3. A receipt is ours when the Message-ID it quotes has our form, `<pm.{id}@...>`; the id inside is the sender's. Receipts of other messages (sent by hand, or by the old system) are left alone.
4. It is published whole ([outcome-events.ts](src/modules/sending/outcome-events.ts)): the `.eml` and the `daticert.xml` in base64, their facts, and `final` (DELIVERY, NON_DELIVERY, NON_ACCEPTANCE, VIRUS_DETECTED). The `eventId` is the SHA-256 of the receipt's own Message-ID, or of its bytes.

**No memory, on purpose**: the cursor lives in memory. At every start the last `PECMAILER_RECEIPTS_LOOKBACK_HOURS` (24 since 0.6.1, 72 before) are read again; the same receipts come out with the same `eventId`, and the consumer discards them. Verified live: after a restart, the two receipts of a PEC were published again with identical ids.

**Failures**: a receipt that cannot be published (RabbitMQ unreachable) stops the pass and is read again at the next one, for as long as it takes; a mail that cannot be downloaded or parsed three passes in a row is skipped with an `error` log, so it cannot hold back the others. A refused IMAP login suspends the mailbox through the object shared with the sender ([mailbox-suspension.ts](src/modules/sending/mailbox-suspension.ts)): one `mailbox.suspended` event, nothing sent or read until a restart.

**Liveness**: the reader counts as alive while it reads or sleeps on schedule; a pass stuck for more than 15 minutes beyond the poll interval makes the liveness probe fail.

**Greenmail issues no receipts**: the tests and the live checks drop receipts into the sender's inbox themselves. The receipts of real providers are covered by the anonymised Aruba fixtures of stage 5, and by the collaudo of phase 5.

### Phase 5: release and collaudo

**Collaudo on a real Aruba mailbox** (2026-09-19), with the image of the release, the local RabbitMQ and a container `serfin/collaudo-aruba` whose password came from `.env` through compose (a git-ignored override in `data/collaudo/`):

1. `probe`: SMTP and IMAP login ok, Sent folder `INBOX.Inviata` found.
2. Two PECs published with `npm run local:publish`: one to the mailbox itself with a PDF, one to an address that does not exist.
3. Output queue, within a minute: `sent` ×2 (Sent copy ARCHIVED), `receipt` ACCEPTANCE ×2, DELIVERY ×1, NON_DELIVERY ×1 (`5.1.1 - indirizzo non valido`). The PEC delivered to the mailbox itself was left out as a transport envelope, as it should.
4. Container restarted: the four receipts came out again with the same `eventId` and byte-identical `.eml`.

**Not done**: the same collaudo on Legalmail (no credentials yet), listed in What's Next.

**Release**: version 0.6.0 in `package.json` and [src/app/version.ts](src/app/version.ts); CHANGELOG, README and SECURITY.md rewritten for the queue-based service.

### Review of stage 6 (0.6.1)

The usual full re-read after a stage, plus a read-only check on the real Aruba mailbox: `ImapProofLookup` (the receipt search of a redelivered PEC) found the acceptance of both collaudo PECs in about half a second each and nothing for a Message-ID never sent, so the redelivery path works on the real provider too.

| #   | Found                                                                                                                                                                                                                                                                                                                                                                                                             | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | On stop, the consumer stayed open until the receipt reader ended its pass: PECs taken meanwhile went back to the end of the queue, and one caught on its way to the container (rabbitmq-client drops messages that arrive while it closes, and RabbitMQ gives them back marked redelivered) meant a five-minute wait and a false `uncertain` after the restart. Likeliest during campaigns, when passes are long. | [container.ts](src/app/container.ts) stops consuming together with the reader, right after the abort; [rabbit-queues.ts](src/queue/rabbit-queues.ts) skips the failure pause once stopping. Unit test with a pass held open; integration test for the pause; verified live (six PECs, stop in the middle: all `sent`, none redelivered). A window of a few milliseconds remains, when the CRM publishes exactly while the container closes: a limit of the library, accepted. |
| 2   | `recover` ran every check again, the recipient's too, whose verdict depends on DNS and on the lists: a PEC that left could come out `rejected` and be sent again.                                                                                                                                                                                                                                                 | `SendRequestChecker.check(body, { verifyRecipient: false })` in `recover`; the Message-ID comes from `messageIdFor`, without building the whole message.                                                                                                                                                                                                                                                                                                                      |
| 3   | The `infocert` preset used Namirial's domain (sicurezzapostale.it) with server names that do not exist.                                                                                                                                                                                                                                                                                                           | Replaced by `namirial` with the servers Namirial publishes; its Sent folder is unknown, so the preset leaves it out and the configuration asks for it.                                                                                                                                                                                                                                                                                                                        |
| 4   | Legalmail preset on port 25 with STARTTLS; InfoCert publishes 465 with TLS, and port 25 is often blocked out of cloud networks.                                                                                                                                                                                                                                                                                   | 465/tls; the Legalmail collaudo confirms it.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 5   | A refused IMAP login in the Sent copy was only a failed copy: one refused login per PEC until the reader noticed.                                                                                                                                                                                                                                                                                                 | `ImapAuthError` ([imap-auth-error.ts](src/modules/sending/imap/imap-auth-error.ts)) thrown by all three IMAP users; the sender suspends the mailbox on it.                                                                                                                                                                                                                                                                                                                    |
| 6   | 72 hours of receipts re-published at every restart: during a campaign, hundreds of MB and new receipts delayed by the backlog.                                                                                                                                                                                                                                                                                    | Default 24 hours.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 7   | The retry budget counted the waits only.                                                                                                                                                                                                                                                                                                                                                                          | Waits + one SMTP timeout per attempt ≤ 25 minutes; the defaults fit exactly.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | Wording: `RETRIES_EXHAUSTED` "after 30 minutes" (21 with the defaults), a comment naming the old configuration file, a doubled comment, no log line for `MESSAGE_TOO_LARGE`, nothing in the guides about a PEC with two outcomes.                                                                                                                                                                                 | Fixed; rule 9 in the guides.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 9   | Quorum dead-lettering defaults to at most once: a message moved while the dead-letter queue is unavailable is lost.                                                                                                                                                                                                                                                                                               | `x-dead-letter-strategy: at-least-once` with `x-overflow: reject-publish` (required by it; no length limit is set, so no publish is ever refused). Existing input queues must be recreated: RabbitMQ refuses a declaration with different arguments.                                                                                                                                                                                                                          |

Known and accepted: a PEC whose outcome was published but not acknowledged (the container stopped in that instant) comes back and may get a second, different outcome, e.g. `failed` then `uncertain`. Telling the two apart would need memory; the guides tell the CRM to treat such a PEC as `uncertain`.

### Housekeeping after the merge into main

- **Line endings**: `.gitattributes` forces LF (see Known Quirks, 1).
- **A test that had lost its subject**: the in-process SMTP server of the tests ([fake-smtp.ts](test/helpers/fake-smtp.ts)) had been unused since the move to queues, so the real SMTP client was no longer tested against a real dialogue, and the most delicate case (the connection cut after the server took the message) had no protocol-level test. It is back, with [smtp-client.spec.ts](test/unit/sending/smtp-client.spec.ts); writing it showed that the fake server did not really cut the connection, now fixed.
- **Leftovers of 0.5.x removed**: the configuration file, the old API key, the MongoDB and storage volumes, the compiled files of removed code, obsolete entries in `.gitignore` and `.dockerignore`; ADR 0001 to 0005 marked as superseded. The real receipts of the first Aruba collaudo were saved to `data/collaudo/esiti-0.5.1` before their volume was deleted.
- **`.env`**: only the local secrets compose reads (the Aruba collaudo password); everything else is in `docker-compose.yml` and, for a container outside Docker, in a `.env` made from `.env.example`.

---

## What's Next

Version 0.6.1. Open items before production:

- **Collaudo on Legalmail**, the production provider: login with the account code, SMTP port 465 with TLS (as InfoCert publishes it; the legacy project used 25, often blocked in cloud networks), Sent folder `INBOX/Spedite`. The preset holds all three; only a real send proves them. The mailbox is the company's: its credentials are typed by the operator in a terminal session of their own, never written in a file.
- **Hand-over to infrastructure**: RabbitMQ settings and the exact queue arguments, one user per tenant, Kubernetes manifests (ConfigMap, Secret and Deployment per mailbox), logs to Graylog, alerts on `mailbox.suspended` and on messages in `.dead`.
- **The CRM side**: publishing PECs and consuming the output queue ([docs/it/messaggi.md](docs/it/messaggi.md) has PHP examples).
- **PEC provider lists** ([pec-providers.ts](src/modules/recipients/pec-providers.ts)) to be checked against the AgID registry.
- **A load test** close to reality (thousands of PECs through Greenmail) before the first large campaign.
- **Namirial**: its Sent folder is unknown; `probe` finds it the day a Namirial mailbox is used.
- **Verification of the providers' S/MIME signature** on receipts, if ever required.

---

## History: versions 0.1 to 0.5.1

What follows describes the first design: a multi-tenant HTTP API with a worker, MongoDB and webhooks (ADR 0001 to 0005, now superseded by ADR 0006). It is kept as the record of how the domain code was built and of the problems found on the way; none of it runs today.

### Stack choices of 0.1 to 0.5.1

#### Node.js & TypeScript

**What**: Node 24 LTS with TypeScript 5.9 in strict mode (`noImplicitAny` enforced by ESLint at build time).

**Why**: PEC sending is I/O-bound (SMTP, IMAP, network delays). Node's async/await model is a natural fit. TypeScript provides type safety at compile time so runtime surprises surface early. Strict mode catches entire categories of bugs (implicit types, optional property access).

**Impact**: Zero `any` in production code — the build fails if you try to sneak one in. This makes refactoring and onboarding safer.

---

#### NestJS 11 on Fastify

**What**: NestJS 11.2.5 as the application framework, Fastify as the HTTP server instead of Express.

**Why**:

- NestJS provides structure (dependency injection, guards, interceptors, module system) that multiple developers recognize.
- Fastify is faster than Express and has better streaming support for multipart uploads (which we need for batch file intake).
- Version 12 was days old at the time; the ecosystem (nestjs-zod, nestjs-pino) hadn't caught up. Staying on 11 was safer.

**Impact**: Code is organized by concern (auth module, mailboxes module, health checks), making it easy to find and test pieces. Fastify's streaming means large file uploads don't load into memory.

---

#### Zod 4 for Validation & OpenAPI

**What**: Zod 4.6.5 as the single source of truth for request/response validation and OpenAPI documentation.

**Why**:

- One schema definition → runtime validation, TypeScript types, and OpenAPI spec. No duplication, no drift.
- Catch bad input at the edge before it reaches business logic.
- Integrates cleanly with NestJS via `nestjs-zod`.

**Trade-off**: `.prefault({})` syntax for object defaults (not `.default({})`) — Zod 4 uses `prefault` for partial defaults.

**Impact**: Every endpoint is self-documenting at `/docs` (Swagger UI). Clients see the exact shape they must send.

---

#### MongoDB 9 + Mongoose 9

**What**: MongoDB 8 as the database, Mongoose 9.10.1 as the ODM (Object Document Mapper).

**Why**:

- Company standard — all microservices use MongoDB.
- Document-oriented storage maps naturally to JSON payloads (batches, messages, attachments).
- Single-node replica set (even locally) enables transactions and change streams, which we need for reliable state transitions.
- Mongoose keeps us from writing raw queries; schemas validate shape at the application level.

**Constraint**: Write concern is `{ w: 'majority', journal: true }` — a message recorded as SENT must survive a replica failover, so it is never sent twice.

**Impact**: Data lives in one database with `tenantId` isolation; migrations are straight schema updates. No schema version management; Mongoose handles index creation.

---

#### nodemailer + imapflow

**What**:

- `nodemailer@10.0.10` for SMTP (sending messages); ships its own TypeScript types since v10.
- `imapflow@2.0.5` for IMAP (reading receipts, filing copies).

**Why**:

- Both are maintained and typed (TypeScript support out of the box).
- nodemailer speaks all SMTP flavours (TLS, STARTTLS, SASL).
- imapflow has structured responses and stream support for large attachments.
- No dependency on PHP's deprecated `imap` extension.

**Impact**: Sending and receipt logic is portable; we're not locked to a CRM-specific mailer.

---

#### pino (Logging) via nestjs-pino

**What**: pino with nestjs-pino integration for structured JSON logging.

**Why**:

- JSON on stdout, one line per event — the platform (Kubernetes, observability stack) collects it automatically.
- `pino-pretty` in dev mode for readability; JSON in production.
- Field redaction at the logger level: passwords, API keys, secrets never leak even if accidentally logged.
- `assignResponse: true` means fields added with `PinoLogger.assign()` (like `tenantId` after auth) appear on the "request completed" line.

**Impact**: Logs are machine-readable and safe to ship to observability stacks. Every request is tagged with the tenant it belongs to.

---

#### Vitest 5 + SWC for Testing

> Update (stage 2): the e2e project now runs against an in-memory MongoDB replica set started once per run by `test/e2e/global-setup.ts` (`fileParallelism: false`, `hookTimeout` raised for the first binary download). See _mongodb-memory-server_ below.

**What**: Vitest 5.0.1 as the test runner, @swc/core for transpilation.

**Why**:

- Vitest is fast (no startup overhead like Jest) and supports modern ES syntax out of the box.
- SWC transpiler with decorator metadata support for NestJS DI (factories, injectables).
- No `module: commonjs` in vitest config — defaults to ESM, which matches the codebase.
- Three project configs (unit / integration / e2e) let us run test suites independently.

**Impact**: Unit tests run in milliseconds. Integration tests with a real MongoDB take ~30s. E2E tests on the HTTP surface run in seconds.

---

#### Greenmail for Local PEC Testing

**What**: Greenmail (standalone SMTP/IMAP/POP3/POP3S/IMAPS fake server) for local development.

**Why**:

- No need to create real PEC mailboxes during development.
- Greenmail user format: `login:password@domain` (e.g., `solleciti:change-me@pec.serfin.example`).
- Exposes SMTP (3025), IMAPS (3993), web UI (8080) for inspection.
- Healthcheck via `/dev/tcp` (bash file descriptor trick) since the image has no curl/wget.

**Impact**: `docker compose up` gives you a full local PEC stack in seconds.

---

### Architectural patterns of 0.1 to 0.5.1

#### Multi-Tenancy

**Design**: Single MongoDB database with `tenantId` on every document. Tenant identity derives from the API key (never from the request payload). Branded types (`TenantId`, `MailboxCode`, etc.) prevent passing the wrong ID to the wrong query at compile time.

**Why**: Shared infrastructure is cheaper than separate databases. Type safety catches tenant-isolation bugs before they reach production.

---

#### Configuration

**Design**:

- **Environment** (`.env`): ports, database URI, paths, every secret (mailbox passwords as `MAILBOX_<CODE>_PASSWORD`, webhook secrets by name).
- **Config file** (`config/pecmailer.yaml`): tenants, mailboxes, API key SHA-256 hashes. No secrets. Validated at boot.

**Why**: Secrets stay in the environment (Kubernetes Secret injection), not in config files. Configuration is loaded once at boot; parse errors refuse to start the process.

---

#### Error Handling

**Design**: Every error is an RFC 9457 problem document (`application/problem+json`). 5xx errors never expose an internal message; clients get a `requestId` to quote.

**Why**: Consistent error handling across all endpoints. Integrators handle failures in one place.

---

### Deployment notes of 0.1 to 0.5.1

- **Single image, three entry points**: `docker run ... node dist/main.api.js`, `node dist/main.worker.js`, `node dist/main.cli.js`.
- **Environment loading**: npm scripts use `node --env-file-if-exists=.env` to load the env file at runtime, not at build time.
- **Secrets from environment only**: Passwords, webhook secrets, API keys never live in the config file or the image.
- **Mongo write concern**: `w: 'majority', journal: true` ensures durability across replicas.

---

### Testing strategy of 0.1 to 0.5.1

- **Unit tests** (`test/unit/**`): fast, no external services. Test business logic, guards, config parsing.
- **Integration tests** (`test/integration/**`): real MongoDB + Greenmail from `docker-compose.test.yml`. Test sender, receipt logic, state transitions.
- **E2E tests** (`test/e2e/**`): in-process HTTP calls (Fastify injection). No database. Test API surface, error handling, tenant isolation.

---

### Stage 2 — Batch intake (2026-09-19)

#### htmlparser2 (HTML policy)

**What**: `htmlparser2@12` (MIT), a fast, forgiving HTML parser, with `domhandler` for the DOM it produces.

**Why**: the template policy is a _closed allowlist_ — every element and attribute is checked, nothing is stripped. That needs a real parser, not regular expressions: browsers and mail clients are forgiving too (`<SCRIPT>`, unclosed tags, attributes without quotes), so the check must see the document the way they will. htmlparser2 is the parser behind cheerio, small, dependency-light, and exposes element names and attributes directly.

**Alternatives considered**: `sanitize-html`/`DOMPurify` clean the HTML — the opposite of what a certified message needs (reject, never silently change); `parse5` is spec-exact but heavier and gives nothing more for an allowlist.

**Where**: [src/modules/templates/html-policy.ts](src/modules/templates/html-policy.ts).

#### mongodb-memory-server (tests and OpenAPI export)

**What**: `mongodb-memory-server@11` (MIT, dev dependency). Downloads a real `mongod` binary once (~800 MB for MongoDB 8.2, cached in `~/.cache/mongodb-binaries`) and starts it in memory; `MongoMemoryReplSet` starts it as a single-node replica set.

**Why**: the intake relies on transactions, unique partial indexes and duplicate-key errors. A mocked Mongoose would test the mock. With a real in-memory replica set the e2e suite runs with `npm run test:e2e`, no Docker required, and each test stack gets its own database inside one shared `mongod` (started once by [test/e2e/global-setup.ts](test/e2e/global-setup.ts)). The OpenAPI export tool uses it too, since the application now always needs a database to boot.

**Trade-off**: the first run downloads the binary; CI must cache `~/.cache/mongodb-binaries`.

#### @fastify/multipart (already installed, now used)

**What**: streaming multipart parser for Fastify. Registered in [src/app/multipart.ts](src/app/multipart.ts) with `attachFieldsToBody: false`: nothing is buffered, the intake iterates `request.parts()`.

**Quirk**: a form field sent with `Content-Type: application/json` reaches the handler already parsed into an object (and malformed JSON is refused by the plugin itself with `406`). The intake serialises it back so one code path validates it and the idempotency fingerprint sees stable bytes. A client can also send the field as plain text.

#### How POST /v1/batches works

1. **Stream** every part: the `batch` JSON in memory (bounded), every file to `STORAGE_DIR/staging/<request id>/<part>` while a SHA-256 and the first 512 bytes are computed. The per-tenant request ceiling is enforced while streaming (`413`).
2. **Parse** the JSON with the Zod schema ([batch-request.schema.ts](src/modules/batches/batch-request.schema.ts)); structural rules (`EMPTY_BATCH`, `TOO_MANY_MESSAGES`, `DUPLICATE_REF`) are `422`.
3. **Resolve the mailbox** for the calling tenant (`403` otherwise) and its state (`423` if suspended).
4. **Check files**: content type from the first bytes + extension allowlist (`415`); every referenced part must exist and every part must be referenced (`400`).
5. **Idempotency**: fingerprint = JSON + files; `begin()` inserts the lock or replays the stored answer.
6. **Compile the template** once: placeholder syntax, HTML policy, inline images (`422 TEMPLATE_REJECTED`).
7. **Per row**: recipient verdict (domain lists, then MX with a per-domain cache), `dedupKey` (against the database and within the batch), render (missing placeholders, raw HTML values re-checked), attachments (extension must match the part, no duplicate names), encoded size against the mailbox limit. Each failure is one rejected row with a stable code.
8. **Decide**: `atomic` with rejections → `422`; zero accepted → `422`; `dryRun` → `200` with a preview and the staging removed.
9. **Persist**: staging renamed to `batches/<tenant>/<batch>/parts/`, batch + messages inserted in one transaction, idempotency record completed, `202` with `Location`.

Every error path removes the staging directory and releases the idempotency lock.

#### Collections added

| Collection         | Key facts                                                                                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `batches`          | `_id` = `b_...`; template, options, stored parts, counters, per-row rejections and warnings; indexes on `tenantId` + `createdAt`/`reference`/`subTenant`/`status`.                                                   |
| `messages`         | `_id` = `m_...`; rendered subject/html, attachments with paths, `status: PENDING`, `nextAttemptAt`; unique `{batchId, ref}`; unique partial `{tenantId, dedupKey}`; worker index `{mailbox, status, nextAttemptAt}`. |
| `idempotency_keys` | unique `{tenantId, key}`, fingerprint, state, stored response, TTL 24 h.                                                                                                                                             |
| `mailbox_states`   | `_id` = mailbox code, `ACTIVE`/`SUSPENDED` + reason; absent = active. Written by the worker (stage 3) and operators.                                                                                                 |

#### Error codes a client can branch on

Batch level (nothing created): `MULTIPART_REQUIRED` 415, `MISSING_BATCH_PART`/`INVALID_JSON`/`VALIDATION_FAILED`/`MISSING_PART`/`UNREFERENCED_PART`/`IDEMPOTENCY_KEY_REQUIRED` 400, `MAILBOX_NOT_AVAILABLE` 403, `IDEMPOTENCY_KEY_REUSED`/`IDEMPOTENCY_IN_PROGRESS`/`DEDUP_KEY_CONFLICT` 409, `REQUEST_TOO_LARGE` 413, `ATTACHMENT_TYPE_REJECTED` 415, `EMPTY_BATCH`/`TOO_MANY_MESSAGES`/`DUPLICATE_REF`/`TEMPLATE_REJECTED`/`BATCH_REJECTED`/`ALL_MESSAGES_REJECTED` 422, `MAILBOX_SUSPENDED` 423, `TOO_MANY_REQUESTS` 429.

Row level (in `rejectedMessages`): `RECIPIENT_NOT_PEC`, `RECIPIENT_UNVERIFIED`, `DUPLICATE_DEDUP_KEY`, `MISSING_PLACEHOLDER`, `HTML_VALUE_REJECTED`, `SUBJECT_LENGTH`, `ATTACHMENT_EXTENSION_MISMATCH`, `DUPLICATE_ATTACHMENT_FILENAME`, `MESSAGE_TOO_LARGE`.

Warnings: `TEMPLATE_WITHOUT_PLACEHOLDERS`, `UNUSED_VARS`, `UNUSED_INLINE_IMAGE`.

See [docs/en/adr/0002-batch-intake.md](docs/en/adr/0002-batch-intake.md) for the reasoning behind each rule.

---

### Stage 3 — Sending worker (2026-09-19)

#### nodemailer 10 (SMTP) — how it is used

**What**: `nodemailer` for the SMTP dialogue, `nodemailer/lib/mail-composer` to build the MIME message. Version 10 ships its own TypeScript types (`@types/nodemailer` was removed).

**How**: the message is composed once with `MailComposer` and streamed to an `.eml` file; the file is then sent as `raw` with an explicit envelope. A pooled transport per mailbox (`pool: true, maxConnections: 1, maxMessages: 100`) keeps one connection while there is work and is closed when the queue is empty. Timeouts (`connectionTimeout`, `greetingTimeout`, `socketTimeout`) come from `smtp.timeoutSeconds`.

**Quirk that shaped the design**: nodemailer tags a socket timeout as `command: 'CONN'` wherever it happens, so its error alone cannot tell "the server never got the message" from "the server took it and we lost the final reply". With `transactionLog: true` nodemailer passes every client command and server reply to a logger object (never the body); [smtp-client.ts](src/modules/sending/smtp/smtp-client.ts) watches for the server's `354` and attaches `dataAccepted` to the failure. [smtp-outcome.ts](src/modules/sending/smtp/smtp-outcome.ts) turns that into `suspend | retry | fail | stuck`.

#### imapflow 2 (IMAP) — how it is used

**What**: `imapflow` for the Sent-folder copy (`append`) and the probe (`status` of the folder). Lazy connection per mailbox, reconnected on the next message after an error, closed with the lease. `logger: false`.

#### smtp-server + mailparser (tests only)

**What**: `smtp-server` (nodemailer's own SMTP server, MIT-0) runs a real SMTP server inside the test process with scripted answers (accept, refuse login, 450/550 on RCPT, 452/552 on DATA, hang up after DATA). `mailparser` parses the produced EML to assert headers, attachments and inline images.

**Why**: the state machine is driven by what the server answers; only a real SMTP dialogue exercises nodemailer's error fields and our protocol observer. The IMAP side is behind `SentArchiverFactory` and faked in tests; the Docker stack with Greenmail is the real run.

#### How the worker works

1. **WorkerRunner** starts one `MailboxSender` per configured mailbox and the `StuckRecovery` job, all on one abort signal. `WORKER_ID` (default `hostname:pid`) signs the leases.
2. **Lease**: `mailbox_leases` upsert conditioned on "free, expired or mine"; renewed at a third of `leaseTtlSeconds`; lost lease = loop stops at once; released on shutdown.
3. **Loop**: suspended? sleep and re-check · nothing due? close the idle SMTP connection and poll · `MailboxPacer.acquireSlot` (per-minute wait, per-day pause) · `claimNext` (atomic PENDING/RETRY_SCHEDULED → SENDING) · `sendOne`.
4. **sendOne**: build the EML → SMTP send → on success `markSent` (Message-ID, reply, EML path) then IMAP copy (`sentCopy`); on failure classify → suspend / retry (backoff, then `FAILED *_MAX_ATTEMPTS`) / fail / stuck.
5. **StuckRecovery** every minute: SENDING older than `staleSendingSeconds` → STUCK (`STALE_SENDING`).
6. **Batch**: QUEUED → SENDING on the first claim; counters follow every transition; SENT when `pending = 0` and `stuck = 0`.
7. **Shutdown**: abort, finish the message in flight (bounded by the SMTP timeouts), release leases, 45 s grace.

#### Collections added

| Collection              | Key facts                                                                                                                                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mailbox_leases`        | `_id` = mailbox code, `owner`, `expiresAt`; the one-sender-per-mailbox guarantee.                                                                                                                                                  |
| `mailbox_counters`      | `_id` = mailbox code, minute window and UTC day counters for pacing.                                                                                                                                                               |
| `messages` (new fields) | `sendingStartedAt`, `heartbeatAt` (stage 4), `workerId`, `sentAt`, `failedAt`, `stuckAt`, `messageIdHeader`, `smtpResponse`, `emlPath`, `sentCopy` (`PENDING` / `ARCHIVED` / `FAILED` / `DISABLED`), `sentCopyError`, `lastError`. |
| `batches` (new fields)  | `sendingStartedAt`, `sentAt`.                                                                                                                                                                                                      |

#### Operations

| Situation                      | What to do                                                                                                                                                                                               |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mailbox list` shows SUSPENDED | The provider refused the login. Fix the password in the environment, `mailbox probe <code>`, then `mailbox activate <code>`.                                                                             |
| `message stuck` lists messages | Open the provider's webmail / Sent folder and look for the `Message-ID` shown. Present → `message resolve <id> --as sent`; absent → `--as requeue` (same Message-ID is reused); give up → `--as failed`. |
| Worker `/health/live` is 503   | No loop ticked for 5 minutes: the process is wedged, restart it; leases expire on their own.                                                                                                             |

See [docs/en/adr/0003-sending-worker.md](docs/en/adr/0003-sending-worker.md) for the reasoning.

---

### Stage 4 — Read side and cancellation (2026-09-19)

No new library this stage; the choices are about how data is read and kept consistent.

#### Keyset (cursor) pagination

**What**: lists return `items` and, when there is more, an opaque `nextCursor` to pass back as `?cursor=`. The cursor is the sort key of the last item (base64url JSON, tagged with the list it belongs to): `(createdAt, _id)` for newest-first lists, `position` inside a batch.

**Why not page numbers/offsets**: a list of messages changes while it is read (the worker moves statuses, new batches arrive); offsets then skip or repeat items, and `skip(n)` gets slower the deeper you go. A keyset query is an index range scan whatever the page. See [src/common/http/cursor.ts](src/common/http/cursor.ts).

**Security note**: the cursor is not signed. It only says where to resume; the query it is applied to is already restricted to the tenant, so a forged cursor cannot reveal anything more. A cursor of another list, or malformed, is `400 INVALID_CURSOR`.

#### Derived counters instead of stored ones

**What**: the per-status counters of a batch are an aggregation over its messages (index `{batchId, status}`); the batch is closed (`SENT`, or `CANCELLED` when nothing ever left) by looking at the messages themselves ([batch-counters.ts](src/modules/batches/batch-counters.ts)).

**Why**: stage 3 kept counters on the batch with `$inc` after each message transition. Two writes without a transaction: a crash between them left the counters wrong and the batch SENDING forever. Counting 2,500 documents on an index is a few milliseconds; correctness by construction is worth more than a stored number.

#### `Repr-Digest` (RFC 9530)

**What**: `GET /v1/messages/{id}/eml` sends `Repr-Digest: sha-256=:<base64>:`, the SHA-256 computed while the EML was written, before sending.

**Why**: RFC 9530 (2024) replaces the old `Digest` header (RFC 3230). The value comes from the database, not from re-reading the file: if the file on disk were altered later, the client would see a mismatch instead of a digest that vouches for the altered file.

#### Heartbeat for leases and in-flight messages

**What**: while a worker holds a mailbox, a timer renews the lease every `leaseTtlSeconds/3` and refreshes `heartbeatAt` on the message being sent; stale recovery marks STUCK only messages whose heartbeat is older than `staleSendingSeconds`.

**Why**: the loop can legitimately wait longer than a renewal period (a paced minute) or send for longer than the stale threshold (a 30 MB upload). Renewing from the loop let the lease lapse (two senders on one mailbox) and let a live send be marked STUCK.

#### Index management: `db sync-indexes`

**What**: `node dist/main.cli.js db sync-indexes [--dry-run]` compares every collection's indexes with the schemas ([all-schemas.ts](src/database/all-schemas.ts)), creates the missing ones and drops the obsolete ones.

**Why**: Mongoose's `autoIndex` is off in production (several replicas building and dropping indexes at boot is a known way to cause an outage). Nothing else created them, and some carry guarantees: the unique `{tenantId, dedupKey}` and `{batchId, ref}`. Run it once per release, before rolling out (a Kubernetes Job).

#### Endpoints

| Endpoint                                         | What                                                                                           |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `GET /v1/batches`                                | Newest first; `status`, `reference`, `subTenant`, `mailbox`, `createdFrom`/`createdBefore`     |
| `GET /v1/batches/{id}`                           | State, counters (sum to `total`), rejected rows, warnings, timestamps                          |
| `GET /v1/batches/{id}/summary?groupBy=subTenant` | Counters per subTenant, the null group last                                                    |
| `GET /v1/batches/{id}/messages`                  | In the client's row order; same filters as the search                                          |
| `POST /v1/batches/{id}/cancel`                   | PENDING/RETRY_SCHEDULED → CANCELLED; SENDING untouched; idempotent                             |
| `GET /v1/messages`                               | Across batches, newest first; `status`, `ref`, `to`, `subject`, `subTenant`, `batchId`, dates  |
| `GET /v1/messages/{id}`                          | Detail: attempts (SMTP code and reply), operator actions, timeline, attachment and EML digests |
| `GET /v1/messages/{id}/rendered`                 | Subject and HTML as rendered for this recipient                                                |
| `GET /v1/messages/{id}/eml`                      | The exact bytes transmitted, with `Repr-Digest`; `409` before anything was transmitted         |

Multi-value filters: `status` and `subTenant` comma-separated (or repeated); `ref`, `to` and `batchId` repeated only, never split on commas. Dates: `createdFrom` inclusive, `createdBefore` exclusive (`to` is the recipient, so it is not a date name). `to` is exact but case-insensitive.

See [docs/en/adr/0004-read-side.md](docs/en/adr/0004-read-side.md) for the reasoning.

---

### Stage 5 — Receipts, settlement and webhooks (2026-09-19)

No new library: two that were already installed take on a new job, and one moves from the tests to production.

#### mailparser — now a runtime dependency

**What**: `mailparser` (by the nodemailer author, MIT) turns a raw mail into headers and parts. Until stage 4 it was a dev dependency used only by the tests; now [receipt-parser.ts](src/modules/receipts/receipt-parser.ts) uses it to read every receipt, so it moved to `dependencies` (the Docker image installs with `npm ci --omit=dev`: left in dev, the worker would have crashed in production at the first receipt).

**Why this and not by hand**: a PEC receipt is `multipart/signed` around a `multipart/mixed` with the text and `daticert.xml`, in base64 or quoted-printable, sometimes with encoded headers. MIME parsing by hand is where security bugs live; mailparser has been handling it for over a decade.

#### htmlparser2 in `xmlMode` — for daticert.xml

**What**: the same `htmlparser2` of the HTML policy (stage 2), with `xmlMode: true`, reads `daticert.xml` ([daticert.ts](src/modules/receipts/daticert.ts)): receipt type, error, provider, date and zone, the `msgid` of our message, the delivery address.

**Why**: it is not a validating parser and never expands the entities of a DTD. XXE (an entity pointing at `file:///etc/passwd`) and "billion laughs" (entities that multiply) are impossible by construction; a test feeds it a hostile DOCTYPE. A full XML library would have been one more dependency to configure safely.

#### Which mails count as receipts

1. **Top-level `X-Ricevuta` only**. The provider writes it on the receipts it issues. A mail with `X-Trasporto` is a PEC _transport envelope_ (someone else's PEC) or an anomaly: ignored, even if it contains something that looks like a receipt, because the envelope vouches for the sender, not for what the sender put inside.
2. Matched by `X-Riferimento-Message-ID`, falling back to the daticert `<msgid>`; the Message-ID we generate is unique per message.
3. The original mail and its daticert are saved under `batches/<tenant>/<batch>/receipts/<receiptId>.eml|.daticert.xml` with their SHA-256; a receipt is stored once (`{mailbox, dedupKey}` unique).
4. The provider's S/MIME signature is kept, not verified (see the ADR).

| `X-Ricevuta`                                               | Receipt type                                 | Effect on the message                                        |
| ---------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `accettazione`                                             | ACCEPTANCE                                   | → ACCEPTED (also from STUCK, RETRY_SCHEDULED, FAILED)        |
| `avvenuta-consegna`                                        | DELIVERY                                     | → DELIVERED, settled                                         |
| `errore-consegna`, `rilevazione-virus`, `non-accettazione` | NON_DELIVERY, VIRUS_DETECTED, NON_ACCEPTANCE | → NOT_DELIVERED with `deliveryError {code, detail}`, settled |
| `presa-in-carico`, `preavviso-errore-consegna`             | TAKING_CHARGE, NON_DELIVERY_WARNING          | stored, no state change                                      |

States only move forward: a late acceptance after the delivery only fills `acceptedAt`.

**How the folder is read** ([receipt-reader.ts](src/modules/receipts/receipt-reader.ts)):

- One mail at a time: the next is fetched only when the previous one is stored. A complete delivery receipt carries the whole original message, attachments included, so a pass never holds more than one mail in memory.
- The two header lines `X-Ricevuta` and `X-Trasporto` are fetched first; the body is downloaded only when they say the mail may be a receipt. An ordinary PEC with large attachments is never downloaded.
- The first read of a folder (and a read after its UIDVALIDITY changed) starts from the mails received in the last `settleAfterHours` + 24 hours, not from the first mail of a mailbox used for years.
- A mail that fails three passes in a row is skipped with an `error` in the log (`mail skipped after repeated failures`), so it cannot hold back every receipt after it.
- A mailbox suspended because a login was refused is not read (another refused login could get the account locked). A mailbox paused by an operator is still read: reading changes nothing and keeps the outcomes coming.
- A receipt found already stored is applied again: a crash between storing a receipt and moving its message cannot leave the message behind.

#### Settlement: when a batch is over

Each message has `settlement`: `PENDING` until a final receipt (`SETTLED`), or `TIMED_OUT` when no final receipt came within `receipts.settleAfterHours` (30 h) of sending. FAILED and CANCELLED messages are settled at once. A batch is `SENT` when no message is open and `SETTLED` when no message is `PENDING`; the batch detail shows `settlement {pending, settled, timedOut}` next to the counters, and `settledAt`.

`SettlementJob` runs every minute: it times out the overdue messages, and closes the batches that a crash left open (the message was updated, the batch check did not run).

A batch's closing is final. A receipt that arrives afterwards (an acceptance for a message an operator had marked FAILED, a delivery after the timeout) still updates the message and therefore the counters, but does not reopen the batch or send a second `batch.settled`.

#### Transactional outbox

**What**: an event is a document in `webhook_events`, written **in the same MongoDB transaction** as the change it reports ([batch-lifecycle.ts](src/modules/batches/batch-lifecycle.ts), [mailbox-state.store.ts](src/modules/mailboxes/mailbox-state.store.ts)). The `WebhookDispatcher` in the worker delivers them later.

**Why**: calling the client from inside the transaction is wrong both ways: a crash after the commit loses the notification, a rollback after the call notifies something that did not happen. With the outbox, "the batch is SETTLED" and "the client will be told" are one write. `{tenantId, dedupKey}` is unique, so recording the same fact twice produces one event.

#### Webhooks for clients

Configured per tenant (`tenants[].webhook.url`, `secretEnv`). One `POST` per event, JSON body:

```json
{
  "eventId": "ev_o2AJyGhrU6JGwZOj",
  "type": "batch.settled",
  "occurredAt": "2026-09-19T08:23:32.818Z",
  "data": {
    "batchId": "b_y7GDd5g2eEeugsOj",
    "mailbox": "serfin-aruba",
    "reference": "solleciti-settembre",
    "counters": { "total": 3, "accepted": 1, "delivered": 1, "notDelivered": 1, "...": 0 },
    "settlement": { "pending": 0, "settled": 2, "timedOut": 1 }
  }
}
```

| Event               | When                                                         | `data`                                                     |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `batch.sent`        | No message of the batch is still to be sent                  | `batchId`, `mailbox`, `reference`, `subTenant`, `counters` |
| `batch.settled`     | Every message has its final outcome or timed out             | the same, plus `settlement`                                |
| `mailbox.suspended` | A mailbox stops (login refused by SMTP or IMAP, or operator) | `mailbox`, `cause`, `suspendedAt`                          |

No recipient, subject or body ever travels in a webhook: the details are read from the API.

| Header                         | Content                                                                            |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `X-PecMailer-Event`            | the event type                                                                     |
| `X-PecMailer-Event-Id`         | the id to deduplicate on: the same across retries                                  |
| `X-PecMailer-Timestamp`        | Unix seconds of this attempt                                                       |
| `X-PecMailer-Signature`        | `sha256=` + hex HMAC-SHA256 of `"<timestamp>.<raw body>"` with the tenant's secret |
| `X-PecMailer-Delivery-Attempt` | 1, 2, 3…                                                                           |

**Delivery**: any `2xx` is success; anything else, a timeout or a network error is retried after `30s, 2m, 10m, 30m, 1h, 2h, 2h…` until `retryForHours` (24 h) from the event, then `FAILED`. At least once: the receiver must deduplicate on `X-PecMailer-Event-Id`. Redirects are not followed. `webhooks.timeoutSeconds` bounds the whole exchange up to the status line; the response body is never read.

**Order**: events are delivered one by one but not necessarily in order: a `batch.sent` that is being retried can arrive after the `batch.settled` of the same batch. Order by `occurredAt`, and treat `batch.settled` as final.

**Secret**: at least 32 characters (`openssl rand -hex 32`), or the service does not start. Anyone holding one signed notification can try secrets offline; a short one would fall.

**Verifying on the receiving side (PHP)**: verify on the raw body, before decoding it.

```php
<?php
$secret    = getenv('PECMAILER_WEBHOOK_SECRET');
$body      = file_get_contents('php://input');
$timestamp = $_SERVER['HTTP_X_PECMAILER_TIMESTAMP'] ?? '';
$signature = $_SERVER['HTTP_X_PECMAILER_SIGNATURE'] ?? '';

$expected = 'sha256=' . hash_hmac('sha256', $timestamp . '.' . $body, $secret);
if (!ctype_digit($timestamp) || abs(time() - (int) $timestamp) > 300
    || !hash_equals($expected, $signature)) {
    http_response_code(401);
    exit;
}

$event = json_decode($body, true, 512, JSON_THROW_ON_ERROR);
// Already processed? Look up $event['eventId'] and answer 200 without doing it again.
http_response_code(204);
```

`hash_equals` compares in constant time; the 5-minute window stops a captured notification from being replayed.

#### Anti-SSRF

The dispatcher never connects to a private or reserved address: loopback, RFC 1918, link-local (`169.254.169.254` is the cloud metadata service), CGNAT, ULA, multicast. An IPv4 address carried inside IPv6 is judged as the IPv4 address it is, however it is written: IPv4-mapped (`::ffff:10.0.0.1`, which a URL parser rewrites as `::ffff:a00:1`) and NAT64 (`64:ff9b::a00:1`, how an IPv6-only cluster reaches IPv4 hosts). The check runs on the **address the name resolves to**, inside the socket's own `lookup` ([address-guard.ts](src/modules/webhooks/address-guard.ts)), so a DNS record pointing at `127.0.0.1` does not get through and there is no window between check and connect. HTTPS only. A client whose receiver sits inside the VPN sets `webhook.allowPrivateNetwork: true` for that tenant only.

#### Collections added

| Collection                    | Key facts                                                                                                                                             |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `receipts`                    | one per receipt: type, message, provider, recipient, error, issue date, paths and SHA-256 of `.eml` and `.daticert.xml`; unique `{mailbox, dedupKey}` |
| `imap_cursors`                | `_id` = `<mailbox>:<folder>`, `uidValidity`, `lastUid`                                                                                                |
| `webhook_events`              | the outbox: `status` (PENDING, DELIVERING, DELIVERED, FAILED), `attempts`, `nextAttemptAt`, `giveUpAt`, `lastStatusCode`, `lastError`                 |
| `messages` (new fields)       | `acceptedAt`, `deliveredAt`, `notDeliveredAt`, `deliveryError`, `settledAt`; indexes `{batchId, settlement}`, `{settlement, sentAt}`                  |
| `batches` (new field)         | `settledAt`                                                                                                                                           |
| `mailbox_states` (new fields) | `cause` (SMTP_AUTH_REFUSED, IMAP_AUTH_REFUSED, OPERATOR), `changedAt`                                                                                 |

#### Endpoints

| Endpoint                         | What                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/messages/{id}`          | now with `receipts[]`, `deliveryError`, `settlement` and the timeline `acceptedAt`, `deliveredAt`, `notDeliveredAt`, `settledAt` |
| `GET /v1/messages/{id}/receipts` | the receipts of a message, oldest first                                                                                          |
| `GET /v1/receipts/{id}/eml`      | the receipt exactly as the provider sent it (the legal proof), with `Repr-Digest`                                                |
| `GET /v1/receipts/{id}/daticert` | its `daticert.xml`, with `Repr-Digest`                                                                                           |
| `GET /v1/batches/{id}`           | now with `settlement {pending, settled, timedOut}` and `settledAt`                                                               |
| `GET /v1/mailboxes`              | now with `suspendedAt` and `suspensionCause`                                                                                     |

#### Operations

| Situation                                             | What to do                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `webhook list` shows events with `last error`         | The client's endpoint is down or refuses: retries continue on their own for 24 h.                                                                                                                       |
| `webhook list --status FAILED`                        | Retries are over. Once the client's side works: `webhook retry <eventId>` starts a new 24 h window.                                                                                                     |
| A mailbox is SUSPENDED with cause `IMAP_AUTH_REFUSED` | Same password as SMTP: fix it, `mailbox probe <code>`, `mailbox activate <code>`.                                                                                                                       |
| A batch stays `SENT` for more than a day              | Normal until `settleAfterHours` has passed since its last message was sent; then the settlement job closes it.                                                                                          |
| Worker `/health/live` is 503                          | A loop has been stuck on an await for 5 minutes (a loop sleeping on purpose counts as alive until its planned wake-up): restart the worker.                                                             |
| Log line `mail skipped after repeated failures`       | A mail of the receipts folder could not be processed three times (`uid` in the log). If it is a receipt, its outcome is missing: look it up in the mailbox and, if needed, resolve the message by hand. |

See [docs/en/adr/0005-receipts-webhooks.md](docs/en/adr/0005-receipts-webhooks.md) for the reasoning.

#### Collaudo on a real Aruba mailbox (2026-09-19)

A batch of two messages from a real Aruba PEC mailbox: one to the sender itself with a PDF, one to an address that does not exist on `pec.it`.

| Step                                  | Result                                                                                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SMTP and IMAP login (`mailbox probe`) | ok                                                                                                                                                                                  |
| First read of the INBOX               | only the last 54 hours; 5 receipts of the owner's own PECs recognised and left alone, 4 other mails judged by their headers and never downloaded                                    |
| Send                                  | both accepted by Aruba (`250 Ok: queued`); a copy of each in `INBOX.Inviata`                                                                                                        |
| Receipts                              | read within 30 seconds: acceptance and delivery of message 1, acceptance and non-delivery of message 2; the copy of message 1 that reached the inbox (a transport envelope) ignored |
| Batch                                 | `SETTLED` 27 seconds after sending                                                                                                                                                  |

What the real receipts taught, now covered by tests on anonymised copies ([test/fixtures/receipts/aruba](test/fixtures/receipts/aruba/README.md)):

- Aruba reports a mailbox that does not exist with `errore="altro"` and the reason in `errore-esteso` (`5.1.1 - ARUBA PEC S.p.A. - indirizzo non valido`). Clients must read `deliveryError.detail`, not only the code.
- The transport envelope carries `X-Riferimento-Message-ID` with our Message-ID: the `X-Trasporto` check is what keeps it from being taken for a receipt.
- The daticert time has one-second precision: a receipt no longer overwrites the send time the worker recorded.

Still to do before production: the same collaudo on Legalmail (login with the account code, SMTP on port 25 with STARTTLS, Sent folder `INBOX/Spedite`).

#### Review of stages 4 and 5 (2026-09-19)

Found by reading the code again after stage 5, fixed and covered by tests:

| Finding                                                                                             | Risk                                                                                              | Fix                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| The receipt reader loaded up to 200 whole mails before processing them                              | Out of memory with complete delivery receipts of messages with attachments                        | One mail at a time; headers first, body only for possible receipts |
| The first read of a folder started from its first mail                                              | A mailbox used for years downloaded entirely, new receipts waiting behind it                      | Start from the settlement window                                   |
| A mail failing every time held the cursor                                                           | Every later receipt of the mailbox stopped; batches timed out silently                            | Skipped after three failures, with an error in the log             |
| A receipt already stored was not applied again                                                      | A crash between the two writes left the message without its outcome                               | Applied again (idempotent)                                         |
| A receipt could not move a PENDING message                                                          | A STUCK message requeued by an operator was sent twice even when its acceptance was already there | PENDING is movable (its Message-ID exists only after an attempt)   |
| An operator's suspension also stopped reading                                                       | Outcomes sitting in the mailbox timed out                                                         | Reading stops only after a refused login                           |
| The webhook timeout covered socket idleness only, and the body was read to the end                  | An endpoint dripping its answer blocked every tenant's notifications                              | One deadline for the whole exchange; body never read               |
| `::ffff:a00:1` (the URL form of `::ffff:10.0.0.1`) and NAT64 addresses passed the SSRF check        | A webhook URL could reach the internal network                                                    | IPv4 carried in IPv6 is extracted and judged as IPv4               |
| A dispatcher whose delivery outlived its lock could overwrite the outcome of the one that took over | A delivered event marked for retry, or the reverse                                                | The claim's lock time is a fencing token                           |
| The outbox swallowed a duplicate-key error inside a transaction                                     | That error aborts the transaction: the state change would have been lost                          | Upsert on the dedup key                                            |
| Webhook secrets of any length were accepted                                                         | A short HMAC secret can be found from one signed notification                                     | At least 32 characters, checked at boot                            |
| A cancel on a finished batch set `cancelRequestedAt`                                                | A misleading field                                                                                | Only on an open batch                                              |
| No index for the settlement job's scan of open batches                                              | A collection scan every minute                                                                    | `{status, updatedAt}`                                              |

---
