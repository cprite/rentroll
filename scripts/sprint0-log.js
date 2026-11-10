import { appendFileSync } from 'node:fs';
import { pp } from '../lib/paypal.js';
const LOG = new URL('../scratch/sprint0-calls.jsonl', import.meta.url);
// Wraps pp() and records request + response (no auth headers) for the report.
export async function call(label, method, path, body, headers) {
  const res = await pp(method, path, body, headers);
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), label, method, path, request: body ?? null, ...res }) + '\n');
  console.log(`${label}: ${method} ${path} -> ${res.status} (debug ${res.debug_id})`);
  return res;
}
