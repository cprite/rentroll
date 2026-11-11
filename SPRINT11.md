# SPRINT 11: the tenant gets their own side of the flow (2026-11-11, ~13:10–13:45 UTC)

**Branch:** `sprint11-tenant-view` (worktree `app-sprint11/`, based on `main` `5c2e982`). Nothing pushed. `app/` and
other worktrees untouched; only `../app/.sprint0-webhook-log.jsonl` was read (read-only) to replay PayPal's signed
capture webhooks into the test DB. No login/password text changed. Moves **Design** (JUDGEPASS #1 weakness: "the landlord
types the tenant's texts and clicks 'Tenant pays' on the tenant's behalf"; "there is no tenant view").

## What changed

- **Token** (`server.js` migrate + seed): `tenant.access_token` = `randomBytes(32).toString('base64url')` (43 chars,
  256 bits), unique index. Seed sets it; `migrate()` back-fills every tenant without one (so the live DB's 3 seeded tenants
  get tokens on first start of this build). Accepted only if it matches `^[A-Za-z0-9_-]{43}$`, then exact DB lookup.
- **`GET /t/:token`** (`lib/tenant-page.js`, new, render only): phone-first, single column, max-width 440px, 52px
  full-width buttons, 17px inputs (no iOS zoom), no tables. Same colour tokens as the dashboard. Shows, for the tenant's
  current rent period(s) only:
  - balance owed (big), status, paid so far, due date + days late, PayPal invoice number (link to PayPal's payer view);
  - late-fee note from `ledgerSnapshot()` ("could apply since …, NOT added to your balance; your landlord decides");
  - the plan: status in tenant words ("Waiting for your landlord to approve" / "Approved" / "completed" / "declined"),
    the ledger box the AI was given (now labelled with the time it was read), installments, "✓ adds up to what you owe",
    and the AI's reasoning;
  - if approved: a 🔒 locked next-installment card and a "Pay $X with PayPal (card)" button; otherwise an amount field
    (default = balance);
  - a message box ("Need more time? Tell your landlord"), the tenant's own message history, their payments with PayPal
    ref and webhook-confirmed state.
- **`POST /t/:token/messages`**: calls the same `handleTenantMessage()` as the landlord route, channel `app`, scoped to the
  token's own rent period. Ledger line reads `Jordan Ellis (own tenant link): "…"`. Max 5 per tenant per 10 min
  (`RENTROLL_TENANT_MSG_LIMIT`) → 429, because each one is an LLM call on an unauthenticated route.
- **`POST /t/:token/pay-sandbox`**: calls the same `payRentPeriodSandbox()` (approved plan ⇒ exact next installment, else up
  to the balance). New `via` option: the ledger line ends "from their own tenant link", payload `via: "tenant_link"`.
  Both POSTs take the page's form (303 back to the page with a flash) or JSON.
- **Scoping:** an optional `rent_period_id` must be one of this tenant's current periods; anything else is the same 404.
- **No landlord actions** on the page: only two form actions exist, `/t/<token>/messages` and `/t/<token>/pay-sandbox`.
- **Auth** (`lib/auth.js`): exempts exactly `GET|HEAD /t/<one segment>` and `POST /t/<one segment>/(messages|pay-sandbox)`.
  Everything else (incl. `/t/<token>/anything-else`, approve/reject, reminders, `/api/*`) still needs Basic Auth.
  The token check runs before body parsing, so a bad token is always the same `404 Not found.` (text/plain).
- **Headers on /t/**: `Cache-Control: no-store`, `Referrer-Policy: no-referrer` (+ meta tag; the PayPal link is
  `rel=noreferrer`), so the token can't leak in a Referer), `X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY`.
- **Dashboard**: under each tenant's name, "Tenant's page ↗" and a "Copy tenant link" button (copies
  `location.origin + /t/<token>`, falls back to a prompt if clipboard is blocked).
- **Not exposed elsewhere:** `getPeriod()` never selects the token, so `/api/rent-periods`, court packet, event log etc.
  don't carry it (checked below). The dashboard (behind Basic Auth) is the only place it appears.
- **Test:** `scripts/sprint11-test.sh` + `scripts/sprint11-text.py` (prints visible text of page sections).

## The real test (`./scripts/sprint11-test.sh`, 13:33–13:36 UTC)

Throwaway DB `$TMPDIR/s11real/test.db` (rent_period ids +1000 via `scripts/sprint10-testdb.mjs`), port 8812, real
NVIDIA LLM, real PayPal sandbox (Orders + Invoicing). Every tenant step is a plain HTTP request **with no login**, posting
the same fields the page's own form posts; landlord steps use a random local-only Basic Auth login for this server.
Token printed as its first 6 chars only.

```
=== 0. server up 13:33:27Z on a throwaway DB; startup invoices: 3/3 created + sent ===
  tenant of rent_period 1001: token voPNQq… (43 chars, base64url of 32 random bytes); tokens distinct across tenants: 3/3
=== 1. tenant opens their link ===
  GET /t/voPNQq… (no login): HTTP 200, 7346 bytes
  [balance] Unit 2 · November 2026 rent · you owe $1,800.00 UNPAID Rent $1,800.00 Paid so far $0.00 Due date Sun, Nov 1 · 10 days ago PayPal invoice RR202611U1P1001-C5T796 Your lease has a $75.00 late fee after a 5-day grace period. It could apply since Sat, Nov 7, but it has not been added to your balance; your landlord decides.
  [plan] (absent)
  [pay] Pay Amount (up to $1,800.00) Pay with PayPal (card)
=== 2. tenant sends their own message from the page (real LLM call) ===
  body: "Hey, I got paid late this month. I can do 600 today and the rest on the 20th, is that ok?"
  POST /t/voPNQq…/messages (form, no login): first response → final HTTP 200
  [flash] Sent. The AI drafted a payment plan from your real balance; your landlord will approve or decline it.
  [plan] Payment plan Waiting for your landlord to approve Read from your payment record first: rent $1,800.00 − paid $0.00 (0 PayPal payments) = $1,800.00 owed . The AI had to fit the plan to that number, not to the figures in your message. 1 Due Wed, Nov 11 Partial payment today $600.00 2 Due Fri, Nov 20 Remaining balance $1,200.00 ✓ adds up to what you owe: $1,800.00 How the AI read your message: Tenant proposed $600 now and the balance on the 20th. The ledger shows full outstanding balance of $1800.00 with 10 days past due (late fee of $75 applicable but not yet charged). Adjusted the second installment to $1200 so the two payments sum exactly to the $1800 outstanding balance. Nothing is locked in until your landlord approves it. You can still send another message.
  [pay] Pay Amount (up to $1,800.00) Pay with PayPal (card) Your plan is not approved yet, so any amount up to your balance is accepted for now.
  [messages] Your messages Hey, I got paid late this month. I can do 600 today and the rest on the 20th, is that ok? Nov 11, 13:33 UTC · from this page
  landlord API sees plan 1 proposed [('2026-11-11', 60000), ('2026-11-20', 120000)] | errors [] | llm nvidia/nemotron-3.5-lightning-30b-a3b
  ledger: tenant Jordan Ellis (own tenant link): "Hey, I got paid late this month. I can do 600 today and the rest on the 20th, is that ok?"
=== 3. landlord approves plan #1 (Basic-Auth route, same test DB) ===
  without login: POST /api/plans/1/approve -> HTTP 401
  with landlord login: ok True  | plan approved
  PayPal invoice sync: True RR202611U1P1001-C5T796 after {"status": "SENT", "allow_partial_payment": true, "minimum_amount_due_cents": 60000, "due_date": "2026-11-11", "paid_cents": 0, "due_cents": 180000}
=== 4. tenant reloads: plan approved, next installment locked ===
  GET /t/voPNQq… (no login): HTTP 200, 8854 bytes
  [plan] Payment plan Approved by your landlord Read from your payment record first: rent $1,800.00 − paid $0.00 (0 PayPal payments) = $1,800.00 owed . The AI had to fit the plan to that number, not to the figures in your message. 1 Next · due Wed, Nov 11 installment 1 of 2 $600.00 2 Upcoming Fri, Nov 20 installment 2 of 2 $1,200.00 How the AI read your message: Tenant proposed $600 now and the balance on the 20th. The ledger shows full outstanding balance of $1800.00 with 10 days past due (late fee of $75 applicable but not yet charged). Adjusted the second installment to $1200 so the two payments sum exactly to the $1800 outstanding balance.
  [pay] Pay your next installment 🔒 Installment 1 of 2 due Wed, Nov 11 $600.00 Pay $600.00 with PayPal (card) Your approved plan fixes this amount. RentRoll refuses any other amount before PayPal is called.
  wrong amount from the tenant route (JSON, no login): {"ok":false,"error":"approved plan #1 only accepts installment 1 of 2: exactly $600.00 (due 2026-11-11). $1,800.00 refused"}
=== 5.1 tenant taps Pay (locked amount from the page: $600.00) -> real PayPal sandbox capture ===
  POST /t/voPNQq…/pay-sandbox (form, no login): first response → final HTTP 200
  [flash] Thank you. $600.00 paid through PayPal (ref 93L9409256592342U). Still owed: $1,200.00.
  [pay] Pay your next installment 🔒 Installment 2 of 2 due Fri, Nov 20 $1,200.00 Pay $1,200.00 with PayPal (card) Your approved plan fixes this amount. RentRoll refuses any other amount before PayPal is called.
=== 5.2 tenant taps Pay (locked amount from the page: $1200.00) -> real PayPal sandbox capture ===
  POST /t/voPNQq…/pay-sandbox (form, no login): first response → final HTTP 200
  [flash] Thank you. $1,200.00 paid through PayPal (ref 59J14949K3726684B). You are paid in full.
  [pay] Pay ✓ Paid in full. Nothing more to pay for November 2026.
=== 6. landlord-side check of the same rent period (Basic Auth API) ===
  rent_period 1001: PAID paid 180000 balance 0 | invoice RR202611U1P1001-C5T796 MARKED_AS_PAID
   payment 1 COMPLETED 60000 plan 1 inst 1 order 434741177L638201P capture 93L9409256592342U on invoice EXTR-4NB47825KP619863S
   payment 2 COMPLETED 120000 plan 1 inst 2 order 97F28191RL8816422 capture 59J14949K3726684B on invoice EXTR-4UE748500H712264V
  ledger: payment tenant Jordan Ellis paid $600.00 by card through PayPal (plan #1, installment 1 of 2) (capture 93L9409256592342U, COMPLETED) from their own tenant link. Balance now $1,200.00
  ledger: invoice_payment_recorded system Recorded $600.00 (capture 93L9409256592342U) on PayPal invoice RR202611U1P1001-C5T796 as payment EXTR-4NB47825KP619863S. Read back from PayPal: PARTIALLY_PAID, $600.00 paid, $1,200.00 due
  ledger: plan_completed system Payment plan #1 completed: every installment paid through PayPal
  ledger: payment tenant Jordan Ellis paid $1,200.00 by card through PayPal (plan #1, installment 2 of 2) (capture 59J14949K3726684B, COMPLETED) from their own tenant link. Balance now $0.00
  ledger: invoice_payment_recorded system Recorded $1,200.00 (capture 59J14949K3726684B) on PayPal invoice RR202611U1P1001-C5T796 as payment EXTR-4UE748500H712264V. Read back from PayPal: MARKED_AS_PAID, $1,800.00 paid, $0.00 due
=== 7. webhooks: wait up to 150 s for PayPal to deliver the capture webhooks to the live service, replay into the test DB ===
   PAYMENT.CAPTURE.COMPLETED WH-8VM34818CP415235X-9J298109Y4753990V -> payment_confirmed sig SUCCESS
   PAYMENT.CAPTURE.COMPLETED WH-3SX69292R6941313E-4A742339NJ311324G -> payment_confirmed sig SUCCESS
=== 8. tenant reloads: final paid state ===
  GET /t/voPNQq… (no login): HTTP 200, 7946 bytes
  [balance] Unit 2 · November 2026 rent · you owe $0.00 PAID Rent $1,800.00 Paid so far $1,800.00 Due date Sun, Nov 1 PayPal invoice RR202611U1P1001-C5T796
  [plan] Payment plan Plan completed Read from your payment record first: rent $1,800.00 − paid $0.00 (0 PayPal payments) = $1,800.00 owed . The AI had to fit the plan to that number, not to the figures in your message. ✓ Paid was due Wed, Nov 11 $600.00 ✓ Paid was due Fri, Nov 20 $1,200.00 How the AI read your message: Tenant proposed $600 now and the balance on the 20th. The ledger shows full outstanding balance of $1800.00 with 10 days past due (late fee of $75 applicable but not yet charged). Adjusted the second installment to $1200 so the two payments sum exactly to the $1800 outstanding balance.
  [pay] Pay ✓ Paid in full. Nothing more to pay for November 2026.
  [payments] Your payments $600.00 · Wed, Nov 11 · installment 1 ✓ confirmed by PayPal webhook · PayPal ref 93L9409256592342U $1,200.00 · Wed, Nov 11 · installment 2 ✓ confirmed by PayPal webhook · PayPal ref 59J14949K3726684B
  [messages] Your messages Hey, I got paid late this month. I can do 600 today and the rest on the 20th, is that ok? Nov 11, 13:33 UTC · from this page
=== 9. security checks ===
  GET /t/<valid token with last char changed>: HTTP 404
  GET /t/1001: HTTP 404 body: Not found.
  GET /t/ (no token): HTTP 401
  POST /t/<bad>/messages: HTTP 404
  POST /t/<bad>/pay-sandbox: HTTP 404
  POST /t/<tenant 1001 token>/messages for rent_period 1002 (another tenant's): HTTP 404
  POST /t/<tenant 1001 token>/pay-sandbox for rent_period 1002: HTTP 404
  GET /t/<token>/anything-else (not exempt): HTTP 401
  GET / without login: HTTP 401
  GET /api/rent-periods without login: HTTP 401
  GET /api/event-log without login: HTTP 401
  POST /reminders/run without login: HTTP 401
  landlord-only actions in the tenant page HTML (/plans/ approve|reject, /reminders, court-packet, /api/, Approve plan, Send reminders): 0
  form actions on the tenant page: action="/t/<token>/messages" action="/t/<token>/pay-sandbox" 
  other tenant's name/token in this tenant's page: 0
  tokens in landlord API /api/rent-periods: 0
  tokens in landlord API /api/event-log: 0
  tokens in landlord API /api/rent-periods/1001/plans: 0
  tokens in landlord API /api/rent-periods/1001/court-packet.json: 0
  tokens in landlord API /api/reminders: 0
  landlord dashboard: 4 'Copy tenant link' buttons; 3 distinct /t/<token> paths
  header: Cache-Control: no-store
  header: Referrer-Policy: no-referrer
  header: X-Robots-Tag: noindex, nofollow
  header: X-Frame-Options: DENY
files in /tmp/claude-1000/s11real
```

Notes on the transcript:
- "first response → final HTTP 200": the `%{redirect_url}` field is blank because curl ran with `-L` (it followed the 303
  back to the page). The 200 is the reloaded tenant page; the flash text shown under it is from that page. Cosmetic.
- "4 'Copy tenant link' buttons": 3 buttons + the same string inside the copy script. 3 distinct `/t/<token>` paths = 3 tenants.
- `GET /t/` (no token) gives 401 (Basic Auth), not 404: it isn't a tenant route. No token info either way.
- Step 8's plan box said "Read from your payment record first: … paid $0.00 … = $1,800.00 owed" on the completed plan.
  That's the ledger at proposal time, but nothing on the page said so. Fixed after the run (`8df7ce6`): it now says
  "Read from your payment record when the AI drafted this plan (Nov 11, 13:33 UTC): …". Re-checked by rendering the same
  test DB (copy) with invoicing off. The full test was not re-run for this label change.
- The LLM adjusted the tenant's "600 today and the rest on the 20th" into $600 + $1,200 (sum = ledger balance) and noted
  the $75 late fee as applicable but not charged.

## Honest limits

1. **Not looked at on a real phone or in a browser.** Headless Chromium can't start in this sandbox (same as Sprint 10), so
   the narrow-viewport layout is checked by reading the CSS/HTML only, not with a screenshot. Worth one look on an iPhone
   via the Funnel URL before recording.
2. **The tenant still pays with PayPal's sandbox test card via Orders** (hard-coded in `payRentPeriodSandbox`). Now the
   tenant presses the button, not the landlord, but it isn't a PayPal Checkout/JS SDK button where the tenant enters a card
   or logs in. JUDGEPASS's Tech "best fix" (real Checkout/Venmo) is still open.
3. **Token = bearer link.** Anyone with the URL is that tenant. There's no rotation/revoke endpoint (rotate by setting
   `access_token` to NULL and restarting: migrate gives a new one). No expiry. Fine for a demo with fake tenants.
4. **Rate limit only on messages** (5 per 10 min per tenant). Pay is not limited beyond the existing ledger rules.
5. **Reminders still say "pay through the usual PayPal link"** and aren't delivered. They could now include the tenant link.
   Not done (out of scope).
6. **Deploying:** first start of this build against the real DB adds `tenant.access_token` and gives the 3 live tenants
   tokens. The landlord dashboard then shows the links. The old "Tenant texted"/"Tenant pays" landlord controls are unchanged.
7. Webhooks were replayed from the live log (same method as Sprints 3–10), not received live by this build.

SPRINT11 STATUS: done — a tenant with only their `/t/<token>` link sent their own message (real LLM plan $600 + $1,200), the landlord approved it through the Basic-Auth route, and the tenant paid both locked installments from their page (real sandbox captures 93L9409256592342U + 59J14949K3726684B, recorded on the PayPal invoice, webhooks verified), after which the page showed PAID and the plan completed; wrong/foreign tokens get a plain 404 and the page has no landlord actions.
