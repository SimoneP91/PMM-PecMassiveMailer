# pecmailer

Microservizio multi-tenant che spedisce PEC per conto di applicazioni clienti, raccoglie le ricevute legali e conserva tutto ciò che ha spedito.

> English documentation: [README.md](README.md)

Il cliente invia un **lotto**: un template, una casella, N destinatari ciascuno con i propri valori per i placeholder e i propri allegati, in una sola chiamata HTTP. Il servizio valida tutto in anticipo, spedisce al ritmo consentito dal provider, archivia una copia nella cartella Inviata della casella, legge le ricevute di accettazione e consegna e avvisa il cliente quando il lotto è partito e quando è concluso.

## Stato

Tutte e cinque le fasi sono fatte: i lotti vengono accettati, **spediti**, **seguiti** e **chiusi**. Il cliente invia template, casella e fino a 2.500 destinatari con i loro file in una sola chiamata multipart; ogni riga è validata, resa e messa in coda; il worker spedisce ogni messaggio una volta sola, al ritmo della casella, archivia i byte esatti, ne mette una copia in Inviata e non indovina mai quando l'esito è ignoto (STUCK, per un operatore). Poi legge le ricevute PEC dalla casella (in sola lettura), porta ogni messaggio in ACCEPTED, DELIVERED o NOT_DELIVERED, conserva ogni ricevuta come prova legale e chiude il lotto quando ogni esito è noto o dopo 30 ore. Il cliente elenca e cerca lotti e messaggi, scarica l'EML esatto e ogni ricevuta con le loro impronte, annulla ciò che non è partito e riceve webhook firmati quando un lotto è partito, quando è chiuso e quando una casella viene sospesa.

| Fase | Contenuto                                                                                                            | Stato |
| ---- | -------------------------------------------------------------------------------------------------------------------- | ----- |
| 1    | strumenti, Docker, configurazione, health, Swagger, `GET /v1/mailboxes`                                              | fatta |
| 2    | `POST /v1/batches`: ricezione multipart, regole dei template, verifica PEC del destinatario, allegati, prova a vuoto | fatta |
| 3    | worker di invio: lease della casella, pacing, SMTP, copia IMAP, archivio EML, macchina a stati                       | fatta |
| 4    | endpoint di lettura: lotti, messaggi, ricerca, annullamento                                                          | fatta |
| 5    | ricevute, webhook, chiusura del lotto                                                                                | fatta |

## Stack

Node 24 · TypeScript 5.9 (strict, nessun `any`) · NestJS 11 su Fastify · MongoDB 8 + Mongoose · Zod (validazione e OpenAPI dagli stessi schemi) · nodemailer / imapflow · pino · Vitest · Docker.

## Avvio rapido

```bash
cp .env.example .env
cp config/pecmailer.example.yaml config/pecmailer.yaml
npm install
npm run build
npm run cli -- api-key generate --label "locale"  # incolla l'hash in config/pecmailer.yaml
npm run cli -- config check                       # niente parte finché questo non passa
docker compose up --build
```

Poi:

- Swagger UI: http://localhost:3000/docs
- health: http://localhost:3000/health/ready
- `curl -H "Authorization: Bearer pm_..." http://localhost:3000/v1/mailboxes`
- invio di un lotto (una chiamata: parte JSON + parti file):

  ```bash
  curl -X POST http://localhost:3000/v1/batches \
    -H "Authorization: Bearer pm_..." \
    -H "Idempotency-Key: $(uuidgen)" \
    -F 'batch={"mailbox":"serfin-aruba","template":{"subject":"Pratica {{n}}","html":"<p>Gentile {{name}}</p>"},"messages":[{"ref":"1","to":"x@pec.it","vars":{"n":"1","name":"Rossi"},"attachments":[{"part":"doc"}]}]};type=application/json' \
    -F 'doc=@sollecito.pdf'
  ```

  Con `"options":{"dryRun":true}` valida e mostra l'anteprima senza creare nulla.

- seguirlo:

  ```bash
  curl -H "Authorization: Bearer pm_..." http://localhost:3000/v1/batches/b_...                 # stato e contatori
  curl -H "Authorization: Bearer pm_..." "http://localhost:3000/v1/messages?ref=1"              # ritrovare una riga col proprio ref
  curl -H "Authorization: Bearer pm_..." -OJ http://localhost:3000/v1/messages/m_.../eml         # ciò che è partito
  curl -X POST -H "Authorization: Bearer pm_..." http://localhost:3000/v1/batches/b_.../cancel   # fermare ciò che non è partito
  curl -H "Authorization: Bearer pm_..." http://localhost:3000/v1/messages/m_.../receipts       # accettazione, consegna...
  curl -H "Authorization: Bearer pm_..." -OJ http://localhost:3000/v1/receipts/r_.../eml         # una ricevuta, la prova legale
  ```

- Greenmail (finto provider PEC), interfaccia web: http://localhost:8080
- probe del worker: http://localhost:3001/health/live

Operazioni (stessa immagine, `node dist/main.cli.js`, oppure `npm run cli --` in locale):

```bash
npm run cli -- db sync-indexes --dry-run    # indici da creare/eliminare; senza --dry-run li applica
npm run cli -- mailbox list                 # stato di ogni casella e quale worker la detiene
npm run cli -- mailbox probe serfin-aruba   # login SMTP + IMAP con le credenziali configurate
npm run cli -- mailbox activate serfin-aruba
npm run cli -- message stuck                # messaggi dall'esito ignoto
npm run cli -- message resolve m_... --as sent|requeue|failed
npm run cli -- webhook list                 # eventi non ancora consegnati, con l'ultimo errore
npm run cli -- webhook retry ev_...         # un evento FAILED riceve una nuova finestra di 24 ore
```

## Sviluppo

```bash
npm run dev:api          # API con ricarica automatica
npm run dev:worker       # worker con ricarica automatica
npm run check            # typecheck + lint + formato + test unitari: ciò che esegue la CI
npm run test:e2e         # superficie HTTP contro un MongoDB in memoria (binario scaricato una volta, ~800 MB)
npm run test:integration # IMAP reale contro Greenmail: prima docker compose -f docker-compose.test.yml up -d
npm run openapi:export   # scrive openapi.json per chi integra
```

## Configurazione

Due sorgenti, lette una volta all'avvio; il processo si rifiuta di partire se una delle due non è valida:

- **ambiente** ([.env.example](.env.example)): porte, database, percorsi e ogni segreto — password delle caselle come `MAILBOX_<CODICE>_PASSWORD`, segreti di firma dei webhook per nome.
- **file di configurazione** ([config/pecmailer.example.yaml](config/pecmailer.example.yaml)): tenant, hash delle loro chiavi API, caselle e limiti. Non contiene segreti; in Kubernetes è una ConfigMap.

## Struttura

```
src/
  main.api.ts | main.worker.ts | main.cli.ts   entry point, una sola immagine
  app/          moduli per entry point, Swagger
  config/       schemi di ambiente e file di configurazione, loader
  common/       errori (RFC 9457), logging, sicurezza, id, tempo
  database/     connessione MongoDB
  modules/      auth · tenants · mailboxes · batches · messages · templates · recipients · attachments · sending · health
  cli/          comandi di amministrazione
test/
  unit/ integration/ e2e/ security/
docker/         Dockerfile, init di mongo
config/         configurazione di esempio
docs/           architettura, API, decisioni (en/it)
```

## Rilasciare una versione

1. Costruire e pubblicare l'immagine.
2. Eseguire una volta `node dist/main.cli.js db sync-indexes` con la nuova immagine (un Job Kubernetes): in produzione né l'API né il worker creano indici, e alcuni portano garanzie (una `dedupKey` usata una sola volta per tenant).
3. Aggiornare API e worker.

## Sicurezza

Vedi [SECURITY.md](SECURITY.md). In breve: le chiavi API sono conservate come hash, le password delle caselle non lasciano mai l'ambiente, ogni errore è un problem document che non porta mai un messaggio interno, e nessun tenant può nominarne un altro in nessuna richiesta.
