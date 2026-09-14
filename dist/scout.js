import { openDb } from "./db.js";
import { existsSync } from "node:fs";
import { playbookFor, learn, BROWSER_PROFILE, learningStatus } from "./browser-scout.js";
import { proposeGoals, ratifiedGoal, ensureGoalsBackfilled } from "./goals.js";
import { assess, explain, WEEK_HOURS } from "./power.js";
// Analysis takes real time with real playbooks; the synthetic scout honors a
// short window so the lifecycle (connected -> analyzing -> choose -> running)
// is genuine, not instant theater.
export const ANALYZE_MS = Number(process.env.OPENXPLI_ANALYZE_MS ?? 90_000);
import { requestKit } from "./kits.js";
import { queueLearningJob } from "./learning-jobs.js";
import { BrowserCancelled } from "./browser-session.js";
const LIB = {
    email: [
        ["subject line", "current subject", "question-form subject with concrete benefit", "open rate", 0, "Question-form subjects with a concrete benefit outperform statements in most B2C lists; current subject is a statement."],
        ["send time", "9:00 local", "19:30 local", "conversion rate", 0, "Evening sends catch decision-mode browsing for commerce audiences; current schedule targets work hours."],
        ["CTA copy", "Shop now", "Finish checking out", "click-through rate", 0, "Task-completion language beats generic imperatives when the audience already carted items."],
        ["discount placement", "footer", "first paragraph", "conversion rate", 0, "The offer is below the fold; moving it above should lift conversion without changing discount economics."],
    ],
    ads: [
        ["headline", "current headline", "benefit-first headline naming the outcome", "click-through rate", 0, "Template idea: test a concrete benefit in the headline. Learn the account to draft the actual copy."],
        ["description", "current description", "one concise product benefit with a clear next step", "click-through rate", 0, "Template idea: simplify the description while preserving the offer. Learn the account first."],
        ["image", "current image", "a product-focused image showing the benefit", "click-through rate", 0, "Template idea: test the image while retaining all copy. Learn the account to ground the creative brief."],
    ],
    support: [
        ["routing rule", "round-robin", "skill-based routing", "first reply time", 1, "Round-robin ignores agent specialty; skill-based routing shortens first reply on technical queues."],
        ["macro opening", "current greeting macro", "greeting that restates the issue in one line", "customer satisfaction", 0, "Restating the issue up front raises perceived understanding and CSAT."],
        ["triage priority", "newest first", "SLA-risk first", "SLA breach rate", 1, "Newest-first leaves aging tickets to breach; sorting by SLA risk should cut breaches directly."],
    ],
    crm: [
        ["follow-up delay", "3 days", "26 hours", "reply rate", 0, "Reply probability decays fast after first touch; a next-day follow-up usually beats day-3."],
        ["sequence step 2", "feature summary", "customer-story one-liner", "meeting book rate", 0, "Social proof at step 2 outperforms feature lists once interest exists."],
        ["lead routing", "alphabetical owner", "territory + load balance", "time to first touch", 1, "Alphabetical assignment ignores load; balanced routing cuts first-touch latency."],
    ],
    generic: [
        ["primary CTA", "current label", "verb + outcome label", "conversion rate", 0, "Outcome-naming CTAs outperform generic labels in most funnels."],
        ["default option", "none selected", "recommended option preselected", "completion rate", 0, "A sensible default reduces decision cost; completion should rise."],
        ["notification timing", "immediate", "batched daily digest", "engagement rate", 0, "Immediate pings train ignoring; a digest usually lifts per-message engagement."],
    ],
};
function kindFor(tool) {
    const t = tool.toLowerCase();
    if (/klaviyo|mailchimp|customer\.io|braze|sendgrid|email/.test(t))
        return "email";
    if (/ads|adwords|meta|criteo|openai/.test(t))
        return "ads";
    if (/zendesk|intercom|freshdesk|support/.test(t))
        return "support";
    if (/hubspot|salesforce|salesloft|outreach|crm/.test(t))
        return "crm";
    return "generic";
}
function fnv(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
export function ensureCandidatesTable() {
    openDb().exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES processes(id),
      field TEXT NOT NULL, control_value TEXT NOT NULL, variant_value TEXT NOT NULL,
      metric TEXT NOT NULL, inverse INTEGER NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL, expected_multiple REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL
    );`);
}
export function insertCandidates(sourceId, rows_, replaceProposed = false) {
    let rows = rows_;
    ensureCandidatesTable();
    const db = openDb();
    const proposed = db.prepare("SELECT COUNT(*) c FROM candidates WHERE source_id = ? AND status = 'proposed'").get(sourceId).c;
    if (!replaceProposed && proposed >= 3)
        return listCandidates(sourceId); // a scout already landed; don't stack or clobber
    const liveFields = new Set(db.prepare("SELECT field FROM experiments WHERE process_id = ? AND status IN ('running','launching')").all(sourceId).map((r) => r.field.toLowerCase()));
    rows = rows.filter((r) => !liveFields.has(r.field.toLowerCase()));
    // Do not offer an experiment that cannot see the effect it expects. Where the
    // object's volume is known, size the run from it and drop anything that stays
    // underpowered even at the maximum run length.
    const powers = new Map();
    rows = rows.filter((r) => {
        if (!r.volume)
            return true; // no volume read for this object; cannot judge
        const arms = r.arms ?? 3;
        const first = assess(r.metric, r.inverse, r.volume, arms, r.expected_multiple, WEEK_HOURS);
        if (!first.needed_hours) {
            console.log(`scout: dropped "${r.field}" — ${explain(first)}`);
            return false;
        }
        powers.set(r.field, assess(r.metric, r.inverse, r.volume, arms, r.expected_multiple, first.needed_hours));
        return true;
    });
    if (!rows.length)
        return listCandidates(sourceId);
    const short = sourceId.split("/").pop() ?? sourceId;
    const used = db.prepare("SELECT COUNT(*) c FROM candidates WHERE source_id = ?").get(sourceId).c;
    const ins = db.prepare("INSERT OR IGNORE INTO candidates (id, source_id, field, control_value, variant_value, metric, inverse, rationale, expected_multiple, status, created_at, power, run_hours, evidence) VALUES (?,?,?,?,?,?,?,?,?, 'proposed', ?,?,?,?)");
    db.transaction(() => {
        if (replaceProposed)
            db.prepare("UPDATE candidates SET status = 'dismissed' WHERE source_id = ? AND status = 'proposed'").run(sourceId);
        rows.forEach((r, n) => {
            const pw = powers.get(r.field) ?? null;
            ins.run(`${short}#${used + n + 1}`, sourceId, r.field, r.control_value, r.variant_value, r.metric, r.inverse ? 1 : 0, r.rationale, r.volume ? r.expected_multiple : Math.min(1.2, Math.max(1.005, r.expected_multiple || 1.03)), Date.now(), pw ? JSON.stringify(pw) : null, pw ? pw.run_hours : null, r.evidence ? JSON.stringify(r.evidence) : null);
        });
    }).immediate();
    db.prepare("UPDATE processes SET status = 'proposed' WHERE id = ? AND status = 'shadow'").run(sourceId);
    return listCandidates(sourceId);
}
// Browser jobs are deduplicated per connector; persistent contexts are queued
// across all connectors, sign-in windows, and scheduled browser reads.
export function spawnDetachedScout(sourceId) {
    queueLearningJob(sourceId, "learn");
    return true;
}
export async function rescout(sourceId, _isChild = false, options = {}) {
    ensureCandidatesTable();
    const db = openDb();
    try {
        const src = db.prepare("SELECT * FROM processes WHERE id = ?").get(sourceId);
        if (!src)
            throw new Error(`rescout: no such connector: ${sourceId}`);
        const pb = playbookFor(src.tool);
        if (!pb)
            return scout(sourceId);
        if (!existsSync(BROWSER_PROFILE))
            throw new Error("NEED_SIGNIN");
        const rows = await learn(sourceId, src.tool, pb, options);
        if (options.cancelled?.())
            throw new BrowserCancelled();
        // Do not discard existing suggestions until new, grounded output is ready.
        if (!rows.length || rows.some((r) => !r.field || !r.control_value || !r.variant_value || !r.metric || !Number.isFinite(r.expected_multiple)))
            throw new Error("Learning did not produce usable suggestions. Previous suggestions are kept; retry learning.");
        return insertCandidates(sourceId, rows.map((r) => ({ ...r, inverse: r.inverse ? 1 : 0 })), true);
    }
    finally {
        db.close();
    }
}
export function scout(sourceId) {
    ensureCandidatesTable();
    const db = openDb();
    const src = db.prepare("SELECT * FROM processes WHERE id = ?").get(sourceId);
    if (!src)
        throw new Error(`scout: no such connector: ${sourceId}`);
    // Experiments are proposed against the connector's north star. Without one
    // there is nothing to propose *toward*, so scouting waits for ratification.
    const goal = ratifiedGoal(sourceId);
    if (!goal)
        return [];
    const existing = db.prepare("SELECT COUNT(*) c FROM candidates WHERE source_id = ? AND status = 'proposed'").get(sourceId);
    if (existing.c >= 3)
        return listCandidates(sourceId);
    // Templates that already measure the goal come first; the rest keep their
    // lever but are re-pointed at the goal, so every candidate is comparable.
    const base = LIB[kindFor(src.tool)];
    const native = base.filter((t) => t[3] === goal.metric);
    const repointed = base
        .filter((t) => t[3] !== goal.metric)
        .map(([field, control, variant, , , rationale]) => [field, control, variant, goal.metric, goal.inverse,
        `${rationale} Scored against this connector's goal, ${goal.metric}.`]);
    const lib = [...native, ...repointed];
    const used = db.prepare("SELECT COUNT(*) c FROM candidates WHERE source_id = ?").get(sourceId).c;
    const start = (fnv(sourceId) + used) % lib.length;
    return insertCandidates(sourceId, Array.from({ length: 3 }, (_, n) => {
        const [field, control_value, variant_value, metric, inverse, rationale] = lib[(start + n) % lib.length];
        return { field, control_value, variant_value, metric, inverse, rationale,
            expected_multiple: 1.02 + ((fnv(`${sourceId}:${field}`) % 9) / 100) };
    }));
}
// Complete any analysis whose window has elapsed, and re-scout connectors
// whose candidates were all dismissed. Called lazily on every read path.
export function maybeAnalyze() {
    ensureCandidatesTable();
    ensureGoalsBackfilled();
    const db = openDb();
    // Analysis finishes by proposing north stars, not experiments. Choosing what
    // the connector is for comes before choosing what to try on it.
    const due = db.prepare("SELECT id, tool FROM processes WHERE status = 'shadow' AND created_at <= ?").all(Date.now() - ANALYZE_MS);
    for (const r of due) {
        proposeGoals(r.id);
        db.prepare("UPDATE processes SET status = 'goal' WHERE id = ?").run(r.id);
    }
    // Goal ratified but no live candidates: scout experiments against it.
    const empty = db.prepare(`SELECT p.id, p.tool FROM processes p WHERE p.status IN ('proposed','running')
    AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.source_id = p.id AND c.status = 'proposed')
    AND NOT EXISTS (SELECT 1 FROM experiments e WHERE e.process_id = p.id AND e.status IN ('running','launching'))
    AND EXISTS (SELECT 1 FROM goals g WHERE g.source_id = p.id AND g.status = 'ratified')`).all();
    for (const r of empty) {
        if (playbookFor(r.tool)) {
            const attempted = db.prepare("SELECT 1 FROM knowledge WHERE source_id = ? AND key = 'learning-status'").get(r.id);
            if (attempted)
                continue; // retries belong to the user, not every polling request
            if (existsSync(BROWSER_PROFILE))
                spawnDetachedScout(r.id);
            else
                learningStatus(r.id, "needs-signin", "Sign in to read the account and prepare grounded suggestions.");
        }
        else
            scout(r.id);
    }
}
export function listCandidates(sourceId) {
    ensureCandidatesTable();
    const db = openDb();
    return (sourceId
        ? db.prepare("SELECT * FROM candidates WHERE source_id = ? AND status = 'proposed' ORDER BY id").all(sourceId)
        : db.prepare("SELECT * FROM candidates WHERE status = 'proposed' ORDER BY source_id, id").all());
}
export function acceptCandidate(candidateId) {
    const kit = requestKit(candidateId);
    return `Preparing experiment kit ${kit.id}. Review and download it in Connectors. Nothing is launched or changed in your account.`;
}
export function dismissCandidate(candidateId) {
    ensureCandidatesTable();
    const db = openDb();
    const r = db.prepare("UPDATE candidates SET status = 'dismissed' WHERE id = ? AND status = 'proposed'").run(candidateId);
    if (!r.changes)
        throw new Error(`no proposed candidate: ${candidateId}`);
    return `dismissed ${candidateId}`;
}
export function addSource(id, tool) {
    if (!id || !/^[a-z0-9][a-z0-9._\/-]{2,80}$/i.test(id))
        throw new Error("add: connector account id required (letters/digits/./_/-//, e.g. klaviyo/main-account)");
    if (!tool)
        throw new Error("add: --tool required (Klaviyo, ChatGPT Ads, Zendesk, ...)");
    const db = openDb();
    try {
        db.prepare("INSERT INTO processes (id, tool, metric, inverse, autonomy, status, policy, created_at) VALUES (?,?, '', 0, 'shadow', 'shadow', '{}', ?)").run(id, tool, Date.now());
    }
    catch (e) {
        if (String(e).includes("UNIQUE"))
            throw new Error(`add: ${id} is already connected`);
        throw e;
    }
    return {
        message: `Connector ${id} (${tool}) connected in SHADOW MODE — read-only. No changes will be made to ${tool}.\nOpenXPLI is analyzing the current state and will propose what ${tool} should be accountable to — its north star metric — in about ${Math.round(ANALYZE_MS / 60_000) || 1} minute(s). You ratify one goal, then experiments are proposed against it.\nWatch the console or run: openxpli goals ${id}`,
        candidates: [],
    };
}
