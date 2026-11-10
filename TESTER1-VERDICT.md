# TESTER1 verdict: Sprint 1 (`sprint1-data-model`, `8d29d15..882d098`)

This is an independent test run on 2026-11-10, from about 22:55 to 23:00 UTC, against the real PayPal sandbox. I edited no product code.

## How the test was run (read first)

**The live service on 127.0.0.1:8790 cannot be reached from the tester sandbox.**
- The tester runs in its own network namespace. `curl -s http://127.0.0.1:8790/healthz` gave `curl: (7) Failed to connect to 127.0.0.1 port 8790`.
- `ss -ltn` lists only the sandbox proxy ports, 1080 and 3128.
- So for the HTTP checks I started this exact branch myself: `PORT=8792 NODE_USE_ENV_PROXY=1 node server.js`, using the real DB `data/rentroll.db`. Each test phase ran as one shell script, because the instance dies between tool calls.

**PayPal webhooks still reach the live `rentroll.service`, which shares the same DB file.**
- PayPal delivers through the Funnel to the live service.
- So the round-trip in section 3 really is the live service's webhook path. It shows up as `via: live` in event_log, and my instance logged no `[webhook]` line.
- The live service last re-read the logged webhook deliveries (the startup backfill) at 22:54:18Z (event_log rows 8–9), so it is running the Sprint 1 build.

**I did not reset the real DB, for two reasons:**
- `npm run reset` deletes and recreates `rentroll.db`. The running service would keep writing to the deleted file.
- Reset is also undone on the next start (finding F2 below).
- Instead I used rent period 2 (Unit 3), which was still UNPAID. Unit 2 (rent period 1) was already PAID from the builder's tests.

**Another worker changed the working tree during my test.**
- At 22:58:44Z the tree had been switched to branch `sprint2-ai-plan-parser` and `server.js` was modified. Started from that tree, it crashes: `ReferenceError: PLAN_TABLE is not defined` (server.js:81).
- All the live tests below (sections 1–4) ran between 22:56 and 22:57:40Z, before that change.
- After 22:58:44Z I ran checks only from a clean `git archive 882d098` copy in `$TMPDIR`. Its `server.js` sha256 `457ccd19…` matches the commit.
- **If `rentroll.service` restarts from this working tree now, it will crash.**

## Results

### 1. Smoke: PASS
```
$ curl -s http://127.0.0.1:8792/healthz
{"ok":true,"service":"rentroll","db":"rentroll.db"} HTTP 200
```

### 2. Dashboard renders: PASS
- `curl -s http://127.0.0.1:8792/` returned 8191 bytes of real HTML, starting `<!doctype html><html lang="en"><head>…`.
- It has unit rows: Unit 2 PAID, Unit 3 UNPAID before payment.
- Unit 2 was PAID from the builder's run, as SPRINT1.md says.

### 3. Real payment and webhook round-trip: PASS (on rent period 2, not 1; see above)
```
$ curl -s -X POST http://127.0.0.1:8792/api/rent-periods/2/pay-sandbox -H 'Content-Type: application/json' -d '{"amount":"800.00"}'
{"ok":true,"payment":{"id":3,"rent_period_id":2,"status":"COMPLETED","amount_cents":80000,"fee_cents":2582,"net_cents":77418,
 "custom_id":"RR:rp2:2026-11:u2:i1:8abbb93f","paypal_order_id":"0PR48413SY774420J","paypal_capture_id":"0KU21143WF9666003",
 "paypal_debug_id":"f84756240ecd8","paid_at":"2026-11-10T22:56:52Z","webhook_event_id":null,...},
 "rent_period":{"before":"UNPAID","status":"PARTIALLY_PAID","paid_cents":80000,"balance_cents":40000}}  HTTP 200
```
- The response has a real PayPal order id and capture id, a debug id, a fee of $25.82 and a net of $774.18. It is not a canned response.

**The webhook arrived and the live service processed it.** I polled the DB, and after about 15 s:
```
webhook confirmed after ~15s: WH-8S385731KJ934624H-8VH81868F68373625 @ 2026-11-10T22:57:07.393Z
GET /api/rent-periods -> {'id': 2, 'unit_label': 'Unit 3', 'status': 'PARTIALLY_PAID', 'amount_paid_cents': 80000, 'balance_cents': 40000}
                         [('0KU21143WF9666003', 'COMPLETED', 'WH-8S385731KJ934624H-8VH81868F68373625')]
```

**Webhook log** (`tail -5 .sprint0-webhook-log.jsonl`, summarised):
```
2026-11-10T22:57:06.845Z PAYMENT.CAPTURE.COMPLETED WH-8S385731KJ934624H-8VH81868F68373625 0KU21143WF9666003 RR:rp2:2026-11:u2:i1:8abbb93f COMPLETED (paypal-transmission-sig present)
```

**Ledger row:**
```
11|2026-11-10T22:57:07.447Z|webhook_received|paypal|2|PayPal confirmed $800.00 from Priya Nair (capture 0KU21143WF9666003). Unit 3 November 2026: PARTIALLY PAID, balance $400.00|SUCCESS|live
```

**Note:** PARTIALLY_PAID is already set by the synchronous API response. The webhook adds `webhook_event_id` and `webhook_confirmed_at`, and the dashboard moves from "Waiting for PayPal webhook confirmation" to "confirmed". The webhook confirms the payment; it does not produce the status change. The brief's wording ("proves the webhook updates state") holds only in that sense.

### 4. Validation and edge cases: PASS (one minor issue)
```
overpay $500 on rp2 (open $400)   {"ok":false,"error":"amount $500.00 exceeds open balance $400.00"}  -> HTTP 422
non-JSON body                     Express default HTML error page WITH STACK TRACE                     -> HTTP 400
{"amount":"abc"}                  {"ok":false,"error":"amount must be a dollar amount like \"800.00\""} -> HTTP 400
{"amount_cents":"abc"}            {"ok":false,"error":"amount must be a positive dollar amount, ..."}   -> HTTP 400
{"amount":"-5"} / "0" / no body   400 / 400 / 400
form, amount=abc                  303 Location: /?err=amount%20must%20be...                            (clean)
/api/rent-periods/9999            {"ok":false,"error":"rent period 9999 not found"}                     -> HTTP 404
/api/rent-periods/abc             {"ok":false,"error":"rent period NaN not found"}                      -> HTTP 404
2 CONCURRENT $400 payments        A: 200 COMPLETED capture 7DS0036560817970A; B: 409 "has no open balance"
$1 more on rp2 (now PAID)         {"ok":false,"error":"Unit 3 2026-11 has no open balance"}             -> HTTP 409
$1 on rp1 (PAID)                  {"ok":false,"error":"Unit 2 2026-11 has no open balance"}             -> HTTP 409
```
- The race is handled: the PENDING row reserved inside BEGIN IMMEDIATE works.
- PayPal also confirmed the second rp2 payment by webhook within about 20 s.
- **Minor:** for a non-JSON body, the express.json() parser error falls through to Express's default handler. That page includes a stack trace with absolute server paths (`/home/pi/.openclaw/...`). The status is correct (400) and no secrets are exposed.

### 5. Ledger integrity / append-only: FAIL
- The ledger entries exist and are in chronological order: rows 10 (payment, 22:56:53) → 11 (webhook, 22:57:07), and so on. No HTTP route edits or deletes event_log; there are only `GET /api/event-log` and INSERTs in `logEvent`.
- **F3: the append-only triggers can be bypassed.** I tested this on a temp DB.
  ```
  $ sqlite3 rr.db "DELETE FROM event_log"                       Error: event_log is append-only (19)
  $ sqlite3 rr.db "UPDATE event_log SET summary='x' WHERE id=1" Error: event_log is append-only (19)
  $ sqlite3 rr.db "INSERT OR REPLACE INTO event_log(id,kind,actor,summary) VALUES(1,'tampered','x','REWRITTEN')"   (succeeds)
    before: 1|seed|November 2026 rent opened for Unit 2 ...   after: 1|tampered|REWRITTEN
  ```
  - REPLACE deletes the conflicting row without firing the DELETE trigger, because SQLite's `recursive_triggers` is off.
  - `DROP TRIGGER` is also allowed, as for any SQLite file.
  - The app's own code never uses REPLACE, so this is a DB-level gap, not an HTTP-reachable one.
  - **Fix:** add a `BEFORE INSERT` trigger that aborts when `NEW.id` already exists, or enable `PRAGMA recursive_triggers=ON` in openDb. Don't describe the ledger as "tamper-proof", since anyone with file access can drop the triggers.
- **F2: reset is not clean.** Tested on a temp DB with a copy of the real webhook log:
  ```
  $ RENTROLL_DB=tmp npm run reset          -> rent_period 1: UNPAID, rent_period 2: UNPAID
  $ (start server = service restart)       -> "[webhook] back-filled 5 logged deliveries"
  rent_period: 1|PAID|180000   payments: 1XH093476K818891C 80000, 45H728579V2749828 100000 (re-created)
  ```
  - The startup backfill replays `.sprint0-webhook-log.jsonl` into the fresh DB. Payments that carry our `custom_id` are recreated.
  - So "`npm run reset` returns both to UNPAID" (SPRINT1.md, For hack-lead #2) holds only until the next start. After that, Unit 2 is PAID again, and from now on Unit 3 will be too.
  - `--reset` also unlinks the DB while the service has it open: the service keeps serving the deleted file until it restarts.
  - **Fix:** in `--reset`, also rotate or truncate the webhook log, or record a reset watermark and skip earlier deliveries. Stop the service before resetting.

### 6. Security and scope: FAIL
- **F1 (blocker): forged webhooks are accepted.** Anyone who can reach `/webhooks/paypal`, which is public through the Funnel, can mark rent PAID. Tested on a clean `882d098` export with a temp DB:
  ```
  $ curl -X POST http://127.0.0.1:8794/webhooks/paypal -H 'Content-Type: application/json' -d '{"id":"WH-FORGED-2","event_type":"PAYMENT.CAPTURE.COMPLETED","create_time":"2026-11-10T23:00:00Z","resource":{"id":"FAKECAPTURE2","custom_id":"RR:rp2:2026-11:u2:i1:x","create_time":"2026-11-10T23:00:00Z","amount":{"currency_code":"USD","value":"1200.00"},"status":"COMPLETED"}}'
  {"ok":true,"result":"payment_confirmed","status":"PAID","paid_cents":120000,"verification":"SKIPPED_NO_HEADERS","via":"live"}  HTTP 200
  ledger: "PayPal confirmed $1,200.00 from Priya Nair (capture FAKECAPTURE2). Unit 3 November 2026: PAID, balance $0.00"
  dashboard: "Nothing to do. Paid in full, confirmed by PayPal"
  ```
  - The request had no `paypal-*` headers at all.
  - SPRINT1.md does disclose "bad signatures are not rejected yet". But it understates the impact: an unsigned request creates a payment row, and the ledger and dashboard then say "confirmed by PayPal".
  - With `WEBHOOK_VERIFY=enforce`, the same request returns `400 rejected_signature (SKIPPED_NO_HEADERS)` and the state stays UNPAID, so the fix exists.
  - **Fix:** make `enforce` the default. Both real deliveries and all backfilled ones verified SUCCESS, so the TODO's condition is already met.
  - Also related: if the forged event omits `create_time`, the handler returns 500 ("Provided value cannot be bound to SQLite parameter 10"), so PayPal-style retries would loop on it. The fix is to default `paid_at` to now.
- **The non-sandbox refusal works, but the check is loose.**
  - With `PAYPAL_API_BASE=https://api-m.paypal.com`, the call returned `503 "sandbox card payments are disabled: PAYPAL_API_BASE is not a sandbox URL"` and wrote 0 payment rows.
  - But the check is `/sandbox/i.test(base)`, a substring match. A base like `https://api-m.paypal.com/?sandbox` would pass.
  - Suggested fix: compare the hostname to exactly `api-m.sandbox.paypal.com` or `api.sandbox.paypal.com`. This is not a blocker, because the env is hack-lead-controlled.
- **Secrets: no leak found.**
  - The code reads PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET only in `lib/paypal.js` getToken. They are never logged and never put into responses. The oauth error message includes only PayPal's `error` and `error_description`.
  - No route echoes `process.env`.
  - `.gitignore` covers `.env*`, `data/` (the DB), `.sprint0-webhook-log.jsonl`, `*.log` and `scratch/`.
  - No `.env`, `.db` or webhook-log file was ever committed (`git log --all --name-only`).
  - A secret-pattern grep over the `8d29d15..882d098` diff found 0 matches.
  - Minor: the stack-trace page from section 4. Also, `/api/rent-periods` and `/api/event-log` are public through the Funnel and expose tenant name, email and phone. The tenants are fake for now, but this needs auth before real tenants are added.

## Where SPRINT1.md differs from what I observed
1. "`npm run reset` returns both to UNPAID": only until the next start, because the backfill recreates payments (F2).
2. "Signature verification runs and is recorded": in `record` mode an unsigned request is processed and labelled "confirmed by PayPal" (F1).
3. "event_log is append-only: triggers block UPDATE and DELETE": `INSERT OR REPLACE` rewrites rows (F3).
4. "Non-JSON gave 400": true, but the body is a stack-trace HTML page, not JSON.
5. Everything else I checked matched: the real Orders capture with fee and net, the live webhook within 15–20 s with SUCCESS verification, dedup by event id, 422/409/400/404, the concurrency guard, the 503 for a non-sandbox base, and .gitignore.

## What to fix before merging to `main`
1. **Required:** default `WEBHOOK_VERIFY` to `enforce` (F1).
2. **Required:** make `--reset` clear or watermark the webhook log so the backfill cannot bring payments back (F2). Document "stop service, reset, start".
3. Add a BEFORE INSERT duplicate-id trigger, or `PRAGMA recursive_triggers=ON` (F3).
4. **Nice to have:** a JSON error handler for body-parser errors, a hostname-exact sandbox check, and defaulting `paid_at` to now when the event has no `create_time`.
5. **Ops:** the shared working tree is now on `sprint2-ai-plan-parser`, and its uncommitted `server.js` crashes on start. Don't restart `rentroll.service` from it.

Current demo state of the real DB, left by this test: Unit 2 PAID ($800 + $1,000), Unit 3 PAID ($800 + $400, captures `0KU21143WF9666003` and `7DS0036560817970A`). Both are webhook-confirmed.

TESTER1 VERDICT: FAIL — Real sandbox payments and live webhook confirmation work, but the public webhook accepts unsigned forged events that mark rent "PAID, confirmed by PayPal" (default `WEBHOOK_VERIFY=record`), and `npm run reset` is undone by the startup backfill.
