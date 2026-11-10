// Sprint 2 offline self-test: JSON extraction, validation, retry/parse_failed paths (no network). node scripts/sprint2-selftest.mjs
import { extractJson, validatePlan, proposePlan } from '../lib/plan-ai.js';
const snap = { today: '2026-11-10', outstanding_cents: 100000, amount_due_cents: 180000, amount_paid_cents: 80000, payments: [], due_date: '2026-11-01', late_fee_rule: { grace_days: 5, type: 'flat', value_cents: 7500 }, late_fee_applies_from: '2026-11-07', days_past_due: 9, late_fee_currently_applicable: true, unit: 'Unit 2', tenant: 'J', period: '2026-11' };
const good = '{"installments":[{"due_date":"2026-11-10","amount_cents":90000,"note":"now"},{"due_date":"2026-11-15","amount_cents":10000,"note":"rest"}],"reasoning":"x"}';
console.log('strict', extractJson(good).how);
console.log('fenced', extractJson('Sure!\n```json\n' + good + '\n```\nhope it helps').how);
console.log('think+prose', extractJson('<think>{bad</think> Here: ' + good + ' done').how);
console.log('garbage', extractJson('I cannot do that').error);
console.log('truncated', extractJson('{"installments":[{"due_date":"2026-').error);
console.log('valid', JSON.stringify(validatePlan(JSON.parse(good), snap).errors));
console.log('wrong sum (1800 basis)', JSON.stringify(validatePlan({ installments: [{ due_date: '2026-11-10', amount_cents: 90000 }, { due_date: '2026-12-01', amount_cents: 90000 }] }, snap).errors));
console.log('bad items', JSON.stringify(validatePlan({ installments: [{ due_date: '2026-02-30', amount_cents: 500.5 }, { due_date: '2026-11-01', amount_cents: -5 }] }, snap).errors));
// parse failure path: both attempts garbage -> parse_failed; second-attempt recovery -> proposed
let n = 0; const fake = (out) => async () => ({ content: out[n++ % out.length], finish_reason: 'stop', ms: 1, model: 'fake' });
n = 0; let r = await proposePlan(snap, 'hi', { llm: fake(['nope', 'still nope']) }); console.log('both garbage ->', r.status, r.errors);
n = 0; r = await proposePlan(snap, 'hi', { llm: fake(['nope', good]) }); console.log('retry recovers ->', r.status, r.meta.attempts.map(a=>a.parse));
