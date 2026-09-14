import { openDb } from "./db.js";
import { ratifiedGoal } from "./goals.js";
// The autonomy ladder is earned, then explicitly enabled by a human:
//   human-gated -> auto-start (may start its own experiments)
//               -> auto-merge (fully autonomous: starts, merges winners, iterates)
export const AUTO_START_WINS = Number(process.env.OPENXPLI_AUTOSTART_WINS ?? 2);
export const AUTO_MERGE_WINS = Number(process.env.OPENXPLI_AUTOMERGE_WINS ?? 4);
export function autonomyStats(processId) {
    const db = openDb();
    // Autonomy is earned against the CURRENT goal. Counting every win a connector
    // ever had makes the reset-on-re-goal cosmetic: wins measured against an
    // abandoned metric would instantly re-qualify it.
    const goal = ratifiedGoal(processId);
    const gid = goal?.id ?? "\u0000none";
    const one = (sql) => db.prepare(sql).get(processId, gid).c;
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
export function setAutonomy(processId, level) {
    if (level === "auto-start" || level === "auto-merge")
        throw new Error("Autonomy is not available in the manual milestone. Prepare kits and launch experiments yourself first.");
    if (!LEVELS.includes(level))
        throw new Error(`autonomy: level must be one of ${LEVELS.join("|")}`);
    const db = openDb();
    const p = db.prepare("SELECT * FROM processes WHERE id = ?").get(processId);
    if (!p)
        throw new Error(`autonomy: no such connector: ${processId}`);
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
// Legacy hook retained for harvest; execution is disabled in the manual milestone.
export function runAutonomy() {
    // Existing saved autonomy levels cannot bypass the manual milestone.
    // Harvest may observe existing experiments, but cannot prepare, start or merge new ones.
}
