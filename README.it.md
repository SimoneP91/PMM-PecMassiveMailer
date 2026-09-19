# pecmailer

Spedisce PEC per conto di applicazioni clienti. Ogni container serve un cliente e una sua casella: prende le PEC da una coda di ingresso, le spedisce tramite il gestore e mette in una coda di uscita cosa è successo, cioè l'esito e poi ogni ricevuta. Non conserva niente: chi riempie e svuota le code tiene i dati, gli allegati e le ricevute.

Come si usa, a parole e con esempi in PHP: [docs/it/messaggi.md](docs/it/messaggi.md) ([inglese](docs/en/messages.md)). Il contratto formale: [docs/asyncapi.yaml](docs/asyncapi.yaml).

## Stato

Versione 0.6.0: il passaggio da un'API HTTP con database alle code è completo ([ADR 0006](docs/it/adr/0006-queues-no-database.md)). Invio, copia in Inviata, esiti e ricevute funzionano da un capo all'altro, verificati su una casella Aruba reale. Le versioni fino alla 0.5.1, con API HTTP e MongoDB, restano nella storia di git.

Prima della produzione: un collaudo su una casella Legalmail, il gestore usato in produzione, e le impostazioni di RabbitMQ di [docker/rabbitmq/rabbitmq.conf](docker/rabbitmq/rabbitmq.conf) applicate da chi gestisce il server.

## Tecnologie

Node 24 · TypeScript 5.9 (rigoroso, nessun `any`) · RabbitMQ tramite rabbitmq-client · nodemailer / imapflow / mailparser · htmlparser2 · Zod · pino · Vitest · Docker. Nessun framework, nessun database.

## Avvio rapido

```bash
npm install
docker compose up --build
```

- Pagina di RabbitMQ: http://localhost:15672 (utente `pecmailer`, password `pecmailer`), con tre code per casella: `pecmailer.serfin.serfin-aruba.in`, `.out`, `.dead`, e le stesse per `serfin-legalmail`.
- Greenmail, il finto gestore PEC, solo dello stack locale: in produzione non esiste. Riceve le PEC in SMTP (porta 3025) e le tiene in caselle che si leggono in IMAP (porta 3143, qualunque password). La pagina su http://localhost:8080 documenta la sua interfaccia per i programmi; i messaggi di una casella sono su http://localhost:8080/api/user/destinatario@pec.example/messages/INBOX, oppure in un programma di posta collegato a `localhost:3143`.
- Sonde: http://localhost:3001/health/ready (serfin-aruba), http://localhost:3002/health/ready (serfin-legalmail)

Per fare la parte del CRM da questa macchina, con le impostazioni di [examples/local.env](examples/local.env):

```bash
npm run build
npm run local:publish -- examples/pec.json                       # una PEC con un PDF, nella coda di serfin-aruba
npm run local:publish -- examples/pec.json --mailbox serfin-legalmail
npm run local:outcomes -- --follow                               # cosa è successo, man mano (Ctrl+C per fermare)
```

I container spediscono tramite Greenmail: la PEC arriva nella casella di `destinatario@pec.example`, la sua copia nella cartella Inviata del mittente, il suo esito nella coda di uscita. Greenmail non emette ricevute: per vedere gli eventi delle ricevute bisogna mettere delle ricevute nella casella del mittente, come fanno i test di integrazione. `npm run local:outcomes -- --save data/esiti` scrive in una cartella ogni evento e il file `.eml` di ogni ricevuta.

Operazioni, dentro un container oppure con un `.env` (vedi [.env.example](.env.example)):

```bash
docker compose exec serfin-aruba node dist/main.cli.js config check   # la configurazione con cui gira, senza segreti
docker compose exec serfin-aruba node dist/main.cli.js probe          # accesso SMTP e IMAP, senza spedire nulla
```

## Sviluppo

```bash
npm run check                                         # tipi + lint + formato + test unitari
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration                              # contro un RabbitMQ e un Greenmail veri
```

## Configurazione

Solo variabili d'ambiente, tutte elencate con i valori predefiniti in [.env.example](.env.example): chi è il container (cliente, casella, gestore, mittente), le credenziali della casella, il ritmo e `RABBITMQ_URL`. Le code si chiamano `<prefisso>.<cliente>.<casella>.in`, `.out` e `.dead`. Una variabile sbagliata ferma l'avvio con un messaggio che la nomina.

RabbitMQ richiede due impostazioni, in [docker/rabbitmq/rabbitmq.conf](docker/rabbitmq/rabbitmq.conf): una dimensione massima dei messaggi di 64 MB, perché una PEC da 30 MB dentro un messaggio diventa circa 40 MB e il predefinito è 16 MB; e i 30 minuti di attesa della conferma, su cui sono calcolati i ritentativi.

## Struttura

```
src/
  main.ts        il container: un cliente, una casella
  main.cli.ts    comandi di amministrazione e di sviluppo
  app/           server delle sonde, versione
  config/        schema delle variabili, impostazioni dei gestori
  queue/         l'interfaccia delle code e la sua versione RabbitMQ
  modules/       recipients (controllo PEC) · templates (regole HTML) · attachments (tipo degli allegati)
                 sending (messaggio, SMTP, copia in Inviata) · receipts (lettura ricevute, daticert, IMAP)
  cli/           comandi
  common/        log, segreti, orologio
test/            unit/ integration/ helpers/ fixtures/ (ricevute vere di Aruba, anonimizzate)
docker/          Dockerfile, impostazioni di RabbitMQ
docs/            contratto, guide, decisioni (en/it)
examples/        una PEC e le impostazioni per provare lo stack locale
```

## Messa in produzione

Un Deployment per ogni coppia cliente-casella, con una sola copia: la coda di ingresso lascia comunque prendere le PEC a un solo lettore alla volta. Variabili da una ConfigMap, e da un Secret per la password della casella e `RABBITMQ_URL`. Sonde `/health/live` e `/health/ready` sulla porta 3001; la prontezza è falsa finché la casella è sospesa per una password rifiutata, la vitalità solo quando una gestione è bloccata. `terminationGracePeriodSeconds: 120`: allo stop il container finisce la PEC che ha in mano, entro i tempi massimi di SMTP. Nessun volume: il file system può essere in sola lettura.

Il container crea le sue code all'avvio. Se l'infrastruttura preferisce crearle lei, usa gli stessi parametri (vedi [docs/asyncapi.yaml](docs/asyncapi.yaml)) e imposta `PECMAILER_DECLARE_QUEUES=false`.

## Sicurezza

Vedi [SECURITY.md](SECURITY.md).
