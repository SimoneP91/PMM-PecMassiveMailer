# First run on a new machine

How to bring pecmailer up from nothing and make the first tests, all in Docker and without touching a real PEC mailbox. Every command here was run on a freshly cloned copy of the project.

Half an hour, most of it waiting for downloads.

## What the machine needs

| What               | Version           | What for                                                                                    |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------- |
| **Docker Desktop** | 29 or later       | Runs the service, RabbitMQ and the fake PEC provider. On Windows it needs WSL2              |
| **Node.js**        | 24 (see `.nvmrc`) | For the development commands and the automated tests. The service itself runs inside Docker |
| **git**            | any               | To clone the project                                                                        |

**Nothing else.** No PEC mailbox, no password, no database: everything needed to try it is in the project.

Behind a corporate proxy, configure npm and Docker for it first, or the downloads stall.

## 1. Clone the project

```bash
git clone https://github.com/SimoneP91/PMM-PecMassiveMailer.git
cd PMM-PecMassiveMailer
```

## 2. Install the libraries

```bash
npm ci
```

`npm ci` installs exactly the versions recorded in the project, upgrading nothing: two machines end up identical. It must end with `found 0 vulnerabilities`.

## 3. Build the development commands

```bash
npm run build
```

Compiles the TypeScript into `dist/`, which the commands of step 6 need. The containers compile themselves when they are built.

## 4. Start everything

Open Docker Desktop and wait for "Engine running". Then:

```bash
docker compose up -d --build --wait
```

The first time it downloads about 1.2 GB of images and builds the service's own: up to ten minutes. Afterwards it starts in a dozen seconds.

Four containers:

| Container          | What it is                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `rabbitmq`         | The queues: the service's only way in and out                                                                                |
| `greenmail`        | A fake PEC provider, for tests only: it takes the messages and keeps them in fake mailboxes. It does not exist in production |
| `serfin-aruba`     | A pecmailer container, for the test mailbox "serfin-aruba"                                                                   |
| `serfin-legalmail` | A second one, for another mailbox: it shows that each mailbox is separate                                                    |

`--wait` returns only when every container reports itself healthy.

## 5. Check that it is up

```bash
docker compose ps
curl http://localhost:3001/health/ready
curl http://localhost:3002/health/ready
```

Both answers must be `{"status":"ok","checks":{"rabbitmq":true,"mailbox":true,"running":true}}`.

The configuration a container runs with, secrets excluded:

```bash
docker compose exec serfin-aruba node dist/main.cli.js config check
```

Pages:

- **RabbitMQ**: http://localhost:15672 — user `pecmailer`, password `pecmailer`. Under "Queues" are the three queues of each mailbox: `.in` (PECs to send), `.out` (outcomes and receipts), `.dead` (unreadable messages).
- **Greenmail**: http://localhost:8080 — the documentation of its programming interface, not a mailbox. The mails of a mailbox are at http://localhost:8080/api/user/destinatario@pec.example/messages/INBOX

## 6. The first test PEC

The service takes PECs from a queue. These two commands play the part the CRM will play in production:

```bash
npm run local:publish -- examples/pec.json     # puts an example PEC, with a PDF, in the queue
npm run local:outcomes                         # reads what happened and empties the output queue
```

The second must print a line like:

```
sent       29f6d1dab654...  <pm.29f6d1dab654...@pec.serfin.example> via SMTP, Sent copy ARCHIVED
```

The PEC left, the fake provider took it, and the copy was filed in the mailbox's Sent folder. The message itself:

```bash
curl "http://localhost:8080/api/user/destinatario@pec.example/messages/INBOX"
```

More ways to try:

```bash
npm run local:publish -- examples/pec.json --mailbox serfin-legalmail   # the other mailbox
npm run local:outcomes -- --follow                                       # keep listening (Ctrl+C to stop)
npm run local:outcomes -- --save data/esiti                              # save every event to a folder
```

**Receipts**: Greenmail issues none, as it is not a real provider. To see `receipt` events, run the integration tests, which drop real anonymised receipts into the sender's inbox, or use a real PEC mailbox.

## 7. The automated tests

```bash
npm run check
```

Types, lint, formatting and the unit tests: **157 tests**, no Docker needed.

```bash
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration
```

These run against a real RabbitMQ and a real Greenmail: **20 tests**. They use containers and ports of their own, so the two stacks never disturb each other.

Afterwards:

```bash
docker compose -f docker-compose.test.yml down
```

## 8. Stop and clean up

```bash
docker compose down                       # stops the service, keeps RabbitMQ's data
docker compose down -v                     # stops it and deletes the queues too
```

## When something goes wrong

| Symptom                                        | What is happening                            | Remedy                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `failed to connect to the docker API`          | Docker Desktop is not running                | Open it, wait for "Engine running", run the command again                                                                                                    |
| `port is already allocated`                    | Something else uses that port                | The ports are 5672 and 15672 (RabbitMQ), 3025, 3143 and 8080 (Greenmail), 3001 and 3002 (the probes). Change them in `docker-compose.yml`, left of the colon |
| `PRECONDITION_FAILED ... inequivalent arg`     | A queue created by an earlier version exists | Delete the empty queues and start again: `docker compose exec rabbitmq rabbitmqctl delete_queue pecmailer.serfin.serfin-aruba.in`                            |
| `npm run local:publish` cannot find `dist/...` | Not built                                    | Run `npm run build`                                                                                                                                          |
| A container stays `unhealthy`                  | Usually it cannot reach RabbitMQ             | Look at the logs: `docker compose logs serfin-aruba --tail 50`                                                                                               |
| Downloads hang                                 | Corporate proxy                              | Configure the proxy in npm and in Docker Desktop                                                                                                             |

A container's logs are JSON lines, one per event:

```bash
docker compose logs -f serfin-aruba
```

## What not to do

- **Do not point it at a real PEC mailbox** without agreeing to it first: every PEC sent has legal value and costs money. How to test against a real mailbox is in the README, under "Development".
- **Never put a password in the project**: credentials live in environment variables only, and in production in a Kubernetes Secret.

## After the first tests

- How the CRM sends and reads outcomes, with PHP examples: [messages.md](messages.md).
- The formal contract: [docs/asyncapi.yaml](../asyncapi.yaml).
- How the service is built and why: `documentation.md` in the project root, and the decisions in [adr/](adr/).
- What is left before production: the "What's Next" section of `documentation.md`.
