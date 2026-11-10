import { call } from './sprint0-log.js';
const r = await call('webhook.event-get', 'GET', `/v1/notifications/webhooks-events/${process.argv[2]}`);
const { resource, ...rest } = r.body || {};
console.log(JSON.stringify(rest, null, 1));
console.log('resource keys', Object.keys(resource || {}).join(','), 'custom_id', resource?.custom_id, 'invoice_id', resource?.invoice_id, 'order', resource?.supplementary_data?.related_ids?.order_id);
