# pecmailer — documento tecnico

Per chi sviluppa pecmailer, persona o assistente AI. Cos'è il progetto e come funziona nel suo insieme: [README](../README.md), in inglese. Il contratto dei messaggi: [docs/asyncapi.yaml](asyncapi.yaml) e, a parole, [docs/guida-crm.md](guida-crm.md). Installazione e gestione: [deploy/README.md](../deploy/README.md).

## 1. In breve

pecmailer spedisce PEC per conto di un'applicazione (il CRM). Un container serve un cliente e una sua casella: prende le PEC da una coda RabbitMQ di ingresso, le spedisce attraverso il gestore (SMTP), mette una copia nella cartella "Inviata" e legge le ricevute (IMAP), e pubblica su una coda di uscita cosa è successo. **Non conserva niente**: niente database, niente file, niente stato fra un riavvio e l'altro. Versione 0.6.1.

**Le regole che non si rompono mai:**

1. **Una PEC non parte mai due volte.** Un messaggio riconsegnato dalla coda può essere già partito: pecmailer cerca la ricevuta del gestore nella casella, e dichiara `uncertain` quando non può saperlo. Mai "rispedire e basta".
2. **Un esito non si perde mai.** Il messaggio di ingresso si conferma solo dopo che RabbitMQ ha confermato il suo esito; ogni evento ha un `eventId` stabile, così un evento ripetuto si riconosce.
3. **Niente segreti né dati personali nei log o nel repository.** Le password arrivano dall'ambiente, avvolte in `Secret`; i log portano solo identificativi, codici e conteggi, mai un destinatario, un oggetto, un testo o un allegato.
4. **La casella del cliente è in sola lettura**, tranne la copia in "Inviata".
5. **Un accesso rifiutato sospende la casella** invece di riprovare: ripetuti rifiuti fanno bloccare l'account.

## 2. Primo avvio su una macchina nuova

Tutto in Docker, senza caselle PEC vere. Circa mezz'ora, quasi tutta di scaricamenti.

| Cosa               | Versione                                                                      | A cosa serve                                 |
| ------------------ | ----------------------------------------------------------------------------- | -------------------------------------------- |
| **Docker Desktop** | 29 o superiore (su Windows con WSL2)                                          | Il servizio, RabbitMQ e il finto gestore PEC |
| **Node.js**        | 24 (vedi `.nvmrc`). Il 25 funziona, con un avviso di vitest all'installazione | I comandi di prova e i test                  |
| **git**            | qualsiasi                                                                     | Scaricare il progetto                        |

Se la rete aziendale passa da un proxy, vanno configurati prima sia npm sia Docker.

```bash
git clone <indirizzo del repository> pecmailer && cd pecmailer
npm ci                                   # le librerie esattamente come nel lockfile; deve dire "found 0 vulnerabilities"
npm run build                            # compila in dist/, serve ai comandi local:*
npm run check                            # tipi, lint, formattazione, 157 test unitari
docker compose up -d --build --wait      # lo stack locale: RabbitMQ, Greenmail e due container
```

Lo stack locale ([docker-compose.yml](../docker-compose.yml)) avvia quattro container:

| Container          | Cos'è                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rabbitmq`         | Le code. Pagina su http://localhost:15672, utente e password `pecmailer`: tre code per casella, `.in`, `.out`, `.dead`                                                                 |
| `greenmail`        | Un finto gestore PEC, solo per le prove: accetta qualunque password e non emette ricevute. I messaggi arrivati: http://localhost:8080/api/user/destinatario@pec.example/messages/INBOX |
| `serfin-aruba`     | Un container pecmailer, sonde su http://localhost:3001/health/ready                                                                                                                    |
| `serfin-legalmail` | Un secondo container, per una seconda casella: sonde sulla 3002                                                                                                                        |

Le due sonde devono rispondere `{"status":"ok","checks":{"rabbitmq":true,"mailbox":true,"running":true}}`.

**La prima PEC di prova** (il CRM lo fanno questi due comandi, con le impostazioni di [examples/local.env](../examples/local.env)):

```bash
npm run local:publish -- examples/pec.json                           # una PEC con un PDF nella coda di serfin-aruba
npm run local:outcomes                                               # legge e svuota la coda di uscita
npm run local:publish -- examples/pec.json --mailbox serfin-legalmail  # l'altra casella
npm run local:outcomes -- --follow                                   # resta in ascolto (Ctrl+C per uscire)
npm run local:outcomes -- --save data/esiti                          # salva ogni evento e ogni .eml
```

`local:outcomes` deve stampare una riga `sent … via SMTP, Sent copy ARCHIVED`. Il file di esempio usa `"path": "sollecito.pdf"` al posto di `content`: è una comodità di questo strumento, che legge il file e lo converte in base64. Il CRM manda sempre `content`.

**I test di integrazione** usano uno stack separato ([docker-compose.test.yml](../docker-compose.test.yml): RabbitMQ sulla 5673, Greenmail sulle 13025 e 13143), quindi non disturbano quello locale:

```bash
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration                                # 20 test
docker compose -f docker-compose.test.yml down
```

**Fermare**: `docker compose down` tiene i dati di RabbitMQ, `docker compose down -v` cancella anche le code.

| Sintomo                                  | Causa                                      | Rimedio                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to connect to the docker API`    | Docker Desktop è spento                    | Aprirlo (o `docker desktop start`) e ripetere                                                                                                           |
| `port is already allocated`              | Un'altra cosa usa la porta                 | Porte usate: 5672 e 15672 (RabbitMQ), 3025, 3143 e 8080 (Greenmail), 3001 e 3002 (sonde). Si cambiano in `docker-compose.yml`, a sinistra dei due punti |
| `PRECONDITION_FAILED … inequivalent arg` | Una coda creata da una versione precedente | Cancellarla vuota e riavviare: `docker compose exec rabbitmq rabbitmqctl delete_queue <nome>`                                                           |
| `local:publish` non trova `dist/…`       | Manca la compilazione                      | `npm run build`                                                                                                                                         |
| Un container resta `unhealthy`           | Di solito non raggiunge RabbitMQ           | `docker compose logs <container> --tail 50`                                                                                                             |
| Gli scaricamenti si bloccano             | Proxy aziendale                            | Configurarlo in npm e in Docker Desktop                                                                                                                 |

## 3. Comandi

| Comando                                              | Cosa fa                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run check`                                      | Tipi, lint, formattazione, test unitari (157). Da lanciare prima di consegnare un lavoro |
| `npm test`                                           | Solo i test unitari                                                                      |
| `npm run test:integration`                           | I 20 test contro RabbitMQ e Greenmail veri (stack di test acceso)                        |
| `npm run build`                                      | Compila in `dist/`                                                                       |
| `npm run local:publish -- <file>` / `local:outcomes` | Fanno la parte del CRM contro lo stack locale; `--mailbox <codice>` per un'altra casella |
| `node dist/main.cli.js config check`                 | La configurazione con cui gira un container, senza segreti                               |
| `node dist/main.cli.js probe`                        | Login SMTP e IMAP con le credenziali configurate, senza spedire niente                   |
| `npm run cli -- <comando>`                           | Gli stessi comandi da questa macchina, con un `.env` fatto da `.env.example`             |

Dentro un container: `docker compose exec serfin-aruba node dist/main.cli.js config check`.

## 4. Com'è fatto il codice

```
src/main.ts              il container: un cliente, una casella; aggiunge sonde e spegnimento
src/main.cli.ts          i comandi (config check, probe, publish, outcomes)
src/app/container.ts     tutto collegato a mano: il punto da cui leggere il flusso intero
src/app/                 anche il server delle sonde e la versione
src/queue/               l'interfaccia Queues; rabbit-queues.ts è l'unico file che conosce RabbitMQ
src/config/              lo schema delle variabili (zod) e i preset dei gestori
src/modules/sending/     controlli, MIME, SMTP, copia in Inviata, ritmo, eventi, sospensione
src/modules/receipts/    lettore delle ricevute, parser, daticert, ricerca della ricevuta di una PEC riconsegnata
src/modules/recipients/  questo indirizzo è PEC?
src/modules/templates/   le regole dell'HTML; modules/attachments/ i tipi di allegato
src/common/              log, segreti, orologio
test/unit  test/integration  test/helpers  test/fixtures (ricevute Aruba vere, anonimizzate)
docker/                  Dockerfile e impostazioni di RabbitMQ degli stack locali
deploy/                  la produzione: Docker Compose e la procedura per l'IT
docs/                    asyncapi.yaml (il contratto), guida-crm.md, questo documento
examples/                una PEC e le impostazioni per provare lo stack locale
```

Dove il codice incontra il mondo esterno c'è un'interfaccia (`Queues`, `SmtpClientFactory`, `SentArchiverFactory`, `ProofLookup`, `ReceiptSourceFactory`, `MxResolver`, `Clock`, `Sleeper`): i test unitari la sostituiscono con un finto, [container.ts](../src/app/container.ts) collega quelle vere.

### 4.1 Il giro di una PEC

In [pec-sender.ts](../src/modules/sending/pec-sender.ts), una alla volta:

1. **Senza un `id` utilizzabile, o non JSON** → coda `.dead`: non c'è nessuno a cui rispondere.
2. **Controlli** ([send-request.ts](../src/modules/sending/send-request.ts)): il formato (rigido: i campi sconosciuti fanno rifiutare), le regole dell'HTML, le immagini nel testo contro i riferimenti `cid:`, il tipo di ogni allegato dai suoi byte, il dominio PEC del destinatario, poi la dimensione una volta composta. Qualsiasi problema → `rejected` con tutti i motivi, e non parte niente.
3. **Ritmo** ([pace.ts](../src/modules/sending/pace.ts)): una PEC ogni 60/`PECMAILER_PER_MINUTE` secondi, in memoria.
4. **SMTP**, con l'esito classificato da [smtp-outcome.ts](../src/modules/sending/smtp/smtp-outcome.ts):
   - accettata → copia in Inviata, poi `sent`;
   - rifiuto definitivo (5xx sul messaggio) → `failed`;
   - errore temporaneo (4xx, rete) → nuovo tentativo dopo `PECMAILER_RETRY_BACKOFF_SECONDS` (60, 300, 900), poi `failed` con `RETRIES_EXHAUSTED`;
   - connessione caduta dopo che il gestore aveva il messaggio → `uncertain`, mai ritentato;
   - accesso rifiutato → casella sospesa.
5. Il messaggio di ingresso si conferma quando RabbitMQ ha confermato l'esito. Se la pubblicazione fallisce, il gestore lancia un errore e il messaggio torna più tardi, marcato "già consegnato".

**Una PEC riconsegnata** (il container è morto, o non è riuscito a pubblicare l'esito) non si rispedisce mai alla cieca. [sent-proof.ts](../src/modules/receipts/sent-proof.ts) cerca nella cartella ricevute, in sola lettura, una ricevuta che citi il suo Message-ID (`SEARCH HEADER X-Riferimento-Message-ID`), e la passa allo stesso parser delle ricevute. La ricerca si ripete ogni 20 secondi per `PECMAILER_REDELIVERY_WAIT_SECONDS` (300). Trovata → `sent` con `confirmedBy: ACCEPTANCE_RECEIPT`. Non trovata → `uncertain`. Una PEC riconsegnata che viola una regola del proprio contenuto non era certamente partita → `rejected`; il destinatario invece **non** viene rigiudicato, perché DNS ed elenchi cambiano. La ricerca non guarda la data: per questo un `id` non va mai riusato.

**Rimettere in coda come messaggio nuovo**: quando il container si ferma fra due tentativi, o la casella viene sospesa, la PEC certamente non è partita. Restituirla nel modo normale la marcherebbe "già consegnata" e tornerebbe come "forse partita"; viene quindi ripubblicata in fondo alla coda, e l'originale confermato.

**Sospensione** ([mailbox-suspension.ts](../src/modules/sending/mailbox-suspension.ts), condivisa da chi spedisce e da chi legge): un accesso rifiutato, SMTP o IMAP (ricerca della ricevuta, lettura delle ricevute, copia in Inviata), pubblica una volta `mailbox.suspended`, ferma il consumatore e rende falsa la sonda `ready`. Le PEC aspettano in coda; un riavvio con la password giusta riprende.

**Connessioni**: SMTP (una sola connessione per casella) e IMAP si aprono alla prima PEC e si chiudono dopo 30 secondi senza PEC.

**Vitalità**: la sonda `live` è falsa solo se una gestione dura più di 35 minuti (i tentativi stanno in 25): il container è bloccato, e l'orchestratore lo riavvia.

### 4.2 Le ricevute

In [receipt-reader.ts](../src/modules/receipts/receipt-reader.ts), ogni `PECMAILER_RECEIPTS_POLL_SECONDS` (60):

1. La cartella si apre in sola lettura (`EXAMINE`, `BODY.PEEK`): niente segnato come letto, spostato o cancellato. Le mail dopo l'ultimo UID letto arrivano una alla volta.
2. Le due intestazioni di primo livello `X-Ricevuta` e `X-Trasporto` decidono se una mail può essere una ricevuta; solo allora si scarica e si analizza. Una busta di trasporto non è mai una ricevuta, e una PEC in arrivo non viene nemmeno scaricata.
3. Una ricevuta è nostra se il Message-ID che cita ha la nostra forma, `<pm.{id}@…>`: l'`id` dentro è quello del CRM. Le ricevute di altri messaggi (spediti a mano, o dal vecchio sistema) si lasciano stare.
4. Si pubblica intera ([outcome-events.ts](../src/modules/sending/outcome-events.ts)): `.eml` e `daticert.xml` in base64, i loro dati, e `final`. L'`eventId` è lo SHA-256 del Message-ID della ricevuta stessa, o dei suoi byte.

**Nessuna memoria, di proposito**: il cursore sta in memoria. A ogni avvio si rileggono le ultime `PECMAILER_RECEIPTS_LOOKBACK_HOURS` (24): le stesse ricevute escono con lo stesso `eventId`, e il CRM le scarta. Dopo un fermo più lungo va alzata prima di riavviare.

**Errori**: una ricevuta che non si riesce a pubblicare (RabbitMQ irraggiungibile) ferma il giro e si rilegge al successivo, finché serve; una mail che non si riesce a scaricare o leggere per tre giri di fila si salta, con un log `error`, per non bloccare le altre. Un giro fermo da più di 15 minuti oltre l'intervallo fa fallire la sonda `live`.

### 4.3 Le code

In [rabbit-queues.ts](../src/queue/rabbit-queues.ts), l'unico file che conosce RabbitMQ (libreria `rabbitmq-client`):

- **Tre code quorum** per container: replicate, e un messaggio sopravvive a un riavvio del broker.
- La coda di ingresso aggiunge: `x-single-active-consumer` (due container della stessa casella: ne lavora uno), `x-delivery-limit` 5 con spostamento negli scarti, `x-dead-letter-strategy: at-least-once` (un messaggio lascia l'ingresso solo quando gli scarti l'hanno salvato; richiede `x-overflow: reject-publish`, e senza limite di lunghezza non rifiuta mai niente).
- **Un messaggio alla volta** (prefetch 1), confermato solo quando il gestore ha finito, cioè quando il suo esito è confermato.
- **Pubblicazione con conferma** (publisher confirms).
- Una gestione fallita restituisce il messaggio **dopo una pausa di 10 secondi** (senza pausa durante lo spegnimento): vedi le trappole, 2.
- Le code le dichiara il container all'avvio e dopo ogni riconnessione; con `PECMAILER_DECLARE_QUEUES=false` le controlla soltanto.

### 4.4 Lo spegnimento

Su SIGTERM ([main.ts](../src/main.ts)) il container smette **subito** di prendere PEC, lascia finire il giro del lettore di ricevute, finisce la PEC in mano (un dialogo SMTP non si interrompe mai di proposito: il gestore potrebbe già avere il messaggio) ed esce. Dopo 110 secondi esce comunque: per questo l'orchestratore deve concedere almeno 2 minuti.

## 5. Decisioni e perché

| Decisione                                                                                                  | Perché                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Un container per ogni coppia cliente-casella**, configurato solo da variabili d'ambiente                 | Isolamento: una casella bloccata, sospesa o che consuma troppa memoria non tocca le altre. Si scala aggiungendo caselle, non repliche                                                                                   |
| **Nessun database; il servizio non conserva niente**                                                       | Chi spedisce (il CRM) ha già un database e tiene lo storico. Il servizio non custodisce dati personali. Il confronto con database e Redis è nel [README](../README.md), sezione 9                                       |
| **RabbitMQ con code quorum**: ingresso, uscita, scarti                                                     | Durevoli e replicate; comportamento da coda nativo (uno alla volta, riconsegna, limite, scarti)                                                                                                                         |
| **Una PEC per messaggio in coda**; il lotto è solo un'etichetta                                            | Un messaggio si conferma o si restituisce intero: "spedita o no" resta esatto                                                                                                                                           |
| **L'`id` del CRM dentro il Message-ID** (`<pm.{id}@dominio>`)                                              | Ogni ricevuta cita il Message-ID: le ricevute ritrovano la loro PEC senza memoria, e il container riconosce i propri messaggi nella casella                                                                             |
| **Conferma dell'ingresso solo dopo la conferma dell'esito**                                                | Un esito non si perde mai. Il prezzo: eventi "almeno una volta", da cui l'`eventId` stabile                                                                                                                             |
| **Una PEC riconsegnata non si rispedisce**: si cerca la ricevuta; trovata = `sent`, altrimenti `uncertain` | Una riconsegna vuol dire che il tentativo precedente potrebbe averla spedita, e una PEC ha valore legale                                                                                                                |
| **Una PEC riconsegnata non si rigiudica sul destinatario**                                                 | DNS ed elenchi cambiano: una PEC partita non deve risultare `rejected`, che inviterebbe a rispedirla                                                                                                                    |
| **Pausa di 10 secondi prima di restituire un messaggio**                                                   | RabbitMQ 4 non conta le restituzioni volute nel limite di consegne: senza pausa, un messaggio che fallisce sempre girerebbe a vuoto                                                                                     |
| **Tentativi entro 25 minuti** (attese + un timeout SMTP per tentativo)                                     | RabbitMQ riprende un messaggio non confermato entro 30 minuti                                                                                                                                                           |
| **Oggetto e HTML già pronti dal CRM**; l'HTML si **rifiuta, mai ripulito**                                 | Niente modelli nel servizio. Una PEC ha valore legale: parte esattamente com'è stata scritta, o non parte                                                                                                               |
| **Solo ritmo al minuto**, in memoria                                                                       | Evita che il gestore blocchi la casella; contare gli invii non è compito del servizio                                                                                                                                   |
| **rabbitmq-client** invece di amqplib                                                                      | Si ricollega, ridichiara le code e riprende a leggere da solo; con amqplib tutto questo va scritto a mano, ed è lì che nascono i bug. Sta in un solo file, dietro l'interfaccia `Queues`: sostituirla tocca solo quello |
| **Niente framework** (NestJS non c'è più)                                                                  | Un container che legge una coda ha una dozzina di oggetti, collegati a mano in `container.ts`                                                                                                                           |
| **Log JSON sullo standard output**                                                                         | Quello che un container deve fare, e che Graylog legge senza regole di interpretazione                                                                                                                                  |
| **Code dichiarate dal container**, o dall'infrastruttura con `PECMAILER_DECLARE_QUEUES=false`              | Funziona subito in locale; l'infrastruttura mantiene il controllo quando lo vuole                                                                                                                                       |
| **Allo spegnimento, smettere subito di prendere PEC**                                                      | `rabbitmq-client` perde i messaggi che arrivano mentre un consumatore si chiude, e RabbitMQ li restituisce marcati "già consegnati": sarebbero `uncertain` falsi                                                        |
| **Immagine Debian slim, non Alpine**                                                                       | La libreria C di Debian rende prevedibile la risoluzione DNS dei record MX                                                                                                                                              |

**Limiti noti e accettati:**

- Una PEC il cui esito è stato pubblicato ma non confermato (il container si ferma in quell'istante) torna in coda e può ricevere un secondo esito diverso, per esempio `failed` e poi `uncertain`. Distinguerli richiederebbe memoria; la guida del CRM dice di trattarla come `uncertain`.
- Un container ucciso **prima** di spedire lascia la PEC `uncertain`: da fuori non si distingue da uno ucciso dopo.
- La connessione caduta dopo aver trasmesso la PEC dà `uncertain`: è intrinseco a SMTP.
- pecmailer non riconosce un `id` già usato. Proposta, non fatta: cercare nella casella le ricevute del Message-ID prima di spedire, e rifiutare l'id duplicato.
- Su un RabbitMQ condiviso da più clienti, i permessi per coda non impediscono di pubblicare nelle code di un altro (trappole, 6).

## 6. Tecnologie

| Pacchetto                  | Versione         | Cosa fa                                                                                                                                                                                                         | Perché                                                                                                                                         |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                    | 24               | L'ambiente                                                                                                                                                                                                      | Il lavoro è quasi tutto attesa (SMTP, IMAP, RabbitMQ): il modello asincrono di Node ci sta bene                                                |
| TypeScript                 | 5.9.3            | Il linguaggio, `strict` più `noUncheckedIndexedAccess` ed `exactOptionalPropertyTypes`; ESLint `strict-type-checked` vieta `any`                                                                                | Un errore scoperto in compilazione non diventa una PEC sbagliata                                                                               |
| rabbitmq-client            | 5.0.8            | RabbitMQ: code, conferme, riconnessione                                                                                                                                                                         | Vedi le decisioni. Comunità più piccola di amqplib: per questo sta dietro un'interfaccia                                                       |
| nodemailer                 | 10.0.10          | Compone il MIME e parla SMTP                                                                                                                                                                                    | Il suo registro della conversazione (comandi e risposte, mai il corpo) dice se il server aveva già accettato i dati quando la connessione cade |
| imapflow                   | 2.0.5            | IMAP: copia in Inviata, ricevute                                                                                                                                                                                | Sola lettura con `EXAMINE` e `BODY.PEEK`; ricerca per intestazione                                                                             |
| mailparser                 | 3.9.28           | Legge le ricevute                                                                                                                                                                                               |                                                                                                                                                |
| htmlparser2 / domhandler   | 12.0.0 / 6.0.1   | Controlla l'HTML contro un elenco chiuso; in modalità XML legge `daticert.xml`                                                                                                                                  | Non espande mai le entità DTD: niente XXE                                                                                                      |
| zod                        | 4.6.5            | Schemi delle variabili d'ambiente e del messaggio di ingresso                                                                                                                                                   | Una definizione dà validazione, tipo e messaggi d'errore; `strictObject` rifiuta i campi sconosciuti                                           |
| pino                       | 9.14.0           | Log JSON, una riga per evento, con cliente, casella e versione                                                                                                                                                  | Oscura i campi `password`, `pass` e `url`                                                                                                      |
| vitest                     | 5.0.1            | Test, due progetti: `unit` e `integration`                                                                                                                                                                      |                                                                                                                                                |
| eslint + typescript-eslint | 10.11.0 / 8.70.0 | Lint rigoroso                                                                                                                                                                                                   |                                                                                                                                                |
| smtp-server                | 3.19.13          | Un server SMTP vero dentro i test, con risposte a copione ([fake-smtp.ts](../test/helpers/fake-smtp.ts))                                                                                                        | Prova il client SMTP vero contro un dialogo vero, compreso il taglio della connessione dopo i dati                                             |
| Greenmail                  | 2.1.4            | Finto gestore SMTP e IMAP, solo negli stack locale e di test                                                                                                                                                    | Accetta qualunque password (il login è l'indirizzo intero) e non emette ricevute                                                               |
| Docker                     | —                | [docker/Dockerfile](../docker/Dockerfile): più stadi su `node:24-bookworm-slim`, solo dipendenze di produzione, utente non root, controllo di salute, due punti d'ingresso (`dist/main.js`, `dist/main.cli.js`) |                                                                                                                                                |

`package-lock.json` fissa l'albero esatto; `npm audit` non segnala vulnerabilità.

## 7. Configurazione

Solo variabili d'ambiente, controllate una volta all'avvio ([env.schema.ts](../src/config/env.schema.ts)). Sono tutte in [.env.example](../.env.example), con i valori predefiniti. Una variabile sbagliata ferma l'avvio con un messaggio che la nomina. Le credenziali IMAP, se non indicate, sono quelle SMTP.

**I preset dei gestori** ([provider-presets.ts](../src/config/provider-presets.ts)) impostano server, porte, sicurezza e cartella Inviata; ogni valore si può sovrascrivere per casella.

| Preset      | SMTP / IMAP                                                            | Cartella Inviata                                         | Login                                  | Stato                                             |
| ----------- | ---------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| `aruba`     | `smtps.pec.aruba.it:465` / `imaps.pec.aruba.it:993`, TLS               | `INBOX.Inviata`                                          | L'indirizzo PEC                        | Provato con invii veri il 19/09/2026              |
| `legalmail` | `sendm.cert.legalmail.it:465` / `mbox.cert.legalmail.it:993`, TLS      | `INBOX/Spedite`                                          | Il codice utente `M…`, non l'indirizzo | Provato con invii veri il 21/09/2026              |
| `namirial`  | `smtps.sicurezzapostale.it:465` / `imaps.sicurezzapostale.it:993`, TLS | Sconosciuta: va indicata in `PECMAILER_IMAP_SENT_FOLDER` | L'indirizzo PEC                        | Non provato; `probe` la trova il giorno che serve |
| `custom`    | Tutto da indicare                                                      |                                                          |                                        |                                                   |

**Le code** si chiamano `<prefisso>.<cliente>.<casella>.in`, `.out` e `.dead`, con prefisso `pecmailer`.

**I destinatari**: un dominio è PEC se appartiene a un gestore noto, o se i suoi server di posta (record MX) sono di un gestore ([pec-providers.ts](../src/modules/recipients/pec-providers.ts)); un dominio di posta ordinaria è rifiutato; uno che non si riesce a classificare è rifiutato, salvo `options.unverifiedRecipient: send`. Gli elenchi sono un punto di partenza, non il registro AgID, e si estendono per container con `PECMAILER_PEC_DOMAINS` e simili.

**Dove stanno i valori**: nello stack locale, in `docker-compose.yml`; nei collaudi, in un override fuori da git (`data/`) con le password in `.env`; in produzione, in ConfigMap e Secret di Kubernetes, o nel `.env` di [deploy/](../deploy/). `.env` non si legge né si committa mai.

## 8. Trappole e comportamenti verificati

1. **A capo LF, imposti da `.gitattributes`.** Git per Windows scrive CRLF a ogni checkout; senza l'attributo `prettier --check` fallisce. I file binari sono dichiarati `binary`, le ricevute di prova `-text`, byte per byte.
2. **RabbitMQ 4**, verificato sul 4.3:
   - un messaggio restituito di proposito (nack con requeue) **non** conta nel limite di consegne, uno restituito perché il consumatore è morto **sì**: da qui la pausa di 10 secondi;
   - `basic.get` è rifiutato su una coda quorum con un solo consumatore attivo: i test prendono i messaggi con un consumatore;
   - dichiarare una coda esistente con argomenti diversi fallisce con `PRECONDITION_FAILED`: si cancella vuota e si ridichiara. Le code quorum rifiutano `delete --if-empty`: controllare prima che siano vuote;
   - la dimensione massima predefinita di un messaggio è 16 MB (serve 64 MB), e un messaggio non confermato entro 30 minuti viene ripreso.
3. **rabbitmq-client perde i messaggi che arrivano mentre un consumatore si chiude**, e RabbitMQ li restituisce marcati "già consegnati": il container smette di consumare nell'istante in cui gli si chiede di fermarsi.
4. **Greenmail** (solo stack locale e di test) accetta qualunque password, il login è l'indirizzo intero, e non emette ricevute: i test mettono le ricevute nella casella del mittente da soli.
5. **RabbitMQ in Docker tiene i dati sotto il nome del nodo**, `rabbit@<nome host>`, e il nome host di un container è il suo id: ricreandolo, le code sembrano sparite. Il compose di `deploy/` imposta `hostname: rabbitmq`; in Kubernetes serve StatefulSet o operator. Gli stack locale e di test non lo fanno, e lì non importa. Collegato: un `docker exec … rabbitmq-diagnostics` lanciato come root nel primo secondo di vita di un broker nuovo crea `.erlang.cookie` di proprietà di root, e il broker fallisce con `eacces`.
6. **Un utente RabbitMQ per cliente non isola la pubblicazione.** Le PEC passano dall'exchange predefinito, e RabbitMQ controlla la scrittura sull'exchange (`amq.default`), non sulla coda di destinazione. Provato sul 4.3: un utente con permessi limitati a `^pecmailer\.serfin\..*` non può creare né leggere le code di un altro cliente, ma può pubblicare nella sua coda di ingresso. Con più clienti sullo stesso broker: un virtual host per cliente.
7. **Windows e Git Bash**: `grep` e `sed` tolgono i ritorni a capo (i byte si controllano con node); i percorsi che iniziano con `/` vengono convertiti in percorsi Windows nei comandi `docker exec` (`MSYS_NO_PATHCONV=1`).
8. **Docker Compose**: `docker compose restart` riavvia il container con le impostazioni vecchie, dopo una modifica a `.env` serve `up -d`; un container `unhealthy` non viene riavviato. **Kubernetes**: una ConfigMap o un Secret modificati si applicano solo con `kubectl rollout restart`.
9. **Aruba**, per una casella inesistente, usa il codice d'errore generico `altro`: il motivo vero sta in `errore-esteso`. La busta di trasporto porta anch'essa `X-Riferimento-Message-ID`: solo il controllo su `X-Trasporto` impedisce di scambiarla per una ricevuta.

## 9. Sicurezza

| Tema                   | Controllo                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Segreti                | Password e `RABBITMQ_URL` solo dall'ambiente (in produzione un Secret). Avvolti in `Secret` dal momento in cui si leggono: un log, un dump JSON o `config check` stampano `[redacted]`; il logger oscura anche i campi `password`, `pass` e `url` |
| Dati a riposo          | Nessuno. Messaggi, allegati e ricevute passano in memoria verso il gestore o verso la coda di uscita. Nessun volume; file system in sola lettura                                                                                                  |
| Dati personali nei log | Solo identificativi, codici e conteggi: mai un destinatario, un oggetto, un testo o un allegato                                                                                                                                                   |
| Accesso alle code      | Un container raggiunge solo le code col nome del suo cliente e della sua casella. Isolamento fra clienti: vedi trappole, 6                                                                                                                        |
| Trasporto              | SMTP e IMAP con il TLS del gestore e verifica del certificato; `RABBITMQ_URL` accetta `amqps://` dove la rete non è fidata                                                                                                                        |
| Messaggi in ingresso   | Schema rigido: campi sconosciuti rifiutati, dimensioni limitate (HTML 512 KB, 50 allegati, 20 immagini, la PEC entro il limite della casella), niente a capo né caratteri di controllo nell'oggetto e nel nome del destinatario                   |
| HTML                   | Elenco chiuso di elementi e attributi, rifiutato e mai ripulito: niente script, moduli, riquadri, gestori di eventi, immagini esterne, `url()` nel CSS; link solo `https`, `http`, `mailto`; immagini solo come parti `cid:`                      |
| Allegati               | Tipo riconosciuto dai primi byte, mai dal nome; elenco di estensioni ammesse; eseguibili e script rifiutati; nomi senza separatori di percorso                                                                                                    |
| Destinatari            | Solo indirizzi serviti da un gestore PEC accreditato; un dominio di posta ordinaria è rifiutato prima dell'invio                                                                                                                                  |
| Doppio invio           | Vedi le regole in cima e la sezione 4.1                                                                                                                                                                                                           |
| Messaggi velenosi      | Un messaggio illeggibile va negli scarti; uno che fa morire il container ci va dopo il limite di consegne, "almeno una volta"; una gestione fallita restituisce il messaggio dopo una pausa, così niente gira a vuoto                             |
| Fiducia nelle ricevute | Conta come ricevuta solo una mail con `X-Ricevuta` di primo livello; le buste `X-Trasporto` si ignorano: una finta ricevuta mandata da un terzo arriva per forza dentro una busta. La ricevuta si pubblica byte per byte con il suo SHA-256       |
| XML                    | `daticert.xml` letto senza mai espandere entità DTD: niente XXE                                                                                                                                                                                   |
| Casella del cliente    | Ricevute in sola lettura; l'unica scrittura è la copia in Inviata                                                                                                                                                                                 |
| Blocco dell'account    | Un accesso rifiutato sospende la casella invece di riprovare; riprende solo con un riavvio                                                                                                                                                        |
| Container              | Utente non root, solo dipendenze di produzione, immagine di base fissata, controllo di salute; l'unica porta aperta è quella delle sonde                                                                                                          |

**Non fatto**, di proposito o per disegno: la firma S/MIME dei gestori sulle ricevute si conserva ma non si verifica contro l'elenco AgID; conservare storico, allegati e ricevute è compito di chi spedisce; isolamento fra clienti e TLS verso RabbitMQ dipendono da come è gestito RabbitMQ.

Una vulnerabilità si segnala in privato a chi mantiene il progetto, con cliente, casella e ora: ogni riga di log porta i primi due.

## 10. Test

- **Unitari** (`npm test`, 157, nessun servizio esterno): ogni regola dell'invio e della lettura con finti (coda in memoria, SMTP a copione, cartella Inviata finta, cartella ricevute finta, un orologio che avanza a comando, un'attesa che non aspetta); il client SMTP vero contro un dialogo SMTP vero; il parser contro ricevute Aruba vere e anonimizzate ([test/fixtures/receipts/aruba](../test/fixtures/receipts/aruba/README.md)); configurazione, dichiarazione delle code, ordine di spegnimento.
- **Integrazione** (`npm run test:integration`, 20): contro RabbitMQ e Greenmail veri. Le code (conferme, un consumatore alla volta, la pausa, gli scarti, il limite di consegne); il container intero (spedita, rifiutata, negli scarti, riconsegnata con e senza ricevuta, ricevute pubblicate intere); la sorgente IMAP delle ricevute.
- **Ogni cambiamento di comportamento ha il suo test.**
- **Dal vivo**: lo stack locale con `local:publish` e `local:outcomes`; i collaudi su caselle vere (sezione 11).

## 11. Collaudi su caselle vere

**Una PEC spedita da una casella vera costa e ha valore legale: mai senza che sia stato chiesto.**

La procedura: un override di compose fuori da git (in `data/`) avvia un container in più sullo stack locale, con le impostazioni del gestore vero. La password arriva da `.env` attraverso compose, o da variabili digitate nel proprio terminale quando non deve essere scritta da nessuna parte. Prima `probe`; poi due PEC a indirizzi che si controllano (una consegnata, una a un indirizzo inesistente); alla fine si rimuove il container.

| Collaudo                  | Esito                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aruba**, 19/09/2026     | `probe` ok (cartella `INBOX.Inviata`); `sent` ×2 con copia archiviata; accettazione ×2, consegna ×1, mancata consegna ×1 (`5.1.1 - indirizzo non valido`); dopo il riavvio le quattro ricevute sono uscite di nuovo con lo stesso `eventId` e `.eml` identici. La ricerca della ricevuta di una PEC riconsegnata ha trovato l'accettazione in mezzo secondo |
| **Legalmail**, 21/09/2026 | `probe` ok (login con codice `M…`, cartella `INBOX/Spedite`); `sent` ×2 con copia archiviata; accettazione ×2 (InfoCert), consegna ×1 e mancata consegna ×1 (Aruba, lato destinatario: codice `altro`); dopo il riavvio stesse quattro ricevute, stessi `eventId`, `.eml` identici                                                                          |

## 12. Rilascio

1. Versione nuova in `package.json` e in [src/app/version.ts](../src/app/version.ts) (un test verifica che coincidano), la sua voce in [CHANGELOG.md](../CHANGELOG.md), `npm run check` verde, commit, tag git `v<versione>`.
2. L'immagine, dalla radice del repository e senza modifiche in sospeso:

```bash
docker login <indirizzo del registro>          # con una credenziale che può pubblicare
docker build -f docker/Dockerfile --platform linux/amd64 \
  -t <indirizzo del registro>/pecmailer:<versione> \
  --label org.opencontainers.image.version=<versione> \
  --label org.opencontainers.image.revision=$(git rev-parse HEAD) .
docker push <indirizzo del registro>/pecmailer:<versione>
```

Su Azure Container Registry l'accesso si fa anche con `az acr login --name <nome>`. 3. **Una versione si pubblica una volta sola**: se va corretta, si pubblica la successiva. **Mai `latest`**: chi installa deve sapere cosa gira, e poter tornare alla versione di prima. 4. L'installazione segue [deploy/README.md](../deploy/README.md).

## 13. Cosa manca

- **Kubernetes**: i manifest (Deployment, ConfigMap e Secret per casella) e RabbitMQ nel cluster, con l'operator o uno StatefulSet. Il comportamento su Kubernetes non è ancora stato provato.
- **Il lato CRM**: pubblicare le PEC, leggere gli esiti, gli stati e il controllo periodico ([guida-crm.md](guida-crm.md)).
- **Un test di carico** vicino alla realtà (migliaia di PEC attraverso Greenmail) prima della prima campagna grande: servirà anche a misurare memoria e disco.
- **Ritmo e allarmi**: il ritmo iniziale (5 al minuto) e la soglia "ferma in coda" del CRM vanno decisi insieme.
- **Id riusati**: il controllo sulla casella proposto nella sezione 5.
- **Più clienti sullo stesso RabbitMQ**: prima, un virtual host per cliente, o un exchange per cliente con il contratto e la guida aggiornati.
- **Elenchi dei gestori PEC** ([pec-providers.ts](../src/modules/recipients/pec-providers.ts)) da verificare con il registro AgID.
- **Namirial**: la cartella Inviata è sconosciuta; `probe` la trova il giorno che serve.
- **Verifica della firma S/MIME** dei gestori sulle ricevute, se un giorno sarà richiesta.
