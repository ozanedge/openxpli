import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";

export interface ProcessRow {
  id: string;
  tool: string;
  metric: string;
  inverse: number; // 1 = lower-is-better metric, plotted/scored as 1/x
  autonomy: "shadow" | "human-gated" | "auto-merge";
  status: string;
  policy: string; // JSON: caps, guardrails
  created_at: number;
}

export interface ExperimentRow {
  id: string;
  process_id: string;
  field: string;
  control_value: string;
  variant_value: string;
  started_at: number;
  ends_at: number;
  status: "running" | "won" | "failed";
  final_multiple: number | null;
  record_id: string | null;
}

export interface ObservationRow {
  experiment_id: string;
  hour: number; // run: 1..168; holdout: continues 169..(168+VALIDATION_HOURS)
  ts: number;
  multiple: number | null; // cumulative multiple vs control; null when missing
  sigma: number | null;
  source: string; // binding that produced it: api | cli | browser | synthetic
  missing: number; // 1 = unfillable gap, recorded honestly
  phase: string; // 'run' | 'holdout'
}

export interface HoldoutRow {
  experiment_id: string;
  process_id: string;
  started_at: number;
  ends_at: number;
  share: number; // fraction of traffic kept on the old control
  status: "validating" | "validated" | "regressed";
  final_multiple: number | null; // promoted variant vs holdout at exit
}

export function openDb(): Database.Database {
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

function ensureColumn(db: Database.Database, table: string, col: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
