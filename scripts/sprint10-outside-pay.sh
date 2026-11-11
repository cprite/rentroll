# Extra check: money recorded on the invoice OUTSIDE RentRoll (as if the landlord logged $200 cash in PayPal's own
# invoice UI). Then the signed INVOICING.INVOICE.PAID webhook must make RentRoll add it from a GET, not the payload.
set -u
T="$TMPDIR/s10real"; LIVE_LOG=../app/.sprint0-webhook-log.jsonl
export RENTROLL_DB="$T/test.db" RENTROLL_WEBHOOK_LOG="$T/wh-outside.jsonl" NODE_USE_ENV_PROXY=1
INV=$(python3 -c "import sqlite3;print(sqlite3.connect('$RENTROLL_DB').execute('select paypal_invoice_id from rent_period where id=1002').fetchone()[0])")
echo "rp1002 invoice $INV"
node --input-type=module -e "
import { recordPaymentOnInvoice } from './lib/invoicing.js';
console.log('direct record-payment (not via RentRoll):', JSON.stringify(await recordPaymentOnInvoice('$INV', { amountCents: 20000, paymentDate: '2026-11-11', note: 'Cash handed to landlord (logged in PayPal directly, sprint10 outside-payment check)' })));"
for i in $(seq 1 75); do grep "INVOICING.INVOICE.PAID" $LIVE_LOG | grep -q "\"$INV\"" && break; sleep 2; done
grep "INVOICING.INVOICE.PAID" $LIVE_LOG | grep "\"$INV\"" | head -1 > "$RENTROLL_WEBHOOK_LOG"
echo "delivery lines: $(wc -l < "$RENTROLL_WEBHOOK_LOG") (after ~$((i*2)) s)"
node server.js --ingest-webhook-log
python3 - <<PY
import sqlite3; c=sqlite3.connect('$RENTROLL_DB')
print('payments rp1002:', c.execute("select id,source,status,amount_cents,custom_id,invoice_payment_id,invoice_webhook_event_id from payment where rent_period_id=1002").fetchall())
print('rent_period 1002:', c.execute("select status,amount_paid_cents,paypal_invoice_status,paypal_invoice_paid_cents from rent_period where id=1002").fetchone())
print('ledger:', c.execute("select kind, summary from event_log where rent_period_id=1002 order by id desc limit 1").fetchone())
PY
