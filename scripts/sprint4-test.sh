#!/usr/bin/env bash
# Sprint 4 real test: real LLM drafts, real PayPal sandbox captures, separate test DB (ids offset to 941-943).
# Run from app-sprint4/ with the build env (PAYPAL_*, NVIDIA_API_KEY, LLM_*). Prints no credentials.
set -u
T="$TMPDIR/s4real"; rm -rf "$T"; mkdir -p "$T"
export RENTROLL_DB="$T/test.db" RENTROLL_WEBHOOK_LOG="$T/wh.jsonl" PORT=8797 NODE_USE_ENV_PROXY=1
U=http://127.0.0.1:8797; J='-H Content-Type:application/json'
node server.js --seed --reset >/dev/null && node scripts/sprint4-testdb.mjs "$RENTROLL_DB" >/dev/null
start() { RENTROLL_TODAY=$1 node server.js >>"$T/server.log" 2>&1 & PID=$!; sleep 1.5; echo "=== server up, RENTROLL_TODAY=$1 ($(date -u +%H:%M:%SZ)) ==="; }
stop() { kill $PID; wait $PID 2>/dev/null; }
pay() { echo "\$ POST /api/rent-periods/$1/pay-sandbox {\"amount\":\"$2\"}"
  curl -s -X POST $J -d "{\"amount\":\"$2\"}" $U/api/rent-periods/$1/pay-sandbox | python3 -c 'import sys,json;r=json.load(sys.stdin);p=r.get("payment") or {};print("  ok=",r["ok"],r.get("error",""),"capture",p.get("paypal_capture_id"),p.get("status"),"| period",r.get("rent_period"))'; }
show() { python3 -c '
import sys,json; r=json.load(sys.stdin)
print("  today=%s run_at=%s drafted=%s skipped=%s would_draft=%s" % (r["today"], r["run_at"], r["drafted"], r["skipped"], r.get("would_draft")))
for x in r["results"]:
  print("  [%s rp%s] %s  target=%s owed=%s days_overdue=%s tier=%s fee=%s prior=%s last_event=%s changed=%s" % (x["unit"], x["rent_period_id"], x["action"].upper(), x.get("target_key"), x.get("owed_cents"), x.get("days_overdue"), x.get("tier"), x.get("late_fee_applicable"), x.get("prior_reminders"), x.get("last_reminder_event_id"), x.get("changed_since_last")))
  if x.get("reason"): print("      reason:", x["reason"])
  if x.get("text"): print("      event_log #%s, drafted_by=%s%s\n      TEXT: %s" % (x["event_log_id"], x["drafted_by"], (" (" + x["fallback_reason"] + ")") if x.get("fallback_reason") else "", x["text"]))
'; }
run() { echo "\$ POST /api/reminders/run$1"; curl -s -X POST "$U/api/reminders/run$1" | show; }

start 2026-11-11
pay 942 1200.00                                     # Unit 3 pays in full (real sandbox capture)
node scripts/sprint4-testdb.mjs "$RENTROLL_DB" stale 942   # fake a stale "still UNPAID" cached flag
run '?dry_run=1'
run ''                                              # 1st real run
run ''                                              # 2nd run straight away: must be a no-op
pay 941 500.00                                      # Unit 2 pays part (real capture): balance changes
run ''                                              # only Unit 2 re-opens (amount changed), Unit 4 still rate-limited
stop
start 2026-11-20                                    # simulated later date: real days overdue grow
run ''                                              # escalation: Unit 2 firm -> formal, Unit 4 friendly -> firm
run ''                                              # and again a no-op
curl -s $U/ > "$T/dash.html"; stop
echo "=== event_log reminder_sent rows ==="
node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.RENTROLL_DB);for(const r of d.prepare("SELECT id,at,rent_period_id,json_extract(payload_json,?) k,json_extract(payload_json,?) t,json_extract(payload_json,?) n,json_extract(payload_json,?) o,json_extract(payload_json,?) p FROM event_log WHERE kind=? ORDER BY id").all("$.target_key","$.tier","$.reminder_number","$.owed_cents","$.previous_reminder_event_id","reminder_sent"))console.log(" ",r.id,r.at,"rp"+r.rent_period_id,r.k,r.t,"#"+r.n,"owed",r.o,"prev_event",r.p)'
echo "=== dashboard (text-extracted reminder boxes) ==="
python3 - "$T/dash.html" <<'PY'
import re,sys,html
s=open(sys.argv[1]).read()
print("  button:", "Send reminders now" in s and 'action="/reminders/run"' in s)
for b in re.findall(r'<tr class="remrow">(.*?)</tr>', s, re.S):
  t=html.unescape(re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',b))).strip(); print("  -", t)
PY
