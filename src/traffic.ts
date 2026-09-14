import { openDb, type ExperimentRow } from "./db.js";
import { DEFAULT_VARIANT_SHARE } from "./paths.js";

// What a visitor sees, for ONE experiment. Under the three-arm model a
// connector runs a single experiment at a time and that experiment owns every
// arm — holdout v(current--), control v(current), variant v(current++) — so
// this is both the experiment's split and the whole live traffic picture.
// There is no cross-experiment composition left to assemble.

// An arm differs from control in exactly one field. Showing each arm's whole
// configuration meant repeating every adopted value three times; the only
// information in it was the one line that changed.
export interface ArmDiff {
  field: string;
  from: string;  // what control serves for this field
  to: string;    // what this arm serves instead
}

export interface Arm {
  key: "holdout" | "control" | "variant";
  label: string;
  share: number;
  shareExact: boolean;
  diff: ArmDiff | null;  // null on control — it IS the reference
  verb: string;          // testing | live | re-testing
  note: string;
  multiple: number | null; // vs control, from the latest reading; control is 1.00 by definition
  raw: number | null;      // the absolute metric for this arm: baseline x multiple
  unit: string | null;
  absent?: boolean;        // the slot exists, the arm does not — render N/A, not zero
}

export function splitFor(experimentId: string): Arm[] {
  const db = openDb();
  const e = db.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId) as ExperimentRow | undefined;
  if (!e || (e.status !== "running" && e.status !== "launching")) return [];

  // Values already adopted on this goal: they ride along in every arm.
  const merged = db.prepare(
    `SELECT en.field, en.variant_value FROM outcomes o JOIN experiments en ON en.id = o.experiment_id
     WHERE o.process_id = ? AND o.goal_id IS ? AND o.review_state = 'merged' ORDER BY en.ends_at`
  ).all(e.process_id, e.goal_id) as { field: string; variant_value: string }[];
  const promoted = new Map<string, string>();
  for (const m of merged) promoted.set(m.field, m.variant_value);

  // Latest reading: the variant and holdout ratios are both measured against
  // control, which is the x1.00 reference by construction.
  const last = db.prepare(
    "SELECT multiple, holdout_multiple FROM observations WHERE experiment_id = ? AND missing = 0 ORDER BY hour DESC LIMIT 1"
  ).get(experimentId) as { multiple: number | null; holdout_multiple: number | null } | undefined;

  const base = e.baseline;
  const unit = e.baseline_unit ?? null;
  // For a lower-is-better metric the multiple is a reduction, so the absolute
  // value divides rather than multiplies. Getting this backwards would show a
  // CPC win as a cost increase.
  const inv = !!e.baseline_inverse;
  const raw = (m: number | null) => (base != null && m != null ? (inv ? base / m : base * m) : null);

  const v = e.share ?? DEFAULT_VARIANT_SHARE;
  const h = e.holdout_share ?? 0;
  const isAA = e.holdout_field === e.field && e.holdout_value === e.control_value;

  const variant: Arm = {
    key: "variant", label: "variant", share: v, shareExact: e.share != null,
    diff: { field: e.field, from: e.control_value, to: e.variant_value },
    verb: "testing", note: "v(current++)",
    multiple: last?.multiple ?? null, raw: raw(last?.multiple ?? null), unit,
  };
  const control: Arm = {
    key: "control", label: "control", share: 1 - v - h, shareExact: e.share != null,
    diff: null, verb: "live", note: "v(current) — every adopted change, unmodified",
    multiple: 1, raw: base ?? null, unit,
  };
  const holdout: Arm = (h > 0 && e.holdout_field)
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
  const arms: Arm[] = [variant, control, holdout];
  return arms;
}
