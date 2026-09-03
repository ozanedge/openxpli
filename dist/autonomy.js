import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { LEDGER_DIR } from "./paths.js";
import { scout, listCandidates, acceptCandidate } from "./scout.js";
import { approve } from "./review.js";
// The autonomy ladder is earned, then explicitly enabled by a human:
//   human-gated -> auto-start (may start its own experiments)
//               -> auto-merge (fully autonomous: starts, merges winners, iterates)
export const AUTO_START_WINS = Number(process.env.OPENXPLI_AUTOSTART_WINS ?? 2);
export const AUTO_MERGE_WINS = Number(process.env.OPENXPLI_AUTOMERGE_WINS ?? 4);
export function autonomyStats(processId) {
    const db = openDb();
    const wins = db.prepare("SELECT COUNT(*) c FROM experiments WHERE process_id = ? AND status = 'won'").get(processId).c;
    const validated = db.prepare("SELECT COUNT(*) c FROM holdouts WHERE process_id = ? AND status = 'validated'").get(processId).c;
    const regressed = db.prepare("SELECT COUNT(*) c FROM holdouts WHERE process_id = ? AND status = 'regressed'").get(processId).c;
    return {
        wins, validated, regressed,
        autoStartAt: AUTO_START_WINS, autoMergeAt: AUTO_MERGE_WINS,
        eligibleStart: wins >= AUTO_START_WINS && regressed === 0,
        eligibleMerge: wins >= AUTO_MERGE_WINS && validated >= 1 && regressed === 0,
    };
}
const LEVELS = ["shadow", "human-gated", "auto-start", "auto-merge"];
export function setAutonomy(processId, level) {
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
// Called from every harvest: connectors with earned-and-enabled autonomy act.
export function runAutonomy() {
    const db = openDb();
    const procs = db.prepare("SELECT * FROM processes WHERE autonomy IN ('auto-start','auto-merge') AND status != 'reverted'").all();
    for (const p of procs) {
        // Fully autonomous: merge this connector's open winning records first.
        if (p.autonomy === "auto-merge") {
            const wonExps = db.prepare("SELECT * FROM experiments WHERE process_id = ? AND status = 'won' AND record_id IS NOT NULL").all(p.id);
            for (const e of wonExps) {
                const path = join(LEDGER_DIR, `${e.record_id}.md`);
                if (existsSync(path) && readFileSync(path, "utf8").includes("open (awaiting review)")) {
                    try {
                        console.log(`autonomy: auto-merged ${e.record_id} (${p.id}) — ${approve(e.record_id)}`);
                    }
                    catch { /* raced or already resolved */ }
                }
            }
        }
        // Both levels: keep the loop turning — start the next best candidate.
        const running = db.prepare("SELECT 1 FROM experiments WHERE process_id = ? AND status = 'running'").get(p.id);
        if (running)
            continue;
        let cands = listCandidates(p.id);
        if (!cands.length) {
            scout(p.id);
            cands = listCandidates(p.id);
        }
        if (!cands.length)
            continue;
        const best = cands.slice().sort((a, b) => b.expected_multiple - a.expected_multiple)[0];
        try {
            console.log(`autonomy: auto-started (${p.autonomy}) — ${acceptCandidate(best.id)}`);
        }
        catch { /* invariant raced */ }
    }
}
