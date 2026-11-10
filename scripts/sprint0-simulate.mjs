import { call } from './sprint0-log.js';
const webhook_id = process.argv[2];
const event_type = process.argv[3] || 'PAYMENT.CAPTURE.COMPLETED';
const r = await call('webhook.simulate', 'POST', '/v1/notifications/simulate-event', { webhook_id, event_type, resource_version: event_type.startsWith('INVOICING') ? '1.0' : '2.0' });
console.log(r.status, r.body?.id, r.body?.event_type, r.status >= 300 ? JSON.stringify(r.body) : '');
