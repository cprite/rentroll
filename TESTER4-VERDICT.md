# TESTER4 verdict: sprint6-court-packet

**The branch passes.** I fetched the court packet PDF over real HTTP after a new real sandbox capture. The PDF parses strictly with pypdf and with pdfinfo. Its text, the `.json` and a direct DB query agree on every key fact: order id, capture id, amount, fee, net, balance and webhook event id. The SHA-256 I recomputed from `event_log` matches the one in the packet. Edge cases return clean 404/400 JSON. The core loop still works: pay-sandbox, then PayPal's real signed webhook, then verification SUCCESS. A forged webhook is still rejected with 400. `LICENSE` is the standard MIT template.

**Setup.** Branch `sprint6-court-packet` @ `5aa3cd4` (`main` @ `cf09e79`), in the `app/` working tree.
- Throwaway DB `$TMPDIR/t4/t4.db`, test webhook log `$TMPDIR/t4/wh.jsonl`, `PORT=8812`, `NODE_USE_ENV_PROXY=1`.
- Ran `node server.js --seed`, then `scripts/sprint4-testdb.mjs` to move the rent-period ids to 941/942/943.
- Own script, `$TMPDIR/t4bin/run.sh`, ran everything in one shell (the sandbox gives each command its own network namespace, so the server and curl have to share one call).
- Did not edit product code, touch `data/rentroll.db` or `main`, or push. Only read the live webhook log. `git status` is clean afterwards.
- Wrote own checks, did not run the builder's `sprint6-test.sh` or `sprint6-verify-pdf.py`.

## 1. Fresh install and smoke: PASS
- `npm install` → `found 0 vulnerabilities`. `node_modules/pdfkit` is version `0.20.2`.
- `GET /healthz` → `{"ok":true,"service":"rentroll","db":"t4.db"} [HTTP 200]`
- `GET /` → `HTTP 200 12493B`. After the run it was `13072B`. Grepping for `error|stack|node_modules` found 0 matches.
- `server.log` has no stack traces. Its only lines are `listening` and the rejected forged webhook.

## 2. Court packet PDF after a real payment: PASS
- `POST /api/rent-periods/941/pay-sandbox {"amount":"400.00"}` returned HTTP 200 `COMPLETED` at 02:22:07Z:
  - order `64U84598H2840461R`, capture `9XJ58670B1208173U`, debug `f878196ffb770`
  - fee 1306, net 38694, `custom_id RR:rp941:2026-11:u1:i1:70eb248a`
  - `rent_period {"before":"UNPAID","status":"PARTIALLY_PAID","paid_cents":40000,"balance_cents":140000}`
- PayPal's real signed webhook reached the **live** log about 20 s later, at 02:22:28Z. Copied that one line into the test log and ran `node server.js --ingest-webhook-log`:
  - `{"result":"payment_confirmed","payment_id":1,…,"event_id":"WH-6CS43453DN492314C-2DX0013846154241D","event_type":"PAYMENT.CAPTURE.COMPLETED","verification":"SUCCESS","via":"backfill"}`
  - Re-ingesting it → `{"result":"duplicate",…}`
- `GET /api/rent-periods/941/court-packet.pdf` → `HTTP 200 4401B application/pdf`
  - Headers: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="rentroll-unit-2-2026-11-payment-record.pdf"`, `Cache-Control: no-store`
  - First bytes `%PDF-1.3`. File ends `startxref\n3886\n%%EOF\n`.
- `pdfinfo`: no errors; `Pages: 1`, `Title: RentRoll payment record: Unit 2, November 2026`, letter size, `File size: 4401 bytes`.
- `pypdf 6.13.2` with `strict=True` parsed it: 1 page, 2666 characters of text. rp942/rp943 packets also parse strictly (3561B/3556B, 1 page each).
- `pdftotext -layout` gives 54 lines with the right order id/capture id/webhook id/amount/fee/net counts.
- Content reads correctly: "$400.00 of $1,800.00 paid; $1,400.00 outstanding as of 2026-11-11", "10 days overdue", the late-fee rule note, "Webhook confirmed: Yes" with PayPal event id, times, and signature verification SUCCESS, the ledger rows, and the Integrity SHA-256.

## 3. Court packet JSON against the DB: PASS
- `court-packet.json` summary/payments match a direct `sqlite3` query exactly (amounts, fee, net, order/capture ids, webhook_confirmed).
- Recomputed SHA-256 in Python over the included ledger rows **matches** `integrity.sha256` in the packet and the PDF.

## 4. Edge cases: PASS
404/400 JSON for missing/invalid ids (999, abc, 0, -3, 1.5); `1e2` reads as 100 (m1, cosmetic). Nothing crashed; `/healthz` stayed 200.

## 5. Regression smoke: PASS
Dashboard shows the court-packet download links; pay-sandbox + real webhook confirmation still works; forged webhook (F1) still rejected 400 with no state change.

## 6. LICENSE: PASS
`app/LICENSE` (commit `5aa3cd4`) is byte-identical to the canonical MIT template from line 5 on; line 1 "MIT License", line 3 "Copyright (c) 2026 Nikolay (cprite)".

## Minor findings (do not block)
- **m1:** `1e2`/`0x10`-style ids parse as numbers instead of 400 — cosmetic.
- **m2:** the real $400 test capture's webhook reached the live service and logged an "unmatched" row — same harmless pattern as earlier sprints.
- **m3:** the PDF route is public via the Funnel and exposes tenant PII (existing auth TODO, already in SPRINT6.md).
- **m4:** the live `rentroll.service` needs `npm install` (for pdfkit) and a restart after merging, before the new route goes live.

TESTER4 VERDICT: PASS
