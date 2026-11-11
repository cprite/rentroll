// Sprint 4 test helper: shift rent_period ids of a freshly seeded TEST DB by +940 (1,2,3 -> 941,942,943), for the
// same reason as sprint3-testdb.mjs: the live service gets every sandbox webhook and matches custom_id "RR:rp<id>".
// Also: `node scripts/sprint4-testdb.mjs <db> stale <rpId>` overwrites the CACHED paid/status columns of one period
// with UNPAID/0 to simulate a stale "still overdue" flag (payments are untouched).
import { DatabaseSync } from 'node:sqlite';
const [file, cmd, arg] = process.argv.slice(2);
if (!file || /data\/rentroll\.db$/.test(file)) { console.error('refusing: pass a TEST db path'); process.exit(1); }
const d = new DatabaseSync(file);
if (cmd === 'stale') {
  d.prepare("UPDATE rent_period SET status='UNPAID', amount_paid_cents=0 WHERE id=?").run(Number(arg));
  console.log('cached columns now:', d.prepare('SELECT id, status, amount_paid_cents FROM rent_period WHERE id=?').get(Number(arg)),
    '| COMPLETED payments:', d.prepare("SELECT COALESCE(SUM(amount_cents),0) s, COUNT(*) n FROM payment WHERE rent_period_id=? AND status='COMPLETED'").get(Number(arg)));
} else {
  d.exec(`PRAGMA foreign_keys=OFF; DROP TRIGGER IF EXISTS event_log_no_update; DROP TRIGGER IF EXISTS event_log_no_delete;
    UPDATE rent_period SET id = id + 940; UPDATE event_log SET rent_period_id = rent_period_id + 940 WHERE rent_period_id IS NOT NULL;
    UPDATE payment SET rent_period_id = rent_period_id + 940; UPDATE plan SET rent_period_id = rent_period_id + 940;
    UPDATE message SET rent_period_id = rent_period_id + 940 WHERE rent_period_id IS NOT NULL;`);
  console.log(d.prepare('SELECT id, period, due_date, amount_due_cents FROM rent_period').all());
}
