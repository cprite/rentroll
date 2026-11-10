import { call } from './sprint0-log.js';
const tag = Date.now().toString(36).toUpperCase();
const due = '2026-11-30';
const draft = (num, partial) => ({
  detail: {
    invoice_number: `RR-S0-${num}-${tag}`,
    currency_code: 'USD',
    invoice_date: '2026-11-10',
    payment_term: { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: due },
    note: 'November rent, Unit 2, 14 Elm St.',
    memo: 'RentRoll sprint 0 test',
  },
  invoicer: { name: { given_name: 'Pat', surname: 'Landlord' } },
  primary_recipients: [{ billing_info: { name: { given_name: 'Jordan', surname: 'Tenant' }, email_address: 'jordan.tenant.unit2@example.com' } }],
  items: [{ name: 'November rent, Unit 2', quantity: '1', unit_amount: { currency_code: 'USD', value: '1800.00' }, unit_of_measure: 'AMOUNT' }],
  configuration: partial ? { partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '800.00' } } } : { partial_payment: { allow_partial_payment: false } },
});

// A: partial payment enabled at creation
const a = await call('A.create', 'POST', '/v2/invoicing/invoices', draft('A', true));
if (a.status >= 300) { console.log(JSON.stringify(a.body, null, 2)); process.exit(1); }
const aId = a.body.id || a.body.href?.split('/').pop();
console.log('A id', aId, 'status', a.body.status, 'config', JSON.stringify(a.body.configuration));
const aSend = await call('A.send', 'POST', `/v2/invoicing/invoices/${aId}/send`, { send_to_invoicer: false, send_to_recipient: true });
console.log(JSON.stringify(aSend.body));
const aGet = await call('A.get', 'GET', `/v2/invoicing/invoices/${aId}`);
console.log('A after send', aGet.body.status, JSON.stringify(aGet.body.configuration), 'links', JSON.stringify(aGet.body.links?.map(l => l.rel)), 'recipient_view_url', aGet.body.detail?.metadata?.recipient_view_url);

// B: full-pay invoice sent first, then partial payment written back by PUT (the real RentRoll flow)
const b = await call('B.create', 'POST', '/v2/invoicing/invoices', draft('B', false));
const bId = b.body.id || b.body.href?.split('/').pop();
await call('B.send', 'POST', `/v2/invoicing/invoices/${bId}/send`, { send_to_invoicer: false, send_to_recipient: true });
const bGet = await call('B.get-before', 'GET', `/v2/invoicing/invoices/${bId}`);
const upd = structuredClone(bGet.body);
upd.configuration = { ...upd.configuration, partial_payment: { allow_partial_payment: true, minimum_amount_due: { currency_code: 'USD', value: '800.00' } } };
upd.detail.note = 'November rent, Unit 2. Plan agreed 2026-11-10: $800 now, $1,000 by 2026-11-15.';
const bPut = await call('B.put-partial', 'PUT', `/v2/invoicing/invoices/${bId}?send_to_recipient=true&send_to_invoicer=false`, upd);
console.log('B PUT', bPut.status, bPut.status < 300 ? JSON.stringify(bPut.body.configuration) : JSON.stringify(bPut.body));
console.log(JSON.stringify({ aId, bId }));
