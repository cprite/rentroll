# SPRINT 0: de-risk report (2026-11-10, ~21:15–21:35 UTC)

All calls went to the sandbox base from `PAYPAL_API_BASE`. Every request/response (no auth headers) is in
`scratch/sprint0-calls.jsonl` (gitignored). The scripts are in `scripts/` and use `lib/paypal.js`.

## Summary

- **1. Skeleton: PASS.** Express 4 on 127.0.0.1:8790 via `./start.sh`. `POST /webhooks/paypal` logs headers + body to
  `.sprint0-webhook-log.jsonl` and returns 200. Tested locally with curl.
- **2. Invoice create/send/partial: BLOCKED.** Every Invoicing v2 call returns `403 NOT_AUTHORIZED`. The app's token has no invoicing scope.
- **3. Webhook registration: PASS.** Webhook `8X653932CG029174U` registered to `https://nikopi5.tail4aaac7.ts.net/webhooks/paypal`.
- **4. Tenant payment without a buyer login: PASS for payment.** A real $800 sandbox **card capture** through Orders v2 with a
  PayPal test card, no buyer login. **Delivery NOT VERIFIED:** PayPal created the event, but it never showed up in the local log.

## Task 2: Invoicing, BLOCKED (needs a human, about 2 minutes)

- `POST /v1/oauth2/token` (client_credentials) works. The token has 26 scopes and **none of them are invoicing**
  (no `https://uri.paypal.com/services/invoicing`). It does have the checkout, payments, refund and webhooks scopes.
- Each of these returned `403 {"name":"NOT_AUTHORIZED","message":"Authorization failed due to insufficient permissions."}`:
  - `POST /v2/invoicing/invoices` (debug_id f339641094b50)
  - `GET /v2/invoicing/invoices?page_size=1` (f821231e4d1a7)
  - `POST /v2/invoicing/generate-next-invoice-number` (f2547344a702e)
  - `POST /v2/invoicing/search-invoices` (f3076800ac596)
- **Fix (hack-lead/Nikolay):**
  1. Open developer.paypal.com → Apps & Credentials → Sandbox → this app.
  2. Under the app's features/permissions, enable **Invoicing** and save.
  3. Run `NODE_USE_ENV_PROXY=1 node scripts/sprint0-token.mjs` and check that an invoicing scope now appears.
     PayPal may take a few minutes to issue a token with the new scope.
  4. Run `NODE_USE_ENV_PROXY=1 node scripts/sprint0-invoice.mjs`. It is ready but untested past the 403.
     - It creates invoice A with partial payment set at creation, then sends it.
     - It then creates and sends invoice B and **PUTs** partial payment onto the already-sent B.
       That PUT is the real RentRoll "write the plan back" step.
- The `record-payment` fallback (`POST /v2/invoicing/invoices/{id}/payments`) needs the same scope, so it is also blocked right now.

### Corrections from the live docs (developer.paypal.com/api/invoicing/v2/schema.json, fetched 2026-11-10)
- The partial-payment field is **not** `detail.partial_payment`. It is in `configuration`:
  `configuration.partial_payment = { allow_partial_payment: bool, minimum_amount_due: {currency_code, value} }`
  (schema `base_configuration.partial_payment`). It is not available for users in India, Brazil or Israel.
- PayPal enforces only a **minimum amount**, not a schedule. The plan "$800 now, $1,000 on the 15th" can't be stored as
  dates in PayPal. RentRoll has to store the schedule itself and put the text in `detail.note`.
- Invoice statuses include `PARTIALLY_PAID`, `PAID`, `MARKED_AS_PAID`, `PAYMENT_PENDING` and `UNPAID`. Paid totals are in
  `payments.paid_amount` plus a `payments.transactions[]` array.
- **There is no separate partial-payment webhook.** `INVOICING.INVOICE.PAID` = "An invoice is paid, partially paid, or payment
  is made and is pending." (developer.paypal.com/api/rest/webhooks/event-names/, 2026-11-10).
  After each event, GET the invoice and read the status.
- pain-points.md says "`allow_partial_payment`". The field name is right, but it's nested in `configuration.partial_payment`.
- The API also has auto-reminder configuration and `/remind`, which could replace part of our own reminder scheduler (not tested).

## Task 3: Webhook registration, PASS

- `POST /v1/notifications/webhooks` → 201, id `8X653932CG029174U`.
- PayPal accepted all these event names: `INVOICING.INVOICE.PAID`, `INVOICING.INVOICE.UPDATED`,
  `INVOICING.INVOICE.CANCELLED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.DENIED`, `CHECKOUT.ORDER.APPROVED`.
- Before this call the app had no webhooks.
- Registering the invoicing events worked even though the Invoicing API returns 403.

## Task 4: Tenant payment, PASS for payment, delivery NOT VERIFIED

**Path (a) works through the API alone, with no browser:**
- `POST /v2/checkout/orders` with `intent: CAPTURE` and `payment_source.card` **creates and captures in one call**.
- Card: PayPal-documented sandbox Visa `4012000033330026` (developer.paypal.com/tools/sandbox/card-testing), expiry 2030-12, CVV 123.
- Order `15A89508HH5594456`, status `COMPLETED`.
- Capture `8T4329861X925214G`: $800.00, PayPal fee $25.82, net $774.18 (sandbox fee ≈ 2.99% + $0.49).
- `custom_id` (`RR-unit2-2026-11-partial1`) and `invoice_id` are carried through to the capture resource and the webhook event.
  Use them to map payments back to unit, month and plan installment.
- I didn't need Playwright. No PayPal login was involved.

**Caveat:** this is an Orders payment, not a payment against an Invoicing invoice.
- Once the Invoicing scope is on, we still need to check how a tenant pays an invoice without a login
  (the invoice's payer link takes a guest card) and whether that fires `INVOICING.INVOICE.PAID`.
- If a guest payment on the invoice page won't work, the fallback is: capture through Orders, then `record-payment`
  (`method: "PAYPAL"`, `payment_id` = capture id). That keeps the invoice ledger accurate.

**Webhook delivery:**
- PayPal created the real event `WH-1RP81426DG890914K-43403394DR168380W` (`PAYMENT.CAPTURE.COMPLETED`,
  "Payment completed for $ 800.0 USD", resource_version 2.0) about 10s after the capture.
  `GET /v1/notifications/webhooks-events` lists it.
- I also sent two simulator events (`POST /v1/notifications/simulate-event`, both 202). PayPal accepted them.
  - `PAYMENT.CAPTURE.COMPLETED` works with `resource_version: "2.0"`.
  - `INVOICING.INVOICE.PAID` works only with `"1.0"`. `"2.0"` returns 400 "Not a valid Resource Type".
- **`.sprint0-webhook-log.jsonl` was still missing after about 10 minutes.** Nothing came in on the public route.
- **Cause: unknown.** I couldn't check it:
  - Each of my Bash commands runs in its own short-lived sandbox, so a server I start ends with the command and is not the one Funnel reaches.
  - `systemctl` from inside fails: "Failed to connect to system scope bus ... Operation not permitted".
  - I couldn't read any `rentroll.service` unit file.
- **Likely suspects:**
  1. `rentroll.service` is not running. It may have failed or hit its restart limit before `start.sh` existed.
  2. Funnel is not routing `/` to 127.0.0.1:8790.
- **For hack-lead (about 3 minutes):**
  1. `systemctl [--user] restart rentroll.service && curl -s http://127.0.0.1:8790/healthz`
  2. `cd app && NODE_USE_ENV_PROXY=1 node scripts/sprint0-resend.mjs WH-1RP81426DG890914K-43403394DR168380W 8X653932CG029174U`
  3. `tail -1 app/.sprint0-webhook-log.jsonl`. It should show `event_type: PAYMENT.CAPTURE.COMPLETED`.
- The route is scaffolding only. It does not verify signatures yet.
  - Sprint 1 should call `POST /v1/notifications/verify-webhook-signature` (the raw body is kept for this).
  - It must handle duplicate deliveries idempotently by `event.id`.

## Surprises / gotchas
- **Node 24 `fetch` ignores HTTP(S)_PROXY** in this sandbox and fails with `getaddrinfo EAI_AGAIN`. Set `NODE_USE_ENV_PROXY=1`.
  `start.sh` now exports it, and it does nothing when no proxy is set.
- The sandbox payee is a generated business account (`sb-…@business.example.com`, merchant id `FM5VD8U77WV24`).
- The OAuth token lasts about 9h. It's cached in memory only and never written to disk. Restart the process after scope changes.
- `PayPal-Request-Id` on order creation gives idempotency. Use one per installment attempt.

## Recommended Sprint 1 data model (SQLite or a JSON file is enough)
- **unit**: id, label ("Unit 2"), address, monthly_rent_cents, due_day, late_fee_rule (grace_days, flat/percent, state), tenant_id.
- **tenant**: id, name, email (PayPal invoice recipient), phone, unit_id.
- **rent_period** (one per unit per month):
  - id, unit_id, period ("2026-11"), amount_due_cents
  - paypal_invoice_id (nullable until Invoicing is unblocked), paypal_invoice_status (mirror: SENT/PARTIALLY_PAID/PAID/…)
  - payer_view_url, amount_paid_cents (derived from payments)
- **plan** (AI-proposed, landlord-approved):
  - id, rent_period_id, status (proposed/approved/rejected/broken/completed), source_message_id, approved_at
  - installments[] {due_date, amount_cents, payment_id?}
  - PayPal stores only `minimum_amount_due` (= the first installment), so the schedule itself lives here.
- **payment**:
  - id, rent_period_id, installment_index, source (paypal_capture | paypal_invoice | record_payment_external)
  - paypal_capture_id, paypal_order_id, amount_cents, fee_cents, net_cents, paid_at
  - `simulated` flag + honest label for anything recorded via record-payment.
- **event_log** (court ledger, append-only):
  - id, at (UTC), actor, payload_json
  - kind (message_in, plan_proposed, plan_approved, invoice_sent, invoice_updated, reminder_sent, webhook_received, payment)
  - paypal_event_id (unique → idempotency).
- **message**: id, tenant_id, direction, channel, body, received_at, ai_extraction_json.

SPRINT0 STATUS: blocked — the PayPal sandbox app has no Invoicing permission (every Invoicing call returns 403, so a human has to enable Invoicing on the app in the developer dashboard); webhook registration and a real no-login sandbox card capture work, but delivery to the local webhook log is still unverified.
