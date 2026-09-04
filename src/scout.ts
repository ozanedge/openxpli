import { openDb, type ProcessRow } from "./db.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./paths.js";
import { playbookFor, learn, BROWSER_PROFILE } from "./browser-scout.js";
import { proposeGoals, ratifiedGoal, ensureGoalsBackfilled } from "./goals.js";

// Analysis takes real time with real playbooks; the synthetic scout honors a
// short window so the lifecycle (connected -> analyzing -> choose -> running)
// is genuine, not instant theater.
export const ANALYZE_MS = Number(process.env.OPENXPLI_ANALYZE_MS ?? 90_000);
import { startExperiment } from "./enroll.js";

// Scout: analyze a Source's current state and propose the top 3 experiment
// candidates. Synthetic for now (a per-tool candidate library); the real
// implementation reads the tool through its playbook bindings. The user
// accepts a candidate to start it — OpenXPLI does the decomposition, not them.

export interface CandidateRow {
  id: string;
  source_id: string;
  field: string;
  control_value: string;
  variant_value: string;
  metric: string;
  inverse: number;
  rationale: string;
  expected_multiple: number;
  status: "proposed" | "accepted" | "dismissed";
  created_at: number;
}

type Tpl = [field: string, control: string, variant: string, metric: string, inverse: 0 | 1, rationale: string];

const LIB: Record<string, Tpl[]> = {
  email: [
    ["subject line", "current subject", "question-form subject with concrete benefit", "open rate", 0, "Question-form subjects with a concrete benefit outperform statements in most B2C lists; current subject is a statement."],
    ["send time", "9:00 local", "19:30 local", "conversion rate", 0, "Evening sends catch decision-mode browsing for commerce audiences; current schedule targets work hours."],
    ["CTA copy", "Shop now", "Finish checking out", "click-through rate", 0, "Task-completion language beats generic imperatives when the audience already carted items."],
    ["discount placement", "footer", "first paragraph", "conversion rate", 0, "The offer is below the fold; moving it above should lift conversion without changing discount economics."],
  ],
  ads: [
    ["headline", "current headline", "benefit-first headline naming the outcome", "click-through rate", 0, "The live headline names the product, not the outcome; benefit-first phrasing typically lifts CTR."],
    ["bid", "current CPC bid", "bid −15% with dayparting", "cost per click", 1, "Spend is flat across hours while conversions cluster; dayparting the bid should cut CPC without losing volume."],
    ["audience", "broad", "lookalike of converters, 2%", "cost per acquisition", 1, "Broad targeting is paying for unqualified clicks; a tight lookalike usually lowers CPA at this spend level."],
    ["creative format", "static image", "short motion loop", "click-through rate", 0, "Motion creatives out-earn statics on this placement in most accounts; the account runs statics only."],
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

function kindFor(tool: string): keyof typeof LIB {
  const t = tool.toLowerCase();
  if (/klaviyo|mailchimp|customer\.io|braze|sendgrid|email/.test(t)) return "email";
  if (/ads|adwords|meta|criteo|openai/.test(t)) return "ads";
  if (/zendesk|intercom|freshdesk|support/.test(t)) return "support";
  if (/hubspot|salesforce|salesloft|outreach|crm/.test(t)) return "crm";
  return "generic";
}

function fnv(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function ensureCandidatesTable(): void {
  openDb().exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES processes(id),
      field TEXT NOT NULL, control_value TEXT NOT NULL, variant_value TEXT NOT NULL,
      metric TEXT NOT NULL, inverse INTEGER NOT NULL DEFAULT 0,
      rationale TEXT NOT NULL, expected_multiple REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL
    );`);
}

export function insertCandidates(sourceId: string, rows_: { field: string; control_value: string; variant_value: string; metric: string; inverse: number | boolean; rationale: string; expected_multiple: number }[]): CandidateRow[] {
  let rows = rows_;
  ensureCandidatesTable();
  const db = openDb();
  const proposed = (db.prepare("SELECT COUNT(*) c FROM candidates WHERE source_id = ? AND status = 'proposed'").get(sourceId) as { c: number }).c;
  if (proposed >= 3) return listCandidates(sourceId); // a scout already landed; don't stack or clobber
  const liveFields = new Set((db.prepare("SELECT field FROM experiments WHERE process_id = ? AND status IN ('running','launching')").all(sourceId) as { field: string }[]).map((r) => r.field.toLowerCase()));
  rows = rows.filter((r) => !liveFields.has(r.field.toLowerCase()));
  if (!rows.length) return listCandidates(sourceId);
  const short = sourceId.split("/").pop() ?? sourceId;
  const used = (db.prepare("SELECT COUNT(*) c FROM candidates WHERE source_id = ?").get(sourceId) as { c: number }).c;
  const ins = db.prepare(
    "INSERT OR IGNORE INTO candidates (id, source_id, field, control_value, variant_value, metric, inverse, rationale, expected_multiple, status, created_at) VALUES (?,?,?,?,?,?,?,?,?, 'proposed', ?)"
  );
  rows.forEach((r, n) => ins.run(`${short}#${used + n + 1}`, sourceId, r.field, r.control_value, r.variant_value, r.metric, r.inverse ? 1 : 0, r.rationale, Math.min(1.2, Math.max(1.005, r.expected_multiple || 1.03)), Date.now()));
  db.prepare("UPDATE processes SET status = 'proposed' WHERE id = ? AND status = 'shadow'").run(sourceId);
  return listCandidates(sourceId);
}

// Real scouting runs in a detached child (browser + model are slow); a lock
// dir keeps ticks from spawning duplicates.
function scoutLock(sourceId: string): string { return join(DATA_DIR, `scout-${sourceId.replace(/[^a-z0-9]/gi, "-")}.lock`); }
export function spawnDetachedScout(sourceId: string): boolean {
  const lock = scoutLock(sourceId);
  try {
    const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < 10 * 60_000) return false; // already scouting
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  } catch { return false; }
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  spawn(process.execPath, [cli, "rescout", sourceId, "--child"], { detached: true, stdio: "ignore" }).unref();
  return true;
}

export async function rescout(sourceId: string, isChild = false): Promise<CandidateRow[]> {
  ensureCandidatesTable();
  const db = openDb();
  const src = db.prepare("SELECT * FROM processes WHERE id = ?").get(sourceId) as ProcessRow | undefined;
  if (!src) throw new Error(`rescout: no such connector: ${sourceId}`);
  db.prepare("UPDATE candidates SET status = 'dismissed' WHERE source_id = ? AND status = 'proposed'").run(sourceId);
  const pb = playbookFor(src.tool);
  try {
    if (pb && existsSync(BROWSER_PROFILE)) {
      console.log(`rescout: learning ${pb.name} through the browser (read-only crawl -> knowledge store)…`);
      const rows = await learn(sourceId, src.tool, pb);
      return insertCandidates(sourceId, rows.map((r) => ({ ...r, inverse: r.inverse ? 1 : 0 })));
    }
    if (pb && !existsSync(BROWSER_PROFILE))
      console.log(`rescout: no browser session yet — run \`openxpli signin ${sourceId}\` once to enable real scouting of ${pb.name}. Falling back to template suggestions.`);
  } catch (e) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg.includes("NEED_SIGNIN"))
      console.log(`rescout: ${pb?.name} wants a sign-in — run \`openxpli signin ${sourceId}\`. Falling back to template suggestions.`);
    else console.log(`rescout: real scout failed (${msg.slice(0, 160)}) — falling back to template suggestions.`);
  } finally {
    if (isChild) rmSync(scoutLock(sourceId), { recursive: true, force: true });
  }
  return scout(sourceId);
}

export function scout(sourceId: string): CandidateRow[] {
  ensureCandidatesTable();
  const db = openDb();
  const src = db.prepare("SELECT * FROM processes WHERE id = ?").get(sourceId) as ProcessRow | undefined;
  if (!src) throw new Error(`scout: no such connector: ${sourceId}`);
  // Experiments are proposed against the connector's north star. Without one
  // there is nothing to propose *toward*, so scouting waits for ratification.
  const goal = ratifiedGoal(sourceId);
  if (!goal) return [];
  const existing = db.prepare(
    "SELECT COUNT(*) c FROM candidates WHERE source_id = ? AND status = 'proposed'"
  ).get(sourceId) as { c: number };
  if (existing.c >= 3) return listCandidates(sourceId);

  // Templates that already measure the goal come first; the rest keep their
  // lever but are re-pointed at the goal, so every candidate is comparable.
  const base = LIB[kindFor(src.tool)];
  const native = base.filter((t) => t[3] === goal.metric);
  const repointed = base
    .filter((t) => t[3] !== goal.metric)
    .map(([field, control, variant, , , rationale]) =>
      [field, control, variant, goal.metric, goal.inverse as 0 | 1,
       `${rationale} Scored against this connector's goal, ${goal.metric}.`] as Tpl);
  const lib = [...native, ...repointed];

  const used = (db.prepare("SELECT COUNT(*) c FROM candidates WHERE source_id = ?").get(sourceId) as { c: number }).c;
  const start = (fnv(sourceId) + used) % lib.length;
  return insertCandidates(sourceId, Array.from({ length: 3 }, (_, n) => {
    const [field, control_value, variant_value, metric, inverse, rationale] = lib[(start + n) % lib.length];
    return { field, control_value, variant_value, metric, inverse, rationale,
      expected_multiple: 1.02 + ((fnv(`${sourceId}:${field}`) % 9) / 100) };
  }));
}

// Complete any analysis whose window has elapsed, and re-scout connectors
// whose candidates were all dismissed. Called lazily on every read path.
export function maybeAnalyze(): void {
  ensureCandidatesTable();
  ensureGoalsBackfilled();
  const db = openDb();
  // Analysis finishes by proposing north stars, not experiments. Choosing what
  // the connector is for comes before choosing what to try on it.
  const due = db.prepare("SELECT id, tool FROM processes WHERE status = 'shadow' AND created_at <= ?").all(Date.now() - ANALYZE_MS) as { id: string; tool: string }[];
  for (const r of due) {
    proposeGoals(r.id);
    db.prepare("UPDATE processes SET status = 'goal' WHERE id = ?").run(r.id);
  }
  // Goal ratified but no live candidates: scout experiments against it.
  const empty = db.prepare(`SELECT p.id, p.tool FROM processes p WHERE p.status IN ('proposed','running')
    AND NOT EXISTS (SELECT 1 FROM candidates c WHERE c.source_id = p.id AND c.status = 'proposed')
    AND NOT EXISTS (SELECT 1 FROM experiments e WHERE e.process_id = p.id AND e.status IN ('running','launching'))
    AND EXISTS (SELECT 1 FROM goals g WHERE g.source_id = p.id AND g.status = 'ratified')`).all() as { id: string; tool: string }[];
  for (const r of empty) {
    if (playbookFor(r.tool) && existsSync(BROWSER_PROFILE)) spawnDetachedScout(r.id);
    else scout(r.id);
  }
}

export function listCandidates(sourceId?: string): CandidateRow[] {
  ensureCandidatesTable();
  const db = openDb();
  return (sourceId
    ? db.prepare("SELECT * FROM candidates WHERE source_id = ? AND status = 'proposed' ORDER BY id").all(sourceId)
    : db.prepare("SELECT * FROM candidates WHERE status = 'proposed' ORDER BY source_id, id").all()) as CandidateRow[];
}

export function acceptCandidate(candidateId: string): string {
  ensureCandidatesTable();
  const db = openDb();
  const c = db.prepare("SELECT * FROM candidates WHERE id = ?").get(candidateId) as CandidateRow | undefined;
  if (!c) throw new Error(`no such candidate: ${candidateId}`);
  if (c.status !== "proposed") throw new Error(`${candidateId} is already ${c.status}`);
  // A candidate is measured BY the goal; it can never redefine it. This used to
  // be an UPDATE of processes.metric, which meant whichever experiment you
  // happened to accept silently became the connector's definition of winning.
  const goal = ratifiedGoal(c.source_id);
  if (!goal)
    throw new Error(`accept: ${c.source_id} has no ratified goal yet — ratify one first (openxpli goals ${c.source_id})`);
  if (c.metric !== goal.metric || c.inverse !== goal.inverse)
    throw new Error(`accept: ${candidateId} measures \`${c.metric}\` but ${c.source_id} is accountable to \`${goal.metric}\` — dismiss it, or re-goal the connector to change the north star`);
  db.prepare("UPDATE processes SET status = 'running' WHERE id = ?").run(c.source_id);
  const src = db.prepare("SELECT * FROM processes WHERE id = ?").get(c.source_id) as ProcessRow;
  const pb = playbookFor(src.tool);
  const viaBrowser = pb && existsSync(BROWSER_PROFILE);
  const msg = startExperiment(c.source_id, c.field, c.control_value, c.variant_value, 7, viaBrowser ? "launching" : "running");
  db.prepare("UPDATE candidates SET status = 'accepted' WHERE id = ?").run(candidateId);
  if (viaBrowser) {
    const expId = msg.match(/started (\S+):/)?.[1];
    if (expId) {
      const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
      spawn(process.execPath, [cli, "act", expId, "--child"], { detached: true, stdio: "ignore" }).unref();
      return `accepted ${candidateId} — launching in ${pb!.name}: OpenXPLI is creating the objects in the browser now (receipts in ~/.openxpli/receipts). The run starts when launch completes.`;
    }
  }
  return `accepted ${candidateId} — ${msg}`;
}

export function dismissCandidate(candidateId: string): string {
  ensureCandidatesTable();
  const db = openDb();
  const r = db.prepare("UPDATE candidates SET status = 'dismissed' WHERE id = ? AND status = 'proposed'").run(candidateId);
  if (!r.changes) throw new Error(`no proposed candidate: ${candidateId}`);
  return `dismissed ${candidateId}`;
}

export function addSource(id: string, tool: string): { message: string; candidates: CandidateRow[] } {
  if (!id || !/^[a-z0-9][a-z0-9._\/-]{2,80}$/i.test(id))
    throw new Error("add: connector account id required (letters/digits/./_/-//, e.g. klaviyo/main-account)");
  if (!tool) throw new Error("add: --tool required (Klaviyo, ChatGPT Ads, Zendesk, ...)");
  const db = openDb();
  try {
    db.prepare(
      "INSERT INTO processes (id, tool, metric, inverse, autonomy, status, policy, created_at) VALUES (?,?, '', 0, 'shadow', 'shadow', '{}', ?)"
    ).run(id, tool, Date.now());
  } catch (e) {
    if (String(e).includes("UNIQUE")) throw new Error(`add: ${id} is already connected`);
    throw e;
  }
  return {
    message: `Connector ${id} (${tool}) connected in SHADOW MODE — read-only. No changes will be made to ${tool}.\nOpenXPLI is analyzing the current state and will propose what ${tool} should be accountable to — its north star metric — in about ${Math.round(ANALYZE_MS / 60_000) || 1} minute(s). You ratify one goal, then experiments are proposed against it.\nWatch the console or run: openxpli goals ${id}`,
    candidates: [],
  };
}
