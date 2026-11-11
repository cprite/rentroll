// Sprint 10 test helper: shift rent_period ids of a freshly seeded TEST DB by +1000 (1,2,3 -> 1001,1002,1003), for
// the same reason as sprint3/sprint4-testdb.mjs: the live service gets every sandbox webhook and matches
// custom_id "RR:rp<id>". Run it BEFORE the first server start, so each invoice is created for the offset id.
import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
if (!file || /data\/rentroll\.db$/.test(file)) { console.error('refusing: pass a TEST db path'); process.exit(1); }
const d = new DatabaseSync(file);
if (d.prepare('SELECT COUNT(*) n FROM rent_period WHERE paypal_invoice_id IS NOT NULL').get().n) { console.error('refusing: invoices already created'); process.exit(1); }
d.exec(`PRAGMA foreign_keys=OFF; DROP TRIGGER IF EXISTS event_log_no_update; DROP TRIGGER IF EXISTS event_log_no_delete;
  UPDATE rent_period SET id = id + 1000; UPDATE event_log SET rent_period_id = rent_period_id + 1000 WHERE rent_period_id IS NOT NULL;
  UPDATE payment SET rent_period_id = rent_period_id + 1000; UPDATE plan SET rent_period_id = rent_period_id + 1000;
  UPDATE message SET rent_period_id = rent_period_id + 1000 WHERE rent_period_id IS NOT NULL;`);
console.log(d.prepare('SELECT id, period, due_date, amount_due_cents FROM rent_period').all());
