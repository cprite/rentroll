#!/usr/bin/env bash
# Sprint 4 offline check: no LLM (unreachable on purpose, so drafts use the template fallback), no PayPal capture.
# Synthetic DB rows only. Covers: approved-plan installment targeting, plan "not due yet" skip, pending-payment skip,
# paid-in-full with a stale cached flag, and a balance change re-opening the rate limit. Run from app-sprint4/.
set -u
T="$TMPDIR/s4off"; rm -rf "$T"; mkdir -p "$T"
export RENTROLL_DB="$T/test.db" RENTROLL_WEBHOOK_LOG="$T/wh.jsonl" PORT=8796 LLM_BASE_URL=http://127.0.0.1:1/v1
node server.js --seed --reset >/dev/null && node scripts/sprint4-testdb.mjs "$RENTROLL_DB" >/dev/null
sql() { node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.RENTROLL_DB);d.exec(process.argv[1])' "$1"; }
# 941: approved plan $900 on 11-12, $900 on 11-20.  942: fully paid (COMPLETED row) but cached status UNPAID.  943: a PENDING payment.
sql "INSERT INTO plan (rent_period_id,status,installments_json,approved_at) VALUES (941,'approved','[{\"due_date\":\"2026-11-12\",\"amount_cents\":90000},{\"due_date\":\"2026-11-20\",\"amount_cents\":90000}]','2026-11-10T00:00:00Z');
 INSERT INTO payment (rent_period_id,installment_index,source,status,amount_cents,custom_id,paid_at,webhook_event_id) VALUES (942,1,'paypal_capture','COMPLETED',120000,'RR:test:942','2026-11-09T10:00:00Z','WH-SYNTHETIC-1');
 INSERT INTO payment (rent_period_id,installment_index,source,status,amount_cents,custom_id) VALUES (943,1,'paypal_capture','PENDING',95000,'RR:test:943');"
run() { # $1 = RENTROLL_TODAY
  RENTROLL_TODAY=$1 node server.js >>"$T/server.log" 2>&1 & PID=$!; sleep 1.2
  echo "--- today=$1 ---"
  curl -s -X POST http://127.0.0.1:8796/api/reminders/run | python3 -c 'import sys,json;r=json.load(sys.stdin);[print(" ",x["unit"],x["action"],x.get("target_key"),x.get("tier"),x.get("days_overdue"),"|",x.get("reason") or x.get("text")) for x in r["results"]]'
  kill $PID; wait $PID 2>/dev/null
}
run 2026-11-11        # 941 plan inst 1 not due yet; 942 paid (stale flag ignored); 943 pending
sql "UPDATE payment SET status='FAILED' WHERE rent_period_id=943"
run 2026-11-14        # 941 plan inst 1 2 days overdue -> friendly on plan941:i1; 943 6 days -> firm
run 2026-11-14        # repeat: both rate-limited
sql "INSERT INTO payment (rent_period_id,installment_index,source,status,amount_cents,custom_id,paid_at) VALUES (943,2,'paypal_capture','COMPLETED',45000,'RR:test:943b','2026-11-14T09:00:00Z')"
run 2026-11-14        # 943 balance changed 950 -> 500: new reminder allowed inside the window; 941 still rate-limited
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.RENTROLL_DB);for(const r of d.prepare("SELECT id,rent_period_id,json_extract(payload_json,?) k,json_extract(payload_json,?) t FROM event_log WHERE kind=? ORDER BY id").all("$.target_key","$.tier","reminder_sent"))console.log("  event_log",r.id,r.rent_period_id,r.k,r.t)'
