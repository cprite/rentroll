// Re-deliver a stored PayPal webhook event to all subscribed webhooks (use once rentroll.service is confirmed up).
import { call } from './sprint0-log.js';
const r = await call('webhook.resend', 'POST', `/v1/notifications/webhooks-events/${process.argv[2]}/resend`, { webhook_ids: process.argv[3] ? [process.argv[3]] : undefined });
console.log(r.status, JSON.stringify(r.body).slice(0, 300));
