import { openDb } from "./db.js";
import { DEFAULT_VARIANT_SHARE } from "./paths.js";
export function splitFor(experimentId) {
    const db = openDb();
    const e = db.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId);
    if (!e || (e.status !== "running" && e.status !== "launching"))
        return [];
    // Values already adopted on this goal: they ride along in every arm.
    const merged = db.prepare(`SELECT en.field, en.variant_value FROM outcomes o JOIN experiments en ON en.id = o.experiment_id
     WHERE o.process_id = ? AND o.goal_id IS ? AND o.review_state = 'merged' ORDER BY en.ends_at`).all(e.process_id, e.goal_id);
    const promoted = new Map();
    for (const m of merged)
        promoted.set(m.field, m.variant_value);
    // Latest reading: the variant and holdout ratios are both measured against
    // control, which is the x1.00 reference by construction.
    const last = db.prepare("SELECT multiple, holdout_multiple FROM observations WHERE experiment_id = ? AND missing = 0 ORDER BY hour DESC LIMIT 1").get(experimentId);
    const base = e.baseline;
    const unit = e.baseline_unit ?? null;
    const raw = (m) => (base != null && m != null ? base * m : null);
    const v = e.share ?? DEFAULT_VARIANT_SHARE;
    const h = e.holdout_share ?? 0;
    const inherited = (skip) => [...promoted].filter(([f]) => !skip.includes(f)).map(([field, value]) => ({ field, value, inherited: true }));
    const isAA = e.holdout_field === e.field && e.holdout_value === e.control_value;
    const arms = [];
    if (h > 0 && e.holdout_field) {
        arms.push({
            key: "holdout", label: "holdout", share: h, shareExact: true,
            config: isAA
                ? [...inherited([e.field]), { field: e.field, value: e.control_value }]
                : [
                    { field: e.holdout_field, value: e.holdout_value ?? "" },
                    ...inherited([e.holdout_field, e.field]),
                    { field: e.field, value: e.control_value },
                ],
            note: isAA
                ? "A/A — identical to control. Nothing has been adopted yet, so this arm re-tests the measurement: it should read ×1.00."
                : `v(current--) — the configuration before \`${e.holdout_field}\` was adopted. If this arm wins, that change is reverted.`,
            multiple: last?.holdout_multiple ?? null, raw: raw(last?.holdout_multiple ?? null), unit,
        });
    }
    arms.push({
        key: "control", label: "control", share: 1 - v - h, shareExact: e.share != null,
        config: [...inherited([e.field]), { field: e.field, value: e.control_value }],
        note: "v(current) — what is live today",
        multiple: 1, raw: base ?? null, unit,
    });
    arms.push({
        key: "variant", label: "variant", share: v, shareExact: e.share != null,
        config: [...inherited([e.field]), { field: e.field, value: e.variant_value }],
        note: "v(current++) — the change under test",
        multiple: last?.multiple ?? null, raw: raw(last?.multiple ?? null), unit,
    });
    return arms;
}
