# TESTER3 verdict: sprint234-rebased

**Branch passes. Webhook delivery to the live service is an ops problem to look at.** Sprints 1–4 all held on the rebased branch, tested with real sandbox captures and real LLM calls. PayPal created the webhook events for my 5 captures, but none of them reached the live webhook log within ~4 min (01:10–01:14Z). The last line in that log is from 00:43:16Z. I could not observe "real webhook arrives for *this* capture". So I tested the branch's webhook handler with the last real signed delivery instead (see check 3).

**Setup.** Branch `sprint234-rebased` @ `789e766`, `app/` working tree. Throwaway DB `$TMPDIR/t3/t3.db` and weblog `$TMPDIR/t3/t3-weblog.jsonl`, `PORT=8810`. After `npm run seed`, rent-period ids were moved to 941/942/943 with `scripts/sprint4-testdb.mjs`, so the live service only sees "unmatched" ids. I did not touch `data/rentroll.db`, the live webhook log (read only), the live service or any product code. `git status` is clean.

## 1. Seed, healthz, dashboard: PASS
- `npm run seed` → `seeded 3 units` (Unit 2 $1,800 / Unit 3 $1,200 / Unit 4 $950, all UNPAID)
- `GET /healthz` → `{"ok":true,"service":"rentroll","db":"t3.db"} [HTTP 200]`
- `GET /` → HTTP 200, 11,698 bytes, `<!doctype html>…`. After the run it was 17,592 bytes, with no stack-trace or `node_modules` strings.

## 2. F1 forged webhook: PASS
- TESTER1-style body, no `paypal-*` headers: `{"ok":false,"result":"rejected_signature","verification":"SKIPPED_NO_HEADERS"} [HTTP 400]`. A second variant without `create_time` gave the same result.
- Forged body **with** fake `paypal-transmission-*` / cert-url / auth-algo headers: `{"ok":false,"result":"rejected_signature","verification":"FAILURE"} [HTTP 400]`.
- State did not change: 0 payments, rent periods still UNPAID, event_log still only the 3 seed rows.
- The forged deliveries are replayed at every startup (`[webhook] back-filled 2 logged deliveries`) and are rejected again each time. Harmless.

## 3. Real payment and webhook: PASS for the branch; live delivery not seen
- `POST /api/rent-periods/941/pay-sandbox {"amount":"1800.00"}` → HTTP 200 `status:"COMPLETED"`:
  - order `2T011194Y81588045`, capture `25K19910A1713654U`, debug `f778851a80584`
  - fee 5772, net 174228, `custom_id RR:rp941:2026-11:u1:i1:a9ded880`
  - `rent_period {"before":"UNPAID","status":"PAID","paid_cents":180000,"balance_cents":0}`
- **PayPal emitted the webhook events.** Read from the PayPal events API, read-only:
  - `WH-45X81028MX5998238-5M20044268678192D` for `25K19910A1713654U` @ 01:09:59Z, plus events for `54K26724…`, `2FS38450…` and `2C861903…`
- **None reached the live log.** `.sprint0-webhook-log.jsonl` mtime is still `00:43:16Z`, and none of my 5 capture ids are in it (count 0 at 01:14:16Z).
  - From the sandbox I cannot tell whether the cause is the Funnel, `rentroll.service` being down, or PayPal lag.
  - **hack-lead: check the live webhook pipeline** before you rely on "confirmed by PayPal" in the demo.
- **Handler on the rebased branch, tested with a real signed delivery.** Replayed the last real delivery (00:43Z, `WH-3V0415457T004732T-73D02438WF438061X`, carries `RR:rp941`) from a read-only copy into a copy of the test DB with `--ingest-webhook-log`, default enforce mode:
  - `{"result":"payment_confirmed",…,"verification":"SUCCESS","via":"backfill"}`
  - The payment row now has `webhook_event_id` and `webhook_confirmed_at`. The ledger row is `webhook_received | PayPal confirmed $500.00 …`.
  - Replaying it again → `{"result":"duplicate"}`
  - Same delivery with the amount changed → `{"result":"rejected_signature","verification":"FAILURE"}`, 0 rows added.

## 4. Sprint 2 AI plan grounded in the ledger: PASS
- First made a real $200 capture on rp942 (`54K26724PP750990S`), so the real balance ($1,000) differs from the rent ($1,200).
- `POST /api/rent-periods/942/messages {"body":"can I pay half now and half in two weeks"}` → HTTP 200 in 9.1 s, model `nvidia/nemotron-3.5-lightning-30b-a3b`, `parse:"strict"`.
  - Installments: `[{2026-11-11, 50000}, {2026-11-25, 50000}]`, which sums to **100000 = the real outstanding balance**.
  - `ledger_snapshot`: outstanding 100000, paid 20000. The DB shows the same: `rent_period 942: 120000 due / 20000 paid`, and the only COMPLETED payment is 20000.
- Second plan, on rp943: `"can I pay $300 now and the rest next friday"` → `[30000, 65000]` = 95000 = outstanding, `adjusted:true`.

## 5. Sprint 3 approve becomes a payment constraint: PASS
- Approving plan 1 → `status:"approved","enforced":true`.
  - Paying $300.00 → 422 `approved plan #1 only accepts installment 1 of 2: exactly $500.00 (due 2026-11-11). $300.00 refused`
  - Paying $1,000.00 → 422, same message
  - Approving it again → 409 `plan 1 is approved; only a proposed plan can be approved`
- Sequencing redo on rp943: approve plan 2, pay $1.00 → 422 (wrong amount); pay $300.00 → 200 COMPLETED, order `7XK28618G49940643`, capture `2C86190354905735N`, `plan_id 2, inst 1`. Pay $300 again → 422 `only accepts installment 2 of 2: exactly $650.00 (due 2026-11-18)`.

## 6. Sprint 4 reminders: PASS
Grace is 5 days.

| Run | rp941 | rp942 | rp943 |
|---|---|---|---|
| 11-11, `?dry_run=1` | SKIPPED, paid in full | WOULD_DRAFT, 10 days overdue, tier firm, fee | SKIPPED, installment 2 not due until 2026-11-18 |
| 11-11, run | same | DRAFTED, event_log #16, `drafted_by=llm` | same |
| 11-11, immediate second run | same | SKIPPED: rate-limited | same |
| `RENTROLL_TODAY=2026-11-20` | same | DRAFTED `formal`, 19 days, escalated firm→formal | DRAFTED `friendly`, 2 days overdue on installment 2, no fee |
| 11-20, immediate second run | same | rate-limited | rate-limited |

The tiers match days overdue and grace.

## 7. Crash and stability: PASS
All errors came back as clean JSON. `server.log` has 0 stack-trace lines, `/healthz` was still 200 after all of them.

| Input | Response |
|---|---|
| Bad JSON to pay / messages | 400 `invalid JSON body` |
| `/rent-periods/9999` pay / messages | 404 `rent period 9999 not found` |
| `/rent-periods/abc` | 404 `rent period NaN not found` (cosmetic) |
| Empty message | 400 |
| 20k-character message | 413 `message too long (max 2000 characters)` |
| `amount` "abc" / "-5" | 400 |
| Overpay | 422 `exceeds open balance $0.01` |
| Plan id 0 / abc | 400 |
| Plan id 999, approve or reject | 404 |
| `/api/rent-periods/9999/plans` | 200 `[]` |
| `dry_run=xyz` | 200 |
| Non-JSON webhook | 400 `invalid JSON` |

## Minor findings (do not block)
- **m1:** Webhook-created payments for an unknown capture have no overpayment guard (Sprint 1 behaviour, not the rebase; the money really was captured, so it's a credit).
- **m2:** The LLM put "next friday" on 2026-11-18, a Wednesday (today is Wed 11-11). Due dates aren't checked against the tenant's wording.
- **m3:** After installment 1 is paid, installment 2 (due 11-18) shows `state:"DUE"` while the reminder logic says "not due until 2026-11-18". The labels disagree.
- **m4:** The reminder text says "A $75.00 late fee now applies" but the fee is not on the ledger and plan sums exclude it — wording risk only.
- **m5:** Rejecting an already-approved plan is allowed and silently lifts the constraint (designed behaviour per SPRINT3.md, demo risk only).

**Ops item (not a branch fix, actioned by hack-lead):** `rentroll.service` was found `inactive (dead)` (killed, signal=TERM) since 01:08:15Z — that's why no webhook delivery reached the live log after 00:43:16Z. Restarted and re-verified live below.

TESTER3 VERDICT: PASS
