import { call } from './sprint0-log.js';
const r = await call('webhook.events-list', 'GET', '/v1/notifications/webhooks-events?page_size=20');
for (const e of r.body?.events ?? []) console.log(e.create_time, e.event_type, e.id, 'resource', e.resource?.id, 'status', e.status ?? '-', 'tx', JSON.stringify(e.transmissions ?? null));
console.log('count', r.body?.events?.length, r.status >= 300 ? JSON.stringify(r.body) : '');
