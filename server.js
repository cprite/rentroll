import express from 'express';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEBHOOK_LOG = path.join(__dirname, '.sprint0-webhook-log.jsonl');
const PORT = 8790;
const HOST = '127.0.0.1';

const app = express();

// Sprint 0 scaffolding: log every PayPal webhook delivery verbatim, ack immediately.
// Raw body is kept so later sprints can verify signatures against the exact bytes.
app.post('/webhooks/paypal', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  res.status(200).json({ ok: true });
  const raw = req.body ? req.body.toString('utf8') : '';
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  const entry = { received_at: new Date().toISOString(), method: req.method, url: req.originalUrl, headers: req.headers, body };
  try { appendFileSync(WEBHOOK_LOG, JSON.stringify(entry) + '\n'); } catch (e) { console.error('webhook log write failed:', e.message); }
  console.log(`[webhook] ${body?.event_type ?? 'unknown'} ${body?.id ?? ''}`);
});

app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'rentroll' }));
app.get('/', (_req, res) => res.type('text/plain').send('RentRoll — sprint 0 scaffold'));

app.listen(PORT, HOST, () => console.log(`rentroll listening on http://${HOST}:${PORT}`));
