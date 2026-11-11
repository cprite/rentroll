# SPRINT1-FIX: fixes for TESTER1 F1/F2/F3 (branch `sprint1-data-model`, commit `cb24455` on top of `1e37eae`)

Run on 2026-11-10, about 23:45 to 23:50 UTC. Files changed: `server.js` and `.gitignore`.

## How it was tested
- **Before:** a clean `git archive 1e37eae` export in `$TMPDIR/fix1/src-before`. Its `server.js` sha256 is `457ccd19…`, the same as the commit.
- **After:** a copy of the fixed tree in `$TMPDIR/fix1/src-after`.
- **Same script both times:** `$TMPDIR/fix1/repro.sh <app> <port> <label>`, on ports 8795 (before) and 8796 (after).
  - Each run gets its own throwaway `RENTROLL_DB` and `RENTROLL_WEBHOOK_LOG`.
  - F2 uses a byte copy of the real webhook log (sha256 `46fb4aa7…`).
- **Real files not touched:** the real `data/rentroll.db` and `.sprint0-webhook-log.jsonl` were never opened for writing. After the run the real log still had sha256 `46fb4aa7…` and mtime 23:00:25.
- **Live service not tested:** `rentroll.service` was not restarted or tested by this worker (hack-lead did that afterward).

## F1: forged or unsigned webhook accepted. FIXED
**Change:**
- `WEBHOOK_VERIFY` now defaults to `enforce`. Only the exact value `record` turns enforcement off.
- `paid_at` now falls back to the current time when both `resource.create_time` and `event.create_time` are missing. This applies to both places where the webhook handler writes `paid_at`.

Repro, using the tester's exact body:
```
curl -X POST http://127.0.0.1:<port>/webhooks/paypal -H 'Content-Type: application/json' -d '{"id":"WH-FORGED-TEST","event_type":"PAYMENT.CAPTURE.COMPLETED","create_time":"2026-11-10T23:00:00Z","resource":{"id":"FAKECAPTURE-TEST","custom_id":"RR:rp2:2026-11:u2:i1:x","create_time":"2026-11-10T23:00:00Z","amount":{"currency_code":"USD","value":"1200.00"},"status":"COMPLETED"}}'
```
BEFORE (`1e37eae`):
```
{"ok":true,"result":"payment_confirmed","payment_id":1,"before":"UNPAID","status":"PAID","paid_cents":120000,"balance_cents":0,"event_id":"WH-FORGED-TEST",...,"verification":"SKIPPED_NO_HEADERS","via":"live"} HTTP 200
payments:    1|2|COMPLETED|120000|FAKECAPTURE-TEST
rent_period: 1|UNPAID|0   2|PAID|120000
forged event without create_time: {"ok":false} HTTP 500
```
AFTER:
```
{"ok":false,"result":"rejected_signature","verification":"SKIPPED_NO_HEADERS"} HTTP 400
payments:    (no rows)
rent_period: 1|UNPAID|0   2|UNPAID|0
forged event without create_time: {"ok":false,"result":"rejected_signature","verification":"SKIPPED_NO_HEADERS"} HTTP 400
```

### Missing `create_time`
I cannot produce a real signed event that lacks `create_time`. So I tested the code path with `WEBHOOK_VERIFY=record` and an event with no `create_time`:
```
{"ok":true,"result":"payment_confirmed","payment_id":1,...,"event_id":"WH-NOTIME",...} HTTP 200
payment row: 1|COMPLETED|1000|2026-11-10T23:47:04.532Z    (paid_at = now)
same event again: {"ok":true,"result":"duplicate","event_id":"WH-NOTIME"} HTTP 200
```
Before the fix, this returned a 500 ("cannot be bound to SQLite parameter").

### Regression check: real signed deliveries under `enforce`
I ran `node server.js --ingest-webhook-log` in the default `enforce` mode, on a fresh throwaway DB with a copy of the real log.
- All 8 deliveries returned `"verification":"SUCCESS"` from PayPal's verify-webhook-signature.
- The rent periods ended at `1|PAID|180000` and `2|PAID|120000`.
- So real deliveries are still processed. Only unverified ones are rejected.

Forged POSTs are still appended to the raw log for audit. When the back-fill replays them, they are rejected again and cannot change state.

## F2: `npm run reset` undone by the startup back-fill. FIXED (option a: rotate the log)
**Change:**
- `--reset` now renames `WEBHOOK_LOG` to `<log>.pre-reset-<ISO timestamp>`. The file is kept for audit, not deleted.
- The back-fill only reads `WEBHOOK_LOG`, so it can no longer recreate old payments.
- `.gitignore` now uses `.sprint0-webhook-log.jsonl*`, so the rotated files stay untracked.

Repro steps: copy of the real log, then `npm run reset`, then start the server (the back-fill runs), wait 12 s, stop it and query the DB.

BEFORE:
```
seeded 2 units ... rent_period 1: ... UNPAID / rent_period 2: ... UNPAID
[after restart] [webhook] back-filled 8 logged deliveries
rent_period: 1|PAID|180000   2|PAID|120000
payments: 1XH093476K818891C|80000  45H728579V2749828|100000  0KU21143WF9666003|80000  7DS0036560817970A|40000
```
AFTER:
```
rotated webhook log to /tmp/claude-1000/fix1/work-after/weblog.jsonl.pre-reset-2026-11-10T23-46-31-741Z
seeded 2 units ... rent_period 1: ... UNPAID / rent_period 2: ... UNPAID
[after restart] rentroll listening on http://127.0.0.1:8796 ...   (no back-fill line)
rent_period: 1|UNPAID|0   2|UNPAID|0
payments: (no rows)
```

Not changed in code: reset still unlinks the DB file. A running service keeps serving the deleted file until it restarts. The correct order is: stop the service, run `npm run reset`, start the service. This is now written in comments at the top of `server.js` and at the reset code.

## F3: event_log append-only bypass via `INSERT OR REPLACE`. FIXED
**Change:**
- Two new `BEFORE INSERT` triggers in the schema (`CREATE TRIGGER IF NOT EXISTS`):
  - `event_log_no_replace` aborts if `NEW.id` already exists.
  - `event_log_no_replace_event` aborts if `NEW.paypal_event_id` already exists, because REPLACE on that UNIQUE column would also delete a row.
- Also added `PRAGMA recursive_triggers = ON` in `openDb`.
  - The pragma alone would not fix the tester's repro. It applies per connection, and the repro uses the `sqlite3` CLI.
  - The triggers are stored in the DB file, so they apply to every connection.
- The webhook dedup race handler now also treats the trigger's "duplicate paypal_event_id" error as `duplicate`.

Repro: `sqlite3 <db> "INSERT OR REPLACE INTO event_log(id,kind,actor,summary) VALUES(1,'tampered','x','REWRITTEN')"`

BEFORE:
```
before: 1|seed|November 2026 rent opened for Unit 2 (Jordan Ellis): $1,800.00 due 2026-11-01
exit=0
after:  1|tampered|REWRITTEN
```
AFTER:
```
before: 1|seed|November 2026 rent opened for Unit 2 (Jordan Ellis): $1,800.00 due 2026-11-01
Error: stepping, event_log is append-only: id already exists (19)
exit=19
after:  1|seed|November 2026 rent opened for Unit 2 (Jordan Ellis): $1,800.00 due 2026-11-01
```

### Existing-DB check
1. I copied a DB created by the old build. It had only the `event_log_no_update` and `event_log_no_delete` triggers.
2. The new build opened it once (`--seed`). After that it also had `event_log_no_replace` and `event_log_no_replace_event`.
3. REPLACE on id 2 failed with `append-only: id already exists (19)`.
4. REPLACE with an existing paypal_event_id failed with `append-only: duplicate paypal_event_id (19)`.
5. A normal INSERT still worked (exit 0).

The real DB gets these triggers on the next service start.

Limit: anyone with write access to the file can still `DROP TRIGGER`, so this is "append-only", not "tamper-proof". This is noted in the schema comment.

## Nice-to-haves
- **DONE: JSON 400 for body-parser errors.**
  - Before: posting non-JSON to `/api/rent-periods/1/pay-sandbox` returned Express's HTML page with a stack trace showing `/home/pi/.openclaw/...` paths.
  - After: `{"ok":false,"error":"invalid JSON body"} HTTP 400`. Any 5xx now returns a generic `internal error` body.
- **DONE: exact sandbox hostname check.**
  - The code compares `new URL(base).hostname` against `api-m.sandbox.paypal.com` and `api.sandbox.paypal.com`.
  - Test: `PAYPAL_API_BASE='https://api-m.paypal.com/?sandbox'` returned `503 "sandbox card payments are disabled: PAYPAL_API_BASE is not a sandbox URL"`.
  - Not tested: a real sandbox card capture through this check. No new PayPal charge was made during this fix.
- **DONE (comment only): auth TODO** above `/api/rent-periods`. It says the dashboard and APIs are public through the Funnel and expose tenant name/email/phone, and that auth is needed before real tenant data. No auth was built.

## Not verified by this worker (done by hack-lead afterward)
- The live `rentroll.service` was not restarted or tested by this worker. It needed a stop and start to pick up `cb24455`.
- Nothing was merged to `main` or pushed by this worker.

SPRINT1FIX STATUS: done — F1, F2 and F3 no longer reproduce on throwaway copies with the tester's exact steps, real signed deliveries still verify SUCCESS under the new `enforce` default, and the fixes are committed on `sprint1-data-model` as `cb24455`.
