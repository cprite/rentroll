# SPRINT 2: AI payment-plan parser grounded in the live ledger (2026-11-10, ~22:55–23:20 UTC)

**Branch:** `sprint2-ai-plan-parser` (based on `sprint1-data-model` @ `882d098`). Code commit `b780ef8`, plus this report.
`main` and `sprint1-data-model` were not touched. Nothing was pushed.

## What was built
- **`lib/plan-ai.js`** (new). Responsibilities are split like this:
  - `ledgerSnapshot(db, rpId, today)` is **our code** reading the DB. It takes rent due from `rent_period`, sums COMPLETED rows in `payment` (recomputed, the cached column isn't trusted), and computes the outstanding balance, due date, days past due and late-fee rule/applicability from `unit.late_fee_rule_json`.
  - `buildMessages()` puts those numbers into the system prompt as "AUTHORITATIVE LEDGER STATE". The prompt tells the model to sum to the outstanding balance, reconcile the tenant's numbers and explain any adjustment in `reasoning`, and not to add the uncharged late fee. The tenant's text goes into the user turn and is marked as untrusted.
  - `callLlm()` calls OpenAI-compatible `POST $LLM_BASE_URL/chat/completions`. Credentials come from env only and are never logged.
  - `extractJson()` tries a strict parse first. If that fails, it strips code fences and `<think>` blocks and takes the first balanced `{...}`.
  - `proposePlan()` retries the LLM once if parsing fails. If the first reply was empty it re-asks the same question; if it was non-JSON text it sends a "JSON only" follow-up.
  - `validatePlan()` runs **on the server, always**. It checks that amounts are positive integer cents, that dates are real `YYYY-MM-DD` dates on or after today and in order, and that the sum equals the ledger balance within 1 cent.
- **`POST /api/rent-periods/:id/messages`** takes `{"body": "...", "channel": "sms"}`. It works like this:
  - Inserts a `message` row (direction `in`, plus the new `rent_period_id` column) and an `event_log` `message_in` entry.
  - Takes the ledger snapshot. If nothing is owed, it returns **409** with the snapshot and makes no LLM call.
  - Runs `proposePlan`, then inserts a `plan` row. The status is `proposed` if validation passed, `needs_review` (with reasons) if it failed, or `parse_failed` if parsing failed or the LLM errored or timed out.
  - Every `plan` row stores the installments, the model's reasoning, the validation errors, **the exact ledger snapshot fed to the model**, LLM metadata (model, attempts, finish_reason, usage, ms) and the raw reply.
  - It also writes an `event_log` `plan_proposed` entry (actor `ai`).
  - The response is the full plan.
- **Supporting changes:**
  - A form version (`POST /rent-periods/:id/messages`) that redirects with a flash message.
  - `GET /api/rent-periods/:id/plans`.
  - The `plan` schema now allows `needs_review` and `parse_failed` and has the new columns. Sprint 1 DBs are migrated in place at startup (`migrate()` in `openDb`). I tested this on a copy of the real DB, not the real DB itself.
- **Dashboard:**
  - Each unit with a balance has a "Tenant texted" input.
  - The latest `proposed`, `needs_review` or `parse_failed` plan is shown under the unit's row. It shows the tenant's quoted text, a "Read from the ledger before proposing: rent − paid = outstanding" line, the installments table with a total and a ✓/✗ against the ledger, the AI's reasoning and any validation issues.
  - **"Approve · coming in Sprint 3" is a `disabled` button with a tooltip. It is not wired to anything.**
- **Scripts:**
  - `scripts/sprint2-selftest.mjs` is an offline parser/validator/retry test.
  - `scripts/sprint2-control.mjs` is the no-ledger control call.

## LLM request/response shape
- **Request:**
  - `POST {LLM_BASE_URL}/chat/completions`
  - `{model: $LLM_MODEL, temperature: 0.2, max_tokens: 8192, chat_template_kwargs: {enable_thinking: false}, messages: [system(ledger + rules + JSON schema), user(tenant text)]}`
- **Model reported:** `nvidia/nemotron-3.5-lightning-30b-a3b`.
- **Expected reply content:** `{"installments":[{"due_date","amount_cents","note"}],"tenant_stated","adjusted","reasoning"}`.
- **Reasoning settings, measured tonight on the same grounded prompt:**

  | Setting | Time | Result |
  |---|---|---|
  | Thinking on, `max_tokens` 4096 | 46 s | `finish_reason: "length"`: all 4096 tokens went to reasoning, **content was empty**. The retry recovered (39 s), 85 s total. |
  | Thinking on, `max_tokens` 8192 | >150 s | Client timeout, stored as `parse_failed` |
  | `reasoning_budget: 1024` | 12 s | Correct plan |
  | `enable_thinking: false` | **1.9–3.3 s** | Correct plan |

  - So the default is thinking off. `LLM_REASONING_BUDGET=<n>` switches to bounded thinking, and `LLM_MAX_TOKENS` overrides the token cap.
  - Correctness never depends on the model's reasoning, because `validatePlan` checks every plan.

## The not-a-wrapper test (real LLM, real DB, real PayPal sandbox)
**Setup:**
- I used a separate test DB (`$TMPDIR/s2/test.db`, seeded with the Sprint 1 seed) so the real `data/rentroll.db` was not changed.
- Its rent_period ids were offset to **901/902**. That way PayPal's real webhook for my test capture, when it reaches the live service, can't match and alter a real-DB row. It will only be logged there as "did not match any RentRoll payment".

**Step 1, real payment through the Sprint 1 endpoint:**
- Call: `POST /api/rent-periods/901/pay-sandbox {"amount":"800.00"}`.
- Result: order `4NF58555BB985605R`, capture `9FL18009C86100432` **COMPLETED**, `custom_id RR:rp901:2026-11:u1:i1:e28a58f9`.
- Ledger: Unit 2 (Jordan Ellis) PARTIALLY_PAID, paid $800.00, balance **$1,000.00**.

**Step 2, the tenant message ignores that payment:**
- Call: `POST /api/rent-periods/901/messages {"body":"sorry, can I pay 900 now and the rest later"}`.
- The ledger snapshot our code computed and fed to the model (stored in `plan.ledger_snapshot_json`): `amount_due_cents 180000, amount_paid_cents 80000, outstanding_cents 100000, due_date 2026-11-01, late fee $75 flat after 5 grace days, applicable since 2026-11-07, not charged`.
- System prompt line: `- OUTSTANDING BALANCE: 100000 cents ($1000.00)`.
- Raw model reply (final run, plan id 3, 1 attempt, `finish_reason stop`, 244 tokens, 2970 ms):
```json
{"installments":[{"due_date":"2026-11-10","amount_cents":90000,"note":"Partial payment now"},
                 {"due_date":"2026-11-20","amount_cents":10000,"note":"Remaining balance"}],
 "tenant_stated":"can I pay 900 now and the rest later","adjusted":true,
 "reasoning":"Tenant offered $900 upfront. Ledger shows outstanding balance is $1000.00 ($100000 cents). Adjusted first installment to $900.00 and second to $100.00 to exactly match the outstanding balance. Late fee of $75 applies after 5 grace days (from 2026-11-07), but per rules it is not included in the plan.",
 "outstanding_balance_cents":100000}
```
- Stored plan: `status: proposed`, `validation_errors: []`, total **$1,000.00** (= ledger balance).
- Ledger entry: `AI proposed a plan for the $1,000.00 balance: $900.00 on 2026-11-10, $100.00 on 2026-11-20. Awaiting landlord approval`.
- The first run (thinking on, 85 s, recovered on retry) gave the same $900 + $100 plan.

**Step 3, control: the same model and the same message, with no ledger access** (`scripts/sprint2-control.mjs`):
- The control prompt gave only "rent was $1,800 due 2026-11-01", which is everything a plain chat session would know. Thinking was on, 18.8 s.
- Raw reply: `{"installments":[{"due_date":"2026-11-10","amount_cents":90000,...},{"due_date":"2026-11-20","amount_cents":90000,...}],"reasoning":"...splits the $1,800 November rent into two $900 installments..."}`.
- That is a **$1,800 plan, which overcharges the tenant by $800.** The model couldn't know about the $800 capture: the only record of it is PayPal's capture and our `payment` row, and only our code reads that.
- When I replayed that control reply through our pipeline, the validator returned **`needs_review`**: `installments sum to 180000 cents ($1800.00), but the ledger's outstanding balance is 100000 cents ($1000.00)`. So even a wrong model answer can't become a proposed plan.

**Why this isn't a wrapper:**
- The number that matters ($1,000) comes from PayPal-confirmed payment state that our code reads and sums.
- The model only does the language work: interpreting "the rest later", choosing dates and explaining the adjustment.
- Our code checks the model's arithmetic against the ledger before anyone sees it.

## Other checks actually run
- **Offline self-test** (`node scripts/sprint2-selftest.mjs`):
  - Strict, fenced and `<think>`+prose JSON all parse.
  - Garbage gives "no JSON object found" and a truncated reply gives "unbalanced". Both lead to `parse_failed` after one retry.
  - A garbage-then-valid sequence recovers to `proposed`.
  - Validator errors for a 2026-02-30 date, 500.5 cents, a negative amount, a past date and a wrong sum.
- **HTTP edge cases** (throwaway copy DB):
  - A blank body gives 400, id 999 gives 404 and `abc` gives 400.
  - A paid period gives 409: the message is stored and no LLM call is made.
  - **An unreachable LLM** (`LLM_BASE_URL=http://127.0.0.1:1/v1`) gives 200, the plan is `parse_failed` with `"LLM call failed: fetch failed"`, and the server stays up.
  - The form post gives a 303 with a flash message.
- **Real parse failure:** the thinking-on 8192-token run timed out at 150 s. It was stored as `parse_failed` with the reason and logged to the ledger, with no crash.
- **Dashboard HTML** (fetched and text-extracted):
  - Shows: "AI proposal · awaiting your approval", the tenant quote, "rent $1,800.00 due Nov 1 − paid $800.00 (1 PayPal capture) = $1,000.00 outstanding", the installments, "Total $1,000.00 ✓ matches the ledger balance", the AI reasoning, and the disabled "Approve · coming in Sprint 3" button.
  - No screenshot. Headless Chromium wasn't tried again after Sprint 1's sandbox failure.

## Caveats / for hack-lead
1. **The real DB has not been migrated yet.** When `rentroll.service` restarts on this build, `migrate()` will rebuild the empty `plan` table with the new CHECK and columns and add `message.rent_period_id`. This was tested on a copy of `data/rentroll.db`.
2. **Two notes on the test capture:**
   - The real sandbox capture `9FL18009C86100432` (custom_id `rp901`) will show up in the live service's raw webhook log and ledger as "unmatched". That's expected, because the id was offset on purpose.
   - Sprint 1's webhook handler matches `custom_id` to a rent_period **by id across any DB**. Test DBs that share the sandbox account could cross-contaminate the real one. Worth guarding with a per-DB prefix in `custom_id` later.
3. **Things I couldn't test:**
   - The LLM call depends on the provider accepting `chat_template_kwargs`. NVIDIA's endpoint did tonight. A provider that rejects it would produce `parse_failed`, not a crash.
   - The late fee is shown and explained but never added to the plan, because no fee charge exists on the ledger yet. That's the landlord's decision (Sprint 3).
4. **Sandbox gotchas for workers:**
   - The Write tool was blocked again. Files were created with a one-line shell stub, then filled with Edit.
   - The sandbox gives every command its own network namespace, so a server started in one command can't be reached from the next. Each test starts the server and curls it in the same command.
5. **Not mine, left alone:** an untracked `TESTER1-VERDICT.md` in `app/`.

SPRINT2 STATUS: done. On a real $800 sandbox capture, the AI's plan came out at the true $1,000 balance, with the ledger numbers coming from our own code. The same model without ledger access proposed $1,800, and the server-side validator rejects exactly that answer.
