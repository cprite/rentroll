#!/usr/bin/env bash
# Sprint 6 real test: build a realistic history on a THROWAWAY DB (ids offset to 941-943 so live webhooks can't
# touch it), then fetch the court packet over HTTP and verify it as a PDF. Run from app/ with the build env.
# Real calls: PayPal verify-webhook-signature (replayed real signed delivery), NVIDIA LLM (reminder + plan),
# one PayPal sandbox capture. Prints no credentials.
set -u
T="$TMPDIR/s6real"; rm -rf "$T"; mkdir -p "$T"
export RENTROLL_DB="$T/test.db" RENTROLL_WEBHOOK_LOG="$T/wh.jsonl" PORT=8806 NODE_USE_ENV_PROXY=1
U=http://127.0.0.1:8806; J='-H Content-Type:application/json'; C="curl -s"
node server.js --seed >/dev/null && node scripts/sprint4-testdb.mjs "$RENTROLL_DB" >/dev/null
# The last real PayPal-signed delivery (Sprint 4: capture 3PW203477K501833J, $500, custom_id RR:rp941...), read-only copy.
SRC=$(ls .sprint0-webhook-log.jsonl.pre-reset-* | head -1)
grep '"WH-3V0415457T004732T-73D02438WF438061X"' "$SRC" | head -1 > "$RENTROLL_WEBHOOK_LOG"
echo "replay source: $SRC ($(wc -c < "$RENTROLL_WEBHOOK_LOG") bytes, 1 delivery)"
node server.js >>"$T/server.log" 2>&1 & PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 30); do $C $U/healthz >/dev/null && break; sleep 0.5; done; sleep 4   # let start-up back-fill verify the signature
echo "=== server up $(date -u +%H:%M:%SZ) ==="; grep -h 'back-filled\|listening' "$T/server.log"
echo '$ POST /api/reminders/run'
$C -X POST $U/api/reminders/run | python3 -c 'import sys,json;r=json.load(sys.stdin)
for x in r["results"]: print("  ",x["unit"],"rp%s"%x["rent_period_id"],x["action"],x.get("tier"),"owed",x.get("owed_cents"),x.get("drafted_by",""),x.get("reason",""))'
echo '$ POST /api/rent-periods/941/messages'
$C -X POST $J -d '{"body":"Sorry about the late rent. I can pay $650 today and the last $650 on the 20th, is that ok?"}' $U/api/rent-periods/941/messages > "$T/plan.json"
python3 -c 'import json;r=json.load(open("'"$T"'/plan.json"));p=r.get("plan") or {};print("  ok",r.get("ok"),"plan",p.get("id"),p.get("status"),[(i["due_date"],i["amount_cents"]) for i in p.get("installments",[])], r.get("error",""))'
PLAN=$(python3 -c 'import json;print(json.load(open("'"$T"'/plan.json"))["plan"]["id"])')
FIRST=$(python3 -c 'import json;print("%.2f"%(json.load(open("'"$T"'/plan.json"))["plan"]["installments"][0]["amount_cents"]/100))')
echo "\$ POST /api/plans/$PLAN/approve"; $C -X POST $U/api/plans/$PLAN/approve | python3 -c 'import sys,json;r=json.load(sys.stdin);print("  ok",r["ok"],r.get("error",""),(r.get("plan") or {}).get("status"))'
echo "\$ POST /api/rent-periods/941/pay-sandbox {\"amount\":\"$FIRST\"}"
$C -X POST $J -d "{\"amount\":\"$FIRST\"}" $U/api/rent-periods/941/pay-sandbox | tee "$T/pay.json" | python3 -c 'import sys,json;r=json.load(sys.stdin);p=r.get("payment") or {};print("  ok",r["ok"],r.get("error",""),"order",p.get("paypal_order_id"),"capture",p.get("paypal_capture_id"),p.get("status"),"fee",p.get("fee_cents"),"| period",r.get("rent_period"))'

# PayPal delivers the signed webhook for this capture to the LIVE service (it logs it there as "unmatched": no rp941 in
# the real DB). Wait for it in the live raw log (read-only), copy that one line into the test log, ingest it into the
# TEST DB: the handler re-verifies the signature with PayPal before it confirms anything.
CAP=$(python3 -c 'import json;print(json.load(open("'"$T"'/pay.json"))["payment"]["paypal_capture_id"])')
echo "waiting up to 120 s for PayPal's webhook for capture $CAP in the live log..."
for i in $(seq 1 60); do grep -q "\"$CAP\"" .sprint0-webhook-log.jsonl 2>/dev/null && break; sleep 2; done
if grep -q "\"$CAP\"" .sprint0-webhook-log.jsonl 2>/dev/null; then
  grep "\"$CAP\"" .sprint0-webhook-log.jsonl | grep PAYMENT.CAPTURE.COMPLETED | head -1 >> "$RENTROLL_WEBHOOK_LOG"
  echo "  arrived after ~$((i*2)) s; ingesting into the test DB:"
  node server.js --ingest-webhook-log | sed 's/^/  /'
else echo "  NOT arrived within 120 s: packet will show payment 2 as captured, not webhook-confirmed"; fi

echo '=== court packet ==='
$C -D "$T/pdf.headers" -o "$T/packet.pdf" -w '  HTTP %{http_code}, %{size_download} bytes, %{content_type}\n' $U/api/rent-periods/941/court-packet.pdf
grep -i 'content-type\|content-disposition' "$T/pdf.headers" | sed 's/^/  /'
$C -o "$T/packet.json" $U/api/rent-periods/941/court-packet.json
$C -o /dev/null -w '  404 check rp 999: HTTP %{http_code}\n' $U/api/rent-periods/999/court-packet.pdf
$C -o /dev/null -w '  400 check rp abc: HTTP %{http_code}\n' $U/api/rent-periods/abc/court-packet.pdf
$C $U/ | grep -o 'href="/api/rent-periods/[0-9]*/court-packet.pdf"[^>]*>Download court packet (PDF)' | sed 's/ title=.*>/ > /;s/^/  dashboard: /'
for id in 942 943; do $C -o "$T/packet$id.pdf" -w "  rp$id packet: HTTP %{http_code}, %{size_download} bytes\n" $U/api/rent-periods/$id/court-packet.pdf; done
kill $PID; wait $PID 2>/dev/null; trap - EXIT
echo "files in $T"
