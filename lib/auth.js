// One shared demo login for the hosted demo. A casual gate to keep random visitors off the Funnel URL, not a real
// auth system: the login is given to judges out-of-band (Devpost), never published in this repo.
// Sprint 8 used HTTP Basic Auth; Sprint 12 replaces the browser's native prompt with a RentRoll-styled /login page
// (which can show judges a helper line) and a signed session cookie. No new dependency: node:crypto only.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

// Routes that must stay open. The webhook cannot log in; its protection is PayPal signature verification.
// /login and /logout are open too, or the gate would redirect to itself.
const EXEMPT = new Set(['GET /healthz', 'HEAD /healthz', 'POST /webhooks/paypal',
  'GET /login', 'HEAD /login', 'POST /login', 'GET /logout', 'POST /logout']);
// Sprint 11: the tenant's own page. Its protection is the unguessable per-tenant token in the URL (checked by the
// route itself; an unknown token is a plain 404). Only these three shapes are exempt, nothing else under /t/.
const TENANT_ROUTE = /^(?:(?:get|head) \/t\/[^/]+|post \/t\/[^/]+\/(?:messages|pay-sandbox))$/;

const COOKIE = 'rr_session';
const MAX_AGE_S = 30 * 24 * 3600; // 30 days
// SESSION_SECRET from env if set. Otherwise a random secret generated once at process boot, which means every
// session is invalidated when the process restarts (judges just log in again). That is fine for this demo.
const SECRET = process.env.SESSION_SECRET || randomBytes(32).toString('hex');

// Hash both sides first so timingSafeEqual always compares equal-length buffers and never short-circuits.
const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

// Only a same-origin relative path may be a post-login target (no open redirect): starts with one "/", not "//"
// or "/\" (browsers treat both as protocol-relative), no control characters, and never back to /login or /logout.
export function safeNext(n) {
  if (typeof n !== 'string' || n.length > 2048 || !n.startsWith('/') || /^\/[/\\]/.test(n) || /[\x00-\x1f\x7f]/.test(n)) return '/';
  if (/^\/log(?:in|out)(?:[/?#]|$)/i.test(n)) return '/';
  return n;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ERRORS = { 1: 'Wrong username or password.' }; // fixed messages only: ?err= text is never echoed back

const CSS = `
:root{--ink:#14213d;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f7fb;--card:#fff;--brand:#0b5fff;--ok:#0f9d58;--warn:#b26a00;--bad:#c62828;--info:#1565c0}
*{box-sizing:border-box}html,body{margin:0}body{font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:400px;margin:0 auto;padding:12vh 18px 40px}
.logo{font-weight:800;font-size:28px;letter-spacing:-.4px;text-align:center}.logo span{color:var(--brand)}
.tag{color:var(--muted);text-align:center;font-size:14px;margin:2px 0 22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px 20px}
h1{font-size:19px;margin:0 0 14px}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:12px 0 5px}
input{width:100%;font:inherit;font-size:17px;padding:12px 13px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink)}
input:focus{outline:2px solid var(--brand);outline-offset:-1px;border-color:var(--brand)}
button{width:100%;height:52px;margin-top:18px;font:inherit;font-weight:700;font-size:17px;color:#fff;background:var(--brand);border:0;border-radius:10px;cursor:pointer}
button:hover{filter:brightness(1.08)}
.err{background:#fdecea;color:var(--bad);border:1px solid #f5c2c0;border-radius:10px;padding:10px 12px;font-size:14px;margin:0 0 6px}
.help{color:var(--muted);font-size:14px;margin:16px 4px 0;text-align:center}
.badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:3px 8px;border-radius:999px;background:#fff4e5;color:var(--warn);border:1px solid #ffd59e}
.foot{text-align:center;margin-top:18px}`;

function loginPage({ next, err }) {
  const msg = err ? (ERRORS[err] || 'Please sign in again.') : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Sign in · RentRoll</title><style>${CSS}</style></head><body><main>
<div class="logo">Rent<span>Roll</span></div><div class="tag">Rent collection for small landlords</div>
<div class="card"><h1>Landlord sign in</h1>
${msg ? `<p class="err" role="alert">${esc(msg)}</p>` : ''}<form method="post" action="/login">
<input type="hidden" name="next" value="${esc(next)}">
<label for="u">Username</label><input id="u" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button></form></div>
<p class="help">Judges: the login is in the 'Try it' section at the top of the project description on Devpost.</p>
<div class="foot"><span class="badge">PayPal sandbox</span></div>
</main></body></html>`;
}

export function sessionAuth({ user = process.env.DEMO_USER, password = process.env.DEMO_PASSWORD } = {}) {
  if (!user || !password) {
    // Local dev only. Production (the Funnel demo) must set DEMO_USER and DEMO_PASSWORD in app.env.
    user ||= 'demo'; password ||= 'demo';
    console.warn('[auth] DEMO_USER/DEMO_PASSWORD not set: using local-dev login demo/demo');
  }
  // The HMAC key mixes in a hash of the login, so rotating DEMO_PASSWORD (and restarting) invalidates every
  // existing session cookie even when SESSION_SECRET is pinned.
  const key = createHmac('sha256', SECRET).update(digest(`${user}\0${password}`)).digest();
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('hex');
  const credsOk = (u, p) => { const a = same(u, user), b = same(p, password); return (a & b) === 1; };

  function issue() {
    const payload = Buffer.from(JSON.stringify({ iat: Math.floor(Date.now() / 1000) })).toString('base64url');
    return `${payload}.${sign(payload)}`;
  }
  // Valid only if: well-formed, HMAC matches bit-for-bit (constant time), and not older than MAX_AGE_S.
  function valid(value) {
    const m = /^([A-Za-z0-9_-]{1,200})\.([0-9a-f]{64})$/.exec(value || '');
    if (!m) return false;
    if (!timingSafeEqual(Buffer.from(sign(m[1]), 'hex'), Buffer.from(m[2], 'hex'))) return false;
    try {
      const { iat } = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
      const age = Math.floor(Date.now() / 1000) - iat;
      return Number.isInteger(iat) && age >= -60 && age < MAX_AGE_S;
    } catch { return false; }
  }
  const loggedIn = (req) => valid(parseCookies(req.headers.cookie)[COOKIE]);
  // Scripts and curl may still send the same login as an HTTP Basic header (the Sprint 10/11 test scripts do).
  // The server never sends WWW-Authenticate any more, so browsers never show the native prompt.
  function basicOk(req) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.get('authorization') || '');
    if (!m) return false;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    return i >= 0 && credsOk(decoded.slice(0, i), decoded.slice(i + 1));
  }
  const setCookie = (res, value, maxAge) =>
    res.append('Set-Cookie', `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`);

  // Gate: every route not exempt needs a valid session cookie (or the same login as Basic Auth, for scripts).
  const gate = (req, res, next) => {
    // Express routing is case-insensitive and ignores a trailing slash; normalize the same way.
    const p = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    if (EXEMPT.has(`${req.method} ${p}`) || TENANT_ROUTE.test(`${req.method.toLowerCase()} ${p}`)) return next();
    if (loggedIn(req) || basicOk(req)) return next();
    res.set('Cache-Control', 'no-store');
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(302, `/login?next=${encodeURIComponent(safeNext(req.originalUrl))}`);
    res.status(401).json({ ok: false, error: 'login required: sign in at /login' });
  };

  function routes(app) {
    const noStore = (res) => res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    app.get('/login', (req, res) => {
      const next = safeNext(req.query.next);
      if (loggedIn(req)) return res.redirect(302, next);
      noStore(res).type('html').send(loginPage({ next, err: typeof req.query.err === 'string' ? req.query.err : '' }));
    });
    app.post('/login', express.urlencoded({ extended: false, limit: '8kb' }), (req, res) => {
      const b = req.body || {};
      const next = safeNext(b.next);
      noStore(res);
      if (typeof b.username !== 'string' || typeof b.password !== 'string' || !credsOk(b.username, b.password)) {
        return res.redirect(302, `/login?err=1${next !== '/' ? `&next=${encodeURIComponent(next)}` : ''}`);
      }
      setCookie(res, issue(), MAX_AGE_S);
      res.redirect(302, next);
    });
    // Both GET and POST log out (the dashboard uses a POST form; GET is a convenience for typing the URL).
    const logout = (_req, res) => { setCookie(noStore(res), '', 0); res.redirect(302, '/login'); };
    app.get('/logout', logout);
    app.post('/logout', logout);
  }

  return { gate, routes };
}
