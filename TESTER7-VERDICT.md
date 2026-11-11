# TESTER7 VERDICT: Sprint 11 (tenant's own `/t/:token` page)

Independent tester, 2026-11-11, ~14:10–14:45 UTC. Branch `sprint11-tenant-view` @ `7be2b64`, worktree `app-sprint11/`.
No product code edited, nothing pushed, `../app/` and `rentroll.service` untouched.

**Setup.** I wrote my own harness in `$TMPDIR/t7/`. It does not use `scripts/sprint11-test.sh`. It seeds a fresh throwaway DB
(`$TMPDIR/t7/run/test.db`) using a copy of `sprint10-testdb.mjs` that offsets rent_period ids by **+7000** (7001–7003), so
these runs don't collide with the builder's 1001–1003. Port 8813, random local-only Basic Auth login, real NVIDIA LLM, real
PayPal sandbox (Orders + Invoicing). Startup created and sent 3/3 invoices. Tokens are 43 chars, `^[A-Za-z0-9_-]{43}$`, and distinct
across the 3 tenants (`randomBytes(32).toString('base64url')`, `server.js:205`). Output below shows tokens as `<TOKEN_A/B/C>`.
I did 3 runs: (a) the full flow; (b) security; (c) populate, regression, token grep and rate limit, plus an XSS/wording pass on a
checkpointed copy of (c).

## 1. Real tenant flow, end to end: PASS

None of the tenant steps sent an `Authorization` header.

    --- 1a  GET /t/<TOKEN_A>: HTTP 200 7346B
      [balance] Unit 2 · November 2026 rent · you owe $1,800.00 UNPAID ... PayPal invoice RR202611U1P7001-C7D7YP
                ... $75.00 late fee ... could apply since Sat, Nov 7, but it has not been added to your balance
    --- 1b  POST /t/<TOKEN_A>/messages (form) body="Hi, my hours got cut. Could I pay 500 now, 700 on the 18th and whatever is left on the 28th?"
      HTTP 303 -> Location: /t/<TOKEN_A>?ok=Sent. The AI drafted a payment plan from your real balance; ...
      [plan] Waiting for your landlord to approve ... rent $1,800.00 − paid $0.00 = $1,800.00 owed ...
             1 Due Wed, Nov 11 $500.00  2 Due Wed, Nov 18 $700.00  3 Due Sat, Nov 28 $600.00  ✓ adds up to what you owe: $1,800.00
      landlord API plan 1 proposed [('2026-11-11', 50000), ('2026-11-18', 70000), ('2026-11-28', 60000)] sum 180000 errors [] snap outstanding 180000
      other tenant rp 7002 plans: 0 / rp 7003 plans: 0          <- plan scoped to A's period only
      ledger message_in tenant Jordan Ellis (own tenant link): "Hi, my hours got cut. ..."
    --- 1c  POST /api/plans/1/approve  no auth: 401 | landlord auth: ok True approved, invoice sync True
      tenant reload: [plan] Approved by your landlord ... [pay] 🔒 Installment 1 of 3 due Wed, Nov 11 $500.00  Pay $500.00 with PayPal (card)
      wrong amount (JSON, tenant route) $1.00 / $5,000.00 -> {"ok":false,"error":"approved plan #1 only accepts installment 1 of 3: exactly $500.00 ..."}
    --- 1d  POST /t/<TOKEN_A>/pay-sandbox amount=<locked amount read from the page>
      1: 303 ?ok=Thank you. $500.00 paid through PayPal (ref 1VK031745T4152430). Still owed: $1,300.00.
      2: 303 ?ok=Thank you. $700.00 paid through PayPal (ref 6GG272517W230922J). Still owed: $600.00.
      3: 303 ?ok=Thank you. $600.00 paid through PayPal (ref 5FL87001TU0899744). You are paid in full.
    --- 1e  [balance] you owe $0.00 PAID ... Paid so far $1,800.00   [plan] Plan completed ✓ Paid ×3   [pay] ✓ Paid in full.
      rp 7001 PAID paid 180000 bal 0 MARKED_AS_PAID ; 3 payments COMPLETED inst 1/2/3 with the captures above
      rp 7002 / 7003 untouched (UNPAID, SENT)
      ledger payment ... (capture ..., COMPLETED) from their own tenant link. Balance now $0.00

I didn't replay webhooks into my test DB, so my payments read "received by PayPal, webhook confirmation pending", which is
accurate. I did not check the "✓ confirmed by PayPal webhook" state myself.

## 2. Security: PASS

**2a. Bad tokens give a clean 404.** Each case returns 404 with body `Not found.\n` (11 bytes, text/plain):
- the last character changed, a middle character changed, the case flipped;
- `hello`, `7002`, `<TOKEN_A>7002`, a 42-char prefix, `<TOKEN_A>x`;
- a random 43-char base64url string, `%00`, `..%2Fapi%2Frent-periods`, `<TOKEN_A>%2F7002`.

A bad token on POST also gets 404, even with invalid JSON in the body, because the token check runs before body parsing.
`GET /t/<TOKEN_A>?rent_period_id=7002` returns A's own page (the query is ignored) and no other tenant's name.
**Note:** `GET /t/<TOKEN_A>/7002` (a path segment appended) returns **401**, not 404. That shape isn't an exempt route, so Basic Auth
answers before any token lookup. The 401 doesn't depend on whether the token is valid, so it reveals nothing. This is documented in
SPRINT11.md and is acceptable.

**2b. Cross-tenant POSTs are refused with 404.**
- Messages: A to 7002 (form), A to 7003 (JSON).
- Payments: A to 7002 (form), A to 7003 (`amount_cents`), A to `[7002]` (JSON array), A to `"7002 "`, B to 7001.

DB row counts were the same before and after: `{"m":0,"p":0,"pl":0}`. Nothing was created on anyone's rent.

**2c. No landlord action is reachable through the token.** Every request below got 401 on both POST and GET, using `--path-as-is`:
- `/t/<A>/approve`, `/t/<A>/plans/1/approve`, `/t/<A>/reminders/run`, `/t/<A>/court-packet.json`, `/t/<A>/api/rent-periods`
- `/t/<A>/messages/../../../api/plans/1/approve`, `/t/<A>/../../api/rent-periods`, `/T/<A>/../../api/rent-periods`
- `/t/<A>/messages/x`, `/api/plans/1/reject?t=/t/<A>`, `/rent-periods/7002/messages`, `/plans/1/reject`, `/api/reminders/run`

Other methods and shapes:
- `GET /t/<A>/messages`, `OPTIONS /t/<A>` and `PUT /t/<A>/messages` return 401.
- `HEAD /t/<A>`, `/T/<A>` and `/t/<A>/` return 200 (own page).

Tenant page HTML for A and B:
- 0 hits for `approve plan|/approve|/reject|reminders|court|/api/|/plans/|Tenant texted|Tenant pays|Copy tenant link|/rent-periods/`.
- The only form actions are `/t/<own>/pay-sandbox` and `/t/<own>/messages`.
- 0 other tenants' names or tokens.

**2d. No tokens in gated responses.** I grepped on a populated DB: 12 messages, 12 plans, 2 payments, a reminders run. Every response
below had 0 hits for all 3 tokens, 0 `/t/` strings and 0 `access_token` keys:
- `POST /api/reminders/run`, `/api/rent-periods`, `/api/event-log`
- `/api/rent-periods/7001/plans`, `/api/rent-periods/7002/plans`
- `/api/rent-periods/7001/court-packet.json`, `/api/rent-periods/7002/court-packet.json`
- `/api/reminders`, `/api/rent-periods/7001/invoice`
- `court-packet.pdf` (checked with pdftotext, 759 words)

Also 0 hits in DB rows of event_log/plan/message/payment (0 of 25 rows) and in `server.log`. The gated dashboard is the only place
the tokens appear (3 distinct `/t/<token>` paths).

**2e. Headers.** Present on the `/t/<A>` 200, on the bad-token 404, and on the POST 303:
`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `X-Frame-Options: DENY`.
The page also has `<meta name="referrer" content="no-referrer">`.

**2f. Rate limit.** Tenant C, sequential JSON posts with real LLM calls: messages 1–5 returned `200 True proposed`, and messages 6
and 7 returned **`429`** "You've sent 5 messages in the last 10 minutes...". A form post after the limit returns 303 with an `err`
flash and no LLM call. 5 app messages were stored.
**Burst test:** 8 parallel posts from tenant B gave `5 × 200, 3 × 429`, so the limit holds under concurrency. The message row is
inserted synchronously before the first `await` (`server.js:498–504`).

**XSS.** Message 1 from C was `<script>alert(1)</script><img src=x onerror=alert(2)> ...`. The tenant page has 0 raw copies and
1 escaped copy. The dashboard escapes message bodies with `esc()` (`server.js:1045`). It showed only C's latest message, so the
payload wasn't on the dashboard to see. A reflected `?ok=<script>alert(1)</script>` comes back as `&lt;script&gt;...`, so it's escaped.

## 3. Regression: PASS

    GET / no auth: 401  wrong pw: 401  with auth: 200
    dashboard: Tenant-texted forms: 3, Tenant-pays forms: 3, copy buttons: 3
      copy button -> token A(7001 Jordan) | nearest name before: Jordan Ellis
      copy button -> token B(7002 Priya)  | nearest name before: Priya Nair
      copy button -> token C(7003 Sam)    | nearest name before: Sam Okafor
      each link GET -> 200, page shows the matching unit/balance (Unit 2 $900 / Unit 3 $1,200 / Unit 4 $950)
    Tenant texted (landlord form, 7002, real LLM): 303 /?ok=AI proposed a payment plan. ... -> plan 2 proposed [(2026-12-01, 60000), (2026-12-15, 60000)]
    Tenant pays (landlord form, 7003, $100.00): 303 /?ok=Payment of $100.00 captured through PayPal (capture 6SA4846685924133A). ...
    Unsigned fake webhook (fake paypal-* headers): 400 {"ok":false,"result":"rejected_signature","verification":"ERROR_400"}
    Unsigned fake webhook, no headers:             400 {"ok":false,"result":"rejected_signature","verification":"SKIPPED_NO_HEADERS"}
      rp7003 after fake webhooks: PARTIALLY_PAID paid 10000 (unchanged; payment webhook_event_id still None)

The copy button's clipboard JavaScript wasn't exercised, because I had no browser. I checked the links by their `data-path`.

## 4. Honesty: PASS (one minor wording issue)

- The header badge says "PayPal sandbox". The footer says: "Demo build: payments run in the PayPal sandbox with a test card, so no
  real money moves."
- The button reads "Pay with PayPal (card)" and the result says "paid through PayPal (ref …)". The page never claims a PayPal login,
  Checkout or Venmo flow.
- Webhook state is shown honestly ("received by PayPal, webhook confirmation pending" until confirmed).
- The late fee is described as "NOT added to your balance".
- **Minor (F1):** the AI's reasoning is shown to the tenant word for word, and it can be wrong. My run displayed "Tenant proposed three
  payments totaling 1800 cents ($18.00)", which the tenant never said. The installments themselves were correct and grounded in the
  ledger. Only the prose is confusing, and before this sprint only the landlord saw it.

## Findings (none blocking)

- **F1 (minor, wording):** the LLM's rationale is shown word for word on the tenant page and can contain wrong figures (see 4).
  Possible fixes: hide it on the tenant page, or show only the validated "✓ adds up to" line. **FIXED by hack-lead**: the raw
  reasoning line is no longer rendered on the tenant page (`lib/tenant-page.js`); the landlord dashboard still shows it in full.
- **F2 (minor):** when a tenant over the limit posts the page's form, they get a 303 with an `err` flash, not a 429 status. Only JSON
  clients see the 429. The block is effective either way.
- **F3 (low):** any `?ok=`/`?err=` text shows as a green or red flash on the tenant page. It is escaped, so there's no XSS, but a
  spoofed message is possible. It needs the tenant's own token, and the dashboard already behaves this way.
- **F4 (cosmetic, ledger):** `plan_completed` is logged before the final installment's `payment` line.
- **Not tested by me:** layout on a real phone or browser; the webhook-confirmed "✓" state on the tenant page.

TESTER7 VERDICT: PASS — I ran the full tenant flow (own message, real LLM plan, landlord approval, 3 real sandbox captures, paid)
with no login on the tenant side. Bad, foreign and cross-tenant tokens all got a 404 and nothing was written. No landlord action
was reachable through the token. No token appeared in any gated response. All 4 headers and the 5-per-10-minute limit (429, even
under a parallel burst) work as claimed.
