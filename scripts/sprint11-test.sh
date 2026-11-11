#!/usr/bin/env bash
# Sprint 11 real end-to-end test: the tenant's own page. THROWAWAY DB (rent_period ids offset to 1001-1003 so the live
# service's webhooks can't touch it), real PayPal sandbox (Orders + Invoicing), real NVIDIA LLM. Run from app-sprint11/
# with the build env. Tenant steps use NO Basic Auth; landlord steps use a random local-only login for this throwaway
# server. Prints no credentials; the tenant token is shown only as its first 6 characters.
set -u
T="$TMPDIR/s11real"; rm -rf "$T"; mkdir -p "$T"
LIVE_LOG=../app/.sprint0-webhook-log.jsonl   # read-only: the live service receives every sandbox webhook
export RENTROLL_DB="$T/test.db" RENTROLL_WEBHOOK_LOG="$T/wh.jsonl" PORT=8812 NODE_USE_ENV_PROXY=1
export DEMO_USER="t11" DEMO_PASSWORD="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
U=http://127.0.0.1:8812; L="curl -s -u $DEMO_USER:$DEMO_PASSWORD"; J='-H Content-Type:application/json'
PY='import sys,json;r=json.load(sys.stdin)'
TXT="python3 scripts/sprint11-text.py"

node server.js --seed --no-invoices >/dev/null && node scripts/sprint10-testdb.mjs "$RENTROLL_DB" >/dev/null
: > "$RENTROLL_WEBHOOK_LOG"
node server.js >>"$T/server.log" 2>&1 & PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s $U/healthz >/dev/null && break; sleep 0.5; done
for i in $(seq 1 60); do [ "$(grep -c '\[invoice\]' "$T/server.log")" -ge 3 ] && break; sleep 1; done
echo "=== 0. server up $(date -u +%H:%M:%SZ) on a throwaway DB; startup invoices: $(grep -c '"invoice_id"' "$T/server.log")/3 created + sent ==="
TOK=$(node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('SELECT t.access_token FROM tenant t JOIN rent_period rp ON rp.tenant_id=t.id WHERE rp.id=1001').get().access_token)" "$RENTROLL_DB")
OTHER=$(node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);console.log(d.prepare('SELECT t.access_token FROM tenant t JOIN rent_period rp ON rp.tenant_id=t.id WHERE rp.id=1002').get().access_token)" "$RENTROLL_DB")
TS="${TOK:0:6}…"
echo "  tenant of rent_period 1001: token $TS (${#TOK} chars, base64url of 32 random bytes); tokens distinct across tenants: $(node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);const r=d.prepare('SELECT COUNT(*) n, COUNT(DISTINCT access_token) u FROM tenant').get();console.log(r.u+'/'+r.n)" "$RENTROLL_DB")"
page() { curl -s -o "$T/$1.html" -w "  GET /t/$TS (no login): HTTP %{http_code}, %{size_download} bytes\n" $U/t/$TOK; }
post() { # $1 name, $2 path suffix, rest = curl data args; form POST exactly like the page's <form>, no login, follow the 303
  local n=$1 p=$2; shift 2
  curl -s -o "$T/$n.html" -L -w "  POST /t/$TS/$p (form, no login): first response %{redirect_url}→ final HTTP %{http_code}\n" "$@" $U/t/$TOK/$p | sed "s#$TOK#$TS#g"; }

echo '=== 1. tenant opens their link ==='
page t1; $TXT "$T/t1.html" balance plan pay

echo '=== 2. tenant sends their own message from the page (real LLM call) ==='
MSG="Hey, I got paid late this month. I can do 600 today and the rest on the 20th, is that ok?"
echo "  body: \"$MSG\""
post t2 messages --data-urlencode "rent_period_id=1001" --data-urlencode "body=$MSG"
$TXT "$T/t2.html" flash plan pay messages
PLAN=$($L $U/api/rent-periods/1001/plans | python3 -c "$PY"';print(r[0]["id"])')
$L $U/api/rent-periods/1001/plans | python3 -c "$PY"'
p=r[0];print("  landlord API sees plan",p["id"],p["status"],[(i["due_date"],i["amount_cents"]) for i in p["installments"]],"| errors",p["validation_errors"],"| llm",(p.get("llm") or {}).get("model"))'
$L $U/api/event-log | python3 -c "$PY"'
for e in r:
  if e["kind"]=="message_in" and e["rent_period_id"]==1001: print("  ledger:",e["actor"],e["summary"])'

echo "=== 3. landlord approves plan #$PLAN (Basic-Auth route, same test DB) ==="
curl -s -o /dev/null -w "  without login: POST /api/plans/$PLAN/approve -> HTTP %{http_code}\n" -X POST $U/api/plans/$PLAN/approve
$L -X POST $U/api/plans/$PLAN/approve | python3 -c "$PY"'
print("  with landlord login: ok",r["ok"],r.get("error",""),"| plan",(r.get("plan") or {}).get("status"))
i=r.get("invoice") or {};print("  PayPal invoice sync:",i.get("ok"),i.get("invoice_number"),"after",json.dumps(i.get("after")))'

echo '=== 4. tenant reloads: plan approved, next installment locked ==='
page t4; $TXT "$T/t4.html" plan pay
echo "  wrong amount from the tenant route (JSON, no login): $(curl -s $J -d '{"rent_period_id":1001,"amount":"1800.00"}' $U/t/$TOK/pay-sandbox)"

N=0
while :; do
  N=$((N+1)); [ $N -gt 6 ] && { echo 'ABORT: too many installments'; break; }
  AMT=$(python3 -c 'import re,sys;m=re.search(r"name=\"amount\" value=\"([0-9.]+)\"",open(sys.argv[1]).read());print(m.group(1) if m else "")' "$T/t$((N+3)).html")
  [ -z "$AMT" ] && break
  echo "=== 5.$N tenant taps Pay (locked amount from the page: \$$AMT) -> real PayPal sandbox capture ==="
  post p$N pay-sandbox --data-urlencode "rent_period_id=1001" --data-urlencode "amount=$AMT"
  $TXT "$T/p$N.html" flash
  cp "$T/p$N.html" "$T/t$((N+4)).html"
  $TXT "$T/t$((N+4)).html" pay
done

echo '=== 6. landlord-side check of the same rent period (Basic Auth API) ==='
$L $U/api/rent-periods | python3 -c "$PY"'
rp=[x for x in r if x["id"]==1001][0]
print("  rent_period 1001:",rp["status"],"paid",rp["amount_paid_cents"],"balance",rp["balance_cents"],"| invoice",rp["paypal_invoice_number"],rp["paypal_invoice_status"])
for p in rp["payments"]: print("   payment",p["id"],p["status"],p["amount_cents"],"plan",p["plan_id"],"inst",p["plan_installment"],"order",p["paypal_order_id"],"capture",p["paypal_capture_id"],"on invoice",p["invoice_payment_id"])'
$L $U/api/event-log | python3 -c "$PY"'
for e in r:
  if e["rent_period_id"]==1001 and e["kind"] in ("payment","plan_completed","invoice_payment_recorded"): print("  ledger:",e["kind"],e["actor"],e["summary"][:220])'

echo '=== 7. webhooks: wait up to 150 s for PayPal to deliver the capture webhooks to the live service, replay into the test DB ==='
CAPS=$($L $U/api/rent-periods | python3 -c "$PY"';print(" ".join(p["paypal_capture_id"] for x in r if x["id"]==1001 for p in x["payments"] if p["paypal_capture_id"]))')
for i in $(seq 1 75); do ok=1; for c in $CAPS; do grep -q "\"$c\"" $LIVE_LOG || ok=0; done; [ $ok = 1 ] && break; sleep 2; done
for c in $CAPS; do grep "\"$c\"" $LIVE_LOG | grep PAYMENT.CAPTURE.COMPLETED | head -1 >> "$RENTROLL_WEBHOOK_LOG"; done
node server.js --ingest-webhook-log | python3 -c 'import sys,json
for l in sys.stdin:
  try: r=json.loads(l)
  except: continue
  print("  ",r.get("event_type"),r.get("event_id"),"->",r.get("result"),"sig",r.get("verification"))'

echo '=== 8. tenant reloads: final paid state ==='
page tfinal; $TXT "$T/tfinal.html" balance plan pay payments messages

echo '=== 9. security checks ==='
BAD="$(printf '%s' "$TOK" | cut -c1-42)$( [ "${TOK: -1}" = A ] && echo B || echo A)"
curl -s -o /dev/null -w "  GET /t/<valid token with last char changed>: HTTP %{http_code}\n" $U/t/$BAD
curl -s -o "$T/404.txt" -w "  GET /t/1001: HTTP %{http_code}" $U/t/1001; echo " body: $(cat $T/404.txt)"
curl -s -o /dev/null -w "  GET /t/ (no token): HTTP %{http_code}\n" $U/t/
curl -s -o /dev/null -w "  POST /t/<bad>/messages: HTTP %{http_code}\n" -d body=hi $U/t/$BAD/messages
curl -s -o /dev/null -w "  POST /t/<bad>/pay-sandbox: HTTP %{http_code}\n" -d amount=1 $U/t/$BAD/pay-sandbox
curl -s -o /dev/null -w "  POST /t/<tenant 1001 token>/messages for rent_period 1002 (another tenant's): HTTP %{http_code}\n" -d rent_period_id=1002 -d body=hi $U/t/$TOK/messages
curl -s -o /dev/null -w "  POST /t/<tenant 1001 token>/pay-sandbox for rent_period 1002: HTTP %{http_code}\n" -d rent_period_id=1002 -d amount=1.00 $U/t/$TOK/pay-sandbox
curl -s -o /dev/null -w "  GET /t/<token>/anything-else (not exempt): HTTP %{http_code}\n" $U/t/$TOK/plans
for r in / /api/rent-periods /api/event-log; do curl -s -o /dev/null -w "  GET $r without login: HTTP %{http_code}\n" $U$r; done
curl -s -o /dev/null -w "  POST /reminders/run without login: HTTP %{http_code}\n" -X POST $U/reminders/run
echo "  landlord-only actions in the tenant page HTML (/plans/ approve|reject, /reminders, court-packet, /api/, Approve plan, Send reminders): $(cat $T/t*.html $T/p*.html | grep -c -E '/plans/|/reminders|court-packet|/api/|Approve plan|Send reminders|Cancel plan')"
echo "  form actions on the tenant page: $(cat $T/t*.html | grep -o 'action="[^"]*"' | sort -u | sed "s#$TOK#<token>#g" | tr '\n' ' ')"
echo "  other tenant's name/token in this tenant's page: $(cat $T/t*.html | grep -c -e "$OTHER" -e 'Priya' -e 'Okafor')"
for r in /api/rent-periods /api/event-log /api/rent-periods/1001/plans /api/rent-periods/1001/court-packet.json /api/reminders; do
  echo "  tokens in landlord API $r: $($L $U$r | grep -c -e "$TOK" -e "$OTHER")"; done
$L $U/ > "$T/dash.html"; echo "  landlord dashboard: $(grep -c 'Copy tenant link' "$T/dash.html") 'Copy tenant link' buttons; $(grep -o 'data-path="/t/[A-Za-z0-9_-]*"' "$T/dash.html" | sort -u | wc -l) distinct /t/<token> paths"
curl -s -D - -o /dev/null $U/t/$TOK | grep -i -E '^(cache-control|referrer-policy|x-robots-tag|x-frame-options)' | tr -d '\r' | sed 's/^/  header: /'
kill $PID; wait $PID 2>/dev/null; trap - EXIT
grep -i 'error\|fail' "$T/server.log" | grep -v '^\[auth\]' | head -5 | sed 's/^/  server.log: /'
echo "files in $T"
