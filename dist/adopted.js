import { openDb } from "./db.js";
import { annualValue } from "./value.js";
export function adoptedState(processId) {
    const db = openDb();
    const proc = db.prepare("SELECT policy FROM processes WHERE id = ?").get(processId);
    const model = proc ? (JSON.parse(proc.policy || "{}").value_model ?? null) : null;
    // Every variant that was ever adopted, newest last.
    const adoptions = db.prepare(`SELECT e.id, e.field, e.object, e.status, e.variant_value, e.ends_at, e.value_basis, o.final_multiple, o.record_id,
            o.review_state, o.holdout_state, g.metric AS goal_metric, g.inverse AS goal_inverse
     FROM outcomes o JOIN experiments e ON e.id = o.experiment_id
     LEFT JOIN goals g ON g.id = o.goal_id
     WHERE o.process_id = ? AND o.winner = 'variant' ORDER BY e.ends_at, e.id`).all(processId);
    // Holdout wins, so a reverted adoption can name what beat it. The link is
    // inferred from field + time until experiments record a parent id.
    const reverts = db.prepare(`SELECT e.id, e.holdout_field, e.ends_at FROM outcomes o JOIN experiments e ON e.id = o.experiment_id
     WHERE o.process_id = ? AND o.winner = 'holdout' ORDER BY e.ends_at, e.id`).all(processId);
    const latestLivePerField = new Map();
    const scope = (a) => JSON.stringify([a.object, a.field]);
    for (const a of adoptions)
        if (a.review_state === "merged")
            latestLivePerField.set(scope(a), a.id);
    const rows = adoptions.map((a) => {
        const superseded = a.review_state === "merged" && latestLivePerField.get(scope(a)) !== a.id
            ? latestLivePerField.get(scope(a)) : null;
        const live = a.review_state === "merged" && !superseded && a.holdout_state !== "regressed" && a.status === "won";
        const pending = a.review_state === "open" && a.status === "won";
        const av = annualValue("variant", a.final_multiple, null, a.goal_metric ? { metric: a.goal_metric, inverse: a.goal_inverse ?? 0 } : null, model, a.value_basis);
        return {
            field: a.field, value: a.variant_value, experiment_id: a.id, record_id: a.record_id,
            multiple: a.final_multiple, ends_at: a.ends_at,
            state: (live ? "live" : pending ? "pending" : "historical"),
            reverted_by: a.review_state !== "reverted" ? null
                : (reverts.find((r) => r.holdout_field === a.field && r.ends_at > a.ends_at)?.id ?? null),
            superseded_by: superseded,
            value_amount: av.amount, value_kind: av.kind,
        };
    }).reverse();
    return {
        rows,
        activeAnnualValue: rows.filter((r) => r.state === "live").reduce((sum, r) => sum + r.value_amount, 0),
        potentialAnnualValue: rows.filter((r) => r.state === "pending").reduce((sum, r) => sum + r.value_amount, 0),
        historicalDecisions: adoptions.filter((a) => a.review_state === "merged" || a.review_state === "reverted").length + reverts.length,
        liveCount: rows.filter((r) => r.state === "live").length,
    };
}
