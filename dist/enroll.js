import { openDb } from "./db.js";
import { HOUR_MS } from "./paths.js";
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
    return `enrolled ${o.id} (${o.tool}, metric: ${o.metric}${o.inverse ? " 1/x" : ""}, autonomy: ${autonomy})`;
}
export function startExperiment(processId, field, control, variant, days = 7, status = "running") {
    if (!field || !control || !variant)
        throw new Error("start: --field, --control, and --variant are required");
    if (!(days >= 1 && days <= 28))
        throw new Error("start: --days must be 1..28");
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
    db.prepare("INSERT INTO experiments (id, process_id, field, control_value, variant_value, started_at, ends_at, status) VALUES (?,?,?,?,?,?,?,?)").run(id, processId, field, control, variant, now, now + days * 24 * HOUR_MS, status);
    return `started ${id}: ${field}: ${control} -> ${variant} (${days}d run; first reads on next harvest)`;
}
