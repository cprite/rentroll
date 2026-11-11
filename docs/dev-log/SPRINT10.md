# SPRINT 10: PayPal Invoicing is the core (2026-11-11, ~11:35–12:50 UTC)

**Branch:** `sprint10-invoicing` (worktree `app-sprint10/`, based on `main` `a169aa6`, which includes the creds cleanup).
Nothing pushed. Nothing under `app/` edited. I only read the live raw webhook log `../app/.sprint0-webhook-log.jsonl`,
to replay PayPal's signed deliveries into the test DB. The real `data/rentroll.db` and `rentroll.service` weren't touched.
No login or password text was changed. The README/SUBMISSION diff only touches the Orders/Invoicing passages.

## Summary

- **Tenant payment path used: Orders card capture + Invoicing `record-payment` (the pre-approved fallback).**
  - The tenant's card is charged through the Orders API with the PayPal sandbox test card, no login.
  - RentRoll then records that capture on the real invoice.
  - The invoice itself moves SENT → PARTIALLY_PAID → MARKED_AS_PAID, and PayPal fires signed `INVOICING.INVOICE.PAID` webhooks.
- **Hosted invoice page with a guest card: NOT TESTED** (not "proven to need a login"):
  - Headless Chromium can't start in the build sandbox: `FATAL: process_singleton_posix.cc:297 Check failed: . socket() failed: Operation not permitted`.
  - The payer page (`https://www.sandbox.paypal.com/invoice/p/#<id>`) is a JS app, so a plain HTTP fetch shows nothing.
  - I stopped there (~20 min budget).
  - If a tenant pays on that page, the webhook reconcile adds the payment from a GET of the invoice (see "outside payment" below).
- **Plan approval rewrites the real invoice: PASS.**
  - `PUT /v2/invoicing/invoices/{id}` on an already SENT invoice changed both of these, and an independent GET confirmed it:
    - `configuration.partial_payment`: off → `{allow_partial_payment: true, minimum_amount_due: 900.00}`
    - `detail.payment_term.due_date`: 2026-11-01 → 2026-11-11
  - After installment 1 was paid, RentRoll moved the due date on to 2026-11-15, the next installment.
- **Real invoice per rent period: PASS.** On startup, all 3 seeded periods got a created + sent invoice. The id and number are stored on `rent_period`.
- **Invoicing webhooks: PASS.**
  - Every `INVOICING.INVOICE.*` delivery was signature-verified (SUCCESS).
  - Each one triggers a GET of the invoice and a reconcile of its transactions against the ledger. All matched.
  - `PAYMENT.CAPTURE.COMPLETED` handling is unchanged and still confirms captures.
- **Court packet cites the invoice: PASS.**
  - The JSON and PDF both have a "PayPal invoice" section: number, id, live status, paid/due, terms, payer link and transactions.
  - Each payment shows its invoice payment id (`EXTR-…`).

## What the API actually does (differences from the brief / SPRINT0)

1. **Token:** now 27 scopes, including `https://uri.paypal.com/services/invoicing` (was 26, with no invoicing scope).
2. **`detail.invoice_number` must be under 25 characters.**
   - `RR-2026-11-U1-RP1001-MWC24U61` got `400 INVALID_REQUEST`, `details[0]`:
     `{"field":"/detail/invoice_number","issue":"INVALID_STRING_MAX_LENGTH","description":"Invoice number length should be less than 25 characters."}`
   - Run 1 of the real test failed on this, and every invoice step was skipped. Fixed in `53d6e02`: format is now `RR202611U1P1001-C251XZ`.
3. **record-payment refuses our capture id as `payment_id`.**
   - `POST /v2/invoicing/invoices/{id}/payments` with `{"method":"PAYPAL","payment_id":"9J760476T11449604",...}` returned
     `404 RESOURCE_NOT_FOUND` (debug f56148799ed1c).
   - Without `payment_id` it works:
     - request: `{"method":"PAYPAL","payment_date":"2026-11-11","amount":{"currency_code":"USD","value":"900.00"},"note":"RentRoll payment #1: card charged through the PayPal Orders API, order …, capture …"}`
     - response: `200 {"payment_id":"EXTR-4D783016TW842374L"}`
   - The invoice then lists `{"type":"EXTERNAL","payment_id":"EXTR-…","method":"PAYPAL","note":…}`. **PayPal itself labels it EXTERNAL.**
   - The capture id lives only in our note, plus RentRoll's own `payment` row (`paypal_capture_id` and `invoice_payment_id`).
4. **A fully recorded invoice ends as `MARKED_AS_PAID`, not `PAID`.** PayPal's status reflects that the money was recorded, not
   collected on the invoice. We show it as-is.
5. **`PUT` on a SENT invoice works** (no "not mutable after send" error), for both `minimum_amount_due` and the due date.
   - We GET the current representation, change `configuration.partial_payment`, `detail.payment_term` and `detail.note`, then
     `PUT …?send_to_recipient=true&send_to_invoicer=false`.
6. **record-payment ignores `allow_partial_payment`.** $200 was recorded on an invoice whose partial payment was OFF, and it went
   PARTIALLY_PAID. The partial-payment setting constrains the payer on PayPal's page, not the merchant's records.
7. **Webhooks:**
   - record-payment fires a signed `INVOICING.INVOICE.PAID`, and so does each later payment.
   - Our PUTs fire `INVOICING.INVOICE.UPDATED`. We also receive `.CREATED` and `.SENT`.
   - The resource is `{invoice:{…}}` with no `resource_version`.
   - Webhook `8X653932CG029174U` already had PAID/UPDATED/CANCELLED registered (Sprint 0); nothing re-registered.
8. Confirmed as the brief said: partial payment lives at `configuration.partial_payment`, and PayPal stores only a minimum, so the
   schedule stays in `plan`. The SEND response returns `{"href":"https://www.sandbox.paypal.com/invoice/p/#INV2-…","rel":"payer-view"}`,
   and `detail.metadata.recipient_view_url` is set after sending.

## What changed (code)

- **`lib/invoicing.js` (new):**
  - `createAndSendRentInvoice`: starts as "pay in full".
  - `applyTermsToInvoice`: GET → modify → PUT → GET.
  - `recordPaymentOnInvoice`, `getInvoice`, `invoiceFacts`.
- **`server.js`:**
  - Migration adds `rent_period.paypal_invoice_number/_paid_cents/_due_cents/_min_due_cents/_due_date/_synced_at` (a mirror
    of the last GET) and `payment.invoice_payment_id/invoice_recorded_at/invoice_webhook_event_id`.
  - `ensureInvoices()` runs at startup and with `--seed` / `--ensure-invoices`. `--open-month YYYY-MM` opens a new month's
    periods + invoices (implemented, not run against PayPal).
  - `syncInvoiceTerms()` runs after approve, after each paid installment, and after cancelling an approved plan:
    - With an approved plan: partial ON, min = next installment, due date = its date, schedule in the note.
    - Without one: partial OFF, original due date.
    - If PayPal refuses, the plan stays approved locally, `invoice_update_failed` is logged, and the API/flash message says so.
  - `recordCaptureOnInvoice()` runs after every COMPLETED capture, from both the API path and the capture webhook. It's idempotent:
    it skips if `invoice_payment_id` is set or if the invoice already has a transaction naming the capture.
  - `handleInvoiceEvent()` handles `INVOICING.INVOICE.*`:
    - It GETs the invoice and never uses the payload's amounts. The payload's claims are kept in `payload_claimed` for audit.
    - It matches transactions to payments.
    - Unknown transactions become `source='paypal_invoice'` payments, linked to the plan only if the amount equals the next installment.
    - It logs paid on invoice vs. paid in the ledger, and flags a MISMATCH if they differ.
  - New `GET /api/rent-periods/:id/invoice` (live GET).
  - Dashboard line per unit: "PayPal invoice <number> · <status> · partial OK, min $X · due …".
  - `RENTROLL_INVOICING=0` turns all of this off.
- **`lib/court-packet.js`:** the invoice section (read live at generation time, falls back to the labelled mirror), invoice
  payment ids per payment, and new event labels.
- **Scripts:** `scripts/sprint10-testdb.mjs` (+1000 id offset), `scripts/sprint10-test.sh` (the real test below),
  `scripts/sprint10-outside-pay.sh`.

## The real test (`./scripts/sprint10-test.sh`, run 2, 11:50–11:54 UTC)

Test DB `$TMPDIR/s10real/test.db` (rent_period 1001 = Unit 2, $1,800), port 8810, a random local-only login, real NVIDIA LLM,
real PayPal sandbox. Webhooks: PayPal delivers to the live service. The script copies the matching signed deliveries from the live
raw log (read-only) and runs `--ingest-webhook-log`, which re-verifies each signature with PayPal (same method as Sprints 3–6).

```
=== 1. server up 11:50:40Z; startup created + sent one PayPal invoice per rent period ===
  [invoice] {"rent_period_id":1001,"invoice_id":"INV2-MSMB-LDZR-QLQY-ML53","invoice_number":"RR202611U1P1001-C251XZ","status":"SENT"}
  [invoice] {"rent_period_id":1002,"invoice_id":"INV2-AZVE-9NRA-57NH-LWAX","invoice_number":"RR202611U2P1002-C253YI","status":"SENT"}
  [invoice] {"rent_period_id":1003,"invoice_id":"INV2-WD73-X9ZQ-BF8Z-GKDR","invoice_number":"RR202611U3P1003-C255BT","status":"SENT"}
$ GET /api/rent-periods/1001/invoice   (live GET from PayPal, before any plan)
  invoice RR202611U1P1001-C251XZ INV2-MSMB-LDZR-QLQY-ML53 status SENT | paid 0 due 180000
  configuration.partial_payment = null
  detail.payment_term = {"term_type": "DUE_ON_DATE_SPECIFIED", "due_date": "2026-11-01"}
  payments.transactions = []
=== 2. tenant message -> AI plan ===
$ POST /api/rent-periods/1001/messages {"body":"Hi, money is tight this month. Can I pay 900 now and the rest on the 15th?"}
  ok True plan 1 proposed [('2026-11-11', 90000), ('2026-11-15', 90000)] 
=== 3. landlord approves -> the real PayPal invoice changes ===
$ POST /api/plans/1/approve
  ok True  plan status approved
  invoice sync: {"ok": true, "invoice_id": "INV2-MSMB-LDZR-QLQY-ML53", "invoice_number": "RR202611U1P1001-C251XZ", "before": {"status": "SENT", "allow_partial_payment": false, "minimum_amount_due_cents": null, "due_date": "2026-11-01", "paid_cents": 0, "due_cents": 180000}, "after": {"status": "SENT", "allow_partial_payment": true, "minimum_amount_due_cents": 90000, "due_date": "2026-11-11", "paid_cents": 0, "due_cents": 180000}}
$ GET /api/rent-periods/1001/invoice   (independent re-read from PayPal)
  invoice RR202611U1P1001-C251XZ INV2-MSMB-LDZR-QLQY-ML53 status SENT | paid 0 due 180000
  configuration.partial_payment = {"allow_partial_payment": true, "minimum_amount_due": {"currency_code": "USD", "value": "900.00"}}
  detail.payment_term = {"term_type": "DUE_ON_DATE_SPECIFIED", "due_date": "2026-11-11"}
  payments.transactions = []
=== 4. payments ===
$ POST /api/rent-periods/1001/pay-sandbox {"amount":"1800.00"}   (not the installment: must be refused before PayPal)
  ok False approved plan #1 only accepts installment 1 of 2: exactly $900.00 (due 2026-11-11). $1,800.00 refused
$ POST /api/rent-periods/1001/pay-sandbox {"amount":"900.00"}   (installment 1)
  ok True  order 563039595J640873V capture 5PD879062Y083192G COMPLETED | period {'before': 'UNPAID', 'status': 'PARTIALLY_PAID', 'paid_cents': 90000, 'balance_cents': 90000}
  record-payment on invoice: {"ok": true, "invoice_payment_id": "EXTR-4D783016TW842374L", "invoice": {"status": "PARTIALLY_PAID", "allow_partial_payment": true, "minimum_amount_due_cents": 90000, "due_date": "2026-11-11", "paid_cents": 90000, "due_cents": 90000}}
  invoice terms moved on: {"ok": true, "invoice_id": "INV2-MSMB-LDZR-QLQY-ML53", "invoice_number": "RR202611U1P1001-C251XZ", "before": {"status": "PARTIALLY_PAID", "allow_partial_payment": true, "minimum_amount_due_cents": 90000, "due_date": "2026-11-11", "paid_cents": 90000, "due_cents": 90000}, "after": {"status": "PARTIALLY_PAID", "allow_partial_payment": true, "minimum_amount_due_cents": 90000, "due_date": "2026-11-15", "paid_cents": 90000, "due_cents": 90000}}
$ GET /api/rent-periods/1001/invoice
  invoice RR202611U1P1001-C251XZ INV2-MSMB-LDZR-QLQY-ML53 status PARTIALLY_PAID | paid 90000 due 90000
  configuration.partial_payment = {"allow_partial_payment": true, "minimum_amount_due": {"currency_code": "USD", "value": "900.00"}}
  detail.payment_term = {"term_type": "DUE_ON_DATE_SPECIFIED", "due_date": "2026-11-15"}
  payments.transactions = [["EXTR-4D783016TW842374L", "EXTERNAL", "PAYPAL", "900.00"]]
=== 5. webhooks: wait up to 150 s for PayPal's signed deliveries (capture 5PD879062Y083192G, invoice INV2-MSMB-LDZR-QLQY-ML53) in the live log ===
  delivered 2026-11-11T11:51:09.627Z PAYMENT.CAPTURE.COMPLETED WH-3B4737137L8889420-1L3431373D2002944 | payload claims: COMPLETED null
  delivered 2026-11-11T11:50:57.820Z INVOICING.INVOICE.SENT WH-4FG75643HS5280121-98W82278N7137163R | payload claims: SENT null
  delivered 2026-11-11T11:50:57.976Z INVOICING.INVOICE.CREATED WH-78089993M8478773V-0AL04305GF710172M | payload claims: SENT null
  delivered 2026-11-11T11:51:07.336Z INVOICING.INVOICE.UPDATED WH-2H07826948336031C-0VM31364E0569325J | payload claims: PARTIALLY_PAID {"currency_code": "USD", "value": "900.00"}
  delivered 2026-11-11T11:51:15.874Z INVOICING.INVOICE.UPDATED WH-5NJ21652VC2817347-8R504420SX1307616 | payload claims: PARTIALLY_PAID {"currency_code": "USD", "value": "900.00"}
  delivered 2026-11-11T11:51:16.798Z INVOICING.INVOICE.PAID WH-3ME86052FY890452M-7SB317587J8358104 | payload claims: PARTIALLY_PAID {"currency_code": "USD", "value": "900.00"}
$ node server.js --ingest-webhook-log   (each delivery re-verified with PayPal; invoice events GET the invoice)
   PAYMENT.CAPTURE.COMPLETED WH-3B4737137L8889420-1L3431373D2002944 -> payment_confirmed sig SUCCESS | invoice None paid None local None matches None added None
   INVOICING.INVOICE.SENT WH-4FG75643HS5280121-98W82278N7137163R -> invoice_reconciled sig SUCCESS | invoice PARTIALLY_PAID paid 90000 local 90000 matches True added 0
   INVOICING.INVOICE.CREATED WH-78089993M8478773V-0AL04305GF710172M -> invoice_reconciled sig SUCCESS | invoice PARTIALLY_PAID paid 90000 local 90000 matches True added 0
   INVOICING.INVOICE.UPDATED WH-2H07826948336031C-0VM31364E0569325J -> invoice_reconciled sig SUCCESS | invoice PARTIALLY_PAID paid 90000 local 90000 matches True added 0
   INVOICING.INVOICE.UPDATED WH-5NJ21652VC2817347-8R504420SX1307616 -> invoice_reconciled sig SUCCESS | invoice PARTIALLY_PAID paid 90000 local 90000 matches True added 0
   INVOICING.INVOICE.PAID WH-3ME86052FY890452M-7SB317587J8358104 -> invoice_reconciled sig SUCCESS | invoice PARTIALLY_PAID paid 90000 local 90000 matches True added 0
=== 6. installment 2 ===
$ POST /api/rent-periods/1001/pay-sandbox {"amount":"900.00"}
  ok True  capture 1XN91344666128502 COMPLETED plan completed | period {'before': 'PARTIALLY_PAID', 'status': 'PAID', 'paid_cents': 180000, 'balance_cents': 0}
  record-payment on invoice: {"ok": true, "invoice_payment_id": "EXTR-62K32482UM3486536", "invoice": {"status": "MARKED_AS_PAID", "allow_partial_payment": true, "minimum_amount_due_cents": 90000, "due_date": "2026-11-15", "paid_cents": 180000, "due_cents": 0}}
  invoice terms: null
$ GET /api/rent-periods/1001/invoice
  invoice RR202611U1P1001-C251XZ INV2-MSMB-LDZR-QLQY-ML53 status MARKED_AS_PAID | paid 180000 due 0
  configuration.partial_payment = {"allow_partial_payment": true, "minimum_amount_due": {"currency_code": "USD", "value": "900.00"}}
  detail.payment_term = {"term_type": "DUE_ON_DATE_SPECIFIED", "due_date": "2026-11-15"}
  payments.transactions = [["EXTR-4D783016TW842374L", "EXTERNAL", "PAYPAL", "900.00"], ["EXTR-62K32482UM3486536", "EXTERNAL", "PAYPAL", "900.00"]]
  waiting up to 150 s for capture 1XN91344666128502 + the invoice's final INVOICING.INVOICE.PAID (status PAID) in the live log...
$ node server.js --ingest-webhook-log   (already-processed events come back as duplicate)
   PAYMENT.CAPTURE.COMPLETED WH-6EH46514DT7535005-54U81836GM8586546 -> payment_confirmed sig SUCCESS | invoice None paid None local None matches None
   None WH-4FG75643HS5280121-98W82278N7137163R -> duplicate sig None | invoice None paid None local None matches None
   None WH-78089993M8478773V-0AL04305GF710172M -> duplicate sig None | invoice None paid None local None matches None
   None WH-2H07826948336031C-0VM31364E0569325J -> duplicate sig None | invoice None paid None local None matches None
   None WH-5NJ21652VC2817347-8R504420SX1307616 -> duplicate sig None | invoice None paid None local None matches None
   None WH-3ME86052FY890452M-7SB317587J8358104 -> duplicate sig None | invoice None paid None local None matches None
   INVOICING.INVOICE.PAID WH-6NU0599411521554L-08M74143JK869640N -> invoice_reconciled sig SUCCESS | invoice MARKED_AS_PAID paid 180000 local 180000 matches True
=== 7. court packet ===
  packet.invoice: {"id": "INV2-MSMB-LDZR-QLQY-ML53", "number": "RR202611U1P1001-C251XZ", "status": "MARKED_AS_PAID", "paid_cents": 180000, "due_cents": 0, "allow_partial_payment": true, "minimum_amount_due_cents": 90000, "due_date": "2026-11-15", "source": "read live from PayPal", "matches_ledger": true}
  transactions: [('EXTR-4D783016TW842374L', 90000, 'EXTERNAL'), ('EXTR-62K32482UM3486536', 90000, 'EXTERNAL')]
  payments: [(1, 90000, '5PD879062Y083192G', 'EXTR-4D783016TW842374L', True, 'WH-4FG75643HS5280121-98W82278N7137163R'), (2, 90000, '1XN91344666128502', 'EXTR-62K32482UM3486536', True, 'WH-6NU0599411521554L-08M74143JK869640N')]
  line: Paid in full: $1,800.00 of $1,800.00 received through PayPal.
  line: Lease late-fee rule: $75.00 flat after a 5-day grace period. Not triggered; RentRoll does not add late fees to the balance above.
  line: PayPal invoice RR202611U1P1001-C251XZ (INV2-MSMB-LDZR-QLQY-ML53): status MARKED_AS_PAID, $1,800.00 paid, $0.00 due, partial payment allowed (minimum $900.00), due date 2026-11-15 (read live from PayPal).
  PDF: HTTP 200, 11505 bytes, application/pdf
  %PDF header: b'%PDF-'
  pdf| 27:PayPal invoice
  pdf| 28-Invoice number
  pdf| 29-PayPal invoice id
  pdf| 30-Status at PayPal
  pdf| 31-Paid / due
  pdf| 32-Payment terms
  pdf| 33-Payer link
  pdf| 34-Invoice transactions
=== 8. ledger (test DB event_log) ===
  1 11:50:33.609 seed                     system   November 2026 rent opened for Unit 2 (Jordan Ellis): $1,800.00 due 2026-11-01
  4 11:50:36.618 invoice_sent             landlord PayPal invoice RR202611U1P1001-C251XZ (INV2-MSMB-LDZR-QLQY-ML53) created and sent to Jordan Ellis for $1,800.00, due 2026-11-01. PayPal status SENT, full amount only (partial payment off)
  7 11:50:40.630 message_in               tenant   Jordan Ellis (sms): "Hi, money is tight this month. Can I pay 900 now and the rest on the 15th?"
  8 11:50:43.998 plan_proposed            ai       AI proposed a plan for the $1,800.00 balance: $900.00 on 2026-11-11, $900.00 on 2026-11-15. Awaiting landlord approval
  9 11:50:44.097 plan_approved            landlord Landlord approved plan #1 for Jordan Ellis: #1 $900.00 by 2026-11-11, #2 $900.00 by 2026-11-15. PayPal payments now only accepted for the next installment's exact amount
  10 11:50:46.033 invoice_updated          landlord PayPal invoice RR202611U1P1001-C251XZ updated (plan #1 approved): full amount only (partial payment off) -> minimum $900.00, due 2026-11-01 -> 2026-11-11. Read back from PayPal: status SENT
  11 11:50:49.864 payment                  tenant   Jordan Ellis paid $900.00 by card through PayPal (plan #1, installment 1 of 2) (capture 5PD879062Y083192G, COMPLETED). Balance now $900.00
  12 11:50:51.022 invoice_payment_recorded system   Recorded $900.00 (capture 5PD879062Y083192G) on PayPal invoice RR202611U1P1001-C251XZ as payment EXTR-4D783016TW842374L. Read back from PayPal: PARTIALLY_PAID, $900.00 paid, $900.00 due
  13 11:50:52.743 invoice_updated          landlord PayPal invoice RR202611U1P1001-C251XZ updated (installment 1 paid, next installment): minimum $900.00 -> minimum $900.00, due 2026-11-11 -> 2026-11-15. Read back from PayPal: status PARTIALLY_PAID
  14 11:51:19.032 webhook_received         paypal   PayPal confirmed $900.00 from Jordan Ellis for plan #1 installment 1 (capture 5PD879062Y083192G). Unit 2 November 2026: PARTIALLY PAID, balance $900.00
  15 11:51:19.675 webhook_received         paypal   PayPal INVOICING.INVOICE.SENT for invoice RR202611U1P1001-C251XZ. Re-read from PayPal: PARTIALLY_PAID, $900.00 paid, $900.00 due, minimum $900.00, due 2026-11-15. Matches RentRoll's ledger ($900.00 paid)
  16 11:51:20.397 webhook_received         paypal   PayPal INVOICING.INVOICE.CREATED for invoice RR202611U1P1001-C251XZ. Re-read from PayPal: PARTIALLY_PAID, $900.00 paid, $900.00 due, minimum $900.00, due 2026-11-15. Matches RentRoll's ledger ($900.00 paid)
  17 11:51:21.042 webhook_received         paypal   PayPal INVOICING.INVOICE.UPDATED for invoice RR202611U1P1001-C251XZ. Re-read from PayPal: PARTIALLY_PAID, $900.00 paid, $900.00 due, minimum $900.00, due 2026-11-15. Matches RentRoll's ledger ($900.00 paid)
  18 11:51:21.589 webhook_received         paypal   PayPal INVOICING.INVOICE.UPDATED for invoice RR202611U1P1001-C251XZ. Re-read from PayPal: PARTIALLY_PAID, $900.00 paid, $900.00 due, minimum $900.00, due 2026-11-15. Matches RentRoll's ledger ($900.00 paid)
  19 11:51:22.132 webhook_received         paypal   PayPal INVOICING.INVOICE.PAID for invoice RR202611U1P1001-C251XZ. Re-read from PayPal: PARTIALLY_PAID, $900.00 paid, $900.00 due, minimum $900.00, due 2026-11-15. Matches RentRoll's ledger ($900.00 paid)
  20 11:51:25.499 plan_completed           system   Payment plan #1 completed: every installment paid through PayPal
  21 11:51:25.500 payment                  tenant   Jordan Ellis paid $900.00 by card through PayPal (plan #1, installment 2 of 2) (capture 1XN91344666128502, COMPLETED). Balance now $0.00
  22 11:51:26.666 invoice_payment_recorded system   Recorded $900.00 (capture 1XN91344666128502) on PayPal invoice RR202611U1P1001-C251XZ as payment EXTR-62K32482UM3486536. Read back from PayPal: MARKED_AS_PAID, $1,800.00 paid, $0.00 due
  23 11:53:58.658 webhook_received         paypal   PayPal confirmed $900.00 from Jordan Ellis for plan #1 installment 2 (capture 1XN91344666128502). Unit 2 November 2026: PAID, balance $0.00
  24 11:53:59.323 webhook_received         paypal   PayPal INVOICING.INVOICE.PAID for invoice RR202611U1P1001-C251XZ. Re-read from PayPal: MARKED_AS_PAID, $1,800.00 paid, $0.00 due, minimum $900.00, due 2026-11-15. Matches RentRoll's ledger ($1,800.00 paid)
  dashboard: PayPal invoice RR202611U1P1001-C251XZ · MARKED_AS_PAID
  dashboard: PayPal invoice RR202611U2P1002-C253YI · SENT
  dashboard: PayPal invoice RR202611U3P1003-C255BT · SENT
files in /tmp/claude-1000/s10real
```

**Outside payment check (`scripts/sprint10-outside-pay.sh`, same test DB, ~11:56 UTC).** This records $200 directly on
rp1002's invoice with record-payment, the way a landlord would log cash in PayPal's own UI (RentRoll not involved). It then
ingests PayPal's signed `INVOICING.INVOICE.PAID`:

```
direct record-payment (not via RentRoll): {"invoice_payment_id":"EXTR-8EW07671HY966973V","debug_id":"ca58d1a1f2e56"}
delivery lines: 1 (after ~26 s)
{"result":"invoice_reconciled","invoice_id":"INV2-AZVE-9NRA-57NH-LWAX","invoice_status":"PARTIALLY_PAID","invoice_paid_cents":20000,"local_paid_cents":20000,"matches_ledger":true,"added":1,"matched":0,"event_id":"WH-6PG38081MB303432P-63M59285TA877014D","event_type":"INVOICING.INVOICE.PAID","verification":"SUCCESS","via":"backfill"}
payments rp1002: [(3, 'paypal_invoice', 'COMPLETED', 20000, 'RRINV:INV2-AZVE-9NRA-57NH-LWAX:EXTR-8EW07671HY966973V', 'EXTR-8EW07671HY966973V', 'WH-6PG38081MB303432P-63M59285TA877014D')]
rent_period 1002: ('PARTIALLY_PAID', 20000, 'PARTIALLY_PAID', 20000)
```

**Sandbox spike (before the data model, 11:38–11:40 UTC):** `scripts/sprint0-invoice.mjs` ran unchanged and passed:
- A: created with partial payment, then sent.
- B: sent, then PUT partial payment (200).

`scratch/spike2.mjs` + `spike3.mjs` (gitignored):
- PUT changed B's min to $900 and its due date to 2026-11-15; GET confirmed both.
- record-payment with the capture id returned 404; without it, 200 `EXTR-0S299271PL008530H`, and A went PARTIALLY_PAID.
- The signed `INVOICING.INVOICE.PAID` webhook arrived 11:39:07.

Spike invoices `INV2-D4NP-8ALG-7HVF-BUBD` and `INV2-6D6P-S89Q-8DK3-PDDZ` and the test invoices are left in the sandbox.
Nikolay's throwaway draft `INV2-732X-EQF6-QU3Z-KZT7` was deleted (GET showed DRAFT, DELETE 200), as the brief allowed.

## Honest limits

1. **The tenant didn't pay on PayPal's invoice page.**
   - Money moves via Orders; the invoice carries an accurate EXTERNAL/PAYPAL record of it, plus the capture id in the note.
   - The final status is MARKED_AS_PAID, not PAID. README/SUBMISSION now say exactly this.
2. **Hosted-page reconcile is only tested with a payment PayPal recorded outside RentRoll** (record-payment by API). It isn't tested
   with a real payer on the hosted page, because no browser is available in the sandbox. A hosted-page payment would likely be type
   `PAYPAL`, not `EXTERNAL`. The code doesn't depend on the type.
3. **The webhooks were replayed, not received live by this build.** Same limitation as Sprints 1–6. The live service on `app/`'s build
   logs these invoice events as plain `logged` until this branch is deployed.
4. **In this LLM run the two installments were equal ($900 + $900).** So after installment 1, `minimum_amount_due` stayed at $900 and
   only the due date moved. The approval step is the one that changed `minimum_amount_due` (off → $900).
5. **Not run against PayPal:**
   - `--open-month` (new month + invoices).
   - Cancelling an approved plan (turns partial payment off).
   - The PayPal-refuses-the-PUT failure branch.
6. **Old offline suites now get 401.** `scripts/sprint3-offline.sh` and `sprint4-offline.sh` predate Sprint 8's Basic Auth and send no
   login. That's also true on `main` and is not caused by this sprint. I didn't fix them.
7. **Deploying needs a restart.** On first start of this build against the real DB, `ensureInvoices()` creates and sends invoices for
   the 3 existing rent periods, which is intended. Restart `rentroll.service` after merging so the cached OAuth token picks up the scope.

SPRINT10 STATUS: done — every rent period now has a real PayPal invoice. Approving the AI plan PUT `minimum_amount_due` $900 and the due date onto the sent invoice, and an independent GET confirmed it. The card capture was then recorded on the invoice, which went PARTIALLY_PAID → MARKED_AS_PAID, and the signed INVOICING webhooks were reconciled from a GET. The tenant's card still runs through Orders, because a no-login payment on the hosted invoice page couldn't be tested here.
