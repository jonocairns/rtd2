// Start the evalite web UI against the existing SQLite cache without running
// any evals. Useful for browsing history / diffs without spending API credits.
import Database from 'better-sqlite3';
import { createServer } from 'evalite/server';
import { createSqliteStorage } from 'evalite/sqlite-storage';

const DB_LOCATION = './evals/db/runs.sqlite';
const PORT = Number(process.env.EVALITE_PORT ?? 3006);

// Delete any dangling "running" evals (and their dependent rows) left by a
// prior interrupted run — otherwise the UI shows them as spinning forever.
// Storage API has no delete; foreign keys aren't ON DELETE CASCADE here, so
// we walk the relations manually inside a transaction.
function purgeStaleRunningEvals(): number {
  const db = new Database(DB_LOCATION);
  try {
    const findStale = db.prepare(`SELECT id FROM evals WHERE status = 'running'`);
    const staleEvalIds = (findStale.all() as { id: number }[]).map((r) => r.id);
    if (staleEvalIds.length === 0) return 0;

    const placeholders = staleEvalIds.map(() => '?').join(',');
    const findResults = db.prepare(`SELECT id FROM results WHERE eval_id IN (${placeholders})`);
    const resultIds = (findResults.all(...staleEvalIds) as { id: number }[]).map((r) => r.id);

    const tx = db.transaction(() => {
      if (resultIds.length > 0) {
        const ph = resultIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM scores WHERE result_id IN (${ph})`).run(...resultIds);
        db.prepare(`DELETE FROM traces WHERE result_id IN (${ph})`).run(...resultIds);
        db.prepare(`DELETE FROM results WHERE id IN (${ph})`).run(...resultIds);
      }
      db.prepare(`DELETE FROM evals WHERE id IN (${placeholders})`).run(...staleEvalIds);
    });
    tx();
    return staleEvalIds.length;
  } finally {
    db.close();
  }
}

const purged = purgeStaleRunningEvals();
if (purged > 0) {
  console.log(`Deleted ${purged} stale "running" eval(s) from a prior interrupted run.`);
}

const storage = await createSqliteStorage(DB_LOCATION);
const server = createServer({ storage });
server.start(PORT);

console.log(`evalite UI (view-only) → http://localhost:${PORT}`);
console.log(`DB: ${DB_LOCATION}`);
console.log('Run `pnpm eval` to generate fresh runs. Ctrl-C to stop.');
