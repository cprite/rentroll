import { call } from './sprint0-log.js';
const url = `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/webhooks/paypal`;
const events = ['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.UPDATED', 'INVOICING.INVOICE.CANCELLED', 'PAYMENT.CAPTURE.COMPLETED', 'PAYMENT.CAPTURE.DENIED', 'CHECKOUT.ORDER.APPROVED'];
const r = await call('webhook.create', 'POST', '/v1/notifications/webhooks', { url, event_types: events.map(name => ({ name })) });
console.log(JSON.stringify(r.body, null, 1));
