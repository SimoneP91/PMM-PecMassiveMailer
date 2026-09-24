# pecmailer

pecmailer is an **automatic postman for PEC** (Italian certified e-mail). The CRM leaves the PECs to send in a queue; pecmailer sends them from the company's Legalmail mailbox, then reports on another queue what happened and every receipt the provider issues. **It keeps nothing**: the memory lives in the CRM, in the queues and in the PEC mailbox.

Version 0.6.1.

## Where to read next

| Document                                 | For whom                                                                                                                      | Language |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------- |
| This README                              | Everyone: what the project is, how it works, where it stands                                                                  | English  |
| [docs/guida-crm.md](docs/guida-crm.md)   | Whoever writes the CRM side, person or AI assistant: the message contract, the rules, the states of a PEC, reference PHP code | Italian  |
| [deploy/README.md](deploy/README.md)     | IT: installing, running, updating and recovering the service                                                                  | Italian  |
| [docs/tecnica.md](docs/tecnica.md)       | Whoever develops pecmailer, person or AI: architecture, decisions, traps, tests, first run on a new machine                   | Italian  |
| [docs/asyncapi.yaml](docs/asyncapi.yaml) | Programs and tools: the formal contract of every message and queue                                                            | English  |
| [CHANGELOG.md](CHANGELOG.md)             | The history of the versions                                                                                                   | English  |

---

## 1. The pieces

| Piece                    | What it is                                                                                          | Who runs it                                                             |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **CRM**                  | The application that decides which PECs to send and keeps the history in its database               | The CRM team (the part that talks to the queues is still to be written) |
| **RabbitMQ**             | The internal post office: the queues between the CRM and pecmailer. It is the part that holds state | In the Kubernetes cluster (who runs it is still to be decided)          |
| **pecmailer**            | The postman: one container per PEC mailbox                                                          | Us: the code of this repository                                         |
| **Legalmail (InfoCert)** | The actual PEC provider: sends, archives, issues the receipts                                       | InfoCert                                                                |
| **Kubernetes**           | Starts, watches, moves and restarts the containers                                                  | IT                                                                      |
| **Container registry**   | The store of ready-made images; Kubernetes pulls them from there                                    | IT                                                                      |
| **Azure DevOps Repos**   | Where the code lives                                                                                | Us                                                                      |

---

## 2. How a PEC flows

```
 CRM ──(1) publishes the PEC──► queue  pecmailer.serfin.legalmail.in
                                          │
                                   (2) pecmailer takes it, one at a time
                                          │
                        (3) checks → (4) pace → (5) SMTP ──► InfoCert ──► recipient
                                          │
                                   (6) copy in "Spedite" (IMAP)
                                          │
 CRM ◄──(7) "sent" outcome─── queue  pecmailer.serfin.legalmail.out
 CRM ◄──(8) receipts ────────┘       ▲
                                     └── every minute pecmailer reads the receipts in the mailbox (IMAP)
```

1. **The CRM publishes** one JSON message per PEC: `id` (a new UUID for every sending, see section 3), recipient, subject, HTML, attachments. RabbitMQ confirms it is stored.
2. **pecmailer takes it**: one PEC at a time, from a single container per mailbox.
3. **Checks**: is the recipient really a PEC address? Does the HTML follow the rules? Are the attachments of an allowed type? Does the PEC fit in 30 MB? If not → outcome `rejected`, and **nothing is sent**.
4. **Pace**: at most N PECs a minute, so the provider does not block the mailbox.
5. **SMTP** to InfoCert. The `id` ends up inside the PEC's Message-ID: `<pm.{id}@legalmail.it>`.
6. **Copy in the "Spedite" (Sent) folder** of the mailbox.
7. **Outcome on the output queue.** Only once RabbitMQ confirms it has stored the outcome does pecmailer tell the input queue "done, you can remove it".
8. **Receipts**: every minute pecmailer reads the mailbox, read-only. Every receipt of one of its PECs (acceptance, delivery, non-delivery…) is published whole: it is the legal proof, and the CRM keeps it.

**How a receipt finds its PEC without a database:** by law every PEC receipt quotes the Message-ID of the original message. Since the `id` is inside it, every receipt carries the identifier of its own PEC.

**The possible outcomes:**

| Event               | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `sent`              | Left; the receipts will follow                                                     |
| `rejected`          | Not sent: it breaks a rule. Fix it and send again with a new id                    |
| `failed`            | Not sent: the provider refused it, or temporary errors lasted more than 25 minutes |
| `uncertain`         | Unknown whether it left. **Never resend blindly**: a person decides                |
| `receipt`           | A receipt from the provider, with the original signed file                         |
| `mailbox.suspended` | The provider refused the password: pecmailer stops on purpose                      |

---

## 3. The id of each PEC

The `id` identifies **one sending**, not the CRM's record.

| Field       | What it holds                                                                        | Why                                                            |
| ----------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| `id`        | **A new UUID for every sending**, generated by the CRM and stored next to the record | It must be unique forever. In PHP: `bin2hex(random_bytes(16))` |
| `reference` | The record's identifier in the CRM, e.g. `"32900738"`                                | Comes back unchanged in every outcome (`sent`, `failed`, …)    |
| `batch`     | The campaign, e.g. `solleciti-2026-09`                                               | Optional; comes back in the outcomes too                       |

```json
{ "version": 1, "id": "3f9c1b7e2a4d4e8f9b0c6d5a1e2f3a4b", "reference": "32900738", "batch": "solleciti-2026-09", ... }
```

A record can have several sendings over time: a PEC that `failed` and is sent again gets **a new UUID and the same `reference`**. Receipts carry the `id` only: the CRM keeps a UUID → record table.

**What happens when the same `id` is used twice**, for example ten days apart (checked in the code):

1. **The second PEC is sent anyway**: pecmailer does not remember the ids it has used.
2. The two PECs have **the same Message-ID**, so their receipts get mixed up: the CRM cannot tell which delivery belongs to which PEC.
3. The second `sent` has the same `eventId` (`sent:<id>`), and the CRM discards it as a duplicate: it never learns that the second PEC left.
4. **The worst case:** if the second PEC is interrupted by a crash before leaving, the check looks for the acceptance receipt of that Message-ID and **finds the first PEC's**, because the search does not look at dates. The second PEC is reported `sent` without ever leaving.
5. The recipient sees the Message-ID, and therefore the identifier used.

An id "derived" from the record (e.g. `32900738-2`) would only work with a counter that never repeats, and would still expose the internal number. A UUID is simpler and cannot collide.

---

## 4. Configuration

| Where                                                | What it holds                                                                         | Changes when                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------ |
| **The image** `pecmailer:<version>`, in the registry | The compiled code. Nothing else                                                       | The code changes                     |
| **The Kubernetes Deployment**, one per mailbox       | The structure: replicas, probes, stop time, resources, image version                  | Rarely; the version at every release |
| **ConfigMap**                                        | The non-secret values: tenant, mailbox, sender, pace                                  | When needed                          |
| **Secret**                                           | The mailbox password, the InfoCert account code, RabbitMQ's address with its password | When they change                     |
| **RabbitMQ's configuration**                         | Messages up to 64 MB, a 30-minute timeout                                             | Practically never                    |

**The container's variables:**

| Variable                  | Example                              | Where                                                  |
| ------------------------- | ------------------------------------ | ------------------------------------------------------ |
| `PECMAILER_TENANT`        | `serfin`                             | ConfigMap: the tenant                                  |
| `PECMAILER_MAILBOX`       | `serfin-legalmail`                   | ConfigMap: the mailbox's code; it names the queues     |
| `PECMAILER_PROVIDER`      | `legalmail`                          | ConfigMap                                              |
| `PECMAILER_FROM_ADDRESS`  | the PEC address                      | ConfigMap: the sender                                  |
| `PECMAILER_FROM_NAME`     | the name recipients see              | ConfigMap                                              |
| `PECMAILER_PER_MINUTE`    | `5` at first                         | ConfigMap: the pace; raised once the CRM is trusted    |
| `PECMAILER_SMTP_USERNAME` | `M…`                                 | Secret: the InfoCert account code, **not** the address |
| `PECMAILER_SMTP_PASSWORD` | —                                    | Secret                                                 |
| `RABBITMQ_URL`            | `amqp://user:password@rabbitmq:5672` | Secret                                                 |

Legalmail's servers, ports and "Spedite" folder are already set in the code (the `legalmail` preset), and **proven by two real sends** on 21 September 2026.

**The queues** are named `pecmailer.<tenant>.<mailbox>.in`, `.out` and `.dead`, and pecmailer creates them at its first start.

With Docker Compose on a single server, the same values go in a `.env` file and the structure is `deploy/docker-compose.yml`, ready to use.

---

## 5. Who orchestrates: Kubernetes

**How each piece runs:**

| Piece         | How                                                                                                                                                               | Why                                                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pecmailer** | One Deployment per mailbox, **1 replica**, read-only file system, no volume                                                                                       | It is stateless. More mailboxes = more Deployments; more replicas of the same mailbox are useless, because the queue lets only one of them work       |
| **Probes**    | `/health/live`: when it fails, Kubernetes restarts the pod. `/health/ready`: false while RabbitMQ is unreachable, the mailbox is suspended or the pod is stopping | A stuck pod is restarted automatically                                                                                                                |
| **Stop**      | `terminationGracePeriodSeconds: 120`                                                                                                                              | The pod finishes the PEC in hand before stopping                                                                                                      |
| **RabbitMQ**  | **StatefulSet with a persistent disk**, or the **RabbitMQ Cluster Operator**. Never a Deployment                                                                  | It is stateful. It keeps its data under its own name: with a Deployment the name changes at every restart, and it would start again with empty queues |

**What happens when…**

| Event                                                          | What happens                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pecmailer is moved** (node maintenance, update, rebalancing) | Kubernetes warns it; it finishes the PEC in hand, and a new one starts elsewhere. Nothing is lost                                                                                                                                        |
| **pecmailer's node dies abruptly**                             | The PEC in hand goes back to the queue marked "delivered before". After about 5 minutes (default settings) Kubernetes recreates pecmailer on another node; the new one checks the receipt: `sent` or `uncertain`, never a second sending |
| **pecmailer gets stuck**                                       | The `live` probe fails and Kubernetes restarts it                                                                                                                                                                                        |
| **Update, with two pods running for a few seconds**            | The queue lets only one of them work. Receipts read twice have the same `eventId`, and the CRM discards the copies                                                                                                                       |
| **RabbitMQ's node dies, 3 replicas**                           | The other two carry on: quorum queues are replicated. No loss, no downtime                                                                                                                                                               |
| **RabbitMQ's node dies, 1 replica on a network disk**          | RabbitMQ starts again on another node and finds its disk. A few minutes of downtime, no loss                                                                                                                                             |
| **RabbitMQ's node dies, 1 replica on a local disk**            | Down until that node comes back. To avoid                                                                                                                                                                                                |

**With Docker Compose on a single server** the same rules apply, already written in `deploy/docker-compose.yml`. The differences: Compose does not restart a stuck container (it marks it `unhealthy`, which needs an alert), and when the server dies nothing moves elsewhere.

---

## 6. Stateless and stateful

| Piece            |                      | What it holds                                               | When it dies                                                                                                                |
| ---------------- | -------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **pecmailer**    | **Stateless**        | Nothing, only the PEC in hand                               | Kubernetes recreates it, on another node if needed. Nothing is lost                                                         |
| **RabbitMQ**     | **Stateful**         | The waiting PECs and the outcomes not yet read, **on disk** | It starts again and finds everything (tried by killing it abruptly with PECs queued). With 3 replicas it does not even stop |
| **PEC mailbox**  | Stateful, InfoCert's | "Spedite" and the receipts: **the legal proof**             | Not up to us; pecmailer never deletes anything                                                                              |
| **CRM database** | Stateful             | The complete history                                        | It is the system's real memory                                                                                              |

---

## 7. The two guarantees, and how they are kept

**1. A PEC is never sent twice.**
If pecmailer dies halfway, the PEC goes back to the queue marked "delivered before". Whoever takes it **does not resend it**: it looks in the mailbox for the acceptance receipt. Found → `sent`. Not arrived within 5 minutes → `uncertain`, and a person decides.

**2. An outcome is never lost.**
pecmailer removes the PEC from the input queue only after RabbitMQ has stored its outcome. The other side of the coin: an outcome may arrive **twice**. That is why every event has a fixed `eventId` (for example `sent:<id>`), which the CRM uses to discard duplicates.

Both rely on a unique `id` for every sending (section 3).

---

## 8. Failures and recovery

| What happens                                      | Result                                                                         | Does a person act?                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| pecmailer stops or is moved                       | It finishes the PEC in hand; the others wait                                   | No                                                                                   |
| pecmailer dies **after** sending                  | On restart it finds the receipt → `sent`                                       | No                                                                                   |
| pecmailer dies **before** sending                 | → `uncertain`: the price of "never twice"                                      | Yes: check "Spedite" and, if needed, resend with a new id                            |
| pecmailer gets stuck                              | Kubernetes restarts it (`live` probe)                                          | No                                                                                   |
| A message crashes the container every time        | After 5 attempts it goes to the `.dead` queue                                  | Yes                                                                                  |
| RabbitMQ dies or is moved                         | It starts again and finds everything; pecmailer reconnects by itself           | No                                                                                   |
| **RabbitMQ's disk is lost**                       | Only what was in transit is lost; the receipts are read again from the mailbox | Yes: first let the receipts come back, then republish only the PECs left without one |
| CRM down                                          | The outcomes wait in the queue                                                 | No                                                                                   |
| InfoCert unreachable                              | Retries for 25 minutes, then `failed`: certainly not sent                      | No                                                                                   |
| Connection lost **after** the PEC was transmitted | `uncertain` at once, never retried                                             | Yes                                                                                  |
| Password refused                                  | Mailbox suspended: the PECs stay safe in the queue                             | Yes: fix the password and restart                                                    |
| pecmailer down for more than 24 hours             | Older receipts are not read again by themselves                                | Yes: raise `PECMAILER_RECEIPTS_LOOKBACK_HOURS` before restarting                     |
| Someone "cleans up" the mailbox by hand           | The receipts removed are lost to the system                                    | Rule: **nobody touches the mailbox**                                                 |
| The same `id` used twice                          | See section 3                                                                  | Avoided in the CRM: a UUID for every sending                                         |

---

## 9. Why RabbitMQ, and not a database or Redis

**RabbitMQ is the stateful part, and it is durable.** Quorum queues write to disk **before** confirming, and with several replicas they are copied to several nodes. Tried: RabbitMQ killed abruptly with 3 PECs queued; after the restart all of them were there.

|                                                                  | RabbitMQ                        | Database (Postgres, Mongo)                                     | Redis                                                                                                                                              |
| ---------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durability                                                       | On disk before the confirmation | On disk                                                        | **In memory.** By default it saves a snapshot every few minutes; even well configured it can lose the last second, and replication is asynchronous |
| Queue behaviour (one at a time, redelivery, limit, dead letters) | Built in                        | To be built                                                    | Partly (Streams)                                                                                                                                   |
| History and searches                                             | No: the CRM keeps them          | Yes                                                            | No                                                                                                                                                 |
| Refusing an id already used                                      | No                              | Yes                                                            | Yes                                                                                                                                                |
| Stateful?                                                        | Yes                             | Yes                                                            | Yes                                                                                                                                                |
| Personal data kept                                               | In transit only                 | Yes: recipients, texts, attachments (GDPR, retention, backups) | In RAM                                                                                                                                             |
| 40 MB PECs                                                       | Configured                      | Yes                                                            | All in RAM: expensive                                                                                                                              |

Considerations:

- **Redis** gives weaker durability guarantees for this use: it is built for caches and sessions, not for messages with legal value.
- **A database does not remove state, it moves it**: a database in Kubernetes needs a StatefulSet, a disk, backups and replicas too.
- **Reliability comes from the protocol**, not from where data is stored: confirm only after storing, a stable id, never resend blindly.
- **The `uncertain` case** (connection lost after transmitting the PEC) is intrinsic to SMTP: no database removes it.
- **What a database would add**: a history inside pecmailer, which the CRM already has, and **refusing an id already used**.
- **Refusing ids already used can be done without a database**: before sending, pecmailer searches the mailbox for receipts of that Message-ID and, if it finds any, rejects the PEC as a duplicate id. One IMAP search per PEC, a fraction of a second. Not there today: a proposal.
- **Bringing a database back** changes the service's design (message contract, code, tests) and puts personal data at rest inside pecmailer.

**Proposal:** keep RabbitMQ, in Kubernetes with the operator, and 3 replicas to survive the loss of a node. The history stays in the CRM's database. If protection against reused ids is wanted, add the check on the mailbox.

---

## 10. Releases and updates

```
dev:        change → commit (Azure DevOps) → docker build → docker push registry/pecmailer:0.6.2
Kubernetes: image version in the Deployment → 0.6.2 → rolling update
```

- **Going back** = the previous version again (or `kubectl rollout undo`).
- **Rules:** a version is published once; never `latest`; read the CHANGELOG before updating, because some versions require recreating the queues.
- **Changing a ConfigMap or a Secret is not enough**: the pod reads its variables at start. The Deployment needs a restart (`kubectl rollout restart`).
- With Docker Compose: change the version in `.env`, then `docker compose pull` and `docker compose up -d`. After touching `.env` use `up -d`, **never `restart`**, which starts again with the old values (tried).

---

## 11. Security in brief

- **Passwords** only in a Kubernetes Secret (with Compose: a `.env` readable by its owner only), never in the repository or in the logs.
- **Logs** without personal data: ids, codes and counts only.
- **The mailbox is read-only**, except for the copy in "Spedite".
- **Refused password → suspension**, so the account does not get locked.
- **Least credentials**: the cluster can only pull from the registry; the CRM has its own RabbitMQ user, without administration rights.
- **RabbitMQ reachable by the CRM only.** If the CRM runs outside the cluster or on an untrusted network, the connection must be encrypted (TLS).
- **Known limit:** on a RabbitMQ shared by several tenants, one tenant could write into another's queues. Irrelevant with one tenant; with several, one virtual host per tenant.

---

## 12. Where we stand

**Done and verified:**

- Code 0.6.1: 157 unit tests and 20 integration tests, all green.
- **Real collaudo on Legalmail**: 2 real PECs, every expected receipt, a restart with no loss and no duplicate.
- RabbitMQ killed abruptly with PECs queued: no loss.
- With Docker Compose and a test registry: image pulled from the registry, sending, orderly stop, version update and going back.
- Git history checked before publishing to Azure DevOps: no password, no personal data.

**Not tried yet:** the behaviour on Kubernetes. What section 5 describes comes from the service's probes and orderly stop, tried with Docker, and from Kubernetes' standard behaviour.

**To do, in order:**

1. Create the `pecmailer` repository on Azure DevOps, **new and separate** from `Serfin97.noMAC`, and push the code.
2. **Registry**: its address, a credential to push and a read-only one for the cluster; publish the 0.6.1 image.
3. **Kubernetes manifests** for the mailbox: Deployment, ConfigMap, Secret.
4. **RabbitMQ in the cluster**: operator or StatefulSet, with a persistent disk and the two settings (64 MB, 30 minutes).
5. **Network**: outbound from the cluster to InfoCert's ports 465 and 993; a DNS that resolves MX records of external domains.
6. **Alerts**: messages in `.dead`, `mailbox.suspended` events, disk space of RabbitMQ.
7. **The CRM side**: a UUID for every sending, the record in `reference`; publishing, reading the outcomes, states and periodic check, all described in [docs/guida-crm.md](docs/guida-crm.md).
8. Align the pace (5 a minute) with the CRM's alert threshold ("stuck in the queue for more than 3 hours").
9. A load test before the first large campaign.
10. To consider: the check of reused ids on the mailbox (section 9).

---

## 13. Open decisions and questions

**Decisions:**

1. **Kubernetes**: who writes the manifests?
2. **RabbitMQ**: who provides and runs it, with how many replicas and on which disk?
3. **Database**: stay without one, or bring it back? And if so, for which precise need: history, refusing reused ids?

**For IT:**

- What is the registry's address? Who creates the two credentials?
- Does the cluster reach Docker Hub, or must RabbitMQ's image be copied into the registry as well?
- Are ports 465 and 993 towards `*.cert.legalmail.it` open outbound from the cluster's nodes? Does the DNS resolve MX records of external domains?
- Which disk is available for RabbitMQ (a network disk?), and how is it backed up?
- Who receives the alerts, and through which tool (Graylog)?
- Does the CRM run in the same cluster, or on the same network?

**For InfoCert, or whoever manages the mailbox:**

- What are the mailbox's limits on sends per minute and simultaneous connections?

**For the CRM team:**

- Who writes the CRM side, and when?
- `id` = a UUID for every sending, the record's number in `reference`.
