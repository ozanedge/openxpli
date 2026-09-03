// Deterministic hash so synthetic data is stable across runs (resumable).
function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const syntheticBinding = {
    name: "synthetic",
    canBackfill: true,
    read(exp, hour) {
        const t = Math.min(1, hour / 168);
        // Stable per-experiment target multiple in [0.88, 1.15]
        const target = 0.88 + (fnv(exp.id) % 28) / 100;
        const eased = 1 + (target - 1) * easeInOut(t);
        // Confidence funnel: volatile early hours converging by run end
        // (same decay the console's design uses: 0.11/(h+2)^0.7 * (1-t)^1.3)
        const amp = (0.11 / Math.pow(hour + 2, 0.7)) * Math.pow(1 - t, 1.3);
        const noise = ((fnv(`${exp.id}:${hour}`) % 2001) / 1000 - 1) * amp;
        return { multiple: eased + noise, sigma: amp * 1.5, source: "synthetic" };
    },
};
// Holdout reading: promoted variant vs the small share left on the old
// control. hour is 1..VALIDATION_HOURS. Synthetic model: ~15% of winners
// (deterministic per experiment) regress — their advantage decays through
// the window; the rest hold their final multiple with converging noise.
export function readHoldout(exp, hour, windowHours) {
    const base = exp.final_multiple ?? 1.0;
    const regresses = fnv(`${exp.id}:fate`) % 100 < 15;
    const t = Math.min(1, hour / windowHours);
    const mean = regresses ? base + (0.97 - base) * easeInOut(t) : base;
    const amp = (0.08 / Math.pow(hour + 2, 0.6)) * Math.pow(1 - t * 0.5, 1.2);
    const noise = ((fnv(`${exp.id}:h:${hour}`) % 2001) / 1000 - 1) * amp;
    return { multiple: mean + noise, sigma: amp * 1.5, source: "synthetic" };
}
export function resolveBinding(_processId) {
    // TODO: per-playbook resolution API -> cli -> browser. Synthetic until
    // the first real playbook (ads.openai.com) lands.
    return syntheticBinding;
}
