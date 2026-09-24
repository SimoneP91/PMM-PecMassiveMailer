# Ricevute PEC Aruba vere

Raccolte durante il primo collaudo su una casella PEC Aruba vera, il 19 settembre 2026: un lotto di due messaggi, uno alla casella stessa del mittente (con un PDF allegato), uno a un indirizzo inesistente su `pec.it`.

| File                           | Cos'è                                                                                                                                                                              | `X-Ricevuta` / `X-Trasporto`     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `accettazione.eml`             | Accettazione del messaggio 1                                                                                                                                                       | `accettazione`                   |
| `avvenuta-consegna.eml`        | Consegna del messaggio 1, completa: contiene il messaggio originale (`postacert.eml`) con il suo PDF                                                                               | `avvenuta-consegna`              |
| `accettazione-inesistente.eml` | Accettazione del messaggio 2                                                                                                                                                       | `accettazione`                   |
| `errore-consegna.eml`          | Mancata consegna del messaggio 2: `errore="altro"`, `5.1.1 - ARUBA PEC S.p.A. - indirizzo non valido`                                                                              | `errore-consegna`                |
| `busta-trasporto.eml`          | Il messaggio 1 come è arrivato nella casella del destinatario: una busta di trasporto, che porta anch'essa `X-Riferimento-Message-ID` e non deve mai essere presa per una ricevuta | `X-Trasporto: posta-certificata` |

## Anonimizzate

L'indirizzo e il nome del mittente sono stati sostituiti (`mittente@pec.example`, "Mittente Collaudo") in ogni intestazione e in ogni parte di testo, decodificando le parti base64 e quoted-printable e ricodificandole. Ogni indirizzo IPv4 tranne il loopback è diventato un indirizzo di documentazione (`192.0.2.x`). Nient'altro è stato cambiato: struttura, delimitatori, intestazioni e Message-ID di Aruba, il daticert e il PDF sono come sono arrivati.

La firma S/MIME del gestore quindi non corrisponde più al contenuto. Il servizio conserva le firme senza verificarle, quindi queste ricevute esercitano comunque tutto quello che fa.

Cosa hanno insegnato, ora coperto dai test:

- Aruba segnala una casella inesistente con `errore="altro"`, non con `no-dest`: il motivo sta nel dettaglio (`errore-esteso`).
- La busta di trasporto porta `X-Riferimento-Message-ID` che punta al nostro messaggio: solo il controllo su `X-Trasporto` impedisce di prenderla per una ricevuta.
- L'orario del daticert ha la precisione di un secondo.
