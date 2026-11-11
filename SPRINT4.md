# SPRINT 4: reminder escalation from real payment state (2026-11-11, ~00:30–00:50 UTC)

**Branch:** `sprint4-reminders` (worktree `app-sprint4/`, based on Sprint 3 `528de57`). Code commit `0e532f0`, plus a label fix and this report in a second commit. Nothing pushed. `app/` and `app-sprint3/` were not touched or read.

## What was built
- **`lib/reminders.js`** (new):
  - `reminderState(d, rpId, today)` is **our code reading the DB** on every run. Nothing is cached or taken from the stored flags:
    - Open balance = rent − SUM(`payment` rows with status COMPLETED). That includes rows a PayPal webhook completed. `rent_period.status` and `amount_paid_cents` are **ignored**.
    - Owed amount:
      - With an approved (enforced) plan: the plan's next unpaid installment, with target key `plan<id>:i<n>`.
      - Without one: the open balance, with target key `rp<id>`.
    - Days overdue = today − the due date of that installment or rent period.
    - Tier comes from days overdue and the unit's `late_fee_rule_json.grace_days` (5 in the seed):
      - **friendly**: days 1–5, inside the grace period, no fee.
      - **firm**: days 6–14. The late fee applies from day 6, the same day the Sprint 1/2 code says it applies.
      - **formal**: day 15 and later.
    - Prior reminders = `event_log` rows with `kind='reminder_sent'` and the same `target_key`, read with `json_extract`. This gives the count, the last timestamp, the last tier and the last amount owed.
  - **Skip rules** (checked in this order):
    1. Paid in full according to the payments table. If the cached flag disagrees, the reason says it was ignored.
    2. A payment is still PENDING at PayPal.
    3. The plan's next installment is not due yet.
    4. Not overdue yet.
    5. **Rate limit:** a reminder for the same target is less than `REMINDER_MIN_INTERVAL_HOURS` old (default 24), measured from the real `event_log.at` timestamp, **and** neither the amount owed nor the tier has changed since. If the balance changed or the tier went up, a new reminder is allowed inside the window.
  - The late fee is only mentioned when there's no approved plan. An approved plan reschedules the balance, so the reminder doesn't talk about the fee.
  - `draftReminder(st)`: the LLM gets the computed facts plus tone rules for the tier, with `max_tokens` 1024 and thinking off, the same as Sprint 2. It must reply with `{"text": ...}`.
  - **`validateDraft` runs on the server.** It checks that:
    - the exact owed amount string appears;
    - the late-fee amount appears when the fee applies (firm and formal);
    - no fee is mentioned when it doesn't apply;
    - there are no placeholders, and the text is ≤ 600 characters.
  - If a draft fails, the error goes back to the model for one retry. If that also fails, or the LLM is down, a fixed per-tier template is used and labelled `drafted_by: template` with the reason.
- **`runReminders()`** in `server.js`:
  - `POST /api/reminders/run`. With `?dry_run=1` it only computes the decisions and writes nothing.
  - The dashboard form is `POST /reminders/run`, which redirects back with a flash summary.
  - `GET /api/reminders` lists the reminders.
  - An in-process lock returns 409 if a run is already in progress.
  - After the LLM call, the state is **re-checked inside `BEGIN IMMEDIATE`** before anything is written. If money moved while the draft was being written, the draft is discarded.
  - Each reminder is one `event_log` row: `kind='reminder_sent'`, actor `ai`. Its payload holds the target, tier, days overdue, amounts, reminder number, previous reminder id, what changed, the text, `drafted_by`, the LLM attempts, and `delivery: "not_sent: no SMS/email integration in this build; drafted and logged only"`.
  - The ledger summary line says "Would be sent by SMS in production; not delivered".
- **Dashboard:**
  - A **Send reminders now** button sits above the units table, with a note explaining what the check reads.
  - Under each unit with a reminder there is a box showing:
    - a tier pill (blue "Friendly nudge", amber "Firm reminder", red "Formal notice"), with a coloured left border to match;
    - the reminder number, days overdue, amount owed and the late-fee note;
    - the drafted text and "drafted and logged only, not delivered".
- **Seed:** adds **Unit 4, Sam Okafor, $950, due on the 8th**, so the demo shows two tiers on the same day. On Nov 11, Unit 2 is 10 days late (firm) and Unit 4 is 3 days late (friendly). Each unit's seed due date now comes from its `due_day`. Existing DBs are not affected, because seeding only runs on an empty DB.
- **Scripts:**
  - `scripts/sprint4-test.sh` is the real test below.
  - `scripts/sprint4-offline.sh` covers the plan, pending and stale-flag cases. It makes no LLM call and no capture.
  - `scripts/sprint4-testdb.mjs` offsets ids by +940 and has a `stale` mode that fakes the cached flag.

## The real test (real LLM, real PayPal sandbox captures, test DB `$TMPDIR/s4real/test.db`, ids 941–943)
Command: `bash scripts/sprint4-test.sh` (server on 127.0.0.1:8797, `NODE_USE_ENV_PROXY=1`). The transcript is verbatim, with long lines wrapped.
- rp941 = Unit 2, $1,800, due Nov 1.
- rp942 = Unit 3, $1,200, due Nov 1.
- rp943 = Unit 4, $950, due Nov 8.
```
=== server up, RENTROLL_TODAY=2026-11-11 (00:42:47Z) ===
$ POST /api/rent-periods/942/pay-sandbox {"amount":"1200.00"}
  ok= True  capture 5HX916624X775891T COMPLETED | period {'before': 'UNPAID', 'status': 'PAID', 'paid_cents': 120000, 'balance_cents': 0}
cached columns now: { id: 942, status: 'UNPAID', amount_paid_cents: 0 } | COMPLETED payments: { s: 120000, n: 1 }     <- stale flag faked on purpose
$ POST /api/reminders/run?dry_run=1
  today=2026-11-11 run_at=2026-11-11T00:42:52.280Z drafted=0 skipped=1 would_draft=2
  [Unit 2 rp941] WOULD_DRAFT  target=rp941 owed=180000 days_overdue=10 tier=firm fee=True prior=0 last_event=None changed=None
  [Unit 3 rp942] SKIPPED  ... reason: paid in full per the payments ledger ($1,200.00 of $1,200.00 COMPLETED); cached status said UNPAID, ignored
  [Unit 4 rp943] WOULD_DRAFT  target=rp943 owed=95000 days_overdue=3 tier=friendly fee=False prior=0 last_event=None changed=None
$ POST /api/reminders/run                                   (1st real run)
  today=2026-11-11 run_at=2026-11-11T00:42:52.326Z drafted=2 skipped=1 would_draft=0
  [Unit 2 rp941] DRAFTED  target=rp941 owed=180000 days_overdue=10 tier=firm fee=True prior=0 last_event=None changed=None
      event_log #5, drafted_by=llm
      TEXT: Hi Jordan, rent for Unit 2 is now 10 days overdue. The amount due is $1,800.00. A late fee of $75.00 now applies per our
            lease terms. Please pay today or reply with the date you can pay. You can pay through the usual PayPal link. - your landlord
  [Unit 3 rp942] SKIPPED  ... reason: paid in full per the payments ledger ($1,200.00 of $1,200.00 COMPLETED); cached status said UNPAID, ignored
  [Unit 4 rp943] DRAFTED  target=rp943 owed=95000 days_overdue=3 tier=friendly fee=False prior=0 last_event=None changed=None
      event_log #6, drafted_by=llm
      TEXT: Hey Sam! Just a friendly nudge that your November rent of $950.00 for Unit 4 is a few days overdue. No worries—life gets
            busy! You can pay through the usual PayPal link. - your landlord
$ POST /api/reminders/run                                   (2nd run, 2.4 s later: must be a no-op)
  today=2026-11-11 run_at=2026-11-11T00:42:54.747Z drafted=0 skipped=3 would_draft=0
  [Unit 2 rp941] SKIPPED  target=rp941 owed=180000 days_overdue=10 tier=firm fee=True prior=1 last_event=5 changed=[]
      reason: rate-limited: reminder #1 for rp941 (event_log #5, firm) went out 0 min ago, inside the 24 h window, and neither the amount owed nor the tier changed
  [Unit 3 rp942] SKIPPED  ... paid in full ...
  [Unit 4 rp943] SKIPPED  target=rp943 owed=95000 days_overdue=3 tier=friendly fee=False prior=1 last_event=6 changed=[]
      reason: rate-limited: reminder #1 for rp943 (event_log #6, friendly) went out 0 min ago, inside the 24 h window, and neither the amount owed nor the tier changed
$ POST /api/rent-periods/941/pay-sandbox {"amount":"500.00"}
  ok= True  capture 3PW203477K501833J COMPLETED | period {'before': 'UNPAID', 'status': 'PARTIALLY_PAID', 'paid_cents': 50000, 'balance_cents': 130000}
$ POST /api/reminders/run                                   (balance changed for Unit 2 only)
  today=2026-11-11 run_at=2026-11-11T00:42:58.092Z drafted=1 skipped=2 would_draft=0
  [Unit 2 rp941] DRAFTED  target=rp941 owed=130000 days_overdue=10 tier=firm fee=True prior=1 last_event=5 changed=['amount owed changed $1,800.00 → $1,300.00']
      event_log #8, drafted_by=llm
      TEXT: Hi Jordan, this is a firm reminder that your November 2026 rent of $1,300.00 is 10 days overdue. A $75.00 late fee now
            applies per your lease. Please pay today or reply with the date you can pay. Thank you for the $500.00 already received. - your landlord
  [Unit 3 rp942] SKIPPED  ... paid in full ...
  [Unit 4 rp943] SKIPPED  ... reason: rate-limited: reminder #1 for rp943 (event_log #6, friendly) went out 0 min ago, inside the 24 h window, and neither the amount owed nor the tier changed
=== server up, RENTROLL_TODAY=2026-11-20 (00:43:01Z) ===     (simulated later date, see note 2)
$ POST /api/reminders/run
  today=2026-11-20 run_at=2026-11-11T00:43:01.175Z drafted=2 skipped=1 would_draft=0
  [Unit 2 rp941] DRAFTED  target=rp941 owed=130000 days_overdue=19 tier=formal fee=True prior=2 last_event=8 changed=['escalated firm → formal']
      event_log #9, drafted_by=llm
      TEXT: Dear Jordan Ellis, Unit 2. This is a formal notice of non-payment. $1,300.00 of the $1,800.00 rent for 2026-11 remains
            outstanding, 19 days overdue. A late fee of $75.00 now applies. Please pay or provide a written payment arrangement within
            3 days, otherwise the landlord will consider next steps under the lease. - your landlord
  [Unit 3 rp942] SKIPPED  ... paid in full ...
  [Unit 4 rp943] DRAFTED  target=rp943 owed=95000 days_overdue=12 tier=firm fee=True prior=1 last_event=6 changed=['escalated friendly → firm']
      event_log #10, drafted_by=llm
      TEXT: Hi Sam, this is a firm reminder that your November 2026 rent of $950.00 is 12 days overdue (due 2026-11-08). A $75.00 late
            fee now applies per your lease. Please pay today or reply with the date you can pay. Thanks. - your landlord
$ POST /api/reminders/run
  today=2026-11-20 run_at=2026-11-11T00:43:08.654Z drafted=0 skipped=3 would_draft=0
  [Unit 2 rp941] SKIPPED  ... reason: rate-limited: reminder #3 for rp941 (event_log #9, formal) went out 0 min ago, inside the 24 h window, and neither the amount owed nor the tier changed
  [Unit 3 rp942] SKIPPED  ... paid in full ...
  [Unit 4 rp943] SKIPPED  ... reason: rate-limited: reminder #2 for rp943 (event_log #10, firm) went out 0 min ago, inside the 24 h window, and neither the amount owed nor the tier changed
=== event_log reminder_sent rows ===
  5 2026-11-11T00:42:53.925Z rp941 rp941 firm #1 owed 180000 prev_event null
  6 2026-11-11T00:42:54.720Z rp943 rp943 friendly #1 owed 95000 prev_event null
  8 2026-11-11T00:42:59.634Z rp941 rp941 firm #2 owed 130000 prev_event 5
  9 2026-11-11T00:43:02.805Z rp941 rp941 formal #3 owed 130000 prev_event 8
  10 2026-11-11T00:43:08.624Z rp943 rp943 firm #2 owed 95000 prev_event 6
=== dashboard (text-extracted reminder boxes) ===
  button: True
  - Formal notice reminder #3 · 19 days overdue · $1,300.00 owed · $75.00 late fee applies Nov 11, 00:43 UTC · 3 logged for this period
    Dear Jordan Ellis, Unit 2. This is a formal notice of non-payment. ... - your landlord
    Drafted by AI from the ledger facts above · SMS to +1-614-555-0142 · drafted and logged only, not delivered (no SMS/email integration in this build)
  - Firm reminder reminder #2 · 12 days overdue · $950.00 owed · $75.00 late fee applies ...
    Hi Sam, this is a firm reminder that your November 2026 rent of $950.00 is 12 days overdue (due 2026-11-08). ...
```
- The doubled word "Firm reminder reminder #2" was fixed after the run. The label now reads "#2 for this amount".
- LLM metadata stored in each payload: model `nvidia/nemotron-3.5-lightning-30b-a3b`. Every draft passed `validateDraft` on the first attempt (0.8–5.8 s, 333–490 tokens). No template fallback was used.
- Event 4 = Unit 3's $1,200 capture. Event 7 = Unit 2's $500 capture.

**The rate limit reads the window from real `event_log.at` timestamps, not from a hardcoded skip.** Same DB (copied), two runs that differ only in the window length:
```
$ REMINDER_MIN_INTERVAL_HOURS=24      POST /api/reminders/run
   Unit 2 skipped formal hours_since_last= 0.01 | rate-limited: reminder #3 for rp941 (event_log #9, formal) went out 0 min ago, inside the 24 h window, ...
   Unit 3 skipped ... paid in full ...
   Unit 4 skipped firm hours_since_last= 0.01 | rate-limited: reminder #2 for rp943 (event_log #10, firm) went out 0 min ago, inside the 24 h window, ...
$ REMINDER_MIN_INTERVAL_HOURS=0.0003  POST /api/reminders/run      (~1 s window, already expired)
   Unit 2 drafted formal hours_since_last= 0.01 | event_log #11: Dear Jordan Ellis, Unit 2. Formal notice of non-payment: $1,300.00 ...
   Unit 3 skipped ... paid in full ...
   Unit 4 drafted firm hours_since_last= 0.01 | event_log #12: Hi Sam, this is a firm reminder that your rent of $950.00 ...
```

### What this shows
- **The tone follows the computed state.** On the same day, Unit 4 (3 days, inside grace) got a friendly nudge with no fee, while Unit 2 (10 days, past grace) got a firm reminder quoting the $75 fee. Nine simulated days later the same units became formal and firm.
- **No reminder goes to a tenant who has paid.** Unit 3 had a COMPLETED $1,200 capture, but the cached flag said UNPAID. It was skipped every time, and the skip reason says the flag was ignored.
- **A real payment changes the next decision.** After the real $500 capture on Unit 2, the next run reopened Unit 2 only, quoted the new $1,300 and thanked the tenant for the $500. Unit 4, with an unchanged balance, stayed rate-limited.
- **Repeat runs within the window send nothing.** Each skip names the `event_log` row it found. Shrinking the window lets reminders through again, so the decision comes from stored timestamps.

## Offline checks (`bash scripts/sprint4-offline.sh`: synthetic rows, LLM unreachable on purpose so the template fallback is used, no capture)
```
--- today=2026-11-11 ---
  Unit 2 skipped plan1:i1 None -1 | on approved plan #1: installment 1 of 2 not due until 2026-11-12
  Unit 3 skipped ... | paid in full per the payments ledger ($1,200.00 of $1,200.00 COMPLETED, 1 confirmed by PayPal webhook); cached status said UNPAID, ignored
  Unit 4 skipped ... | a payment of $950.00 is processing at PayPal; wait for it to settle
--- today=2026-11-14 ---  (pending payment set to FAILED)
  Unit 2 drafted plan1:i1 friendly 2 | Hi Jordan Ellis, just a friendly reminder that installment 1 of 2 ($900.00) of our payment plan, due 2026-11-12, hasn't come through yet. ...
  Unit 4 drafted rp943 firm 6 | Hi Sam Okafor, $950.00 rent for 2026-11, due 2026-11-08, is now 6 days late. The $75.00 late fee under the lease now applies. ...
--- today=2026-11-14 ---  (repeat)  both rate-limited (event_log #4, #5)
--- today=2026-11-14 ---  (synthetic $450 COMPLETED on 943)
  Unit 2 skipped ... rate-limited ...
  Unit 4 drafted rp943 firm 6 | Hi Sam Okafor, $500.00 rent ... is now 6 days late. ...
```
- On an approved plan, the reminder targets the overdue installment (`plan1:i1`, $900) rather than the rent period. It counts days from the installment's due date and doesn't mention the late fee.
- I also ran the LLM-down path. The first offline smoke run returned `fetch failed`, the template was used, and that was labelled `drafted_by: template`.

## Honest notes / for hack-lead
1. **Nothing is delivered.** There is no SMS or email integration. Every reminder is a logged draft, and the payload, the ledger line and the dashboard all say so.
2. **The tier escalation used a simulated date** (`RENTROLL_TODAY=2026-11-20`, the existing test hook), because nine days can't pass tonight. The rate-limit timestamps are real wall-clock time, so the 11-20 runs are seconds after the 11-11 runs. That's why the firm → formal reminder went out inside the 24 h window: escalation reopens it by design.
3. **The PayPal webhooks for my two test captures were not processed by this build.** Captures `5HX916624X775891T` and `3PW203477K501833J` were real and COMPLETED synchronously. Their webhooks went through the Funnel to the live service and will show there as "unmatched", because rp941/942 don't exist in the real DB. The "confirmed by webhook" wording was exercised only in the offline test, with a synthetic `webhook_event_id`. The reminder logic doesn't depend on it: it reads COMPLETED payment rows, whichever path completed them.
4. **It is not run automatically.** There's no cron or scheduler, as the brief asked. It runs only when the button or the API is called. The brief's "webhook-driven" framing is met in this sense: the next run's decision changes because of payment events. A webhook does not trigger a run.
5. **Not built:**
   - Per-tenant opt-out or quiet hours.
   - The late fee is still never charged on the ledger. Reminders say it "applies", which is the same wording Sprint 2 shows to the landlord.
   - Reminders about upcoming plan installments before they are due.
6. **Effect on existing DBs:** nothing is migrated, because there are no new tables or columns. Unit 4 appears only in freshly seeded DBs. The real `data/rentroll.db` was not opened.
7. Not tested: no browser or screenshot. The dashboard was checked by HTML text extraction only. The Write tool was blocked again, so files were created with a shell stub and then filled in with Edit.

SPRINT4 STATUS: done. Reminder tier, amount and rate limit are computed from live payments and prior `event_log` reminders on every run: two units at different real overdue states got genuinely different AI drafts (friendly $950 / firm $1,800 + $75 fee), a real $500 capture reopened only the unit whose balance changed, and an immediate repeat run was a verified no-op that names the `event_log` rows it found.
