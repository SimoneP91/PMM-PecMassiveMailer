# Security

## Reporting a vulnerability

Report privately to the maintainers; do not open a public issue. Include the tenant, the mailbox and the time: every log line carries the first two.

## What the service protects and how

Since version 0.6.0 the service is a container per tenant and mailbox, driven by RabbitMQ queues, with no HTTP API and no database ([ADR 0006](docs/en/adr/0006-queues-no-database.md)). The controls below are the ones the code enforces. Version 0.5.1 (HTTP API, MongoDB, webhooks) and its controls stay in the git history.

| Concern               | Control                                                                                                                                                                                                                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secrets               | The mailbox password and `RABBITMQ_URL` come from the environment only (a Kubernetes Secret). They are wrapped from the moment they are read, so a log line, a JSON dump or `config check` prints `[redacted]`; the logger also redacts any `password`, `pass` or `url` field.                        |
| Data at rest          | None. The container writes nothing to disk: messages, attachments and receipts pass through memory to the provider or to the output queue. The image runs without a volume and can have a read-only file system.                                                                                      |
| Personal data in logs | Ids, codes and counts only: never a recipient, a subject, a body or an attachment. Logs are JSON lines on standard output (Graylog).                                                                                                                                                                  |
| Queue access          | A container reaches only the queues named after its own tenant and mailbox. Isolation between tenants is enforced by RabbitMQ: one user per tenant, with permissions limited to `pecmailer.<tenant>.*` (set by whoever runs RabbitMQ).                                                                |
| Transport             | SMTP and IMAP use the provider's TLS (implicit TLS or STARTTLS from the preset), with certificate verification. `RABBITMQ_URL` accepts `amqps://` for TLS towards the broker where the network is not trusted.                                                                                        |
| Input validation      | Every message of the input queue is checked against a strict schema: unknown fields refused, sizes bounded (HTML 512 KB, 50 attachments, 20 inline images, the encoded PEC within the mailbox limit), no line breaks or control characters in the subject or the recipient's name (header injection). |
| HTML                  | A closed list of elements and attributes, rejected not sanitised: no scripts, forms, frames, event handlers, remote images or CSS `url()`; links only `https`, `http` and `mailto`; images only as inline `cid:` parts.                                                                               |
| Attachments           | The type is detected from the first bytes, never trusted from the name; an extension allow list; executables and scripts refused; file names without path separators.                                                                                                                                 |
| Recipients            | Only addresses served by an accredited PEC provider (known domains or their mail exchangers) are sent to; anything else is rejected before sending.                                                                                                                                                   |
| Duplicate PECs        | A message is acknowledged only after its outcome is stored in the output queue. A message delivered again after an interruption is never sent blindly: the provider's receipt is looked for in the mailbox, and without it the outcome is `uncertain`, for a person to decide.                        |
| Poison messages       | An unreadable message goes to the dead-letter queue; a message that keeps killing its container is dead-lettered by RabbitMQ's delivery limit; a failed handling returns the message after a pause, so nothing spins.                                                                                 |
| Receipt trust         | A mail counts as a receipt only with the provider's top-level `X-Ricevuta` header; PEC transport envelopes (`X-Trasporto`) are ignored whatever they contain, so a forged "receipt" sent by a third party changes nothing. The receipt is published byte for byte with its SHA-256.                   |
| XML                   | `daticert.xml` is read by a non-validating parser that never expands DTD entities: no XXE, no entity expansion.                                                                                                                                                                                       |
| The client's mailbox  | The receipts folder is opened read-only and fetched with `BODY.PEEK`: nothing is marked as read, moved or deleted; the headers of a mail are read first and its body only if it may be a receipt. The only write is the copy in the Sent folder.                                                      |
| Account lockout       | A refused login suspends the mailbox at once (sending and reading) instead of retrying; it resumes only with a restart.                                                                                                                                                                               |
| Container             | Non-root user, production dependencies only, pinned base image, health check; the only port open is the probes'. Eight runtime dependencies; `npm audit` clean at release.                                                                                                                            |

Not done by the service, on purpose or by design:

- The providers' S/MIME signature on receipts is kept, not verified against the AgID trust list.
- Keeping records, attachments and receipts is the sender's job: the service keeps nothing to protect or to retain.
- Tenant isolation on RabbitMQ and TLS towards the broker depend on how RabbitMQ is run.
