#!/usr/bin/env bash
# Sprint 10 real end-to-end test: PayPal Invoicing as the core. THROWAWAY DB (rent_period ids offset to 1001-1003 so the
# live service's webhooks can't touch it), real PayPal sandbox, real NVIDIA LLM. Run from app-sprint10/ with the build env.
# Prints no credentials (a random local-only Basic Auth login is generated for this throwaway server).
set -u
T="$TMPDIR/s10real"; rm -rf "$T"; mkdir -p "$T"
LIVE_LOG=../app/.sprint0-webhook-log.jsonl   # read-only: the live service receives every sandbox webhook
export RENTROLL_DB="$T/test.db" RENTROLL_WEBHOOK_LOG="$T/wh.jsonl" PORT=8810 NODE_USE_ENV_PROXY=1
export DEMO_USER="t10" DEMO_PASSWORD="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
U=http://127.0.0.1:8810; C="curl -s -u $DEMO_USER:$DEMO_PASSWORD"; J='-H Content-Type:application/json'
PY='import sys,json;r=json.load(sys.stdin)'
inv() { $C $U/api/rent-periods/1001/invoice | python3 -c "$PY"'
i=r.get("invoice") or {};print("  invoice",i.get("number"),i.get("id"),"status",i.get("status"),"| paid",i.get("paid_cents"),"due",i.get("due_cents"))
print("  configuration.partial_payment =",json.dumps((r.get("configuration") or {}).get("partial_payment")))
print("  detail.payment_term =",json.dumps(r.get("payment_term")))
print("  payments.transactions =",json.dumps([(t["payment_id"],t["type"],t["method"],t["amount"]["value"]) for t in ((r.get("payments") or {}).get("transactions") or [])]))'; }

node server.js --seed --no-invoices >/dev/null && node scripts/sprint10-testdb.mjs "$RENTROLL_DB" >/dev/null
: > "$RENTROLL_WEBHOOK_LOG"
node server.js >>"$T/server.log" 2>&1 & PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s $U/healthz >/dev/null && break; sleep 0.5; done
for i in $(seq 1 60); do [ "$(grep -c '\[invoice\]' "$T/server.log")" -ge 3 ] && break; sleep 1; done
echo "=== 1. server up $(date -u +%H:%M:%SZ); startup created + sent one PayPal invoice per rent period ==="
grep '\[invoice\]' "$T/server.log" | sed 's/^/  /'
[ "$(grep -c '"invoice_id"' "$T/server.log")" -ge 3 ] || { echo 'ABORT: not every rent period got a PayPal invoice'; exit 1; }
echo '$ GET /api/rent-periods/1001/invoice   (live GET from PayPal, before any plan)'; inv

echo '=== 2. tenant message -> AI plan ==='
echo '$ POST /api/rent-periods/1001/messages {"body":"Hi, money is tight this month. Can I pay 900 now and the rest on the 15th?"}'
$C -X POST $J -d '{"body":"Hi, money is tight this month. Can I pay 900 now and the rest on the 15th?"}' $U/api/rent-periods/1001/messages > "$T/plan.json"
python3 -c 'import json;r=json.load(open("'"$T"'/plan.json"));p=r.get("plan") or {};print("  ok",r.get("ok"),"plan",p.get("id"),p.get("status"),[(i["due_date"],i["amount_cents"]) for i in p.get("installments",[])],r.get("error",""))'
PLAN=$(python3 -c 'import json;print(json.load(open("'"$T"'/plan.json"))["plan"]["id"])')

echo "=== 3. landlord approves -> the real PayPal invoice changes ==="
echo "\$ POST /api/plans/$PLAN/approve"
$C -X POST $U/api/plans/$PLAN/approve | python3 -c "$PY"'
print("  ok",r["ok"],r.get("error",""),"plan status",(r.get("plan") or {}).get("status"))
print("  invoice sync:",json.dumps(r.get("invoice")))'
echo '$ GET /api/rent-periods/1001/invoice   (independent re-read from PayPal)'; inv

echo '=== 4. payments ==='
echo '$ POST /api/rent-periods/1001/pay-sandbox {"amount":"1800.00"}   (not the installment: must be refused before PayPal)'
$C -X POST $J -d '{"amount":"1800.00"}' $U/api/rent-periods/1001/pay-sandbox | python3 -c "$PY"';print("  ok",r["ok"],r.get("error",""))'
FIRST=$(python3 -c 'import json;print("%.2f"%(json.load(open("'"$T"'/plan.json"))["plan"]["installments"][0]["amount_cents"]/100))')
echo "\$ POST /api/rent-periods/1001/pay-sandbox {\"amount\":\"$FIRST\"}   (installment 1)"
$C -X POST $J -d "{\"amount\":\"$FIRST\"}" $U/api/rent-periods/1001/pay-sandbox | tee "$T/pay1.json" | python3 -c "$PY"'
p=r.get("payment") or {};print("  ok",r["ok"],r.get("error",""),"order",p.get("paypal_order_id"),"capture",p.get("paypal_capture_id"),p.get("status"),"| period",r.get("rent_period"))
print("  record-payment on invoice:",json.dumps({k:v for k,v in (r.get("invoice") or {}).items() if k!="invoice_terms"}))
print("  invoice terms moved on:",json.dumps((r.get("invoice") or {}).get("invoice_terms")))'
echo '$ GET /api/rent-periods/1001/invoice'; inv

CAP1=$(python3 -c 'import json;print(json.load(open("'"$T"'/pay1.json"))["payment"]["paypal_capture_id"])')
INVID=$($C $U/api/rent-periods/1001/invoice | python3 -c "$PY"';print(r["invoice"]["id"])')
SINCE=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "=== 5. webhooks: wait up to 150 s for PayPal's signed deliveries (capture $CAP1, invoice $INVID) in the live log ==="
for i in $(seq 1 75); do
  grep -q "\"$CAP1\"" $LIVE_LOG && grep "INVOICING.INVOICE.PAID" $LIVE_LOG | grep -q "\"$INVID\"" && break; sleep 2; done
grep "\"$CAP1\"" $LIVE_LOG | grep PAYMENT.CAPTURE.COMPLETED | head -1 >> "$RENTROLL_WEBHOOK_LOG"
grep "\"$INVID\"" $LIVE_LOG | grep 'INVOICING.INVOICE' >> "$RENTROLL_WEBHOOK_LOG"
python3 -c 'import json
for l in open("'"$RENTROLL_WEBHOOK_LOG"'"):
  e=json.loads(l);b=e["body"];i=(b.get("resource") or {}).get("invoice") or {}
  print("  delivered",e["received_at"],b["event_type"],b["id"],"| payload claims:",i.get("status") or b["resource"].get("status"),json.dumps((i.get("payments") or {}).get("paid_amount")))'
echo '$ node server.js --ingest-webhook-log   (each delivery re-verified with PayPal; invoice events GET the invoice)'
node server.js --ingest-webhook-log | python3 -c 'import sys,json
for l in sys.stdin:
  try: r=json.loads(l)
  except: continue
  print("  ",r.get("event_type"),r.get("event_id"),"->",r.get("result"),"sig",r.get("verification"),"| invoice",r.get("invoice_status"),"paid",r.get("invoice_paid_cents"),"local",r.get("local_paid_cents"),"matches",r.get("matches_ledger"),"added",r.get("added"))'

echo "=== 6. installment 2 ==="
SECOND=$(python3 -c 'import json;print("%.2f"%(json.load(open("'"$T"'/plan.json"))["plan"]["installments"][1]["amount_cents"]/100))')
echo "\$ POST /api/rent-periods/1001/pay-sandbox {\"amount\":\"$SECOND\"}"
$C -X POST $J -d "{\"amount\":\"$SECOND\"}" $U/api/rent-periods/1001/pay-sandbox | tee "$T/pay2.json" | python3 -c "$PY"'
p=r.get("payment") or {};print("  ok",r["ok"],r.get("error",""),"capture",p.get("paypal_capture_id"),p.get("status"),"plan",r.get("plan_status"),"| period",r.get("rent_period"))
print("  record-payment on invoice:",json.dumps({k:v for k,v in (r.get("invoice") or {}).items() if k!="invoice_terms"}))
print("  invoice terms:",json.dumps((r.get("invoice") or {}).get("invoice_terms")))'
echo '$ GET /api/rent-periods/1001/invoice'; inv

CAP2=$(python3 -c 'import json;print(json.load(open("'"$T"'/pay2.json"))["payment"]["paypal_capture_id"])')
echo "  waiting up to 150 s for capture $CAP2 + the invoice's final INVOICING.INVOICE.PAID (status PAID or MARKED_AS_PAID) in the live log..."
for i in $(seq 1 75); do
  grep -q "\"$CAP2\"" $LIVE_LOG && grep "INVOICING.INVOICE.PAID" $LIVE_LOG | grep "\"$INVID\"" | grep -Eq '"status":"(MARKED_AS_)?PAID"' && break; sleep 2; done
: > "$RENTROLL_WEBHOOK_LOG.new"
grep "\"$CAP2\"" $LIVE_LOG | grep PAYMENT.CAPTURE.COMPLETED | head -1 >> "$RENTROLL_WEBHOOK_LOG.new"
grep "\"$INVID\"" $LIVE_LOG | grep 'INVOICING.INVOICE' >> "$RENTROLL_WEBHOOK_LOG.new"
cp "$RENTROLL_WEBHOOK_LOG.new" "$RENTROLL_WEBHOOK_LOG"
echo '$ node server.js --ingest-webhook-log   (already-processed events come back as duplicate)'
node server.js --ingest-webhook-log | python3 -c 'import sys,json
for l in sys.stdin:
  try: r=json.loads(l)
  except: continue
  print("  ",r.get("event_type"),r.get("event_id"),"->",r.get("result"),"sig",r.get("verification"),"| invoice",r.get("invoice_status"),"paid",r.get("invoice_paid_cents"),"local",r.get("local_paid_cents"),"matches",r.get("matches_ledger"))'

echo '=== 7. court packet ==='
$C -o "$T/packet.json" $U/api/rent-periods/1001/court-packet.json
python3 -c 'import json;r=json.load(open("'"$T"'/packet.json"));i=r["invoice"]
print("  packet.invoice:",json.dumps({k:i[k] for k in ("id","number","status","paid_cents","due_cents","allow_partial_payment","minimum_amount_due_cents","due_date","source","matches_ledger")}))
print("  transactions:",[(t["payment_id"],t["amount_cents"],t["type"]) for t in i["transactions"] or []])
print("  payments:",[(p["id"],p["amount_cents"],p["paypal_capture_id"],p["invoice_payment_id"],p["webhook_confirmed"],p["invoice_webhook_event_id"]) for p in r["payments"]])
for l in r["summary"]["lines"]: print("  line:",l)'
$C -o "$T/packet.pdf" -w '  PDF: HTTP %{http_code}, %{size_download} bytes, %{content_type}\n' $U/api/rent-periods/1001/court-packet.pdf
python3 -c 'import sys;d=open("'"$T"'/packet.pdf","rb").read();print("  %PDF header:",d[:5])'
command -v pdftotext >/dev/null && pdftotext "$T/packet.pdf" - | grep -n -A7 '^PayPal invoice$' | head -12 | sed 's/^/  pdf| /'

echo '=== 8. ledger (test DB event_log) ==='
$C $U/api/event-log | python3 -c "$PY"'
for e in r:
  if e["rent_period_id"]==1001: print("  %d %s %-24s %-8s %s" % (e["id"], e["at"][11:23], e["kind"], e["actor"], e["summary"][:300]))'
$C $U/ > "$T/dash.html"; grep -o 'PayPal invoice <a[^<]*</a> · <b>[A-Z_]*</b>' "$T/dash.html" | sed 's/<[^>]*>//g;s/^/  dashboard: /'
kill $PID; wait $PID 2>/dev/null; trap - EXIT
grep -i 'error\|fail' "$T/server.log" | grep -v '^\[auth\]' | head -5 | sed 's/^/  server.log: /'
echo "files in $T"
