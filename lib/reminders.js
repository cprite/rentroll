// Sprint 4: reminder escalation driven by real ledger state, not a calendar.
//
// What decides whether a reminder is drafted, and in what tone, is computed by OUR CODE on every run:
//   * open balance  = rent - SUM(COMPLETED payments)  (the payment table, incl. rows a PayPal webhook completed;
//                     the cached rent_period.status / amount_paid_cents are NOT trusted)
//   * what is owed  = the approved plan's next unpaid installment if a plan is enforced, else the open balance
//   * days overdue  = today - due date of that installment / rent period
//   * tier          = from days overdue and the unit's late-fee grace period (unit.late_fee_rule_json)
//   * prior reminders for this exact target = event_log rows kind='reminder_sent' with the same target_key
// A reminder is skipped if: nothing is owed, nothing is overdue yet, a payment is still processing at PayPal,
// the plan's next installment is not due yet, or one went out for this target within the rate-limit window AND
// neither the amount owed nor the tier changed since.
// The LLM only writes the words. Its draft is checked (must quote the exact amount, fee rules per tier);
// on failure it falls back to a fixed template and says so.
// There is no SMS/email integration: the draft is logged, labelled "not delivered".

import { callLlm, extractJson } from './plan-ai.js';

export const RATE_LIMIT_HOURS = () => Number(process.env.REMINDER_MIN_INTERVAL_HOURS ?? 24);
// Firm tier starts the day the late fee becomes applicable (grace_days + 1); formal FORMAL_AFTER_FEE_DAYS later.
const FORMAL_AFTER_FEE_DAYS = 9;
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function tierFor(daysOverdue, graceDays) {
  if (daysOverdue <= 0) return null;
  if (daysOverdue <= graceDays) return 'friendly';
  if (daysOverdue <= graceDays + FORMAL_AFTER_FEE_DAYS) return 'firm';
  return 'formal';
}
const TIER_RANK = { friendly: 1, firm: 2, formal: 3 };

// The real state of one rent period, for reminder purposes. Pure read, no writes.
export function reminderState(d, rpId, today, { activePlanRow, planSchedule }) {
  const rp = d.prepare(`SELECT rp.*, u.label unit_label, u.late_fee_rule_json, t.name tenant_name, t.phone tenant_phone, t.email tenant_email
    FROM rent_period rp JOIN unit u ON u.id = rp.unit_id LEFT JOIN tenant t ON t.id = rp.tenant_id WHERE rp.id = ?`).get(rpId);
  if (!rp) return null;
  const pays = d.prepare("SELECT id, status, amount_cents, paid_at, webhook_event_id, paypal_capture_id FROM payment WHERE rent_period_id=? AND status IN ('COMPLETED','PENDING')").all(rpId);
  const paid = pays.filter((p) => p.status === 'COMPLETED').reduce((a, p) => a + p.amount_cents, 0);
  const pending = pays.filter((p) => p.status === 'PENDING').reduce((a, p) => a + p.amount_cents, 0);
  const open = rp.amount_due_cents - paid;
  const fee = JSON.parse(rp.late_fee_rule_json || '{}');
  const grace = fee.grace_days ?? 0;
  const base = {
    rent_period_id: rp.id, unit: rp.unit_label, tenant: rp.tenant_name, tenant_phone: rp.tenant_phone, period: rp.period, today,
    rent_due_cents: rp.amount_due_cents, paid_cents: paid, pending_cents: pending, open_balance_cents: open,
    payments_completed: pays.filter((p) => p.status === 'COMPLETED').length,
    payments_webhook_confirmed: pays.filter((p) => p.status === 'COMPLETED' && p.webhook_event_id).length,
    cached_status: rp.status, late_fee_rule: { grace_days: grace, type: fee.type || 'none', value_cents: fee.value_cents ?? 0 },
  };
  if (open <= 0) return { ...base, skip: `paid in full per the payments ledger (${usd(paid)} of ${usd(rp.amount_due_cents)} COMPLETED${base.payments_webhook_confirmed ? `, ${base.payments_webhook_confirmed} confirmed by PayPal webhook` : ''})${rp.status !== 'PAID' ? `; cached status said ${rp.status}, ignored` : ''}` };
  if (pending > 0) return { ...base, skip: `a payment of ${usd(pending)} is processing at PayPal; wait for it to settle` };

  const plan = activePlanRow(d, rp.id);
  let target;
  if (plan) {
    const nx = planSchedule(d, plan).next_installment;
    if (!nx) return { ...base, skip: `approved plan #${plan.id} has no unpaid installment` };
    target = { key: `plan${plan.id}:i${nx.n}`, kind: 'plan_installment', plan_id: plan.id, installment: nx.n, installments_total: nx.of,
      due_date: nx.due_date, owed_cents: nx.amount_cents };
  } else {
    target = { key: `rp${rp.id}`, kind: 'rent_period', due_date: rp.due_date, owed_cents: open };
  }
  const daysOverdue = dayDiff(target.due_date, today);
  // The late fee is tied to the rent due date; an approved plan rescheduled the balance, so no fee talk on a plan.
  const rentDaysLate = dayDiff(rp.due_date, today);
  const feeApplicable = !plan && !!fee.value_cents && rentDaysLate > grace;
  const tier = tierFor(daysOverdue, grace);
  const prior = d.prepare(`SELECT id, at, payload_json FROM event_log WHERE kind='reminder_sent' AND rent_period_id=?
      AND json_extract(payload_json,'$.target_key')=? ORDER BY id`).all(rp.id, target.key);
  const last = prior.at(-1);
  const lastP = last ? JSON.parse(last.payload_json) : null;
  const st = { ...base, target, days_overdue: daysOverdue, tier, late_fee_applicable: feeApplicable,
    late_fee_cents: feeApplicable ? fee.value_cents : 0,
    prior_reminders: prior.length, last_reminder_at: last?.at ?? null, last_reminder_event_id: last?.id ?? null,
    last_reminder_tier: lastP?.tier ?? null, last_reminder_owed_cents: lastP?.owed_cents ?? null };
  if (!tier) return { ...st, skip: plan ? `on approved plan #${plan.id}: installment ${target.installment} of ${target.installments_total} not due until ${target.due_date}` : `not overdue yet (due ${target.due_date})` };
  if (last) {
    const hours = (Date.now() - Date.parse(last.at)) / 36e5;
    st.hours_since_last = Math.round(hours * 100) / 100;
    const changed = [];
    if (lastP.owed_cents !== target.owed_cents) changed.push(`amount owed changed ${usd(lastP.owed_cents)} → ${usd(target.owed_cents)}`);
    if ((TIER_RANK[tier] || 0) > (TIER_RANK[lastP.tier] || 0)) changed.push(`escalated ${lastP.tier} → ${tier}`);
    st.changed_since_last = changed;
    if (hours < RATE_LIMIT_HOURS() && changed.length === 0)
      return { ...st, skip: `rate-limited: reminder #${prior.length} for ${target.key} (event_log #${last.id}, ${lastP.tier}) went out ${hours < 1 ? `${Math.round(hours * 60)} min` : `${st.hours_since_last} h`} ago, inside the ${RATE_LIMIT_HOURS()} h window, and neither the amount owed nor the tier changed` };
  }
  return st;
}

const TONE = {
  friendly: 'FRIENDLY NUDGE. Warm and casual, assume it slipped their mind. No mention of fees or consequences. 2-3 short sentences.',
  firm: 'FIRM. Polite but direct and businesslike. State plainly that the rent is late and how many days, and (if a late fee applies) that the late fee from the lease now applies, with its amount. Ask them to pay today or reply with the date they can pay. 3-4 sentences.',
  formal: 'FORMAL NOTICE. Serious, formal register, no friendliness, no emoji. State the amount, the number of days overdue and (if it applies) the late fee. Say this is a formal notice of non-payment, that the landlord expects payment or a written payment arrangement within 3 days, and that otherwise the landlord will consider next steps under the lease. Do not invent legal claims, statutes or eviction dates. 4-5 sentences.',
};

export function buildReminderMessages(st) {
  const t = st.target;
  const facts = [
    `Tenant: ${st.tenant}, ${st.unit}`,
    t.kind === 'plan_installment'
      ? `Owed now: ${usd(t.owed_cents)} = installment ${t.installment} of ${t.installments_total} of the payment plan the landlord approved, due ${t.due_date}`
      : `Owed now: ${usd(t.owed_cents)} of the ${usd(st.rent_due_cents)} rent for ${st.period}, due ${t.due_date}${st.paid_cents ? ` (${usd(st.paid_cents)} already received; thank them for it)` : ''}`,
    `Days overdue today (${st.today}): ${st.days_overdue}`,
    st.late_fee_applicable ? `Late fee: ${usd(st.late_fee_cents)} now applies (the ${st.late_fee_rule.grace_days}-day grace period has passed)` : 'Late fee: does NOT apply. Do not mention any fee.',
    `Reminders already sent for this amount: ${st.prior_reminders}${st.last_reminder_at ? ` (last one ${st.last_reminder_at.slice(0, 10)}, ${st.last_reminder_tier})` : ''}`,
  ];
  const system = `You write rent reminder text messages (SMS) from a small landlord to a tenant.
FACTS (computed by RentRoll from its payment ledger; use these exact numbers, do not change or round them):
${facts.map((f) => '- ' + f).join('\n')}

TONE: ${TONE[st.tier]}

RULES: Write the amount exactly as "${usd(t.owed_cents)}". Sign off as "- your landlord". Max 480 characters. Plain text.
Mention that they can pay through the usual PayPal link. No placeholders like [name].
Reply with ONLY one JSON object: {"text":"the SMS text"}`;
  return [{ role: 'system', content: system }, { role: 'user', content: `Write the ${st.tier} reminder now.` }];
}

// Server-side check of the draft: the money facts must be right for the tier.
export function validateDraft(text, st) {
  const errs = [];
  if (typeof text !== 'string' || !text.trim()) return ['empty text'];
  if (text.length > 600) errs.push(`too long (${text.length} chars)`);
  if (!text.includes(usd(st.target.owed_cents))) errs.push(`does not state the exact amount owed ${usd(st.target.owed_cents)}`);
  if (st.late_fee_applicable && st.tier !== 'friendly' && !text.includes(usd(st.late_fee_cents))) errs.push(`does not state the late fee ${usd(st.late_fee_cents)}`);
  if (!st.late_fee_applicable && st.late_fee_rule.value_cents && text.includes(usd(st.late_fee_rule.value_cents))) errs.push('mentions a late fee that does not apply');
  if (/\[[a-z ]+\]/i.test(text)) errs.push('contains a placeholder');
  return errs;
}

export function templateDraft(st) {
  const t = st.target, a = usd(t.owed_cents);
  const what = t.kind === 'plan_installment' ? `installment ${t.installment} of ${t.installments_total} (${a}) of our payment plan, due ${t.due_date},` : `${a} rent for ${st.period}, due ${t.due_date},`;
  if (st.tier === 'friendly') return `Hi ${st.tenant}, just a friendly reminder that ${what} hasn't come through yet. You can pay through the usual PayPal link. Thanks! - your landlord`;
  const fee = st.late_fee_applicable ? ` The ${usd(st.late_fee_cents)} late fee under the lease now applies.` : '';
  if (st.tier === 'firm') return `Hi ${st.tenant}, ${what} is now ${st.days_overdue} days late.${fee} Please pay today through the PayPal link or reply with the date you can pay. - your landlord`;
  return `${st.tenant}: this is a formal notice of non-payment. ${what} is ${st.days_overdue} days overdue.${fee} Please pay through the PayPal link or agree a written payment arrangement within 3 days, otherwise I will consider next steps under the lease. - your landlord`;
}

export async function draftReminder(st, { llm = callLlm } = {}) {
  const messages = buildReminderMessages(st);
  const attempts = [];
  let msgs = messages;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res;
    try { res = await llm(msgs, { maxTokens: 1024, timeoutMs: 60_000 }); }
    catch (e) { attempts.push({ attempt, error: e.message }); break; }
    const ex = extractJson(res.content);
    const text = ex.ok && typeof ex.value?.text === 'string' ? ex.value.text.trim() : null;
    const errs = text ? validateDraft(text, st) : [ex.ok ? 'JSON has no "text" string' : ex.error];
    attempts.push({ attempt, model: res.model, ms: res.ms, finish_reason: res.finish_reason, usage: res.usage, errors: errs, rejected_text: errs.length ? text : undefined });
    if (!errs.length) return { text, drafted_by: 'llm', model: res.model, attempts };
    msgs = [...messages, { role: 'assistant', content: res.content || '' },
      { role: 'user', content: `That draft failed RentRoll's checks: ${errs.join('; ')}. Fix it and reply with ONLY {"text":"..."}.` }];
  }
  return { text: templateDraft(st), drafted_by: 'template', fallback_reason: attempts.map((a) => a.error || a.errors?.join('; ')).join(' | '), attempts };
}
