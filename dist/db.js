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
    // In-place upgrades for databases created by older versions.
    ensureColumn(db, "observations", "phase", "TEXT NOT NULL DEFAULT 'run'");
    ensureColumn(db, "experiments", "record_id", "TEXT");
    ensureColumn(db, "experiments", "launch_note", "TEXT");
    ensureColumn(db, "experiments", "goal_id", "TEXT");
    return db;
}
function ensureColumn(db, table, col, ddl) {
    const cols = db.pragma(`table_info(${table})`);
    if (!cols.some((c) => c.name === col))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
