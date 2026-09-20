# pecmailer — notes for an AI assistant

Read this before touching the project. First run on a new machine: [docs/en/getting-started.md](docs/en/getting-started.md) ([Italian](docs/it/avvio.md)).

## What this is

A service that sends PEC (Italian certified e-mail) for client applications. One container serves one tenant and one of its mailboxes: it takes PECs from a RabbitMQ input queue, sends them through the provider (SMTP), files a copy in the Sent folder and reads the receipts (IMAP), and publishes on an output queue what happened. **It stores nothing**: no database, no files, no state between restarts. Version 0.6.1; versions up to 0.5.1 were an HTTP API with MongoDB and are history.

## What must never break

1. **A PEC must never be sent twice.** A message delivered again by the queue may already have been sent: the container looks for the provider's receipt in the mailbox and reports `uncertain` when it cannot tell. Never "just resend".
2. **An outcome must never be lost.** The input message is acknowledged only after its outcome is confirmed by RabbitMQ; every event carries a stable `eventId`, so a repeated event is recognisable.
3. **No secrets and no personal data in logs or in the repository.** Passwords come from the environment, wrapped in `Secret`; logs carry ids, codes and counts only — never a recipient, a subject, a body or an attachment.
4. **The client's mailbox is read-only** except for the copy in the Sent folder.
5. **A refused login suspends the mailbox** instead of retrying: repeated refusals get the account locked.

## Commands

| Command                                                                                  | What it does                                                            |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `npm run check`                                                                          | Types, lint, formatting, unit tests (157). Run before handing work over |
| `npm test`                                                                               | Unit tests only                                                         |
| `docker compose -f docker-compose.test.yml up -d --wait` then `npm run test:integration` | 20 tests against a real RabbitMQ and Greenmail                          |
| `npm run build`                                                                          | Compiles to `dist/` (needed by the `local:*` commands)                  |
| `docker compose up -d --build --wait`                                                    | The local stack: RabbitMQ, Greenmail, two containers                    |
| `npm run local:publish -- examples/pec.json`                                             | Puts a PEC in the input queue (plays the CRM)                           |
| `npm run local:outcomes -- --follow`                                                     | Reads the output queue                                                  |
| `docker compose exec serfin-aruba node dist/main.cli.js config check`                    | The configuration of a running container, no secrets                    |

## Layout

```
src/main.ts              the container; main.cli.ts the commands
src/app/container.ts     everything wired by hand: start here to see the whole flow
src/queue/               the Queues interface; rabbit-queues.ts is the only file that knows RabbitMQ
src/config/              environment schema (zod), provider presets
src/modules/sending/     checks, MIME, SMTP, Sent copy, pace, outcome events, suspension
src/modules/receipts/    receipt reader, parser, daticert, the receipt search of a redelivered PEC
src/modules/recipients/  is this address a PEC address
src/modules/templates/   the HTML rules; modules/attachments/ the attachment types
test/unit  test/integration  test/helpers  test/fixtures (real Aruba receipts, anonymised)
docs/      asyncapi.yaml (the contract), guides and ADRs in en/ and it/
```

## Conventions

- TypeScript strict, no `any` (ESLint `strict-type-checked`). Prettier decides formatting; LF line endings, enforced by `.gitattributes`.
- Code, comments and repository documentation in English. The guides and ADRs exist in English and Italian: change both.
- Every behaviour change needs a test. Notable changes go in `CHANGELOG.md`; the reasoning goes in `documentation.md`, and a decision that shapes the design gets an ADR in `docs/*/adr/`.
- **Commits are made by a person.** Do the work, then hand over a summary and a suggested commit message; do not run `git commit`, `git push` or `git add`.
- Never read or edit `.env`; never touch `oldProject/` (legacy PHP with real credentials) or `data/` (local files, git-ignored).
- Sending a PEC from a real mailbox costs money and has legal value: never do it without being asked to.

## Traps worth knowing

- **RabbitMQ 4**: a message given back on purpose (nack with requeue) does **not** count towards the delivery limit, hence the pause before returning one; `basic.get` is refused on a single-active-consumer quorum queue; a queue cannot be declared with arguments different from the existing ones (delete it empty and declare again) and quorum queues refuse `delete --if-empty`.
- **rabbitmq-client** drops the messages that arrive while a consumer is closing, and the broker gives them back marked "redelivered": the container stops consuming the instant it is asked to stop.
- **Greenmail** (local and test stacks only) accepts any password, the login is the full address, and it issues no receipts.
- **Windows**: `grep` and `sed` from Git Bash strip carriage returns; check bytes with node instead.
- More of these in the "Known Quirks & Decisions" section of `documentation.md`.

## Where to read more

- `documentation.md` — what runs today, how it was built, what is left. Start with "Overview".
- `docs/it/messaggi.md` / `docs/en/messages.md` — what the CRM must publish and read, with PHP examples.
- `docs/asyncapi.yaml` — the formal contract of every message and queue.
- `README.md` — a quick tour; `SECURITY.md` — what the service protects and how.
