# SPRINT 12: a real login page instead of the browser's Basic Auth prompt (2026-11-11)

**Branch:** `sprint12-login-page` (worktree `app-sprint12/`, based on `main` `2e320d4`). Commit `55a1d25`. Nothing
pushed. `app/` and other worktrees untouched. The demo login is not rotated and its values appear nowhere in code,
docs, commits or this report.

## Why
The browser's native HTTP Basic Auth dialog can't show any text, so judges had no hint where the login is. A
RentRoll-styled page can.

## What changed
- **`GET /login`** (`lib/auth.js`): phone-first card in the app's own colour tokens (same `:root` as the dashboard
  and tenant page), 17px inputs, 52px button. Under the form: "Judges: the login is in the 'Try it' section at the
  top of the project description on Devpost." `?err=1` shows "Wrong username or password." above the form; any other
  `err` value shows a fixed "Please sign in again." (query text is never echoed). Already signed in → 302 to `next`
  (or `/`). `Cache-Control: no-store`, `X-Frame-Options: DENY`, `noindex`.
- **`POST /login`** (`express.urlencoded`, 8 kB): compares `username`/`password` with `DEMO_USER`/`DEMO_PASSWORD`
  via sha256-then-`timingSafeEqual` on both fields (both always compared, combined with `&`). Success → session
  cookie + 302 to `next`. Failure → 302 `/login?err=1` (keeps `next`), never says which field was wrong.
- **Logout:** both `GET /logout` and `POST /logout` clear the cookie (`Max-Age=0`) and 302 to `/login`. The
  dashboard header has a "Sign out" button (POST form).
- **Session cookie** `rr_session`, `node:crypto` only (dependencies still just express + pdfkit):
  `<base64url({"iat":<unix s>})>.<hex HMAC-SHA256>`, attributes `Max-Age=2592000; Path=/; HttpOnly; Secure;
  SameSite=Lax` (`Secure` unconditional: the demo is always https via Tailscale Funnel; curl on localhost still
  accepts it). Secret = `SESSION_SECRET` or `randomBytes(32)` at boot (sessions don't survive a restart without the
  env var; fine for the demo). The HMAC key is derived from the secret plus a hash of the login, so rotating
  the password invalidates old cookies. Verification: strict format regex, recomputed HMAC compared with
  `timingSafeEqual` (equal-length by construction), `iat` must be an integer and younger than 30 days. Cookie
  header parsed by hand.
- **Gate** (same `EXEMPT` + `TENANT_ROUTE` as Sprint 11, plus `/login` and `/logout`): no valid session →
  GET/HEAD get 302 `/login?next=<original URL, encoded>`; every other method gets
  `401 {"ok":false,"error":"login required: sign in at /login"}`. `next` is accepted only as a same-origin path:
  starts with `/`, not `//` or `/\`, no control chars, ≤2048 chars, not `/login`/`/logout`; otherwise `/`.
- **Order in `server.js`:** the gate is still the first `app.use`, it never reads the body, so the webhook's
  `express.raw()` still gets the untouched bytes; signature verification unchanged.
- **Docs:** README env block and SUBMISSION judge instructions now describe the sign-in page; `SESSION_SECRET`
  documented.

## Decisions / deviations from the brief
- **HTTP Basic Auth is still accepted** as an alternative credential (same login, same constant-time compare) so
  the Sprint 10/11 test scripts (`curl -u`) and API users keep working. The server never sends `WWW-Authenticate`,
  so browsers never show the native prompt. Remove `basicOk` in `lib/auth.js` to make it cookie-only.
- `?err=` maps to fixed messages instead of being displayed verbatim (no content injection on the login page).
- GET on `/api/...` without a session redirects to `/login` like any GET (brief rule taken literally); only
  non-GET/HEAD gets the 401 JSON.
- No login rate limit (Basic Auth had none either; behind Funnel every request comes from 127.0.0.1, so a per-IP
  limit would lock out all judges at once).

## How it was tested
Throwaway server (port 8813, temp DB, `RENTROLL_INVOICING=0`) with a random local-only login (the real
`DEMO_USER`/`DEMO_PASSWORD` were not present in the worker env). Results:
- `GET /` no cookie → `302 /login?next=%2F`; deep link → `next=%2Frent-periods%2F1%2Fcourt-packet.pdf`.
- `GET /login` → 200, exact helper text present (grep count 1).
- wrong/wrong and right-user/wrong-password → `302 /login?err=1`, no `Set-Cookie`.
- correct login → 302 to `next`, `Set-Cookie` with HttpOnly, Secure, SameSite=Lax, Max-Age, Path.
- that cookie (curl jar and raw header) → `GET /` 200, dashboard title + "Sign out"; `GET /login` → 302 to `next`.
- `POST /api/rent-periods/1/messages` and `POST /reminders/run` without cookie → 401 JSON.
- `/t/<real token>` no login → 200; unknown token → 404 (unchanged).
- forged cookies (garbage, extra char, zeroed MAC, swapped payload `{"iat":1}`, empty) → GET 302 / POST 401, no crash.
- `next` = `//evil.com`, `https://evil.com`, `/\evil`, `/logout` → redirect `/`.
- `/healthz` 200; `POST /webhooks/paypal` with no/forged signature → 400 `rejected_signature` (unchanged).
- Basic Auth with right login → 200; with wrong password → 302 to /login, no `WWW-Authenticate` header.
- GET and POST `/logout` → cookie cleared (`Max-Age=0`), 302 `/login`.

Not tested: expiry of a correctly signed cookie older than 30 days (would need the server's secret); a real browser
render of the page (no browser in the sandbox).

## Independent verification (tester8)
PASS, see `TESTER8-VERDICT.md`. Confirmed live: 10/10 checks, no crashes under 11 forged-cookie variants, open
redirect resistant, webhook signature path untouched, password rotation correctly invalidates old sessions.
