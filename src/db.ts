import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./paths.js";

export interface ProcessRow {
  id: string;
  tool: string;
  metric: string;
  inverse: number; // 1 = lower-is-better metric, plotted/scored as 1/x
  autonomy: "shadow" | "human-gated" | "auto-start" | "auto-merge";
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
  goal_id: string | null; // the goal this experiment was started under
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

export interface GoalRow {
  id: string;
  source_id: string;
  metric: string;
  inverse: number; // 1 = lower-is-better north star, scored as 1/x
  guardrails: string; // JSON: [{metric, direction}] — declared, must not regress
  rationale: string;
  status: "proposed" | "ratified" | "superseded" | "dismissed";
  record_id: string | null; // ledger record for the ratification
  created_at: number;
  ratified_at: number | null;
}

// An experiment's outcome has a life after the run ends: a verdict, a written
// record, a human review, and a trailing holdout that can still overturn it.
// That lifecycle used to live in three places at once — two columns on
// experiments, a row in holdouts, and a status line inside a markdown file that
// runAutonomy string-matched to decide what to merge. It gets a row.
export interface OutcomeRow {
  experiment_id: string;
  process_id: string;
  goal_id: string | null;   // what this run was measured against
  verdict: "won" | "failed";
  final_multiple: number | null;
  record_id: string | null; // the ledger narrative for this outcome
  review_state: "open" | "merged" | "rejected" | "reopened" | "auto-reverted";
  reviewed_at: number | null;
  holdout_state: "none" | "validating" | "validated" | "regressed" | "cancelled";
  holdout_multiple: number | null;
  decided_at: number;
}

export interface Guardrail {
  metric: string;
  direction: "must-not-drop" | "must-not-rise";
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

function ensureColumn(db: Database.Database, table: string, col: string, ddl: string): void {
  const cols = db.pragma(`table_info(${table})`) as { name: string }[];
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
