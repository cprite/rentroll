# SPRINT 3: approve → write (2026-11-10, ~23:35–23:55 UTC)

**Branch:** `sprint3-approve-flow` (worktree `app-sprint3/`, based on Sprint 2 `bd12741`). The code is in commit `c328000`, and this report is in a separate commit. Nothing was pushed, and nothing under `app/` was edited. I only read two things there: the raw webhook log and a copy of its DB.

## What was built (`server.js`, plus two test scripts)
- **`POST /api/plans/:id/approve`** (the form version is `POST /plans/:id/approve`):
  - Only a `proposed` plan can be approved. Anything else returns 409, an unknown id returns 404 and a non-integer id returns 400.
  - **Approval re-checks the ledger at the moment of approval.** The plan total must equal the current open balance (rent − COMPLETED − PENDING). If money moved after the AI proposed the plan, it returns 409 "stale, ask the tenant again".
  - Only one approved plan is allowed per rent period. The handler returns 409, and a partial UNIQUE index (`plan_one_approved`) enforces the same rule in the DB.
  - On approval it sets `status='approved'` and `approved_at`, and appends `event_log` `plan_approved` with actor `landlord`.
  - Any other open proposals for the same period are set to `rejected` (superseded), and their ids are listed in the payload.
- **`POST /api/plans/:id/reject`** (the form version is `/plans/:id/reject`):
  - Works on proposed, needs_review, parse_failed or approved plans. It returns 409 if an installment is still processing at PayPal.
  - Logs `plan_rejected`. The landlord can then ask for a new proposal, and once an approved plan is cancelled, free-form payments are allowed again.
- **The write-back, in `payRentPeriodSandbox()`:**
  - The check runs inside the same `BEGIN IMMEDIATE` transaction that reserves the PENDING payment row.
  - **If the period has an approved plan, any amount other than the next unpaid installment's exact amount returns 422 before PayPal is called.**
  - It returns 409 if the next installment is already PENDING.
  - Without an approved plan, Sprint 1's rule is unchanged: any amount up to the open balance.
  - "Next" means the first installment with no COMPLETED or PENDING payment linked to it.
- **Payments are linked to installments:**
  - New columns `payment.plan_id` and `payment.plan_installment` are added in place by `migrate()`.
  - The `i<n>` in `custom_id` is the plan installment number for plan payments.
  - The webhook handler keeps the link, because it matches by capture id or custom_id, and adds "for plan #X installment N" to the ledger line.
  - When every installment is PAID, the plan becomes `completed` and `plan_completed` is logged. This check runs on both the API path and the webhook path.
- **`GET /api/rent-periods/:id/plans`:** returns each plan with `approved_at` and `enforced`, plus `schedule` and `next_installment` for plans that were approved.
  - Example: `"installment 1 of 2: PAID ($900.00)"`, `"installment 2 of 2: due 2026-11-15 ($900.00)"`.
  - Each schedule entry carries its capture id and `webhook_confirmed`.
- **Dashboard:**
  - **Before approval:** the AI proposal box has working **Approve plan** and **Reject** buttons. The disabled Sprint 2 button is gone. "Tenant pays" is the free-form amount input (default: the full balance).
  - **After approval:**
    - A green box "🔒 Approved plan · enforced on every PayPal payment" shows a per-installment table: ✓ PAID with capture id and "✓ PayPal confirmed", NEXT · due, or upcoming.
    - The pay form loses its input. It shows a fixed `🔒 $900.00`, the button "Tenant pays installment 2 of 2" and the note "Locked by approved plan #1 · due Nov 15".
    - Next action reads "On approved plan #1: installment 2 of 2 ($900.00) due Nov 15".
    - The box has a **Cancel plan** button.
  - The amount travels in a hidden field. The server enforces it, so editing the HTML changes nothing: a forged form post is refused (see step 7 below).
- **Scripts:**
  - `scripts/sprint3-testdb.mjs` shifts the rent_period ids of a seeded **test** DB by +930. The live service gets every sandbox webhook, so test captures must not match a real-DB row. The script refuses to touch `data/rentroll.db`.
  - `scripts/sprint3-offline.sh` is an offline check with no LLM call and no capture.

## The real test (real LLM, real PayPal sandbox, test DB `$TMPDIR/s3b/test.db`, rent_period 931 = Unit 2, $1,800 unpaid)
Server: `RENTROLL_DB=$TMPDIR/s3b/test.db PORT=8794 NODE_USE_ENV_PROXY=1 node server.js`. All times are UTC.

**1. The tenant texts. A real LLM proposes a plan grounded in the ledger (23:49:57Z):**
```
$ curl -X POST -H Content-Type:application/json -d {"body":"can I pay 900 now and the rest on the 15th"} /api/rent-periods/931/messages
{ "ok": true, "plan_id": 1, "status": "proposed",
  "installments": [ {"due_date":"2026-11-10","amount_cents":90000,"note":"Initial payment"},
                    {"due_date":"2026-11-15","amount_cents":90000,"note":"Remaining balance"} ],
  "validation_errors": [], "ledger_outstanding_cents": 180000,
  "reasoning": "Tenant offered $900 now and $900 on the 15th. The ledger shows full outstanding balance of $1800.00 due to no prior payments. ...",
  "llm": {"model":"nvidia/nemotron-3.5-lightning-30b-a3b","ms":1603,"finish":"stop"} }
```
**2. The landlord approves:**
```
$ curl -X POST /api/plans/1/approve
{"ok":true,"plan":{"id":1,...,"status":"approved","approved_at":"2026-11-10T23:49:59.814Z","enforced":true,
 "schedule":[{"n":1,"of":2,...,"state":"DUE","label":"installment 1 of 2: due 2026-11-10 ($900.00)"},
             {"n":2,"of":2,...,"state":"UPCOMING","label":"installment 2 of 2: upcoming 2026-11-15 ($900.00)"}],
 "next_installment":{"n":1,...,"amount_cents":90000}},"superseded_plan_ids":[]}  -> HTTP 200
```
**3. Wrong amounts are refused. Both would have been accepted before approval, since both are ≤ the $1,800 balance:**
```
$ curl -X POST -H Content-Type:application/json -d {"amount":"1800.00"} /api/rent-periods/931/pay-sandbox
{"ok":false,"error":"approved plan #1 only accepts installment 1 of 2: exactly $900.00 (due 2026-11-10). $1,800.00 refused"}  -> HTTP 422
$ curl -X POST -H Content-Type:application/json -d {"amount":"500.00"} /api/rent-periods/931/pay-sandbox
{"ok":false,"error":"approved plan #1 only accepts installment 1 of 2: exactly $900.00 (due 2026-11-10). $500.00 refused"}  -> HTTP 422
```
**4. The exact installment amount is accepted and a real sandbox capture runs:**
```
$ curl -X POST -H Content-Type:application/json -d {"amount":"900.00"} /api/rent-periods/931/pay-sandbox
{"ok":true,"payment":{"id":1,"rent_period_id":931,"installment_index":1,"status":"COMPLETED","amount_cents":90000,"fee_cents":2901,"net_cents":87099,
 "custom_id":"RR:rp931:2026-11:u1:i1:b7c8d0c1","paypal_order_id":"55320646PM521071L","paypal_capture_id":"50J960343T2087406",
 "paypal_debug_id":"ca588f4fb1865","paid_at":"2026-11-10T23:50:02Z","webhook_event_id":null,"plan_id":1,"plan_installment":1},
 "rent_period":{"before":"UNPAID","status":"PARTIALLY_PAID","paid_cents":90000,"balance_cents":90000}, ... "plan_status":"approved"}  -> HTTP 200
```
**5. PayPal's webhook arrives:**
- PayPal delivered `PAYMENT.CAPTURE.COMPLETED` through the Funnel to the live `rentroll.service`, 10 s after the capture.
- From the live service's raw log, `../app/.sprint0-webhook-log.jsonl` (read-only):
```
2026-11-10T23:50:12.693Z PAYMENT.CAPTURE.COMPLETED WH-392188405L141403D-2KW43472AA404394W 50J960343T2087406 RR:rp931:2026-11:u1:i1:b7c8d0c1 COMPLETED {'currency_code': 'USD', 'value': '900.00'} sig present: True
```
- I replayed that exact delivery (raw bytes and PayPal's original `paypal-*` headers) into my build's live HTTP route. This is the same method Sprint 1 used.
```
$ curl -X POST -H @paypal-headers --data-binary @raw.json /webhooks/paypal   (1st)
{"ok":true,"result":"payment_confirmed","payment_id":1,"before":"PARTIALLY_PAID","status":"PARTIALLY_PAID","paid_cents":90000,"balance_cents":90000,
 "event_id":"WH-392188405L141403D-2KW43472AA404394W","event_type":"PAYMENT.CAPTURE.COMPLETED","verification":"SUCCESS","via":"live"}  -> HTTP 200
$ (same delivery again)
{"ok":true,"result":"duplicate","event_id":"WH-392188405L141403D-2KW43472AA404394W"}  -> HTTP 200
```
**6. Installment 1 is PAID, installment 2 is still due:**
```
$ curl /api/rent-periods/931/plans
1 approved enforced= True [["installment 1 of 2: PAID ($900.00)", "50J960343T2087406", "webhook_confirmed=True"], ["installment 2 of 2: due 2026-11-15 ($900.00)", null, "webhook_confirmed=False"]]

$ curl /   (Unit 2 row + plan box, HTML text-extracted)
Jordan Ellis · $1,800.00 due Nov 1 · $900.00 paid · $900.00 left · PARTIALLY PAID
On approved plan #1: installment 2 of 2 ($900.00) due Nov 15
Nov 10 · $900.00 card · plan #1 inst. 1 · ✓ PayPal confirmed
🔒 $900.00   [Tenant pays installment 2 of 2]   Locked by approved plan #1 · due Nov 15
🔒 Approved plan · enforced on every PayPal payment     plan #1 · approved Nov 10, 23:49 UTC
1 of 2  Nov 10  $900.00  ✓ PAID  capture 50J960343T2087406 · ✓ PayPal confirmed
2 of 2  Nov 15  $900.00  NEXT · due Nov 15
[Cancel plan]
--- forms in Unit 2 row: ['/rent-periods/931/pay-sandbox', '/rent-periods/931/messages'] ['<input type="hidden" name="amount" value="900.00">']
```
**7. A forged dashboard form post with the wrong amount is refused:**
```
$ curl -X POST -d amount=100.00 /rent-periods/931/pay-sandbox
Location: /?err=approved plan #1 only accepts installment 2 of 2: exactly $900.00 (due 2026-11-15). $100.00 refused
```
**Ledger (test DB `event_log`):**
```
3 23:49:58.000Z message_in      tenant   Jordan Ellis (sms): "can I pay 900 now and the rest on the 15th"
4 23:49:59.631Z plan_proposed   ai       AI proposed a plan for the $1,800.00 balance: $900.00 on 2026-11-10, $900.00 on 2026-11-15. Awaiting landlord approval
5 23:49:59.814Z plan_approved   landlord Landlord approved plan #1 for Jordan Ellis: #1 $900.00 by 2026-11-10, #2 $900.00 by 2026-11-15. PayPal payments now only accepted for the next installment's exact amount
6 23:50:02.568Z payment         tenant   Jordan Ellis paid $900.00 by card through PayPal (plan #1, installment 1 of 2) (capture 50J960343T2087406, COMPLETED). Balance now $900.00
7 23:50:33.646Z webhook_received paypal  PayPal confirmed $900.00 from Jordan Ellis for plan #1 installment 1 (capture 50J960343T2087406). Unit 2 November 2026: PARTIALLY PAID, balance $900.00 [sig SUCCESS]
```

### Why a plain LLM-wrapper chat could not have done this
- In a chat, "approve" only changes the conversation. The tenant can still pay any amount, and nothing checks it.
- Here, approval writes a constraint to the server's database. **The next real PayPal transaction has to satisfy that constraint before PayPal is even called.**
  - Before approval, $1,800 or $500 would have been captured. After approval, both got 422.
  - Only the $900 installment was captured (`50J960343T2087406`), and it was then confirmed by PayPal's signed webhook.
  - After that, the constraint moved to installment 2 by itself.
- Our code does every step of the enforcement: checking the balance at approval time, matching the exact amount, the ordering, linking the payment to an installment, and settling the plan from webhooks. The model's only job was to turn "900 now and the rest on the 15th" into dates and amounts, and our validator checks even that.
- A model with no access to this ledger and this payment rail can produce a plan as text. It cannot make a different amount get refused.

## Other checks actually run
- **`scripts/sprint3-offline.sh`** (fresh test DB, synthetic plans, no LLM, no capture). All returned as expected:
  - Approving a `needs_review` plan: 409.
  - Approving a stale plan ($500 vs a $1,200 balance): 409 "stale".
  - `abc`: 400. `99`: 404. A second approve: 409.
  - $800, $1,800 and $5 (form): 422 or the err redirect, before any PayPal call. 0 payment rows were created.
  - The dashboard showed the locked form.
  - Reject on the approved plan restored Sprint 1's rule ($5,000 gave "exceeds open balance $1,800.00").
  - The `plan_approved` and `plan_rejected` ledger rows were present.
- **Pre-approval dashboard** (synthetic proposed plan): it shows the free-form `<input name="amount" value="1800.00">` and working `Approve plan` and `Reject` forms, and no `disabled` button.
- **Migration on a copy of the real DB** (`../app/data/rentroll.db` and its WAL, copied to `$TMPDIR`, never opened in place):
  - Opened cleanly. `payment` gained `plan_id,plan_installment` and the `plan_one_approved` index was created.
  - Existing data was intact: both units PAID.

## Honest notes / for hack-lead
1. **An aborted first run made one extra real capture.**
   - My first E2E script had a bug: my curl wrapper printed a line before the JSON, so the plan-id parse failed and the approve call hit `/api/plans//approve` (404).
   - The script didn't stop, so its `$1,800` call ran with **no approved plan**. It was correctly captured under Sprint 1's rule: capture `38N014768N4176055`, custom_id `RR:rp931:...`, in a throwaway DB `$TMPDIR/s3`.
   - That is not evidence for this sprint. It will appear in the live service's ledger as "unmatched", because id 931 doesn't exist there.
   - The rerun above added abort guards.
2. **The webhook was replayed, not received live by my build.** PayPal can only reach the live service through the Funnel. The live service is still on `app/`'s build and DB. The replay uses PayPal's real delivery bytes and headers, and verification returned SUCCESS. The same limitation applied in Sprints 1 and 2.
3. **The webhook confirms the payment; it does not change the installment state.** The capture's synchronous COMPLETED response already marks installment 1 PAID. The webhook adds `webhook_confirmed` (the "✓ PayPal confirmed" badge). This is the same semantics TESTER1 noted for Sprint 1.
4. **Not built:**
   - No due-date enforcement: installment 2 can be paid early. Only the exact amount and the order are enforced.
   - When an installment goes overdue, the plan is not automatically set to `broken`. It is shown as "OVERDUE since" only.
   - The LLM is still told the plain outstanding balance when an approved plan is active. A new proposal can be made, but it can't be approved until the current plan is cancelled (409).
   - Invoicing is still not touched (403-blocked). This is the Orders-rail equivalent of `allow_partial_payment`.
5. **The real DB gets the new columns and index on the first start of this build.** This was tested on a copy only. Approving and paying on the live demo DB has not been done.
6. Not tested: no browser or screenshot. The dashboard was checked through HTML extraction only.

SPRINT3 STATUS: done. Approving the AI plan now writes a server-enforced constraint: after approval, the real sandbox refused $1,800 and $500 (422), captured exactly $900 as installment 1 (`50J960343T2087406`, webhook signature SUCCESS), and moved the constraint on to installment 2.
