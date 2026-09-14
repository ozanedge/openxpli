// The hard rules used to live in the prompt. "never delete anything" is an
// instruction to a model, and the executor clicked whatever index came back
// with no idea what the element was. This is the same rules as code, checked
// against the element's own text immediately before the click happens.
const DESTRUCTIVE = /\b(delete|remove|archive|trash|discard)\b/i;
const BILLING = /\b(billing|payment|payment method|credit card|card details|invoice|subscription|add funds|top ?up|upgrade|downgrade)\b/i;
const ACCOUNT = /\b(close account|cancel account|cancel subscription|deactivate account|delete account|transfer ownership)\b/i;
// "Cancel" alone backs out of a dialog, which is the SAFE direction. Only block
// it when it is cancelling a thing rather than a step.
const BARE_CANCEL = /^\s*cancel\s*$/i;
export function classify(label) {
    const t = (label || "").trim();
    if (!t)
        return { ok: true };
    if (BARE_CANCEL.test(t))
        return { ok: true };
    if (ACCOUNT.test(t))
        return { ok: false, kind: "account", why: `"${t}" touches account lifecycle` };
    if (BILLING.test(t))
        return { ok: false, kind: "billing", why: `"${t}" touches billing or payment` };
    if (DESTRUCTIVE.test(t))
        return { ok: false, kind: "destructive", why: `"${t}" destroys an object` };
    return { ok: true };
}
/** A write in plan mode is a bug, not a judgement call. */
export function assertAction(action, label, opts) {
    const writes = action === "click" || action === "fill" || action === "press";
    if (opts.mode === "plan" && writes)
        return { ok: false, kind: "mode", why: `plan mode is read-only; refused ${action} on "${label}"` };
    return classify(label);
}
/** Budget fields may fall or hold. They may never rise. */
export function assertBudget(before, after) {
    if (after > before + 1e-9)
        return { ok: false, kind: "budget", why: `budget would rise from ${before} to ${after}` };
    return { ok: true };
}
/** Every arm's copy has to fit the placement, or the test is measuring truncation. */
export function assertCopyLimits(values, limits) {
    for (const v of values) {
        const cap = limits[v.field];
        if (cap && v.value.length > cap)
            return { ok: false, kind: "copy", why: `${v.field} is ${v.value.length} chars, limit ${cap}` };
    }
    return { ok: true };
}
/**
 * A native confirm() is the platform asking "are you sure you want to do the
 * irreversible thing". The answer is always no, and the run stops.
 */
export function armDialogGuard(page, onTrip) {
    page.on("dialog", (d) => {
        const dlg = d;
        const msg = dlg.message();
        dlg.dismiss().catch(() => { });
        onTrip(msg);
    });
}
