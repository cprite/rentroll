# JUDGEPASS: RentRoll, scored as a PayPal AI Hackathon judge (2026-11-11)

Sources used: `RULES.md` (Devpost rules, snapshot 2026-11-09), `app/README.md`, `app/SUBMISSION.md`, `app/LICENSE`, `app/package.json`, `app/server.js`, `app/lib/{plan-ai,paypal}.js` (read in full), `app/lib/{reminders,court-packet,auth}.js` (grep only), `app/SPRINT2.md` (grep only: the README cites it for the with/without-ledger test), `app/samples/court-packet-example.txt` (text of `court-packet-example.pdf`), `deliverables/video/script-lines.json`, `app/.git/config`.
Not read: PLAN/BRIEF/SCORECARD/STATE/gates/HANDOFF/MORNING, `.workers/`, `research/`, `competitors/`.

**What I could not observe:**
- **Hosted demo: not reached.** The fetch tool rejected all three URLs with the embedded login (`/`, `/healthz`, `/api/rent-periods/1/court-packet.pdf`) with `Invalid URL` before sending any request. This sandbox also can't reach the Funnel URL. So I have no HTTP status, no live page and no live PDF. Everything about the UI below comes from the HTML that `renderDashboard()` in `server.js` produces, not from the running site.
- **Video footage: not watched.** I judged Presentation from the narration script only, so that score is low-confidence. I couldn't measure the length of the mp4.
- **Interactive flows: not run.** I did not submit forms, trigger payments or generate plans. Statements about payments and webhooks come from the code and the team's recorded sample output, not from my own run.
- **Repo visibility:** I couldn't check what is committed (no git access) or whether the GitHub repo is public.

---

## Stage One (pass/fail)

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Meaningfully uses PayPal | **PASS** | `POST /v2/checkout/orders` with `intent: CAPTURE` and a card `payment_source`, plus a `PayPal-Request-Id` idempotency key (`server.js:304-313`). Webhook signatures are checked through `/v1/notifications/verify-webhook-signature`, using the raw request bytes (`server.js:561-572`). Forged webhooks are rejected by default (`WEBHOOK_VERIFY='enforce'`, `server.js:42,581`). `PAYMENT.CAPTURE.COMPLETED` and `DENIED` events update the ledger. The sample packet shows real sandbox order and capture ids with `verification: SUCCESS`. |
| 2 | Meaningfully incorporates AI | **PASS** | Nemotron via NVIDIA NIM (`lib/plan-ai.js:99-122`) turns tenant text into a payment plan. The prompt is grounded in a computed ledger snapshot, and the output is validated on the server (`validatePlan`, line 149). The AI also drafts reminders, which are validated and fall back to a template when they fail (`lib/reminders.js:121-141`). The AI does real work in the product. |
| 3 | Fits the theme ("Build what's next with PayPal and AI") | **PASS** | The AI output becomes a constraint on which PayPal payments the server will create. PayPal and AI are both central. |
| 4 | Judges can run it | **PASS** | README has the Node 24 requirement, the full env var list, `npm install && ./start.sh`, seeding, reset and webhook registration. ../SUBMISSION.md has a 6-step judge walkthrough and the demo login. **hack-lead verified externally, after this worker's report**: `https://nikopi5.tail4aaac7.ts.net/` returns 401 without credentials and 200 with the published `judge`/`8c8r45j5md` login; `/healthz` is open. The worker's "unverified" was its own sandbox's network limitation (it cannot reach the public internet from its read-only execution context), not a real problem with the hosted demo. |
| 5 | Public repo with an open-source license | **FAIL (pending owner step)** | `app/LICENSE` is the standard MIT text at the repo root, so GitHub should detect it. The remote is `github.com/cprite/rentroll`. **The repo is currently PRIVATE. Devpost requires it to be public, with the license visible in the About section.** This is not a code problem. **hack-lead verified after this worker's report**: `git ls-files` (48 files) and a grep for secret-like patterns across tracked content show no `.env*`, `data/`, webhook-log, API key, or credential ever committed — safe to make public. |
| 6 | Public YouTube video under 3 minutes | **FAIL (pending owner step)** | Not on YouTube yet. The script is about 225 words, roughly 1.5 to 1.8 minutes of narration, so it is very likely under 3:00. **hack-lead verified after this worker's report**: the actual rendered video is 114.6s (1:55), confirmed via `ffprobe`. The rules ban third-party trademarks without permission; the narration names Avail, TurboTenant, Zelle and Venmo as plain descriptive mentions (no logos/screenshots), which should be fine. |

---

## Stage Two

### 1. Technological Implementation: **7 / 10**
This is a real implementation, not a thin wrapper around a chatbot. The best part is how the work is divided between code and model:
- `ledgerSnapshot()` computes the balance from COMPLETED payments;
- the LLM gets that balance as "AUTHORITATIVE LEDGER STATE", and the tenant's text is marked as untrusted (`plan-ai.js:85`);
- `validatePlan()` rejects wrong sums, non-integer cents, past dates and out-of-order dates;
- JSON parsing of the reply is defensive, with one retry;
- `approvePlan()` re-checks the plan against the ledger at approval time, so stale plans are refused (`server.js:406-411`);
- after approval, a payment is accepted only for the exact next installment amount (`server.js:286`).

The payment and ledger handling is also stronger than usual for a hackathon:
- the payment attempt is recorded locally as PENDING before PayPal is called, so a webhook that arrives first still matches it;
- a completed payment is never downgraded;
- webhooks are processed once per event id;
- database triggers block UPDATE, DELETE and REPLACE on `event_log`;
- the server refuses any PayPal API base that is not the sandbox.

SPRINT2.md records a control test: with the ledger the model proposed $900 + $100; without it, $900 + $900, and the validator rejected that plan. That is good evidence.

What holds the score at 7 is how little of PayPal it uses:
- one server-side create-and-capture call with a **hard-coded sandbox test card** (`server.js:311`), plus webhooks;
- no checkout on the tenant's side (no PayPal JS SDK buttons, no Venmo, no approval redirect);
- the Invoicing integration was dropped after a `403`.

The AI side is one structured-extraction call and one message-drafting call, with thinking turned off. It is solid, but it is not agentic and doesn't use the PayPal Agent Toolkit. There is also no automated test command in `package.json`, only sprint-named scripts.

**Best fix:** add a real PayPal Checkout for the tenant (JS SDK buttons, Venmo eligible) on a pay link for each installment, so the locked installment becomes the order amount the tenant approves. If that doesn't fit before the deadline, say in ../SUBMISSION.md that "Tenant pays" deliberately simulates the tenant with a sandbox card.

### 2. Design: **6 / 10**
The landlord dashboard in the generated HTML is coherent:
- summary tiles: Collected, Outstanding, Paid in full;
- a "Next action" line for each unit that changes with its state;
- a plan card showing the ledger math the AI was given (rent minus paid equals outstanding), the installments, a "✓ matches the ledger balance" check, the AI's reasoning and any validation problems;
- a 🔒 locked-amount pay control after approval;
- reminder cards by tone, a ledger feed, and a court-packet link for each unit.

The sample court packet is well organized. It has a balance summary, PayPal references with fee and net, plan status, a dated ledger, a SHA-256 integrity line and honest disclaimers ("append-only, not tamper-proof", "not legal advice").

It is still a staged landlord console rather than a complete product:
- the landlord types the tenant's texts and clicks "Tenant pays" on the tenant's behalf;
- reminders are never sent;
- there is no way to add a property, unit or tenant (seed data only);
- there is no tenant view;
- the reminder text tells the tenant to "pay through the usual PayPal link", and that link doesn't exist.

**Best fix:** give the tenant their side of the flow. Either add a minimal tenant page (pay link plus plan status), or at least label the simulated controls ("Simulate: tenant texted / tenant pays") so a judge reads them as demo controls rather than missing product. **hack-lead note:** the dashboard forms already carry a `title` (hover tooltip) attribute saying exactly this ("Simulates the tenant paying by card...", "Simulates an incoming tenant text..."), confirmed in the live HTML — but a tooltip isn't as visible as on-screen text, so the suggestion to make it a visible label still stands as a worthwhile small improvement if time allows.

### 3. Potential Impact: **6 / 10**
The audience is specific and real: landlords with 1 to 4 units who collect rent informally over PayPal, Venmo or Zelle and make ad-hoc partial-payment deals. The pain is concrete: checking transactions by hand, deals that live in text threads, and rebuilding the history from screenshots for small claims court. The court packet is the most clearly valuable piece.

The two weaknesses the team states openly add credibility: free bank-transfer (ACH) tools exist, and the PayPal fee is $25.82 on $800, about $54 a month on $1,800 rent. That same fee also limits the impact. It makes RentRoll an expensive choice for the people it targets, and the case for paying about $650 a year is "speed and a paper trail".

What is shown only partly solves the problem as stated:
- payments made over Zelle, Venmo or outside RentRoll are not picked up (only captures the app makes itself, or webhooks carrying its `custom_id`);
- real tenant messages are not received.

So the promise to stop checking payments by hand is not met yet.

**Best fix:** state the impact claim in one line tied to what is demonstrated, for example "every partial-payment deal is enforced and every payment is documented for court". Drop or soften "check by hand every month", because the app doesn't track payments made outside RentRoll.

### 4. Innovation / Idea: **6 / 10**
This is based only on my own general knowledge; I didn't see the team's competitor research. Rent collection for small landlords is crowded (Avail, TurboTenant, RentRedi, Baselane, Zillow Rental Manager), and "the LLM proposes, code validates" is a known pattern. What is new is putting three things in one product:
- an AI-negotiated partial-payment plan grounded in the real payment ledger;
- a plan that, once approved, becomes a hard limit on which payments go through;
- a court-ready record built from PayPal ids and verified webhooks.

I don't know of a mainstream small-landlord tool that enforces informal payment plans this way. The narration's thesis, "A chatbot alone cannot refuse a payment. Ours does.", frames it sharply. Overall it is a clever new angle on a familiar category, not a new category.

**Best fix:** open the pitch with "the AI's plan becomes an enforced payment rule", since that is what differs from existing tools. Show the control test on screen ($900 + $900 without the ledger, refused by the validator).

### 5. Presentation: **6 / 10 (as scored by the worker, against the ORIGINAL script)**
The script follows the organisers' advice ("Open with the problem and who it's for, then show PayPal and AI working end to end"). It runs: problem, dashboard, plan, enforcement, payment with webhook, reminders, court packet, honest trade-off, thesis, close. It names PayPal and AI throughout and comes in well under 3 minutes (confirmed: 1:55). README and ../SUBMISSION.md are clear, concrete and honest about limits.

The worker found 3 real wording problems in the narration:
- **Line 04 contradicted itself:** "that plan becomes a rule **PayPal itself enforces**... **before PayPal is even called**" — the two halves disagree, and the README says RentRoll's own server enforces the plan because Invoicing was unavailable.
- **Line 03 overstated what the AI reads:** "the AI reads the real PayPal balance first" — the code actually computes the balance from RentRoll's own record of PayPal payments and hands that to the AI; nothing reads a PayPal balance directly.
- **Line 01 didn't match the README:** "one or two units" vs. the README's "one to four".

**FIXED by hack-lead after this report, before any submission:** all three lines rewritten, their audio re-synthesized (same `nikosha-en` voice), subtitles regenerated, and a title card with the same imprecise phrasing ("reads the real PayPal ledger first") also corrected to "reads the real payment ledger first" for consistency. The video was fully rebuilt: still 1920x1080, still 1:55 (114.6s), same footage and structure, only the 3 narration lines + 1 card changed. Re-QA'd via a contact sheet — corrected wording confirmed on screen. **This fix is not yet re-scored by an independent pass**; treat the Presentation score as likely improved but not re-verified.

---

## Total: **31 / 50** (as scored against the pre-fix video; see Presentation note above for what changed since)
(Tech 7 · Design 6 · Impact 6 · Innovation 6 · Presentation 6)

This is a well-built, honest submission. Its core idea, an AI plan that becomes an enforced payment rule, is real and well proven in the code. Two things cap the score: it uses only a small part of PayPal (no checkout for the tenant, a hard-coded test card), and in the demo the landlord plays the tenant. The Stage One items must be fixed. The script fix was cheap and has already been applied.

## Top 3 things to fix before submitting (ranked by impact) — STATUS as of hack-lead's follow-up
1. **Clear the Stage One blockers (owner steps) — STILL PENDING, Nikolay's gate.**
   - Make `github.com/cprite/rentroll` public — **hack-lead confirmed via `git ls-files` + a secret-pattern grep that nothing sensitive is tracked, safe to do.**
   - Upload the video to YouTube as Public early, since processing can take hours.
   - The deadline is **Nov 12, 2026, 12:00 PT (20:00 UTC)**.
2. **Test the hosted demo from outside this network — DONE by hack-lead.** `https://nikopi5.tail4aaac7.ts.net/` confirmed: 401 without the login, 200 with `judge`/`8c8r45j5md`, `/healthz` open. The worker's inability to reach it was its own sandbox's network limitation, not a real outage.
3. **Fix the video's wrong claims — DONE by hack-lead**, video rebuilt and re-delivered to `deliverables/video/rentroll-demo.mp4` (1:55). Not yet independently re-scored.

(Next most valuable if time allows: a real PayPal Checkout/Venmo pay link for tenants, or at least a visible on-screen "Simulate tenant" label on the dashboard controls, beyond the existing hover tooltips.)
