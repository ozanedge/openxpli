import http from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openDb } from "./db.js";
import { LEDGER_DIR, DEFAULT_RUN_HOURS } from "./paths.js";
import { approve, reject, extend, kill } from "./review.js";
import { enrollProcess, startExperiment } from "./enroll.js";
import { addSource, acceptCandidate, dismissCandidate, listCandidates, maybeAnalyze, ANALYZE_MS, spawnDetachedScout } from "./scout.js";
import { harvest } from "./harvest.js";
import { autonomyStats, setAutonomy } from "./autonomy.js";
import { ratifyGoal, regoal, listGoals, ratifiedGoal, parseGuardrails } from "./goals.js";
import { outcomeCounts, ensureOutcomesBackfilled } from "./outcomes.js";

// Normal CDF via the Abramowitz–Stegun erf approximation.
function phi(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + e) : 0.5 * (1 - e);
}

const CONSOLE_HTML = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "console.html");

function json(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

function summary(db: ReturnType<typeof openDb>) {
  const procs = db.prepare("SELECT COUNT(*) c, COUNT(DISTINCT tool) t FROM processes").get() as { c: number; t: number };
  const won = (db.prepare("SELECT COUNT(*) c FROM experiments WHERE status='won'").get() as { c: number }).c;
  const failed = (db.prepare("SELECT COUNT(*) c FROM experiments WHERE status='failed'").get() as { c: number }).c;
  // Multiples only compound within one metric. The old query multiplied a CTR
  // lift by a CPC lift by an open-rate lift and printed one number.
  const byGoal = db.prepare(
    `SELECT o.goal_id, g.metric, COUNT(*) AS wins, EXP(SUM(LN(o.final_multiple))) AS blended
     FROM outcomes o JOIN goals g ON g.id = o.goal_id
     WHERE o.verdict = 'won' AND o.final_multiple > 0
     GROUP BY o.goal_id ORDER BY wins DESC`
  ).all() as { goal_id: string; metric: string; wins: number; blended: number }[];
  const blended = byGoal.length === 1 ? byGoal[0].blended : null;
  const regressed = (db.prepare("SELECT COUNT(*) c FROM holdouts WHERE status='regressed'").get() as { c: number }).c;
  const validated = (db.prepare("SELECT COUNT(*) c FROM holdouts WHERE status='validated'").get() as { c: number }).c;
  const obs = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(missing),0) g FROM observations").get() as { c: number; g: number };
  return {
    processes: procs.c, tools: procs.t,
    won, failed, winRate: won + failed > 0 ? won / (won + failed) : null,
    blendedMultiple: blended,
    blendedByGoal: byGoal,
    unattributedWins: (db.prepare("SELECT COUNT(*) c FROM outcomes WHERE verdict='won' AND goal_id IS NULL").get() as { c: number }).c,
    regressionsCaught: regressed, validated,
    observations: obs.c, gaps: obs.g,
  };
}

function experiments(db: ReturnType<typeof openDb>, days: number) {
  const since = Date.now() - days * 86_400_000;
  const exps = db.prepare(
    "SELECT e.*, p.tool, p.metric, p.policy FROM experiments e JOIN processes p ON p.id = e.process_id WHERE e.started_at >= ? ORDER BY e.started_at"
  ).all(since) as Record<string, unknown>[];
  for (const e of exps) {
    e.series = db.prepare(
      "SELECT hour, multiple, sigma, phase, missing FROM observations WHERE experiment_id = ? ORDER BY hour"
    ).all(e.id);
    e.holdout = db.prepare("SELECT * FROM holdouts WHERE experiment_id = ?").get(e.id as string) ?? null;
    e.run_hours = Math.max(1, Math.round(((e.ends_at as number) - (e.started_at as number)) / 3_600_000));
    e.policy = JSON.parse((e.policy as string) || "{}");
    const runObs = (e.series as { phase: string; multiple: number | null; sigma: number | null; missing: number }[])
      .filter((o) => o.phase === "run" && !o.missing && o.multiple != null);
    const lastObs = runObs[runObs.length - 1];
    e.p_improvement = lastObs ? phi(((lastObs.multiple as number) - 1) / Math.max(lastObs.sigma ?? 0.001, 0.001)) : null;
  }
  return exps;
}

function records(): { id: string; title: string; outcome: string; process: string; body: string }[] {
  let files: string[] = [];
  try { files = readdirSync(LEDGER_DIR).filter((f) => f.startsWith("REC-")).sort(); } catch { /* no ledger yet */ }
  return files.map((f) => {
    const body = readFileSync(join(LEDGER_DIR, f), "utf8");
    const title = (body.match(/^# (.+)$/m)?.[1] ?? f).slice(0, 120);
    const statusLine = body.match(/- \*\*status:\*\* (.+)/)?.[1] ?? "";
    const outcome = body.includes("TRAILING REGRESSION") ? "regressed"
      : statusLine.startsWith("merged") ? "merged"
      : statusLine.startsWith("rejected") ? "rejected"
      : statusLine.startsWith("reopened") ? "open"
      : body.includes("VALIDATED") ? "validated"
      : statusLine.startsWith("open") ? "open"
      : body.includes("auto-reverted, not adopted") ? "reverted"
      : "open";
    const process = body.match(/\*\*process:\*\* (\S+)/)?.[1] ?? "";
    return { id: f.replace(".md", ""), title, outcome, process, body };
  });
}

function processes(db: ReturnType<typeof openDb>) {
  ensureOutcomesBackfilled();
  maybeAnalyze();
  const procs = db.prepare("SELECT * FROM processes ORDER BY created_at").all() as Record<string, unknown>[];
  for (const p of procs) {
    const latest = db.prepare(
      `SELECT e.id, e.status, e.final_multiple, e.record_id,
              (SELECT multiple FROM observations WHERE experiment_id = e.id AND missing = 0 ORDER BY hour DESC LIMIT 1) AS last_multiple,
              (SELECT MAX(ts) FROM observations WHERE experiment_id = e.id) AS updated
       FROM experiments e WHERE e.process_id = ? ORDER BY e.started_at DESC LIMIT 1`
    ).get(p.id as string) ?? null;
    p.latest = latest;
    p.policy = JSON.parse((p.policy as string) || "{}");
    p.candidates = listCandidates(p.id as string);
    p.experiments = db.prepare(
      `SELECT e.id, e.status, e.field, e.control_value, e.variant_value, e.started_at, e.ends_at,
              e.final_multiple, e.record_id, e.launch_note,
              (SELECT multiple FROM observations WHERE experiment_id = e.id AND missing = 0 ORDER BY hour DESC LIMIT 1) AS last_multiple,
              (SELECT status FROM holdouts WHERE experiment_id = e.id) AS holdout_status
       FROM experiments e WHERE e.process_id = ? ORDER BY e.started_at DESC`
    ).all(p.id as string);
    p.analyze_eta = (p.created_at as number) + ANALYZE_MS;
    p.autonomy_stats = autonomyStats(p.id as string);
    p.map = (db.prepare("SELECT content FROM knowledge WHERE source_id = ? AND kind = 'map'").get(p.id as string) as { content: string } | undefined)?.content ?? null;
    const g = ratifiedGoal(p.id as string);
    p.goal = g ? { ...g, guardrails: parseGuardrails(g.guardrails) } : null;
    p.goal_options = listGoals(p.id as string).map((o) => ({ ...o, guardrails: parseGuardrails(o.guardrails) }));
    p.outcomes = outcomeCounts(p.id as string);
    p.experiments = (p.experiments as Record<string, unknown>[]).map((e) => ({
      ...e,
      outcome: db.prepare("SELECT verdict, review_state, holdout_state, holdout_multiple, goal_id FROM outcomes WHERE experiment_id = ?").get(e.id as string) ?? null,
    }));
  }
  return procs;
}

export function ui(port: number, openBrowser: boolean): void {
  const db = openDb();
  // Anti-drive-by token: injected into the served page, required on every
  // mutation. A foreign website can POST to localhost but cannot read it.
  const token = randomBytes(16).toString("hex");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "POST") {
        if (req.headers["x-openxpli-token"] !== token) {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "bad or missing token" }));
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", () => {
          try {
            const b = JSON.parse(raw || "{}");
            let msg: string;
            if (url.pathname === "/api/approve") msg = approve(b.record);
            else if (url.pathname === "/api/reject") msg = reject(b.record);
            else if (url.pathname === "/api/extend") msg = extend(b.experiment, Number(b.days ?? 7));
            else if (url.pathname === "/api/kill") { msg = kill(b.experiment); harvest(); }
            else if (url.pathname === "/api/enroll") msg = enrollProcess(b);
            else if (url.pathname === "/api/start") { msg = startExperiment(b.process, b.field, b.control, b.variant, Number(b.days ?? 7)); harvest(); }
            else if (url.pathname === "/api/add") { const r = addSource(b.id, b.tool); msg = r.message; }
            else if (url.pathname === "/api/accept") { msg = acceptCandidate(b.candidate); harvest(); }
            else if (url.pathname === "/api/dismiss") msg = dismissCandidate(b.candidate);
            else if (url.pathname === "/api/rescout") {
              const db2 = openDb();
              db2.prepare("UPDATE candidates SET status = 'dismissed' WHERE source_id = ? AND status = 'proposed'").run(b.id);
              const busy = db2.prepare("SELECT 1 FROM experiments WHERE process_id = ? AND status IN ('running','launching')").get(b.id);
              if (!busy) db2.prepare("UPDATE processes SET status = 'shadow', created_at = ? WHERE id = ?").run(Date.now(), b.id);
              spawnDetachedScout(b.id);
              msg = `rescouting ${b.id} — fresh suggestions shortly`;
            }
            else if (url.pathname === "/api/autonomy") { msg = setAutonomy(b.id, b.level); harvest(); }
            else if (url.pathname === "/api/ratify") { msg = ratifyGoal(b.goal); maybeAnalyze(); }
            else if (url.pathname === "/api/regoal") { const r = regoal(b.id); msg = `re-opened goal selection for ${b.id} — ${r.length} north stars proposed`; }
            else { res.writeHead(404); return res.end(); }
            json(res, { ok: true, message: msg });
          } catch (e) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(e) }));
          }
        });
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(CONSOLE_HTML, "utf8").replace("__OPENXPLI_TOKEN__", token));
      } else if (url.pathname === "/api/export.csv") {
        const rows = experiments(db, Number(url.searchParams.get("days") ?? 365)) as Record<string, unknown>[];
        const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const csv = ["experiment,process,tool,field,control,variant,started,ended,status,final_multiple,p_improvement"]
          .concat(rows.map((e) => [e.id, e.process_id, e.tool, e.field, e.control_value, e.variant_value,
            new Date(e.started_at as number).toISOString(), new Date(e.ends_at as number).toISOString(),
            e.status, e.final_multiple ?? "", e.p_improvement == null ? "" : (e.p_improvement as number).toFixed(4)].map(esc).join(",")))
          .join("\n");
        res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=openxpli-experiments.csv" });
        res.end(csv);
      } else if (url.pathname === "/api/summary") {
        json(res, summary(db));
      } else if (url.pathname === "/api/experiments") {
        json(res, experiments(db, Number(url.searchParams.get("days") ?? 30)));
      } else if (url.pathname === "/api/records") {
        json(res, records());
      } else if (url.pathname === "/api/processes") {
        json(res, processes(db));
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(e));
    }
  });
  // 127.0.0.1 on purpose: this console must never be reachable from the
  // network by accident. Remote access is the hosted cloud's job.
  server.listen(port, "127.0.0.1", () => {
    const addr = `http://localhost:${port}`;
    console.log(`openxpli console: ${addr}  (Ctrl-C to stop)`);
    if (openBrowser && process.platform === "darwin") spawn("open", [addr], { stdio: "ignore" });
  });
}
