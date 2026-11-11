# SPRINT 7: README and SUBMISSION (2026-11-11)

Branch `sprint7-polish`. Wrote `README.md` and `../SUBMISSION.md` (Devpost text) with the Sepia skill. LICENSE not touched.

Facts come from SPRINT0-4, SPRINT1-FIX, TESTER1/TESTER3 verdicts, BRIEF.md, RULES.md, HANDOFF.md.

## Things hack-lead should check at merge
- Court packet: both docs describe it as "included in the final build" from the Sprint 6 branch. If it doesn't merge, remove it from README "What it does", SUBMISSION description/demo flow/step 6, and drop `pdfkit` from Built With. Check the real button label and fix step 6 to match.
- Invoicing: both docs say plainly that PayPal Invoicing returned 403, so payments use Orders and our server enforces the plan. BRIEF.md's `allow_partial_payment` story is NOT claimed. If Invoicing gets enabled and wired later, update both docs.
- Fee: used the measured sandbox fee ($25.82 on $800, 2.99% + $0.49, SPRINT0) and BRIEF.md's ~3.49% / ~$60 figure. Re-check against PayPal's current US pricing page before submitting.
- `PUBLIC_BASE_URL` is read only by `scripts/sprint0-webhook.mjs` in this branch. `PAYPAL_WEBHOOK_ID` was added to the README env list because local runners need it for signature checks (server.js falls back to our webhook id).
- Hosted demo has no login, so anyone can approve/reject plans, run sandbox captures and change the demo state. Consider a reset before judging.
- Judging-period promise ("repo and demo stay up through Dec 15") depends on `rentroll.service` staying up; TESTER3 found it dead once.
- Testing steps 1-5 match the dashboard labels in server.js on this branch ("Tenant texted", "Approve plan", "Tenant pays installment N of M", "Send reminders now"). Not clicked in a browser.
