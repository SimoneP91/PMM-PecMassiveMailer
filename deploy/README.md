# pecmailer — installazione e gestione

Per chi installa e gestisce pecmailer: sistemisti e IT. Cos'è il progetto e come funziona: [README](../README.md), in inglese. Il messaggio che il CRM deve mandare: [docs/guida-crm.md](../docs/guida-crm.md).

pecmailer spedisce PEC per conto di un'applicazione (il CRM). Il CRM mette le PEC in una coda RabbitMQ; pecmailer le spedisce attraverso il gestore PEC (Legalmail), mette una copia nella cartella "Spedite" della casella, legge le ricevute e pubblica gli esiti su un'altra coda, che il CRM legge.

**pecmailer non conserva niente**: niente database, niente file, niente dischi. L'unico dato che vive nell'infrastruttura sono le code di RabbitMQ.

Due modi di installarlo:

- **Kubernetes**, la destinazione prevista: i requisiti dei manifest sono nella sezione 2. I manifest non sono ancora nel repository.
- **Docker Compose su un solo server**: i file pronti sono in questa cartella (sezione 3).

## 1. Cosa serve, in entrambi i casi

- **Linux x86_64** (amd64): le immagini non girano su ARM.
- **L'immagine di pecmailer** nel registro dei container aziendale, con la sua versione, es. `registro.azurecr.io/pecmailer:0.6.1`. La pubblica chi sviluppa ([docs/tecnica.md](../docs/tecnica.md), "Rilascio"). Per scaricarla serve una credenziale che possa **solo scaricare**: su Azure Container Registry un token di sola lettura, o un'identità con il ruolo `AcrPull`.
- **RabbitMQ 4.3** con due impostazioni (file [rabbitmq.conf](rabbitmq.conf)):
  - `max_message_size = 67108864`: una PEC da 30 MB dentro un messaggio diventa circa 40 MB, e il valore predefinito di RabbitMQ è 16 MB;
  - `consumer_timeout = 1800000`: 30 minuti, su cui pecmailer dimensiona i suoi tentativi.
- **Risorse**, come punto di partenza: per pecmailer 256 MiB di memoria richiesti e 1 GiB di limite; per RabbitMQ lo spazio delle PEC in attesa (fino a circa 40 MB l'una). Sono stime, non misure: un test di carico non è ancora stato fatto.

### Rete

| Direzione | Verso                                 | Porta | A cosa serve                                                                    |
| --------- | ------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| Uscita    | `sendm.cert.legalmail.it`             | 465   | SMTP con TLS: la spedizione delle PEC                                           |
| Uscita    | `mbox.cert.legalmail.it`              | 993   | IMAP con TLS: la copia in "Spedite" e la lettura delle ricevute                 |
| Uscita    | il DNS                                | 53    | Anche i record **MX di domini esterni**: servono a riconoscere un indirizzo PEC |
| Uscita    | il registro dei container             | 443   | Scaricare l'immagine di pecmailer                                               |
| Uscita    | Docker Hub                            | 443   | Scaricare l'immagine di RabbitMQ, se non se ne usa una copia nel registro       |
| Entrata   | RabbitMQ, solo dal CRM e da pecmailer | 5672  | AMQP: il CRM pubblica le PEC e legge gli esiti                                  |

pecmailer espone solo la porta 3001, quella delle sonde. Il traffico AMQP sulla 5672 non è cifrato: se il CRM non sta nella stessa rete fidata, va concordato TLS verso RabbitMQ (pecmailer accetta anche `amqps://`).

## 2. Kubernetes

### pecmailer: un Deployment per casella

| Voce                            | Valore                                                                  | Perché                                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repliche                        | **1**                                                                   | La coda fa lavorare un solo consumatore alla volta: altre repliche della stessa casella restano ferme, e leggono le stesse ricevute due volte. Più caselle = più Deployment |
| Aggiornamento                   | `RollingUpdate` o `Recreate`                                            | Vanno bene entrambi: durante un aggiornamento graduale la coda fa lavorare comunque un solo pod                                                                             |
| `terminationGracePeriodSeconds` | **120**                                                                 | Allo stop pecmailer finisce la PEC che ha in mano: un dialogo SMTP interrotto a metà lascerebbe il dubbio se la PEC sia partita                                             |
| Sonda `livenessProbe`           | `GET /health/live` sulla porta 3001                                     | Fallisce solo se pecmailer è bloccato (una gestione oltre 35 minuti): Kubernetes lo riavvia                                                                                 |
| Sonda `readinessProbe`          | `GET /health/ready` sulla porta 3001                                    | Falsa se RabbitMQ non è raggiungibile, se la casella è sospesa o durante lo stop                                                                                            |
| `securityContext`               | `runAsNonRoot: true`, `runAsUser: 1000`, `readOnlyRootFilesystem: true` | Il container gira come utente `node` (uid 1000) e non scrive niente su disco                                                                                                |
| Volumi                          | Nessuno                                                                 | È stateless                                                                                                                                                                 |
| `imagePullSecrets`              | La credenziale di sola lettura del registro                             |                                                                                                                                                                             |

**Variabili**, da una ConfigMap e da un Secret:

| Variabile                 | Esempio                                | Dove                                                                                          |
| ------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `PECMAILER_TENANT`        | `serfin`                               | ConfigMap: il cliente                                                                         |
| `PECMAILER_MAILBOX`       | `serfin-legalmail`                     | ConfigMap: il nome della casella; dà il nome alle code                                        |
| `PECMAILER_PROVIDER`      | `legalmail`                            | ConfigMap: server, porte e cartella "Spedite" vengono dal preset                              |
| `PECMAILER_FROM_ADDRESS`  | l'indirizzo PEC                        | ConfigMap: il mittente                                                                        |
| `PECMAILER_FROM_NAME`     | il nome che vedono i destinatari       | ConfigMap                                                                                     |
| `PECMAILER_PER_MINUTE`    | `5` all'inizio                         | ConfigMap: il ritmo; si alza quando ci si fida del CRM                                        |
| `PECMAILER_SMTP_USERNAME` | `M…`                                   | Secret: il codice utente InfoCert, **non** l'indirizzo                                        |
| `PECMAILER_SMTP_PASSWORD` | —                                      | Secret                                                                                        |
| `RABBITMQ_URL`            | `amqp://utente:password@rabbitmq:5672` | Secret. Nella password solo lettere e numeri: caratteri come `@ : /` romperebbero l'indirizzo |

Tutte le altre variabili, con i loro valori predefiniti, sono in [.env.example](../.env.example). Una variabile sbagliata ferma l'avvio con un messaggio che la nomina.

**Cambiare una ConfigMap o un Secret non basta**: il pod legge le variabili all'avvio. Dopo la modifica: `kubectl rollout restart deployment/<nome>`.

### RabbitMQ

- **Mai come Deployment.** RabbitMQ tiene i dati sotto il proprio nome di nodo, che viene dal nome dell'host: un Deployment cambia nome a ogni riavvio, e RabbitMQ ripartirebbe con le code vuote.
- **RabbitMQ Cluster Operator** (consigliato), oppure uno **StatefulSet** con un disco persistente.
- **3 repliche** reggono la perdita di un nodo senza perdite né fermo: le code quorum si replicano. Con **1 replica** serve un **disco di rete**: se il nodo muore, RabbitMQ riparte altrove e ritrova il disco, con qualche minuto di fermo. Un disco locale lo lega a quel nodo.
- Le due impostazioni di [rabbitmq.conf](rabbitmq.conf) (con l'operator: `additionalConfig`).
- **Le code** le crea pecmailer al primo avvio. Se si preferisce crearle dall'infrastruttura, vanno usati **esattamente** gli argomenti di [docs/asyncapi.yaml](../docs/asyncapi.yaml) (code quorum, un solo consumatore attivo, limite di consegne, scarti "almeno una volta") e in pecmailer va impostato `PECMAILER_DECLARE_QUEUES=false`.

### Prima dell'avvio: provare le credenziali della casella

Prima di avviare il Deployment, un pod (o un Job) una tantum con la stessa immagine, le stesse variabili (`envFrom` della ConfigMap e del Secret) e il comando `node dist/main.cli.js probe`: fa solo il login SMTP e IMAP, senza spedire niente e senza toccare le code. Deve rispondere con due righe `login ok`, e dire che la cartella `INBOX/Spedite` esiste.

Con il Deployment già attivo, lo stesso controllo si fa con `kubectl exec deploy/<nome> -- node dist/main.cli.js probe`.

> **Se l'accesso viene rifiutato, non ripetere il comando.** Troppi accessi rifiutati fanno bloccare la casella dal gestore. Correggere prima il Secret.
>
> Se il comando resta fermo a lungo e poi fallisce, la rete sta bloccando le porte 465 o 993.

La configurazione con cui gira un pod, senza segreti: `kubectl exec deploy/<nome> -- node dist/main.cli.js config check`.

## 3. Docker Compose su un solo server

In questa cartella: [docker-compose.yml](docker-compose.yml) (RabbitMQ e un container per la casella Legalmail), [rabbitmq.conf](rabbitmq.conf) e [.env.example](.env.example), il modello delle impostazioni. Sul server serve solo questa cartella, più **Docker Engine** con il plugin **Docker Compose v2**, avviato all'accensione (`systemctl enable --now docker`).

Tutti i comandi si danno nella cartella copiata sul server, per esempio `/opt/pecmailer`.

**1. Accedere al registro**

```bash
docker login <indirizzo del registro>
```

Con la credenziale di sola lettura, non quella personale di chi installa.

**2. Le impostazioni e le password**

```bash
cp .env.example .env
chmod 600 .env
```

Compilare `.env` seguendo i commenti che contiene. `PECMAILER_IMAGE` è l'immagine da usare, con la versione. La password della casella PEC la inserisce chi ne è responsabile, direttamente sul server: **non va mandata per e-mail né in chat**. `.env` va conservato anche nel gestore delle password aziendale.

**3. Controllare che non manchi niente, e scaricare le immagini**

```bash
docker compose config --quiet
docker compose pull
```

Il primo comando non stampa niente se è tutto a posto; altrimenti elenca per nome ogni valore mancante. Non usare `docker compose config` senza `--quiet`: stamperebbe le password.

**4. Provare le credenziali della casella, senza spedire niente**

```bash
docker compose run --rm --no-deps legalmail node dist/main.cli.js probe
```

Valgono le stesse avvertenze della sezione 2: se l'accesso viene rifiutato, non ripetere.

**5. Avviare e verificare**

```bash
docker compose up -d --wait
docker compose ps
curl http://127.0.0.1:3001/health/ready
```

La sonda deve rispondere `{"status":"ok","checks":{"rabbitmq":true,"mailbox":true,"running":true}}`.

Il compose è già impostato come serve in produzione: 2 minuti per fermarsi, riavvio automatico di ogni servizio, nome host fisso per RabbitMQ, file system in sola lettura, log a rotazione, pagina di RabbitMQ (15672) e sonde (3001) raggiungibili solo dal server. La pagina di RabbitMQ si apre con un tunnel SSH: `ssh -L 15672:127.0.0.1:15672 utente@server`, poi http://localhost:15672.

Rispetto a Kubernetes, Compose **non riavvia un container bloccato** (lo segna come `unhealthy`: serve un allarme) e, se il server muore, non sposta niente altrove.

## 4. L'utente del CRM su RabbitMQ

L'utente di RabbitMQ che usa pecmailer è un amministratore. Al CRM conviene darne uno suo, senza diritti di amministrazione. Con `serfin` come codice del cliente (con Kubernetes: `kubectl exec` nel pod di RabbitMQ; con Compose: `docker compose exec rabbitmq`):

```bash
rabbitmqctl add_user serfin 'PASSWORD-DEL-CRM'
rabbitmqctl set_permissions -p / serfin \
  '^pecmailer\.serfin\..*' '^(amq\.default|pecmailer\.serfin\..*)$' '^pecmailer\.serfin\..*'
```

La password scritta sulla riga di comando resta nella cronologia della shell: cancellarla dopo, oppure creare l'utente dalla pagina di RabbitMQ.

I tre permessi, nell'ordine: creare le code del cliente, pubblicare, leggere le code del cliente. Provati su RabbitMQ 4.3: l'utente pubblica e legge sulle sue code, e non può leggere né creare quelle di un altro cliente.

**Un limite da conoscere**: le PEC si pubblicano attraverso l'exchange predefinito di RabbitMQ (`amq.default`), e RabbitMQ controlla la scrittura sull'exchange, non sulla coda di destinazione. Un utente che può pubblicare può quindi mettere messaggi anche nelle code di ingresso di un altro cliente. Con un solo cliente non ha conseguenze; con più clienti sullo stesso RabbitMQ, ognuno ha il suo virtual host.

## 5. Tenerlo d'occhio

I log sono righe JSON sullo standard output, una per evento, pronte per Graylog. Non contengono destinatari, oggetti, testi né allegati: solo identificativi, codici e conteggi.

| Allarme                                                                                                                                                                            | Significa                                                                                                               | Cosa fare                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Nei log una riga `"level":"error"` con `mailbox suspended until the container restarts`; la sonda `/health/ready` risponde 503; sulla coda di uscita un evento `mailbox.suspended` | Il gestore ha rifiutato la password. pecmailer smette apposta di spedire e di leggere; le PEC restano al sicuro in coda | Correggere la password, poi riavviare pecmailer |
| Messaggi nelle code `.dead`                                                                                                                                                        | Messaggi che nessuno gestirà: illeggibili, o che hanno fatto fermare il container più volte                             | Li deve guardare una persona                    |
| Spazio sul disco di RabbitMQ                                                                                                                                                       | Se finisce, RabbitMQ blocca le pubblicazioni per proteggersi: tutto si ferma in sicurezza                               | Liberare o allargare il disco                   |
| Con Compose: container `unhealthy`                                                                                                                                                 | pecmailer è bloccato, e Compose non lo riavvia                                                                          | `docker compose restart legalmail`              |

Per vedere le code: `rabbitmqctl list_queues name messages`.

Con Compose, per mandare i log a Graylog si sostituisce il blocco `x-logging` del `docker-compose.yml` con il driver `gelf` (`gelf-address: udp://graylog.esempio.local:12201`).

## 6. Operazioni

| Operazione                           | Kubernetes                                                                             | Docker Compose                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Passare a un'altra versione**      | Cambiare la versione dell'immagine nel Deployment                                      | Cambiare `PECMAILER_IMAGE` in `.env`, poi `docker compose pull` e `docker compose up -d --wait`                                             |
| **Tornare alla versione precedente** | `kubectl rollout undo`, o la versione di prima nel Deployment                          | La versione di prima in `.env`, poi `docker compose up -d --wait`                                                                           |
| **Cambiare un'impostazione**         | Modificare ConfigMap o Secret, poi `kubectl rollout restart`                           | Modificare `.env`, poi `docker compose up -d`. **Non** `docker compose restart`: riavvia con i valori vecchi                                |
| **Cambiare la password di RabbitMQ** | `rabbitmqctl change_password <utente> '<nuova>'`, poi aggiornare il Secret e riavviare | Come a sinistra, poi `.env` e `docker compose up -d`. `RABBITMQ_USER` e `RABBITMQ_PASSWORD` di `.env` valgono solo al primo avvio           |
| **Aggiungere una casella**           | Un Deployment in più, con la sua ConfigMap e il suo Secret                             | Copiare il blocco `legalmail` nel `docker-compose.yml`, con un altro nome e un'altra porta (3002…), e aggiungere le sue variabili in `.env` |

Prima di aggiornare si leggono le note della versione in [CHANGELOG.md](../CHANGELOG.md): alcune versioni chiedono di ricreare le code, perché RabbitMQ rifiuta di dichiarare una coda esistente con argomenti diversi (si cancella vuota e si lascia ricreare a pecmailer).

## 7. Salvataggi e ripristino

**L'unico dato è il disco di RabbitMQ**: le PEC in attesa e gli esiti che il CRM non ha ancora letto. pecmailer non ha niente da salvare. La vera memoria del sistema è nel database del CRM e nella casella PEC.

| Evento                                | Cosa succede                                                                                                     | Cosa fare                                                                                                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pecmailer si ferma o viene spostato   | Finisce la PEC in corso; le altre aspettano in coda                                                              | Niente                                                                                                                                                                                                  |
| pecmailer muore di colpo              | La PEC in corso torna in coda; al riavvio pecmailer cerca la sua ricevuta: `sent` se c'è, altrimenti `uncertain` | Niente: gli `uncertain` li gestisce il CRM                                                                                                                                                              |
| RabbitMQ si ferma o muore             | Riparte e ritrova tutto (provato uccidendolo di colpo con PEC in coda); pecmailer si ricollega da solo           | Niente                                                                                                                                                                                                  |
| **Si perde il disco di RabbitMQ**     | Si perdono le PEC in attesa e gli esiti non letti                                                                | Avvisare chi gestisce il CRM: aspetta che pecmailer ripubblichi le ricevute dalla casella, poi ripubblica solo le PEC rimaste senza (procedura in [docs/guida-crm.md](../docs/guida-crm.md), sezione 6) |
| pecmailer fermo per **più di 24 ore** | Al riavvio rilegge solo le ultime 24 ore della casella: le ricevute più vecchie non tornano da sole              | Prima di riavviare, alzare `PECMAILER_RECEIPTS_LOOKBACK_HOURS` (fino a 720 ore) quanto è durato il fermo; poi riportarla a 24                                                                           |

Con Compose, il disco è il volume `pecmailer_rabbitmq-data`, e si copia a RabbitMQ fermo. Per un riavvio programmato del server: prima `docker compose stop`, così pecmailer finisce con calma la PEC in corso.

## 8. Cosa non fare

- **Cancellare il disco di RabbitMQ** (con Compose: `docker compose down -v`): con lui se ne vanno le PEC in attesa.
- **Più repliche o più container sulla stessa casella**: ne lavora comunque uno solo, e gli altri pubblicano di nuovo le stesse ricevute.
- **Accorciare il tempo di arresto** sotto i 2 minuti: un container ucciso durante un invio lascia una PEC di esito incerto.
- **Ripetere un accesso rifiutato** alla casella: il gestore la blocca.
- **Cambiare a mano gli argomenti delle code**: RabbitMQ rifiuta poi di dichiararle, e pecmailer non parte.
- **RabbitMQ come Deployment**, o senza nome host fisso con Compose: ricreandolo, ripartirebbe con le code vuote.
- **Toccare la casella PEC a mano**: niente pulizie e niente regole che spostano i messaggi. pecmailer legge le ricevute in `INBOX`; una ricevuta tolta prima che la legga non arriva mai al CRM.
