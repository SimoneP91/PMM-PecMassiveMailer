# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
