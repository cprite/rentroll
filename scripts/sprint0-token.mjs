import { getToken, tokenInfo } from '../lib/paypal.js';
await getToken();
const i = tokenInfo();
const scopes = i.scope.split(' ');
console.log(JSON.stringify({ ok: true, expires_at: i.expires_at, n_scopes: scopes.length,
  relevant: scopes.filter(s => /invoic|webhook|payments|checkout|notifications/i.test(s)) }, null, 2));
