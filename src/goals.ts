import { openDb, type GoalRow, type Guardrail, type ProcessRow } from "./db.js";
import { writeGoalRecord } from "./ledger.js";

// A connector's goal is the north star it is accountable to: one metric, a
// direction, and the guardrails that must not regress while chasing it.
//
// The rule this module exists to enforce: an experiment can never define the
// goal. The scout proposes goals, a human ratifies one, and every candidate
// beneath it must measure that same metric. Without this, whichever experiment
// you happened to accept silently became the definition of winning — and a
// self-starting connector would re-pick the metric it could most easily move.

type GoalTpl = [metric: string, inverse: 0 | 1, guardrails: Guardrail[], rationale: string];

const GOAL_LIB: Record<string, GoalTpl[]> = {
  email: [
    ["conversion rate", 0,
      [{ metric: "unsubscribe rate", direction: "must-not-rise" }, { metric: "spam complaint rate", direction: "must-not-rise" }],
      "Revenue per send is what the program is funded for. Open and click rates move first but can rise while conversion falls, so they belong as diagnostics, not as the north star."],
    ["revenue per recipient", 0,
      [{ metric: "unsubscribe rate", direction: "must-not-rise" }, { metric: "deliverability", direction: "must-not-drop" }],
      "Normalizes across list-size changes, so wins are not an artifact of sending to more people. Choose this when list growth is active."],
    ["open rate", 0,
      [{ metric: "unsubscribe rate", direction: "must-not-rise" }],
      "A deliberately shallow north star for a warm-up phase. Fast to move and fast to read, but easy to win without any business effect — treat it as temporary."],
  ],
  ads: [
    ["cost per acquisition", 1,
      [{ metric: "conversion volume", direction: "must-not-drop" }, { metric: "daily spend", direction: "must-not-rise" }],
      "Ties the account to what a customer actually costs. Guardrailed on volume because CPA is trivially improved by simply buying less."],
    ["return on ad spend", 0,
      [{ metric: "conversion volume", direction: "must-not-drop" }],
      "Right when order values vary widely, since CPA treats a $10 and a $400 order as the same event."],
    ["cost per click", 1,
      [{ metric: "click volume", direction: "must-not-drop" }, { metric: "conversion rate", direction: "must-not-drop" }],
      "The cheapest signal to read hourly, so experiments resolve fastest — but it is upstream of revenue and rewards cheap unqualified traffic. Guardrail conversion rate hard if you pick this."],
  ],
  support: [
    ["customer satisfaction", 0,
      [{ metric: "first reply time", direction: "must-not-rise" }, { metric: "SLA breach rate", direction: "must-not-rise" }],
      "The outcome the function is judged on. Speed metrics are means to it and make poor north stars alone — a fast wrong answer scores well."],
    ["first reply time", 1,
      [{ metric: "customer satisfaction", direction: "must-not-drop" }, { metric: "reopen rate", direction: "must-not-rise" }],
      "Choose when the queue is the acknowledged problem. Guardrail CSAT and reopens, or the team optimizes toward fast, useless replies."],
    ["SLA breach rate", 1,
      [{ metric: "customer satisfaction", direction: "must-not-drop" }],
      "Right when breaches carry contractual cost. Narrow by design — it says nothing about tickets already inside SLA."],
  ],
  crm: [
    ["meeting book rate", 0,
      [{ metric: "opt-out rate", direction: "must-not-rise" }],
      "The first outcome with real revenue attached. Reply rate moves earlier but rewards any reply, including the annoyed ones."],
    ["pipeline created", 0,
      [{ metric: "opt-out rate", direction: "must-not-rise" }, { metric: "meeting no-show rate", direction: "must-not-rise" }],
      "Closest to revenue of anything readable at this stage, at the cost of a slower read — expect experiments to need longer runs."],
    ["reply rate", 0,
      [{ metric: "opt-out rate", direction: "must-not-rise" }],
      "Fastest to read, so good for a first loop on a cold connector. Weak as a durable north star: it counts every reply as a win."],
  ],
  generic: [
    ["conversion rate", 0,
      [{ metric: "bounce rate", direction: "must-not-rise" }],
      "The default when the funnel ends in a single clear action. Readable within a 7-day run at most traffic levels."],
    ["completion rate", 0,
      [{ metric: "time to complete", direction: "must-not-rise" }],
      "Right when the job is finishing a flow rather than converting once — onboarding, setup, checkout."],
    ["engagement rate", 0,
      [{ metric: "churn rate", direction: "must-not-rise" }],
      "The broadest option and the weakest. Pick it only when no sharper outcome is measurable yet, and plan to replace it."],
  ],
};

function kindFor(tool: string): keyof typeof GOAL_LIB {
  const t = tool.toLowerCase();
  if (/klaviyo|mailchimp|customer\.io|braze|sendgrid|email/.test(t)) return "email";
  if (/ads|adwords|meta|criteo|openai/.test(t)) return "ads";
  if (/zendesk|intercom|freshdesk|support/.test(t)) return "support";
  if (/hubspot|salesforce|salesloft|outreach|crm/.test(t)) return "crm";
  return "generic";
}

export function listGoals(sourceId: string, status: string = "proposed"): GoalRow[] {
  return openDb().prepare("SELECT * FROM goals WHERE source_id = ? AND status = ? ORDER BY id").all(sourceId, status) as GoalRow[];
}

export function ratifiedGoal(sourceId: string): GoalRow | null {
  return (openDb().prepare("SELECT * FROM goals WHERE source_id = ? AND status = 'ratified'").get(sourceId) as GoalRow | undefined) ?? null;
}

export function parseGuardrails(g: string): Guardrail[] {
  try { const v = JSON.parse(g); return Array.isArray(v) ? v : []; } catch { return []; }
}

// Propose the north stars this connector could be held to. Idempotent: an
// existing proposed set is returned untouched so a re-read never restacks.
export function proposeGoals(sourceId: string): GoalRow[] {
  const db = openDb();
  const src = db.prepare("SELECT * FROM processes WHERE id = ?").get(sourceId) as ProcessRow | undefined;
  if (!src) throw new Error(`goals: no such connector: ${sourceId}`);
  const open = listGoals(sourceId);
  if (open.length) return open;

  const short = sourceId.split("/").pop() ?? sourceId;
  const used = (db.prepare("SELECT COUNT(*) c FROM goals WHERE source_id = ?").get(sourceId) as { c: number }).c;
  const lib = GOAL_LIB[kindFor(src.tool)];
  const ins = db.prepare(
    "INSERT OR IGNORE INTO goals (id, source_id, metric, inverse, guardrails, rationale, status, created_at) VALUES (?,?,?,?,?,?, 'proposed', ?)"
  );
  const now = Date.now();
  lib.forEach(([metric, inverse, guardrails, rationale], i) => {
    ins.run(`${short}#g${used + i + 1}`, sourceId, metric, inverse, JSON.stringify(guardrails), rationale, now);
  });
  return listGoals(sourceId);
}

// Ratification is the human act. It is the most consequential decision in the
// system, so it lands in the ledger like any other — and re-goaling a
// connector gives back its earned autonomy, because the wins that earned it
// were measured against a different definition of winning.
export function ratifyGoal(goalId: string): string {
  const db = openDb();
  let g = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId) as GoalRow | undefined;
  // Goal ids are short (`ads-main#g1`); accept the connector-qualified spelling too.
  if (!g && goalId?.includes("/"))
    g = db.prepare("SELECT * FROM goals WHERE id = ?").get(goalId.slice(goalId.lastIndexOf("/") + 1)) as GoalRow | undefined;
  if (!g) throw new Error(`ratify: no such goal: ${goalId}`);
  if (g.status === "ratified") throw new Error(`ratify: ${goalId} is already the ratified goal`);
  if (g.status !== "proposed") throw new Error(`ratify: ${goalId} is ${g.status}`);
  const src = db.prepare("SELECT * FROM processes WHERE id = ?").get(g.source_id) as ProcessRow;
  const prev = ratifiedGoal(g.source_id);

  const demotedFrom = prev && (src.autonomy === "auto-start" || src.autonomy === "auto-merge") ? src.autonomy : null;

  // Database first, ledger second. The reverse order means a failed write
  // leaves a committed record asserting a ratification that never happened —
  // a lie inside the one artifact whose whole value is being trustworthy.
  const now = Date.now();
  const policy = { ...JSON.parse(src.policy || "{}"), goal_id: g.id, guardrails: parseGuardrails(g.guardrails) };
  db.transaction(() => {
    if (prev) db.prepare("UPDATE goals SET status = 'superseded' WHERE id = ?").run(prev.id);
    db.prepare("UPDATE goals SET status = 'dismissed' WHERE source_id = ? AND status = 'proposed' AND id != ?").run(g.source_id, g.id);
    db.prepare("UPDATE goals SET status = 'ratified', ratified_at = ? WHERE id = ?").run(now, g.id);
    db.prepare("UPDATE processes SET metric = ?, inverse = ?, policy = ?, status = 'proposed' WHERE id = ?")
      .run(g.metric, g.inverse, JSON.stringify(policy), g.source_id);
    // Candidates proposed against the old goal no longer measure the right thing.
    db.prepare("UPDATE candidates SET status = 'dismissed' WHERE source_id = ? AND status = 'proposed' AND metric != ?").run(g.source_id, g.metric);
    if (demotedFrom) db.prepare("UPDATE processes SET autonomy = 'human-gated' WHERE id = ?").run(g.source_id);
  })();

  let recordId: string;
  try {
    recordId = writeGoalRecord(src, g, prev, demotedFrom);
    db.prepare("UPDATE goals SET record_id = ? WHERE id = ?").run(recordId, g.id);
  } catch (e) {
    throw new Error(
      `ratify: ${g.source_id} is now accountable to \`${g.metric}\`, but the ledger record could not be written (${String(e instanceof Error ? e.message : e).slice(0, 120)}). ` +
      `The goal is live and unrecorded — fix the ledger and re-run to record it.`
    );
  }

  const inflight = db.prepare(
    "SELECT COUNT(*) c FROM experiments WHERE process_id = ? AND status IN ('running','launching')"
  ).get(g.source_id) as { c: number };
  const parts = [`goal ratified for ${g.source_id}: ${g.metric}${g.inverse ? " (lower is better)" : ""} -> ${recordId}`];
  if (prev) parts.push(`supersedes ${prev.metric}`);
  if (inflight.c) parts.push(`${inflight.c} in-flight experiment(s) will finish and be reported against ${prev ? prev.metric : "their original goal"}`);
  if (demotedFrom) parts.push(`autonomy reset ${demotedFrom} -> human-gated (wins were earned against the old goal)`);
  return parts.join("; ");
}

// A north star the operator states outright (enroll --metric) still becomes a
// ratified goal through the normal path, so it is ledgered like any other.
export function adoptGoal(sourceId: string, metric: string, inverse: number, guardrails: (string | Guardrail)[], rationale: string): string {
  const db = openDb();
  const short = sourceId.split("/").pop() ?? sourceId;
  const used = (db.prepare("SELECT COUNT(*) c FROM goals WHERE source_id = ?").get(sourceId) as { c: number }).c;
  const id = `${short}#g${used + 1}`;
  const rails: Guardrail[] = guardrails.map((d) => (typeof d === "string" ? parseLegacyRail(d) : d));
  db.prepare(
    "INSERT INTO goals (id, source_id, metric, inverse, guardrails, rationale, status, created_at) VALUES (?,?,?,?,?,?, 'proposed', ?)"
  ).run(id, sourceId, metric, inverse, JSON.stringify(rails), rationale, Date.now());
  ratifyGoal(id);
  return id;
}

// Legacy guardrails were free text like "unsubscribes must not rise" — the
// direction is already inside the sentence, so parse it out instead of
// stapling a second one on the end.
export function parseLegacyRail(d: string): Guardrail {
  const m = /^(.*?)\s+must\s+not\s+(rise|increase|grow|drop|fall|decrease)\b.*$/i.exec(d.trim());
  if (!m) return { metric: d.trim(), direction: "must-not-drop" };
  const up = /^(rise|increase|grow)$/i.test(m[2]);
  return { metric: m[1].trim(), direction: up ? "must-not-rise" : "must-not-drop" };
}

// Re-open goal selection on a connector that already has one.
export function regoal(sourceId: string): GoalRow[] {
  const db = openDb();
  if (!db.prepare("SELECT 1 FROM processes WHERE id = ?").get(sourceId)) throw new Error(`goals: no such connector: ${sourceId}`);
  db.prepare("UPDATE goals SET status = 'proposed' WHERE source_id = ? AND status = 'dismissed'").run(sourceId);
  const open = listGoals(sourceId);
  return open.length ? open : proposeGoals(sourceId);
}

// Databases written before goals existed carry their north star on the
// process row. Adopt it as a ratified goal rather than inventing a
// ratification that never happened — rationale says so plainly.
let backfilled = false;
export function ensureGoalsBackfilled(): void {
  if (backfilled) return;
  backfilled = true;
  const n = backfillGoals();
  if (n) console.log(`goals: adopted ${n} existing connector metric(s) as ratified goals`);
}

export function backfillGoals(): number {
  const db = openDb();
  const procs = db.prepare("SELECT * FROM processes WHERE metric != ''").all() as ProcessRow[];
  let n = 0;
  for (const p of procs) {
    if (ratifiedGoal(p.id)) continue;
    const short = p.id.split("/").pop() ?? p.id;
    const used = (db.prepare("SELECT COUNT(*) c FROM goals WHERE source_id = ?").get(p.id) as { c: number }).c;
    const declared = JSON.parse(p.policy || "{}").guardrails;
    const guardrails: Guardrail[] = Array.isArray(declared)
      ? declared.map((d: unknown) => (typeof d === "string" ? parseLegacyRail(d) : d as Guardrail))
      : [];
    db.prepare(
      "INSERT INTO goals (id, source_id, metric, inverse, guardrails, rationale, status, created_at, ratified_at) VALUES (?,?,?,?,?,?, 'ratified', ?, ?)"
    ).run(`${short}#g${used + 1}`, p.id, p.metric, p.inverse, JSON.stringify(guardrails),
      "Adopted from the connector's existing metric when goals became first-class. Not ratified through review — re-goal the connector to set one deliberately.",
      p.created_at, Date.now());
    // Candidates proposed before goals existed may measure anything at all;
    // any that miss the adopted north star are retired rather than left to
    // fail on accept.
    db.prepare("UPDATE candidates SET status = 'dismissed' WHERE source_id = ? AND status = 'proposed' AND metric != ?").run(p.id, p.metric);
    n++;
  }
  return n;
}
