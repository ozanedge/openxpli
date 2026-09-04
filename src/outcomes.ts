import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDb, type OutcomeRow, type ExperimentRow } from "./db.js";
import { LEDGER_DIR } from "./paths.js";

// The database holds the STATE of an outcome; the ledger holds its NARRATIVE.
// Before this split, review state existed only as the line "- **status:** open
// (awaiting review)" inside a markdown file, and an autonomous merge was gated
// on a substring match against prose.

export function outcomeFor(experimentId: string): OutcomeRow | null {
  return (openDb().prepare("SELECT * FROM outcomes WHERE experiment_id = ?").get(experimentId) as OutcomeRow | undefined) ?? null;
}

export function recordOutcome(exp: ExperimentRow, verdict: "won" | "failed", finalMultiple: number, recordId: string | null): void {
  openDb().prepare(
    `INSERT INTO outcomes (experiment_id, process_id, goal_id, verdict, final_multiple, record_id, review_state, holdout_state, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(experiment_id) DO UPDATE SET
       verdict = excluded.verdict, final_multiple = excluded.final_multiple,
       record_id = excluded.record_id, review_state = excluded.review_state,
       holdout_state = excluded.holdout_state, reviewed_at = NULL, decided_at = excluded.decided_at`
  ).run(
    exp.id, exp.process_id, exp.goal_id, verdict, finalMultiple, recordId,
    // A loss is never adopted, so there is nothing for a human to approve.
    verdict === "won" ? "open" : "auto-reverted",
    verdict === "won" ? "validating" : "none",
    Date.now()
  );
}

export function setReviewState(experimentId: string, state: OutcomeRow["review_state"]): void {
  openDb().prepare("UPDATE outcomes SET review_state = ?, reviewed_at = ? WHERE experiment_id = ?")
    .run(state, Date.now(), experimentId);
}

export function setHoldoutState(experimentId: string, state: OutcomeRow["holdout_state"], multiple: number | null = null): void {
  openDb().prepare("UPDATE outcomes SET holdout_state = ?, holdout_multiple = COALESCE(?, holdout_multiple) WHERE experiment_id = ?")
    .run(state, multiple, experimentId);
}

// Outcomes still waiting on a human. This is what autonomy reads instead of
// grepping the record file.
export function openOutcomes(processId: string): OutcomeRow[] {
  return openDb().prepare(
    "SELECT * FROM outcomes WHERE process_id = ? AND review_state = 'open' AND verdict = 'won' ORDER BY decided_at"
  ).all(processId) as OutcomeRow[];
}

export function outcomeCounts(processId: string): { open: number; validating: number; resolved: number; total: number } {
  const db = openDb();
  const row = db.prepare(
    `SELECT
       SUM(review_state = 'open') AS open,
       SUM(holdout_state = 'validating') AS validating,
       SUM(review_state != 'open' AND holdout_state != 'validating') AS resolved,
       COUNT(*) AS total
     FROM outcomes WHERE process_id = ?`
  ).get(processId) as { open: number | null; validating: number | null; resolved: number | null; total: number };
  return { open: row.open ?? 0, validating: row.validating ?? 0, resolved: row.resolved ?? 0, total: row.total ?? 0 };
}

const REVIEW_FROM_RECORD: [RegExp, OutcomeRow["review_state"]][] = [
  [/^- \*\*status:\*\* *merged/im, "merged"],
  [/^- \*\*status:\*\* *rejected/im, "rejected"],
  [/^- \*\*status:\*\* *reopened/im, "reopened"],
  [/^- \*\*status:\*\* *reverted/im, "auto-reverted"],
  [/^- \*\*status:\*\* *open/im, "open"],
];

// Rebuild outcomes for databases written before the table existed. Review state
// is read out of the record files one final time — that is the last read; from
// here the database is authoritative and the record is narrative.
export function backfillOutcomes(): number {
  const db = openDb();
  const decided = db.prepare(
    "SELECT * FROM experiments WHERE status IN ('won','failed') AND id NOT IN (SELECT experiment_id FROM outcomes)"
  ).all() as ExperimentRow[];
  let n = 0;
  for (const e of decided) {
    let review: OutcomeRow["review_state"] = e.status === "won" ? "open" : "auto-reverted";
    if (e.record_id) {
      const path = join(LEDGER_DIR, `${e.record_id}.md`);
      if (existsSync(path)) {
        const body = readFileSync(path, "utf8");
        for (const [re, state] of REVIEW_FROM_RECORD) if (re.test(body)) { review = state; break; }
      }
    }
    const h = db.prepare("SELECT status, final_multiple FROM holdouts WHERE experiment_id = ?").get(e.id) as
      { status: OutcomeRow["holdout_state"]; final_multiple: number | null } | undefined;
    db.prepare(
      `INSERT INTO outcomes (experiment_id, process_id, goal_id, verdict, final_multiple, record_id, review_state, holdout_state, holdout_multiple, decided_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(e.id, e.process_id, e.goal_id, e.status, e.final_multiple, e.record_id, review,
      h?.status ?? "none", h?.final_multiple ?? null, e.ends_at);
    n++;
  }
  return n;
}

let done = false;
export function ensureOutcomesBackfilled(): void {
  if (done) return;
  done = true;
  const n = backfillOutcomes();
  if (n) console.log(`outcomes: rebuilt ${n} outcome row(s) from experiments, holdouts and record files`);
}
