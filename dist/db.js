import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";
export function openDb() {
    ensureDirs();
    const db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS processes (
      id TEXT PRIMARY KEY, tool TEXT NOT NULL, metric TEXT NOT NULL,
      inverse INTEGER NOT NULL DEFAULT 0,
      autonomy TEXT NOT NULL DEFAULT 'shadow',
      status TEXT NOT NULL DEFAULT 'running',
      policy TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY, process_id TEXT NOT NULL REFERENCES processes(id),
      field TEXT NOT NULL, control_value TEXT NOT NULL, variant_value TEXT NOT NULL,
      started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      final_multiple REAL
    );
    CREATE TABLE IF NOT EXISTS observations (
      experiment_id TEXT NOT NULL REFERENCES experiments(id),
      hour INTEGER NOT NULL, ts INTEGER NOT NULL,
      multiple REAL, sigma REAL,
      source TEXT NOT NULL, missing INTEGER NOT NULL DEFAULT 0,
      phase TEXT NOT NULL DEFAULT 'run',
      PRIMARY KEY (experiment_id, hour)
    );
    CREATE TABLE IF NOT EXISTS holdouts (
      experiment_id TEXT PRIMARY KEY REFERENCES experiments(id),
      process_id TEXT NOT NULL REFERENCES processes(id),
      started_at INTEGER NOT NULL, ends_at INTEGER NOT NULL,
      share REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'validating',
      final_multiple REAL
    );
  `);
    // A goal is the north star a connector is accountable to. It is proposed by
    // the scout, ratified by a human, ledgered, and outlives every experiment
    // run beneath it — an experiment can never redefine what winning means.
    db.exec(`
    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES processes(id),
      metric TEXT NOT NULL, inverse INTEGER NOT NULL DEFAULT 0,
      guardrails TEXT NOT NULL DEFAULT '[]',
      rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed',
      record_id TEXT, created_at INTEGER NOT NULL, ratified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS goals_by_source ON goals (source_id, status);
    CREATE TABLE IF NOT EXISTS outcomes (
      experiment_id TEXT PRIMARY KEY REFERENCES experiments(id),
      process_id TEXT NOT NULL REFERENCES processes(id),
      goal_id TEXT,
      verdict TEXT NOT NULL,
      final_multiple REAL,
      record_id TEXT,
      review_state TEXT NOT NULL DEFAULT 'open',
      reviewed_at INTEGER,
      holdout_state TEXT NOT NULL DEFAULT 'none',
      holdout_multiple REAL,
      decided_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outcomes_by_goal ON outcomes (goal_id, verdict);
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES processes(id),
      field TEXT NOT NULL, control_value TEXT NOT NULL, variant_value TEXT NOT NULL,
      metric TEXT NOT NULL, inverse INTEGER NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL, expected_multiple REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL
    );`);
    db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge (
      source_id TEXT NOT NULL REFERENCES processes(id),
      key TEXT NOT NULL, kind TEXT NOT NULL,
      content TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, key)
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS kits (
    id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL UNIQUE REFERENCES candidates(id),
    process_id TEXT NOT NULL REFERENCES processes(id), goal_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued', content TEXT, image BLOB, error TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    launched_at INTEGER, launch_note TEXT
  );`);
    db.exec(`CREATE TABLE IF NOT EXISTS browser_requests (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
    pid INTEGER NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS learning_jobs (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES processes(id),
    kind TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', pid INTEGER,
    continue_requested INTEGER NOT NULL DEFAULT 0, cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS one_learning_job_per_connector ON learning_jobs(source_id)
    WHERE status IN ('queued','running');`);
    ensureColumn(db, "candidates", "evidence", "TEXT");
    // Preserve links from older launch tracking; new reports do not create runs.
    ensureColumn(db, "kits", "experiment_id", "TEXT");
    // In-place upgrades for databases created by older versions.
    ensureColumn(db, "observations", "phase", "TEXT NOT NULL DEFAULT 'run'");
    ensureColumn(db, "experiments", "record_id", "TEXT");
    ensureColumn(db, "experiments", "launch_note", "TEXT");
    ensureColumn(db, "experiments", "goal_id", "TEXT");
    ensureColumn(db, "experiments", "share", "REAL");
    ensureColumn(db, "experiments", "holdout_field", "TEXT");
    ensureColumn(db, "experiments", "holdout_value", "TEXT");
    ensureColumn(db, "experiments", "holdout_share", "REAL");
    ensureColumn(db, "experiments", "object", "TEXT");
    ensureColumn(db, "experiments", "baseline", "REAL");
    ensureColumn(db, "experiments", "baseline_unit", "TEXT");
    ensureColumn(db, "experiments", "baseline_inverse", "INTEGER");
    ensureColumn(db, "experiments", "value_basis", "REAL");
    ensureColumn(db, "experiments", "power", "TEXT");
    ensureColumn(db, "candidates", "power", "TEXT");
    ensureColumn(db, "candidates", "run_hours", "INTEGER");
    ensureColumn(db, "observations", "holdout_multiple", "REAL");
    ensureColumn(db, "outcomes", "winner", "TEXT");
    return db;
}
function ensureColumn(db, table, col, ddl) {
    const cols = db.pragma(`table_info(${table})`);
    if (!cols.some((c) => c.name === col))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
