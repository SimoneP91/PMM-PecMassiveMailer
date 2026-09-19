# I messaggi di pecmailer: guida per chi spedisce

pecmailer spedisce PEC e riporta indietro cosa è successo. Non conserva niente: né i messaggi, né gli allegati, né le ricevute. Chi mette le PEC in coda e chi legge gli esiti ne tiene traccia.

Ogni container serve un cliente e una sua casella. Serfin con tre caselle ha tre container, ognuno con le sue code.

La descrizione formale, leggibile dai programmi, è in [docs/asyncapi.yaml](../asyncapi.yaml). Per vederla come pagina si può incollare in AsyncAPI Studio (studio.asyncapi.com). Questa guida dice le stesse cose a parole.

## Le code

| Coda                                 | Chi scrive                                                                                            | Chi legge                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `pecmailer.{cliente}.{casella}.in`   | Il CRM: una PEC per messaggio                                                                         | Il container, una PEC alla volta        |
| `pecmailer.{cliente}.{casella}.out`  | Il container: gli esiti e le ricevute                                                                 | Il CRM                                  |
| `pecmailer.{cliente}.{casella}.dead` | RabbitMQ, con i messaggi che il container non riesce a leggere o che lo hanno fatto fermare più volte | Una persona, per capire cosa non andava |

Esempio: `pecmailer.serfin.serfin-aruba.in`.

Le code sono di tipo "quorum": RabbitMQ ne tiene più copie e non perde i messaggi se si riavvia. Il container le crea al primo avvio, se non esistono già. Se le crea chi gestisce RabbitMQ, deve usare esattamente i parametri elencati in [docs/asyncapi.yaml](../asyncapi.yaml).

## Spedire una PEC

Un messaggio JSON per ogni PEC, con questi campi:

| Campo                         | Obbligatorio | Cosa contiene                                                                                                         |
| ----------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `version`                     | sì           | Sempre `1`                                                                                                            |
| `id`                          | sì           | L'identificativo della PEC, scelto dal CRM. Vedi sotto                                                                |
| `reference`                   | no           | Un'etichetta del CRM, per esempio il numero della pratica. Torna uguale negli esiti                                   |
| `batch`                       | no           | Un'etichetta per un gruppo di PEC, per esempio una campagna di solleciti. Torna uguale negli esiti                    |
| `to.address`                  | sì           | L'indirizzo PEC del destinatario                                                                                      |
| `to.name`                     | no           | Il nome del destinatario                                                                                              |
| `subject`                     | sì           | L'oggetto, già completo, senza a capo, al massimo 500 caratteri                                                       |
| `html`                        | sì           | Il testo, già completo, in HTML, al massimo 512 KB                                                                    |
| `attachments`                 | no           | Fino a 50 allegati: `filename` e `content`, cioè il file codificato in base64                                         |
| `inlineImages`                | no           | Fino a 20 immagini nel testo: `cid`, `content` e, se vuoi, `filename`. Nel testo si usano come `<img src="cid:logo">` |
| `options.unverifiedRecipient` | no           | Se il dominio del destinatario non si riesce a classificare: `reject`, il predefinito, oppure `send`                  |

Campi in più, non previsti, fanno rifiutare il messaggio: così un errore di battitura non passa inosservato.

### L'identificativo

L'`id` è la cosa più importante:

- **Deve essere unico per sempre.** Diventa parte del Message-ID della PEC, cioè `<pm.{id}@dominio-mittente>`, e ogni ricevuta lo riporta. È così che una ricevuta ritrova la sua PEC.
- **Stesso id due volte significa due PEC** con ricevute impossibili da distinguere. Una PEC da rispedire prende un id nuovo.
- **Il destinatario lo vede**, perché il Message-ID è visibile. Mai dati personali: va benissimo un UUID.
- Lettere, cifre, punto, trattino e trattino basso; al massimo 64 caratteri.

### I controlli

Prima di spedire, il container controlla tre cose. Se una non va, la PEC non parte e in uscita arriva un esito `rejected` con il motivo:

- l'indirizzo è una PEC: un dominio di posta ordinaria, come gmail.com, viene rifiutato;
- l'HTML rispetta le regole di sicurezza: niente script, moduli, riquadri, immagini esterne, stili con `url()`; i link solo `https`, `http` e `mailto`;
- la PEC intera, allegati compresi, non supera il limite della casella: 30 MB per Aruba.

Il tipo degli allegati si riconosce dal contenuto, non dal nome. Estensioni ammesse: pdf, p7m, xml, txt, csv, rtf, eml, zip, doc, docx, xls, xlsx, ppt, pptx, odt, ods, png, jpg, jpeg, gif. I programmi eseguibili sono sempre rifiutati.

### Esempio

Gli indirizzi degli esempi sono inventati, su domini `.example` che il servizio rifiuterebbe: vanno sostituiti con quelli veri.

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

### Da PHP

Con la libreria `php-amqplib` (`composer require php-amqplib/php-amqplib`). RabbitMQ conferma ogni messaggio che ha salvato; se non lo conferma, la PEC non è in coda e va ripubblicata.

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

$connection = new AMQPStreamConnection('rabbitmq', 5672, 'serfin', getenv('RABBITMQ_PASSWORD'));
$channel = $connection->channel();
$channel->set_nack_handler(function (AMQPMessage $message): void {
    throw new RuntimeException('RabbitMQ non ha salvato la PEC ' . $message->get('message_id'));
});
$channel->confirm_select();

$pec = [
    'version' => 1,
    'id' => bin2hex(random_bytes(16)), // da salvare nel proprio database, insieme alla pratica
    'reference' => 'pratica-4521',
    'to' => ['address' => 'destinatario@pec.example', 'name' => 'Mario Rossi'],
    'subject' => 'Sollecito pratica 4521',
    'html' => '<p>Gentile Mario Rossi,</p><p>le inviamo in allegato il sollecito.</p>',
    'attachments' => [
        ['filename' => 'sollecito.pdf', 'content' => base64_encode(file_get_contents('/percorso/sollecito.pdf'))],
    ],
];

$channel->basic_publish(
    new AMQPMessage(json_encode($pec, JSON_THROW_ON_ERROR), [
        'content_type' => 'application/json',
        'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT, // sopravvive a un riavvio di RabbitMQ
        'message_id' => $pec['id'],
    ]),
    '',                                 // nessuno smistatore: la coda si indica per nome
    'pecmailer.serfin.serfin-aruba.in',
);
$channel->wait_for_pending_acks(5.0);

$channel->close();
$connection->close();
```

## Leggere gli esiti

Ogni messaggio della coda di uscita è un evento JSON. Tutti hanno questi campi: `version`, `event`, `eventId`, `occurredAt`, `tenant`, `mailbox`.

| `event`             | Cosa significa                                                                                                                          | Cosa fare                                                                         |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `sent`              | Il gestore ha preso la PEC. Riporta `messageId`, `sentAt`, la risposta del gestore e `sentCopy`, cioè se la copia in Inviata è riuscita | Aspettare le ricevute                                                             |
| `rejected`          | Non è partita: il messaggio non rispetta una regola. `errors` dice quale                                                                | Correggere e ripubblicare con un id nuovo                                         |
| `failed`            | Non è partita: il gestore l'ha rifiutata, o gli errori temporanei sono durati troppo                                                    | Leggere `code` e `detail`; eventualmente ripubblicare con un id nuovo             |
| `uncertain`         | Non si sa se è partita: la connessione è caduta mentre il gestore aveva già il messaggio, oppure il container si è fermato a metà       | Non rispedire alla cieca: vedi sotto                                              |
| `receipt`           | Una ricevuta del gestore. Contiene il file della ricevuta                                                                               | Conservarla: è la prova legale                                                    |
| `mailbox.suspended` | Il gestore ha rifiutato la password della casella                                                                                       | Correggere la password e riavviare il container. Le PEC restano al sicuro in coda |

Gli esiti di una PEC riportano `id`, `reference` e `batch`. Le ricevute riportano solo `id`: il resto il CRM lo ritrova dall'id.

### Le ricevute

| `receiptType`          | Cos'è                                            | Finale |
| ---------------------- | ------------------------------------------------ | ------ |
| `ACCEPTANCE`           | Il gestore del mittente l'ha accettata           | no     |
| `TAKING_CHARGE`        | Il gestore del destinatario l'ha presa in carico | no     |
| `NON_DELIVERY_WARNING` | Preavviso di mancata consegna                    | no     |
| `DELIVERY`             | Consegnata                                       | sì     |
| `NON_DELIVERY`         | Non consegnata                                   | sì     |
| `NON_ACCEPTANCE`       | Non accettata dal gestore del mittente           | sì     |
| `VIRUS_DETECTED`       | Rifiutata per un virus                           | sì     |

Il campo `final` dice se la PEC ha il suo esito definitivo. Una ricevuta contiene:

- `eml`: la ricevuta intera, così come l'ha mandata il gestore, firma compresa, codificata in base64. **È la prova legale: va conservata.**
- `emlSha256`: la sua impronta, per verificare che il file salvato sia intatto.
- `daticert`: il file `daticert.xml` della ricevuta, in base64.
- `error`: per una mancata consegna, il codice e la spiegazione del gestore. Attenzione: Aruba per una casella inesistente usa il codice generico `altro`, e il motivo vero sta solo nella spiegazione.

### Da PHP

La conferma a RabbitMQ va data solo dopo aver salvato l'evento nel proprio database: se il programma si ferma prima, RabbitMQ riconsegna l'evento e nulla va perso.

```php
<?php
require __DIR__ . '/vendor/autoload.php';

use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

$connection = new AMQPStreamConnection('rabbitmq', 5672, 'serfin', getenv('RABBITMQ_PASSWORD'));
$channel = $connection->channel();
$channel->basic_qos(0, 10, false); // al massimo 10 eventi in lavorazione alla volta

$channel->basic_consume('pecmailer.serfin.serfin-aruba.out', '', false, false, false, false,
    function (AMQPMessage $message): void {
        $event = json_decode($message->getBody(), true, 512, JSON_THROW_ON_ERROR);

        if (giaTrattato($event['eventId'])) { // un doppione: già salvato
            $message->ack();
            return;
        }

        switch ($event['event']) {
            case 'receipt':
                $file = base64_decode($event['eml'], true);
                if ($file === false || hash('sha256', $file) !== $event['emlSha256']) {
                    throw new RuntimeException('Ricevuta danneggiata: ' . $event['eventId']);
                }
                salvaRicevuta($event['id'], $event['receiptType'], $event['final'], $file);
                break;
            default:
                aggiornaEsito($event['id'], $event);
        }

        segnaTrattato($event['eventId']);
        $message->ack(); // solo ora: il database ha l'evento
    },
);

while ($channel->is_consuming()) {
    $channel->wait();
}
```

## Regole da rispettare

1. **Un id nuovo per ogni PEC,** anche quando si rispedisce.
2. **I doppioni arrivano, anche per le ricevute.** A ogni riavvio il container rilegge le ricevute delle ultime 24 ore, perché non ricorda dove era arrivato, e le ripubblica con lo stesso `eventId`. Le code consegnano ogni evento almeno una volta, non esattamente una. Il CRM tiene gli `eventId` già trattati e scarta le copie: lo stesso fatto ha sempre lo stesso `eventId`.
3. **L'ordine non è garantito.** Una ricevuta di accettazione può arrivare prima dell'evento `sent` della stessa PEC.
4. **Una PEC `uncertain` non si rispedisce alla cieca.** Le sue ricevute continuano ad arrivare: se arriva l'accettazione, la PEC era partita. Si può anche guardare la cartella Inviata della casella. Solo se si è sicuri che non è partita, si ripubblica con un id nuovo.
5. **Le ricevute si conservano.** Il servizio non ne tiene copia. Restano anche nella casella PEC presso il gestore, perché il servizio non cancella nulla, ma solo finché qualcuno non le cancella o finisce lo spazio.
6. **La conferma a RabbitMQ va data solo dopo aver salvato.**
7. **Una PEC tornata in coda dopo un'interruzione non viene mai rispedita alla cieca.** Se il container si è fermato mentre la gestiva, al riavvio cerca nella casella una ricevuta del gestore per quella PEC. Se la trova, pubblica `sent` con `confirmedBy: "ACCEPTANCE_RECEIPT"`, `attempts: 0` e `sentCopy: "UNKNOWN"`. Se non la trova entro qualche minuto, pubblica `uncertain`.
8. **Una casella sospesa non perde le PEC.** Se il gestore rifiuta la password, il container pubblica `mailbox.suspended`, rimette in coda la PEC che aveva in mano e non ne prende altre finché non viene riavviato con la password giusta.
9. **In casi rarissimi una PEC riceve due esiti diversi.** Succede se il container si ferma nell'istante fra la pubblicazione di un esito e la conferma a RabbitMQ: al riavvio la PEC torna in coda e riceve un secondo esito, per esempio `failed` e poi `uncertain`. Si tratta come un `uncertain`: le ricevute dicono com'è andata.

## Codici

Negli eventi `rejected`, ogni voce di `errors` ha `code`, `field` e `detail`.

| Codice                                  | Motivo                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `INVALID_MESSAGE`                       | Il messaggio non rispetta il formato: campo mancante, sbagliato o in più |
| `RECIPIENT_NOT_PEC`                     | Il destinatario non è un indirizzo PEC                                   |
| `RECIPIENT_UNVERIFIED`                  | Non si riesce a stabilire se il dominio è PEC                            |
| `FORBIDDEN_ELEMENT`                     | Un elemento HTML non ammesso, per esempio `<script>`                     |
| `FORBIDDEN_ATTRIBUTE`                   | Un attributo HTML non ammesso, per esempio `onclick`                     |
| `FORBIDDEN_CSS`                         | Uno stile non ammesso, per esempio `url()`                               |
| `FORBIDDEN_URL`                         | Un link con un protocollo non ammesso                                    |
| `FORBIDDEN_NODE`, `FORBIDDEN_DIRECTIVE` | Parti dell'HTML non ammesse, per esempio un DOCTYPE                      |
| `EXTERNAL_IMAGE`                        | Un'immagine caricata da internet: vanno allegate come immagini nel testo |
| `UNDECLARED_INLINE_IMAGE`               | Il testo usa un `cid:` che non è tra le immagini                         |
| `INLINE_IMAGE_NOT_IMAGE`                | Un'immagine nel testo che non è un'immagine                              |
| `EXECUTABLE`                            | Un allegato è un programma o uno script                                  |
| `EXTENSION_NOT_ALLOWED`                 | Un allegato con un'estensione non ammessa                                |
| `CONTENT_MISMATCH`                      | Il contenuto di un allegato non corrisponde alla sua estensione          |
| `MESSAGE_TOO_LARGE`                     | La PEC supera il limite della casella                                    |

Negli eventi `sent`, l'avviso `UNUSED_INLINE_IMAGE` segnala un'immagine allegata ma non usata nel testo: la PEC parte lo stesso.

Negli eventi `failed`, `code` è `SMTP_` seguito dal codice del gestore, per esempio `SMTP_550`, oppure `RETRIES_EXHAUSTED` quando gli errori temporanei continuano anche all'ultimo tentativo: con le impostazioni normali, circa 21 minuti dopo il primo.

## Cosa il servizio non fa

- Non conserva messaggi, allegati né ricevute: se ne occupa chi legge la coda di uscita.
- Non offre ricerche: lo stato di ogni PEC è nel CRM.
- Non conta gli invii del giorno. Rispetta solo il ritmo al minuto della casella, perché il gestore non la blocchi.
