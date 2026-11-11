// Sprint 10: PayPal Invoicing v2 is the system of record for each month's rent.
// Every function here talks to the real API (sandbox) through lib/paypal.js and returns PayPal's own
// representation; nothing is faked. Facts verified against the sandbox on 2026-11-11 (see docs/dev-log/SPRINT10.md):
//   - partial payment lives in configuration.partial_payment {allow_partial_payment, minimum_amount_due}
//   - PUT /v2/invoicing/invoices/{id} works on an already SENT invoice and changes BOTH
//     configuration.partial_payment.minimum_amount_due AND detail.payment_term.due_date (GET afterwards confirms)
//   - POST /v2/invoicing/invoices/{id}/payments (record-payment) with method PAYPAL: passing our Orders capture id
//     as `payment_id` returns 404 RESOURCE_NOT_FOUND; without it PayPal assigns an "EXTR-..." id and stores the
//     transaction with type EXTERNAL. So the capture id goes into the note.
//   - record-payment moves the invoice to PARTIALLY_PAID / PAID and fires a signed INVOICING.INVOICE.PAID webhook.
import { pp } from './paypal.js';

const usd = (cents) => ({ currency_code: 'USD', value: (cents / 100).toFixed(2) });
const toCents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));
const monthName = (p) => new Date(p + '-01T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const splitName = (n = '') => { const parts = n.trim().split(/\s+/); return { given_name: parts[0] || 'Tenant', surname: parts.slice(1).join(' ') || '-' }; };

export class InvoiceError extends Error {
  constructor(step, r) {
    super(`PayPal Invoicing ${step} failed: ${r.status} ${r.body?.name || ''} ${r.body?.details?.[0] ? `${r.body.details[0].issue} ${r.body.details[0].field || ''} ${r.body.details[0].description || ''}` : r.body?.message || ''} (debug_id ${r.debug_id})`.replace(/\s+/g, ' '));
    this.status = 502; this.paypal_status = r.status; this.debug_id = r.debug_id; this.body = r.body;
  }
}

// Plain facts RentRoll mirrors from a PayPal invoice representation.
export function invoiceFacts(inv) {
  if (!inv) return null;
  const pp_ = inv.configuration?.partial_payment || {};
  return {
    id: inv.id, number: inv.detail?.invoice_number ?? null, status: inv.status ?? null,
    total_cents: toCents(inv.amount?.value), due_cents: toCents(inv.due_amount?.value),
    paid_cents: toCents(inv.payments?.paid_amount?.value) ?? 0,
    allow_partial_payment: !!pp_.allow_partial_payment, minimum_amount_due_cents: toCents(pp_.minimum_amount_due?.value),
    due_date: inv.detail?.payment_term?.due_date ?? null,
    payer_view_url: inv.detail?.metadata?.recipient_view_url ?? null,
    transactions: (inv.payments?.transactions || []).map((t) => ({ payment_id: t.payment_id, type: t.type, method: t.method,
      amount_cents: toCents(t.amount?.value), payment_date: t.payment_date, note: t.note ?? null })),
    last_update_time: inv.detail?.metadata?.last_update_time ?? null,
  };
}

export async function getInvoice(id) {
  const r = await pp('GET', `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
  if (r.status !== 200) throw new InvoiceError('GET invoice', r);
  return r.body;
}

// Create + send one rent invoice. Starts as "pay in full" (no partial payment); approving a plan turns it on.
export async function createAndSendRentInvoice(rp, { invoiceNumber }) {
  const body = {
    detail: {
      invoice_number: invoiceNumber, currency_code: 'USD', invoice_date: new Date().toISOString().slice(0, 10),
      payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: rp.due_date },
      reference: `RentRoll rent_period ${rp.id}`,
      note: `${monthName(rp.period)} rent, ${rp.unit_label}, ${rp.unit_address || ''}`.trim(),
      memo: `RentRoll rent_period ${rp.id} (unit ${rp.unit_id}, ${rp.period})`,
    },
    invoicer: { name: { given_name: 'RentRoll', surname: 'Landlord' } },
    primary_recipients: [{ billing_info: { name: splitName(rp.tenant_name), email_address: rp.tenant_email || undefined } }],
    items: [{ name: `${monthName(rp.period)} rent, ${rp.unit_label}`, quantity: '1', unit_amount: usd(rp.amount_due_cents), unit_of_measure: 'AMOUNT' }],
    configuration: { partial_payment: { allow_partial_payment: false } },
  };
  const c = await pp('POST', '/v2/invoicing/invoices', body, { 'PayPal-Request-Id': `rr-inv-${invoiceNumber}` });
  if (c.status >= 300) throw new InvoiceError('create invoice', c);
  const id = c.body?.id || c.body?.href?.split('/').pop();
  const s = await pp('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_invoicer: false, send_to_recipient: true });
  if (s.status >= 300) throw new InvoiceError('send invoice', s);
  return { invoice: await getInvoice(id), create_debug_id: c.debug_id, send_debug_id: s.debug_id, payer_view_href: s.body?.href ?? null };
}

// Write the plan onto the real invoice: GET the current representation, change configuration.partial_payment
// (+ the due date and note), PUT it back, GET again so the caller gets what PayPal actually stored.
export async function applyTermsToInvoice(id, { allowPartial, minimumCents, dueDate, note }) {
  const before = await getInvoice(id);
  const upd = structuredClone(before);
  upd.configuration = { ...upd.configuration, partial_payment: allowPartial
    ? { allow_partial_payment: true, minimum_amount_due: usd(minimumCents) }
    : { allow_partial_payment: false } };
  if (dueDate) upd.detail.payment_term = { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: dueDate };
  if (note) upd.detail.note = note.slice(0, 4000);
  const r = await pp('PUT', `/v2/invoicing/invoices/${encodeURIComponent(id)}?send_to_recipient=true&send_to_invoicer=false`, upd);
  if (r.status >= 300) throw new InvoiceError('update invoice (PUT)', r);
  const after = await getInvoice(id);
  return { before, after, put_debug_id: r.debug_id };
}

// Record a payment that moved through PayPal Orders onto the invoice (record-payment). PayPal stores it as an
// EXTERNAL transaction with method PAYPAL and our note; it assigns its own EXTR-... payment id.
export async function recordPaymentOnInvoice(id, { amountCents, paymentDate, note }) {
  const r = await pp('POST', `/v2/invoicing/invoices/${encodeURIComponent(id)}/payments`,
    { method: 'PAYPAL', payment_date: paymentDate, amount: usd(amountCents), note: note.slice(0, 2000) });
  if (r.status >= 300) throw new InvoiceError('record-payment', r);
  return { invoice_payment_id: r.body?.payment_id ?? null, debug_id: r.debug_id };
}
