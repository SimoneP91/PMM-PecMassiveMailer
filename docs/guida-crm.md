# pecmailer — guida per il CRM e per il suo assistente AI

Questa guida spiega come il CRM spedisce PEC tramite pecmailer e come gestisce tutto quello che torna indietro. È scritta perché un assistente AI che lavora nel progetto del CRM la segua da sola, senza vedere il progetto pecmailer; vale uguale per una persona.

> **Per chi la installa.** Copia questo file nel progetto del CRM, per esempio in `docs/pecmailer.md`, e aggiungi al `CLAUDE.md` del CRM (o crealo) la riga:
> `Per tutto ciò che riguarda l'invio di PEC, leggi e segui docs/pecmailer.md.`
> Vale per pecmailer 0.6.x, contratto dei messaggi versione 1.

## 1. Cos'è pecmailer, in breve

pecmailer è un servizio che spedisce PEC. Gira in container: uno per ogni casella PEC. Il CRM **non lo chiama mai direttamente**: gli parla solo attraverso RabbitMQ, un sistema di code. Una coda è una cassetta delle lettere: chi scrive lascia un messaggio, chi legge lo prende quando è pronto, e nel frattempo il messaggio è al sicuro.

```
CRM ──(1) mette la PEC──► pecmailer.<cliente>.<casella>.in  ──► pecmailer ──► gestore PEC ──► destinatario
CRM ◄─(2) legge gli esiti── pecmailer.<cliente>.<casella>.out ◄──┘
                            pecmailer.<cliente>.<casella>.dead  (messaggi illeggibili: li guarda una persona)
```

- Ogni casella ha le sue tre code. Esempio: `pecmailer.serfin.serfin-legalmail.in`.
- pecmailer **non conserva niente**: né i messaggi, né gli allegati, né le ricevute. Lo stato di ogni PEC e le ricevute, che sono la prova legale, li tiene **il CRM**.
- pecmailer rispetta da solo il ritmo della casella, deciso da chi lo installa: 60 PEC al minuto come valore predefinito, meno nei primi tempi in produzione. Il CRM può mettere in coda migliaia di PEC in un colpo; partiranno al ritmo giusto.
- pecmailer **non offre ricerche** (lo stato di ogni PEC è nel CRM) e **non conta gli invii del giorno**: rispetta solo il ritmo al minuto, perché il gestore non blocchi la casella.
- Per ogni PEC, pecmailer pubblica un **esito** (partita, rifiutata, fallita, incerta) e poi ogni **ricevuta** del gestore man mano che arriva.

## 2. Le regole che non si discutono

1. **Una PEC non deve mai partire due volte.** Ogni invio ha un `id` nuovo, un UUID generato dal CRM e mai riusato. Una PEC da rispedire prende un id nuovo. L'`id` **non** è l'identificativo del record del CRM: quello va in `reference` (sezione 5).
2. **Prima il database, poi la coda.** La PEC si registra nel database del CRM _prima_ di metterla in coda: così non esiste mai una PEC di cui il CRM non sa niente.
3. **Un esito non deve mai andare perso.** Il CRM conferma a RabbitMQ di aver ricevuto un evento (`ack`) solo _dopo_ averlo salvato nel database, nella stessa transazione.
4. **I doppioni sono normali.** Lo stesso evento può arrivare due volte (dopo un riavvio pecmailer ripubblica le ricevute delle ultime 24 ore). Ogni evento ha un `eventId` stabile: il CRM tiene quelli già visti e scarta le copie.
5. **Le ricevute sono la prova legale**: si salvano intere, così come arrivano, controllandone l'impronta SHA-256, e si conservano per il tempo previsto dalle regole aziendali. Restano anche nella casella PEC presso il gestore, perché pecmailer non cancella nulla, ma solo finché qualcuno non le cancella o lo spazio non finisce: la copia che fa fede è quella del CRM.
6. **Le code sono di pecmailer.** Il CRM non le crea, non le cancella, non le svuota e non ne cambia le impostazioni. Scrive solo nelle code `.in` e legge solo dalle code `.out`.
7. **Nessuna credenziale nel codice.** L'utente e la password di RabbitMQ arrivano da variabili d'ambiente o dal gestore dei segreti del CRM.

## 3. Direttive per l'assistente AI del CRM

- Prima di scrivere codice, **esplora il CRM**: versione di PHP, framework (o codice scritto a mano), database, come gira in produzione, e come spedisce le PEC oggi. **Chiedi prima di togliere o cambiare il vecchio sistema di invio.**
- Adatta il codice di riferimento della sezione 8 alle convenzioni del CRM (cartelle, nomi, migrazioni, test), **ma senza cambiare il comportamento** descritto nelle sezioni 2, 5 e 6.
- **Non cambiare il formato dei messaggi.** Se serve qualcosa che il contratto non prevede, fermati e chiedi: il contratto si cambia da parte di pecmailer.
- **Non spedire mai PEC vere** e non puntare mai a code di produzione senza una richiesta esplicita. Per le prove c'è lo stack locale (sezione 10).
- **Non scrivere mai password** nel codice, nei file di configurazione versionati o nella chat.
- Ogni regola di stato (sezione 6) ha un test. Gli eventi di esempio della sezione 9 sono pronti per i test.
- Pubblicare e leggere gli esiti sono **due processi separati**: chi mette le PEC in coda (una pagina, un'attività di campagna) non aspetta gli esiti.
- Rispetta le regole del progetto CRM su commit e revisioni.

## 4. Cosa serve

| Cosa         | Dettaglio                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PHP          | 8.0 o superiore (il codice di riferimento usa `match` e le proprietà nel costruttore)                                                                                                                                                                                                                                          |
| Libreria     | `php-amqplib/php-amqplib` (`composer require php-amqplib/php-amqplib`), che richiede le estensioni `sockets` e `mbstring`                                                                                                                                                                                                      |
| Memoria      | `memory_limit` di almeno 256 MB: una PEC da 30 MB diventa circa 40 MB dentro il messaggio, e una ricevuta di consegna contiene la PEC intera                                                                                                                                                                                   |
| RabbitMQ     | Indirizzo, porta, virtual host, utente e password: li fornisce chi gestisce l'infrastruttura. Un utente per il CRM, senza diritti di amministrazione. Se più clienti condividono lo stesso RabbitMQ, ognuno ha il suo virtual host: i permessi sulle code da soli non impediscono di pubblicare nelle code di un altro cliente |
| Le caselle   | L'elenco dei codici casella (es. `serfin-legalmail`) e quale usare per quale tipo di PEC: è una scelta del CRM                                                                                                                                                                                                                 |
| Spazio disco | Una cartella per i file delle ricevute, compresa nei backup                                                                                                                                                                                                                                                                    |

Variabili d'ambiente suggerite: `RABBITMQ_HOST`, `RABBITMQ_PORT` (5672, o 5671 con TLS), `RABBITMQ_VHOST`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`, `PECMAILER_CLIENTE` (es. `serfin`), `PECMAILER_CASELLE` (es. `serfin-legalmail,serfin-aruba`), `PEC_CARTELLA_RICEVUTE`.

## 5. Il contratto dei messaggi

### La PEC da spedire (coda `.in`)

Un messaggio JSON per ogni PEC, con proprietà AMQP `content_type: application/json`, `delivery_mode: 2` (persistente) e `message_id` uguale all'`id`.

| Campo                         | Obbligatorio | Regole                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                     | sì           | Sempre `1`                                                                                                                                                                                                                                                                                                 |
| `id`                          | sì           | **Un UUID nuovo per ogni invio** (32 caratteri esadecimali casuali: `bin2hex(random_bytes(16))`), unico per sempre. Lettere, cifre, `.`, `_`, `-`; da 1 a 64 caratteri. **Non** l'identificativo del record: quello va in `reference`. Il destinatario lo vede dentro il Message-ID: niente dati personali |
| `reference`                   | no           | L'identificativo del record nel CRM, es. `32900738`, o il numero di pratica; al massimo 200 caratteri. Torna negli esiti                                                                                                                                                                                   |
| `batch`                       | no           | Etichetta di gruppo, es. la campagna; al massimo 200 caratteri. Torna negli esiti                                                                                                                                                                                                                          |
| `to.address`                  | sì           | Indirizzo PEC del destinatario; al massimo 254 caratteri                                                                                                                                                                                                                                                   |
| `to.name`                     | no           | Nome del destinatario; al massimo 200 caratteri, senza a capo                                                                                                                                                                                                                                              |
| `subject`                     | sì           | Oggetto già completo; da 1 a 500 caratteri, senza a capo                                                                                                                                                                                                                                                   |
| `html`                        | sì           | Testo già completo in HTML; al massimo 512 KB                                                                                                                                                                                                                                                              |
| `attachments`                 | no           | Fino a 50: `{ "filename": "...", "content": "<base64>" }`                                                                                                                                                                                                                                                  |
| `inlineImages`                | no           | Fino a 20 immagini nel testo: `{ "cid": "logo", "content": "<base64>", "filename": "..." }`, usate come `<img src="cid:logo">`                                                                                                                                                                             |
| `options.unverifiedRecipient` | no           | `reject` (predefinito) o `send`: cosa fare se non si riesce a stabilire che il dominio è PEC                                                                                                                                                                                                               |

Campi non previsti fanno rifiutare il messaggio. La PEC intera, allegati compresi, non deve superare il limite della casella (30 MB con le impostazioni normali): gli allegati, che vengono ricodificati, possono arrivare a circa 22 MB in tutto.

**Perché l'`id` non si riusa mai.** Diventa il Message-ID della PEC, `<pm.{id}@dominio-mittente>`, e ogni ricevuta lo cita. Se lo stesso id viene usato per due invii, anche a giorni di distanza:

1. la seconda PEC parte comunque: pecmailer non ricorda gli id già usati;
2. le ricevute delle due PEC si confondono, perché citano lo stesso Message-ID;
3. il `sent` della seconda ha lo stesso `eventId` del primo (`sent:<id>`), e il CRM lo scarta come doppione;
4. il caso più grave: se la seconda PEC viene interrotta da un crash prima di partire, pecmailer cerca la ricevuta di accettazione di quel Message-ID, trova quella della prima PEC (la ricerca non guarda la data) e dichiara `sent` una PEC mai partita.

Per questo un record del CRM può avere più invii, ognuno con il suo UUID, tutti con la stessa `reference`.

Cosa pecmailer controlla prima di spedire. Se qualcosa non va, la PEC non parte e arriva un esito `rejected`:

- **Destinatario**: deve essere un indirizzo PEC; i domini di posta ordinaria, come gmail.com, sono rifiutati.
- **HTML**: elenco chiuso di elementi; niente script, moduli, riquadri, immagini esterne, stili con `url()`; link solo `https`, `http`, `mailto`. Le immagini vanno allegate come `inlineImages`.
- **Allegati**: il tipo si riconosce dal contenuto, non dal nome. Estensioni ammesse: pdf, p7m, xml, txt, csv, rtf, eml, zip, doc, docx, xls, xlsx, ppt, pptx, odt, ods, png, jpg, jpeg, gif. Eseguibili e script sempre rifiutati.

### Gli eventi (coda `.out`)

Ogni evento è JSON e ha sempre: `version` (1), `event`, `eventId`, `occurredAt` (data ISO), `tenant`, `mailbox`. La proprietà AMQP `type` è il nome dell'evento, `message_id` è l'`eventId`.

| `event`             | `eventId`                            | Campi propri                                                                                                                                                                                                          | Significato                                                                                                                                    |
| ------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sent`              | `sent:<id>`                          | `id`, `reference`, `batch`, `messageId`, `sentAt`, `confirmedBy` (`SMTP` o `ACCEPTANCE_RECEIPT`), `smtpResponse`, `attempts`, `sentCopy` (`ARCHIVED`, `FAILED`, `DISABLED`, `UNKNOWN`), `sentCopyError`, `warnings[]` | Il gestore ha preso la PEC                                                                                                                     |
| `rejected`          | `rejected:<id>`                      | `id`, `reference`, `batch`, `errors[]` (`code`, `field`, `detail`)                                                                                                                                                    | Non è partita: il messaggio non rispetta una regola                                                                                            |
| `failed`            | `failed:<id>`                        | `id`, `reference`, `batch`, `code`, `smtpCode`, `detail`, `attempts`                                                                                                                                                  | Non è partita: il gestore l'ha rifiutata, o gli errori temporanei sono continuati fino all'ultimo tentativo (circa 21 minuti)                  |
| `uncertain`         | `uncertain:<id>`                     | `id`, `reference`, `batch`, `messageId`, `reason`, `detail`                                                                                                                                                           | Non si sa se è partita                                                                                                                         |
| `receipt`           | `receipt:<sha256>`                   | `id`, `messageId`, `receiptType`, `final`, `issuedAt`, `provider`, `recipient`, `error` (`code`, `detail`), `providerId`, `receiptMessageId`, `eml` (base64), `emlSha256`, `daticert` (base64)                        | Una ricevuta del gestore, intera                                                                                                               |
| `mailbox.suspended` | `mailbox.suspended:<casella>:<data>` | `cause` (`SMTP_AUTH_REFUSED` o `IMAP_AUTH_REFUSED`), `detail`                                                                                                                                                         | Il gestore ha rifiutato la password: la casella è ferma finché non viene riavviata con quella giusta. Le PEC aspettano in coda, non si perdono |

I campi `reference`, `batch`, `smtpResponse`, `sentCopyError`, `smtpCode`, `provider`, `recipient`, `error`, `providerId`, `receiptMessageId` e `daticert` possono mancare. Le ricevute riportano solo `id`: il resto il CRM lo ritrova dall'id.

| `receiptType`          | Cos'è                                                                                                              | `final` |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ | ------- |
| `ACCEPTANCE`           | Il gestore del mittente l'ha accettata: da qui la PEC ha valore legale                                             | no      |
| `TAKING_CHARGE`        | Il gestore del destinatario l'ha presa in carico                                                                   | no      |
| `NON_DELIVERY_WARNING` | Preavviso di mancata consegna                                                                                      | no      |
| `DELIVERY`             | Consegnata                                                                                                         | sì      |
| `NON_DELIVERY`         | Non consegnata; il motivo è in `error.detail` (Aruba, per una casella inesistente, usa il codice generico `altro`) | sì      |
| `NON_ACCEPTANCE`       | Non accettata dal gestore del mittente                                                                             | sì      |
| `VIRUS_DETECTED`       | Rifiutata per un virus                                                                                             | sì      |

Negli eventi `rejected`, ogni voce di `errors` ha `code`, `field` (quando riguarda un campo preciso) e `detail`. Vengono elencati tutti i problemi del messaggio, non solo il primo.

| Codice di `rejected`                    | Motivo                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `INVALID_MESSAGE`                       | Il messaggio non rispetta il formato: campo mancante, sbagliato o in più |
| `RECIPIENT_NOT_PEC`                     | Il destinatario non è un indirizzo PEC                                   |
| `RECIPIENT_UNVERIFIED`                  | Non si riesce a stabilire se il dominio è PEC                            |
| `FORBIDDEN_ELEMENT`                     | Un elemento HTML non ammesso, per esempio `<script>`                     |
| `FORBIDDEN_ATTRIBUTE`                   | Un attributo HTML non ammesso, per esempio `onclick`                     |
| `FORBIDDEN_CSS`                         | Uno stile non ammesso, per esempio `url()`                               |
| `FORBIDDEN_URL`                         | Un link con un protocollo non ammesso                                    |
| `FORBIDDEN_NODE`, `FORBIDDEN_DIRECTIVE` | Parti dell'HTML non ammesse, per esempio un DOCTYPE                      |
| `EXTERNAL_IMAGE`                        | Un'immagine caricata da internet: va passata come immagine nel testo     |
| `UNDECLARED_INLINE_IMAGE`               | Il testo usa un `cid:` che non è tra le immagini                         |
| `INLINE_IMAGE_NOT_IMAGE`                | Un'immagine nel testo che non è PNG, JPEG o GIF                          |
| `EXECUTABLE`                            | Un allegato è un programma o uno script                                  |
| `EXTENSION_NOT_ALLOWED`                 | Un allegato con un'estensione non ammessa                                |
| `CONTENT_MISMATCH`                      | Il contenuto di un allegato non corrisponde alla sua estensione          |
| `MESSAGE_TOO_LARGE`                     | La PEC supera il limite della casella                                    |

Negli eventi `failed`, `code` è `SMTP_` seguito dal codice del gestore (es. `SMTP_550`), oppure `RETRIES_EXHAUSTED` quando gli errori temporanei continuano fino all'ultimo tentativo. Negli eventi `sent`, l'avviso `UNUSED_INLINE_IMAGE` segnala un'immagine allegata ma non usata: la PEC parte lo stesso. Un `sent` confermato dalla ricevuta dopo un'interruzione ha `confirmedBy: "ACCEPTANCE_RECEIPT"`, `attempts: 0` e `sentCopy: "UNKNOWN"`.

Il contratto cresce solo aggiungendo campi o eventi: il CRM deve **ignorare i campi che non conosce** e conservare gli eventi che non conosce senza fermarsi. Una `version` diversa da 1 invece vuol dire un contratto nuovo: il CRM non la tratta e lo segnala.

## 6. Gli stati di una PEC nel CRM

| Stato            | Quando                                                          | Cosa fare                                                                                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IN_ACCODAMENTO` | Registrata; la pubblicazione è in corso o non ha avuto risposta | Niente. Se resta così più di 35 minuti, un avviso chiama una persona (vedi sotto)                                                                                                                                                             |
| `DA_ACCODARE`    | RabbitMQ ha detto esplicitamente di no, o la coda non esiste    | Il controllo periodico la ripubblica **con lo stesso id**: è sicuro, perché RabbitMQ non l'ha salvata                                                                                                                                         |
| `IN_CODA`        | RabbitMQ ha confermato di averla salvata                        | Aspettare                                                                                                                                                                                                                                     |
| `RIFIUTATA`      | Esito `rejected`                                                | Correggere e rispedire con **un id nuovo**                                                                                                                                                                                                    |
| `FALLITA`        | Esito `failed`                                                  | Leggere il motivo; eventualmente rispedire con **un id nuovo**                                                                                                                                                                                |
| `DA_VERIFICARE`  | Esito `uncertain`                                               | **Mai rispedire alla cieca.** Se arriva l'accettazione, lo stato passa da solo ad `ACCETTATA`. Altrimenti una persona controlla (cartella Inviata della casella, ricevute) e solo se è sicura che non è partita la rispedisce con un id nuovo |
| `SPEDITA`        | Esito `sent`                                                    | Aspettare le ricevute                                                                                                                                                                                                                         |
| `ACCETTATA`      | Ricevuta `ACCEPTANCE`                                           | Aspettare la consegna                                                                                                                                                                                                                         |
| `CONSEGNATA`     | Ricevuta `DELIVERY`                                             | Finita                                                                                                                                                                                                                                        |
| `NON_CONSEGNATA` | Ricevuta `NON_DELIVERY`, `NON_ACCEPTANCE` o `VIRUS_DETECTED`    | Finita; il motivo è nel dettaglio                                                                                                                                                                                                             |

**Lo stato cambia solo verso un'informazione più sicura**, secondo questo ordine:

| Rango | Stati                           |
| ----- | ------------------------------- |
| 0     | `IN_ACCODAMENTO`, `DA_ACCODARE` |
| 1     | `IN_CODA`                       |
| 2     | `RIFIUTATA`, `FALLITA`          |
| 3     | `DA_VERIFICARE`                 |
| 4     | `SPEDITA`                       |
| 5     | `ACCETTATA`                     |
| 6     | `CONSEGNATA`, `NON_CONSEGNATA`  |

Un evento che porterebbe a un rango uguale o più basso viene conservato ma non cambia lo stato. Così:

- una ricevuta arrivata prima dell'esito `sent`, cosa che può succedere, non viene scavalcata;
- i doppioni non fanno danni;
- nel caso rarissimo di due esiti diversi per la stessa PEC (per esempio `failed` e poi `uncertain`, se pecmailer si ferma nell'istante sbagliato), vince `DA_VERIFICARE`, come deve;
- `TAKING_CHARGE` e `NON_DELIVERY_WARNING` si conservano ma non cambiano lo stato.

**`IN_ACCODAMENTO` da più di 35 minuti** vuol dire che RabbitMQ non ha risposto, o che il processo si è fermato mentre pubblicava: la PEC potrebbe essere in coda oppure no. Ripubblicarla alla cieca rischia un doppio invio, quindi decide una persona. È sicuro ripubblicarla con lo stesso id solo se, nella pagina di RabbitMQ, le code `.in` e `.out` di quella casella sono vuote (anche la colonna "Unacked" a zero) e per quell'id non è arrivato nessun evento. In quel caso la si porta a `DA_ACCODARE` e il controllo periodico la ripubblica. È un caso raro.

**Se si perde il disco di RabbitMQ** (lo segnala chi gestisce l'infrastruttura), si perdono le PEC ancora in coda e gli esiti che il CRM non aveva ancora letto: alcune PEC rimaste `IN_CODA` potrebbero essere già partite, con l'esito perso insieme al disco. Non si ripubblicano subito. Prima si lascia che pecmailer ripubblichi le ricevute che trova nella casella (lo fa da solo al riavvio, per le ultime 24 ore): le PEC partite passano ad `ACCETTATA`. Solo quelle rimaste `IN_CODA` senza nessuna ricevuta si ripubblicano, con lo stesso id. È un caso raro.

## 7. Come è fatta la parte CRM

1. **Le tabelle** `pec_invii`, `pec_eventi` e `pec_ricevute` (sezione 8.1).
2. **La classe che mette in coda** (8.2): registra la PEC, la pubblica, aspetta la conferma di RabbitMQ.
3. **Il lettore degli esiti** (8.3): un programma sempre acceso che legge le code `.out` di tutte le caselle, scarta i doppioni, aggiorna gli stati, salva le ricevute, e conferma a RabbitMQ solo dopo aver salvato. Va tenuto acceso da qualcosa che lo riavvia se si ferma: supervisord, systemd, un container. Uno basta per tutte le caselle di un cliente.
4. **Il controllo periodico** (8.4), per esempio ogni 5 minuti: ripubblica le PEC `DA_ACCODARE` e manda gli avvisi.
5. **Gli avvisi** a una persona: casella sospesa, PEC da verificare, PEC ferme troppo a lungo in uno stato intermedio.
6. **Le pagine del CRM**: stato di ogni PEC per pratica e per campagna, scaricamento delle ricevute.

Una PEC da rispedire si costruisce sempre dai dati del CRM: la stessa funzione che la costruisce la prima volta la ricostruisce per ripubblicarla con lo stesso id. Così non serve conservare il messaggio, che con gli allegati può pesare decine di MB.

## 8. Codice di riferimento

PHP 8, PDO e MySQL; nessun framework. Va adattato al CRM, mantenendone il comportamento.

### 8.1 Le tabelle

```sql
CREATE TABLE pec_invii (
  id            CHAR(32)     NOT NULL PRIMARY KEY,  -- l'id dato a pecmailer
  casella       VARCHAR(63)  NOT NULL,              -- es. serfin-legalmail
  pratica       VARCHAR(200) NULL,                  -- il "reference"
  campagna      VARCHAR(200) NULL,                  -- il "batch"
  destinatario  VARCHAR(254) NOT NULL,
  oggetto       VARCHAR(500) NOT NULL,
  stato         VARCHAR(20)  NOT NULL,
  dettaglio     TEXT         NULL,                  -- motivo di un rifiuto, di un errore, di una mancata consegna
  message_id    VARCHAR(320) NULL,
  creata_il     DATETIME     NOT NULL,
  aggiornata_il DATETIME     NOT NULL,
  INDEX (stato, aggiornata_il), INDEX (pratica), INDEX (campagna)
);

CREATE TABLE pec_eventi (                           -- gli eventi già trattati: così si scartano i doppioni
  event_id    VARCHAR(150) NOT NULL PRIMARY KEY,
  pec_id      CHAR(32)     NULL,
  tipo        VARCHAR(30)  NOT NULL,
  ricevuto_il DATETIME     NOT NULL,
  INDEX (pec_id)
);

CREATE TABLE pec_ricevute (
  event_id   VARCHAR(150) NOT NULL PRIMARY KEY,
  pec_id     CHAR(32)     NOT NULL,
  tipo       VARCHAR(30)  NOT NULL,                 -- ACCEPTANCE, DELIVERY, NON_DELIVERY...
  emessa_il  DATETIME     NOT NULL,
  eml_sha256 CHAR(64)     NOT NULL,
  percorso   VARCHAR(500) NOT NULL,                 -- dove sta il file .eml: la prova legale
  INDEX (pec_id)
);
```

### 8.2 Mettere in coda

```php
<?php
declare(strict_types=1);

use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Exception\AMQPTimeoutException;
use PhpAmqpLib\Message\AMQPMessage;

/**
 * Mette le PEC nelle code di pecmailer. Una connessione per processo: per una
 * campagna, un solo oggetto e un giro su tutte le PEC.
 */
final class CodaPec
{
    private AMQPChannel $canale;
    private ?bool $confermata = null;
    private bool $respinta = false;

    public function __construct(
        private PDO $db,
        AMQPStreamConnection $rabbit,
        private string $cliente,                     // es. "serfin"
    ) {
        $this->canale = $rabbit->channel();
        $this->canale->set_ack_handler(function (): void { $this->confermata = true; });    // salvata
        $this->canale->set_nack_handler(function (): void { $this->confermata = false; });  // non salvata
        $this->canale->set_return_listener(function (): void { $this->respinta = true; });  // coda inesistente
        $this->canale->confirm_select();
    }

    /**
     * Registra una PEC nuova e la mette in coda. $pec contiene i campi del
     * contratto tranne "version" e "id". Restituisce l'id, da tenere con la pratica.
     */
    public function accoda(string $casella, array $pec): string
    {
        $id = bin2hex(random_bytes(16));
        $this->db->prepare(
            "INSERT INTO pec_invii (id, casella, pratica, campagna, destinatario, oggetto, stato, creata_il, aggiornata_il)
             VALUES (?, ?, ?, ?, ?, ?, 'IN_ACCODAMENTO', NOW(), NOW())"
        )->execute([$id, $casella, $pec['reference'] ?? null, $pec['batch'] ?? null, $pec['to']['address'], $pec['subject']]);
        $this->pubblica($id, $casella, $pec);

        return $id;
    }

    /** Ripubblica una PEC DA_ACCODARE: RabbitMQ non l'aveva salvata, quindi lo stesso id è sicuro. */
    public function ripubblica(string $id, string $casella, array $pec): void
    {
        $presa = $this->db->prepare(
            "UPDATE pec_invii SET stato = 'IN_ACCODAMENTO', aggiornata_il = NOW() WHERE id = ? AND stato = 'DA_ACCODARE'"
        );
        $presa->execute([$id]);
        if ($presa->rowCount() !== 1) {
            throw new RuntimeException("La PEC $id non è DA_ACCODARE: non si ripubblica");
        }
        $this->pubblica($id, $casella, $pec);
    }

    private function pubblica(string $id, string $casella, array $pec): void
    {
        $this->confermata = null;
        $this->respinta = false;
        $messaggio = new AMQPMessage(
            json_encode(['version' => 1, 'id' => $id] + $pec, JSON_THROW_ON_ERROR),
            [
                'content_type' => 'application/json',
                'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT, // sopravvive a un riavvio di RabbitMQ
                'message_id' => $id,
            ],
        );
        // L'ultimo "true" (mandatory) fa tornare indietro il messaggio se la coda non esiste:
        // senza, con un nome di casella sbagliato, la PEC sparirebbe in silenzio.
        $this->canale->basic_publish($messaggio, '', "pecmailer.{$this->cliente}.$casella.in", true);

        try {
            $this->canale->wait_for_pending_acks_returns(10.0);
        } catch (AMQPTimeoutException) {
            return; // nessuna risposta: resta IN_ACCODAMENTO (sezione 6)
        }
        if ($this->respinta || $this->confermata === false) {
            $this->cambiaStato($id, 'DA_ACCODARE');
            if ($this->respinta) {
                throw new RuntimeException("La coda pecmailer.{$this->cliente}.$casella.in non esiste");
            }
            return;
        }
        if ($this->confermata === true) {
            $this->cambiaStato($id, 'IN_CODA');
        }
    }

    private function cambiaStato(string $id, string $stato): void
    {
        // Solo da IN_ACCODAMENTO: un esito arrivato nel frattempo non viene scavalcato.
        $this->db->prepare(
            "UPDATE pec_invii SET stato = ?, aggiornata_il = NOW() WHERE id = ? AND stato = 'IN_ACCODAMENTO'"
        )->execute([$stato, $id]);
    }
}
```

Esempio d'uso:

```php
$rabbit = new AMQPStreamConnection(
    getenv('RABBITMQ_HOST'), (int) getenv('RABBITMQ_PORT'),
    getenv('RABBITMQ_USER'), getenv('RABBITMQ_PASSWORD'), getenv('RABBITMQ_VHOST') ?: '/',
);
$coda = new CodaPec($db, $rabbit, getenv('PECMAILER_CLIENTE'));

$id = $coda->accoda('serfin-legalmail', [
    'reference' => 'pratica-4521',
    'batch' => 'solleciti-2026-09',
    'to' => ['address' => 'destinatario@pec.it', 'name' => 'Mario Rossi'],
    'subject' => 'Sollecito pratica 4521',
    'html' => '<p>Gentile Mario Rossi, ...</p>',
    'attachments' => [
        ['filename' => 'sollecito.pdf', 'content' => base64_encode(file_get_contents('/percorso/sollecito.pdf'))],
    ],
]);
```

### 8.3 Il lettore degli esiti

```php
<?php
declare(strict_types=1);
require __DIR__ . '/vendor/autoload.php';

use PhpAmqpLib\Connection\AMQPStreamConnection;
use PhpAmqpLib\Message\AMQPMessage;

/** Lo stato cambia solo verso un'informazione più sicura (sezione 6). */
const RANGO = [
    'IN_ACCODAMENTO' => 0, 'DA_ACCODARE' => 0, 'IN_CODA' => 1,
    'RIFIUTATA' => 2, 'FALLITA' => 2, 'DA_VERIFICARE' => 3, 'SPEDITA' => 4,
    'ACCETTATA' => 5, 'CONSEGNATA' => 6, 'NON_CONSEGNATA' => 6,
];

$db = new PDO(getenv('DB_DSN'), getenv('DB_USER'), getenv('DB_PASSWORD'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$rabbit = new AMQPStreamConnection(
    getenv('RABBITMQ_HOST'), (int) getenv('RABBITMQ_PORT'),
    getenv('RABBITMQ_USER'), getenv('RABBITMQ_PASSWORD'), getenv('RABBITMQ_VHOST') ?: '/',
);
$canale = $rabbit->channel();
$canale->basic_qos(0, 10, false); // al massimo 10 eventi in lavorazione alla volta

$gestisci = function (AMQPMessage $messaggio) use ($db): void {
    $db->beginTransaction();
    try {
        $evento = json_decode($messaggio->getBody(), true, 512, JSON_THROW_ON_ERROR);
        $nuovo = $db->prepare('INSERT IGNORE INTO pec_eventi (event_id, pec_id, tipo, ricevuto_il) VALUES (?, ?, ?, NOW())');
        $nuovo->execute([$evento['eventId'], $evento['id'] ?? null, $evento['event']]);
        if ($nuovo->rowCount() === 1) {   // 0 = già visto: è un doppione, si conferma e basta
            applica($db, $evento);
        }
        $db->commit();
        $messaggio->ack();                // solo ora: il database ha l'evento
    } catch (Throwable $errore) {
        $db->rollBack();
        error_log('pecmailer: evento non salvato, riprovo: ' . $errore->getMessage());
        sleep(5);                         // niente giri a vuoto se il problema persiste
        $messaggio->nack(true);           // torna in coda
    }
};

$cliente = getenv('PECMAILER_CLIENTE');
foreach (explode(',', getenv('PECMAILER_CASELLE')) as $casella) {
    $canale->basic_consume("pecmailer.$cliente." . trim($casella) . '.out', '', false, false, false, false, $gestisci);
}
while ($canale->is_consuming()) {
    $canale->wait();
}

function applica(PDO $db, array $e): void
{
    if (($e['version'] ?? null) !== 1) {
        // Un contratto nuovo: non si tratta. Resta in coda e compare nei log finché qualcuno non aggiorna il CRM.
        throw new RuntimeException('evento con versione sconosciuta: ' . json_encode($e['version'] ?? null));
    }
    switch ($e['event']) {
        case 'sent':
            avanza($db, $e['id'], 'SPEDITA', null, $e['messageId']);
            break;
        case 'rejected':
            avanza($db, $e['id'], 'RIFIUTATA', json_encode($e['errors'], JSON_UNESCAPED_UNICODE));
            break;
        case 'failed':
            avanza($db, $e['id'], 'FALLITA', $e['code'] . ': ' . $e['detail']);
            break;
        case 'uncertain':
            avanza($db, $e['id'], 'DA_VERIFICARE', $e['detail'], $e['messageId']);
            avvisa("PEC {$e['id']} da verificare: {$e['detail']}");
            break;
        case 'receipt':
            salvaRicevuta($db, $e);
            break;
        case 'mailbox.suspended':
            avvisa("Casella {$e['mailbox']} sospesa ({$e['cause']}): {$e['detail']}. Le PEC aspettano in coda.");
            break;
        default:
            // Un evento nuovo, aggiunto da una versione futura: conservato in pec_eventi, nient'altro.
            break;
    }
}

function salvaRicevuta(PDO $db, array $e): void
{
    $file = base64_decode($e['eml'], true);
    if ($file === false || hash('sha256', $file) !== $e['emlSha256']) {
        throw new RuntimeException('ricevuta danneggiata: ' . $e['eventId']);
    }
    $percorso = getenv('PEC_CARTELLA_RICEVUTE') . "/{$e['id']}/{$e['emlSha256']}.eml";
    if (!is_dir(dirname($percorso))) {
        mkdir(dirname($percorso), 0750, true);
    }
    file_put_contents($percorso, $file);
    $db->prepare('INSERT INTO pec_ricevute (event_id, pec_id, tipo, emessa_il, eml_sha256, percorso) VALUES (?, ?, ?, ?, ?, ?)')
        ->execute([$e['eventId'], $e['id'], $e['receiptType'], date('Y-m-d H:i:s', strtotime($e['issuedAt'])), $e['emlSha256'], $percorso]);

    $stato = match ($e['receiptType']) {
        'ACCEPTANCE' => 'ACCETTATA',
        'DELIVERY' => 'CONSEGNATA',
        'NON_DELIVERY', 'NON_ACCEPTANCE', 'VIRUS_DETECTED' => 'NON_CONSEGNATA',
        default => null,                  // presa in carico, preavviso: conservati, lo stato non cambia
    };
    if ($stato !== null) {
        avanza($db, $e['id'], $stato, $e['error']['detail'] ?? null);
    }
}

function avanza(PDO $db, string $id, string $stato, ?string $dettaglio = null, ?string $messageId = null): void
{
    if ($messageId !== null) {
        $db->prepare('UPDATE pec_invii SET message_id = ? WHERE id = ?')->execute([$messageId, $id]);
    }
    $riga = $db->prepare('SELECT stato FROM pec_invii WHERE id = ? FOR UPDATE');
    $riga->execute([$id]);
    $attuale = $riga->fetchColumn();
    if ($attuale === false) {
        return;                           // una PEC che il CRM non conosce (es. di collaudo): evento conservato, niente altro
    }
    if (RANGO[$stato] <= RANGO[$attuale]) {
        return;
    }
    $db->prepare('UPDATE pec_invii SET stato = ?, dettaglio = COALESCE(?, dettaglio), aggiornata_il = NOW() WHERE id = ?')
        ->execute([$stato, $dettaglio, $id]);
}

/** Da scrivere con gli strumenti del CRM: una mail, una notifica, un messaggio a chi deve intervenire. */
function avvisa(string $testo): void
{
    error_log('pecmailer AVVISO: ' . $testo);
}
```

Tenerlo acceso, per esempio con supervisord:

```ini
[program:pec-esiti]
command=php /percorso/del/crm/bin/pec-esiti.php
autostart=true
autorestart=true
startretries=999
stopwaitsecs=30
```

Se il lettore si ferma a metà di un evento, niente si perde: l'evento non era confermato, quindi RabbitMQ lo riconsegna, e la tabella `pec_eventi` scarta ciò che era già stato salvato. Se la connessione a RabbitMQ cade, lo script termina con un errore e supervisord lo riavvia.

### 8.4 Il controllo periodico

Ogni 5 minuti, per esempio con cron.

**Ripubblicare le PEC `DA_ACCODARE`:** per ognuna si ricostruisce il messaggio dai dati del CRM, con la stessa funzione della prima volta, e si chiama `$coda->ripubblica($id, $casella, $pec)`.

**Avvisi**, con soglie da regolare sull'esperienza:

| Condizione                       | Query                                                                     | Perché                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pubblicazione senza risposta     | `stato = 'IN_ACCODAMENTO' AND aggiornata_il < NOW() - INTERVAL 35 MINUTE` | Decide una persona (sezione 6)                                                                                                                                                                                                                                   |
| Ferma in coda                    | `stato = 'IN_CODA' AND aggiornata_il < NOW() - INTERVAL <soglia>`         | La soglia dipende dal ritmo della casella: 5000 PEC impiegano circa un'ora e mezza a 60 al minuto, circa 17 ore a 5 al minuto. Va fissata sopra la durata della campagna più lunga. Oltre, la casella potrebbe essere sospesa o il messaggio finito negli scarti |
| Partita, ma senza accettazione   | `stato = 'SPEDITA' AND aggiornata_il < NOW() - INTERVAL 1 HOUR`           | L'accettazione arriva di norma in pochi secondi                                                                                                                                                                                                                  |
| Accettata, ma senza esito finale | `stato = 'ACCETTATA' AND aggiornata_il < NOW() - INTERVAL 26 HOUR`        | Per le regole PEC la consegna o la mancata consegna arrivano entro 24 ore                                                                                                                                                                                        |
| Da verificare                    | `stato = 'DA_VERIFICARE'`                                                 | Serve sempre una persona                                                                                                                                                                                                                                         |

## 9. Eventi di esempio, per i test

```json
{
  "version": 1,
  "event": "sent",
  "eventId": "sent:7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f",
  "occurredAt": "2026-09-19T15:41:18.402Z",
  "tenant": "serfin",
  "mailbox": "serfin-legalmail",
  "id": "7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f",
  "reference": "pratica-4521",
  "batch": "solleciti-2026-09",
  "messageId": "<pm.7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f@legalmail.it>",
  "sentAt": "2026-09-19T15:41:18.310Z",
  "confirmedBy": "SMTP",
  "smtpResponse": "250 2.0.0 Ok: queued as 4hn9cv4XD9z97",
  "attempts": 1,
  "sentCopy": "ARCHIVED",
  "warnings": []
}
```

```json
{
  "version": 1,
  "event": "rejected",
  "eventId": "rejected:3b9e0c0d1f2a4e6b8c7d5e4f3a2b1c0d",
  "occurredAt": "2026-09-19T15:42:01.000Z",
  "tenant": "serfin",
  "mailbox": "serfin-legalmail",
  "id": "3b9e0c0d1f2a4e6b8c7d5e4f3a2b1c0d",
  "reference": "pratica-4522",
  "errors": [
    {
      "code": "RECIPIENT_NOT_PEC",
      "field": "to.address",
      "detail": "gmail.com is an ordinary mail service, not PEC"
    }
  ]
}
```

```json
{
  "version": 1,
  "event": "failed",
  "eventId": "failed:5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f",
  "occurredAt": "2026-09-19T16:03:44.000Z",
  "tenant": "serfin",
  "mailbox": "serfin-legalmail",
  "id": "5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f",
  "code": "SMTP_550",
  "smtpCode": 550,
  "detail": "550 5.1.1 recipient rejected",
  "attempts": 1
}
```

```json
{
  "version": 1,
  "event": "uncertain",
  "eventId": "uncertain:9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
  "occurredAt": "2026-09-19T16:10:00.000Z",
  "tenant": "serfin",
  "mailbox": "serfin-legalmail",
  "id": "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d",
  "messageId": "<pm.9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d@legalmail.it>",
  "reason": "CONNECTION_LOST_AFTER_DATA",
  "detail": "connection lost after the message was transmitted"
}
```

```json
{
  "version": 1,
  "event": "receipt",
  "eventId": "receipt:8d3f1a6c0b9e4d7a2f5c8e1b4a7d0c3f6e9b2a5d8c1f4e7a0b3d6c9f2e5a8b1d",
  "occurredAt": "2026-09-19T15:41:25.000Z",
  "tenant": "serfin",
  "mailbox": "serfin-legalmail",
  "id": "7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f",
  "messageId": "<pm.7f1c2e4a9b8d4c1e8f0a3d2b1a0c9e8f@legalmail.it>",
  "receiptType": "DELIVERY",
  "final": true,
  "issuedAt": "2026-09-19T15:41:24.000Z",
  "provider": "InfoCert S.p.A.",
  "recipient": "destinatario@pec.it",
  "eml": "<base64 del file .eml>",
  "emlSha256": "<sha256 del file .eml>"
}
```

```json
{
  "version": 1,
  "event": "mailbox.suspended",
  "eventId": "mailbox.suspended:serfin-legalmail:2026-09-19T16:20:00.000Z",
  "occurredAt": "2026-09-19T16:20:00.000Z",
  "tenant": "serfin",
  "mailbox": "serfin-legalmail",
  "cause": "SMTP_AUTH_REFUSED",
  "detail": "535 5.7.8 authentication failed"
}
```

Nei test delle ricevute, `eml` e `emlSha256` vanno riempiti con un file vero: `base64_encode($eml)` e `hash('sha256', $eml)`.

Test minimi da avere:

- ogni evento porta allo stato giusto;
- un doppione non cambia niente;
- una ricevuta `ACCEPTANCE` arrivata prima di `sent` lascia `ACCETTATA`;
- `failed` seguito da `uncertain` dà `DA_VERIFICARE`;
- una ricevuta con impronta sbagliata non viene salvata né confermata;
- un evento di tipo sconosciuto si conserva senza errori;
- `version` 2 non viene trattato.

## 10. Provare in locale, senza produzione

Il progetto pecmailer contiene uno stack Docker completo: RabbitMQ, un finto gestore PEC (Greenmail) e due caselle di prova. Si avvia così (dettagli nel documento tecnico di pecmailer, `docs/tecnica.md`):

```bash
git clone <indirizzo del repository pecmailer> pecmailer
cd pecmailer
docker compose up -d --build --wait
```

Il CRM si collega con host `localhost`, porta `5672`, utente e password `pecmailer`, virtual host `/`, cliente `serfin`, caselle `serfin-aruba` e `serfin-legalmail`. Pagina di RabbitMQ: http://localhost:15672.

- Le PEC finiscono tutte in Greenmail, anche se il destinatario è un indirizzo vero: dallo stack locale non parte niente verso l'esterno. Tornano gli esiti `sent`. Il dominio `pec.example` è accettato come PEC apposta per gli esempi; un dominio di posta ordinaria, come gmail.com, dà `rejected`, ed è un buon modo per provare quel caso.
- **Greenmail non emette ricevute.** Per provare il lettore sulle ricevute, in locale e solo in locale, si possono pubblicare a mano gli eventi di esempio della sezione 9 nella coda `.out`, anche dalla pagina di RabbitMQ (coda, poi "Publish message").
- Le ricevute vere arrivano solo con una casella PEC reale: quel collaudo lo fanno le persone, con la procedura di pecmailer.

## 11. La messa in produzione

1. Il CRM completo e provato in locale (sezione 10).
2. Un collaudo con una casella vera e pochi destinatari propri: esiti, ricevute, stati, file salvati.
3. Il via libera di chi gestisce l'infrastruttura: code, utenti, permessi, avvisi.
4. La prima campagna piccola, poche decine di PEC, guardando stati e avvisi; poi a crescere.

## 12. Glossario

| Parola                    | Significato                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| PEC                       | Posta elettronica certificata: una mail con valore legale, grazie alle ricevute del gestore            |
| Gestore                   | Chi fornisce la casella PEC: Aruba, Legalmail (InfoCert), Namirial...                                  |
| Ricevuta di accettazione  | Il gestore del mittente ha preso la PEC: da qui ha valore legale                                       |
| Ricevuta di consegna      | La PEC è arrivata nella casella del destinatario                                                       |
| daticert.xml              | La parte di ogni ricevuta leggibile dai programmi: tipo, date, mittente, destinatario, errori          |
| Coda                      | Una cassetta delle lettere di RabbitMQ: i messaggi restano lì finché qualcuno li prende                |
| Conferma di pubblicazione | La risposta di RabbitMQ a chi pubblica: "l'ho salvato" (ack) oppure "no" (nack)                        |
| `ack` / `nack`            | Chi legge dice a RabbitMQ "fatto, puoi toglierlo" oppure "rimettilo in coda"                           |
| `mandatory`               | Chiede a RabbitMQ di restituire un messaggio che non può consegnare a nessuna coda, invece di buttarlo |
| Prefetch (`basic_qos`)    | Quanti messaggi il lettore riceve in anticipo, prima di averli confermati                              |
| `eventId`                 | L'identificativo stabile di un evento: lo stesso fatto ha sempre lo stesso `eventId`                   |
