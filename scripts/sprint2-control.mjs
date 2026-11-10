// Sprint 2 CONTROL: same model + tenant text, but NO ledger access (what a plain chat session sees).
// NODE_USE_ENV_PROXY=1 node scripts/sprint2-control.mjs   (needs LLM_* env vars)
// CONTROL: same model, same tenant text, NO ledger access (what a plain chat session would see).
import { callLlm, extractJson } from '../lib/plan-ai.js';
const messages = [
  { role: 'system', content: `You are a payment-plan assistant for a small landlord. Today is 2026-11-10. The tenant's November rent was $1,800, due 2026-11-01.
Propose a partial-payment plan. Reply with ONLY one JSON object: {"installments":[{"due_date":"YYYY-MM-DD","amount_cents":0,"note":""}],"reasoning":""}` },
  { role: 'user', content: 'Tenant\'s message:\n"""sorry, can I pay 900 now and the rest later"""' },
];
const r = await callLlm(messages, { maxTokens: 8192 });
const ex = extractJson(r.content);
const inst = ex.ok ? ex.value.installments : null;
console.log(JSON.stringify({ finish_reason: r.finish_reason, ms: r.ms, usage: r.usage?.completion_tokens, content: r.content,
  sum_cents: inst ? inst.reduce((a, x) => a + x.amount_cents, 0) : null }, null, 1));
