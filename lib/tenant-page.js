// Sprint 11: the tenant's own page, GET /t/:token. Pure rendering: server.js gathers the facts (tenantView) and
// this file only turns them into HTML. Phone-first (single column, big tap targets, no tables). It deliberately has
// NO landlord actions: no approve/reject, no reminders, no court packet, no other tenants.
//
// view = { token, tenant: {name}, flash, today, periods: [{ rp, snap, pending_cents, plan, messages, payments }] }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (iso) => new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC';
const monthName = (p) => new Date(p + '-01T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

// Same colour tokens as the landlord dashboard (server.js CSS :root), own layout.
const CSS = `
:root{--ink:#14213d;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f7fb;--card:#fff;--brand:#0b5fff;--ok:#0f9d58;--warn:#b26a00;--bad:#c62828;--info:#1565c0}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;font:17px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
.app{max-width:440px;margin:0 auto;padding:0 16px 40px}
header{display:flex;align-items:center;gap:10px;padding:16px 0 6px}
.logo{font-weight:800;font-size:19px;letter-spacing:-.3px}.logo span{color:var(--brand)}
.sp{flex:1}.badge{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:3px 8px;border-radius:999px;background:#fff4e5;color:var(--warn);border:1px solid #ffd59e}
h1{font-size:22px;margin:10px 0 2px}.sub{color:var(--muted);margin:0 0 14px;font-size:15px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px;margin:0 0 14px}
.card h2{font-size:16px;margin:0 0 10px}
.owed small{display:block;color:var(--muted);font-size:14px}.owed b.big{display:block;font-size:40px;letter-spacing:-1px;line-height:1.1;margin:2px 0 6px;font-variant-numeric:tabular-nums}
.bar{height:8px;background:#eef0f4;border-radius:9px;overflow:hidden;margin:10px 0 6px}.bar i{display:block;height:100%;background:var(--ok)}
.pill{display:inline-block;font-size:13px;font-weight:700;padding:4px 10px;border-radius:999px;white-space:nowrap}
.pill.UNPAID{background:#fdecea;color:var(--bad)}.pill.PARTIALLY_PAID{background:#fff4e5;color:var(--warn)}.pill.PAID{background:#e6f4ea;color:var(--ok)}
.pill.p-proposed{background:#e8efff;color:var(--brand)}.pill.p-approved,.pill.p-completed{background:#e6f4ea;color:var(--ok)}
.pill.p-needs_review,.pill.p-parse_failed{background:#fff4e5;color:var(--warn)}.pill.p-rejected{background:#f1f2f5;color:var(--muted)}
.row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--line);font-size:15px}
.row span:first-child{color:var(--muted)}.row span:last-child{text-align:right;font-variant-numeric:tabular-nums}
.note{font-size:14px;border-radius:10px;padding:10px 12px;margin:10px 0 0}.note.warn{background:#fff8ec;color:#7a4a00}.note.info{background:#f3f6ff}
.small{font-size:13.5px;color:var(--muted)}
.flash{padding:14px 16px;border-radius:12px;margin:0 0 14px;font-weight:600;font-size:15px}.flash.ok{background:#e6f4ea;color:var(--ok)}.flash.err{background:#fdecea;color:var(--bad)}
.inst{list-style:none;margin:8px 0 0;padding:0}
.inst li{display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line)}.inst li:first-child{border-top:0}
.inst .n{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:14px;background:#eef2ff;color:var(--brand)}
.inst .n.PAID{background:#e6f4ea;color:var(--ok)}.inst .n.OVERDUE{background:#fdecea;color:var(--bad)}
.inst .d{flex:1;font-size:15px}.inst .d small{display:block;color:var(--muted);font-size:13px}
.inst .a{font-weight:700;font-variant-numeric:tabular-nums}
.ground{font-size:14px;background:#f3f6ff;border-radius:10px;padding:10px 12px;margin:10px 0}
button{display:block;width:100%;min-height:52px;border:0;border-radius:14px;background:var(--brand);color:#fff;font:inherit;font-weight:700;font-size:17px;cursor:pointer;padding:12px 16px}
button:active{filter:brightness(.92)}button.ghost{background:#fff;color:var(--brand);border:1.5px solid #c9d8ff}
label{display:block;font-size:14px;color:var(--muted);margin:0 0 6px}
input,textarea{width:100%;font:inherit;font-size:17px;padding:14px;border:1.5px solid var(--line);border-radius:12px;background:#fff;color:var(--ink)}
textarea{min-height:104px;resize:vertical}input:focus,textarea:focus{outline:2px solid #c9d8ff;border-color:var(--brand)}
form{margin:12px 0 0}form>*+*{margin-top:10px}
.lock{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1.5px dashed var(--ok);background:#f3fbf5;border-radius:12px;padding:12px 14px;margin:10px 0 0}
.lock b{font-size:24px;font-variant-numeric:tabular-nums}
.msgs{list-style:none;margin:0;padding:0}.msgs li{background:#eef2ff;border-radius:16px 16px 4px 16px;padding:10px 14px;margin:0 0 10px 34px;font-size:15px}
.msgs li small{display:block;color:var(--muted);font-size:12.5px;margin-top:4px}
.pays{list-style:none;margin:0;padding:0}.pays li{padding:10px 0;border-top:1px solid var(--line);font-size:15px}.pays li:first-child{border-top:0}
.ok-ic{color:var(--ok);font-weight:700}
footer{color:var(--muted);font-size:13px;padding:10px 2px}
a{color:var(--brand)}
`;

const PLAN_LABEL = {
  proposed: 'Waiting for your landlord to approve',
  approved: 'Approved by your landlord',
  completed: 'Plan completed',
  needs_review: 'Sent to your landlord to review',
  parse_failed: 'Sent to your landlord to review',
  rejected: 'Your landlord declined this plan',
};
const INST_TXT = { PAID: 'Paid', PROCESSING: 'Processing at PayPal', DUE: 'Next · due', OVERDUE: 'Next · overdue since', UPCOMING: 'Upcoming' };

function renderInstallments(p) {
  if (p.schedule) {
    return `<ul class="inst">${p.schedule.map((x) => {
      const done = x.state === 'PAID' || x.state === 'PROCESSING';
      return `<li><span class="n ${x.state}">${x.state === 'PAID' ? '✓' : x.n}</span>
      <span class="d">${esc(INST_TXT[x.state] || x.state)}${done ? '' : ' ' + esc(fmtDate(x.due_date))}<small>${done ? `was due ${esc(fmtDate(x.due_date))}` : `installment ${x.n} of ${x.of}`}</small></span>
      <span class="a">${money(x.amount_cents)}</span></li>`; }).join('')}</ul>`;
  }
  const ok = (x) => Number.isFinite(x.amount_cents) && typeof x.due_date === 'string';
  return `<ul class="inst">${p.installments.filter(ok).map((x, i) => `<li><span class="n">${i + 1}</span>
    <span class="d">Due ${esc(/^\d{4}-\d{2}-\d{2}$/.test(x.due_date) ? fmtDate(x.due_date) : x.due_date)}${x.note ? `<small>${esc(x.note)}</small>` : ''}</span>
    <span class="a">${money(x.amount_cents)}</span></li>`).join('')}</ul>`;
}

function renderPlan(p) {
  if (!p) return '';
  const s = p.ledger_snapshot;
  const sum = p.installments.reduce((a, x) => a + (Number.isFinite(x.amount_cents) ? x.amount_cents : 0), 0);
  const showList = ['proposed', 'approved', 'completed', 'rejected'].includes(p.status) && p.installments.length;
  return `<section class="card plan" id="plan"><h2>Payment plan</h2>
    <span class="pill p-${esc(p.status)}">${esc(PLAN_LABEL[p.status] || p.status)}</span>
    ${s ? `<div class="ground"><b>Read from your payment record${p.created_at ? ` when the AI drafted this plan (${esc(fmtTime(p.created_at))})` : ''}:</b> rent ${money(s.amount_due_cents)} − paid ${money(s.amount_paid_cents)}
      (${s.payments.length} PayPal payment${s.payments.length === 1 ? '' : 's'}) = <b>${money(s.outstanding_cents)} owed</b>.
      The AI had to fit the plan to that number, not to the figures in your message.</div>` : ''}
    ${showList ? renderInstallments(p) : ''}
    ${showList && s && !p.schedule ? `<div class="small">${Math.abs(sum - s.outstanding_cents) <= 1 ? '✓ adds up to what you owe' : '✗ does not add up to what you owe'}: ${money(sum)}</div>` : ''}
    ${p.reasoning && p.status !== 'parse_failed' ? `<p class="small"><b>How the AI read your message:</b> ${esc(p.reasoning)}</p>` : ''}
    ${p.status === 'proposed' ? '<p class="small">Nothing is locked in until your landlord approves it. You can still send another message.</p>' : ''}
    ${p.status === 'needs_review' || p.status === 'parse_failed' ? '<p class="small">RentRoll could not turn your message into a plan that adds up, so your landlord will look at it. You can also send a clearer message below, e.g. "I can pay $600 now and the rest on the 20th".</p>' : ''}
    ${p.status === 'rejected' ? '<p class="small">You can send a new proposal below.</p>' : ''}
  </section>`;
}

function renderPay(token, x) {
  const { rp, plan, pending_cents } = x;
  const bal = rp.amount_due_cents - rp.amount_paid_cents;
  if (bal <= 0) return `<section class="card" id="pay"><h2>Pay</h2><p class="ok-ic">✓ Paid in full. Nothing more to pay for ${esc(monthName(rp.period))}.</p></section>`;
  if (pending_cents > 0) return `<section class="card" id="pay"><h2>Pay</h2><p>A payment of ${money(pending_cents)} is still processing at PayPal. Check back in a minute.</p></section>`;
  const nx = plan?.status === 'approved' ? plan.next_installment : null;
  const hidden = `<input type="hidden" name="rent_period_id" value="${rp.id}">`;
  if (nx) {
    return `<section class="card" id="pay"><h2>Pay your next installment</h2>
      <div class="lock"><span>🔒 Installment ${nx.n} of ${nx.of}<br><span class="small">due ${esc(fmtDate(nx.due_date))}</span></span><b>${money(nx.amount_cents)}</b></div>
      <form method="post" action="/t/${esc(token)}/pay-sandbox">${hidden}<input type="hidden" name="amount" value="${(nx.amount_cents / 100).toFixed(2)}">
        <button>Pay ${money(nx.amount_cents)} with PayPal (card)</button></form>
      <p class="small">Your approved plan fixes this amount. RentRoll refuses any other amount before PayPal is called.</p></section>`;
  }
  return `<section class="card" id="pay"><h2>Pay</h2>
    <form method="post" action="/t/${esc(token)}/pay-sandbox">${hidden}
      <label for="amt-${rp.id}">Amount (up to ${money(bal)})</label>
      <input id="amt-${rp.id}" name="amount" inputmode="decimal" autocomplete="off" value="${(bal / 100).toFixed(2)}">
      <button>Pay with PayPal (card)</button></form>
    ${plan?.status === 'proposed' ? '<p class="small">Your plan is not approved yet, so any amount up to your balance is accepted for now.</p>' : ''}</section>`;
}

function renderPeriod(token, x) {
  const { rp, snap } = x;
  const bal = rp.amount_due_cents - rp.amount_paid_cents;
  const pct = Math.min(100, Math.round((rp.amount_paid_cents / rp.amount_due_cents) * 100));
  const fee = snap.late_fee_rule;
  const lateNote = bal <= 0 || !fee.value_cents ? ''
    : snap.late_fee_currently_applicable
      ? `<div class="note warn">Your lease has a ${money(fee.value_cents)} late fee after a ${fee.grace_days}-day grace period. It could apply since ${esc(fmtDate(snap.late_fee_applies_from))}, but it has <b>not</b> been added to your balance; your landlord decides.</div>`
      : `<div class="note info">Late fee: ${money(fee.value_cents)} if unpaid by ${esc(fmtDate(snap.late_fee_applies_from))} (${fee.grace_days}-day grace period).</div>`;
  const msgs = x.messages.map((m) => `<li>${esc(m.body)}<small>${esc(fmtTime(m.received_at))}${m.channel === 'app' ? ' · from this page' : ` · ${esc(m.channel)}`}</small></li>`).join('');
  const pays = x.payments.map((p) => `<li><b>${money(p.amount_cents)}</b> · ${esc(fmtDate((p.paid_at || p.created_at).slice(0, 10)))}${p.plan_installment ? ` · installment ${p.plan_installment}` : ''}<br>
    <span class="small">${p.status === 'COMPLETED' ? (p.webhook_event_id || p.invoice_webhook_event_id ? '<span class="ok-ic">✓</span> confirmed by PayPal webhook' : 'received by PayPal, webhook confirmation pending') : esc(p.status.toLowerCase())}${p.paypal_capture_id ? ` · PayPal ref ${esc(p.paypal_capture_id)}` : ''}</span></li>`).join('');
  return `
  <section class="card owed" id="balance">
    <small>${esc(rp.unit_label)} · ${esc(monthName(rp.period))} rent · you owe</small>
    <b class="big">${money(Math.max(0, bal))}</b>
    <span class="pill ${rp.status}">${rp.status.replace('_', ' ')}</span>
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="row"><span>Rent</span><span>${money(rp.amount_due_cents)}</span></div>
    <div class="row"><span>Paid so far</span><span>${money(rp.amount_paid_cents)}</span></div>
    <div class="row"><span>Due date</span><span>${esc(fmtDate(rp.due_date))}${bal > 0 && snap.days_past_due > 0 ? ` · ${snap.days_past_due} day${snap.days_past_due === 1 ? '' : 's'} ago` : ''}</span></div>
    ${rp.paypal_invoice_number ? `<div class="row"><span>PayPal invoice</span><span>${rp.payer_view_url ? `<a href="${esc(rp.payer_view_url)}" rel="noopener noreferrer" target="_blank">${esc(rp.paypal_invoice_number)}</a>` : esc(rp.paypal_invoice_number)}</span></div>` : ''}
    ${lateNote}
  </section>
  ${renderPlan(x.plan)}
  ${renderPay(token, x)}
  ${bal > 0 ? `<section class="card" id="message"><h2>Need more time? Tell your landlord</h2>
    <form method="post" action="/t/${esc(token)}/messages"><input type="hidden" name="rent_period_id" value="${rp.id}">
      <label for="msg-${rp.id}">Your message, in your own words</label>
      <textarea id="msg-${rp.id}" name="body" maxlength="2000" required placeholder="e.g. Can I pay $900 now and the rest on the 15th?"></textarea>
      <button class="ghost">Send</button></form>
    <p class="small">An AI turns your message into a payment plan that adds up to what you actually owe. Your landlord approves it before it counts.</p></section>` : ''}
  ${msgs ? `<section class="card" id="messages"><h2>Your messages</h2><ul class="msgs">${msgs}</ul></section>` : ''}
  ${pays ? `<section class="card" id="payments"><h2>Your payments</h2><ul class="pays">${pays}</ul></section>` : ''}`;
}

export function renderTenantPage(view) {
  const { token, tenant, flash, periods, today } = view;
  const title = periods[0] ? `${monthName(periods[0].rp.period)} rent` : 'Your rent';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#f6f7fb">
<title>RentRoll · ${esc(title)}</title><style>${CSS}</style></head><body><div class="app">
<header><div class="logo">Rent<span>Roll</span></div><div class="sp"></div><span class="badge">PayPal sandbox</span></header>
<h1>Hi ${esc(firstName(tenant.name))}</h1><p class="sub">Your rent at ${esc(periods[0]?.rp.unit_address || 'your unit')} · today ${esc(fmtDate(today))}</p>
${flash ? `<div class="flash ${flash.ok ? 'ok' : 'err'}" role="status">${esc(flash.msg)}</div>` : ''}
${periods.length ? periods.map((x) => renderPeriod(token, x)).join('') : '<section class="card"><p>No rent is open for you right now.</p></section>'}
<footer>This is your private link from your landlord; please don't share it. Demo build: payments run in the PayPal sandbox with a test card, so no real money moves.</footer>
</div></body></html>`;
}
