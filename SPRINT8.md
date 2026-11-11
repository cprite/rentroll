# Sprint 8: shared demo login (HTTP Basic Auth)

Branch `sprint8-basic-auth` from `main` @ `7da0287`. Not merged, not pushed.

## Values for hack-lead

Add to `~/.openclaw/credentials/hackathons/paypal-ai-hackathon-2026/app.env`, then restart `rentroll.service`:

```
DEMO_USER=judge
DEMO_PASSWORD=8c8r45j5md
```

This is not a secret. It is published in README.md and SUBMISSION.md for judges. (I can't write to that file from my sandbox.)
If the service starts without these two variables, the login falls back to `demo` / `demo` and logs
`[auth] DEMO_USER/DEMO_PASSWORD not set: using local-dev login demo/demo`. Then the published login won't work, so set them before restarting.

## What changed

- `lib/auth.js` (new, 35 lines): `basicAuth()` middleware. Reads `DEMO_USER` / `DEMO_PASSWORD`. Compares SHA-256 digests of the
  submitted and expected user and password with `crypto.timingSafeEqual`, so both buffers are always 32 bytes, and evaluates both checks without short-circuiting.
  A missing or wrong login gets `401`, `WWW-Authenticate: Basic realm="RentRoll"`, and a plain-text body. No new dependencies.
- `server.js`: imports it and adds `app.use(basicAuth())` as the first middleware in `buildApp`. No route or handler changed.
  I also updated the TODO comment about the public routes.
- `README.md`, `SUBMISSION.md`: replaced the "No login" lines with the published login and added the two env vars to the README env list.

## Routes left open, and why

The open routes are listed explicitly in `lib/auth.js` (method + path, lowercased, trailing slash ignored, which matches Express's default routing). They don't depend on route order.

| Route | Why it's open |
|---|---|
| `GET /healthz` (and `HEAD`) | Monitoring and uptime checks. |
| `POST /webhooks/paypal` | PayPal can't send Basic Auth. This route is protected by PayPal signature verification (enforce mode by default), which is unchanged. |

Everything else needs the login, including `GET /webhooks/paypal`, `POST /healthz` and unknown paths.

## Test evidence

How I tested: `node server.js` on 127.0.0.1:8799 with a throwaway DB `RENTROLL_DB=$TMPDIR/s8/test.db` (freshly seeded),
a throwaway `RENTROLL_WEBHOOK_LOG=$TMPDIR/s8/wh.jsonl`, `DEMO_USER=judge`, `DEMO_PASSWORD=8c8r45j5md`, and the real PayPal sandbox and NVIDIA creds from env.
I didn't touch the real `data/rentroll.db`, the real webhook log, or the live service on :8790.

**No credentials on `GET /`:**
```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Basic realm="RentRoll"
Content-Type: text/plain; charset=utf-8
```
**Correct `-u judge:8c8r45j5md` on `GET /`:** `200 text/html; charset=utf-8 12475B`, `<title>RentRoll · November 2026 rent`, The page renders the dashboard forms as before. After the test flow it had 8 forms: `/rent-periods/{1,2,3}/messages`, `/rent-periods/{1,2,3}/pay-sandbox`, `/plans/1/reject` and `/reminders/run`.

**`GET /healthz`, no credentials:** `HTTP/1.1 200 OK` `{"ok":true,"service":"rentroll","db":"test.db"}`. `/healthz/`, `/HEALTHZ` and `HEAD /healthz` also return 200.

**`POST /webhooks/paypal`, forged body, no paypal-* headers, no credentials:**
```
HTTP/1.1 400 Bad Request
{"ok":false,"result":"rejected_signature","verification":"SKIPPED_NO_HEADERS"}
```
Server log: `[webhook] PAYMENT.CAPTURE.COMPLETED WH-FORGED-S8 → rejected_signature (sig SKIPPED_NO_HEADERS)`. The request reached the existing check, not the auth layer.
The same request with a wrong Basic Auth header also returned `400`.

**Wrong credentials.** Codes for no credentials / `judge:wrong` / `admin:8c8r45j5md`:
```
GET  /                                       401 401 401
GET  /api/rent-periods                       401 401 401
GET  /api/event-log                          401 401 401
POST /api/rent-periods/1/pay-sandbox         401 401 401
POST /rent-periods/1/pay-sandbox             401 401 401
POST /api/rent-periods/1/messages            401 401 401
POST /rent-periods/1/messages                401 401 401
POST /api/plans/1/approve                    401 401 401
POST /plans/1/reject                         401 401 401
POST /api/reminders/run                      401 401 401
POST /reminders/run                          401 401 401
GET  /api/rent-periods/1/plans               401 401 401
GET  /api/rent-periods/1/court-packet.pdf    401 401 401
GET  /api/reminders                          401 401 401
GET  /webhooks/paypal                        401 401 401
POST /healthz                                401 401 401
GET  /nope                                   401 401 401
```
Malformed headers: `Bearer x`, `Basic !!!`, and base64 with no colon all return 401. A lowercase `basic` scheme with the right login returns 200, which is correct: auth schemes are case-insensitive under RFC 7235.

**Full flow with the login (real NVIDIA LLM and real PayPal sandbox):**
1. `POST /api/rent-periods/1/messages` "Can I pay $900 now and the rest in two weeks?" returned `200`. Plan #1 was `proposed` with $900.00 due 2026-11-11 and $900.00 due 2026-11-25.
2. `POST /api/plans/1/approve` returned `200`. Installment 1 was `DUE` at $900.00.
3. `POST /api/rent-periods/1/pay-sandbox {"amount_cents":100}` returned `422`: `approved plan #1 only accepts installment 1 of 2: exactly $900.00 ... $1.00 refused`. Plan enforcement still works.
4. `POST /api/rent-periods/1/pay-sandbox {"amount_cents":90000}` returned `200` with `status COMPLETED`, PayPal order `00350277ET3138154`, capture `2MU358374S2896049`, fee $29.01.
5. Dashboard form routes with the login all returned `303` back to `/`: `POST /plans/99999/reject` with `?err=plan 99999 not found`, `POST /reminders/run` with `?ok=Reminder check ran...`, and `POST /rent-periods/2/pay-sandbox amount=abc` with `?err=amount must be a dollar amount...`.
6. `GET /api/rent-periods` and `GET /api/rent-periods/1/court-packet.pdf` with the login returned `200` (JSON and `application/pdf`).

**Login fallback with the env vars unset:** no credentials returns `401` and `demo:demo` returns `200`. The startup warning is logged as shown above.

## Notes

- PayPal will send the signed `PAYMENT.CAPTURE.COMPLETED` webhook for capture `2MU358374S2896049` to the live service through the public URL, not to my test server.
  The live DB has no payment for that capture. I didn't check how the live service records it, and I didn't touch the live log or DB. Earlier sprint testers' sandbox payments did the same.
- Once you log in, browsers resend the login automatically on form posts and redirects, so the no-JS dashboard needed no changes.
- `curl -u` / `-w %{redirect_url}` shows `judge:8c8r45j5md@` in redirect URLs. That's curl echoing the credentials; the server sends a relative `Location: /?...`.
