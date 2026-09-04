import { openDb } from "./db.js";
import { HOUR_MS, DEFAULT_HOLDOUT_ARM_SHARE, AA_HOLDOUT } from "./paths.js";
import { ratifiedGoal, adoptGoal } from "./goals.js";
const AUTONOMY = ["shadow", "human-gated", "auto-merge"];
export function enrollProcess(o) {
    if (!o.id || !/^[a-z0-9][a-z0-9._\/-]{2,80}$/i.test(o.id))
        throw new Error("enroll: --id required (letters/digits/./_/-//, e.g. klaviyo/cart-abandon-01)");
    if (!o.tool)
        throw new Error("enroll: --tool required (where this process lives)");
    if (!o.metric)
        throw new Error("enroll: --metric required (the outcome it is accountable to)");
    const autonomy = o.autonomy ?? "shadow"; // autonomy is earned; everything starts in shadow
    if (!AUTONOMY.includes(autonomy))
        throw new Error(`enroll: --autonomy must be one of ${AUTONOMY.join("|")}`);
    const policy = {};
    if (o.guardrails?.length)
        policy.guardrails = o.guardrails;
    if (o.blastRadius)
        policy.blast_radius = o.blastRadius;
    const db = openDb();
    try {
        db.prepare("INSERT INTO processes (id, tool, metric, inverse, autonomy, status, policy, created_at) VALUES (?,?,?,?,?, 'running', ?, ?)").run(o.id, o.tool, o.metric, o.inverse ? 1 : 0, autonomy, JSON.stringify(policy), Date.now());
    }
    catch (e) {
        if (String(e).includes("UNIQUE"))
            throw new Error(`enroll: ${o.id} is already enrolled`);
        throw e;
    }
    // --metric on enroll IS a deliberate human choice of north star, so it is
    // ratified as one — with a ledger record — rather than left implicit.
    const g = adoptGoal(o.id, o.metric, o.inverse ? 1 : 0, o.guardrails ?? [], "Specified by the operator at enroll.");
    return `enrolled ${o.id} (${o.tool}, goal: ${o.metric}${o.inverse ? " 1/x" : ""} -> ${g}, autonomy: ${autonomy})`;
}
export function startExperiment(processId, field, control, variant, days = 7, status = "running", share, object, baseline, baselineUnit) {
    if (!field || !control || !variant)
        throw new Error("start: --field, --control, and --variant are required");
    if (!(days >= 1 && days <= 28))
        throw new Error("start: --days must be 1..28");
    if (share != null && !(share > 0 && share < 1))
        throw new Error("start: --share must be between 0 and 1 (variant's share of traffic)");
    const db = openDb();
    const proc = db.prepare("SELECT * FROM processes WHERE id = ?").get(processId);
    if (!proc)
        throw new Error(`start: no such process: ${processId} (enroll it first)`);
    const running = db.prepare("SELECT id FROM experiments WHERE process_id = ? AND status IN ('running','launching')").get(processId);
    if (running)
        throw new Error(`start: ${processId} already has a running experiment (${running.id}) — one at a time`);
    const short = processId.split("/").pop() ?? processId;
    const d = new Date();
    const stamp = String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0") + String(d.getFullYear() % 100);
    let id = `${short}/${stamp}`;
    let n = 2;
    while (db.prepare("SELECT 1 FROM experiments WHERE id = ?").get(id))
        id = `${short}/${stamp}-${n++}`;
    const now = Date.now();
    // An experiment is bound to the goal it started under, so re-goaling the
    // connector mid-flight cannot retroactively change what this run was for.
    // No goal means there is nothing for the run to be measured against.
    const goal = ratifiedGoal(processId);
    if (!goal)
        throw new Error(`start: ${processId} has no ratified goal — run \`openxpli goals ${processId}\` and ratify one first`);
    // The holdout arm is v(current--): the configuration in force before the last
    // ADOPTED change on this goal. A predecessor that lost, or won but was never
    // merged, moved nothing — so there is nothing to hold back and the experiment
    // runs on two arms. The first experiment under a goal is always two-armed.
    const prev = db.prepare(`SELECT e.field, e.control_value FROM outcomes o JOIN experiments e ON e.id = o.experiment_id
     WHERE o.process_id = ? AND o.goal_id = ? AND o.review_state = 'merged'
     ORDER BY e.ends_at DESC LIMIT 1`).get(processId, goal.id);
    const policy = JSON.parse(proc.policy || "{}");
    // No adopted predecessor: the holdout arm runs A/A against control instead of
    // being dropped, so every experiment carries one and the measurement gets
    // checked on every cycle.
    const aa = !prev && AA_HOLDOUT;
    const hShare = (prev || aa) ? (typeof policy.holdout_share === "number" ? policy.holdout_share : DEFAULT_HOLDOUT_ARM_SHARE) : 0;
    if (hShare < 0 || hShare >= 1)
        throw new Error("start: policy.holdout_share must be between 0 and 1");
    // Undeclared variant share splits whatever the holdout arm leaves, evenly —
    // so a three-armed run is 20/40/40 and a two-armed one is 50/50.
    const vShare = share ?? (1 - hShare) / 2;
    if (hShare + vShare >= 1)
        throw new Error(`start: holdout ${hShare} + variant ${vShare} leaves nothing for control`);
    db.prepare(`INSERT INTO experiments (id, process_id, field, control_value, variant_value, started_at, ends_at, status,
       goal_id, share, holdout_field, holdout_value, holdout_share, object, baseline, baseline_unit)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, processId, field, control, variant, now, now + days * 24 * HOUR_MS, status, goal.id, vShare, prev ? prev.field : (aa ? field : null), prev ? prev.control_value : (aa ? control : null), hShare || null, object?.trim() || null, baseline ?? null, baselineUnit ?? null);
    const arms = prev
        ? `3 arms — holdout ${Math.round(hShare * 100)}% (${prev.field}: ${prev.control_value}), control ${Math.round((1 - hShare - vShare) * 100)}%, variant ${Math.round(vShare * 100)}%`
        : aa
            ? `3 arms — holdout ${Math.round(hShare * 100)}% A/A (nothing adopted yet, so it re-tests the measurement), control ${Math.round((1 - hShare - vShare) * 100)}%, variant ${Math.round(vShare * 100)}%`
            : `2 arms — control ${Math.round((1 - vShare) * 100)}%, variant ${Math.round(vShare * 100)}%`;
    return `started ${id}${object ? ` on “${object}”` : ""}: ${field}: ${control} -> ${variant} (${days}d run; ${arms})`;
}
