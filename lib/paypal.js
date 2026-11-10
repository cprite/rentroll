// Minimal PayPal REST client. Credentials come only from env; never logged.
const BASE = () => {
  const b = process.env.PAYPAL_API_BASE;
  if (!b) throw new Error('PAYPAL_API_BASE not set');
  return b.replace(/\/+$/, '');
};

let cached = null; // { token, exp }

export async function getToken() {
  if (cached && Date.now() < cached.exp - 60_000) return cached.token;
  const id = process.env.PAYPAL_CLIENT_ID, secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error('PAYPAL_CLIENT_ID/SECRET not set');
  const r = await fetch(`${BASE()}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`oauth failed ${r.status}: ${j.error || ''} ${j.error_description || ''}`);
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000, scope: j.scope, app_id: j.app_id };
  return cached.token;
}
export const tokenInfo = () => cached && { scope: cached.scope, app_id: cached.app_id, expires_at: new Date(cached.exp).toISOString() };

export async function pp(method, path, body, extraHeaders = {}) {
  const token = await getToken();
  const r = await fetch(`${BASE()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, debug_id: r.headers.get('paypal-debug-id'), body: json };
}
