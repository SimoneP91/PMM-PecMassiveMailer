# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
