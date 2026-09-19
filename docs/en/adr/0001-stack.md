# ADR 0001 — Stack

**Date**: 2026-09-18 · **Status**: partly superseded by [ADR 0006](0006-queues-no-database.md) (no NestJS, no MongoDB since 0.6.0)

## Context

A PHP/MySQL single-tenant PEC sender embedded in a CRM is being rewritten as a standalone multi-tenant microservice, delivered as a Docker image, with MongoDB as the company standard database and no message broker in the environment.

## Decision

| Choice                                                     | Reason                                                                                                                                                                          |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24 + TypeScript 5.9, strict, no `any` (lint-enforced) | The work is I/O bound (SMTP, IMAP); the API contract is the product and a typed schema documents it. TypeScript 7 is not yet supported by the linter.                           |
| NestJS 11 on Fastify                                       | Structure that other developers recognise; Fastify underneath for throughput. NestJS 12 was days old at the time and the ecosystem (nestjs-zod, nestjs-pino) had not caught up. |
| Zod 4 + nestjs-zod                                         | One schema gives runtime validation, static types and the OpenAPI document.                                                                                                     |
| MongoDB 8 + Mongoose 9                                     | Company standard. Single-document atomic updates carry the state machine; a single-node replica set is required even locally for transactions and change streams.               |
| No broker: MongoDB is the queue                            | One less system to operate; at 60 messages/minute per mailbox a database-backed queue is not a bottleneck. The queue sits behind an interface.                                  |
| nodemailer + imapflow                                      | Maintained, typed, streaming attachments, structured SMTP response codes, no dependency on the deprecated PHP imap extension.                                                   |
| pino via nestjs-pino                                       | JSON on stdout for the platform; redaction at the logger.                                                                                                                       |
| Vitest + SWC                                               | Fast tests with decorator metadata support.                                                                                                                                     |
| Secrets from the environment only                          | The deployment pattern of the platform (Kubernetes Secret); nothing to store, nothing to encrypt at rest.                                                                       |

## Consequences

- One image, three commands; Kubernetes concerns (replicas, secrets injection) stay outside the code, but "one mailbox, one worker at a time" is enforced in code with a lease, so N replicas remain safe.
- Adding a tenant or a mailbox is a configuration change and a restart, not an API call — acceptable at 1–3 tenants, revisited if that changes.
