// Sprint 3 test helper: shift rent_period ids of a freshly seeded TEST DB by +930 (1,2 -> 931,932).
// Why: the live rentroll.service receives every PayPal webhook for the shared sandbox account and matches
// custom_id "RR:rp<id>:..." by id. Offset ids can't match (or create) rows in the real DB.
// Usage: RENTROLL_DB=$TMPDIR/s3/test.db node server.js --seed --reset && node scripts/sprint3-testdb.mjs $TMPDIR/s3/test.db
import { DatabaseSync } from 'node:sqlite';
const file = process.argv[2];
if (!file || /data\/rentroll\.db$/.test(file)) { console.error('refusing: pass a TEST db path'); process.exit(1); }
const d = new DatabaseSync(file);
d.exec(`PRAGMA foreign_keys=OFF; DROP TRIGGER IF EXISTS event_log_no_update; DROP TRIGGER IF EXISTS event_log_no_delete;
  UPDATE rent_period SET id = id + 930; UPDATE event_log SET rent_period_id = rent_period_id + 930 WHERE rent_period_id IS NOT NULL;
  UPDATE payment SET rent_period_id = rent_period_id + 930; UPDATE plan SET rent_period_id = rent_period_id + 930;
  UPDATE message SET rent_period_id = rent_period_id + 930 WHERE rent_period_id IS NOT NULL;`);
console.log(d.prepare('SELECT id, period, amount_due_cents FROM rent_period').all());
// triggers are recreated by server.js openDb() (CREATE TRIGGER IF NOT EXISTS)
