// Sprint 8: one shared HTTP Basic Auth login for the hosted demo. A casual gate to keep random visitors off
// the Funnel URL, not a real auth system: the password is given to judges in Devpost's judges-only
// testing-instructions field, not published in this repo.
import { createHash, timingSafeEqual } from 'node:crypto';

// Routes that must stay open. The webhook cannot send Basic Auth; its protection is PayPal signature verification.
const EXEMPT = new Set(['GET /healthz', 'HEAD /healthz', 'POST /webhooks/paypal']);
// Sprint 11: the tenant's own page. Its protection is the unguessable per-tenant token in the URL (checked by the
// route itself; an unknown token is a plain 404). Only these three shapes are exempt, nothing else under /t/.
const TENANT_ROUTE = /^(?:(?:get|head) \/t\/[^/]+|post \/t\/[^/]+\/(?:messages|pay-sandbox))$/;

// Hash both sides first so timingSafeEqual always compares equal-length buffers.
const digest = (s) => createHash('sha256').update(String(s), 'utf8').digest();
const same = (a, b) => timingSafeEqual(digest(a), digest(b));

export function basicAuth({ user = process.env.DEMO_USER, password = process.env.DEMO_PASSWORD, realm = 'RentRoll' } = {}) {
  if (!user || !password) {
    // Local dev only. Production (the Funnel demo) must set DEMO_USER and DEMO_PASSWORD in app.env.
    user ||= 'demo'; password ||= 'demo';
    console.warn('[auth] DEMO_USER/DEMO_PASSWORD not set: using local-dev login demo/demo');
  }
  return (req, res, next) => {
    // Express routing is case-insensitive and ignores a trailing slash; normalize the same way.
    const p = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    if (EXEMPT.has(`${req.method} ${p}`) || TENANT_ROUTE.test(`${req.method.toLowerCase()} ${p}`)) return next();
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.get('authorization') || '');
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i >= 0) {
        const okUser = same(decoded.slice(0, i), user);
        const okPass = same(decoded.slice(i + 1), password);
        if (okUser & okPass) return next();
      }
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}"`)
      .status(401).type('text/plain').send('Login required. The demo login is listed in the README.\n');
  };
}
