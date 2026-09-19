# pecmailer messages: a guide for senders

pecmailer sends PECs and reports what happened. It keeps nothing: not the messages, not the attachments, not the receipts. Whoever puts PECs in the queue and reads the outcomes keeps the records.

Each container serves one tenant and one of its mailboxes. Serfin with three mailboxes has three containers, each with its own queues.

The formal description, readable by programs, is [docs/asyncapi.yaml](../asyncapi.yaml); pasted into AsyncAPI Studio (studio.asyncapi.com) it renders as a page. This guide says the same in words.

## The queues

| Queue                               | Written by                                            | Read by                              |
| ----------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| `pecmailer.{tenant}.{mailbox}.in`   | The CRM: one PEC per message                          | The container, one PEC at a time     |
| `pecmailer.{tenant}.{mailbox}.out`  | The container: outcomes and receipts                  | The CRM                              |
| `pecmailer.{tenant}.{mailbox}.dead` | RabbitMQ, with the messages the container cannot read | A person, to find out what was wrong |

Example: `pecmailer.serfin.serfin-aruba.in`.

The queues are "quorum" queues: RabbitMQ keeps several copies and loses no message when it restarts. The container creates them on its first start if they do not exist.

## Sending a PEC

One JSON message per PEC:

| Field                         | Required | Content                                                                                                 |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `version`                     | yes      | Always `1`                                                                                              |
| `id`                          | yes      | The PEC's identifier, chosen by the CRM. See below                                                      |
| `reference`                   | no       | A CRM label, e.g. the case number. Returned as is in the outcomes                                       |
| `batch`                       | no       | A label for a group of PECs, e.g. a reminder campaign. Returned as is in the outcomes                   |
| `to.address`                  | yes      | The recipient's PEC address                                                                             |
| `to.name`                     | no       | The recipient's name                                                                                    |
| `subject`                     | yes      | The final subject, no line breaks, at most 500 characters                                               |
| `html`                        | yes      | The final text in HTML, at most 512 KB                                                                  |
| `attachments`                 | no       | Up to 50 attachments: `filename` and `content`, the file in base64                                      |
| `inlineImages`                | no       | Up to 20 images in the text: `cid`, `content` and optionally `filename`, used as `<img src="cid:logo">` |
| `options.unverifiedRecipient` | no       | When the recipient's domain cannot be classified: `reject` (default) or `send`                          |

Unknown fields get the message rejected, so a typo does not go unnoticed.

### The identifier

The `id` matters most:

- **Unique for ever.** It becomes part of the PEC's Message-ID, `<pm.{id}@sender-domain>`, which every receipt quotes: that is how a receipt finds its PEC.
- **The same id twice means two PECs** whose receipts cannot be told apart. A PEC sent again gets a new id.
- **The recipient sees it**, as the Message-ID is visible. Never personal data: a UUID is ideal.
- Letters, digits, dot, hyphen and underscore; at most 64 characters.

### The checks

Before sending, the container checks three things. If one fails, the PEC does not leave and a `rejected` outcome says why:

- the address is a PEC: an ordinary mail domain such as gmail.com is refused;
- the HTML follows the safety rules: no scripts, forms, frames, remote images, styles with `url()`; links only `https`, `http` and `mailto`;
- the whole PEC, attachments included, is within the mailbox limit: 30 MB for Aruba.

The type of an attachment is detected from its content, not from its name. Allowed extensions: pdf, p7m, xml, txt, csv, rtf, eml, zip, doc, docx, xls, xlsx, ppt, pptx, odt, ods, png, jpg, jpeg, gif. Executables are always refused.

### Example

The addresses in the examples are made up, on `.example` domains the service would refuse: replace them with real ones.

```json
{
  "version": 1,
  "id": "7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f",
  "reference": "pratica-4521",
  "batch": "solleciti-2026-09",
  "to": { "address": "destinatario@pec.example", "name": "Mario Rossi" },
  "subject": "Sollecito pratica 4521",
  "html": "<p>Gentile Mario Rossi,</p><p>le inviamo in allegato il sollecito.</p>",
  "attachments": [{ "filename": "sollecito.pdf", "content": "JVBERi0xLjQK..." }]
}
```

### From PHP

With `php-amqplib` (`composer require php-amqplib/php-amqplib`). RabbitMQ confirms every message it has stored; without the confirmation the PEC is not in the queue and must be published again.

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

$connection = new AMQPStreamConnection('rabbitmq', 5672, 'serfin', getenv('RABBITMQ_PASSWORD'));
$channel = $connection->channel();
$channel->set_nack_handler(function (AMQPMessage $message): void {
    throw new RuntimeException('RabbitMQ did not store PEC ' . $message->get('message_id'));
});
$channel->confirm_select();

$pec = [
    'version' => 1,
    'id' => bin2hex(random_bytes(16)), // store it in your database, with the case
    'reference' => 'pratica-4521',
    'to' => ['address' => 'destinatario@pec.example', 'name' => 'Mario Rossi'],
    'subject' => 'Sollecito pratica 4521',
    'html' => '<p>Gentile Mario Rossi,</p><p>le inviamo in allegato il sollecito.</p>',
    'attachments' => [
        ['filename' => 'sollecito.pdf', 'content' => base64_encode(file_get_contents('/path/sollecito.pdf'))],
    ],
];

$channel->basic_publish(
    new AMQPMessage(json_encode($pec, JSON_THROW_ON_ERROR), [
        'content_type' => 'application/json',
        'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT, // survives a RabbitMQ restart
        'message_id' => $pec['id'],
    ]),
    '',                                 // no exchange: the queue is named directly
    'pecmailer.serfin.serfin-aruba.in',
);
$channel->wait_for_pending_acks(5.0);

$channel->close();
$connection->close();
```

## Reading the outcomes

Every message of the output queue is a JSON event with these fields: `version`, `event`, `eventId`, `occurredAt`, `tenant`, `mailbox`.

| `event`             | Meaning                                                                                                                                    | What to do                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `sent`              | The provider took the PEC. Carries `messageId`, `sentAt`, the provider's answer and `sentCopy`, whether the copy in the Sent folder worked | Wait for the receipts                                                     |
| `rejected`          | Not sent: the message breaks a rule, `errors` says which                                                                                   | Fix it and publish it again with a new id                                 |
| `failed`            | Not sent: the provider refused it, or temporary errors lasted too long                                                                     | Read `code` and `detail`; publish again with a new id if appropriate      |
| `uncertain`         | Unknown: the connection dropped while the provider had the message, or the container stopped halfway                                       | Do not resend blindly: see below                                          |
| `receipt`           | A provider's receipt, with the receipt file                                                                                                | Keep it: it is the legal proof                                            |
| `mailbox.suspended` | The provider refused the mailbox password                                                                                                  | Fix the password and restart the container. PECs wait safely in the queue |

The outcomes of a PEC carry `id`, `reference` and `batch`. Receipts carry only `id`: the CRM finds the rest from it.

### Receipts

| `receiptType`          | What it is                                 | Final |
| ---------------------- | ------------------------------------------ | ----- |
| `ACCEPTANCE`           | The sender's provider accepted it          | no    |
| `TAKING_CHARGE`        | The recipient's provider took charge of it | no    |
| `NON_DELIVERY_WARNING` | Warning of a possible non-delivery         | no    |
| `DELIVERY`             | Delivered                                  | yes   |
| `NON_DELIVERY`         | Not delivered                              | yes   |
| `NON_ACCEPTANCE`       | Not accepted by the sender's provider      | yes   |
| `VIRUS_DETECTED`       | Refused because of a virus                 | yes   |

`final` says whether the PEC has its definitive outcome. A receipt carries:

- `eml`: the whole receipt as the provider sent it, signature included, in base64. **It is the legal proof: keep it.**
- `emlSha256`: its digest, to check that the stored file is intact.
- `daticert`: the receipt's `daticert.xml`, in base64.
- `error`: for a non-delivery, the provider's code and explanation. Aruba reports a mailbox that does not exist with the generic code `altro`: the reason is only in the explanation.

### From PHP

Acknowledge to RabbitMQ only after the event is in your database: if the program stops first, RabbitMQ delivers the event again and nothing is lost.

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

$connection = new AMQPStreamConnection('rabbitmq', 5672, 'serfin', getenv('RABBITMQ_PASSWORD'));
$channel = $connection->channel();
$channel->basic_qos(0, 10, false); // at most 10 events in progress at a time

$channel->basic_consume('pecmailer.serfin.serfin-aruba.out', '', false, false, false, false,
    function (AMQPMessage $message): void {
        $event = json_decode($message->getBody(), true, 512, JSON_THROW_ON_ERROR);

        if (alreadyProcessed($event['eventId'])) { // a copy: already stored
            $message->ack();
            return;
        }

        switch ($event['event']) {
            case 'receipt':
                $file = base64_decode($event['eml'], true);
                if ($file === false || hash('sha256', $file) !== $event['emlSha256']) {
                    throw new RuntimeException('Damaged receipt: ' . $event['eventId']);
                }
                storeReceipt($event['id'], $event['receiptType'], $event['final'], $file);
                break;
            default:
                updateOutcome($event['id'], $event);
        }

        markProcessed($event['eventId']);
        $message->ack(); // only now: the database has the event
    },
);

while ($channel->is_consuming()) {
    $channel->wait();
}
```

## Rules

1. **A new id for every PEC,** also when sending again.
2. **Copies happen, receipts included.** At every restart the container reads the receipts of the last 72 hours again, as it remembers nothing, and publishes them again with the same `eventId`. Queues deliver every event at least once, not exactly once. The CRM keeps the `eventId`s it has processed and discards copies: the same fact always has the same `eventId`.
3. **Order is not guaranteed.** An acceptance receipt can arrive before the `sent` event of the same PEC.
4. **An `uncertain` PEC is not sent again blindly.** Its receipts keep coming: if the acceptance arrives, the PEC had left. The mailbox's Sent folder tells too. Only when sure it did not leave, publish it again with a new id.
5. **Receipts are kept by the CRM.** The service keeps no copy. They also stay in the PEC mailbox at the provider, as the service deletes nothing, but only until someone deletes them or the space runs out.
6. **Acknowledge to RabbitMQ only after storing.**
7. **A PEC back in the queue after an interruption is never resent blindly.** If the container stopped while handling it, on restart it looks in the mailbox for a receipt of the provider about that PEC. Found: `sent` with `confirmedBy: "ACCEPTANCE_RECEIPT"`, `attempts: 0` and `sentCopy: "UNKNOWN"`. Not found within a few minutes: `uncertain`.
8. **A suspended mailbox loses no PEC.** When the provider refuses the password, the container publishes `mailbox.suspended`, puts the PEC in hand back in the queue and takes no other until it is restarted with the right password.

## Codes

In `rejected` events every entry of `errors` has `code`, `field` and `detail`.

| Code                                    | Reason                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `INVALID_MESSAGE`                       | The message does not match the format: a missing, wrong or unknown field |
| `RECIPIENT_NOT_PEC`                     | The recipient is not a PEC address                                       |
| `RECIPIENT_UNVERIFIED`                  | Whether the domain is PEC cannot be established                          |
| `FORBIDDEN_ELEMENT`                     | An HTML element that is not allowed, e.g. `<script>`                     |
| `FORBIDDEN_ATTRIBUTE`                   | An HTML attribute that is not allowed, e.g. `onclick`                    |
| `FORBIDDEN_CSS`                         | A style that is not allowed, e.g. `url()`                                |
| `FORBIDDEN_URL`                         | A link with a protocol that is not allowed                               |
| `FORBIDDEN_NODE`, `FORBIDDEN_DIRECTIVE` | Parts of HTML that are not allowed, e.g. a DOCTYPE                       |
| `EXTERNAL_IMAGE`                        | An image loaded from the internet: attach it as an inline image          |
| `UNDECLARED_INLINE_IMAGE`               | The text uses a `cid:` that is not among the images                      |
| `INLINE_IMAGE_NOT_IMAGE`                | An inline image that is not an image                                     |
| `EXECUTABLE`                            | An attachment is a program or a script                                   |
| `EXTENSION_NOT_ALLOWED`                 | An attachment with an extension that is not allowed                      |
| `CONTENT_MISMATCH`                      | An attachment's content does not match its extension                     |
| `MESSAGE_TOO_LARGE`                     | The PEC exceeds the mailbox limit                                        |

In `sent` events the warning `UNUSED_INLINE_IMAGE` flags an image given but not used in the text: the PEC leaves anyway.

In `failed` events `code` is `SMTP_` followed by the provider's code, e.g. `SMTP_550`, or `RETRIES_EXHAUSTED` when temporary errors lasted more than 30 minutes.

## What the service does not do

- It keeps no messages, attachments or receipts: whoever reads the output queue does.
- It offers no search: the state of every PEC is in the CRM.
- It does not count the day's sends. It only keeps the mailbox's pace per minute, so that the provider does not block it.
