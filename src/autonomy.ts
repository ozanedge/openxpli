import { openDb, type ProcessRow } from "./db.js";
import { openOutcomes } from "./outcomes.js";
import { scout, listCandidates, acceptCandidate } from "./scout.js";
import { approve } from "./review.js";
import { ratifiedGoal } from "./goals.js";

// The autonomy ladder is earned, then explicitly enabled by a human:
//   human-gated -> auto-start (may start its own experiments)
//               -> auto-merge (fully autonomous: starts, merges winners, iterates)
export const AUTO_START_WINS = Number(process.env.OPENXPLI_AUTOSTART_WINS ?? 2);
export const AUTO_MERGE_WINS = Number(process.env.OPENXPLI_AUTOMERGE_WINS ?? 4);

export interface AutonomyStats {
  wins: number;
  validated: number;
  regressed: number;
  autoStartAt: number;
  autoMergeAt: number;
  eligibleStart: boolean;
  eligibleMerge: boolean;
  goalId: string | null;
  goalMetric: string | null;
}

export function autonomyStats(processId: string): AutonomyStats {
  const db = openDb();
  // Autonomy is earned against the CURRENT goal. Counting every win a connector
  // ever had makes the reset-on-re-goal cosmetic: wins measured against an
  // abandoned metric would instantly re-qualify it.
  const goal = ratifiedGoal(processId);
  const gid = goal?.id ?? "\u0000none";
  const one = (sql: string) => (db.prepare(sql).get(processId, gid) as { c: number }).c;
  const wins = one("SELECT COUNT(*) c FROM outcomes WHERE process_id = ? AND goal_id = ? AND verdict = 'won'");
  const validated = one("SELECT COUNT(*) c FROM outcomes WHERE process_id = ? AND goal_id = ? AND holdout_state = 'validated'");
  const regressed = one("SELECT COUNT(*) c FROM outcomes WHERE process_id = ? AND goal_id = ? AND holdout_state = 'regressed'");
  return {
    wins, validated, regressed, goalId: goal?.id ?? null, goalMetric: goal?.metric ?? null,
    autoStartAt: AUTO_START_WINS, autoMergeAt: AUTO_MERGE_WINS,
    eligibleStart: wins >= AUTO_START_WINS && regressed === 0,
    eligibleMerge: wins >= AUTO_MERGE_WINS && validated >= 1 && regressed === 0,
  };
}

const LEVELS = ["shadow", "human-gated", "auto-start", "auto-merge"];

export function setAutonomy(processId: string, level: string): string {
  if (!LEVELS.includes(level)) throw new Error(`autonomy: level must be one of ${LEVELS.join("|")}`);
  const db = openDb();
  const p = db.prepare("SELECT * FROM processes WHERE id = ?").get(processId) as ProcessRow | undefined;
  if (!p) throw new Error(`autonomy: no such connector: ${processId}`);
  const from = LEVELS.indexOf(p.autonomy), to = LEVELS.indexOf(level);
  if (to > from) {
    const s = autonomyStats(processId);
    if (level === "auto-start" && !s.eligibleStart)
      throw new Error(`autonomy: not earned yet — ${s.wins}/${s.autoStartAt} wins (and 0 regressions) required for self-starting`);
    if (level === "auto-merge" && !s.eligibleMerge)
      throw new Error(`autonomy: not earned yet — ${s.wins}/${s.autoMergeAt} wins, ≥1 validated holdout, 0 regressions required for full autonomy`);
  }
  db.prepare("UPDATE processes SET autonomy = ? WHERE id = ?").run(level, processId);
  return to > from
    ? `${processId} promoted to ${level} — earned: ${autonomyStats(processId).wins} wins, 0 regressions`
    : `${processId} dialed down to ${level}`;
}

// Called from every harvest: connectors with earned-and-enabled autonomy act.
export function runAutonomy(): void {
  const db = openDb();
  const procs = db.prepare(
    "SELECT * FROM processes WHERE autonomy IN ('auto-start','auto-merge') AND status != 'reverted'"
  ).all() as ProcessRow[];

  for (const p of procs) {
    // No north star, no autonomy. A self-starting connector without a ratified
    // goal would pick whichever candidate it thinks it can move most and call
    // that winning — the exact failure goals exist to prevent.
    if (!ratifiedGoal(p.id)) {
      console.log(`autonomy: ${p.id} has no ratified goal — skipping (ratify one to resume)`);
      continue;
    }
    // Fully autonomous: merge this connector's open winning records first.
    if (p.autonomy === "auto-merge") {
      for (const o of openOutcomes(p.id)) {
        if (!o.record_id) continue;
        try { console.log(`autonomy: auto-merged ${o.record_id} (${p.id}) — ${approve(o.record_id)}`); }
        catch { /* raced or already resolved */ }
      }
    }
    // Both levels: keep the loop turning — start the next best candidate.
    const running = db.prepare(
      "SELECT 1 FROM experiments WHERE process_id = ? AND status = 'running'"
    ).get(p.id);
    if (running) continue;
    let cands = listCandidates(p.id);
    if (!cands.length) { scout(p.id); cands = listCandidates(p.id); }
    // Only candidates that measure the goal are eligible; ranking by expected
    // multiple across mixed metrics is how metric-shopping starts.
    cands = cands.filter((c) => c.metric === p.metric && c.inverse === p.inverse);
    if (!cands.length) continue;
    const best = cands.slice().sort((a, b) => b.expected_multiple - a.expected_multiple)[0];
    try { console.log(`autonomy: auto-started (${p.autonomy}) — ${acceptCandidate(best.id)}`); }
    catch { /* invariant raced */ }
  }
}
