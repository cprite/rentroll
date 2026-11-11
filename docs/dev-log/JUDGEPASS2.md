
# RentRoll: judge pass 2 (post-revision), 2026-11-11

Scored against `RULES.md` only (Devpost rules, snapshot 2026-11-09). Evidence used: `app/README.md`, `app/SUBMISSION.md`, `app/LICENSE`, `app/server.js`, `app/lib/{invoicing,tenant-page,plan-ai,auth}.js`, `app/package.json`, `app/.gitignore`, `deliverables/video/qa-grid.png`, `deliverables/video/script-lines.json`, `app/samples/court-packet-example.pdf`, and a live fetch of `/healthz`. I did not read PLAN/BRIEF/SCORECARD/STATE/gates/HANDOFF/MORNING, `app/JUDGEPASS.md`, `.workers/`, `research/` or `competitors/`.

Environment limits for this pass:
- No demo login (rotated on purpose, held for Devpost's judges-only field). I judged the logged-in flow from source + contact sheet.
- `/healthz` live check: HTTP 200, body `{"ok":true,"service":"rentroll","db":"rentroll.db"}` (fetched 2026-11-11).
- Video: contact sheet (frames ~8 s apart, last frame 2:33) + narration script only. No audio, pacing or legibility at full size. Confidence on Presentation is **medium-low**.

## Stage One (pass/fail)

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Meaningfully uses PayPal | PASS | Invoicing v2 create/send/GET/PUT/record-payment (`lib/invoicing.js`), Orders capture, webhook signature verification via `/v1/notifications/verify-webhook-signature` (`server.js:802-813`), enforced by default (`server.js:46`, `:822`). |
| 2 | Meaningfully incorporates AI | PASS | Nemotron via NIM turns tenant text into a plan grounded in a computed ledger snapshot, then server-validated (`lib/plan-ai.js:54-87`, `:149-169`); AI-drafted reminders with template fallback. |
| 3 | Fits theme | PASS | PayPal is the billing record and payment rail; AI is the plan/reminder layer. Both are central. |
| 4 | Judges can run it | PASS | Hosted demo is up (healthz 200). README lists every env var, Node 24 requirement, `npm install && ./start.sh`, Invoicing feature prerequisite, webhook registration script (`scripts/sprint0-webhook.mjs` exists), reset command. Small gap: see note A below. |
| 5 | Public repo + visible OSS license | **FAIL (pending human step)** | `LICENSE` is MIT and correct. Repo is currently PRIVATE; Devpost requires public with the license detectable in the About section. Not a code issue, but this is a hard gate. |
| 6 | Public YouTube video < 3 min | **FAIL (pending human step)** | Not uploaded yet. Content: last contact-sheet frame at 2:33 plus a short closing card suggests ~2:35-2:45, so under 3:00. Shows the app working on desktop and on a phone. Narration is an AI clone of the entrant's own voice, disclosed in `../SUBMISSION.md`; RULES allow AI voiceover. |

Note A: the 401 response still says `"Login required. The demo login is listed in the README."` (`lib/auth.js:37`). The README now says the opposite (login is in Devpost's judges-only field). A judge who opens the URL without the Devpost field to hand gets sent to a README that doesn't have it. One-line fix.

## Stage Two

### 1. Technological Implementation: 8/10

The PayPal Invoicing integration carries real weight in the flow. Every rent period gets a real invoice, created as pay-in-full and sent (`createAndSendRentInvoice`, `ensureInvoice` at `server.js:555-573`). On approval, `syncInvoiceTerms` (`server.js:587-620`) GETs the invoice, PUTs `configuration.partial_payment.minimum_amount_due` = the next installment plus the installment due date and a schedule note, then GETs it again and checks that PayPal stored what was sent (`applied` flag; it logs a WARNING if not). After each installment it re-syncs to the next installment. Each Orders capture is written to the invoice with record-payment, with an idempotency check (it looks for the capture id in existing transaction notes, `server.js:636-645`). `INVOICING.INVOICE.*` webhooks ignore the payload amounts, re-GET the invoice and reconcile each transaction. A payment that RentRoll didn't make becomes a ledger row, linked to the plan only if it is the exact next installment (`server.js:668-728`). There is clear evidence of probing real API behaviour: the 404 when the capture id is passed as `payment_id`, and the 25-character invoice-number limit. The AI side is a reasonably small LLM task, but it is well engineered: ledger snapshot in the prompt, the tenant text marked as untrusted, a retry on bad JSON, and server-side validation of sum and dates that drops failing plans to `needs_review`. The honesty requirement is met. README ("What it doesn't do yet") and SUBMISSION both say plainly that card money moves through Orders + record-payment (stored by PayPal as `EXTERNAL`), and that the hosted-invoice guest payment path is "coded, not tested end to end." Why not 9-10: money doesn't move through the invoice's own payment flow, so the invoice is partly a mirror that RentRoll writes to. The one path where PayPal itself would collect against the invoice is untested. The AI is a single structured-extraction call with no agentic or tool use (not required by the rules, but it caps how "thorough" this looks next to Agent Toolkit entries).

**Fix:** test the hosted-invoice payer path once, e.g. with a sandbox personal buyer account in a normal browser outside the build sandbox, and change "coded, not tested" to "tested". That turns the weakest disclosed path into a proven one.

### 2. Design: 7/10

The tenant page fixes the earlier role problem properly. `/t/:token` is a separate route with a 32-byte random token, a 404 on any bad token, `no-store`/`noindex`/`X-Frame-Options: DENY` headers (`server.js:1332-1336`), and no landlord actions in the renderer (`lib/tenant-page.js:1-3`). It posts tenant messages into the same `handleTenantMessage` the landlord uses, and it pays through the same `payRentPeriodSandbox`. That function refuses any amount except the next installment (`server.js:314`, `:1370-1376`). The tenant gets their own flow: balance card with a progress bar, plan status in plain language ("Waiting for your landlord to approve"), the ledger figures the AI was given, a locked "Installment 1 of 2 · $600.00" button once approved, and a payments list showing webhook confirmation. Contact-sheet frames 0:25, 0:33, 1:21 and 1:29 show this on a phone and it looks like a real product. The landlord dashboard (0:17, 0:41, 1:37) shows units, AI proposal with reasoning, approve/reject, collected/outstanding tiles and reminder results. Remaining gaps:
- (a) The tenant page links the PayPal invoice number to PayPal's hosted page (`tenant-page.js:145`). That page enforces only a *minimum*, so the tenant sees two payment routes with different rules on one screen.
- (b) The landlord has to copy the tenant link by hand. Nothing delivers it, and reminders aren't sent either (disclosed).
- (c) **`../SUBMISSION.md`'s judge testing steps don't mention the tenant page at all.** All six steps are landlord-side, and step 4 still says "Click 'Tenant pays installment 1 of 2'" on the dashboard. A judge following the instructions may never see the fix.

**Fix:** add a step 1.5 to the testing instructions ("Click 'Tenant's page ↗' on Unit 2, open it on your phone or a narrow window, send the message and pay from there"). Either remove the hosted-invoice link from the tenant page or label it clearly.

### 3. Potential Impact: 6/10

The audience is specific and believable: landlords with 1-4 units who already take rent over PayPal/Venmo/Zelle and agree partial-payment deals by text. The pain is concrete: checking payments by hand, and no record that holds up in small claims court. The demo addresses it. The plan is enforced on the payment, reminders follow real state, and the court packet is real output (the sample PDF has PayPal order/capture ids, fee/net, webhook verification and a SHA-256 over the ledger rows). The team is upfront about the two biggest objections, free ACH tools and PayPal's ~3% fee. That builds credibility, but the objections still hold. ~$54-60/month on $1,800 rent is a real barrier to adoption, and the case rests on users who are already on PayPal for rent. There is no evidence of user validation: no landlord quotes, no numbers on how common partial-payment disputes are. The court-packet value is asserted rather than shown. The sample is "not legal advice," and nothing indicates a court would accept it. The sample reminder says "A late fee of $75.00 now applies" while the same packet says RentRoll does not add late fees. A court reader could pick on that.

**Fix:** add one sourced statistic or quote about small landlords and partial or late rent (e.g. a share of tenants paying late or in parts) to the SUBMISSION description and the video's first 10 seconds.

### 4. Innovation/Idea: 6/10

This is judged only from my own general knowledge, without the team's competitor research. Rent collection is a crowded category: Avail, TurboTenant, Zillow Rental Manager, Baselane, RentRedi, and tenant-side "split rent" products like Flex. Several of these allow partial payments in some form. What is new here is the combination. An LLM turns free-text negotiation into a plan, but only against a ledger computed from PayPal. The approved plan is then written onto a real PayPal invoice and enforced before each charge. The thesis "a chatbot can't refuse a payment or update an invoice" is a sharp framing that most "AI + payments" entries won't have. The pieces (invoices, partial payments, reminders, exports) are each familiar, though, so this is clever integration rather than a new category.

**Fix:** make the new part obvious in the demo by showing a case where the tenant's numbers are wrong (README's $800-already-paid example) and the AI corrects them from the ledger. That is the moment no existing tool shows.

### 5. Presentation: 6/10 (confidence: medium-low, contact sheet + script only)

The video covers the whole flow end to end: tenant message on the phone → AI plan with ledger read-out → landlord approves → invoice updated (minimum $600) → locked pay button on the phone → sandbox capture → webhook reconciles to PARTIALLY PAID with $600 collected → court PDF. Captions are burned in, the PayPal sandbox badge is visible, and the cuts between desktop and phone are labelled ("LIVE · phone · tenant"). Weaknesses visible in the evidence:
- **Changelog framing instead of a problem statement.** Line 1 is "RentRoll *now* runs on PayPal's real Invoicing API…", which is written for someone who saw an earlier version. Judges haven't. The script never says who has the problem or what it is (small landlords chasing partial rent by hand). The organisers' own tip is "Open with the problem and who it's for."
- **About 55 s of static title cards.** 0:01-~0:16 is one title card (frames 0:01 and 0:09 are identical), and ~2:01 to the end is three text cards. That is about a third of the runtime with no product on screen.
- **The AI's main strength isn't shown.** In the demo the ledger read-out is "paid $0.00 (0 PayPal captures) = $1,800.00 outstanding" (frame 0:41). So the AI splits the full rent, and the "reads the real ledger" claim has nothing to correct.
- Frames 0:57 and 1:05 are near-identical (same approval banner), which may be a slow stretch.
- The court-packet frame (1:53) is a full-page PDF that can't be read at video size.

**Fix:** re-cut the first 15 s as problem → audience → one-line solution, and replace the static title card with it. Cut the closing cards to ≤15 s and use the saved time for a partial-payment-already-made scenario.

## Total: 33/50

(Tech 8 · Design 7 · Impact 6 · Innovation 6 · Presentation 6). Stage One is blocked by the two pending human steps (public repo, YouTube upload). Neither is a quality issue, but the entry is ineligible until both are done.

## Before anything else (gates, human owner)
- Make the repo public and check that MIT shows in GitHub's About section.
- Upload the video to YouTube as public, early (organisers: "Processing can take hours").
- Before going public, check what the repo will expose. `app/` holds internal files (`SPRINT*.md`, `TESTER*-VERDICT.md`, `JUDGEPASS.md`, and now this file). I couldn't run `git ls-files` to see which are tracked. Decide on purpose what judges should see.

## Top 3 things to fix before submitting (ranked by impact)
1. **Re-cut the video opening and the AI scene** (Presentation + Innovation + Impact). Start with the problem and who it's for instead of "now runs on". Replace the ~16 s static intro and trim the ~40 s of closing cards. Demo a tenant who has already paid part of the rent, so the AI visibly corrects their maths from the PayPal ledger. ~2-3 h.
2. **Put the tenant page into the judges' path** (Design). Add a tenant-page step to `../SUBMISSION.md` "Testing instructions for judges" (step 4 currently has the landlord press "Tenant pays"). Fix `lib/auth.js:37` so it no longer says the login is in the README. ~15 min.
3. **Regenerate `app/samples/court-packet-example.pdf`** from the current build (Tech credibility). The checked-in sample has no PayPal invoice section at all, while README says the packet includes the invoice number, id and status, and the video (1:53) shows it. Its chronology is also odd: payment #1 at 00:42 UTC comes before "Rent period opened" at 01:32 UTC, presumably from a reset and replay. A judge who opens the sample sees an older, inconsistent artifact. ~15 min.

