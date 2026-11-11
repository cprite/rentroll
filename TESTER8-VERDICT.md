# TESTER8 verdict: Sprint 12 (`sprint12-login-page` @ 55a1d25)

**PASS.** Safe to merge. All 10 checks pass on a live server. Nothing blocks the merge. One known limitation (logout is client-side only) is listed under fixes as optional. `SPRINT12.md` did not exist at test time, so its claims could not be compared (see the last line); it has since been added by hack-lead from the builder's own report text.

Setup: throwaway server `127.0.0.1:8813` (port checked free first), temp DB `$TMPDIR/t8/t8.db`, temp webhook log, `RENTROLL_INVOICING=0`, empty PayPal creds, random throwaway `DEMO_USER`/`DEMO_PASSWORD` (not the real login). The sandbox gives each Bash command its own network namespace, so the server and every curl ran inside one script (`$TMPDIR/t8scripts/run.sh`, `run2.sh`). The server was started 6 times (needed for the restart/rotation tests). Each time it was killed by exact PID after checking `/proc/<pid>/cmdline == "node server.js"`. No other worktree was touched.

## 1. Unauthenticated access: PASS
```
GET /                                    -> HTTP/1.1 302 Found / Location: /login?next=%2F
GET /api/rent-periods/1/court-packet.pdf -> 302 / Location: /login?next=%2Fapi%2Frent-periods%2F1%2Fcourt-packet.pdf
GET /login                               -> HTTP/1.1 200 OK, text/html
grep -o (verbatim) -> Judges: the login is in the 'Try it' section at the top of the project description on Devpost.
```
The brief's example path `/rent-periods/1/court-packet.pdf` does not exist. The real route is `/api/rent-periods/:id/court-packet.pdf`. With a cookie, the non-existent path returns 404, not a redirect, which is correct.

## 2. Login flow: PASS
```
wrong user, right pass   -> 302 Location: /login?err=1   (no Set-Cookie)
right user, wrong pass   -> 302 Location: /login?err=1   (no Set-Cookie)
both wrong               -> 302 Location: /login?err=1   (no Set-Cookie)
empty POST body          -> 302 Location: /login?err=1   (no Set-Cookie)
username[]= (array)      -> 302 Location: /login?err=1   (no Set-Cookie)
/login?err=1 shows:        <p class="err" role="alert">Wrong username or password.</p>
/login?err=<script> shows: <p class="err" role="alert">Please sign in again.</p>   (not echoed)
correct, no next ->
  Set-Cookie: rr_session=eyJpYXQiOjE3OTQ0MzkyMzN9.e144e737…8d97; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax
  Location: /
correct, next=/api/rent-periods/1/court-packet.pdf -> same Set-Cookie form, Location: /api/rent-periods/1/court-packet.pdf
```
All three failure cases return byte-identical responses. Code: `credsOk` compares both fields every time (`a & b`), so it never short-circuits.

## 3. Cookie works: PASS
```
GET / -b rr_session=<cookie> -> 200 text/html; 14885B, <title>RentRoll · November 2026 rent</title>, contains action="/logout"
GET /api/rent-periods/1/court-packet.pdf with cookie -> 200 application/pdf 3647B, starts "%PDF-"
GET /login?next=/x while logged in -> 302 Location: /x
```

## 4. API/POST without cookie: PASS
```
POST /api/rent-periods/1/messages (json) -> {"ok":false,"error":"login required: sign in at /login"} [401]
POST /api/reminders/run                  -> same [401]
POST /rent-periods/1/messages (form)     -> same [401]
```
GET routes under `/api/` (for example `court-packet.json`) redirect to `/login` with a 302 instead of returning 401. This is by design: the gate decides by method, not path, and it is the right choice for the PDF download link.

## 5. Tenant routes: PASS
```
token from test DB: 43 chars (BmlbLb…)
GET /t/<token>, no cookie, no auth         -> 200 text/html, <title>RentRoll · November 2026 rent</title>
GET /t/garbageTOKEN123                     -> 404
GET /t/<token>/extra (not an exempt shape) -> 302 to /login (the exemption is narrow)
```

## 6. Cookie forgery: PASS (no crash)
Each forged value got the same response as having no cookie: `302 → /login?next=%2F`.
```
garbage-string                         -> 302
<payload>.<64 zeros>                   -> 302
<other iat payload>.<old valid sig>    -> 302
<iat 9999999999 payload>.<old sig>     -> 302
"" (empty)                             -> 302
<payload>.<sig><sig> (128 hex)         -> 302
<payload>.<SIG UPPERCASE>              -> 302
<payload> (no sig)                     -> 302
%00<valid cookie>                      -> 302
../../<valid cookie>                   -> 302
Cookie: rr_session=junk; rr_session=<valid>  -> 302 (first wins)
Cookie: rr_session=<valid>; rr_session=junk  -> 200
```
Server log after all attempts: `grep -ciE 'error|at .*\.js:'` returned `0`. The log held only the listen line and the two webhook lines. Path tricks without a cookie: `/HEALTHZ` 200 and `/healthz/` 200 (exempt, harmless). `/login/..%2f`, `/t/x/..%2f..%2f` and `GET /webhooks/paypal` all → 302 to login.

## 7. Open redirect: PASS
Post-login `Location` for each `next` value:
```
//evil.com            -> /
https://evil.com/x    -> /
/\evil                -> /
/\\evil.com           -> /
/<TAB>/evil.com       -> /
javascript:alert(1)   -> /
/login, /logout?x     -> /
/%5Cevil.com          -> /%5Cevil.com      (percent-encoded, so browsers treat it as an in-app path; safe)
/%2F%2Fevil.com       -> /%2F%2Fevil.com   (same; safe)
/ok/path?a=1          -> /ok/path?a=1
```
Also: unauthenticated `GET //evil.com` → `/login?next=%2F`. `GET /login?next=//evil.com` puts `value="/"` in the form. Logged-in `GET /login?next=https://evil.com` → `Location: /`.

## 8. No regressions: PASS
```
GET /healthz -> {"ok":true,"service":"rentroll","db":"t8.db"} [200]
POST /webhooks/paypal, forged paypal-transmission-sig headers ->
  {"ok":false,"result":"rejected_signature","verification":"ERROR_PAYPAL_CLIENT_ID/SECRET not set"} [400]
POST /webhooks/paypal, no signature headers ->
  {"ok":false,"result":"rejected_signature","verification":"SKIPPED_NO_HEADERS"} [400]
```
`git diff main...sprint12-login-page -- server.js` has 0 hunks touching `handleWebhook`, `verifySignature` or the webhook handler. The only server.js changes are the import, the logout button CSS and HTML, and the `buildApp` gate wiring. `express.raw()` still gets the untouched body because the gate never reads it. Note: the live run proves rejection without PayPal creds. With real creds, `verify-webhook-signature` would return FAILURE for a forged signature, and the code path is unchanged.

Logout:
```
POST /logout -> 302 Location: /login
  Set-Cookie: rr_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax
cookie returned by logout ('') -> 302 /login?next=%2F
curl cookie-jar flow: before logout 200 -> GET /logout 302 /login -> after logout 302 /login?next=%2F
OLD pre-logout cookie value replayed by hand -> 200   (see fixes: stateless sessions)
```
HTTP Basic for scripts: right login → 200. Wrong password → 302 to /login with no `WWW-Authenticate` header, so browsers never show the native prompt.

## 9. Code read: PASS
- HMAC check: `timingSafeEqual(Buffer.from(sign(m[1]),'hex'), Buffer.from(m[2],'hex'))`. The regex `^…\.([0-9a-f]{64})$` comes first, so the buffers are always 32 bytes and `timingSafeEqual` cannot throw. Credentials are compared as `timingSafeEqual` over SHA-256 digests. There is no `===` on secrets anywhere.
- Secret: `process.env.SESSION_SECRET || randomBytes(32).toString('hex')`, a CSPRNG value generated once at boot. Live: after a plain restart without SESSION_SECRET, the old cookie → 302.
- Password rotation: the HMAC key is `HMAC(SECRET, sha256(user\0password))`. Live with a pinned `SESSION_SECRET`: fresh cookie → 200. Restart with the same password → 200. Restart with a ROTATED password → 302 /login. A stolen cookie dies on rotation.
- Expiry: the server checks `iat` itself (30 days, 60 s allowance for clock skew), so it does not rely on the browser's Max-Age.
- Weakness (minor, by design): sessions are stateless, so logout only clears the browser's copy. A copied cookie value stays valid until 30 days pass, the password rotates, or the process restarts without SESSION_SECRET. That is acceptable for "keep random visitors out".

## 10. Judge experience: PASS (layout calculated from CSS; no screenshot)
- On-brand: the `:root` palette in `lib/auth.js` is byte-identical to the dashboard's. Same system-ui font stack, same `Rent<span>Roll</span>` logo with the brand-blue span, same tagline, same orange "PayPal sandbox" badge. White card on `#f6f7fb` with 14px radius, 52px brand-blue button, `noindex`. It looks like an intentional page, not a bare form.
- Above the fold at 390px: headless Chromium could not run in this sandbox (`FATAL … process_singleton_posix.cc:297 socket() failed: Operation not permitted`), so this is a calculation from the CSS, not a screenshot. Top padding 12vh ≈ 101px, logo ≈ 41, tagline ≈ 44, card ≈ 332 (≈ 380 with the error box), then 16px margin and the 2-line helper (≈ 40px at 14px over 346px width). The helper's bottom edge lands at ≈ 575px (≈ 620px with the error), inside an 844px iPhone viewport and inside ≈ 664px of Safari's visible area with its toolbars. It is visible without scrolling. One caveat: the helper sits below the card, so an open on-screen keyboard would cover it.

## Fixes before merging
- **Nothing blocking.**
- Optional: logout could invalidate server-side, for example with a per-process `notBefore` timestamp or an in-memory revoked set, if "Sign out" should kill copied cookies. It is not needed for this demo's threat model.
- Optional: move the Judges helper line above the card, or into it under the heading, so it stays visible even with the mobile keyboard open.

## SPRINT12.md vs. findings
`SPRINT12.md` did **not exist** at test time: not in the worktree, not in git history on any branch (`git log --all -- SPRINT12.md` was empty), and not found anywhere under the hackathon folder. So there was no "How it was tested" section to check at the time. The only builder claims available then were in the 55a1d25 commit message, and every one of them held up in the live run: HttpOnly/Secure/SameSite=Lax/30d, GET→302 vs other methods→401 JSON, exempt set, Basic accepted, no WWW-Authenticate.
