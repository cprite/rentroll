# RentRoll: Devpost submission text

## Project name

RentRoll

## One-line pitch

Small landlords get partial-payment plans based on what the tenant has actually paid through PayPal. The plans are written onto the real PayPal invoice and enforced on every payment, and the landlord gets a court-ready record.

## Inspiration

Before picking this idea we read 2,617 Reddit posts about payment pain, across 28 subreddits. About 30 of them were small landlords chasing rent by hand. One landlord on r/Landlord (November 2026) put it simply: "Top of each month is my wife and I asking each other if the tenant paid rent." A partial-payment plan agreed over text has no enforcement and no paper trail, and that's what RentRoll is for.

## Description

Lots of people with one to four rental units collect rent informally. The tenant sends money over Zelle, Venmo or PayPal, and every month the landlord scrolls through transactions to work out who paid what. When a tenant texts "can I pay 800 now and the rest on the 15th", the deal lives in a text thread. Nobody checks the next payment against it, and if it ends up in small claims court, the landlord is rebuilding the history from screenshots.

RentRoll keeps that history in one place and puts the AI where it's actually useful. Each month's rent is a real PayPal invoice, created and sent through the Invoicing API. The landlord pastes in the tenant's message. Our code reads the month's real balance from completed PayPal payments, and the AI (NVIDIA Nemotron) turns the message into a plan that adds up to that balance. When the landlord approves it, RentRoll rewrites the PayPal invoice: partial payment goes on, the minimum amount due becomes the next installment, and the due date becomes that installment's date. RentRoll then reads the invoice back to confirm PayPal stored the change. PayPal only enforces a minimum, not a schedule, so RentRoll also refuses any amount except the next installment before PayPal is called. Each payment is recorded on the invoice, and PayPal's signed webhooks (capture and invoice) are reconciled against a fresh GET of the invoice. Reminders are picked from the real state of the ledger: a friendly nudge inside the grace period, a firm reminder once the late fee applies, a formal notice after two weeks. And one click gives you a dated PDF of every message, plan, reminder and payment for court.

Demo flow: tenant texts a partial-payment ask → AI reads the real PayPal balance and proposes a plan → landlord approves → only the agreed installment gets through to PayPal → reminders escalate off real payment state → one-click court-ready PDF.

What's not there yet: reminders are drafted and logged, not sent (no SMS or email integration), and tenant messages are typed into the dashboard. The demo's "Tenant pays" button doesn't pay on PayPal's hosted invoice page. It charges a sandbox test card through the Orders API, and RentRoll then records that capture on the invoice with record-payment. PayPal lists it as an `EXTERNAL` transaction with method `PAYPAL`, and the note names the capture id. The invoice status moves to PARTIALLY_PAID, then to MARKED_AS_PAID. We couldn't test a no-login guest card payment on the hosted invoice page from our build environment. The code is written to reconcile a payment made there through the `INVOICING.INVOICE.PAID` webhook, the same way it reconciles a payment PayPal records outside RentRoll entirely — but this specific path (a real hosted-page guest payment) is coded, not tested end to end.

Two weaknesses we know about:

1. **Free ACH tools exist.** Avail, TurboTenant and Zillow collect rent by bank transfer for free. RentRoll is for a narrower group: landlords whose tenants already pay through PayPal or Venmo, who end up negotiating partial payments, and who want a record they can take to court. The free tools do those last two poorly or not at all.
2. **PayPal's fee is real money.** In our sandbox runs PayPal took $25.82 on an $800 payment (2.99% + $0.49). On $1,800 rent that's about $54 a month, and closer to $60 at the 3.49% goods-and-services rate. RentRoll isn't the cheapest way to collect rent. You're paying for speed and a paper trail.

## Built With

Node.js, Express, SQLite, pdfkit, PayPal Invoicing API v2 (sandbox), PayPal Orders API (sandbox), PayPal Webhooks + signature verification, NVIDIA NIM (`nvidia/nemotron-3.5-lightning-30b-a3b`), Tailscale Funnel

## AI tools used and how

**1. NVIDIA Nemotron, inside the app.** RentRoll calls `nvidia/nemotron-3.5-lightning-30b-a3b` through NVIDIA NIM for two jobs: turning a tenant's message into a payment plan, and drafting reminder text. The model never gets the last word. Before it runs, our code works out the balance from completed PayPal payments and puts it in the prompt. After it runs, our server checks the result: plan amounts have to add up to the real balance and dates have to be valid, and reminders have to quote the exact amount owed and mention the late fee only when it applies. A plan that fails goes to "needs review" and can't be approved. A reminder that fails gets one retry and then falls back to a fixed template.

We tested whether the ledger matters. A tenant had paid $800 of $1,800 and asked to pay "900 now and the rest later". With the ledger, the model proposed $900 + $100. The same model with only the rent amount proposed $900 + $900, overcharging by $800, and our validator rejected that plan. A chatbot can write a plan. It can't see the payments, and it can't stop PayPal from taking the wrong amount.

**2. Claude Code (Anthropic) built the app.** The whole codebase was written by Claude Code, run overnight by an orchestrator agent we call hack-lead. Each sprint was built on its own branch. Before code could merge to main, a fresh AI tester that hadn't written the code ran it against the real PayPal sandbox and reported pass or fail with evidence. One tester failed Sprint 1 because forged webhooks were accepted. That was fixed and re-tested before merging.

## Testing instructions for judges

The easiest way is the hosted demo: https://nikopi5.tail4aaac7.ts.net/

You'll land on a RentRoll sign-in page — the login is given separately, not in this repo. It's one shared demo login, there
only to keep random visitors off the buttons before a judge gets to it; no test account is needed. It runs on
PayPal's sandbox, and the "Tenant pays" button charges a PayPal test card, so no real money moves.

1. Pick a unit with a balance and type a message into "Tenant texted", e.g. `can I pay 900 now and the rest on the 15th`.
2. Read the AI's proposal. It shows the balance it was given and whether the total matches.
3. Click "Approve plan". The pay form now only accepts the next installment. The unit's PayPal invoice line changes to "partial OK, min $X" and the installment's due date, as read back from PayPal.
4. Click "Tenant's page ↗" (or "Copy tenant link" and open it on your phone, or in a narrow window). This is the tenant's own view — no landlord login, a private per-tenant link. From there, click "Pay $X with PayPal (card)". A real sandbox card capture runs and is recorded on the PayPal invoice, which goes to PARTIALLY_PAID. The PayPal-confirmed badge shows up once the webhook arrives, on both the tenant's page and the landlord's dashboard.
5. Click "Send reminders now" to see drafts picked from each unit's real state.
6. Click "Download court packet (PDF)" to get a dated record of that unit's messages, plan, reminders and payments, with the PayPal invoice number and current status, PayPal's order/capture ids and webhook verification result.

To run it yourself, clone the repo and follow `README.md`. You'll need your own PayPal sandbox app and NVIDIA API key. The repo and the hosted demo will stay up through the end of the Judging Period (December 15, 2026).

## Voice and video disclosure

The narration in the demo video is an AI voice clone of Nikolay's own voice, made and used with his consent. It doesn't imitate anyone else. Any other character voices in the video are fictional and aren't based on real people.

## License

MIT. See `LICENSE` in the repo.
