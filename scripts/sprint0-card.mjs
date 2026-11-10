// Real sandbox capture with a PayPal-documented test card (developer.paypal.com/tools/sandbox/card-testing), no buyer login.
import { call } from './sprint0-log.js';
const value = process.argv[2] || '800.00';
const r = await call('order.card-create', 'POST', '/v2/checkout/orders', {
  intent: 'CAPTURE',
  purchase_units: [{ reference_id: 'unit-2-2026-11', custom_id: 'RR-unit2-2026-11-partial1', invoice_id: `RR-S0-CARD-${Date.now().toString(36)}`,
    description: 'November rent, Unit 2 (partial payment 1 of 2)', amount: { currency_code: 'USD', value } }],
  payment_source: { card: { number: '4012000033330026', expiry: '2030-12', security_code: '123', name: 'Jordan Tenant',
    billing_address: { address_line_1: '14 Elm St', admin_area_2: 'Columbus', admin_area_1: 'OH', postal_code: '43004', country_code: 'US' } } },
}, { 'PayPal-Request-Id': `rr-s0-${Date.now()}` });
const b = r.body;
console.log('status', b?.status, 'name', b?.name, b?.message);
const cap = b?.purchase_units?.[0]?.payments?.captures?.[0];
console.log('capture', JSON.stringify(cap && { id: cap.id, status: cap.status, amount: cap.amount, fee: cap.seller_receivable_breakdown?.paypal_fee, net: cap.seller_receivable_breakdown?.net_amount }));
if (r.status >= 300) console.log(JSON.stringify(b, null, 1));
