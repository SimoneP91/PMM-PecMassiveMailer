# Primo avvio su una macchina nuova

Come mettere in piedi pecmailer da zero e fare le prime prove, tutto in Docker e senza toccare caselle PEC vere. Ogni comando di questa guida è stato eseguito su una copia appena scaricata del progetto.

Serve circa mezz'ora, la maggior parte della quale è attesa per gli scaricamenti.

## Cosa serve sulla macchina

| Cosa               | Versione           | A cosa serve                                                                              |
| ------------------ | ------------------ | ----------------------------------------------------------------------------------------- |
| **Docker Desktop** | 29 o superiore     | Fa girare il servizio, RabbitMQ e il finto gestore PEC. Su Windows richiede WSL2 attivo   |
| **Node.js**        | 24 (vedi `.nvmrc`) | Serve per i comandi di prova e per i test automatici. Il servizio vero gira dentro Docker |
| **git**            | qualsiasi          | Per scaricare il progetto                                                                 |

**Non serve niente altro.** Nessuna casella PEC, nessuna password, nessun database: tutto ciò che occorre per provare è nel progetto.

Se la rete aziendale passa da un proxy, vanno configurati prima sia npm sia Docker, altrimenti gli scaricamenti si fermano.

## 1. Scaricare il progetto

```bash
git clone https://github.com/SimoneP91/PMM-PecMassiveMailer.git
cd PMM-PecMassiveMailer
```

## 2. Installare le librerie

```bash
npm ci
```

`npm ci` installa le librerie esattamente nelle versioni registrate nel progetto, senza aggiornarne nessuna: due macchine ottengono la stessa identica installazione. Alla fine deve dire `found 0 vulnerabilities`.

## 3. Compilare i comandi di prova

```bash
npm run build
```

Traduce il codice TypeScript in JavaScript, nella cartella `dist/`. Serve per i comandi che fanno la parte del CRM (punto 6). I container si compilano da soli quando vengono costruiti.

## 4. Avviare tutto

Aprire Docker Desktop e aspettare che dica "Engine running". Poi:

```bash
docker compose up -d --build --wait
```

La prima volta scarica circa 1,2 GB di immagini e costruisce quella del servizio: possono volerci dieci minuti. Le volte successive parte in una decina di secondi.

Si avviano quattro container:

| Container          | Cos'è                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `rabbitmq`         | Il sistema di code: la porta d'ingresso e di uscita del servizio                                                 |
| `greenmail`        | Un finto gestore PEC, solo per le prove: riceve i messaggi e li tiene in caselle finte. In produzione non esiste |
| `serfin-aruba`     | Un container di pecmailer, per la casella di prova "serfin-aruba"                                                |
| `serfin-legalmail` | Un altro container, per una seconda casella: serve a vedere che ogni casella è separata dalle altre              |

`--wait` fa sì che il comando finisca solo quando tutti i container si dichiarano sani.

## 5. Verificare che sia tutto in piedi

```bash
docker compose ps
curl http://localhost:3001/health/ready
curl http://localhost:3002/health/ready
```

Le due risposte devono essere `{"status":"ok","checks":{"rabbitmq":true,"mailbox":true,"running":true}}`.

Per vedere la configurazione con cui gira un container, senza segreti:

```bash
docker compose exec serfin-aruba node dist/main.cli.js config check
```

Pagine utili nel browser:

- **RabbitMQ**: http://localhost:15672 — utente `pecmailer`, password `pecmailer`. Nella scheda "Queues" si vedono le tre code di ogni casella: `.in` (le PEC da spedire), `.out` (gli esiti e le ricevute), `.dead` (i messaggi illeggibili).
- **Greenmail**: http://localhost:8080 — è la documentazione della sua interfaccia per i programmi, non una casella di posta. I messaggi arrivati si leggono con un indirizzo come http://localhost:8080/api/user/destinatario@pec.example/messages/INBOX

## 6. La prima PEC di prova

Il servizio prende le PEC da una coda. Questi due comandi fanno la parte che in produzione farà il CRM:

```bash
npm run local:publish -- examples/pec.json     # mette una PEC di esempio, con un PDF, nella coda
npm run local:outcomes                         # legge cosa è successo e svuota la coda di uscita
```

Il secondo comando deve stampare una riga come:

```
sent       29f6d1dab654...  <pm.29f6d1dab654...@pec.serfin.example> via SMTP, Sent copy ARCHIVED
```

Significa: la PEC è partita, il finto gestore l'ha presa, e la copia è stata messa nella cartella "Inviata" della casella. Il messaggio si può vedere nella casella del destinatario:

```bash
curl "http://localhost:8080/api/user/destinatario@pec.example/messages/INBOX"
```

Altri modi di provare:

```bash
npm run local:publish -- examples/pec.json --mailbox serfin-legalmail   # l'altra casella
npm run local:outcomes -- --follow                                       # resta in ascolto (Ctrl+C per uscire)
npm run local:outcomes -- --save data/esiti                              # salva ogni evento in una cartella
```

**Le ricevute**: Greenmail non emette ricevute PEC, perché non è un gestore vero. Per vedere gli eventi `receipt` servono i test di integrazione, che mettono ricevute vere e anonimizzate nella casella del mittente, oppure una casella PEC reale.

## 7. I test automatici

```bash
npm run check
```

Controlla i tipi, lo stile del codice, la formattazione ed esegue i test unitari: devono passare **157 test**. Non serve Docker.

```bash
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration
```

Questi provano il servizio contro un RabbitMQ e un Greenmail veri: **20 test**. Usano container e porte separate da quelli del punto 4, così le due cose non si disturbano.

Alla fine:

```bash
docker compose -f docker-compose.test.yml down
```

## 8. Fermare e ripulire

```bash
docker compose down                       # ferma il servizio, tiene i dati di RabbitMQ
docker compose down -v                     # ferma e cancella anche le code
```

## Se qualcosa non va

| Sintomo                                               | Cosa succede                                          | Rimedio                                                                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failed to connect to the docker API`                 | Docker Desktop è spento                               | Aprirlo e aspettare "Engine running", poi ripetere il comando                                                                                                     |
| `port is already allocated`                           | Un'altra cosa usa già quella porta                    | Le porte usate sono 5672 e 15672 (RabbitMQ), 3025, 3143 e 8080 (Greenmail), 3001 e 3002 (le sonde). Si cambiano in `docker-compose.yml`, a sinistra dei due punti |
| `PRECONDITION_FAILED ... inequivalent arg`            | Esiste già una coda creata da una versione precedente | Cancellare le code vuote e riavviare: `docker compose exec rabbitmq rabbitmqctl delete_queue pecmailer.serfin.serfin-aruba.in`                                    |
| `npm run local:publish` dice che non trova `dist/...` | Manca la compilazione                                 | Eseguire `npm run build`                                                                                                                                          |
| Un container resta `unhealthy`                        | Di solito non riesce a raggiungere RabbitMQ           | Guardare i log: `docker compose logs serfin-aruba --tail 50`                                                                                                      |
| Gli scaricamenti si bloccano                          | Proxy aziendale                                       | Configurare il proxy in npm e in Docker Desktop                                                                                                                   |

I log di un container sono righe JSON, una per evento:

```bash
docker compose logs -f serfin-aruba
```

## Cosa non fare

- **Non puntare a caselle PEC vere** senza averlo concordato: ogni PEC spedita ha valore legale e costa. La procedura per provare con una casella vera è nel README, sotto "Sviluppo".
- **Non mettere password nel progetto**: le credenziali stanno solo nelle variabili d'ambiente, e in produzione in un Secret di Kubernetes.

## Dopo le prime prove

- Come il CRM spedisce e legge gli esiti, con esempi in PHP: [messaggi.md](messaggi.md).
- Il contratto formale dei messaggi: [docs/asyncapi.yaml](../asyncapi.yaml).
- Com'è fatto il servizio e perché: `documentation.md` nella radice del progetto e le decisioni in [adr/](adr/).
- Cosa manca prima della produzione: la sezione "What's Next" di `documentation.md`.
