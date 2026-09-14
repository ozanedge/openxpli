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
    // For a lower-is-better metric the multiple is a reduction, so the absolute
    // value divides rather than multiplies. Getting this backwards would show a
    // CPC win as a cost increase.
    const inv = !!e.baseline_inverse;
    const raw = (m) => (base != null && m != null ? (inv ? base / m : base * m) : null);
    const v = e.share ?? DEFAULT_VARIANT_SHARE;
    const h = e.holdout_share ?? 0;
    const isAA = e.holdout_field === e.field && e.holdout_value === e.control_value;
    const variant = {
        key: "variant", label: "variant", share: v, shareExact: e.share != null,
        diff: { field: e.field, from: e.control_value, to: e.variant_value },
        verb: "testing", note: "v(current++)",
        multiple: last?.multiple ?? null, raw: raw(last?.multiple ?? null), unit,
    };
    const control = {
        key: "control", label: "control", share: 1 - v - h, shareExact: e.share != null,
        diff: null, verb: "live", note: "v(current) — every adopted change, unmodified",
        multiple: 1, raw: base ?? null, unit,
    };
    const holdout = (h > 0 && e.holdout_field)
        ? {
            key: "holdout", label: "holdout", share: h, shareExact: true,
            diff: isAA ? null : {
                field: e.holdout_field,
                from: promoted.get(e.holdout_field) ?? e.holdout_value ?? "",
                to: e.holdout_value ?? "",
            },
            verb: isAA ? "A/A" : "rolled back",
            note: isAA
                ? "Identical to control. Nothing adopted yet, so this arm re-tests the measurement: it should read ×1.00."
                : `The configuration before \`${e.holdout_field}\` was adopted. If this arm wins, that change is reverted.`,
            multiple: last?.holdout_multiple ?? null, raw: raw(last?.holdout_multiple ?? null), unit,
        }
        : {
            key: "holdout", label: "holdout", share: 0, shareExact: true,
            diff: null, verb: "none",
            note: "No holdout arm — this experiment predates the three-arm model.",
            multiple: null, raw: null, unit, absent: true,
        };
    const arms = [variant, control, holdout];
    return arms;
}
