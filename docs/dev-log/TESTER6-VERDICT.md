# TESTER6 VERDICT: Sprint 10 (PayPal Invoicing as the core), branch `sprint10-invoicing` @ 9dc3bfd

Independent re-test, 2026-11-11 12:41–12:50 UTC. Worktree `app-sprint10/` only. No product code edited, nothing pushed.
`../app/`, `data/rentroll.db` and `rentroll.service` were not touched. I only read the live raw log `../app/.sprint0-webhook-log.jsonl`.

## Setup (my own, not the builder's script)
- Fresh throwaway DB `$TMPDIR/t6/test.db`: `node server.js --seed --no-invoices`, then my own offset script. Ids are shifted
  **+2000** (rp 2001–2003), so they can't collide with the live service (1–3) or the builder's run (1001–1003). Port 8820, random local-only login.
- **Independent PayPal client** `scratch/t6/ppget.py` (gitignored): its own OAuth token and raw `urllib` calls. It doesn't import any
  RentRoll code (`lib/paypal.js` / `lib/invoicing.js` are not used). Every "independent GET" below comes from it, not from RentRoll's API.
- Driver `scratch/t6/drive.sh`: one process tree, because the sandbox gives each command its own network namespace. Transcript in `$TMPDIR/t6/run.txt`.
- The plan was deliberately **unequal** ($600 now + $1,200 on the 20th). That way `minimum_amount_due` has to change twice, which
  covers the gap the builder listed as limit 4.

## 1. Fresh seed creates real invoices: PASS
Server start log: `[invoice] {"rent_period_id":2001,"invoice_id":"INV2-UQ8A-PA7H-ZGWL-MZDM","invoice_number":"RR202611U1P2001-C3Y2ID","status":"SENT"}`,
plus 2002 → `INV2-WLC4-Q55T-JT3A-732W` and 2003 → `INV2-Q2LV-9AXB-39E5-MLK2`. Independent GET of all three:
```
{"http":200,"id":"INV2-UQ8A-PA7H-ZGWL-MZDM","number":"RR202611U1P2001-C3Y2ID","status":"SENT","amount":"1800.00","due_amount":"1800.00","partial_payment":null,"payment_term":{"term_type":"DUE_ON_DATE_SPECIFIED","due_date":"2026-11-01"},"transactions":[]}
{"http":200,"id":"INV2-WLC4-Q55T-JT3A-732W","number":"RR202611U2P2002-C3Y4VF","status":"SENT","amount":"1200.00",...,"due_date":"2026-11-01"}
{"http":200,"id":"INV2-Q2LV-9AXB-39E5-MLK2","number":"RR202611U3P2003-C3Y6CF","status":"SENT","amount":"950.00",...,"due_date":"2026-11-08"}
```
The amounts and due dates match the seeded rent periods. A restart on the same DB created no duplicate invoices: the second start logged no new `[invoice]` lines.

## 2. Approving a plan changes the REAL invoice: PASS
Real tenant message → real NVIDIA LLM: `plan 1 proposed [('2026-11-11', 60000), ('2026-11-20', 120000)]`.
- Independent GET **before** approve: `"partial_payment": null, "payment_term": {"due_date": "2026-11-01"}`, last_update 12:41:08Z
- `POST /api/plans/1/approve` → `ok True plan approved`
- Independent GET **after** approve:
  `"partial_payment": {"allow_partial_payment": true, "minimum_amount_due": {"currency_code":"USD","value":"600.00"}}, "payment_term": {"term_type":"DUE_ON_DATE_SPECIFIED","due_date":"2026-11-11"}`, last_update 12:44:04Z
- After installment 1 was paid, independent GET: `"minimum_amount_due": {"value":"1200.00"}, "due_date": "2026-11-20"`.
  So the minimum changed twice on PayPal's side (off → $600 → $1,200), and the due date did too (11-01 → 11-11 → 11-20).

## 3. Payment flow end to end: PASS
- Wrong amounts, all refused **before** any PayPal call:
  - `1800.00` → `HTTP 422 {"ok":false,"error":"approved plan #1 only accepts installment 1 of 2: exactly $600.00 (due 2026-11-11). $1,800.00 refused"}`
  - `599.99` → `HTTP 422`, `1200.00` → `HTTP 422` (same message)
  - Independent GET afterwards: still `SENT`, `transactions: []`, last_update unchanged (12:44:04Z).
- Installment 1 `600.00`: `order 0KK10420YM140843L capture 2RK438383S752241J COMPLETED`.
  - Independent capture GET: `HTTP 200 {"id":"2RK438383S752241J","status":"COMPLETED","amount":{"value":"600.00"},"custom_id":"RR:rp2001:2026-11:u1:i1:54c0080d"}`.
  - Independent invoice GET: `"status":"PARTIALLY_PAID","due_amount":"1200.00","paid":"600.00","transactions":[["EXTR-3UH4196796645364N","EXTERNAL","PAYPAL","600.00","RentRoll payment #1: card charged through the PayPal Orders API, order 0KK10420YM140843L, capture 2RK438383S75…"]]`
- Installment 2 `1200.00`: `capture 8N696841RB895542X COMPLETED plan completed`, period PAID.
  - Independent GET: `"status":"MARKED_AS_PAID","due_amount":"0.00","paid":"1800.00"`, two EXTERNAL/PAYPAL transactions (600.00, 1200.00).
- After the invoice was paid in full, `10.00` → `HTTP 409 {"ok":false,"error":"Unit 2 2026-11 has no open balance"}`.
- Status sequence on PayPal: SENT → PARTIALLY_PAID → MARKED_AS_PAID, as claimed.

## 4. Webhook reconciliation: PASS (replayed real signed deliveries, not a live delivery to this build)
- **Code:** `handleWebhook` (server.js:796) verifies the signature first, and in enforce mode (the default, server.js:45) rejects anything
  that isn't SUCCESS. Then `handleInvoiceEvent` (server.js:653):
  - It uses the payload only for the invoice id. The payload's status and paid amount go only into `payload_claimed`, for audit.
  - All numbers come from `invoiceFacts(await getInvoice(invId))` (server.js:664).
  - Transactions are matched by `invoice_payment_id`, then by the capture id in the note. Only unknown transactions are inserted.
- **Delivery method:** PayPal delivers to the live service (old build), so this build can't receive a live delivery. I copied the real
  signed deliveries for my capture and invoice from the live raw log (read-only) and ran `node server.js --ingest-webhook-log`.
  That re-verifies each delivery with PayPal. These are the same steps the builder used, run on my own fresh events:
```
PAYMENT.CAPTURE.COMPLETED WH-2AB519258T598103H-77T98872CF6283122 -> payment_confirmed sig SUCCESS
INVOICING.INVOICE.CREATED WH-8RD69457M25045509-4B232752YG249442N -> invoice_reconciled sig SUCCESS | inv PARTIALLY_PAID 60000 local 60000 match True added 0
INVOICING.INVOICE.SENT    WH-2SD59344WS318514X-1W3560648F7733818 -> invoice_reconciled sig SUCCESS | inv PARTIALLY_PAID 60000 ...
INVOICING.INVOICE.UPDATED WH-64M0398308137262E-0KU60126R65535433 -> invoice_reconciled sig SUCCESS | ...
INVOICING.INVOICE.PAID    WH-5K8454979T721751L-7YC18422PG729445S -> invoice_reconciled sig SUCCESS | ...
INVOICING.INVOICE.UPDATED WH-3RK851153B776352N-10X06651SY568992K -> invoice_reconciled sig SUCCESS | ...
```
- **The reconcile reads the live GET, not the payload:**
  - The CREATED and SENT payloads claim `SENT` with nothing paid.
  - The reconcile result for those same events is `PARTIALLY_PAID 60000`: the invoice's state at replay time.
- A second ingest of all 10 events gave `Counter({'duplicate': 10})`.

## 5. Court packet: PASS (one cosmetic labelling issue, see finding A)
- `court-packet.json` → HTTP 200: `packet.invoice: {"id":"INV2-UQ8A-PA7H-ZGWL-MZDM","number":"RR202611U1P2001-C3Y2ID","status":"MARKED_AS_PAID","paid_cents":180000,"due_cents":0,"total_cents":180000,"allow_partial_payment":true,"minimum_amount_due_cents":120000,"due_date":"2026-11-20","source":"read live from PayPal","matches_ledger":true}`
  - Transactions: `[('EXTR-3UH4196796645364N',60000,'EXTERNAL','PAYPAL'),('EXTR-5UT354765X616353F',120000,'EXTERNAL','PAYPAL')]`.
  - All of these match my independent final GET exactly (status, 1800.00 paid, 0.00 due, min 1200.00, due 2026-11-20, both EXTR ids and amounts).
- `court-packet.pdf` → `HTTP 200 11640B application/pdf`. `pdftotext` shows a "PayPal invoice" section with:
  `RR202611U1P2001-C3Y2ID`, `INV2-UQ8A-PA7H-ZGWL-MZDM`, `MARKED_AS_PAID (read live from PayPal, 2026-11-11 12:47:05 UTC)`,
  `$1,800.00 paid / $0.00 due`, `minimum amount due $1,200.00; due date 2026-11-20`, the payer link, and `EXTR-3UH4196796645364N: $600.00 EXTERNAL/PAYPAL …`.

## 6. Regression check: PASS
- Dashboard: `GET /` with the login → 200. It shows `PayPal invoice RR202611U1P2001-C3Y2ID · MARKED_AS_PAID`, `… U2P2002 … · PARTIALLY_PAID` and `… U3P2003 … · SENT`.
- Forged webhooks → 400, and nothing was written to the ledger (0 event_log rows for the forged ids; rp2002 unchanged):
  - a) no PayPal headers, forged `INVOICING.INVOICE.PAID` claiming PAID $1,200 → `400 {"result":"rejected_signature","verification":"SKIPPED_NO_HEADERS"}`
  - b) fake signature headers → `400 {"result":"rejected_signature","verification":"FAILURE"}`
  - c) real PayPal headers from `WH-79887841F51808321-4SH06559VG8872110` with the body tampered → `400 … "FAILURE"`
- Outside payment: I called record-payment directly at PayPal from my own client (method CASH, $150), not through RentRoll:
  `HTTP 200 {"payment_id":"EXTR-2NA64517GN536762E"}`. The independent GET showed PARTIALLY_PAID, paid 150.00.
  - Ingesting the real signed INV2-WLC4 deliveries: `CREATED … added 1 matched 0`, then `SENT … added 0 matched 1`, then `PAID … added 0 matched 1`.
  - DB afterwards: exactly **one** row, `(3,'paypal_invoice','COMPLETED',15000,None,'EXTR-2NA64517GN536762E',…)`. rp2002 `PARTIALLY_PAID 15000`, matching PayPal.
  - Re-ingest → all duplicates. No double counting.
- Basic Auth, no login:
  - 401: `/`, `/api/rent-periods`, `/api/rent-periods/2001/invoice`, `/api/rent-periods/2001/court-packet.json`, `POST /api/plans/1/approve`. Wrong password → 401.
  - 200: `/healthz` and `/HEALTHZ/`.
  - `POST /webhooks/paypal` (empty body) → 400, from the route itself rather than auth.

## 7. Honesty check: PASS (one minor wording issue, see finding B)
README.md:27 and ../SUBMISSION.md:19 say plainly that:
- the card is charged through Orders, not on the hosted invoice page;
- the payment is recorded with record-payment as `EXTERNAL`/`PAYPAL`, with the capture id in the note;
- the final status is `MARKED_AS_PAID`;
- the hosted-page guest payment wasn't tested.

All of that matches what I saw on PayPal. README.md:17 says "PayPal only enforces a minimum, not a schedule" and that RentRoll does the exact-amount enforcement. That is accurate (step 3).

## Findings (non-blocking)
- **A. (cosmetic, but it ends up in a court document)** The packet can cite an invoice webhook that predates the payment.
  - PDF, payment #1: "confirmed by PayPal invoice event WH-8RD69457M25045509-4B232752YG249442N". That is `INVOICING.INVOICE.CREATED`,
    delivered 12:41:23, while the payment was recorded at 12:44:14.
  - Cause: `handleInvoiceEvent` sets `invoice_webhook_event_id` on every matched payment, for whichever invoice event is processed first after the payment exists (server.js:677).
  - In replay order the old CREATED event comes after the capture. The builder's run had the same issue (SENT event `WH-4FG756…`).
  - Live, events arrive in time order, so this mostly affects backfills.
  - Suggested fix (post-merge OK): only set it when `event.create_time >= payment.invoice_recorded_at`, or prefer `INVOICING.INVOICE.PAID`.
- **B. (wording)** ../SUBMISSION.md:19, "A payment made there would still reach the ledger through the INVOICING.INVOICE.PAID webhook", is stated as fact.
  - README.md:27 adds the correct qualifier: "coded, but only tested with a payment recorded directly on PayPal's side".
  - Suggest adding the same qualifier to SUBMISSION.
- **C. (deploy note, already in SPRINT10)** The live service still runs the pre-Invoicing build. Until this branch is deployed, live
  INVOICING webhooks are only `logged`, and step 4 of the SUBMISSION demo ("PayPal-confirmed badge") depends on the deploy plus a restart.

## Not tested by me
- Hosted-invoice-page guest payment: no browser in the sandbox. Same limit the builder reported.
- `--open-month`, cancelling an approved plan, and the PUT-refused failure branch.
- A live webhook delivery to this build: not possible before deploy. I replayed real signed deliveries instead.

TESTER6 VERDICT: PASS — every claim I re-tested holds up against my own independent PayPal client: per-period SENT invoices, plan approval rewriting the real invoice's `minimum_amount_due` and due date twice, captures recorded so the invoice goes SENT → PARTIALLY_PAID → MARKED_AS_PAID, wrong amounts refused with 422 before PayPal is called, signed INVOICING webhooks reconciled from a live GET, the outside payment added exactly once, and forged webhooks rejected with 400; two small non-blocking issues remain (packet webhook label A, SUBMISSION wording B).
