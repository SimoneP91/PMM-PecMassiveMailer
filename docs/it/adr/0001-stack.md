# ADR 0001 — Stack

**Data**: 18/09/2026 · **Stato**: accettata

## Contesto

Un invio PEC single-tenant in PHP/MySQL, incorporato in un CRM, viene riscritto come microservizio multi-tenant autonomo, consegnato come immagine Docker, con MongoDB come database standard aziendale e nessun message broker nell'ambiente.

## Decisione

| Scelta                                                            | Motivo                                                                                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node 24 + TypeScript 5.9, strict, nessun `any` (imposto dal lint) | Il lavoro è I/O (SMTP, IMAP); il contratto API è il prodotto e uno schema tipizzato lo documenta. TypeScript 7 non è ancora supportato dal linter.                                     |
| NestJS 11 su Fastify                                              | Struttura riconoscibile da altri sviluppatori; Fastify sotto per le prestazioni. NestJS 12 era uscito da pochi giorni e l'ecosistema (nestjs-zod, nestjs-pino) non lo supportava.      |
| Zod 4 + nestjs-zod                                                | Un solo schema dà validazione a runtime, tipi statici e documento OpenAPI.                                                                                                             |
| MongoDB 8 + Mongoose 9                                            | Standard aziendale. Gli aggiornamenti atomici su singolo documento reggono la macchina a stati; un replica set a un nodo è necessario anche in locale per transazioni e change stream. |
| Nessun broker: la coda è MongoDB                                  | Un sistema in meno da gestire; a 60 messaggi al minuto per casella una coda su database non è un collo di bottiglia. La coda sta dietro un'interfaccia.                                |
| nodemailer + imapflow                                             | Mantenuti, tipizzati, allegati in streaming, codici SMTP strutturati, nessuna dipendenza dall'estensione imap di PHP ormai deprecata.                                                  |
| pino via nestjs-pino                                              | JSON su stdout per la piattaforma; redazione a livello di logger.                                                                                                                      |
| Vitest + SWC                                                      | Test veloci con supporto ai metadati dei decoratori.                                                                                                                                   |
| Segreti solo dall'ambiente                                        | Il pattern di deploy della piattaforma (Secret di Kubernetes); niente da conservare, niente da cifrare a riposo.                                                                       |

## Conseguenze

- Una immagine, tre comandi; le questioni Kubernetes (repliche, iniezione dei segreti) restano fuori dal codice, ma "una casella, un worker alla volta" è imposto nel codice con un lease, quindi N repliche restano sicure.
- Aggiungere un tenant o una casella è una modifica di configurazione e un riavvio, non una chiamata API: accettabile con 1–3 tenant, da rivedere se cambia.
