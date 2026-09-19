# Real Aruba PEC receipts

Captured during the first collaudo on a real Aruba PEC mailbox, 19 September 2026: a batch of two messages, one to the sender's own mailbox (with a PDF attachment), one to an address that does not exist on `pec.it`.

| File                           | What it is                                                                                                                                          | `X-Ricevuta` / `X-Trasporto`     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `accettazione.eml`             | Acceptance of message 1                                                                                                                             | `accettazione`                   |
| `avvenuta-consegna.eml`        | Delivery of message 1, complete: carries the original message (`postacert.eml`) with its PDF                                                        | `avvenuta-consegna`              |
| `accettazione-inesistente.eml` | Acceptance of message 2                                                                                                                             | `accettazione`                   |
| `errore-consegna.eml`          | Non-delivery of message 2: `errore="altro"`, `5.1.1 - ARUBA PEC S.p.A. - indirizzo non valido`                                                      | `errore-consegna`                |
| `busta-trasporto.eml`          | Message 1 as it reached the recipient's inbox: a transport envelope, which carries `X-Riferimento-Message-ID` too and must never count as a receipt | `X-Trasporto: posta-certificata` |

## Anonymised

The sender's address and name were replaced (`mittente@pec.example`, "Mittente Collaudo") in every header and every text part, decoding base64 and quoted-printable parts and encoding them again. Every IPv4 address but loopback became a documentation address (`192.0.2.x`). Nothing else was changed: structure, boundaries, Aruba's headers and Message-IDs, the daticert and the PDF are as received.

The provider's S/MIME signature therefore no longer matches the content. This service keeps signatures without verifying them, so the fixtures still exercise everything it does.

Lessons from these receipts, now covered by tests:

- Aruba reports a non-existent mailbox with `errore="altro"`, not `no-dest`: the detail (`errore-esteso`) is what tells the reason.
- The transport envelope carries `X-Riferimento-Message-ID` pointing at our message: only the `X-Trasporto` check keeps it from being taken for a receipt.
- The daticert time has one-second precision.
