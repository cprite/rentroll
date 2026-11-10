#!/usr/bin/env bash
# Sprint 3 offline check: no LLM, no PayPal capture. Inserts a synthetic proposed plan, approves it, and checks
# that pay-sandbox refuses a non-matching amount BEFORE any PayPal call. Run from app-sprint3/.
set -u
T="$TMPDIR/s3off"; rm -rf "$T"; mkdir -p "$T"
export RENTROLL_DB="$T/test.db" RENTROLL_WEBHOOK_LOG="$T/wh.jsonl" PORT=8793 RENTROLL_TODAY=2026-11-10
node server.js --seed --reset >/dev/null && node scripts/sprint3-testdb.mjs "$RENTROLL_DB" >/dev/null
node -e '
const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(process.env.RENTROLL_DB);
const ins = (st) => d.prepare("INSERT INTO plan (rent_period_id,status,installments_json) VALUES (931,?,?)").run(st, JSON.stringify([{due_date:"2026-11-10",amount_cents:90000},{due_date:"2026-11-20",amount_cents:90000}]));
ins("proposed"); ins("needs_review");
d.prepare("INSERT INTO plan (rent_period_id,status,installments_json) VALUES (932,?,?)").run("proposed", JSON.stringify([{due_date:"2026-11-20",amount_cents:50000}]));'
node server.js >"$T/server.log" 2>&1 & PID=$!; sleep 1.5
c() { echo "\$ $*" | sed "s#http://127.0.0.1:8793##"; curl -s -w '  -> HTTP %{http_code}\n' "$@"; }
J='-H Content-Type:application/json'
c -X POST http://127.0.0.1:8793/api/plans/2/approve                       # needs_review -> 409
c -X POST http://127.0.0.1:8793/api/plans/3/approve                       # stale: 500 != 1200 -> 409
c -X POST http://127.0.0.1:8793/api/plans/abc/approve                     # 400
c -X POST http://127.0.0.1:8793/api/plans/99/approve                      # 404
c -X POST http://127.0.0.1:8793/api/plans/1/approve | head -c 400; echo
c -X POST http://127.0.0.1:8793/api/plans/1/approve | head -c 300; echo  # already approved -> 409
c -X POST $J -d '{"amount":"800.00"}'  http://127.0.0.1:8793/api/rent-periods/931/pay-sandbox
c -X POST $J -d '{"amount":"1800.00"}' http://127.0.0.1:8793/api/rent-periods/931/pay-sandbox
c -X POST --data-urlencode amount=5 -o /dev/null -D - http://127.0.0.1:8793/rent-periods/931/pay-sandbox | grep -i '^location' | python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read()))'
curl -s http://127.0.0.1:8793/api/rent-periods/931/plans | python3 -c 'import sys,json;[print(p["id"],p["status"],p.get("enforced"),[x["label"] for x in p.get("schedule") or []]) for p in json.load(sys.stdin)]'
curl -s http://127.0.0.1:8793/ > "$T/dash.html"; grep -o 'Tenant pays installment [0-9] of [0-9]\|🔒 [^<]*\|Locked by approved plan[^<]*\|On approved plan[^<]*' "$T/dash.html" | sort -u
c -X POST http://127.0.0.1:8793/api/plans/1/reject | head -c 200; echo
c -X POST $J -d '{"amount":"5000.00"}' http://127.0.0.1:8793/api/rent-periods/931/pay-sandbox   # back to Sprint 1 rule
sqlite3 -version >/dev/null 2>&1; node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(process.env.RENTROLL_DB);for(const r of d.prepare("SELECT id,kind,actor,summary FROM event_log WHERE kind LIKE ? ORDER BY id").all("plan_%"))console.log(r.id,r.kind,r.actor,r.summary); console.log("payments:", d.prepare("SELECT COUNT(*) n FROM payment").get().n)'
kill $PID
