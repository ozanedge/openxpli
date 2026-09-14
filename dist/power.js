// Whether an experiment can see what it is looking for, before it spends a week
// looking. Nothing in the engine asked this, which is how it came to propose a
// test whose smallest detectable difference (65%) was twice the effect it
// expected to find (30%).
export const HOUR = 3_600_000;
export const WEEK_HOURS = 168;
// Ask for a comfortably resolvable run, not a marginal one: a design whose MDE
// only just clears the expected effect is a coin flip in practice.
export const POWER_MARGIN = 1.25;
export const MAX_RUN_WEEKS = 4;
// Relative standard error of the metric on one arm.
//  - a cost-per-click metric is driven by how many clicks landed
//  - a rate on impressions is a proportion, and a LOW rate is a rare event, so
//    plentiful impressions buy less precision than they appear to
function relSE(kind, vol, days, arms) {
    if (kind === "cost-per-click") {
        const c = (vol.clicks_per_day * days) / arms;
        return c > 0 ? 1 / Math.sqrt(c) : Infinity;
    }
    const n = (vol.impressions_per_day * days) / arms;
    const p = vol.impressions_per_day > 0 ? vol.clicks_per_day / vol.impressions_per_day : 0;
    return n > 0 && p > 0 ? Math.sqrt((p * (1 - p)) / n) / p : Infinity;
}
// Two arms compared at 95%: the difference has to clear 1.96 standard errors of
// the difference, and that error is sqrt(2) times one arm's.
const mdeFrom = (se) => 1.96 * se * Math.SQRT2;
export function assess(metric, inverse, vol, arms, expectedMultiple, runHours = WEEK_HOURS) {
    const kind = /cost per click|cpc|cost per/i.test(metric) ? "cost-per-click" : "rate";
    const expected = Math.abs(expectedMultiple - 1);
    const days = runHours / 24;
    const se = relSE(kind, vol, days, arms);
    const mde = mdeFrom(se);
    // Shortest whole number of weeks that resolves the expected effect with margin.
    let needed = null;
    for (let w = 1; w <= MAX_RUN_WEEKS; w++) {
        if (mdeFrom(relSE(kind, vol, (w * WEEK_HOURS) / 24, arms)) <= expected / POWER_MARGIN) {
            needed = w * WEEK_HOURS;
            break;
        }
    }
    return {
        arms, run_hours: runHours,
        clicks_per_arm: (vol.clicks_per_day * days) / arms,
        impressions_per_arm: (vol.impressions_per_day * days) / arms,
        mde, expected,
        resolvable: mde <= expected / POWER_MARGIN,
        needed_hours: needed,
        basis: `${vol.clicks_per_day.toFixed(1)} clicks/day and ${Math.round(vol.impressions_per_day).toLocaleString()} impressions/day on this object, split ${arms} ways`,
    };
}
export function explain(p) {
    const pct = (x) => `${(x * 100).toFixed(0)}%`;
    if (p.resolvable)
        return `${Math.round(p.run_hours / WEEK_HOURS)}-week run resolves down to ${pct(p.mde)}; this expects ${pct(p.expected)}. ${Math.round(p.clicks_per_arm)} clicks per arm. Based on ${p.basis}.`;
    if (p.needed_hours)
        return `A ${Math.round(p.run_hours / WEEK_HOURS)}-week run only resolves ${pct(p.mde)} but this expects ${pct(p.expected)} — needs ${p.needed_hours / WEEK_HOURS} weeks. Based on ${p.basis}.`;
    return `Underpowered at any run length up to ${MAX_RUN_WEEKS} weeks: resolves ${pct(p.mde)} against an expected ${pct(p.expected)}. Not enough volume on this object. Based on ${p.basis}.`;
}
