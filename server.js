// RentRoll server (Sprint 1: data model, dashboard, sandbox capture, webhook ledger;
// Sprint 2: tenant message -> AI payment plan grounded in the live ledger, see lib/plan-ai.js;
// Sprint 3: landlord approval turns the plan into a server-enforced payment constraint, see approvePlan();
// Sprint 4: reminder escalation from real ledger state, POST /api/reminders/run, see runReminders() + lib/reminders.js;
// Sprint 6: court packet, GET /api/rent-periods/:id/court-packet.pdf (and .json), see lib/court-packet.js);
// Sprint 10: PayPal Invoicing is the core: one real invoice per rent period, plan approval rewrites the invoice's
// configuration.partial_payment + due date, payments are recorded on the invoice, INVOICING.* webhooks reconcile.
//
// One file on purpose for tonight: schema + seed + domain logic + dashboard + PayPal endpoints.
//   node server.js                 start (auto-creates data/rentroll.db, seeds demo data if empty,
//                                  back-fills webhook deliveries from .sprint0-webhook-log.jsonl)
//   node server.js --seed [--reset] seed demo data and exit (--reset wipes the demo DB and rotates the
//                                  webhook log aside; stop rentroll.service first, start it again after)
//   node server.js --ingest-webhook-log  replay logged deliveries through the handler and exit (idempotent)
//   node server.js --ensure-invoices     create + send a PayPal invoice for every rent period that has none, exit
//   node server.js --open-month 2026-12  open next month's rent periods (one per unit) + their PayPal invoices, exit
//
// INVOICING (Sprint 10, see lib/invoicing.js and SPRINT10.md). RENTROLL_INVOICING=0 turns every Invoicing call
// off (offline tests). The tenant's card charge still runs through Orders (no logged-in buyer needed); the
// capture is then recorded on the invoice with record-payment, so the invoice itself carries the payment.
import express from 'express';
import { appendFileSync, readFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pp } from './lib/paypal.js';
import { ledgerSnapshot, proposePlan } from './lib/plan-ai.js';
import { reminderState, draftReminder, RATE_LIMIT_HOURS } from './lib/reminders.js';
import { courtPacketData, renderCourtPacketPdf } from './lib/court-packet.js';
import { basicAuth } from './lib/auth.js';
import { invoiceFacts, getInvoice, createAndSendRentInvoice, applyTermsToInvoice, recordPaymentOnInvoice } from './lib/invoicing.js';

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
const INVOICING_ON = process.env.RENTROLL_INVOICING !== '0';

// ───────────────────────────── data model ─────────────────────────────
// All money is integer cents; timestamps ISO-8601 UTC.
// Sprint 2 fills `plan` from the AI flow (statuses parse_failed / needs_review added; migrated in openDb).
const PLAN_TABLE = `CREATE TABLE IF NOT EXISTS plan (
  id                    INTEGER PRIMARY KEY,
  rent_period_id        INTEGER NOT NULL REFERENCES rent_period(id),
  status                TEXT NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','needs_review','parse_failed','approved','rejected','broken','completed')),
  source_message_id     INTEGER REFERENCES message(id),
  installments_json     TEXT NOT NULL DEFAULT '[]',  -- [{due_date, amount_cents, note, payment_id?}]
  ai_rationale          TEXT,                        -- the model's "reasoning" field, shown to the landlord
  validation_json       TEXT,                        -- server-side validation errors (empty array = passed)
  ledger_snapshot_json  TEXT,                        -- the exact ledger numbers our code fed the model
  llm_meta_json         TEXT,                        -- model, attempts, finish_reason, usage, timing
  raw_response          TEXT,                        -- raw model output (always kept, esp. for parse_failed)
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_at           TEXT
);`;
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
${PLAN_TABLE}
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
  migrate(d);
  return d;
}
// Sprint 1 DBs have the old plan CHECK constraint and no message.rent_period_id; upgrade in place.
function migrate(d) {
  const planSql = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='plan'").get()?.sql || '';
  if (!planSql.includes('parse_failed')) {
    tx(d, () => {
      d.exec('ALTER TABLE plan RENAME TO plan_sprint1');
      d.exec(PLAN_TABLE);
      d.exec(`INSERT INTO plan (id, rent_period_id, status, source_message_id, installments_json, ai_rationale, created_at, approved_at)
        SELECT id, rent_period_id, status, source_message_id, installments_json, ai_rationale, created_at, approved_at FROM plan_sprint1`);
      d.exec('DROP TABLE plan_sprint1');
    });
  }
  const msgCols = d.prepare('PRAGMA table_info(message)').all().map((c) => c.name);
  if (!msgCols.includes('rent_period_id')) d.exec('ALTER TABLE message ADD COLUMN rent_period_id INTEGER REFERENCES rent_period(id)');
  d.exec('CREATE INDEX IF NOT EXISTS plan_period ON plan(rent_period_id)');
  // Sprint 3: a payment made under an approved plan records which plan + installment (1-based) it satisfies.
  const payCols = d.prepare('PRAGMA table_info(payment)').all().map((c) => c.name);
  if (!payCols.includes('plan_id')) d.exec('ALTER TABLE payment ADD COLUMN plan_id INTEGER REFERENCES plan(id)');
  if (!payCols.includes('plan_installment')) d.exec('ALTER TABLE payment ADD COLUMN plan_installment INTEGER');
  // At most one approved (= enforced) plan per rent period, guaranteed by the DB, not just the handler.
  d.exec("CREATE UNIQUE INDEX IF NOT EXISTS plan_one_approved ON plan(rent_period_id) WHERE status = 'approved'");
  // Sprint 10: mirror of the real PayPal invoice (PayPal stays the source; these are read back after every call).
  const rpCols = d.prepare('PRAGMA table_info(rent_period)').all().map((c) => c.name);
  for (const [c, t] of [['paypal_invoice_number', 'TEXT'], ['paypal_invoice_paid_cents', 'INTEGER'], ['paypal_invoice_due_cents', 'INTEGER'],
    ['paypal_invoice_min_due_cents', 'INTEGER'], ['paypal_invoice_due_date', 'TEXT'], ['paypal_invoice_synced_at', 'TEXT']])
    if (!rpCols.includes(c)) d.exec(`ALTER TABLE rent_period ADD COLUMN ${c} ${t}`);
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS rent_period_invoice ON rent_period(paypal_invoice_id) WHERE paypal_invoice_id IS NOT NULL');
  // invoice_payment_id: the id PayPal gave this payment on the invoice (EXTR-... for record-payment).
  for (const [c, t] of [['invoice_payment_id', 'TEXT'], ['invoice_recorded_at', 'TEXT'], ['invoice_webhook_event_id', 'TEXT']])
    if (!d.prepare('PRAGMA table_info(payment)').all().some((x) => x.name === c)) d.exec(`ALTER TABLE payment ADD COLUMN ${c} ${t}`);
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
  // Sprint 4: rent due on the 8th, so on a given day this unit sits in a different reminder tier than Units 2/3.
  { label: 'Unit 4', address: '418 Larkspur Ave, Apt 4, Columbus, OH 43206', rent: 95000, due_day: 8,
    tenant: { name: 'Sam Okafor', email: 'sam.okafor@tenant.example.com', phone: '+1-614-555-0119' } },
];
const LATE_FEE = { grace_days: 5, type: 'flat', value_cents: 7500, state: 'OH' };

function seed(d) {
  if (d.prepare('SELECT COUNT(*) n FROM unit').get().n > 0) return 0;
  return tx(d, () => {
    for (const u of SEED_UNITS) {
      const tenantId = Number(d.prepare('INSERT INTO tenant (name, email, phone) VALUES (?,?,?)')
        .run(u.tenant.name, u.tenant.email, u.tenant.phone).lastInsertRowid);
      const unitId = Number(d.prepare('INSERT INTO unit (label, address, monthly_rent_cents, due_day, late_fee_rule_json, tenant_id) VALUES (?,?,?,?,?,?)')
        .run(u.label, u.address, u.rent, u.due_day ?? 1, JSON.stringify(LATE_FEE), tenantId).lastInsertRowid);
      const dueDate = `${SEED_PERIOD}-${String(u.due_day ?? 1).padStart(2, '0')}`;
      d.prepare('UPDATE tenant SET unit_id=? WHERE id=?').run(unitId, tenantId);
      const rpId = Number(d.prepare('INSERT INTO rent_period (unit_id, tenant_id, period, due_date, amount_due_cents) VALUES (?,?,?,?,?)')
        .run(unitId, tenantId, SEED_PERIOD, dueDate, u.rent).lastInsertRowid);
      logEvent(d, { kind: 'seed', actor: 'system', rent_period_id: rpId,
        summary: `${monthName(SEED_PERIOD)} rent opened for ${u.label} (${u.tenant.name}): ${money(u.rent)} due ${dueDate}`,
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
    // Sprint 3 write-back: an approved plan replaces "any amount up to the balance" with "exactly the next installment".
    const planRow = activePlanRow(d, rp.id);
    let idx, planId = null;
    if (planRow) {
      const sch = planSchedule(d, planRow);
      if (sch.blocked_by_processing) throw new HttpError(409, `approved plan #${planRow.id}: installment ${sch.blocked_by_processing.n} of ${sch.blocked_by_processing.of} is still processing at PayPal`);
      const nx = sch.next_installment;
      if (!nx) throw new HttpError(409, `approved plan #${planRow.id} has no unpaid installment`);
      if (amountCents !== nx.amount_cents) throw new HttpError(422, `approved plan #${planRow.id} only accepts installment ${nx.n} of ${nx.of}: exactly ${money(nx.amount_cents)} (due ${nx.due_date}). ${money(amountCents)} refused`);
      idx = nx.n; planId = planRow.id;
    } else {
      if (amountCents > open) throw new HttpError(422, `amount ${money(amountCents)} exceeds open balance ${money(open)}`);
      idx = d.prepare("SELECT COUNT(*) n FROM payment WHERE rent_period_id=? AND status IN ('COMPLETED','PENDING')").get(rpId).n + 1;
    }
    const nonce = randomUUID().slice(0, 8);
    const customId = `RR:rp${rp.id}:${rp.period}:u${rp.unit_id}:i${idx}:${nonce}`;
    const requestId = `rr-${rp.id}-${idx}-${randomUUID()}`;
    const payId = Number(d.prepare(`INSERT INTO payment (rent_period_id, installment_index, source, status, amount_cents, custom_id, paypal_request_id, plan_id, plan_installment)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(rp.id, idx, 'paypal_capture', 'PENDING', amountCents, customId, requestId, planId, planId ? idx : null).lastInsertRowid);
    return { rp, idx, customId, requestId, payId, planId, planOf: planRow ? JSON.parse(planRow.installments_json).length : null };
  });
  const { rp, idx, customId, requestId, payId, planId, planOf } = attempt;

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
  const out = tx(d, () => {
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
    const planStatus = settlePlan(d, planId);
    logEvent(d, { kind: 'payment', actor: 'tenant', rent_period_id: rp.id,
      summary: `${rp.tenant_name} paid ${money(amountCents)} by card through PayPal${planId ? ` (plan #${planId}, installment ${idx} of ${planOf})` : ''} (capture ${cap.id}, ${cap.status}). Balance now ${money(s.balance_cents)}`,
      payload: { payment_id: payId, order_id: order.id, capture_id: cap.id, capture_status: cap.status, fee_cents: fee, net_cents: net, custom_id: customId,
        plan_id: planId, plan_installment: planId ? idx : null } });
    return { payment: d.prepare('SELECT * FROM payment WHERE id=?').get(payId), rent_period: s,
      plan: planId ? planOut(d, d.prepare('SELECT * FROM plan WHERE id=?').get(planId)) : null, plan_status: planStatus };
  });
  // Sprint 10: write the captured money onto the real PayPal invoice (record-payment), then move the invoice's
  // minimum amount due on to the next installment. A failure here is logged and returned, never hidden.
  if (out.payment.status === 'COMPLETED') {
    out.invoice = await recordCaptureOnInvoice(d, payId);
    out.payment = d.prepare('SELECT * FROM payment WHERE id=?').get(payId);
  }
  return out;
}

// ───────────────────────────── tenant message → AI plan (Sprint 2) ─────────────────────────────
function planView(row) {
  if (!row) return null;
  const j = (s, dflt) => { try { return s ? JSON.parse(s) : dflt; } catch { return dflt; } };
  return { id: row.id, rent_period_id: row.rent_period_id, status: row.status, source_message_id: row.source_message_id,
    installments: j(row.installments_json, []), reasoning: row.ai_rationale, validation_errors: j(row.validation_json, []),
    ledger_snapshot: j(row.ledger_snapshot_json, null), llm: j(row.llm_meta_json, null), raw_response: row.raw_response,
    created_at: row.created_at };
}

// ───────────────────────────── approve → write (Sprint 3) ─────────────────────────────
// Approving a plan is a server-enforced constraint, not a label: while a rent period has an `approved` plan,
// payRentPeriodSandbox() refuses every amount except the next unpaid installment's exact amount.
const activePlanRow = (d, rpId) => d.prepare("SELECT * FROM plan WHERE rent_period_id=? AND status='approved'").get(rpId);

// Per-installment state, derived from payments linked to the plan (payment.plan_id + plan_installment).
function planSchedule(d, planRow) {
  const inst = JSON.parse(planRow.installments_json || '[]');
  const pays = d.prepare("SELECT * FROM payment WHERE plan_id=? AND status IN ('COMPLETED','PENDING') ORDER BY id").all(planRow.id);
  let next = null;
  const rows = inst.map((x, i) => {
    const n = i + 1;
    const done = pays.find((p) => p.plan_installment === n && p.status === 'COMPLETED');
    const pend = pays.find((p) => p.plan_installment === n && p.status === 'PENDING');
    let state = done ? 'PAID' : pend ? 'PROCESSING' : null;
    if (!state) {
      if (!next) { next = n; state = x.due_date < today() ? 'OVERDUE' : 'DUE'; } else state = 'UPCOMING';
    }
    return { n, of: inst.length, due_date: x.due_date, amount_cents: x.amount_cents, note: x.note ?? null, state,
      payment_id: (done || pend)?.id ?? null, paypal_capture_id: (done || pend)?.paypal_capture_id ?? null,
      webhook_confirmed: !!done?.webhook_event_id,
      label: `installment ${n} of ${inst.length}: ${done ? 'PAID' : pend ? 'PROCESSING' : `${state === 'UPCOMING' ? 'upcoming' : state === 'OVERDUE' ? 'OVERDUE since' : 'due'} ${x.due_date}`} (${money(x.amount_cents)})` };
  });
  const firstOpen = rows.find((r) => r.state !== 'PAID');
  return { installments: rows, next_installment: next ? rows[next - 1] : null, blocked_by_processing: firstOpen?.state === 'PROCESSING' ? firstOpen : null,
    paid_cents: rows.filter((r) => r.state === 'PAID').reduce((a, r) => a + r.amount_cents, 0),
    all_paid: rows.length > 0 && rows.every((r) => r.state === 'PAID') };
}

// After any payment state change: an approved plan whose installments are all PAID becomes `completed`.
function settlePlan(d, planId) {
  if (!planId) return null;
  const row = d.prepare('SELECT * FROM plan WHERE id=?').get(planId);
  if (!row || row.status !== 'approved') return row?.status ?? null;
  if (!planSchedule(d, row).all_paid) return 'approved';
  d.prepare("UPDATE plan SET status='completed' WHERE id=?").run(planId);
  logEvent(d, { kind: 'plan_completed', actor: 'system', rent_period_id: row.rent_period_id,
    summary: `Payment plan #${planId} completed: every installment paid through PayPal`, payload: { plan_id: planId } });
  return 'completed';
}

function approvePlan(d, planId) {
  return tx(d, () => {
    const row = d.prepare('SELECT * FROM plan WHERE id=?').get(planId);
    if (!row) throw new HttpError(404, `plan ${planId} not found`);
    if (row.status !== 'proposed') throw new HttpError(409, `plan ${planId} is ${row.status}; only a proposed plan can be approved`);
    const other = activePlanRow(d, row.rent_period_id);
    if (other) throw new HttpError(409, `plan ${other.id} is already approved for this rent period; reject it first`);
    // Re-check against the ledger NOW, not at proposal time: money may have moved since the AI proposed.
    const snap = ledgerSnapshot(d, row.rent_period_id, today());
    const open = snap.outstanding_cents - snap.pending_cents;
    const inst = JSON.parse(row.installments_json || '[]');
    const sum = inst.reduce((a, x) => a + x.amount_cents, 0);
    if (sum !== open) throw new HttpError(409, `plan ${planId} totals ${money(sum)} but the ledger's open balance is now ${money(open)}; it is stale, ask the tenant again`);
    const now = new Date().toISOString();
    d.prepare("UPDATE plan SET status='approved', approved_at=? WHERE id=?").run(now, planId);
    const superseded = d.prepare("SELECT id FROM plan WHERE rent_period_id=? AND id<>? AND status IN ('proposed','needs_review','parse_failed')").all(row.rent_period_id, planId).map((r) => r.id);
    for (const id of superseded) d.prepare("UPDATE plan SET status='rejected' WHERE id=?").run(id);
    const rp = getPeriod(d, row.rent_period_id);
    logEvent(d, { kind: 'plan_approved', actor: 'landlord', rent_period_id: rp.id,
      summary: `Landlord approved plan #${planId} for ${rp.tenant_name}: ${inst.map((x, i) => `#${i + 1} ${money(x.amount_cents)} by ${x.due_date}`).join(', ')}. PayPal payments now only accepted for the next installment's exact amount`,
      payload: { plan_id: planId, installments: inst, open_balance_cents: open, superseded_plan_ids: superseded } });
    return { plan: planOut(d, d.prepare('SELECT * FROM plan WHERE id=?').get(planId)), superseded_plan_ids: superseded };
  });
}

function rejectPlan(d, planId) {
  return tx(d, () => {
    const row = d.prepare('SELECT * FROM plan WHERE id=?').get(planId);
    if (!row) throw new HttpError(404, `plan ${planId} not found`);
    if (!['proposed', 'needs_review', 'parse_failed', 'approved'].includes(row.status)) throw new HttpError(409, `plan ${planId} is ${row.status}; nothing to reject`);
    if (row.status === 'approved' && planSchedule(d, row).installments.some((x) => x.state === 'PROCESSING'))
      throw new HttpError(409, `plan ${planId} has a payment processing at PayPal; wait for it before cancelling`);
    d.prepare("UPDATE plan SET status='rejected' WHERE id=?").run(planId);
    const rp = getPeriod(d, row.rent_period_id);
    logEvent(d, { kind: 'plan_rejected', actor: 'landlord', rent_period_id: rp.id,
      summary: row.status === 'approved'
        ? `Landlord cancelled approved plan #${planId}. ${rp.tenant_name} can again pay any amount up to the balance`
        : `Landlord rejected plan #${planId}. The tenant can be asked for a new proposal`,
      payload: { plan_id: planId, status_before: row.status } });
    return { plan: planOut(d, d.prepare('SELECT * FROM plan WHERE id=?').get(planId)) };
  });
}

// planView + approval data + live installment schedule (for plans that were ever approved).
function planOut(d, row) {
  const v = planView(row);
  if (!v) return v;
  v.approved_at = row.approved_at;
  v.enforced = row.status === 'approved';
  if (row.approved_at) {
    const s = planSchedule(d, row);
    v.schedule = s.installments;
    v.next_installment = row.status === 'approved' ? s.next_installment : null;
  }
  return v;
}

async function handleTenantMessage(d, rpId, body, channel = 'sms') {
  if (typeof body !== 'string' || !body.trim()) throw new HttpError(400, 'body must be the tenant\'s message text');
  if (body.length > 2000) throw new HttpError(413, 'message too long (max 2000 characters)');
  if (!['sms', 'email', 'app'].includes(channel)) channel = 'sms';
  const rp = getPeriod(d, rpId);
  if (!rp) throw new HttpError(404, `rent period ${rpId} not found`);

  const messageId = tx(d, () => {
    const id = Number(d.prepare('INSERT INTO message (tenant_id, rent_period_id, direction, channel, body) VALUES (?,?,?,?,?)')
      .run(rp.tenant_id, rp.id, 'in', channel, body.trim()).lastInsertRowid);
    logEvent(d, { kind: 'message_in', actor: 'tenant', rent_period_id: rp.id, summary: `${rp.tenant_name} (${channel}): "${body.trim().slice(0, 160)}"`,
      payload: { message_id: id } });
    return id;
  });

  // THE grounding step: real balance computed by our code from the ledger, not by the model.
  const snap = ledgerSnapshot(d, rp.id, today());
  if (snap.outstanding_cents <= 0) {
    return { http: 409, message_id: messageId, plan: null, ledger_snapshot: snap,
      error: `${rp.unit_label} ${rp.period} is already paid in full (${money(snap.amount_paid_cents)} of ${money(snap.amount_due_cents)}); no plan needed` };
  }

  let r;
  try { r = await proposePlan(snap, body.trim()); }
  catch (e) {
    r = { status: 'parse_failed', installments: [], reasoning: null, errors: [`LLM call failed: ${e.message}`], raw: null, meta: { error: e.message } };
  }
  const planId = tx(d, () => {
    const id = Number(d.prepare(`INSERT INTO plan (rent_period_id, status, source_message_id, installments_json, ai_rationale, validation_json,
        ledger_snapshot_json, llm_meta_json, raw_response) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(rp.id, r.status, messageId, JSON.stringify(r.installments), r.reasoning, JSON.stringify(r.errors || []),
        JSON.stringify(snap), JSON.stringify(r.meta || null), r.raw).lastInsertRowid);
    d.prepare('UPDATE message SET ai_extraction_json=? WHERE id=?')
      .run(JSON.stringify({ plan_id: id, tenant_stated: r.tenant_stated ?? null, adjusted: r.adjusted ?? null }), messageId);
    const sched = r.installments.map((x) => `${money(x.amount_cents)} on ${x.due_date}`).join(', ');
    logEvent(d, { kind: 'plan_proposed', actor: 'ai', rent_period_id: rp.id,
      summary: r.status === 'proposed'
        ? `AI proposed a plan for the ${money(snap.outstanding_cents)} balance: ${sched}. Awaiting landlord approval`
        : r.status === 'needs_review'
          ? `AI plan needs review (${r.errors[0]}). Proposed: ${sched || 'nothing'}`
          : `AI could not produce a usable plan (${(r.errors || [])[0] || 'parse failed'}). Raw reply kept for review`,
      payload: { plan_id: id, message_id: messageId, status: r.status, outstanding_cents: snap.outstanding_cents } });
    return id;
  });
  return { http: 200, message_id: messageId, plan: planView(d.prepare('SELECT * FROM plan WHERE id=?').get(planId)),
    tenant_stated: r.tenant_stated ?? null, adjusted: r.adjusted ?? null };
}

// ───────────────────────────── PayPal Invoicing (Sprint 10) ─────────────────────────────
// The rent period's PayPal invoice is the real, tenant-facing bill. RentRoll writes to it (create/send, plan terms,
// record-payment) and reads it back after every write; the rent_period.paypal_invoice_* columns only mirror
// what the last GET returned.
function saveInvoiceMirror(d, rpId, f) {
  d.prepare(`UPDATE rent_period SET paypal_invoice_id=?, paypal_invoice_number=?, paypal_invoice_status=?, payer_view_url=?,
      paypal_invoice_paid_cents=?, paypal_invoice_due_cents=?, paypal_invoice_min_due_cents=?, paypal_invoice_due_date=?, paypal_invoice_synced_at=? WHERE id=?`)
    .run(f.id, f.number, f.status, f.payer_view_url, f.paid_cents, f.due_cents, f.allow_partial_payment ? f.minimum_amount_due_cents : null,
      f.due_date, new Date().toISOString(), rpId);
}
const invTerms = (f) => f && { status: f.status, allow_partial_payment: f.allow_partial_payment, minimum_amount_due_cents: f.minimum_amount_due_cents,
  due_date: f.due_date, paid_cents: f.paid_cents, due_cents: f.due_cents };
const minTxt = (f) => (f.allow_partial_payment ? `minimum ${money(f.minimum_amount_due_cents)}` : 'full amount only (partial payment off)');

// One real invoice per rent period: create it as "pay in full", send it, store id + number.
const invoiceInFlight = new Set();
async function ensureInvoice(d, rpId) {
  const rp = getPeriod(d, rpId);
  if (!rp || rp.paypal_invoice_id || invoiceInFlight.has(rpId)) return null;
  invoiceInFlight.add(rpId);
  try {
    const number = `RR-${rp.period}-U${rp.unit_id}-RP${rp.id}-${Date.now().toString(36).toUpperCase()}`;
    const r = await createAndSendRentInvoice(rp, { invoiceNumber: number });
    const f = invoiceFacts(r.invoice);
    tx(d, () => {
      saveInvoiceMirror(d, rpId, f);
      logEvent(d, { kind: 'invoice_sent', actor: 'landlord', rent_period_id: rpId,
        summary: `PayPal invoice ${f.number} (${f.id}) created and sent to ${rp.tenant_name} for ${money(f.total_cents)}, due ${f.due_date}. PayPal status ${f.status}, ${minTxt(f)}`,
        payload: { invoice_id: f.id, invoice_number: f.number, ...invTerms(f), total_cents: f.total_cents, payer_view_url: f.payer_view_url,
          debug_ids: { create: r.create_debug_id, send: r.send_debug_id } } });
    });
    return f;
  } finally { invoiceInFlight.delete(rpId); }
}
async function ensureInvoices(d) {
  const out = [];
  for (const { id } of d.prepare('SELECT id FROM rent_period WHERE paypal_invoice_id IS NULL ORDER BY id').all()) {
    try { const f = await ensureInvoice(d, id); if (f) out.push({ rent_period_id: id, invoice_id: f.id, invoice_number: f.number, status: f.status }); }
    catch (e) { console.error(`[invoice] rent_period ${id}: ${e.message}`); out.push({ rent_period_id: id, error: e.message }); }
  }
  return out;
}

// Make the real invoice say what the plan says. With an approved plan and an unpaid installment:
// partial payment ON, minimum_amount_due = that installment, due date = its due date, schedule in the note.
// Without a plan (cancelled / none): partial payment OFF, original due date. PayPal enforces only the minimum;
// the full schedule lives in RentRoll's plan table (PayPal has no installment-schedule field).
async function syncInvoiceTerms(d, rpId, { reason }) {
  if (!INVOICING_ON) return { ok: false, skipped: 'invoicing disabled (RENTROLL_INVOICING=0)' };
  const rp = getPeriod(d, rpId);
  if (!rp?.paypal_invoice_id) return { ok: false, skipped: 'this rent period has no PayPal invoice' };
  if (['PAID', 'MARKED_AS_PAID', 'CANCELLED', 'REFUNDED'].includes(rp.paypal_invoice_status)) return { ok: true, skipped: `invoice is ${rp.paypal_invoice_status}` };
  const ap = activePlanRow(d, rpId);
  const sch = ap ? planSchedule(d, ap) : null;
  const nx = sch?.next_installment;
  if (ap && !nx) return { ok: true, skipped: `plan #${ap.id} has no unpaid installment` };
  const base = `${monthName(rp.period)} rent, ${rp.unit_label}, ${rp.unit_address || ''}`.trim();
  const terms = nx
    ? { allowPartial: true, minimumCents: nx.amount_cents, dueDate: nx.due_date,
      note: `${base}. Payment plan #${ap.id} approved by the landlord ${ap.approved_at.slice(0, 10)}: ` +
        sch.installments.map((x) => `${x.n}) ${money(x.amount_cents)} by ${x.due_date}${x.state === 'PAID' ? ' (paid)' : ''}`).join(', ') +
        `. Next payment due: ${money(nx.amount_cents)} by ${nx.due_date}.` }
    : { allowPartial: false, dueDate: rp.due_date, note: `${base}. No payment plan in force.` };
  let r;
  try { r = await applyTermsToInvoice(rp.paypal_invoice_id, terms); }
  catch (e) {
    tx(d, () => logEvent(d, { kind: 'invoice_update_failed', actor: 'system', rent_period_id: rpId,
      summary: `Could not update PayPal invoice ${rp.paypal_invoice_number} (${reason}): ${e.message}. RentRoll's own enforcement still applies`,
      payload: { invoice_id: rp.paypal_invoice_id, reason, wanted: terms, error: e.message, debug_id: e.debug_id ?? null } }));
    return { ok: false, error: e.message };
  }
  const fb = invoiceFacts(r.before), f = invoiceFacts(r.after);
  const applied = f.allow_partial_payment === terms.allowPartial && (!terms.allowPartial || f.minimum_amount_due_cents === terms.minimumCents) && f.due_date === terms.dueDate;
  tx(d, () => {
    saveInvoiceMirror(d, rpId, f);
    logEvent(d, { kind: 'invoice_updated', actor: 'landlord', rent_period_id: rpId,
      summary: `PayPal invoice ${f.number} updated (${reason}): ${minTxt(fb)} -> ${minTxt(f)}, due ${fb.due_date} -> ${f.due_date}. Read back from PayPal: status ${f.status}${applied ? '' : ' (WARNING: PayPal did not store what RentRoll sent)'}`,
      payload: { invoice_id: f.id, invoice_number: f.number, reason, plan_id: ap?.id ?? null, before: invTerms(fb), after: invTerms(f), applied, put_debug_id: r.put_debug_id } });
  });
  return { ok: applied, invoice_id: f.id, invoice_number: f.number, before: invTerms(fb), after: invTerms(f) };
}

// Card money moves through Orders (no buyer login needed); this writes that capture onto the real invoice with
// record-payment. Idempotent: skips if the payment already has an invoice payment id, or if the invoice already
// carries a transaction whose note names this capture (e.g. the API path and the capture webhook raced).
const recordingNow = new Set();
async function recordCaptureOnInvoice(d, payId) {
  if (!INVOICING_ON) return { ok: false, skipped: 'invoicing disabled (RENTROLL_INVOICING=0)' };
  const pay = d.prepare('SELECT * FROM payment WHERE id=?').get(payId);
  if (!pay || pay.status !== 'COMPLETED' || !pay.paypal_capture_id) return { ok: false, skipped: 'payment is not a completed capture' };
  if (pay.invoice_payment_id) return { ok: true, skipped: 'already recorded', invoice_payment_id: pay.invoice_payment_id };
  const rp = getPeriod(d, pay.rent_period_id);
  if (!rp?.paypal_invoice_id) return { ok: false, skipped: 'this rent period has no PayPal invoice' };
  if (recordingNow.has(payId)) return { ok: true, skipped: 'recording in progress' };
  recordingNow.add(payId);
  try {
    const cur = invoiceFacts(await getInvoice(rp.paypal_invoice_id));
    let extr = cur.transactions.find((t) => (t.note || '').includes(pay.paypal_capture_id))?.payment_id ?? null;
    let debugId = null;
    if (!extr) {
      const r = await recordPaymentOnInvoice(rp.paypal_invoice_id, { amountCents: pay.amount_cents,
        paymentDate: (pay.paid_at || new Date().toISOString()).slice(0, 10),
        note: `RentRoll payment #${pay.id}: card charged through the PayPal Orders API, order ${pay.paypal_order_id}, capture ${pay.paypal_capture_id}` +
          `${pay.plan_id ? `, plan #${pay.plan_id} installment ${pay.plan_installment}` : ''}. Recorded on this invoice by RentRoll (record-payment).` });
      extr = r.invoice_payment_id; debugId = r.debug_id;
    }
    const f = invoiceFacts(await getInvoice(rp.paypal_invoice_id));
    tx(d, () => {
      d.prepare("UPDATE payment SET invoice_payment_id=?, invoice_recorded_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND invoice_payment_id IS NULL").run(extr, payId);
      saveInvoiceMirror(d, rp.id, f);
      logEvent(d, { kind: 'invoice_payment_recorded', actor: 'system', rent_period_id: rp.id,
        summary: `Recorded ${money(pay.amount_cents)} (capture ${pay.paypal_capture_id}) on PayPal invoice ${f.number} as payment ${extr}. Read back from PayPal: ${f.status}, ${money(f.paid_cents)} paid, ${money(f.due_cents)} due`,
        payload: { payment_id: payId, invoice_id: f.id, invoice_number: f.number, invoice_payment_id: extr, capture_id: pay.paypal_capture_id,
          after: invTerms(f), debug_id: debugId, already_on_invoice: !debugId } });
    });
    const terms = activePlanRow(d, rp.id) ? await syncInvoiceTerms(d, rp.id, { reason: `installment ${pay.plan_installment} paid, next installment` }) : null;
    return { ok: true, invoice_payment_id: extr, invoice: invTerms(f), invoice_terms: terms };
  } catch (e) {
    tx(d, () => logEvent(d, { kind: 'invoice_update_failed', actor: 'system', rent_period_id: rp.id,
      summary: `Could not record capture ${pay.paypal_capture_id} on PayPal invoice ${rp.paypal_invoice_number}: ${e.message}`,
      payload: { payment_id: payId, invoice_id: rp.paypal_invoice_id, error: e.message, debug_id: e.debug_id ?? null } }));
    return { ok: false, error: e.message };
  } finally { recordingNow.delete(payId); }
}

// INVOICING.INVOICE.* webhook: never trust the payload's numbers. GET the invoice, then reconcile every
// transaction PayPal holds against RentRoll's payment rows. A transaction RentRoll did not record itself
// (e.g. the tenant paid on PayPal's hosted invoice page) becomes a new paypal_invoice payment.
async function handleInvoiceEvent(d, event, { verification, via }) {
  const claimed = event.resource?.invoice || event.resource || {};
  const invId = claimed.id;
  const meta = { event_id: event.id, event_type: event.event_type, verification, via, resource_id: invId, create_time: event.create_time ?? null,
    payload_claimed: { status: claimed.status ?? null, paid_amount: claimed.payments?.paid_amount ?? null } };
  const rpRow = invId ? d.prepare('SELECT id FROM rent_period WHERE paypal_invoice_id=?').get(invId) : null;
  if (!rpRow) {
    logEvent(d, { kind: 'webhook_received', actor: 'paypal', summary: `PayPal ${event.event_type} for invoice ${invId || '?'}, which is not a RentRoll rent invoice`, payload: meta, paypal_event_id: event.id });
    return { result: 'unmatched_invoice', event_id: event.id, invoice_id: invId };
  }
  // A failed GET throws before anything is logged, so the 500 makes PayPal retry the delivery.
  const f = invoiceFacts(await getInvoice(invId));
  const out = tx(d, () => {
    if (d.prepare('SELECT id FROM event_log WHERE paypal_event_id=?').get(event.id)) return { result: 'duplicate', event_id: event.id };
    const rp = getPeriod(d, rpRow.id);
    const added = [], matched = [];
    for (const t of f.transactions) {
      let pay = d.prepare('SELECT * FROM payment WHERE rent_period_id=? AND invoice_payment_id=?').get(rp.id, t.payment_id);
      if (!pay) { // our own record-payment whose API response hasn't been stored yet: the note names the capture
        const cap = /capture ([A-Z0-9]{10,})/.exec(t.note || '')?.[1];
        pay = cap ? d.prepare('SELECT * FROM payment WHERE paypal_capture_id=?').get(cap) : null;
        if (pay) d.prepare('UPDATE payment SET invoice_payment_id=COALESCE(invoice_payment_id, ?) WHERE id=?').run(t.payment_id, pay.id);
      }
      if (pay) {
        d.prepare('UPDATE payment SET invoice_webhook_event_id=COALESCE(invoice_webhook_event_id, ?) WHERE id=?').run(event.id, pay.id);
        matched.push({ payment_id: pay.id, invoice_payment_id: t.payment_id });
        continue;
      }
      // Paid on PayPal's side without going through RentRoll: record what PayPal says, link to the plan only
      // if it is exactly the next installment.
      const ap = activePlanRow(d, rp.id);
      const nx = ap ? planSchedule(d, ap).next_installment : null;
      const link = nx && t.amount_cents === nx.amount_cents;
      const idx = d.prepare("SELECT COUNT(*) n FROM payment WHERE rent_period_id=? AND status IN ('COMPLETED','PENDING')").get(rp.id).n + 1;
      const id = Number(d.prepare(`INSERT INTO payment (rent_period_id, installment_index, source, status, amount_cents, custom_id, paid_at,
          plan_id, plan_installment, invoice_payment_id, invoice_webhook_event_id, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(rp.id, link ? nx.n : idx, 'paypal_invoice', 'COMPLETED', t.amount_cents, `RRINV:${invId}:${t.payment_id}`, t.payment_date || event.create_time || null,
          link ? ap.id : null, link ? nx.n : null, t.payment_id, event.id,
          nx && !link ? `amount ${money(t.amount_cents)} is not plan #${ap.id}'s next installment (${money(nx.amount_cents)})` : null).lastInsertRowid);
      if (link) settlePlan(d, ap.id);
      added.push({ payment_id: id, invoice_payment_id: t.payment_id, type: t.type, method: t.method, amount_cents: t.amount_cents, plan_id: link ? ap.id : null });
    }
    const s = recompute(d, rp.id);
    saveInvoiceMirror(d, rp.id, f);
    const matches = f.paid_cents === s.paid_cents;
    logEvent(d, { kind: 'webhook_received', actor: 'paypal', rent_period_id: rp.id,
      summary: `PayPal ${event.event_type} for invoice ${f.number}. Re-read from PayPal: ${f.status}, ${money(f.paid_cents)} paid, ${money(f.due_cents)} due, ${minTxt(f)}, due ${f.due_date}` +
        `${added.length ? `. ${added.length} payment(s) made on PayPal's side added to the ledger` : ''}. ${matches ? 'Matches' : `MISMATCH with`} RentRoll's ledger (${money(s.paid_cents)} paid)`,
      payload: { ...meta, invoice_id: f.id, invoice_number: f.number, invoice: invTerms(f), local_paid_cents: s.paid_cents, matches_ledger: matches, matched, added },
      paypal_event_id: event.id });
    return { result: 'invoice_reconciled', invoice_id: f.id, invoice_status: f.status, invoice_paid_cents: f.paid_cents, local_paid_cents: s.paid_cents,
      matches_ledger: matches, added: added.length, matched: matched.length, event_id: event.id, event_type: event.event_type, verification, via };
  });
  if (out.added && activePlanRow(d, rpRow.id)) out.invoice_terms = await syncInvoiceTerms(d, rpRow.id, { reason: 'payment made on the PayPal invoice' });
  return out;
}

// Open a new month: one rent_period per unit (same rent + due day) and its PayPal invoice.
async function openMonth(d, period) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new HttpError(400, 'period must be YYYY-MM');
  const created = tx(d, () => d.prepare('SELECT * FROM unit ORDER BY id').all().flatMap((u) => {
    if (d.prepare('SELECT 1 FROM rent_period WHERE unit_id=? AND period=?').get(u.id, period)) return [];
    const due = `${period}-${String(u.due_day).padStart(2, '0')}`;
    const id = Number(d.prepare('INSERT INTO rent_period (unit_id, tenant_id, period, due_date, amount_due_cents) VALUES (?,?,?,?,?)')
      .run(u.id, u.tenant_id, period, due, u.monthly_rent_cents).lastInsertRowid);
    logEvent(d, { kind: 'seed', actor: 'system', rent_period_id: id, summary: `${monthName(period)} rent opened for ${u.label}: ${money(u.monthly_rent_cents)} due ${due}`,
      payload: { unit_id: u.id, tenant_id: u.tenant_id } });
    return [id];
  }));
  return { created, invoices: INVOICING_ON ? await ensureInvoices(d) : [] };
}

// ───────────────────────────── reminder escalation (Sprint 4) ─────────────────────────────
// Manually / dashboard-triggered check (no fake background scheduler). Every decision is recomputed from the
// payments table + event_log at run time; see lib/reminders.js.
let reminderRunActive = false;
async function runReminders(d, { dryRun = false } = {}) {
  if (reminderRunActive) throw new HttpError(409, 'a reminder run is already in progress');
  reminderRunActive = true;
  try {
    const runAt = new Date().toISOString(), t = today();
    const deps = { activePlanRow, planSchedule };
    const ids = d.prepare('SELECT id FROM rent_period ORDER BY unit_id, period').all().map((r) => r.id);
    const results = [];
    for (const id of ids) {
      const st = reminderState(d, id, t, deps);
      const head = { rent_period_id: id, unit: st.unit, tenant: st.tenant, period: st.period };
      const facts = { open_balance_cents: st.open_balance_cents, owed_cents: st.target?.owed_cents ?? null, target_key: st.target?.key ?? null,
        due_date: st.target?.due_date ?? null, days_overdue: st.days_overdue ?? null, tier: st.tier ?? null, late_fee_applicable: st.late_fee_applicable ?? false,
        prior_reminders: st.prior_reminders ?? 0, last_reminder_at: st.last_reminder_at ?? null, last_reminder_event_id: st.last_reminder_event_id ?? null,
        hours_since_last: st.hours_since_last ?? null, changed_since_last: st.changed_since_last ?? null, cached_status: st.cached_status };
      if (st.skip) { results.push({ ...head, action: 'skipped', reason: st.skip, ...facts }); continue; }
      if (dryRun) { results.push({ ...head, action: 'would_draft', ...facts }); continue; }
      const draft = await draftReminder(st);
      // The LLM call took seconds; money may have moved. Re-check and write atomically.
      const out = tx(d, () => {
        const now = reminderState(d, id, today(), deps);
        if (now.skip || now.target.key !== st.target.key || now.target.owed_cents !== st.target.owed_cents || now.tier !== st.tier)
          return { ...head, action: 'discarded', reason: `state changed while drafting: ${now.skip || 'amount/tier changed'}`, ...facts };
        const n = now.prior_reminders + 1;
        const tgt = now.target.kind === 'plan_installment' ? `plan #${now.target.plan_id} installment ${now.target.installment} of ${now.target.installments_total}` : `${monthName(now.period)} rent`;
        const payload = { target_key: now.target.key, target: now.target, tier: now.tier, days_overdue: now.days_overdue, owed_cents: now.target.owed_cents,
          open_balance_cents: now.open_balance_cents, paid_cents: now.paid_cents, late_fee_applicable: now.late_fee_applicable, late_fee_cents: now.late_fee_cents,
          reminder_number: n, previous_reminder_event_id: now.last_reminder_event_id, previous_reminder_at: now.last_reminder_at, changed_since_last: now.changed_since_last ?? null,
          today: now.today, run_at: runAt, channel: 'sms', to: now.tenant_phone,
          delivery: 'not_sent: no SMS/email integration in this build; drafted and logged only',
          text: draft.text, drafted_by: draft.drafted_by, fallback_reason: draft.fallback_reason ?? null, llm: { model: draft.model ?? null, attempts: draft.attempts } };
        const eid = Number(d.prepare('INSERT INTO event_log (kind, actor, rent_period_id, summary, payload_json) VALUES (?,?,?,?,?)').run('reminder_sent', 'ai', id,
          `Reminder #${n} drafted and logged (${now.tier.toUpperCase()}, ${now.days_overdue} day${now.days_overdue === 1 ? '' : 's'} overdue, ${money(now.target.owed_cents)} for ${tgt}) for ${now.tenant}. Would be sent by SMS in production; not delivered: "${draft.text.slice(0, 140)}${draft.text.length > 140 ? '…' : ''}"`,
          JSON.stringify(payload)).lastInsertRowid);
        return { ...head, action: 'drafted', event_log_id: eid, reminder_number: n, drafted_by: draft.drafted_by, fallback_reason: draft.fallback_reason ?? null,
          text: draft.text, delivery: payload.delivery, ...facts };
      });
      results.push(out);
    }
    return { ok: true, run_at: runAt, today: t, dry_run: dryRun, rate_limit_hours: RATE_LIMIT_HOURS(),
      drafted: results.filter((r) => r.action === 'drafted').length, would_draft: results.filter((r) => r.action === 'would_draft').length,
      skipped: results.filter((r) => r.action === 'skipped' || r.action === 'discarded').length, results };
  } finally { reminderRunActive = false; }
}

const latestReminder = (d, rpId) => {
  const r = d.prepare("SELECT id, at, payload_json FROM event_log WHERE kind='reminder_sent' AND rent_period_id=? ORDER BY id DESC LIMIT 1").get(rpId);
  if (!r) return null;
  const p = JSON.parse(r.payload_json);
  return { ...p, id: r.id, at: r.at, total: d.prepare("SELECT COUNT(*) n FROM event_log WHERE kind='reminder_sent' AND rent_period_id=?").get(rpId).n };
};

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

  if (String(event.event_type).startsWith('INVOICING.INVOICE.')) {
    try { return await handleInvoiceEvent(d, event, { verification, via }); }
    catch (e) {
      if (/UNIQUE constraint failed: event_log\.paypal_event_id|duplicate paypal_event_id/.test(e.message)) return { result: 'duplicate', event_id: event.id };
      throw e;
    }
  }
  const res = event.resource || {};
  const base = { event_id: event.id, event_type: event.event_type, verification, via };
  let out;
  try {
    out = tx(d, () => {
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
              custom_id, paypal_capture_id, paypal_order_id, paid_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(Number(m[1]), Number(m[4]), 'paypal_capture', 'COMPLETED', amt, fee, net, res.custom_id, res.id,
              res.supplementary_data?.related_ids?.order_id ?? null, res.create_time || event.create_time || new Date().toISOString()).lastInsertRowid);
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
              net_cents=COALESCE(net_cents, ?), paid_at=COALESCE(paid_at, ?), webhook_event_id=?, webhook_confirmed_at=?,
              paypal_order_id=COALESCE(paypal_order_id, ?) WHERE id=?`)
            .run(res.id, fee, net, res.create_time || event.create_time || new Date().toISOString(), event.id, new Date().toISOString(),
              res.supplementary_data?.related_ids?.order_id ?? null, pay.id);
        } else {
          d.prepare("UPDATE payment SET status='DENIED', webhook_event_id=?, webhook_confirmed_at=?, error='PAYMENT.CAPTURE.DENIED' WHERE id=?")
            .run(event.id, new Date().toISOString(), pay.id);
        }
        const s = recompute(d, pay.rent_period_id);
        settlePlan(d, pay.plan_id);
        const rp = getPeriod(d, pay.rent_period_id);
        logEvent(d, { kind: 'webhook_received', actor: 'paypal', rent_period_id: rp.id,
          summary: completed
            ? `PayPal confirmed ${money(pay.amount_cents)} from ${rp.tenant_name}${pay.plan_id ? ` for plan #${pay.plan_id} installment ${pay.plan_installment}` : ''} (capture ${res.id}). ${rp.unit_label} ${monthName(rp.period)}: ${s.status.replace('_', ' ')}, balance ${money(s.balance_cents)}`
            : `PayPal DENIED capture ${res.id} (${money(pay.amount_cents)}) for ${rp.unit_label}. Balance ${money(s.balance_cents)}`,
          payload: { ...meta, payment_id: pay.id, status_before: s.before, status_after: s.status }, paypal_event_id: event.id });
        return { result: completed ? 'payment_confirmed' : 'payment_denied', payment_id: pay.id, ...s, ...base };
      }

      // Other event types (CHECKOUT.ORDER.APPROVED, ...): recorded in the ledger, no state change.
      logEvent(d, { kind: 'webhook_received', actor: 'paypal', summary: `PayPal event ${event.event_type} received (${event.summary || 'no summary'})`,
        payload: meta, paypal_event_id: event.id });
      return { result: 'logged', ...base };
    });
  } catch (e) {
    if (/UNIQUE constraint failed: event_log\.paypal_event_id|duplicate paypal_event_id/.test(e.message)) return { result: 'duplicate', event_id: event.id };
    throw e;
  }
  // A capture confirmed only by webhook (API response was PENDING, or captured outside the app) still gets
  // recorded on the invoice. recordCaptureOnInvoice() is idempotent, so the usual case is a no-op.
  if (out.result === 'payment_confirmed') out.invoice = await recordCaptureOnInvoice(d, out.payment_id);
  return out;
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
a.packet{display:inline-block;margin-top:6px;color:var(--brand);text-decoration:none;border:1px solid var(--brand);border-radius:6px;padding:2px 8px;white-space:nowrap}a.packet:hover{background:var(--brand);color:#fff}
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
form.msg input{width:250px}button.ghost{background:#fff;color:var(--brand);border:1px solid #c9d8ff}
tr.planrow td{background:#fbfcff;padding:0 16px 16px}
.plan{border:1px solid #c9d8ff;border-left:4px solid var(--brand);border-radius:10px;background:#fff;padding:12px 16px}
.plan.needs_review,.plan.parse_failed{border-color:#ffd59e;border-left-color:var(--warn)}
.plan-h{display:flex;gap:10px;align-items:center;justify-content:space-between;margin-bottom:8px}
.pill.plan-proposed{background:#e8efff;color:var(--brand)}.pill.plan-needs_review,.pill.plan-parse_failed{background:#fff4e5;color:var(--warn)}
.plan blockquote{margin:0 0 8px;padding:6px 12px;border-left:3px solid var(--line);font-style:italic}
.ground{font-size:13px;background:#f3f6ff;border-radius:8px;padding:8px 10px;margin-bottom:10px}
table.inst{border-radius:8px;margin-bottom:8px}table.inst td,table.inst th{padding:6px 12px}tr.tot td{font-weight:700;background:#fafbfc}
.why{margin:6px 0 10px;font-size:13.5px}.issues{color:var(--warn);font-size:13px;margin:0 0 10px}
.who.ai{color:#7b1fa2}
.plan-act{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px}.plan-act form{margin:0}
.plan.approved{border-color:#b7e1c3;border-left-color:var(--ok)}.pill.plan-approved{background:#e6f4ea;color:var(--ok)}
.pill.inst-PAID{background:#e6f4ea;color:var(--ok)}.pill.inst-DUE{background:#e8efff;color:var(--brand)}.pill.inst-OVERDUE{background:#fdecea;color:var(--bad)}
.pill.inst-UPCOMING{background:#f1f2f5;color:var(--muted)}.pill.inst-PROCESSING{background:#fff4e5;color:var(--warn)}
form.pay.locked{align-items:center}.lockamt{font-weight:700;padding:6px 10px;border:1px dashed var(--ok);border-radius:8px;background:#f3fbf5}
.who.landlord{color:var(--ok)}
.remhdr{display:flex;gap:12px;align-items:center;margin:0 0 12px}.remhdr form{margin:0}
tr.remrow td{background:#fbfcff;padding:0 16px 16px}
.rem{border:1px solid var(--line);border-left:4px solid var(--info);border-radius:10px;background:#fff;padding:10px 16px}
.rem.tier-firm{border-left-color:var(--warn)}.rem.tier-formal{border-left-color:var(--bad);background:#fffafa}
.pill.tier-friendly{background:#e8f1fd;color:var(--info)}.pill.tier-firm{background:#fff4e5;color:var(--warn)}.pill.tier-formal{background:#fdecea;color:var(--bad)}
.remtxt{margin:6px 0;padding:6px 12px;border-left:3px solid var(--line);font-size:14px}
@media(max-width:820px){.kpis{grid-template-columns:1fr}table,thead,tbody,tr,td{display:block}thead{display:none}td{border:0;padding:8px 16px}tr{border-bottom:1px solid var(--line);padding:8px 0}.num{text-align:left}}
`;

// The plan shown under a unit row: the approved (enforced) plan if there is one, else the latest open AI proposal.
function renderPlanRow(d, rp) {
  const row = activePlanRow(d, rp.id)
    || d.prepare("SELECT * FROM plan WHERE rent_period_id=? AND status IN ('proposed','needs_review','parse_failed','completed') ORDER BY id DESC LIMIT 1").get(rp.id);
  const p = planOut(d, row);
  if (!p) return '';
  if (p.status === 'completed' && rp.status === 'PAID' && p.schedule) return renderApprovedPlan(rp, p);
  if (p.status === 'completed') return '';
  if (p.status === 'approved') return renderApprovedPlan(rp, p);
  const msg = p.source_message_id ? d.prepare('SELECT body, received_at FROM message WHERE id=?').get(p.source_message_id) : null;
  const s = p.ledger_snapshot;
  const label = { proposed: 'AI proposal · awaiting your approval', needs_review: 'AI proposal · failed RentRoll checks, needs review', parse_failed: 'AI reply unusable' }[p.status];
  const inst = p.installments.map((x, i) => `<tr><td>${i + 1}</td><td>${x.due_date && /^\d{4}-\d{2}-\d{2}$/.test(x.due_date) ? fmtDate(x.due_date) : esc(x.due_date)}</td>
    <td class="num">${Number.isFinite(x.amount_cents) ? money(x.amount_cents) : esc(x.amount_cents)}</td><td class="small">${esc(x.note)}</td></tr>`).join('');
  const sum = p.installments.reduce((a, x) => a + (Number.isFinite(x.amount_cents) ? x.amount_cents : 0), 0);
  return `<tr class="planrow"><td colspan="6"><div class="plan ${p.status}">
    <div class="plan-h"><span class="pill plan-${p.status}">${esc(label)}</span><span class="small">plan #${p.id} · ${fmtTime(p.created_at)}</span></div>
    ${msg ? `<blockquote>“${esc(msg.body)}”<span class="small"> · ${esc(rp.tenant_name)}, ${fmtTime(msg.received_at)}</span></blockquote>` : ''}
    ${s ? `<div class="ground"><b>Read from the ledger before proposing:</b> rent ${money(s.amount_due_cents)} due ${fmtDate(s.due_date)} − paid ${money(s.amount_paid_cents)}
      (${s.payments.length} PayPal capture${s.payments.length === 1 ? '' : 's'}) = <b>${money(s.outstanding_cents)} outstanding</b>.
      Late fee ${s.late_fee_rule.value_cents ? money(s.late_fee_rule.value_cents) : 'none'} ${s.late_fee_currently_applicable ? `applicable since ${fmtDate(s.late_fee_applies_from)} (not charged)` : 'not yet applicable'}.</div>` : ''}
    ${inst ? `<table class="inst"><thead><tr><th>#</th><th>Due</th><th class="num">Amount</th><th>Note</th></tr></thead><tbody>${inst}
      <tr class="tot"><td></td><td>Total</td><td class="num">${money(sum)}</td><td class="small">${s && Math.abs(sum - s.outstanding_cents) <= 1 ? '✓ matches the ledger balance' : '✗ does not match the ledger balance'}</td></tr></tbody></table>` : ''}
    ${p.reasoning ? `<p class="why"><b>AI reasoning:</b> ${esc(p.reasoning)}</p>` : ''}
    ${p.validation_errors.length ? `<ul class="issues">${p.validation_errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    <div class="plan-act">
      ${p.status === 'proposed' ? `<form method="post" action="/plans/${p.id}/approve" title="Locks the schedule: PayPal payments for this unit will only be accepted for the next installment's exact amount"><button>Approve plan</button></form>` : ''}
      <form method="post" action="/plans/${p.id}/reject"><button class="ghost">${p.status === 'proposed' ? 'Reject' : 'Dismiss'}</button></form>
      ${p.status === 'proposed' ? `<span class="small">Approving locks the tenant's payments to this schedule.</span>` : ''}
    </div>
  </div></td></tr>`;
}

const STATE_TXT = { PAID: '✓ PAID', PROCESSING: 'processing at PayPal', DUE: 'NEXT · due', OVERDUE: 'NEXT · overdue since', UPCOMING: 'upcoming' };
function renderApprovedPlan(rp, p) {
  const rows = p.schedule.map((x) => `<tr class="st-${x.state}"><td>${x.n} of ${x.of}</td><td>${fmtDate(x.due_date)}</td><td class="num">${money(x.amount_cents)}</td>
    <td><span class="pill inst-${x.state}">${STATE_TXT[x.state]}${x.state === 'DUE' || x.state === 'OVERDUE' ? ' ' + fmtDate(x.due_date) : ''}</span>
    ${x.paypal_capture_id ? `<span class="small"> capture ${esc(x.paypal_capture_id)}${x.webhook_confirmed ? ' · ✓ PayPal confirmed' : x.state === 'PAID' ? ' · awaiting webhook' : ''}</span>` : ''}</td></tr>`).join('');
  return `<tr class="planrow"><td colspan="6"><div class="plan approved">
    <div class="plan-h"><span class="pill plan-approved">${p.status === 'approved' ? '🔒 Approved plan · enforced on every PayPal payment' : '✓ Plan completed'}</span>
      <span class="small">plan #${p.id} · approved ${fmtTime(p.approved_at)}</span></div>
    <table class="inst"><thead><tr><th>Installment</th><th>Due</th><th class="num">Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>
    ${p.status === 'approved' ? `<div class="plan-act"><span class="small">Until this plan is done, "Tenant pays" only accepts the next installment's exact amount; anything else is refused before PayPal is called.</span>
      <form method="post" action="/plans/${p.id}/reject"><button class="ghost">Cancel plan</button></form></div>` : ''}
  </div></td></tr>`;
}

const TIER_LABEL = { friendly: 'Friendly nudge', firm: 'Firm reminder', formal: 'Formal notice' };
function renderReminderRow(d, rp) {
  const r = latestReminder(d, rp.id);
  if (!r) return '';
  const stillOwed = rp.amount_due_cents - rp.amount_paid_cents > 0;
  return `<tr class="remrow"><td colspan="6"><div class="rem tier-${r.tier}">
    <div class="plan-h"><span><span class="pill tier-${r.tier}">${esc(TIER_LABEL[r.tier] || r.tier)}</span>
      <span class="small"> #${r.reminder_number} for this amount · ${r.days_overdue} day${r.days_overdue === 1 ? '' : 's'} overdue · ${money(r.owed_cents)} owed${r.late_fee_applicable ? ` · ${money(r.late_fee_cents)} late fee applies` : ''}${r.target?.kind === 'plan_installment' ? ` · plan #${r.target.plan_id} installment ${r.target.installment}` : ''}</span></span>
      <span class="small">${fmtTime(r.at)} · ${r.total} logged for this period</span></div>
    <blockquote class="remtxt">${esc(r.text)}</blockquote>
    <div class="small">${r.drafted_by === 'llm' ? 'Drafted by AI from the ledger facts above' : `Template fallback (${esc(r.fallback_reason || 'AI draft unavailable')})`} · SMS to ${esc(r.to || 'tenant')} · <b>drafted and logged only, not delivered</b> (no SMS/email integration in this build)${stillOwed ? '' : ' · <span class="ok-ic">since paid, no further reminders</span>'}</div>
  </div></td></tr>`;
}

function renderDashboard(d, flash) {
  const rows = currentPeriods(d);
  const period = rows[0]?.period || SEED_PERIOD;
  const due = rows.reduce((a, r) => a + r.amount_due_cents, 0), paid = rows.reduce((a, r) => a + r.amount_paid_cents, 0);
  const paidUnits = rows.filter((r) => r.status === 'PAID').length;
  const events = d.prepare('SELECT * FROM event_log ORDER BY id DESC LIMIT 15').all();
  const trs = rows.map((rp) => {
    const pays = d.prepare('SELECT * FROM payment WHERE rent_period_id=? ORDER BY id').all(rp.id);
    const ap = activePlanRow(d, rp.id);
    const nx = ap ? planSchedule(d, ap).next_installment : null;
    const na = nx && !pays.some((p) => p.status === 'PENDING')
      ? { tone: nx.state === 'OVERDUE' ? 'bad' : 'info', text: `On approved plan #${ap.id}: installment ${nx.n} of ${nx.of} (${money(nx.amount_cents)}) ${nx.state === 'OVERDUE' ? 'overdue since' : 'due'} ${fmtDate(nx.due_date)}` }
      : nextAction(rp, pays);
    const bal = rp.amount_due_cents - rp.amount_paid_cents;
    const pct = Math.min(100, Math.round((rp.amount_paid_cents / rp.amount_due_cents) * 100));
    const payList = pays.filter((p) => p.status !== 'FAILED').map((p) =>
      `<li>${fmtDate(p.paid_at || p.created_at)} · ${money(p.amount_cents)} card${p.plan_id ? ` · plan #${p.plan_id} inst. ${p.plan_installment}` : ''} · ${p.status === 'COMPLETED' ? (p.webhook_event_id || p.invoice_webhook_event_id ? '<span class="ok-ic">✓</span> PayPal confirmed' : 'captured, awaiting webhook') : esc(p.status.toLowerCase())}${p.invoice_payment_id ? ` · on invoice (${esc(p.invoice_payment_id)})` : ''}</li>`).join('');
    return `<tr>
      <td><b>${esc(rp.unit_label)}</b><div class="small">${esc(rp.unit_address)}</div>
        <a class="packet small" href="/api/rent-periods/${rp.id}/court-packet.pdf" title="Payment-history PDF from the ledger and PayPal records (not legal advice)">Download court packet (PDF)</a>
        ${rp.paypal_invoice_id ? `<div class="small inv" title="The real PayPal invoice for this month (read back from PayPal after every change)">PayPal invoice <a href="${esc(rp.payer_view_url || '#')}" rel="noopener" target="_blank">${esc(rp.paypal_invoice_number)}</a> · <b>${esc(rp.paypal_invoice_status)}</b>
          · ${rp.paypal_invoice_min_due_cents != null ? `partial OK, min ${money(rp.paypal_invoice_min_due_cents)}` : 'full amount'} · due ${esc(rp.paypal_invoice_due_date || '')}${rp.paypal_invoice_paid_cents ? ` · ${money(rp.paypal_invoice_paid_cents)} paid on invoice` : ''}</div>` : `<div class="small inv">No PayPal invoice yet</div>`}</td>
      <td>${esc(rp.tenant_name)}<div class="small">${esc(rp.tenant_email)}</div></td>
      <td class="num">${money(rp.amount_due_cents)}<div class="small">due ${fmtDate(rp.due_date)}</div></td>
      <td class="num">${money(rp.amount_paid_cents)}<div class="bar"><i style="width:${pct}%"></i></div>${bal > 0 && rp.amount_paid_cents > 0 ? `<div class="small">${money(bal)} left</div>` : ''}</td>
      <td><span class="pill ${rp.status}">${rp.status.replace('_', ' ')}</span></td>
      <td><div class="act ${na.tone}">${esc(na.text)}</div>${payList ? `<ul class="pays">${payList}</ul>` : ''}
        ${bal > 0 ? `${nx ? `<form class="pay locked" method="post" action="/rent-periods/${rp.id}/pay-sandbox" title="Approved plan #${ap.id}: only this exact amount is accepted">
          <input type="hidden" name="amount" value="${(nx.amount_cents / 100).toFixed(2)}"><span class="lockamt">🔒 ${money(nx.amount_cents)}</span>
          <button>Tenant pays installment ${nx.n} of ${nx.of}</button></form><div class="small">Locked by approved plan #${ap.id} · due ${fmtDate(nx.due_date)}</div>`
          : `<form class="pay" method="post" action="/rent-periods/${rp.id}/pay-sandbox" title="Simulates the tenant paying by card (PayPal sandbox test card, no login)">
          <input name="amount" inputmode="decimal" value="${(bal / 100).toFixed(2)}" aria-label="Amount in dollars"><button>Tenant pays</button></form>`}
        <form class="pay msg" method="post" action="/rent-periods/${rp.id}/messages" title="Simulates an incoming tenant text; the AI drafts a plan from the live balance">
          <input name="body" placeholder="Tenant texts… e.g. can I pay 900 now and the rest later" aria-label="Tenant message"><button class="ghost">Tenant texted</button></form>` : ''}</td>
    </tr>${renderPlanRow(d, rp)}${renderReminderRow(d, rp)}`;
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
  <div class="remhdr"><form method="post" action="/reminders/run" title="Checks every unit's live balance, days overdue and reminders already sent, then drafts only the reminders that are due"><button>Send reminders now</button></form>
    <span class="small">Reads the live ledger: who owes what, days overdue, late-fee grace, and reminders already sent (max one per ${RATE_LIMIT_HOURS()} h per unchanged balance). Drafts are logged; no SMS/email integration yet.</span></div>
  <table><thead><tr><th>Unit</th><th>Tenant</th><th class="num">Due</th><th class="num">Paid</th><th>Status</th><th>Next action</th></tr></thead><tbody>${trs}</tbody></table>
  <h2>Ledger</h2><ul class="feed">${feed || '<li>No activity yet.</li>'}</ul>
  <footer>Each month's rent is a real PayPal invoice; approving a plan rewrites that invoice's minimum amount due and due date. "Tenant pays" charges PayPal's sandbox test card through the Orders API and RentRoll records that capture on the invoice (record-payment). Every payment and PayPal webhook is written to an append-only ledger. No real money moves.</footer>
</main></body></html>`;
}

// ───────────────────────────── HTTP ─────────────────────────────
function buildApp(d) {
  const app = express();
  // Sprint 8: shared demo login on every route except GET /healthz and POST /webhooks/paypal (see lib/auth.js).
  app.use(basicAuth());

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

  // TODO(before real tenants): these routes expose tenant name/email/phone. Since Sprint 8 they sit behind
  // one shared, publicly listed demo login. Fine for fake hackathon seed data only; real tenants need real
  // per-user auth.
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
  // Sprint 2: tenant message in -> AI plan grounded in the ledger. JSON {"body": "...", "channel": "sms"}
  app.post('/api/rent-periods/:id/messages', express.json(), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'rent period id must be a positive integer');
      const r = await handleTenantMessage(d, id, req.body?.body, req.body?.channel);
      const { http, ...out } = r;
      res.status(http).json({ ok: http === 200, ...out });
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  });
  // Dashboard form version ("Tenant texted").
  app.post('/rent-periods/:id/messages', express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const r = await handleTenantMessage(d, Number(req.params.id), req.body?.body, 'sms');
      if (!r.plan) return res.redirect(303, `/?err=${encodeURIComponent(r.error)}`);
      const msg = { proposed: 'AI proposed a payment plan. Review it under the unit below.',
        needs_review: 'AI proposed a plan, but it failed RentRoll\'s checks. Review it below before doing anything.',
        parse_failed: 'The AI reply could not be used. The raw reply is saved; nothing was proposed.' }[r.plan.status];
      res.redirect(303, `/?${r.plan.status === 'proposed' ? 'ok' : 'err'}=${encodeURIComponent(msg)}`);
    } catch (e) { res.redirect(303, `/?err=${encodeURIComponent(e.message)}`); }
  });
  app.get('/api/rent-periods/:id/plans', (req, res) =>
    res.json(d.prepare('SELECT * FROM plan WHERE rent_period_id=? ORDER BY id DESC').all(Number(req.params.id)).map((r) => planOut(d, r))));

  // Sprint 3: landlord approves / rejects a plan. Approval changes what pay-sandbox will accept.
  const planId = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'plan id must be a positive integer');
    return id;
  };
  // Sprint 10: after the local approval commits, the real PayPal invoice is rewritten (partial payment on,
  // minimum_amount_due = next installment, due date = its date) and read back. Cancelling an approved plan turns
  // partial payment off again. If PayPal refuses, the plan stays approved locally and the response says so.
  const approveAndInvoice = async (d_, id) => {
    const r = approvePlan(d_, id);
    return { ...r, invoice: await syncInvoiceTerms(d_, r.plan.rent_period_id, { reason: `plan #${id} approved` }) };
  };
  const rejectAndInvoice = async (d_, id) => {
    const wasApproved = d_.prepare('SELECT status FROM plan WHERE id=?').get(id)?.status === 'approved';
    const r = rejectPlan(d_, id);
    return wasApproved ? { ...r, invoice: await syncInvoiceTerms(d_, r.plan.rent_period_id, { reason: `plan #${id} cancelled` }) } : r;
  };
  const invMsg = (r) => (!r.invoice ? '' : r.invoice.ok && r.invoice.after
    ? ` PayPal invoice ${r.invoice.invoice_number} updated: ${r.invoice.after.allow_partial_payment ? `minimum amount due ${money(r.invoice.after.minimum_amount_due_cents)}` : 'partial payment off'}, due ${r.invoice.after.due_date}.`
    : ` PayPal invoice NOT updated: ${r.invoice.error || r.invoice.skipped}.`);
  for (const [verb, fn, okMsg] of [
    ['approve', approveAndInvoice, (r) => `Plan #${r.plan.id} approved. The tenant can now only pay installment 1: ${money(r.plan.installments[0].amount_cents)}.${invMsg(r)}`],
    ['reject', rejectAndInvoice, (r) => `Plan #${r.plan.id} rejected.${invMsg(r)}`],
  ]) {
    app.post(`/api/plans/:id/${verb}`, async (req, res) => {
      try { res.json({ ok: true, ...(await fn(d, planId(req))) }); }
      catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
    });
    app.post(`/plans/:id/${verb}`, async (req, res) => {
      try { res.redirect(303, `/?ok=${encodeURIComponent(okMsg(await fn(d, planId(req))))}`); }
      catch (e) { res.redirect(303, `/?err=${encodeURIComponent(e.message)}`); }
    });
  }
  // Sprint 10: the live PayPal invoice behind a rent period (GET from PayPal, mirror refreshed).
  app.get('/api/rent-periods/:id/invoice', async (req, res) => {
    try {
      const rp = getPeriod(d, Number(req.params.id));
      if (!rp) throw new HttpError(404, 'rent period not found');
      if (!rp.paypal_invoice_id) throw new HttpError(404, 'this rent period has no PayPal invoice yet');
      const inv = await getInvoice(rp.paypal_invoice_id);
      const f = invoiceFacts(inv);
      tx(d, () => saveInvoiceMirror(d, rp.id, f));
      res.json({ ok: true, invoice: f, configuration: inv.configuration, payment_term: inv.detail?.payment_term, payments: inv.payments ?? null });
    } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  });

  // Sprint 4: reminder escalation check. JSON API (?dry_run=1 computes the decisions without drafting/logging).
  app.post('/api/reminders/run', async (req, res) => {
    try { res.json(await runReminders(d, { dryRun: ['1', 'true'].includes(String(req.query.dry_run)) })); }
    catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  });
  app.post('/reminders/run', async (_req, res) => {
    try {
      const r = await runReminders(d);
      const parts = r.results.map((x) => `${x.unit}: ${x.action === 'drafted' ? `${x.tier} reminder #${x.reminder_number} drafted` : `skipped (${x.reason.split(':')[0].split(' (')[0]})`}`);
      res.redirect(303, `/?ok=${encodeURIComponent(`Reminder check ran on live ledger state. ${parts.join(' · ')}. Drafts are logged only; no SMS/email is sent from this build.`)}`);
    } catch (e) { res.redirect(303, `/?err=${encodeURIComponent(e.message)}`); }
  });
  // Sprint 6: court packet (read-only). .json is the exact data the PDF is rendered from.
  // Sprint 10: the packet cites the real PayPal invoice, read live from PayPal at generation time (falls back to
  // the last mirrored state, clearly labelled, if PayPal can't be reached).
  const packet = async (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'rent period id must be a positive integer');
    const rp = getPeriod(d, id);
    if (!rp) throw new HttpError(404, `rent period ${id} not found`);
    let invoice = null;
    if (rp.paypal_invoice_id) {
      try { invoice = { ...invoiceFacts(await getInvoice(rp.paypal_invoice_id)), source: 'read live from PayPal', read_at: new Date().toISOString() }; }
      catch (e) {
        invoice = { id: rp.paypal_invoice_id, number: rp.paypal_invoice_number, status: rp.paypal_invoice_status, paid_cents: rp.paypal_invoice_paid_cents,
          due_cents: rp.paypal_invoice_due_cents, minimum_amount_due_cents: rp.paypal_invoice_min_due_cents, allow_partial_payment: rp.paypal_invoice_min_due_cents != null,
          due_date: rp.paypal_invoice_due_date, payer_view_url: rp.payer_view_url, transactions: null,
          source: `last state RentRoll read from PayPal (live read failed: ${e.message})`, read_at: rp.paypal_invoice_synced_at };
      }
    }
    return courtPacketData(d, id, { getPeriod, activePlanRow, planSchedule, today, invoice });
  };
  app.get('/api/rent-periods/:id/court-packet.json', async (req, res) => {
    try { res.json(await packet(req)); } catch (e) { res.status(e.status || 500).json({ ok: false, error: e.message }); }
  });
  app.get('/api/rent-periods/:id/court-packet.pdf', async (req, res) => {
    try {
      const data = await packet(req);
      const pdf = await renderCourtPacketPdf(data);
      const name = `rentroll-${data.property.unit.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-${data.rent_period.period}-payment-record.pdf`;
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' }).send(pdf);
    } catch (e) {
      if (!e.status) console.error('[court-packet] failed:', e.message);
      res.status(e.status || 500).json({ ok: false, error: e.status ? e.message : 'court packet generation failed' });
    }
  });
  app.get('/api/reminders', (_req, res) => res.json(d.prepare("SELECT id, at, rent_period_id, summary, payload_json FROM event_log WHERE kind='reminder_sent' ORDER BY id").all()
    .map((r) => ({ ...r, payload_json: undefined, payload: JSON.parse(r.payload_json) }))));

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
  if (INVOICING_ON && !args.includes('--no-invoices')) for (const r of await ensureInvoices(d)) console.log('  invoice', JSON.stringify(r));
} else if (args.includes('--ensure-invoices')) {
  const d = openDb();
  for (const r of await ensureInvoices(d)) console.log(JSON.stringify(r));
} else if (args.includes('--open-month')) {
  const d = openDb();
  console.log(JSON.stringify(await openMonth(d, args[args.indexOf('--open-month') + 1])));
} else if (args.includes('--ingest-webhook-log')) {
  const d = openDb();
  seed(d);
  for (const r of await ingestWebhookLog(d)) console.log(JSON.stringify(r));
} else {
  const d = openDb();
  if (seed(d)) console.log('empty database: seeded demo data');
  buildApp(d).listen(PORT, HOST, () => {
    console.log(`rentroll listening on http://${HOST}:${PORT} (db ${DB_PATH})`);
    // Sprint 10: every rent period gets a real PayPal invoice (back-fills periods created before Invoicing worked).
    (INVOICING_ON ? ensureInvoices(d) : Promise.resolve([])).then((rs) => rs.forEach((r) => console.log('[invoice]', JSON.stringify(r))))
      .then(() => ingestWebhookLog(d)).then((rs) => {
      const n = rs.filter((r) => r.result !== 'duplicate').length;
      if (n) console.log(`[webhook] back-filled ${n} logged deliveries`);
    }).catch((e) => console.error('[webhook] back-fill failed:', e.message));
  });
}
