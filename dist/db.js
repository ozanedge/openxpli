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
    return db;
}
function ensureColumn(db, table, col, ddl) {
    const cols = db.pragma(`table_info(${table})`);
    if (!cols.some((c) => c.name === col))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
