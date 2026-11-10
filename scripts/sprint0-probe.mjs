import { call } from './sprint0-log.js';
await call('probe.inv-list', 'GET', '/v2/invoicing/invoices?page_size=1');
await call('probe.inv-nextnum', 'POST', '/v2/invoicing/generate-next-invoice-number', {});
await call('probe.inv-search', 'POST', '/v2/invoicing/search-invoices?page_size=1', { status: ['SENT'] });
const o = await call('probe.order-create', 'POST', '/v2/checkout/orders', { intent: 'CAPTURE', purchase_units: [{ reference_id: 'probe', amount: { currency_code: 'USD', value: '1.00' } }] });
console.log('order', o.body?.id, o.body?.status);
const w = await call('probe.webhooks-list', 'GET', '/v1/notifications/webhooks');
console.log('existing webhooks', JSON.stringify(w.body?.webhooks?.map(x => ({ id: x.id, url: x.url, events: x.event_types.map(e => e.name) }))));
