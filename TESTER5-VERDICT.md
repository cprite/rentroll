# TESTER5 verdict: sprint8-basic-auth

Tested branch `sprint8-basic-auth` @ `d16688a` (based on `main` @ `7da0287`) on 2026-11-11. No product code was edited.

**Setup:** `node server.js` on `127.0.0.1:8811` with `NODE_USE_ENV_PROXY=1`, `DEMO_USER=judge` and `DEMO_PASSWORD=8c8r45j5md`. Throwaway database (`RENTROLL_DB=$TMPDIR/t5/t.db`, freshly seeded) and webhook log (`RENTROLL_WEBHOOK_LOG=$TMPDIR/t5/wh.jsonl`). Real PayPal sandbox and NVIDIA credentials came from the environment. Three server runs on the same throwaway database, each with its curls in the same shell command. Did not touch the real `data/rentroll.db`, the real webhook log, or `:8790`.

## 1. No credentials on `GET /`: PASS
`401 Unauthorized`, `WWW-Authenticate: Basic realm="RentRoll"`, `Login required. The demo login is listed in the README.`

## 2. Wrong credentials on `GET /`: PASS
`admin:8c8r45j5md`, `judge:nope`, `x:y`, `judge:` (empty password), `8c8r45j5md:` (password as user) all → 401.

## 3. Correct login: PASS
`-u judge:8c8r45j5md` on `GET /` → 200, real dashboard HTML (12475 bytes), all 7 dashboard forms present.

## 4. `/healthz` without credentials: PASS
`GET /healthz` → 200; `HEAD /healthz` → 200.

## 5. Forged PayPal webhook: PASS
No-credential forged body (no `paypal-*` headers) → `400 rejected_signature/SKIPPED_NO_HEADERS`. Same with wrong Basic Auth header → same 400 (reaches the signature check, not stopped by auth). Non-JSON body with a bogus Bearer header → `400 invalid JSON` (webhook handler answered, not the auth layer).

## 6. Every other route needs the login: PASS (23 routes/methods)
All dashboard/API/payment/plan/reminder/court-packet routes, plus neighbours of the open routes and several path-trick variants, returned 401 with no credentials and with a wrong login. `event_log` stayed at 3 seed rows throughout — nothing got through unauthenticated.

## 7. Full real flow with the login: PASS
Real sandbox capture (order `518646738N795845L`, capture `11604282V3583271G`), real LLM-proposed plan, approval, and installment-exact-amount enforcement ($1,800 and $1.00 refused with 422, $600.00 accepted, capture `2B7566285S6470246`, next installment then locked to $1,200.00). Court-packet PDF (200, `%PDF-`), reminders run, and a second tenant message all worked correctly behind the login.

## 8. Stability: PASS
`/healthz` 200 throughout; no stack traces or error strings in any of the three server logs.

## Notes (no fix needed)
- Empty-amount pay form gives the existing validation error, unrelated to auth.
- Real sandbox captures made during this test send their webhooks to the live service via the public URL, same as earlier testers' payments.
- The `DEMO_USER`/`DEMO_PASSWORD`-unset fallback (documented in `SPRINT8.md`) was not exercised here since it doesn't affect the deployed demo once `app.env` sets both.

TESTER5 VERDICT: PASS
