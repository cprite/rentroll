// RentRoll server (Sprint 1: data model, dashboard, sandbox capture, webhook ledger).
//
// One file on purpose for tonight: schema + seed + domain logic + dashboard + PayPal endpoints.
//   node server.js                 start (auto-creates data/rentroll.db, seeds demo data if empty,
//                                  back-fills webhook deliveries from .sprint0-webhook-log.jsonl)
//   node server.js --seed [--reset] seed demo data and exit (--reset wipes the demo DB and rotates the
//                                  webhook log aside; stop rentroll.service first, start it again after)
//   node server.js --ingest-webhook-log  replay logged deliveries through the handler and exit (idempotent)
//
// INVOICING (blocked: sandbox app has no Invoicing scope, 403 NOT_AUTHORIZED, see SPRINT0.md):
//   the ready-to-run plumbing is scripts/sprint0-invoice.mjs (create+send, partial payment via
//   configuration.partial_payment, PUT onto a sent invoice). Once the scope is granted, wire it in by
//   setting rent_period.paypal_invoice_id / paypal_invoice_status / payer_view_url and adding an
//   INVOICING.INVOICE.PAID case in handleWebhook() below (GET the invoice, read status + payments).
import express from 'express';
import { appendFileSync, readFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pp } from './lib/paypal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Raw delivery log, kept for audit (override in tests so fake events never land in the real log).
const WEBHOOK_LOG = process.env.RENTROLL_WEBHOOK_LOG || path.join(__dirname, '.sprint0-webhook-log.jsonl');
const DB_PATH = process.env.RENTROLL_DB || path.join(__dirname, 'data', 'rentroll.db');
const PORT = Number(process.env.PORT) || 8790;
const HOST = '127.0.0.1';
// Webhook id registered in Sprint 0 (not a secret). Override if the webhook is re-registered.
const WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID || '8X653932CG029174U';
// 'enforce' (default): reject (400) deliveries whose PayPal verification_status is not SUCCESS, so an
//   unsigned/forged POST can never create a payment or change a rent period (TESTER1 F1).
// 'record': debugging only. Verify and store the result, but still process unverified deliveries.
const WEBHOOK_VERIFY = process.env.WEBHOOK_VERIFY === 'record' ? 'record' : 'enforce';
const today = () => process.env.RENTROLL_TODAY || new Date().toISOString().slice(0, 10);

// ───────────────────────────── data model ─────────────────────────────
// All money is integer cents; timestamps ISO-8601 UTC.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenant (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,              -- PayPal invoice recipient once Invoicing is enabled
  phone      TEXT,
  unit_id    INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS unit (
  id                 INTEGER PRIMARY KEY,
  label              TEXT NOT NULL,     -- "Unit 2"
  address            TEXT,
  monthly_rent_cents INTEGER NOT NULL CHECK (monthly_rent_cents > 0),
  due_day            INTEGER NOT NULL DEFAULT 1 CHECK (due_day BETWEEN 1 AND 28),
  late_fee_rule_json TEXT,              -- {"grace_days":5,"type":"flat","value_cents":7500,"state":"OH"}
  tenant_id          INTEGER REFERENCES tenant(id),
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS rent_period (
  id                    INTEGER PRIMARY KEY,
  unit_id               INTEGER NOT NULL REFERENCES unit(id),
  tenant_id             INTEGER REFERENCES tenant(id),
  period                TEXT NOT NULL,        -- "2026-11"
  due_date              TEXT NOT NULL,        -- "2026-11-01"
  amount_due_cents      INTEGER NOT NULL CHECK (amount_due_cents > 0),
  amount_paid_cents     INTEGER NOT NULL DEFAULT 0,  -- derived from COMPLETED payments by recompute()
  status                TEXT NOT NULL DEFAULT 'UNPAID' CHECK (status IN ('UNPAID','PARTIALLY_PAID','PAID')),
  paypal_invoice_id     TEXT,                 -- NULL until Invoicing permission is granted
  paypal_invoice_status TEXT,                 -- mirror of PayPal invoice status
  payer_view_url        TEXT,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (unit_id, period)
);
CREATE TABLE IF NOT EXISTS message (
  id                 INTEGER PRIMARY KEY,
  tenant_id          INTEGER REFERENCES tenant(id),
  direction          TEXT NOT NULL CHECK (direction IN ('in','out')),
  channel            TEXT NOT NULL,     -- sms | email | app
  body               TEXT NOT NULL,
  received_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ai_extraction_json TEXT
);
CREATE TABLE IF NOT EXISTS plan (           -- schema only in Sprint 1; Sprint 2 (AI proposal + approval) fills it
  id                INTEGER PRIMARY KEY,
  rent_period_id    INTEGER NOT NULL REFERENCES rent_period(id),
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','approved','rejected','broken','completed')),
  source_message_id INTEGER REFERENCES message(id),
  installments_json TEXT NOT NULL DEFAULT '[]',  -- [{due_date, amount_cents, payment_id?}]
  ai_rationale      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at       TEXT
);
CREATE TABLE IF NOT EXISTS payment (
  id                   INTEGER PRIMARY KEY,
  rent_period_id       INTEGER NOT NULL REFERENCES rent_period(id),
  installment_index    INTEGER NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('paypal_capture','paypal_invoice','record_payment_external')),
  status               TEXT NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED','DENIED')),
  amount_cents         INTEGER NOT NULL CHECK (amount_cents > 0),
  fee_cents            INTEGER,
  net_cents            INTEGER,
  custom_id            TEXT NOT NULL UNIQUE,  -- RR:rp<id>:<period>:u<unit>:i<installment>:<attempt>
  paypal_request_id    TEXT UNIQUE,           -- PayPal-Request-Id (idempotency per attempt)
  paypal_order_id      TEXT,
  paypal_capture_id    TEXT UNIQUE,
  paypal_debug_id      TEXT,
  error                TEXT,
  simulated            INTEGER NOT NULL DEFAULT 0, -- 1 = no real PayPal money movement (record-payment of cash)
  paid_at              TEXT,
  webhook_event_id     TEXT,                  -- set when PayPal's PAYMENT.CAPTURE.COMPLETED confirms it
  webhook_confirmed_at TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- Append-only ledger (becomes the court packet). Triggers forbid UPDATE/DELETE.
CREATE TABLE IF NOT EXISTS event_log (
  id              INTEGER PRIMARY KEY,
  at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind            TEXT NOT NULL,  -- seed, payment, webhook_received; later: message_in, plan_proposed,
                                  -- plan_approved, invoice_sent, invoice_updated, reminder_sent
  actor           TEXT NOT NULL,  -- landlord | tenant | paypal | system
  rent_period_id  INTEGER REFERENCES rent_period(id),
  summary         TEXT NOT NULL,
  payload_json    TEXT,
  paypal_event_id TEXT UNIQUE     -- webhook idempotency key
);
CREATE TRIGGER IF NOT EXISTS event_log_no_update BEFORE UPDATE ON event_log
  BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_log_no_delete BEFORE DELETE ON event_log
  BEGIN SELECT RAISE(ABORT, 'event_log is append-only'); END;
-- INSERT OR REPLACE deletes the conflicting row without firing the DELETE trigger when recursive_triggers
-- is off (the default for any other connection, e.g. the sqlite3 CLI). Block it at schema level (TESTER1 F3).
-- Note: anyone with write access to the file can still DROP these triggers; this is append-only, not tamper-proof.
CREATE TRIGGER IF NOT EXISTS event_log_no_replace BEFORE INSERT ON event_log
  WHEN EXISTS (SELECT 1 FROM event_log WHERE id = NEW.id)
  BEGIN SELECT RAISE(ABORT, 'event_log is append-only: id already exists'); END;
CREATE TRIGGER IF NOT EXISTS event_log_no_replace_event BEFORE INSERT ON event_log
  WHEN NEW.paypal_event_id IS NOT NULL AND EXISTS (SELECT 1 FROM event_log WHERE paypal_event_id = NEW.paypal_event_id)
  BEGIN SELECT RAISE(ABORT, 'event_log is append-only: duplicate paypal_event_id'); END;
CREATE INDEX IF NOT EXISTS payment_period ON payment(rent_period_id);
CREATE INDEX IF NOT EXISTS event_period ON event_log(rent_period_id);
`;

function openDb(file = DB_PATH) {
  mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA recursive_triggers = ON;');
  d.exec(SCHEMA);
  return d;
}
// node:sqlite has no transaction helper; BEGIN IMMEDIATE serialises writers (also across processes).
function tx(d, fn) {
  d.exec('BEGIN IMMEDIATE');
  try { const r = fn(); d.exec('COMMIT'); return r; } catch (e) { try { d.exec('ROLLBACK'); } catch {} throw e; }
}

// ───────────────────────────── seed (fake, sandbox-only people) ─────────────────────────────
const SEED_PERIOD = '2026-11';
const SEED_UNITS = [
  { label: 'Unit 2', address: '418 Larkspur Ave, Apt 2, Columbus, OH 43206', rent: 180000,
    tenant: { name: 'Jordan Ellis', email: 'jordan.ellis@tenant.example.com', phone: '+1-614-555-0142' } },
  { label: 'Unit 3', address: '418 Larkspur Ave, Apt 3, Columbus, OH 43206', rent: 120000,
    tenant: { name: 'Priya Nair', email: 'priya.nair@tenant.example.com', phone: '+1-614-555-0187' } },
];
const LATE_FEE = { grace_days: 5, type: 'flat', value_cents: 7500, state: 'OH' };

function seed(d) {
  if (d.prepare('SELECT COUNT(*) n FROM unit').get().n > 0) return 0;
  return tx(d, () => {
    for (const u of SEED_UNITS) {
      const tenantId = Number(d.prepare('INSERT INTO tenant (name, email, phone) VALUES (?,?,?)')
        .run(u.tenant.name, u.tenant.email, u.tenant.phone).lastInsertRowid);
      const unitId = Number(d.prepare('INSERT INTO unit (label, address, monthly_rent_cents, due_day, late_fee_rule_json, tenant_id) VALUES (?,?,?,?,?,?)')
        .run(u.label, u.address, u.rent, 1, JSON.stringify(LATE_FEE), tenantId).lastInsertRowid);
      d.prepare('UPDATE tenant SET unit_id=? WHERE id=?').run(unitId, tenantId);
      const rpId = Number(d.prepare('INSERT INTO rent_period (unit_id, tenant_id, period, due_date, amount_due_cents) VALUES (?,?,?,?,?)')
        .run(unitId, tenantId, SEED_PERIOD, `${SEED_PERIOD}-01`, u.rent).lastInsertRowid);
      logEvent(d, { kind: 'seed', actor: 'system', rent_period_id: rpId,
        summary: `${monthName(SEED_PERIOD)} rent opened for ${u.label} (${u.tenant.name}): ${money(u.rent)} due ${SEED_PERIOD}-01`,
        payload: { unit_id: unitId, tenant_id: tenantId } });
    }
    return SEED_UNITS.length;
  });
}

// ───────────────────────────── domain logic ─────────────────────────────
const money = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const toCents = (v) => (v == null || v === '' ? NaN : Math.round(Number(v) * 100));
const monthName = (p) => new Date(p + '-01T00:00:00Z').toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const parseMoney = (s) => {
  const m = /^\s*\$?(\d{1,6})(?:\.(\d{1,2}))?\s*$/.exec(String(s ?? '').replace(/,/g, ''));
  return m ? Number(m[1]) * 100 + Number((m[2] || '0').padEnd(2, '0')) : null;
};
const CUSTOM_ID_RE = /^RR:rp(\d+):(\d{4}-\d{2}):u(\d+):i(\d+)(?::[0-9a-z]+)?$/;

function logEvent(d, { kind, actor, rent_period_id = null, summary, payload = null, paypal_event_id = null }) {
  d.prepare('INSERT INTO event_log (kind, actor, rent_period_id, summary, payload_json, paypal_event_id) VALUES (?,?,?,?,?,?)')
    .run(kind, actor, rent_period_id, summary, payload == null ? null : JSON.stringify(payload), paypal_event_id);
}

function getPeriod(d, id) {
  return d.prepare(`SELECT rp.*, u.label unit_label, u.address unit_address, u.late_fee_rule_json,
      t.name tenant_name, t.email tenant_email, t.phone tenant_phone
    FROM rent_period rp JOIN unit u ON u.id = rp.unit_id LEFT JOIN tenant t ON t.id = rp.tenant_id WHERE rp.id = ?`).get(id);
}

// Single source of truth for paid amount + status: sum of COMPLETED payments.
function recompute(d, rpId) {
  const rp = d.prepare('SELECT amount_due_cents, status FROM rent_period WHERE id=?').get(rpId);
  const paid = d.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM payment WHERE rent_period_id=? AND status='COMPLETED'").get(rpId).s;
  const status = paid >= rp.amount_due_cents ? 'PAID' : paid > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
  d.prepare("UPDATE rent_period SET amount_paid_cents=?, status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(paid, status, rpId);
  return { before: rp.status, status, paid_cents: paid, balance_cents: rp.amount_due_cents - paid };
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const captureFields = (cap) => {
  const b = cap?.seller_receivable_breakdown;
  return { fee: b?.paypal_fee ? toCents(b.paypal_fee.value) : null, net: b?.net_amount ? toCents(b.net_amount.value) : null };
};

// "Tenant pays $X now": create-and-capture a PayPal Order with the documented sandbox test card
// (developer.paypal.com/tools/sandbox/card-testing), no buyer login. Exactly the Sprint 0 flow.
const SANDBOX_HOSTS = new Set(['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com']);
const isSandboxBase = (base) => { try { return SANDBOX_HOSTS.has(new URL(base).hostname.toLowerCase()); } catch { return false; } };
async function payRentPeriodSandbox(d, rpId, amountCents) {
  if (!isSandboxBase(process.env.PAYPAL_API_BASE || '')) throw new HttpError(503, 'sandbox card payments are disabled: PAYPAL_API_BASE is not a sandbox URL');
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new HttpError(400, 'amount must be a positive dollar amount, e.g. "800.00"');

  // 1. Reserve the attempt locally first (PENDING) so a webhook racing the API response can still match it.
  const attempt = tx(d, () => {
    const rp = getPeriod(d, rpId);
    if (!rp) throw new HttpError(404, `rent period ${rpId} not found`);
    const pending = d.prepare("SELECT COALESCE(SUM(amount_cents),0) s FROM payment WHERE rent_period_id=? AND status='PENDING'").get(rpId).s;
    const open = rp.amount_due_cents - rp.amount_paid_cents - pending;
    if (open <= 0) throw new HttpError(409, `${rp.unit_label} ${rp.period} has no open balance`);
    if (amountCents > open) throw new HttpError(422, `amount ${money(amountCents)} exceeds open balance ${money(open)}`);
    const idx = d.prepare("SELECT COUNT(*) n FROM payment WHERE rent_period_id=? AND status IN ('COMPLETED','PENDING')").get(rpId).n + 1;
    const nonce = randomUUID().slice(0, 8);
    const customId = `RR:rp${rp.id}:${rp.period}:u${rp.unit_id}:i${idx}:${nonce}`;
    const requestId = `rr-${rp.id}-${idx}-${randomUUID()}`;
    const payId = Number(d.prepare(`INSERT INTO payment (rent_period_id, installment_index, source, status, amount_cents, custom_id, paypal_request_id)
      VALUES (?,?,?,?,?,?,?)`).run(rp.id, idx, 'paypal_capture', 'PENDING', amountCents, customId, requestId).lastInsertRowid);
    return { rp, idx, customId, requestId, payId };
  });
  const { rp, idx, customId, requestId, payId } = attempt;

  // 2. Create + capture in one call (intent CAPTURE + payment_source.card).
  let r;
  try {
    r = await pp('POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: `rp${rp.id}`, custom_id: customId, invoice_id: `RR-${rp.period}-U${rp.unit_id}-P${payId}-${customId.slice(-8)}`,
        description: `${monthName(rp.period)} rent, ${rp.unit_label} (payment ${idx})`,
        amount: { currency_code: 'USD', value: (amountCents / 100).toFixed(2) },
      }],
      payment_source: { card: { number: '4012000033330026', expiry: '2030-12', security_code: '123', name: rp.tenant_name || 'Tenant',
        billing_address: { address_line_1: '418 Larkspur Ave', admin_area_2: 'Columbus', admin_area_1: 'OH', postal_code: '43206', country_code: 'US' } } },
    }, { 'PayPal-Request-Id': requestId });
  } catch (e) {
    tx(d, () => d.prepare("UPDATE payment SET status='FAILED', error=? WHERE id=? AND status='PENDING'").run(`network: ${e.message}`, payId));
    throw new HttpError(502, `PayPal unreachable: ${e.message}`);
  }

  // 3. Record the outcome.
  const order = r.body || {};
  const cap = order.purchase_units?.[0]?.payments?.captures?.[0];
  return tx(d, () => {
    if (r.status >= 300 || !cap) {
      const err = `${r.status} ${order.name || ''} ${order.details?.[0]?.issue || order.message || ''}`.trim();
      d.prepare("UPDATE payment SET status='FAILED', error=?, paypal_debug_id=? WHERE id=? AND status='PENDING'").run(err, r.debug_id, payId);
      logEvent(d, { kind: 'payment', actor: 'tenant', rent_period_id: rp.id, summary: `Card payment of ${money(amountCents)} failed (${err})`,
        payload: { payment_id: payId, debug_id: r.debug_id } });
      throw new HttpError(502, `PayPal rejected the payment: ${err} (debug_id ${r.debug_id})`);
    }
    const { fee, net } = captureFields(cap);
    const status = cap.status === 'COMPLETED' ? 'COMPLETED' : cap.status === 'DECLINED' || cap.status === 'FAILED' ? 'FAILED' : 'PENDING';
    // A webhook may already have completed this row; never downgrade.
    d.prepare(`UPDATE payment SET status = CASE WHEN status='COMPLETED' THEN status ELSE ? END,
        paypal_order_id=?, paypal_capture_id=?, paypal_debug_id=?, fee_cents=COALESCE(fee_cents, ?), net_cents=COALESCE(net_cents, ?),
        paid_at=COALESCE(paid_at, ?) WHERE id=?`)
      .run(status, order.id, cap.id, r.debug_id, fee, net, status === 'COMPLETED' ? (cap.create_time || new Date().toISOString()) : null, payId);
    const s = recompute(d, rp.id);
    logEvent(d, { kind: 'payment', actor: 'tenant', rent_period_id: rp.id,
      summary: `${rp.tenant_name} paid ${money(amountCents)} by card through PayPal (capture ${cap.id}, ${cap.status}). Balance now ${money(s.balance_cents)}`,
      payload: { payment_id: payId, order_id: order.id, capture_id: cap.id, capture_status: cap.status, fee_cents: fee, net_cents: net, custom_id: customId } });
    return { payment: d.prepare('SELECT * FROM payment WHERE id=?').get(payId), rent_period: s };
  });
}

// ───────────────────────────── webhooks ─────────────────────────────
async function verifySignature(headers, rawBody) {
  const h = (k) => headers?.[k];
  if (!h('paypal-transmission-sig')) return 'SKIPPED_NO_HEADERS';
  try {
    // Splice the exact raw bytes in, so re-serialisation can't break the signature check.
    const body = `{"auth_algo":${JSON.stringify(h('paypal-auth-algo'))},"cert_url":${JSON.stringify(h('paypal-cert-url'))},` +
      `"transmission_id":${JSON.stringify(h('paypal-transmission-id'))},"transmission_sig":${JSON.stringify(h('paypal-transmission-sig'))},` +
      `"transmission_time":${JSON.stringify(h('paypal-transmission-time'))},"webhook_id":${JSON.stringify(WEBHOOK_ID)},"webhook_event":${rawBody}}`;
    const r = await pp('POST', '/v1/notifications/verify-webhook-signature', body);
    return r.status === 200 ? r.body?.verification_status || 'UNKNOWN' : `ERROR_${r.status}`;
  } catch (e) { return `ERROR_${e.message}`; }
}

// Idempotent by event.id (event_log.paypal_event_id is UNIQUE). Returns a small result object.
async function handleWebhook(d, event, { headers = {}, rawBody, via = 'live' } = {}) {
  if (!event?.id || !event?.event_type) return { result: 'ignored_no_id' };
  const seen = () => d.prepare('SELECT id FROM event_log WHERE paypal_event_id=?').get(event.id);
  if (seen()) return { result: 'duplicate', event_id: event.id };

  const verification = await verifySignature(headers, rawBody ?? JSON.stringify(event));
  if (WEBHOOK_VERIFY === 'enforce' && verification !== 'SUCCESS') return { result: 'rejected_signature', verification };

  const res = event.resource || {};
  const base = { event_id: event.id, event_type: event.event_type, verification, via };
  try {
    return tx(d, () => {
      if (seen()) return { result: 'duplicate', event_id: event.id };
      const meta = { ...base, resource_id: res.id, custom_id: res.custom_id, amount: res.amount, create_time: event.create_time ?? null };

      if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED' || event.event_type === 'PAYMENT.CAPTURE.DENIED') {
        const completed = event.event_type === 'PAYMENT.CAPTURE.COMPLETED';
        let pay = d.prepare('SELECT * FROM payment WHERE paypal_capture_id=?').get(res.id)
          || (res.custom_id && d.prepare('SELECT * FROM payment WHERE custom_id=?').get(res.custom_id));
        const m = CUSTOM_ID_RE.exec(res.custom_id || '');
        // Captured outside this app (e.g. a later demo script) but carrying our custom_id: create the row.
        if (!pay && m && completed && getPeriod(d, Number(m[1]))) {
          const amt = toCents(res.amount?.value);
          const { fee, net } = captureFields(res);
          const id = Number(d.prepare(`INSERT INTO payment (rent_period_id, installment_index, source, status, amount_cents, fee_cents, net_cents,
              custom_id, paypal_capture_id, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(Number(m[1]), Number(m[4]), 'paypal_capture', 'COMPLETED', amt, fee, net, res.custom_id, res.id, res.create_time || event.create_time || new Date().toISOString()).lastInsertRowid);
          pay = d.prepare('SELECT * FROM payment WHERE id=?').get(id);
        }
        if (!pay) {
          logEvent(d, { kind: 'webhook_received', actor: 'paypal', summary: `PayPal ${event.event_type} for capture ${res.id} did not match any RentRoll payment (custom_id ${res.custom_id || 'none'})`,
            payload: meta, paypal_event_id: event.id });
          return { result: 'unmatched', ...base };
        }
        const { fee, net } = captureFields(res);
        if (completed) {
          d.prepare(`UPDATE payment SET status='COMPLETED', paypal_capture_id=COALESCE(paypal_capture_id, ?), fee_cents=COALESCE(fee_cents, ?),
              net_cents=COALESCE(net_cents, ?), paid_at=COALESCE(paid_at, ?), webhook_event_id=?, webhook_confirmed_at=? WHERE id=?`)
            .run(res.id, fee, net, res.create_time || event.create_time || new Date().toISOString(), event.id, new Date().toISOString(), pay.id);
        } else {
          d.prepare("UPDATE payment SET status='DENIED', webhook_event_id=?, webhook_confirmed_at=?, error='PAYMENT.CAPTURE.DENIED' WHERE id=?")
            .run(event.id, new Date().toISOString(), pay.id);
        }
        const s = recompute(d, pay.rent_period_id);
        const rp = getPeriod(d, pay.rent_period_id);
        logEvent(d, { kind: 'webhook_received', actor: 'paypal', rent_period_id: rp.id,
          summary: completed
            ? `PayPal confirmed ${money(pay.amount_cents)} from ${rp.tenant_name} (capture ${res.id}). ${rp.unit_label} ${monthName(rp.period)}: ${s.status.replace('_', ' ')}, balance ${money(s.balance_cents)}`
            : `PayPal DENIED capture ${res.id} (${money(pay.amount_cents)}) for ${rp.unit_label}. Balance ${money(s.balance_cents)}`,
          payload: { ...meta, payment_id: pay.id, status_before: s.before, status_after: s.status }, paypal_event_id: event.id });
        return { result: completed ? 'payment_confirmed' : 'payment_denied', payment_id: pay.id, ...s, ...base };
      }

      // Recorded in the ledger; no state change yet (INVOICING.* lands once the scope is granted).
      logEvent(d, { kind: 'webhook_received', actor: 'paypal', summary: `PayPal event ${event.event_type} received (${event.summary || 'no summary'})`,
        payload: meta, paypal_event_id: event.id });
      return { result: 'logged', ...base };
    });
  } catch (e) {
    if (/UNIQUE constraint failed: event_log\.paypal_event_id|duplicate paypal_event_id/.test(e.message)) return { result: 'duplicate', event_id: event.id };
    throw e;
  }
}

// Back-fill deliveries that reached the raw log while an older build was serving (idempotent).
async function ingestWebhookLog(d) {
  if (!existsSync(WEBHOOK_LOG)) return [];
  const out = [];
  for (const line of readFileSync(WEBHOOK_LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const ev = typeof e.body === 'object' ? e.body : null;
    if (!ev?.id) continue;
    out.push(await handleWebhook(d, ev, { headers: e.headers, rawBody: e.raw, via: 'backfill' }));
  }
  return out;
}

// ───────────────────────────── dashboard ─────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const fmtDate = (iso) => new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtTime = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false }) + ' UTC';

function currentPeriods(d) {
  return d.prepare(`SELECT rp.id FROM rent_period rp WHERE rp.period = (SELECT MAX(period) FROM rent_period r2 WHERE r2.unit_id = rp.unit_id) ORDER BY rp.unit_id`)
    .all().map((r) => getPeriod(d, r.id));
}

function nextAction(rp, pays) {
  const pending = pays.filter((p) => p.status === 'PENDING');
  if (pending.length) return { tone: 'info', text: `Payment of ${money(pending.reduce((a, p) => a + p.amount_cents, 0))} processing at PayPal` };
  if (rp.status === 'PAID') {
    const unconfirmed = pays.filter((p) => p.status === 'COMPLETED' && !p.webhook_event_id).length;
    return unconfirmed ? { tone: 'ok', text: 'Paid in full. Waiting for PayPal webhook confirmation' } : { tone: 'ok', text: 'Nothing to do. Paid in full, confirmed by PayPal' };
  }
  const late = daysBetween(rp.due_date, today());
  const fee = JSON.parse(rp.late_fee_rule_json || '{}');
  const bal = money(rp.amount_due_cents - rp.amount_paid_cents);
  if (late < 0) return { tone: 'muted', text: `Due ${fmtDate(rp.due_date)}. No action yet` };
  if (rp.status === 'PARTIALLY_PAID') return { tone: 'warn', text: `${bal} still owed. Agree a payment plan for the rest` };
  if (late <= (fee.grace_days ?? 5)) return { tone: 'warn', text: `Due ${late === 0 ? 'today' : `${late} day${late > 1 ? 's' : ''} ago`}. Send a friendly reminder` };
  return { tone: 'bad', text: `${late} days late. ${fee.value_cents ? money(fee.value_cents) + ' late fee applies. ' : ''}Send a formal notice` };
}

const CSS = `
:root{--ink:#14213d;--muted:#6b7280;--line:#e5e7eb;--bg:#f6f7fb;--card:#fff;--brand:#0b5fff;--ok:#0f9d58;--warn:#b26a00;--bad:#c62828;--info:#1565c0}
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:var(--bg)}
header{background:var(--card);border-bottom:1px solid var(--line)}
.wrap{max-width:1120px;margin:0 auto;padding:0 24px}
.top{display:flex;align-items:center;gap:14px;height:64px}
.logo{font-weight:800;font-size:20px;letter-spacing:-.3px}.logo span{color:var(--brand)}
.tag{font-size:12px;color:var(--muted)}.sp{flex:1}
.badge{font-size:11px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;padding:3px 8px;border-radius:999px;background:#fff4e5;color:var(--warn);border:1px solid #ffd59e}
h1{font-size:24px;margin:28px 0 4px}.sub{color:var(--muted);margin:0 0 20px}
.kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:22px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.kpi b{display:block;font-size:26px;letter-spacing:-.5px}.kpi small{color:var(--muted)}
.bar{height:6px;background:#eef0f4;border-radius:9px;overflow:hidden;margin-top:8px}.bar i{display:block;height:100%;background:var(--ok)}
table{width:100%;border-collapse:separate;border-spacing:0;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th{font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);text-align:left;padding:12px 16px;background:#fafbfc;border-bottom:1px solid var(--line)}
td{padding:16px;border-bottom:1px solid var(--line);vertical-align:top}tr:last-child td{border-bottom:0}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.small{font-size:12.5px;color:var(--muted)}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;white-space:nowrap}
.pill.UNPAID{background:#fdecea;color:var(--bad)}.pill.PARTIALLY_PAID{background:#fff4e5;color:var(--warn)}.pill.PAID{background:#e6f4ea;color:var(--ok)}
.act{font-weight:600}.act.ok{color:var(--ok)}.act.warn{color:var(--warn)}.act.bad{color:var(--bad)}.act.info{color:var(--info)}.act.muted{color:var(--muted)}
form.pay{display:flex;gap:6px;margin-top:10px}form.pay input{width:96px;padding:6px 8px;border:1px solid var(--line);border-radius:8px;font:inherit}
button{background:var(--brand);color:#fff;border:0;border-radius:8px;padding:7px 12px;font:inherit;font-weight:600;cursor:pointer}button:hover{filter:brightness(.95)}
.pays{margin:8px 0 0;padding:0;list-style:none}.pays li{font-size:12.5px;color:var(--muted)}
.ok-ic{color:var(--ok);font-weight:700}
.flash{padding:12px 16px;border-radius:10px;margin:0 0 18px;font-weight:600}.flash.ok{background:#e6f4ea;color:var(--ok)}.flash.err{background:#fdecea;color:var(--bad)}
h2{font-size:17px;margin:30px 0 10px}
.feed{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0;padding:6px 0;list-style:none}
.feed li{display:flex;gap:14px;padding:10px 16px;border-bottom:1px solid var(--line)}.feed li:last-child{border-bottom:0}
.feed time{width:130px;flex:none;color:var(--muted);font-size:12.5px;padding-top:1px}
.who{flex:none;width:64px;font-size:11px;font-weight:700;text-transform:uppercase;color:var(--muted);padding-top:2px}.who.paypal{color:var(--brand)}
footer{color:var(--muted);font-size:12.5px;padding:28px 0 40px}
@media(max-width:820px){.kpis{grid-template-columns:1fr}table,thead,tbody,tr,td{display:block}thead{display:none}td{border:0;padding:8px 16px}tr{border-bottom:1px solid var(--line);padding:8px 0}.num{text-align:left}}
`;

function renderDashboard(d, flash) {
  const rows = currentPeriods(d);
  const period = rows[0]?.period || SEED_PERIOD;
  const due = rows.reduce((a, r) => a + r.amount_due_cents, 0), paid = rows.reduce((a, r) => a + r.amount_paid_cents, 0);
  const paidUnits = rows.filter((r) => r.status === 'PAID').length;
  const events = d.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT 15').all();
  const trs = rows.map((rp) => {
    const pays = d.prepare('SELECT * FROM payment WHERE rent_period_id=? ORDER BY id').all(rp.id);
    const na = nextAction(rp, pays);
    const bal = rp.amount_due_cents - rp.amount_paid_cents;
    const pct = Math.min(100, Math.round((rp.amount_paid_cents / rp.amount_due_cents) * 100));
    const payList = pays.filter((p) => p.status !== 'FAILED').map((p) =>
      `<li>${fmtDate(p.paid_at || p.created_at)} · ${money(p.amount_cents)} card · ${p.status === 'COMPLETED' ? (p.webhook_event_id ? '<span class="ok-ic">✓</span> PayPal confirmed' : 'captured, awaiting webhook') : esc(p.status.toLowerCase())}</li>`).join('');
    return `<tr>
      <td><b>${esc(rp.unit_label)}</b><div class="small">${esc(rp.unit_address)}</div></td>
      <td>${esc(rp.tenant_name)}<div class="small">${esc(rp.tenant_email)}</div></td>
      <td class="num">${money(rp.amount_due_cents)}<div class="small">due ${fmtDate(rp.due_date)}</div></td>
      <td class="num">${money(rp.amount_paid_cents)}<div class="bar"><i style="width:${pct}%"></i></div>${bal > 0 && rp.amount_paid_cents > 0 ? `<div class="small">${money(bal)} left</div>` : ''}</td>
      <td><span class="pill ${rp.status}">${rp.status.replace('_', ' ')}</span></td>
      <td><div class="act ${na.tone}">${esc(na.text)}</div>${payList ? `<ul class="pays">${payList}</ul>` : ''}
        ${bal > 0 ? `<form class="pay" method="post" action="/rent-periods/${rp.id}/pay-sandbox" title="Simulates the tenant paying by card (PayPal sandbox test card, no login)">
          <input name="amount" inputmode="decimal" value="${(bal / 100).toFixed(2)}" aria-label="Amount in dollars"><button>Tenant pays</button></form>` : ''}</td>
    </tr>`;
  }).join('');
  const feed = events.map((e) => `<li><time>${fmtTime(e.at)}</time><span class="who ${e.actor}">${esc(e.actor)}</span><span>${esc(e.summary)}</span></li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>RentRoll · ${esc(monthName(period))} rent</title><style>${CSS}</style></head><body>
<header><div class="wrap top"><div class="logo">Rent<span>Roll</span></div><div class="tag">Rent collection for small landlords</div><div class="sp"></div><span class="badge">PayPal sandbox</span></div></header>
<main class="wrap">
  <h1>${esc(monthName(period))} rent</h1><p class="sub">418 Larkspur Ave · ${rows.length} units · today ${fmtDate(today())}</p>
  ${flash ? `<div class="flash ${flash.ok ? 'ok' : 'err'}">${esc(flash.msg)}</div>` : ''}
  <section class="kpis">
    <div class="kpi"><small>Collected</small><b>${money(paid)}</b><small>of ${money(due)} due</small><div class="bar"><i style="width:${due ? Math.round((paid / due) * 100) : 0}%"></i></div></div>
    <div class="kpi"><small>Outstanding</small><b>${money(due - paid)}</b><small>${rows.length - paidUnits} unit${rows.length - paidUnits === 1 ? '' : 's'} still owe rent</small></div>
    <div class="kpi"><small>Paid in full</small><b>${paidUnits} / ${rows.length}</b><small>units this month</small></div>
  </section>
  <table><thead><tr><th>Unit</th><th>Tenant</th><th class="num">Due</th><th class="num">Paid</th><th>Status</th><th>Next action</th></tr></thead><tbody>${trs}</tbody></table>
  <h2>Ledger</h2><ul class="feed">${feed || '<li>No activity yet.</li>'}</ul>
  <footer>Every payment and PayPal webhook is written to an append-only ledger. "Tenant pays" charges PayPal's sandbox test card. No real money moves.</footer>
</main></body></html>`;
}

// ───────────────────────────── HTTP ─────────────────────────────
function buildApp(d) {
  const app = express();

  // PayPal webhook: keep the raw bytes (signature check), log the delivery, then process idempotently.
  app.post('/webhooks/paypal', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    const raw = req.body && req.body.length ? req.body.toString('utf8') : '';
    let body;
    try { body = JSON.parse(raw); } catch { body = raw; }
    const entry = { received_at: new Date().toISOString(), method: req.method, url: req.originalUrl, headers: req.headers, body, raw };
    try { appendFileSync(WEBHOOK_LOG, JSON.stringify(entry) + '\n'); } catch (e) { console.error('webhook log write failed:', e.message); }
    if (typeof body !== 'object' || !body) return res.status(400).json({ ok: false, error: 'invalid JSON' });
    try {
      const r = await handleWebhook(d, body, { headers: req.headers, rawBody: raw });
      console.log(`[webhook] ${body.event_type} ${body.id} → ${r.result} (sig ${r.verification ?? '-'})`);
      res.status(r.result === 'rejected_signature' ? 400 : 200).json({ ok: r.result !== 'rejected_signature', ...r });
    } catch (e) {
      console.error('[webhook] processing failed:', e.message);
      res.status(500).json({ ok: false }); // PayPal will retry; dedup makes the retry safe
    }
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true, service: 'rentroll', db: path.basename(DB_PATH) }));

  app.get('/', (req, res) => {
    const flash = req.query.ok ? { ok: true, msg: String(req.query.ok) } : req.query.err ? { ok: false, msg: String(req.query.err) } : null;
    res.type('html').send(renderDashboard(d, flash));
  });

  // TODO(before real tenants): /api/rent-periods, /api/event-log and the dashboard are public through the
  // Tailscale Funnel and expose tenant name/email/phone. Fine for fake hackathon seed data only; add auth
  // before any real tenant data goes in.
  app.get('/api/rent-periods', (_req, res) => res.json(currentPeriods(d).map((rp) => ({
    ...rp, balance_cents: rp.amount_due_cents - rp.amount_paid_cents,
    payments: d.prepare('SELECT * FROM payment WHERE rent_period_id=? ORDER BY id').all(rp.id),
  }))));
  app.get('/api/event-log', (_req, res) => res.json(d.prepare('SELECT * FROM event_log ORDER BY id').all()));

  const pay = async (req) => {
    const b = req.body || {};
    const cents = b.amount_cents != null ? Number(b.amount_cents) : parseMoney(b.amount);
    if (cents == null) throw new HttpError(400, 'amount must be a dollar amount like "800.00"');
    return payRentPeriodSandbox(d, Number(req.params.id), cents);
  };
  // JSON API (demo scripts): {"amount":"800.00"} or {"amount_cents":80000}
  app.post('/api/rent-periods/:id/pay-sandbox', express.json(), async (req, res) => {
    try { res.json({ ok: true, ...(await pay(req)) }); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  });
  // Dashboard form (no JS): post, then redirect back with a flash message.
  app.post('/rent-periods/:id/pay-sandbox', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const r = await pay(req);
      res.redirect(303, `/?ok=${encodeURIComponent(`Payment of ${money(r.payment.amount_cents)} captured through PayPal (capture ${r.payment.paypal_capture_id}). PayPal's webhook will confirm it shortly.`)}`);
    } catch (e) { res.redirect(303, `/?err=${encodeURIComponent(e.message)}`); }
  });
  // Body-parser and other uncaught errors: plain JSON, never Express's HTML page with a stack trace.
  app.use((err, _req, res, _next) => {
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error('[http] unhandled error:', err.message);
    res.status(status).json({ ok: false, error: err.type === 'entity.parse.failed' ? 'invalid JSON body' : status < 500 ? err.message : 'internal error' });
  });
  return app;
}

// ───────────────────────────── entry point ─────────────────────────────
const args = process.argv.slice(2);
if (args.includes('--seed')) {
  if (args.includes('--reset')) {
    // Stop rentroll.service first: a running server keeps serving the unlinked DB file until it restarts.
    for (const s of ['', '-wal', '-shm']) rmSync(DB_PATH + s, { force: true });
    // The startup back-fill replays WEBHOOK_LOG, which would re-create the old payments in the fresh DB
    // (TESTER1 F2). Rotate the log aside (kept for audit, not deleted) so reset stays reset.
    if (existsSync(WEBHOOK_LOG)) {
      const rotated = `${WEBHOOK_LOG}.pre-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      renameSync(WEBHOOK_LOG, rotated);
      console.log(`rotated webhook log to ${rotated}`);
    }
  }
  const d = openDb();
  const n = seed(d);
  console.log(n ? `seeded ${n} units into ${DB_PATH}` : `already seeded (${DB_PATH}); add --reset to start over`);
  for (const r of currentPeriods(d)) console.log(`  rent_period ${r.id}: ${r.unit_label} / ${r.tenant_name} / ${r.period} / ${money(r.amount_due_cents)} / ${r.status}`);
} else if (args.includes('--ingest-webhook-log')) {
  const d = openDb();
  seed(d);
  for (const r of await ingestWebhookLog(d)) console.log(JSON.stringify(r));
} else {
  const d = openDb();
  if (seed(d)) console.log('empty database: seeded demo data');
  buildApp(d).listen(PORT, HOST, () => {
    console.log(`rentroll listening on http://${HOST}:${PORT} (db ${DB_PATH})`);
    ingestWebhookLog(d).then((rs) => {
      const n = rs.filter((r) => r.result !== 'duplicate').length;
      if (n) console.log(`[webhook] back-filled ${n} logged deliveries`);
    }).catch((e) => console.error('[webhook] back-fill failed:', e.message));
  });
}
