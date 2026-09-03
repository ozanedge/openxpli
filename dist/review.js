import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { openDb } from "./db.js";
import { LEDGER_DIR, HOUR_MS } from "./paths.js";
// The three review verbs from the design (plus kill). The ledger file is the
// source of truth for record state; every mutation is a git commit.
function git(args) {
    execFileSync("git", ["-C", LEDGER_DIR, ...args], { encoding: "utf8" });
}
function mutateRecord(recordId, newStatus, note, commitMsg) {
    const path = join(LEDGER_DIR, `${recordId}.md`);
    if (!existsSync(path))
        throw new Error(`no such record: ${recordId}`);
    let body = readFileSync(path, "utf8");
    if (!body.includes("open (awaiting review)") && !body.includes("reopened"))
        throw new Error(`${recordId} is not open for review`);
    body = body.replace(/- \*\*status:\*\* .*/, `- **status:** ${newStatus}`);
    body += `\n## Resolution\n${note} — ${new Date().toISOString()}\n`;
    writeFileSync(path, body);
    git(["add", "-A"]);
    git(["commit", "-qm", commitMsg]);
}
function expForRecord(recordId) {
    const db = openDb();
    const exp = db.prepare("SELECT * FROM experiments WHERE record_id = ?").get(recordId);
    if (!exp)
        throw new Error(`no experiment linked to ${recordId}`);
    return exp;
}
export function approve(recordId) {
    const exp = expForRecord(recordId);
    mutateRecord(recordId, "merged", "Approved & merged. The variant is the new control; the trailing holdout continues to validate.", `${recordId}: approved & merged`);
    return `approved ${recordId} (${exp.id}) — variant merged; holdout continues`;
}
export function reject(recordId) {
    const exp = expForRecord(recordId);
    const db = openDb();
    db.prepare("UPDATE holdouts SET status = 'cancelled' WHERE experiment_id = ? AND status = 'validating'").run(exp.id);
    mutateRecord(recordId, "rejected", "Rejected by reviewer. Variant not adopted; control unchanged; holdout cancelled.", `${recordId}: rejected`);
    return `rejected ${recordId} (${exp.id}) — control unchanged, holdout cancelled`;
}
export function extend(experimentId, days) {
    if (!(days > 0 && days <= 28))
        throw new Error("extend: days must be 1..28");
    const db = openDb();
    const exp = db.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId);
    if (!exp)
        throw new Error(`no such experiment: ${experimentId}`);
    if (exp.status === "running") {
        db.prepare("UPDATE experiments SET ends_at = ends_at + ? WHERE id = ?").run(days * 24 * HOUR_MS, experimentId);
        return `extended ${experimentId} by ${days}d (still running)`;
    }
    // Post-run "Request more runtime" on an open record: reopen the experiment.
    if (!exp.record_id)
        throw new Error(`${experimentId} is ${exp.status} with no record`);
    const db2 = openDb();
    db2.prepare("UPDATE holdouts SET status = 'cancelled' WHERE experiment_id = ? AND status = 'validating'").run(exp.id);
    db2.prepare("UPDATE experiments SET status = 'running', final_multiple = NULL, ends_at = ? WHERE id = ?")
        .run(Date.now() + days * 24 * HOUR_MS, experimentId);
    mutateRecord(exp.record_id, "reopened (more runtime granted)", `Reviewer requested ${days} more days of runtime; decision deferred.`, `${exp.record_id}: more runtime granted`);
    return `reopened ${experimentId} for ${days}d more; ${exp.record_id} marked reopened`;
}
export function kill(experimentId) {
    const db = openDb();
    const exp = db.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId);
    if (!exp)
        throw new Error(`no such experiment: ${experimentId}`);
    if (exp.status !== "running")
        throw new Error(`${experimentId} is not running`);
    const last = db.prepare("SELECT multiple FROM observations WHERE experiment_id = ? AND missing = 0 ORDER BY hour DESC LIMIT 1").get(experimentId);
    // Killed = failed by operator decision, regardless of where it stood.
    db.prepare("UPDATE experiments SET status = 'failed', final_multiple = ?, ends_at = ? WHERE id = ?")
        .run(last?.multiple ?? 1.0, Date.now(), experimentId);
    return `killed ${experimentId} at ${(last?.multiple ?? 1).toFixed(3)}x — variant reverted (record on next harvest)`;
}
