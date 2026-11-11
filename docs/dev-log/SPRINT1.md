# SPRINT 1: data model, dashboard, real payments (2026-11-10, ~22:05–22:20 UTC)

**Branch:** `sprint1-data-model`, commit `dac7870`. `main` was not touched (still `8d29d15`).

### What was built (`server.js`, plus small edits to `lib/paypal.js`, `package.json`, `.gitignore`)
- **Data model:** SQLite through Node 24's built-in `node:sqlite`, so there's nothing to install or compile.
  - The file is `data/rentroll.db` (gitignored) and is created automatically on start.
  - Tables follow SPRINT0's recommendation: `tenant`, `unit`, `rent_period` (UNIQUE per unit and month), `plan` (schema only), `payment`, `event_log`, `message`.
  - `event_log` is append-only: triggers block UPDATE and DELETE, and `paypal_event_id` is UNIQUE for idempotency.
  - All money is stored in integer cents.
  - Paid amount and status are always recomputed from COMPLETED payments.
- **Seed:** `npm run seed`, or `npm run reset` to wipe and reseed. It creates two fake tenants for November 2026:
  - Unit 2: Jordan Ellis, $1,800.
  - Unit 3: Priya Nair, $1,200.
  - Late-fee rule for both: 5 grace days, then a $75 flat fee.
  - If the DB is empty when the server starts, it seeds itself.
- **Dashboard `/`:**
  - Three summary cards: Collected / Outstanding / Paid in full.
  - One row per unit: tenant, amount due, amount paid (with a progress bar), a status pill and the next action. Next action examples: "9 days late. $75.00 late fee applies. Send a formal notice", "Nothing to do. Paid in full, confirmed by PayPal".
  - Each row lists its payments with a "✓ PayPal confirmed" badge, and has a "Tenant pays" form.
  - A ledger feed shows the latest event_log entries.
  - It works without JavaScript.
- **Payment endpoints:** `POST /api/rent-periods/:id/pay-sandbox` takes JSON `{"amount":"800.00"}`. The form version is `POST /rent-periods/:id/pay-sandbox`, which redirects back with a flash message.
  - The payment row is written as PENDING first.
  - Then one Orders call creates and captures the payment with the test card `4012000033330026`, using a per-attempt `PayPal-Request-Id`.
  - `custom_id` looks like `RR:rp<id>:<period>:u<unit>:i<installment>:<nonce>`.
  - The capture's status, fee and net amount are recorded.
  - Amounts over the open balance are rejected (422), as are already-paid periods (409).
  - It refuses to run if `PAYPAL_API_BASE` isn't a sandbox URL.
- **`POST /webhooks/paypal`:**
  - Every delivery is still appended to `.sprint0-webhook-log.jsonl`, now including the raw bytes.
  - Events are deduplicated by `event.id`.
  - The signature is checked with `POST /v1/notifications/verify-webhook-signature`.
  - `PAYMENT.CAPTURE.COMPLETED`: finds the payment by capture id or `custom_id`, marks it COMPLETED and webhook-confirmed, recomputes the rent_period and appends to event_log. If a capture carries our `custom_id` but has no payment row, the row is created.
  - `PAYMENT.CAPTURE.DENIED`: marks the payment DENIED.
  - Other event types are only recorded in event_log.
  - If processing fails it returns 500, so PayPal retries; the dedup makes retries safe.
- **Backfill:** at startup, events that the old build only logged are fed through the new handler. This is idempotent. It can also be run on its own with `npm run ingest-webhooks`.
- **Read-only JSON:** `GET /api/rent-periods` and `GET /api/event-log`.

### How it was tested (all commands actually run)
1. **Offline**, on a temporary DB and a temporary webhook log, port 8791:
   - Running the seed twice was idempotent.
   - A synthetic `PAYMENT.CAPTURE.COMPLETED` moved Unit 2 to PARTIALLY_PAID ($800 paid, $1,000 left).
   - Re-posting the same event returned `duplicate`.
   - Non-JSON gave 400, $5,000 gave 422, unknown id `9` gave 404, `"abc"` gave 400.
   - `DELETE FROM event_log` failed with "event_log is append-only".
2. **Real end to end**, on the real DB:
   - Commands: `node server.js --seed --reset`, then `curl -XPOST localhost:8791/api/rent-periods/1/pay-sandbox -d '{"amount":"800.00"}'`.
   - Result: order `83A71518S3970053P`, capture `1XH093476K818891C` COMPLETED, fee $25.82, net $774.18. Unit 2 became PARTIALLY_PAID.
   - **PayPal delivered** `WH-5WT967254H7414826-7VF63173NG5072017` (`PAYMENT.CAPTURE.COMPLETED`, matching `custom_id`) to the Funnel route at 22:13:07Z, 44 s after the capture.
   - The running `rentroll.service` is still the Sprint 0 build, so it only logged the event.
   - I restarted my build, as a service restart would. It backfilled the event: signature verification **SUCCESS**, payment marked webhook-confirmed, ledger row "PayPal confirmed $800.00 from Jordan Ellis … PARTIALLY PAID, balance $1,000.00".
3. **Dashboard form:** `curl -XPOST /rent-periods/1/pay-sandbox --data-urlencode amount=1000.00` returned 303 with the flash message. Capture `45H728579V2749828`. Unit 2 became PAID. A further $1 attempt was refused with "no open balance".
   - PayPal delivered `WH-1MU50611L38385037-0J326404PG1497811` within about 10 s.
   - I replayed that delivery, with PayPal's original `paypal-*` headers, through the new **live HTTP route**. The first POST returned `payment_confirmed`, signature `SUCCESS`; the second returned `duplicate`.
   - That replay run wrote its raw log to `$TMPDIR`, not the real log.
   - The dashboard HTML then showed Unit 2 PAID, "Nothing to do. Paid in full, confirmed by PayPal", both payments ✓. Unit 3 showed UNPAID, "9 days late".
4. `./start.sh` on the default port 8790 starts cleanly: `/healthz` returns `{"ok":true,"service":"rentroll","db":"rentroll.db"}`.

### Stubbed / TODO
- **Signature verification runs and is recorded, but bad signatures are not rejected yet** (`WEBHOOK_VERIFY=record` by default). Both real deliveries verified SUCCESS. Set `WEBHOOK_VERIFY=enforce` to reject failures with 400. It's a TODO in the code to make that the default.
- The `plan` and `message` tables exist but nothing writes to them yet (that's Sprint 2). No AI calls were made this sprint.
- **Invoicing is not wired in.** Every Invoicing call still returns 403. `scripts/sprint0-invoice.mjs` is unchanged, and the header comment in `server.js` says where it plugs in (the `rent_period.paypal_invoice_*` columns and an `INVOICING.INVOICE.PAID` case). I made no Invoicing calls.
- **The "Tenant pays" button is public through Funnel.** It only charges the sandbox test card and refuses non-sandbox URLs, but anyone with the URL can trigger sandbox captures.
- No screenshot: headless Chromium fails in this sandbox with a zygote `write: Broken pipe` error.

### For hack-lead
1. Restart `rentroll.service` so the new build serves `/` and `/webhooks/paypal`. The ledger already has the two deliveries backfilled.
2. Current demo state: Unit 2 PAID ($800 + $1,000), Unit 3 UNPAID. `npm run reset` returns both to UNPAID.

SPRINT1 STATUS: done. Real sandbox payments flow from the new endpoint through PayPal's webhook (signature verified, deduplicated) to the SQLite ledger and dashboard.

**Note from hack-lead:** the builder worker's own extensive self-testing above is useful evidence but does not
replace the required fresh, independent tester before merging to `main` (Nikolay's explicit rule) — that runs
separately; see PLAN.md's Testers log.
