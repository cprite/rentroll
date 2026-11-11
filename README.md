# RentRoll

Rent collection for landlords with one to four units who take rent over PayPal, Venmo or Zelle and check by hand every month who has paid.

When a tenant writes "can I pay 900 now and the rest on the 15th", RentRoll checks what has actually been paid through PayPal and has an AI turn the message into a payment plan. Once the landlord approves it, only the agreed amounts get through. Reminders are based on what's really been paid, and the whole history can be exported as a dated PDF for small claims court.

Live demo: https://nikopi5.tail4aaac7.ts.net/

No login. It runs against PayPal's sandbox, so no real money moves.

## What it does

- **The AI reads the ledger first.** Before it proposes anything, our code adds up the completed PayPal payments for that month and gives the model the real balance. The model works out the wording ("the rest later") and our server checks its math. In testing, a tenant who'd already paid $800 of $1,800 asked to pay "900 now and the rest later". RentRoll proposed $900 + $100. The same model without the ledger proposed $900 + $900, overcharging by $800, and our validator rejects that plan. (Details in `SPRINT2.md`.)
- **Approving a plan locks the amount.** After approval, the only payment RentRoll will send to PayPal is the next installment, for the exact amount. In the sandbox, $1,800 and $500 were refused, and $900 went through and was confirmed by PayPal's signed webhook. (`SPRINT3.md`)
- **Reminders follow the money.** Each run re-reads the payments and picks a tone: a friendly nudge inside the grace period, a firm reminder once the late fee applies, a formal notice after two weeks. If nothing changed in the last 24 hours, it skips the unit. (`SPRINT4.md`)
- **Court packet.** The "Download court packet (PDF)" link on each unit gives you a dated PDF of every message, plan, reminder and payment, with PayPal's order/capture ids, webhook signature-verification result, and a SHA-256 over the included ledger rows. (`SPRINT6.md`)

PayPal webhooks are signature-checked and deduplicated, and the event log is append-only.

## What it doesn't do yet

- Reminders are drafted and logged, not sent. There's no SMS or email integration, and you run them with the "Send reminders now" button.
- Tenant messages are typed into the dashboard. Nothing receives real texts.
- Tenant payments are sandbox card captures through the PayPal Orders API. We meant to use PayPal Invoicing and its partial-payment setting, but our sandbox app got `403 NOT_AUTHORIZED` on every Invoicing call. So the plan is enforced by our server before it calls Orders.

## Two honest weaknesses

1. **Free ACH tools exist.** Avail, TurboTenant and Zillow collect rent by bank transfer for free. RentRoll is for a narrower case: tenants who already pay through PayPal or Venmo, partial-payment deals, and a record you can take to court. The free tools do those poorly or not at all.
2. **PayPal's fee is real money.** In our sandbox runs PayPal took $25.82 on an $800 payment (2.99% + $0.49). On $1,800 rent that's about $54 a month, and closer to $60 at PayPal's 3.49% goods-and-services rate. You pay that for speed and a clean paper trail. It isn't the cheapest option.

## Run it yourself

You need Node 24 (it uses the built-in `node:sqlite`), a PayPal sandbox app and an OpenAI-compatible LLM endpoint. We used NVIDIA NIM.

Environment variables:

```
PAYPAL_CLIENT_ID
PAYPAL_CLIENT_SECRET
PAYPAL_API_BASE        # sandbox API base; the app refuses anything else
PAYPAL_WEBHOOK_ID      # id of the webhook you registered, for signature checks
NVIDIA_API_KEY
LLM_BASE_URL
LLM_MODEL              # we use nvidia/nemotron-3.5-lightning-30b-a3b
PUBLIC_BASE_URL        # public https URL PayPal can reach for webhooks
PORT                   # defaults to 8790
```

Then:

```
npm install && ./start.sh
```

On first start it creates `data/rentroll.db` with three demo tenants. `npm run reset` wipes it and starts over.

For webhooks, register one at `$PUBLIC_BASE_URL/webhooks/paypal` (`node scripts/sprint0-webhook.mjs` does it) and put its id in `PAYPAL_WEBHOOK_ID`. Webhooks with a bad signature are rejected. Payments still work without them, they just won't get the "PayPal confirmed" badge.

Keep keys in env vars. `.env*` is gitignored.

## License

MIT. See `LICENSE`.
