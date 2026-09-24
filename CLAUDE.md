# pecmailer — note per l'assistente AI

Da leggere prima di toccare il progetto. Tutto il resto è in [docs/tecnica.md](docs/tecnica.md): architettura, decisioni, trappole, test, primo avvio su una macchina nuova.

## Cos'è

Un servizio che spedisce PEC per conto di un'applicazione (il CRM). Un container serve un cliente e una sua casella: prende le PEC da una coda RabbitMQ di ingresso, le spedisce attraverso il gestore (SMTP), mette una copia nella cartella "Inviata" e legge le ricevute (IMAP), e pubblica su una coda di uscita cosa è successo. **Non conserva niente**: niente database, niente file, niente stato fra un riavvio e l'altro. Versione 0.6.1.

## Cosa non si deve mai rompere

1. **Una PEC non parte mai due volte.** Un messaggio riconsegnato dalla coda può essere già partito: il container cerca la ricevuta del gestore nella casella e dichiara `uncertain` quando non può saperlo. Mai "rispedire e basta".
2. **Un esito non si perde mai.** Il messaggio di ingresso si conferma solo dopo che RabbitMQ ha confermato il suo esito; ogni evento ha un `eventId` stabile, così un evento ripetuto si riconosce.
3. **Niente segreti né dati personali nei log o nel repository.** Le password arrivano dall'ambiente, avvolte in `Secret`; i log portano solo identificativi, codici e conteggi, mai un destinatario, un oggetto, un testo o un allegato.
4. **La casella del cliente è in sola lettura**, tranne la copia in "Inviata".
5. **Un accesso rifiutato sospende la casella** invece di riprovare: ripetuti rifiuti fanno bloccare l'account.

## Comandi

| Comando                                                                                 | Cosa fa                                                                                  |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `npm run check`                                                                         | Tipi, lint, formattazione, test unitari (157). Da lanciare prima di consegnare un lavoro |
| `npm test`                                                                              | Solo i test unitari                                                                      |
| `docker compose -f docker-compose.test.yml up -d --wait` poi `npm run test:integration` | 20 test contro RabbitMQ e Greenmail veri                                                 |
| `npm run build`                                                                         | Compila in `dist/` (serve ai comandi `local:*`)                                          |
| `docker compose up -d --build --wait`                                                   | Lo stack locale: RabbitMQ, Greenmail, due container                                      |
| `npm run local:publish -- examples/pec.json`                                            | Mette una PEC nella coda di ingresso (fa la parte del CRM)                               |
| `npm run local:outcomes -- --follow`                                                    | Legge la coda di uscita                                                                  |
| `docker compose exec serfin-aruba node dist/main.cli.js config check`                   | La configurazione di un container acceso, senza segreti                                  |

## Dove sono le cose

```
src/app/container.ts     tutto collegato a mano: da qui si vede il flusso intero
src/queue/               l'interfaccia Queues; rabbit-queues.ts è l'unico file che conosce RabbitMQ
src/modules/sending/     controlli, MIME, SMTP, copia in Inviata, ritmo, eventi, sospensione
src/modules/receipts/    lettore delle ricevute, parser, ricerca della ricevuta di una PEC riconsegnata
deploy/                  la produzione (Docker Compose) e la procedura per l'IT
docs/                    asyncapi.yaml (il contratto), guida-crm.md, tecnica.md
```

I documenti, uno per pubblico: [README.md](README.md) il progetto (in inglese), [docs/guida-crm.md](docs/guida-crm.md) per chi scrive il CRM, [deploy/README.md](deploy/README.md) per l'IT, [docs/tecnica.md](docs/tecnica.md) per chi sviluppa. Il contratto formale: [docs/asyncapi.yaml](docs/asyncapi.yaml).

## Convenzioni

- TypeScript `strict`, niente `any` (ESLint `strict-type-checked`). Prettier decide la formattazione; a capo LF, imposti da `.gitattributes`.
- **Codice e commenti in inglese. Documentazione in italiano, tranne `README.md` (in inglese) e `CHANGELOG.md`.** Un documento per argomento: niente copie in due lingue, niente documenti che si ripetono.
- Ogni cambiamento di comportamento ha il suo test. I cambiamenti notevoli vanno nel `CHANGELOG.md`; il perché nelle decisioni di `docs/tecnica.md`. Se cambia il contratto dei messaggi, si aggiornano insieme `docs/asyncapi.yaml` e `docs/guida-crm.md`.
- **I commit li fa una persona.** Fai il lavoro, poi consegna un riepilogo e un messaggio di commit suggerito; non eseguire `git commit`, `git push` né `git add`.
- Non leggere né modificare mai `.env`; non toccare `oldProject/` (il vecchio PHP, con credenziali vere) né `data/` (file locali, fuori da git) se non è richiesto.
- Spedire una PEC da una casella vera costa e ha valore legale: mai senza che sia stato chiesto.

## Trappole da conoscere

- **RabbitMQ 4**: un messaggio restituito di proposito non conta nel limite di consegne (da qui la pausa prima di restituirlo); `basic.get` è rifiutato su una coda quorum con un solo consumatore attivo; una coda esistente non si può ridichiarare con argomenti diversi (si cancella vuota e si ridichiara).
- **rabbitmq-client** perde i messaggi che arrivano mentre un consumatore si chiude: il container smette di consumare nell'istante in cui gli si chiede di fermarsi.
- **Greenmail** (solo stack locale e di test) accetta qualunque password, il login è l'indirizzo intero, e non emette ricevute.
- **Windows**: `grep` e `sed` di Git Bash tolgono i ritorni a capo, i byte si controllano con node; nei comandi `docker exec` i percorsi che iniziano con `/` vanno protetti con `MSYS_NO_PATHCONV=1`.
- L'elenco completo, con il perché: [docs/tecnica.md](docs/tecnica.md), sezione 8.
