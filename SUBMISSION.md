# RentRoll: Devpost submission text

## Project name

RentRoll

## One-line pitch

Small landlords get partial-payment plans that are based on what the tenant has actually paid through PayPal and enforced on every payment, plus a court-ready record.

## Description

Lots of people with one to four rental units collect rent informally. The tenant sends money over Zelle, Venmo or PayPal, and every month the landlord scrolls through transactions to work out who paid what. When a tenant texts "can I pay 800 now and the rest on the 15th", the deal lives in a text thread. Nobody checks the next payment against it, and if it ends up in small claims court, the landlord is rebuilding the history from screenshots.

RentRoll keeps that history in one place and puts the AI where it's actually useful. The landlord pastes in the tenant's message. Our code reads the month's real balance from completed PayPal payments, and the AI (NVIDIA Nemotron) turns the message into a plan that adds up to that balance. The landlord approves it, and from then on RentRoll will only send PayPal the next installment, for the exact amount. Anything else is refused before PayPal is called. PayPal's signed webhook confirms each payment. Reminders are picked from the real state of the ledger: a friendly nudge inside the grace period, a firm reminder once the late fee applies, a formal notice after two weeks. And one click gives you a dated PDF of every message, plan, reminder and payment for court.

Demo flow: tenant texts a partial-payment ask → AI reads the real PayPal balance and proposes a plan → landlord approves → only the agreed installment gets through to PayPal → reminders escalate off real payment state → one-click court-ready PDF.

What's not there yet: reminders are drafted and logged, not sent (no SMS or email integration), and tenant messages are typed into the dashboard. We planned to use PayPal Invoicing's partial-payment setting, but our sandbox app got `403 NOT_AUTHORIZED` on every Invoicing call, so payments go through the Orders API and our server enforces the plan.

Two weaknesses we know about:

1. **Free ACH tools exist.** Avail, TurboTenant and Zillow collect rent by bank transfer for free. RentRoll is for a narrower group: landlords whose tenants already pay through PayPal or Venmo, who end up negotiating partial payments, and who want a record they can take to court. The free tools do those last two poorly or not at all.
2. **PayPal's fee is real money.** In our sandbox runs PayPal took $25.82 on an $800 payment (2.99% + $0.49). On $1,800 rent that's about $54 a month, and closer to $60 at the 3.49% goods-and-services rate. RentRoll isn't the cheapest way to collect rent. You're paying for speed and a paper trail.

## Built With

Node.js, Express, SQLite, pdfkit, PayPal Orders API (sandbox), PayPal Webhooks + signature verification, NVIDIA NIM (`nvidia/nemotron-3.5-lightning-30b-a3b`), Tailscale Funnel

## AI tools used and how

**1. NVIDIA Nemotron, inside the app.** RentRoll calls `nvidia/nemotron-3.5-lightning-30b-a3b` through NVIDIA NIM for two jobs: turning a tenant's message into a payment plan, and drafting reminder text. The model never gets the last word. Before it runs, our code works out the balance from completed PayPal payments and puts it in the prompt. After it runs, our server checks the result: plan amounts have to add up to the real balance and dates have to be valid, and reminders have to quote the exact amount owed and mention the late fee only when it applies. A plan that fails goes to "needs review" and can't be approved. A reminder that fails gets one retry and then falls back to a fixed template.

We tested whether the ledger matters. A tenant had paid $800 of $1,800 and asked to pay "900 now and the rest later". With the ledger, the model proposed $900 + $100. The same model with only the rent amount proposed $900 + $900, overcharging by $800, and our validator rejected that plan. A chatbot can write a plan. It can't see the payments, and it can't stop PayPal from taking the wrong amount.

**2. Claude Code (Anthropic) built the app.** The whole codebase was written by Claude Code, run overnight by an orchestrator agent we call hack-lead. Each sprint was built on its own branch. Before code could merge to main, a fresh AI tester that hadn't written the code ran it against the real PayPal sandbox and reported pass or fail with evidence. One tester failed Sprint 1 because forged webhooks were accepted. That was fixed and re-tested before merging.

## Testing instructions for judges

The easiest way is the hosted demo: https://nikopi5.tail4aaac7.ts.net/

Your browser will ask for a login — it's given in this submission's judges-only testing-instructions field on
Devpost, not here. It's one shared demo login, there only to keep random visitors off the buttons; no test
account is needed. It runs on PayPal's sandbox, and the "Tenant pays" button charges a PayPal test card, so no
real money moves.

1. Pick a unit with a balance and type a message into "Tenant texted", e.g. `can I pay 900 now and the rest on the 15th`.
2. Read the AI's proposal. It shows the balance it was given and whether the total matches.
3. Click "Approve plan". The pay form now only accepts the next installment.
4. Click "Tenant pays installment 1 of 2". A real sandbox capture runs, and the PayPal-confirmed badge shows up once the webhook arrives.
5. Click "Send reminders now" to see drafts picked from each unit's real state.
6. Click "Download court packet (PDF)" to get a dated record of that unit's messages, plan, reminders and payments, with PayPal's order/capture ids and webhook verification result.

To run it yourself, clone the repo and follow `README.md`. You'll need your own PayPal sandbox app and NVIDIA API key. The repo and the hosted demo will stay up through the end of the Judging Period (December 15, 2026).

## Voice and video disclosure

The narration in the demo video is an AI voice clone of Nikolay's own voice, made and used with his consent. It doesn't imitate anyone else. Any other character voices in the video are fictional and aren't based on real people.

## License

MIT. See `LICENSE` in the repo.
