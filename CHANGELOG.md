# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- A getting-started guide for a machine that never ran the project, in English and Italian (prerequisites, first test PEC, automated tests, what to do when something does not start); every command in it was run on a fresh clone.
- `CLAUDE.md`: what an AI assistant must know before working in this repository (what must never break, the commands, the layout, the conventions and the traps).
- A unit test of the real SMTP client against a real SMTP dialogue (smtp-server in the test process): a connection cut after the server took the message is `stuck`, a refused login suspends, 5xx fails, 4xx retries. Its test server had been left unused since the move to queues.

### Removed

- Leftovers of the HTTP/MongoDB version in `.gitignore` and `.dockerignore` (configuration file, storage folder, openapi.json).

### Changed

- ADR 0001 to 0005 marked as superseded by ADR 0006; kept as the record of the first design.
- Documentation brought up to 0.6.1: README (status, provider presets, collaudo on a real mailbox), SECURITY.md (recipient checks, redelivery, secrets on a developer's machine), ADR 0006 (amendments of 0.6.1), the guides (who creates the queues, what ends up in `.dead`).

## [0.6.1] - 2026-09-19

Review of stage 6. Two changes need action where the service already runs: the provider `infocert` is now `namirial`, and the input queues must be recreated (their arguments changed).

### Fixed

- Shutdown: the container stops taking PECs as soon as it is asked to stop. Before, it kept taking them while the receipt reader finished its pass, put them back at the end of the queue, and one could come back marked "delivered before": after the restart, a five-minute wait and a false `uncertain` for a PEC never sent.
- A PEC delivered again after an interruption is no longer judged on its recipient: a DNS lookup failing at that moment turned a PEC that may have left into `rejected`, and the CRM would have sent it again. Only the rules of the message itself and the provider's receipt decide.
- A refused IMAP login during the copy in the Sent folder suspends the mailbox at once, instead of one refused login per PEC until the receipt reader noticed.
- A failed handling is given back without the 10-second pause once the container is stopping.
- The `infocert` preset pointed at Namirial's domain with wrong server names: it is replaced by `namirial` (smtps/imaps.sicurezzapostale.it, as Namirial publishes them; the Sent folder must be set with `PECMAILER_IMAP_SENT_FOLDER`).

### Changed

- Legalmail preset: SMTP on port 465 with TLS, as InfoCert publishes it (was 25 with STARTTLS, often blocked on the way out of cloud networks). To be confirmed by the Legalmail collaudo.
- Input queue: dead-lettering at least once (`x-dead-letter-strategy: at-least-once`, which requires `x-overflow: reject-publish`): a message leaves the input queue only once the dead-letter queue has stored it. An existing input queue must be deleted (empty) and declared again.
- `PECMAILER_RECEIPTS_LOOKBACK_HOURS` defaults to 24 (was 72): a restart during a campaign re-published every receipt of three days, delivery receipts with their attachments included.
- `PECMAILER_RETRY_BACKOFF_SECONDS` is checked with one SMTP timeout per attempt added to the waits: the defaults fit exactly (25 minutes); a longer timeout needs shorter waits.
- Guides: `RETRIES_EXHAUSTED` comes about 21 minutes after the first attempt with the defaults (they said 30); a new rule on the rare PEC with two different outcomes.

## [0.6.0] - 2026-09-19

Stage 6: from an HTTP API with a database to queues. Breaking: the HTTP API, API keys, webhooks and the configuration file are gone; the service is driven by RabbitMQ (see docs/asyncapi.yaml). Verified on a real Aruba mailbox: sending, the Sent copy, acceptance, delivery and non-delivery receipts, and the same receipt events after a restart.

### Changed

- One container per tenant and mailbox, configured by environment variables only; no configuration file.
- RabbitMQ is the input and the output: three quorum queues per container (`.in`, `.out`, `.dead`), declared at start-up or checked when the infrastructure owns them.
- Logs: JSON lines on standard output with tenant and mailbox, level names instead of numbers.
- Docker image: one entry point (`dist/main.js`), probes on port 3001, no volume.

### Added

- The queue contract: `docs/asyncapi.yaml` and the guides `docs/it/messaggi.md`, `docs/en/messages.md`, with PHP examples.
- CLI: `config check`, `probe`, and for development `publish` and `outcomes`, with `npm run local:publish` / `local:outcomes` and `examples/`.
- Integration tests against a real RabbitMQ.
- Sending (phase 3): each PEC of the input queue is checked (format, HTML rules, inline images, attachment types, PEC recipient, size), sent at the mailbox's pace, retried on temporary errors within 25 minutes, copied to the Sent folder, and reported as `sent`, `rejected`, `failed` or `uncertain`; an unreadable message goes to the dead-letter queue.
- A PEC delivered again after an interruption is never resent: its receipt is looked for in the mailbox (IMAP search on `X-Riferimento-Message-ID`); found = `sent` confirmed by the receipt, not found = `uncertain`.
- A refused SMTP or IMAP login suspends the mailbox: `mailbox.suspended` is published, the PEC in hand goes back to the queue as a new message, nothing else is taken until a restart; readiness turns false.
- `PECMAILER_REDELIVERY_WAIT_SECONDS` (300): how long a redelivered PEC's receipt is looked for.
- Receipts (phase 4): the receipts folder is read every `PECMAILER_RECEIPTS_POLL_SECONDS` (read-only, headers first, one mail at a time); every receipt of a PEC of ours (Message-ID `<pm.{id}@...>`) is published whole as a `receipt` event: type, final or not, issue date, provider, recipient, error, the original `.eml` and `daticert.xml` in base64, SHA-256. Envelopes, ordinary mail and receipts of other messages are left out.
- No cursor is kept: at every start the last `PECMAILER_RECEIPTS_LOOKBACK_HOURS` (72) are read again, and the events come out again with the same `eventId`.
- A receipt that cannot be published is read again at every pass until it is; a mail that cannot be read three times in a row is skipped with an error in the log.
- The mailbox suspension is shared by sender and reader: a refused IMAP login stops sending too, and the other way round.

### Removed

- The HTTP API (batches, searches, downloads, Swagger), API keys, webhooks, MongoDB and everything stored in it, the multi-tenant YAML configuration, templates and placeholders, NestJS.

## [0.5.1] - 2026-09-19

Review of stages 4 and 5.

### Changed

- Webhook signing secrets must be at least 32 characters (`openssl rand -hex 32`); a shorter one stops the boot with a message naming the variable.
- The receipt reader fetches the `X-Ricevuta` and `X-Trasporto` headers first and downloads a mail only when it may be a receipt, one mail at a time.
- The first read of a receipts folder (or a read after a UIDVALIDITY change) starts from the last `settleAfterHours` + 24 hours.
- An operator's suspension stops sending only; receipts are still read. A refused login still stops both.

### Fixed

- The receipt reader could run out of memory: up to 200 whole mails were held before processing.
- A mail that failed every time blocked every later receipt of its mailbox; it is now skipped after three failures, with an error in the log.
- A crash between storing a receipt and moving its message left the message without its outcome; a stored receipt is now applied again.
- A STUCK message requeued by an operator was sent again even when its acceptance had already arrived.
- A webhook endpoint answering slowly, or dripping its response, blocked all notifications; one deadline now covers the whole exchange.
- IPv4-mapped addresses in their hexadecimal form (`::ffff:a00:1`) and NAT64 addresses passed the anti-SSRF check.
- A dispatcher whose delivery outlived its lock could overwrite the outcome recorded by the dispatcher that took the event over.
- The outbox ignored a duplicate-key error inside a transaction, which aborts the transaction.
- A cancel on a finished batch set `cancelRequestedAt`.
- The settlement job scanned the batches without an index (new index `{status, updatedAt}`: run `db sync-indexes`).
- A receipt no longer moves back the send time of a message the worker sent: the daticert time has one-second precision. Only a message without one (STUCK, requeued) takes it from the receipt.
- Mongoose 9 logged a deprecation warning on every state change (`new` option of `findOneAndUpdate`, now `returnDocument`).

### Added

- First collaudo on a real Aruba PEC mailbox: send, Sent copy, acceptance, delivery, non-delivery and batch settlement verified end to end.
- Real Aruba receipts and a real transport envelope, anonymised, as test fixtures (`test/fixtures/receipts/aruba`), with their tests.
- `.gitattributes`: fixture `.eml` files are kept byte for byte.

## [0.5.0] - 2026-09-19

Stage 5: receipts, settlement and webhooks.

### Added

- Receipt reader in the worker: one per mailbox with IMAP, under its own lease; reads the receipts folder read-only (EXAMINE, BODY.PEEK) from a UID cursor (`imap_cursors`, reset on UIDVALIDITY change); config `receipts` (`pollIntervalSeconds`, `maxPerPoll`, `settleAfterHours`) and `mailboxes[].imap.receiptsFolder`.
- Receipts trusted only by the top-level `X-Ricevuta` header (transport envelopes ignored), matched by `X-Riferimento-Message-ID` or the daticert `msgid`, stored once with the original mail and `daticert.xml` and their SHA-256.
- Message states ACCEPTED, DELIVERED, NOT_DELIVERED (with `deliveryError`), forward-only; an acceptance also resolves a STUCK, RETRY_SCHEDULED or FAILED message.
- Settlement: per message `PENDING` → `SETTLED` or `TIMED_OUT` after 30 h; batch `SETTLED` with `settledAt` and `settlement {pending, settled, timedOut}`; a job reconciles batches a crash left open.
- Webhooks `batch.sent`, `batch.settled`, `mailbox.suspended` through a transactional outbox (`webhook_events`): HMAC-SHA256 signature over timestamp and body, stable event id, retries with backoff for 24 h then FAILED; config `webhooks`, `tenants[].webhook.allowPrivateNetwork`.
- Anti-SSRF for webhooks: HTTPS only, no redirects, private and reserved addresses refused after DNS resolution.
- `GET /v1/messages/{id}/receipts`, `GET /v1/receipts/{id}/eml`, `GET /v1/receipts/{id}/daticert` (with `Repr-Digest`); message detail with `receipts[]`, `deliveryError`, `settlement` and the receipt timeline; mailbox list with `suspendedAt` and `suspensionCause`.
- CLI `webhook list [--status]` and `webhook retry <eventId>`.
- First integration test: the IMAP receipt reader against Greenmail (`npm run test:integration`).

### Changed

- `mailparser` is a runtime dependency (it parses the receipts).
- A mailbox suspension records its cause (SMTP_AUTH_REFUSED, IMAP_AUTH_REFUSED, OPERATOR) and emits `mailbox.suspended` once per suspension.
- FAILED and CANCELLED messages are settled at once, so a batch with failures can reach SETTLED.
- Worker liveness: a loop sleeping on purpose counts as alive until its planned wake-up.

### Fixed

- The worker liveness probe would have reported a stalled worker, and got the container restarted, whenever a loop's sleep (a receipt poll interval, a suspended-mailbox recheck) was 5 minutes or longer.

## [0.4.0] - 2026-09-19

Stage 4: read side and cancellation.

### Added

- `GET /v1/batches` (newest first; filters status, reference, subTenant, mailbox, created range), `GET /v1/batches/{id}` (state, counters per status, rejected rows), `GET /v1/batches/{id}/summary?groupBy=subTenant`, `GET /v1/batches/{id}/messages` (the client's row order), `POST /v1/batches/{id}/cancel` (idempotent; PENDING and RETRY_SCHEDULED only).
- `GET /v1/messages` (search across batches; filters status, ref, to case-insensitive, subject contains, subTenant, batchId, created range), `GET /v1/messages/{id}` (every attempt with SMTP code and reply, operator actions, timeline, attachment and EML digests), `/rendered`, `/eml` (`message/rfc822` with `Repr-Digest`, RFC 9530).
- Keyset pagination with opaque cursors bound to their list (`400 INVALID_CURSOR` otherwise); page size 1-500, default 100.
- `db sync-indexes [--dry-run]` admin command.
- Tenant isolation e2e suite: every id-taking endpoint called as the wrong tenant answers like a missing id.
- Messages store `position`, `toLower`, `heartbeatAt`, `emlSha256`/`emlSize`, `attemptLog`, `operatorLog`, `cancelledAt`; batches `messageCount`, `cancelRequestedAt`, `cancelledAt`.

### Changed

- Batch counters are derived from the messages instead of stored; a batch is closed (SENT, or CANCELLED when nothing left) from the actual message states.
- Messages leave in the client's row order.

### Fixed (review of stage 3)

- The mailbox lease is renewed by a heartbeat timer: a long paced wait or a large upload can no longer let a second worker send through the same mailbox.
- Stale recovery looks at the in-flight message's heartbeat: a slow but live send is no longer marked STUCK.
- Stored batch counters could drift after a crash between two writes and leave a batch SENDING forever (replaced by derived counters).
- Production never created indexes (autoIndex off, the referenced migrate command did not exist): the unique `dedupKey` and `{batchId, ref}` guarantees were missing. Now `db sync-indexes`.
- The queue sort was not covered by an index (in-memory sort on every claim).
- Resolving a STUCK message overwrote `lastError`; decisions now go to `operatorLog`.
- The CLI forced pretty logs, which need a dev dependency absent from the image: every database command failed silently inside the container. Pretty logs are also ignored in production for the API and the worker, and CLI boot errors are reported.

## [0.3.0] - 2026-09-19

Stage 3: sending worker.

### Added

- Worker loop per mailbox, guarded by a MongoDB lease (`mailbox_leases`): one sender per mailbox whatever the replica count; leases renewed, released on shutdown, taken over when expired.
- Pacing per mailbox (`perMinute`, `perDay`) with counters in MongoDB (`mailbox_counters`) that survive restarts.
- Message state machine: PENDING/RETRY_SCHEDULED → SENDING → SENT | RETRY_SCHEDULED | FAILED | STUCK; every transition atomic and state-conditioned; batch counters and `SENT` settlement (no pending, no stuck).
- EML built with nodemailer's MailComposer, written under `batches/<tenant>/<batch>/eml/` and sent as raw bytes; deterministic `Message-ID` `<message id>@<sender domain>`; `X-PecMailer-*` headers.
- SMTP outcome classification with a protocol observer (server `354` seen): login refused → mailbox SUSPENDED and message kept PENDING; 4xx → retry with backoff (`sending.retryBackoffSeconds`, `maxAttempts`); 5xx on envelope/data → FAILED; connection lost after the data was taken → STUCK.
- Stale recovery job: SENDING longer than `sending.staleSendingSeconds` → STUCK.
- Sent-folder copy over IMAP (imapflow) after each send, recorded as `sentCopy` on the message.
- Worker health probes on `WORKER_HEALTH_PORT` (`/health/live`, `/health/ready`); docker-compose healthcheck for the worker.
- Admin commands: `mailbox list|probe|activate|suspend`, `message stuck`, `message resolve <id> --as sent|requeue|failed`.
- Config: optional `sending` section; env `WORKER_HEALTH_PORT`, `WORKER_ID`.
- Tests: worker e2e against an in-process SMTP server (`smtp-server`) covering every outcome; unit tests for outcome classification, pacing and EML building (`mailparser`).

### Changed

- Code review of stages 1–2: placeholder position check is now a markup scanner (no false positive on `= {{x}}` in text); a stray `}}` is no longer an error; a batch already written never loses its idempotency record; the rest of a refused multipart upload is drained so the client receives the 4xx; attachment hashing through a Transform; `@types/nodemailer` removed (nodemailer 10 ships its types); `dist/tools` left out of the runtime image.

## [0.2.0] - 2026-09-19

Stage 2: batch intake.

### Added

- `POST /v1/batches`: one multipart call (JSON part + file parts) submits a template, a mailbox and up to 2,500 recipients; `202` with the `ref -> messageId` map and per-row rejections, `200` preview with `options.dryRun`, `options.atomic` to refuse everything on one bad row.
- Template rules: closed allowlist of HTML elements/attributes (reject, never sanitise), `{{name}}` escaped and `{{{name}}}` raw placeholders, inline images by `cid:` only, no remote resources, placeholder position checks (no tag names, unquoted attributes, `<style>`, comments).
- Recipient verification: PEC provider domains and MX lookups against accredited providers; `NOT_PEC` rejected per row, `UNDETERMINED` rejected unless `options.unverifiedRecipients = "send"`; lists extensible from the config file (`recipients`).
- Attachments streamed to disk while hashed; type detected from content with an extension allowlist; executables refused; per-message encoded size checked against the mailbox limit.
- `Idempotency-Key` (mandatory): same key + same content replays the original answer, different content is `409`, concurrent use is `409`, a failed attempt can be retried.
- `dedupKey` per message, unique per tenant across batches.
- MongoDB collections `batches`, `messages` (rendered, PENDING), `idempotency_keys`, `mailbox_states`; batch and messages written in one transaction.
- Per-tenant request rate limit (`429` + `Retry-After`); `423` when the mailbox is suspended; `GET /v1/mailboxes` reports the real state.
- E2E tests against an in-memory MongoDB replica set (`mongodb-memory-server`); `openapi:export` no longer needs a running database.

### Changed

- Field error paths use `messages[3].to` notation.
- `ApiModule` always needs a database (the no-database mode was removed).

## [0.1.0] - 2026-09-18

Stage 1: project foundation.

### Added

- Single Docker image with three entry points: `api`, `worker`, `cli`.
- Environment and configuration file validated at boot (Zod); provider presets for Aruba, Legalmail, InfoCert.
- API key authentication resolving the tenant; `GET /v1/mailboxes`.
- RFC 9457 error responses, request ids, structured logging with redaction.
- Health probes (`/health/live`, `/health/ready`), Swagger UI on `/docs`, OpenAPI export.
- Local stack: MongoDB replica set, Greenmail fake PEC provider.
- Admin commands: `api-key generate`, `config check`.
