// Sprint 6: court packet. A read-only report over one rent_period's real records:
// rent_period/unit/tenant, the append-only event_log, payment rows (PayPal order/capture ids, fee, net,
// webhook confirmation + signature verification result) and plans. Nothing here writes to the DB.
//
//   courtPacketData(d, rpId, deps)  -> plain JSON facts (also served as .json so the PDF can be diffed against it)
//   renderCourtPacketPdf(data)      -> Promise<Buffer> (pdfkit, standard Helvetica, no native deps)
import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';

const money = (c) => (c == null ? '-' : (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const monthName = (p) => new Date(p + '-01T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const utc = (iso) => (iso ? new Date(iso).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '-');
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const toCents = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100));

const KIND_LABEL = {
  seed: 'Rent period opened',
  message_in: 'Message received from tenant',
  plan_proposed: 'Payment plan proposed (AI draft)',
  plan_approved: 'Payment plan approved by landlord',
  plan_rejected: 'Payment plan rejected by landlord',
  plan_completed: 'Payment plan completed',
  payment: 'Payment made (PayPal card capture)',
  invoice_sent: 'PayPal invoice created and sent',
  invoice_updated: 'PayPal invoice terms updated',
  invoice_payment_recorded: 'Payment recorded on the PayPal invoice',
  invoice_update_failed: 'PayPal invoice update FAILED',
  webhook_received: 'PayPal webhook confirmation',
  reminder_sent: 'Reminder drafted and logged (not delivered)',
};

// Amount shown in the timeline column, read from the event's own payload / the rows it points at.
function eventAmount(d, e, p) {
  switch (e.kind) {
    case 'seed': return d.prepare('SELECT amount_due_cents a FROM rent_period WHERE id=?').get(e.rent_period_id)?.a ?? null;
    case 'payment': return p?.payment_id ? d.prepare('SELECT amount_cents a FROM payment WHERE id=?').get(p.payment_id)?.a ?? null : null;
    case 'webhook_received': return toCents(p?.amount?.value);
    case 'plan_proposed': return p?.outstanding_cents ?? null;
    case 'plan_approved': return Array.isArray(p?.installments) ? p.installments.reduce((a, x) => a + (x.amount_cents || 0), 0) : null;
    case 'reminder_sent': return p?.owed_cents ?? null;
    case 'invoice_sent': return p?.total_cents ?? null;
    case 'invoice_payment_recorded': return p?.payment_id ? d.prepare('SELECT amount_cents a FROM payment WHERE id=?').get(p.payment_id)?.a ?? null : null;
    default: return null;
  }
}

export function courtPacketData(d, rpId, { getPeriod, activePlanRow, planSchedule, today, invoice = null }) {
  const rp = getPeriod(d, rpId);
  if (!rp) return null;
  const asOf = today();
  const rows = d.prepare('SELECT id, at, kind, actor, rent_period_id, summary, payload_json, paypal_event_id FROM event_log WHERE rent_period_id=? ORDER BY at, id').all(rp.id);
  // Integrity fingerprint over the exact ledger rows included, so a copy of the DB can be checked against the printout.
  const sha256 = createHash('sha256').update(JSON.stringify(rows.map((r) => [r.id, r.at, r.kind, r.actor, r.summary, r.payload_json, r.paypal_event_id]))).digest('hex');
  const events = rows.map((e) => {
    const p = parse(e.payload_json);
    // The stored one-line summaries truncate long texts; a record should carry them in full.
    let summary = e.summary;
    if (e.kind === 'reminder_sent' && p?.text) summary = summary.replace(/: ".*$/s, `: "${p.text}"`);
    if (e.kind === 'message_in' && p?.message_id) {
      const m = d.prepare('SELECT body, channel FROM message WHERE id=?').get(p.message_id);
      if (m) summary = summary.replace(/: ".*$/s, `: "${m.body.trim()}"`);
    }
    return { id: e.id, at: e.at, kind: e.kind, label: KIND_LABEL[e.kind] || e.kind, actor: e.actor, summary,
      amount_cents: eventAmount(d, e, p), paypal_event_id: e.paypal_event_id,
      verification: e.kind === 'webhook_received' ? p?.verification ?? null : undefined,
      paypal_created_at: e.kind === 'webhook_received' ? p?.create_time ?? null : undefined };
  });

  const payments = d.prepare('SELECT * FROM payment WHERE rent_period_id=? ORDER BY id').all(rp.id).map((x) => {
    const wh = x.webhook_event_id ? d.prepare('SELECT id, at, payload_json FROM event_log WHERE paypal_event_id=?').get(x.webhook_event_id) : null;
    const whp = parse(wh?.payload_json);
    return { id: x.id, status: x.status, amount_cents: x.amount_cents, fee_cents: x.fee_cents, net_cents: x.net_cents,
      paypal_order_id: x.paypal_order_id, paypal_capture_id: x.paypal_capture_id, paypal_debug_id: x.paypal_debug_id, custom_id: x.custom_id,
      paid_at: x.paid_at, created_at: x.created_at, error: x.error, simulated: !!x.simulated, plan_id: x.plan_id ?? null, plan_installment: x.plan_installment ?? null,
      webhook_confirmed: !!x.webhook_event_id, webhook_event_id: x.webhook_event_id, webhook_confirmed_at: x.webhook_confirmed_at,
      webhook_ledger_id: wh?.id ?? null, signature_verification: whp?.verification ?? null, webhook_via: whp?.via ?? null,
      webhook_paypal_created_at: whp?.create_time ?? null, source: x.source,
      invoice_payment_id: x.invoice_payment_id ?? null, invoice_recorded_at: x.invoice_recorded_at ?? null, invoice_webhook_event_id: x.invoice_webhook_event_id ?? null };
  });

  const plans = d.prepare('SELECT * FROM plan WHERE rent_period_id=? ORDER BY id').all(rp.id).map((pl) => ({
    id: pl.id, status: pl.status, created_at: pl.created_at, approved_at: pl.approved_at,
    installments: pl.status === 'approved' ? planSchedule(d, pl).installments.map((i) => ({ n: i.n, due_date: i.due_date, amount_cents: i.amount_cents, state: i.state }))
      : (parse(pl.installments_json) || []).map((i, k) => ({ n: k + 1, due_date: i.due_date, amount_cents: i.amount_cents, state: null })),
  }));

  // Balance from the payments ledger itself (COMPLETED rows), never from the cached rent_period columns.
  const paid = payments.filter((x) => x.status === 'COMPLETED').reduce((a, x) => a + x.amount_cents, 0);
  const pending = payments.filter((x) => x.status === 'PENDING').reduce((a, x) => a + x.amount_cents, 0);
  const balance = rp.amount_due_cents - paid;
  const daysLate = balance > 0 ? Math.max(0, daysBetween(rp.due_date, asOf)) : 0;
  const fee = parse(rp.late_fee_rule_json);
  const feeApplies = !!fee && balance > 0 && daysLate > (fee.grace_days ?? 0);
  const ap = activePlanRow(d, rp.id);
  const nx = ap ? planSchedule(d, ap).next_installment : null;
  const status = balance <= 0 ? 'PAID IN FULL' : paid > 0 ? 'PARTIALLY PAID' : 'UNPAID';
  const lines = [];
  if (balance <= 0) lines.push(`Paid in full: ${money(paid)} of ${money(rp.amount_due_cents)} received through PayPal.`);
  else {
    lines.push(`${money(paid)} of ${money(rp.amount_due_cents)} paid; ${money(balance)} outstanding as of ${asOf}.`);
    lines.push(daysLate > 0 ? `Rent was due ${rp.due_date}: ${daysLate} day${daysLate === 1 ? '' : 's'} overdue.` : `Rent is due ${rp.due_date}: not yet overdue.`);
  }
  if (pending) lines.push(`${money(pending)} is still processing at PayPal and is not counted as paid.`);
  if (nx) lines.push(`On approved payment plan #${ap.id}: next installment ${nx.n} of ${nx.of}, ${money(nx.amount_cents)}, due ${nx.due_date} (${nx.state === 'OVERDUE' ? 'overdue' : 'not yet overdue'}).`);
  else if (ap) lines.push(`Approved payment plan #${ap.id}: no unpaid installment.`);
  if (fee) lines.push(`Lease late-fee rule: ${money(fee.value_cents)} ${fee.type} after a ${fee.grace_days}-day grace period. ${feeApplies ? (ap ? 'Past grace, but an approved plan reschedules the balance; ' : 'Past grace; ') : 'Not triggered; '}RentRoll does not add late fees to the balance above.`);

  if (invoice) lines.push(`PayPal invoice ${invoice.number} (${invoice.id}): status ${invoice.status}, ${money(invoice.paid_cents)} paid, ${money(invoice.due_cents)} due${invoice.allow_partial_payment ? `, partial payment allowed (minimum ${money(invoice.minimum_amount_due_cents)})` : ''}, due date ${invoice.due_date} (${invoice.source}).`);
  else lines.push('No PayPal invoice is attached to this rent period.');
  const unconfirmed = payments.filter((x) => x.status === 'COMPLETED' && !x.webhook_confirmed).length;
  return {
    generated_at: new Date().toISOString(), as_of: asOf,
    property: { unit: rp.unit_label, address: rp.unit_address },
    tenant: { name: rp.tenant_name, email: rp.tenant_email, phone: rp.tenant_phone },
    rent_period: { id: rp.id, period: rp.period, period_label: monthName(rp.period), due_date: rp.due_date, amount_due_cents: rp.amount_due_cents },
    summary: { status, paid_cents: paid, pending_cents: pending, balance_cents: balance, days_overdue: daysLate, late_fee_rule: fee,
      late_fee_past_grace: feeApplies, approved_plan_id: ap?.id ?? null, next_installment: nx ? { n: nx.n, of: nx.of, due_date: nx.due_date, amount_cents: nx.amount_cents, state: nx.state } : null,
      completed_payments: payments.filter((x) => x.status === 'COMPLETED').length, completed_without_webhook: unconfirmed, lines },
    invoice: invoice ? { ...invoice, matches_ledger: invoice.paid_cents == null ? null : invoice.paid_cents === paid } : null,
    events, payments, plans,
    integrity: { ledger_rows: rows.length, first_id: rows[0]?.id ?? null, last_id: rows.at(-1)?.id ?? null, sha256,
      note: 'SHA-256 of the ledger rows listed (id, at, kind, actor, summary, payload_json, paypal_event_id). The event_log table is append-only (DB triggers block UPDATE/DELETE/REPLACE); that is append-only, not tamper-proof.' },
  };
}

// ───────────────────────────── PDF ─────────────────────────────
// Standard PDF fonts are WinAnsi: map the few non-Latin-1 characters our summaries use, drop anything else.
const pdfSafe = (s) => String(s ?? '').replace(/[→]/g, '->').replace(/[✓✔]/g, 'v').replace(/[·•]/g, '-')
  .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—‘’“”…]/g, '?');

export function renderCourtPacketPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 54, left: 54, right: 54 }, bufferPages: true,
      info: { Title: `RentRoll payment record: ${data.property.unit}, ${data.rent_period.period_label}`, Author: 'RentRoll', Subject: 'Payment history', CreationDate: new Date(data.generated_at) } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    const L = doc.page.margins.left, W = doc.page.width - L - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const t = (s) => pdfSafe(s);

    const h2 = (s) => { if (doc.y > bottom() - 60) doc.addPage(); doc.moveDown(0.8).font('Helvetica-Bold').fontSize(12).fillColor('#111').text(t(s), L, doc.y, { width: W }); doc.moveTo(L, doc.y + 2).lineTo(L + W, doc.y + 2).lineWidth(0.5).strokeColor('#999').stroke(); doc.moveDown(0.5); };
    const kv = (k, v) => {
      doc.font('Helvetica').fontSize(9.5);
      const h = Math.max(doc.heightOfString(t(v), { width: W - 125 }), doc.currentLineHeight());
      if (doc.y + h > bottom()) doc.addPage();
      const y = doc.y;
      doc.font('Helvetica-Bold').fillColor('#333').text(t(k), L, y, { width: 120 });
      doc.font('Helvetica').fillColor('#111').text(t(v), L + 125, y, { width: W - 125 });
      doc.y = Math.max(doc.y, y + h); doc.x = L;
    };

    // Table with wrapping cells and page breaks that repeat the header.
    const table = (cols, rows, { size = 8.5 } = {}) => {
      const xs = []; let acc = L; for (const c of cols) { xs.push(acc); acc += c.w * W; }
      const header = () => { const y = doc.y; doc.rect(L, y - 2, W, 14).fill('#eee'); doc.font('Helvetica-Bold').fontSize(size).fillColor('#111');
        cols.forEach((c, i) => doc.text(t(c.h), xs[i] + 2, y + 1, { width: c.w * W - 4, align: c.align || 'left', lineBreak: false })); doc.y = y + 14; };
      header();
      rows.forEach((r, ri) => {
        const hs = cols.map((c, i) => doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).heightOfString(t(r[i]), { width: c.w * W - 4 }));
        const h = Math.max(...hs) + 5;
        if (doc.y + h > bottom()) { doc.addPage(); header(); }
        const y = doc.y;
        if (ri % 2) doc.rect(L, y - 1, W, h).fill('#f5f5f5');
        doc.fillColor('#111');
        cols.forEach((c, i) => doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).text(t(r[i]), xs[i] + 2, y + 1, { width: c.w * W - 4, align: c.align || 'left' }));
        doc.y = y + h;
      });
      doc.x = L;
    };

    // Header
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#111').text('Rent payment record', L, doc.y, { width: W });
    doc.font('Helvetica').fontSize(10).fillColor('#444').text(t(`${data.property.unit} - ${data.rent_period.period_label}`), { width: W });
    doc.moveDown(0.6);
    kv('Property / unit', `${data.property.unit}, ${data.property.address || ''}`);
    kv('Tenant', [data.tenant.name, data.tenant.email, data.tenant.phone].filter(Boolean).join('  |  '));
    kv('Rent amount', `${money(data.rent_period.amount_due_cents)} for ${data.rent_period.period_label}`);
    kv('Due date', data.rent_period.due_date);
    kv('Generated at', `${utc(data.generated_at)} (balance as of ${data.as_of})`);
    kv('Record ids', `rent_period #${data.rent_period.id}; ${data.integrity.ledger_rows} ledger rows for this rent period (ids #${data.integrity.first_id} to #${data.integrity.last_id}; ids in between belong to other units)`);
    doc.moveDown(0.5).font('Helvetica-Oblique').fontSize(8.5).fillColor('#555')
      .text('This is a record generated by RentRoll from PayPal transaction data. It is not legal advice.', L, doc.y, { width: W });

    // Summary
    h2(`Balance and status: ${data.summary.status}`);
    doc.font('Helvetica').fontSize(9.5).fillColor('#111');
    for (const line of data.summary.lines) doc.text(t(`- ${line}`), L, doc.y, { width: W });

    // PayPal invoice
    h2('PayPal invoice');
    if (!data.invoice) doc.font('Helvetica').fontSize(9.5).text('No PayPal invoice is attached to this rent period.', L, doc.y, { width: W });
    else {
      const iv = data.invoice;
      kv('Invoice number', iv.number || '-');
      kv('PayPal invoice id', iv.id);
      kv('Status at PayPal', `${iv.status} (${iv.source}, ${utc(iv.read_at)})`);
      kv('Paid / due', `${money(iv.paid_cents)} paid / ${money(iv.due_cents)} due${iv.matches_ledger == null ? '' : iv.matches_ledger ? ' (matches the payments below)' : ' (DOES NOT match the payments below)'}`);
      kv('Payment terms', `${iv.allow_partial_payment ? `partial payment allowed, minimum amount due ${money(iv.minimum_amount_due_cents)}` : 'full amount, no partial payment'}; due date ${iv.due_date}`);
      if (iv.payer_view_url) kv('Payer link', iv.payer_view_url);
      if (iv.transactions?.length) kv('Invoice transactions', iv.transactions.map((x) => `${x.payment_id}: ${money(x.amount_cents)} ${x.type}/${x.method} on ${x.payment_date}${x.note ? ` - ${x.note}` : ''}`).join('\n'));
    }

    // Payments
    h2('Payments (PayPal references)');
    if (!data.payments.length) doc.font('Helvetica').fontSize(9.5).text('No payment attempts recorded.', L, doc.y, { width: W });
    for (const p of data.payments) {
      if (doc.y > bottom() - 110) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111').text(t(`Payment #${p.id}: ${money(p.amount_cents)} - ${p.status}${p.plan_id ? ` (plan #${p.plan_id}, installment ${p.plan_installment})` : ''}${p.simulated ? ' [SIMULATED, no PayPal money movement]' : ''}`), L, doc.y, { width: W });
      doc.moveDown(0.15);
      kv('Paid at', p.paid_at ? utc(p.paid_at) : `- (attempt created ${utc(p.created_at)})`);
      kv('PayPal order id', p.paypal_order_id || 'not recorded');
      kv('PayPal capture id', p.paypal_capture_id || 'none');
      kv('Amount / fee / net', `${money(p.amount_cents)} / ${money(p.fee_cents)} / ${money(p.net_cents)}`);
      kv('Webhook confirmed', p.webhook_confirmed
        ? `Yes: PayPal event ${p.webhook_event_id}, created by PayPal ${utc(p.webhook_paypal_created_at)}, recorded by RentRoll ${utc(p.webhook_confirmed_at)}${p.webhook_via === 'backfill' ? ' (from the logged delivery)' : ''}; signature verification with PayPal: ${p.signature_verification || 'not recorded'}`
        : p.status === 'COMPLETED' ? 'No: captured per PayPal API response, PayPal webhook not received yet' : 'No');
      if (p.error) kv('Error', p.error);
      kv('On PayPal invoice', p.invoice_payment_id ? `Yes: invoice payment ${p.invoice_payment_id}${p.source === 'paypal_invoice' ? ' (paid on PayPal\'s side, read from the invoice)' : `, recorded by RentRoll ${utc(p.invoice_recorded_at)} (record-payment of the capture above)`}${p.invoice_webhook_event_id ? `; confirmed by PayPal invoice event ${p.invoice_webhook_event_id}` : ''}` : 'No');
      kv('Reference', `custom_id ${p.custom_id}${p.paypal_debug_id ? `; debug_id ${p.paypal_debug_id}` : ''}`);
      doc.moveDown(0.5);
    }

    // Plans
    if (data.plans.length) {
      h2('Payment plans');
      table([{ h: 'Plan', w: 0.1 }, { h: 'Status', w: 0.14 }, { h: 'Created (UTC)', w: 0.22 }, { h: 'Installments', w: 0.54 }],
        data.plans.map((pl) => [`#${pl.id}`, pl.status, utc(pl.created_at), pl.installments.map((i) => `${i.n}. ${money(i.amount_cents)} due ${i.due_date}${i.state ? ` (${i.state})` : ''}`).join('\n') || '-']));
    }

    // Timeline
    h2('Chronological ledger (every event recorded for this rent period)');
    table([{ h: 'Date / time (UTC)', w: 0.19 }, { h: 'Event', w: 0.2, bold: true }, { h: 'Details', w: 0.47 }, { h: 'Amount', w: 0.14, align: 'right' }],
      data.events.map((e) => [utc(e.at), `${e.label}\n#${e.id} - ${e.actor}`,
        e.summary + (e.kind === 'webhook_received' ? `\nPayPal event ${e.paypal_event_id || '-'} (created by PayPal ${utc(e.paypal_created_at)}); signature verification: ${e.verification || 'not recorded'}` : ''),
        e.amount_cents == null ? '' : money(e.amount_cents)]));

    h2('Integrity');
    doc.font('Helvetica').fontSize(8.5).fillColor('#333').text(t(`SHA-256: ${data.integrity.sha256}`), L, doc.y, { width: W });
    doc.text(t(data.integrity.note), { width: W });
    doc.text(t('PayPal invoice, order and capture ids can be looked up by the merchant account holder in PayPal (Invoices; Activity / transaction details). Data from the PayPal sandbox is test data, not real money.'), { width: W });

    // Footer with page numbers on every page.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const m = doc.page.margins.bottom; doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(7.5).fillColor('#777')
        .text(t(`RentRoll record - ${data.property.unit} ${data.rent_period.period} - generated ${utc(data.generated_at)} - page ${i + 1} of ${range.count}`), L, doc.page.height - 36, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = m;
    }
    doc.end();
  });
}
