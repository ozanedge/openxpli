const money = (n) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
const pct = (m) => `${((m - 1) * 100).toFixed(1)}%`;
// `winner` decides what the figure MEANS:
//   variant  — an adopted improvement, worth its lift for a year
//   control  — nothing changed, so nothing is worth anything
//   holdout  — the previous adoption was losing; reverting recovers that loss
export function annualValue(winner, multiple, holdoutMultiple, goal, model, basisOverride) {
    if (basisOverride)
        model = { ...(model ?? {}), annual_spend: basisOverride };
    const basis = model?.note || "the object under test";
    if (!model || (!model.annual_spend && !model.units_per_year))
        return { amount: 0, kind: "none", formula: "No value model set for this connector.", basis };
    if (winner === "control" || !winner)
        return { amount: 0, kind: "none", formula: "Control held — nothing was adopted, so nothing changed.", basis };
    const m = winner === "holdout" ? holdoutMultiple : multiple;
    if (m == null || m <= 1)
        return { amount: 0, kind: "none", formula: "No improvement to annualise.", basis };
    const lift = m - 1;
    // Preferred: units the metric produces, priced. Works for higher-is-better
    // rates, where a fixed budget simply buys more of them.
    if (model.units_per_year && model.value_per_unit && !goal?.inverse) {
        const extra = model.units_per_year * lift;
        const amount = extra * model.value_per_unit;
        const unit = model.unit || "unit";
        return {
            amount,
            kind: winner === "holdout" ? "recovered" : "value",
            formula: `${Math.round(model.units_per_year).toLocaleString()} ${unit}s/yr × ${pct(m)} = ${Math.round(extra).toLocaleString()} more ${unit}s × ${money(model.value_per_unit)} each`,
            basis,
        };
    }
    // Fallback: the same result would have cost more. Also the natural framing for
    // an inverse metric, where the multiple already IS a cost reduction.
    if (model.annual_spend) {
        const amount = model.annual_spend * (1 - 1 / m);
        return {
            amount,
            kind: winner === "holdout" ? "recovered" : "savings",
            formula: `${money(model.annual_spend)}/yr × (1 − 1/${m.toFixed(3)}) — the same outcome for ${pct(m)} less`,
            basis,
        };
    }
    return { amount: 0, kind: "none", formula: "Value model is missing a spend basis.", basis };
}
export function fmtMoney(n) {
    return money(n);
}
