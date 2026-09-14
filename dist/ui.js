import http from "node:http";
import { deleteConnector } from "./connectors.js";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openDb } from "./db.js";
import { LEDGER_DIR } from "./paths.js";
import { approve, reject, extend, kill } from "./review.js";
import { enrollProcess, startExperiment } from "./enroll.js";
import { addSource, acceptCandidate, dismissCandidate, listCandidates, maybeAnalyze, ANALYZE_MS, spawnDetachedScout } from "./scout.js";
import { harvest } from "./harvest.js";
import { autonomyStats, setAutonomy } from "./autonomy.js";
import { ratifyGoal, regoal, alternativeGoals, ratifiedGoal, parseGuardrails, setGoalGuardrails, setPolicy } from "./goals.js";
import { outcomeCounts, ensureOutcomesBackfilled } from "./outcomes.js";
import { splitFor } from "./traffic.js";
import { annualValue } from "./value.js";
import { activeLearningJob, signalLearningJob } from "./learning-jobs.js";
import { playbookFor, startSignin } from "./browser-scout.js";
import { listKits, getKit, requestKit, retryKit, attachKitImage, recordKitLaunch, kitHtml, kitText, kitImage } from "./kits.js";
import { adoptedState } from "./adopted.js";
// Normal CDF via the Abramowitz–Stegun erf approximation.
function phi(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const e = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
    return z >= 0 ? 0.5 * (1 + e) : 0.5 * (1 - e);
}
const CONSOLE_HTML = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "console.html");
function json(res, data) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
}
function summary(db) {
    const procs = db.prepare("SELECT COUNT(*) c, COUNT(DISTINCT tool) t FROM processes").get();
    const won = db.prepare("SELECT COUNT(*) c FROM experiments WHERE status='won'").get().c;
    const failed = db.prepare("SELECT COUNT(*) c FROM experiments WHERE status='failed'").get().c;
    // Multiples only compound within one metric. The old query multiplied a CTR
    // lift by a CPC lift by an open-rate lift and printed one number.
    const byGoal = db.prepare(`SELECT o.goal_id, g.metric, COUNT(*) AS wins, EXP(SUM(LN(o.final_multiple))) AS blended
     FROM outcomes o JOIN goals g ON g.id = o.goal_id
     WHERE o.verdict = 'won' AND o.final_multiple > 0
     GROUP BY o.goal_id ORDER BY wins DESC`).all();
    const blended = byGoal.length === 1 ? byGoal[0].blended : null;
    const regressed = db.prepare("SELECT COUNT(*) c FROM holdouts WHERE status='regressed'").get().c;
    const validated = db.prepare("SELECT COUNT(*) c FROM holdouts WHERE status='validated'").get().c;
    const obs = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(missing),0) g FROM observations").get();
    return {
        processes: procs.c, tools: procs.t,
        won, failed, winRate: won + failed > 0 ? won / (won + failed) : null,
        blendedMultiple: blended,
        blendedByGoal: byGoal,
        unattributedWins: db.prepare("SELECT COUNT(*) c FROM outcomes WHERE verdict='won' AND goal_id IS NULL").get().c,
        regressionsCaught: regressed, validated,
        observations: obs.c, gaps: obs.g,
    };
}
function experiments(db, days) {
    const since = Date.now() - days * 86_400_000;
    const exps = db.prepare("SELECT e.*, p.tool, p.metric, p.policy FROM experiments e JOIN processes p ON p.id = e.process_id WHERE e.started_at >= ? ORDER BY e.started_at").all(since);
    for (const e of exps) {
        e.series = db.prepare("SELECT hour, multiple, holdout_multiple, sigma, phase, missing FROM observations WHERE experiment_id = ? ORDER BY hour").all(e.id);
        e.holdout = db.prepare("SELECT * FROM holdouts WHERE experiment_id = ?").get(e.id) ?? null;
        e.run_hours = Math.max(1, Math.round((e.ends_at - e.started_at) / 3_600_000));
        e.policy = JSON.parse(e.policy || "{}");
        const runObs = e.series
            .filter((o) => o.phase === "run" && !o.missing && o.multiple != null);
        const lastObs = runObs[runObs.length - 1];
        e.p_improvement = lastObs ? phi((lastObs.multiple - 1) / Math.max(lastObs.sigma ?? 0.001, 0.001)) : null;
    }
    return exps;
}
function records() {
    let files = [];
    try {
        files = readdirSync(LEDGER_DIR).filter((f) => f.startsWith("REC-")).sort();
    }
    catch { /* no ledger yet */ }
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
function processes(db) {
    ensureOutcomesBackfilled();
    maybeAnalyze();
    const procs = db.prepare("SELECT * FROM processes ORDER BY created_at").all();
    for (const p of procs) {
        const latest = db.prepare(`SELECT e.id, e.status, e.final_multiple, e.record_id,
              (SELECT multiple FROM observations WHERE experiment_id = e.id AND missing = 0 ORDER BY hour DESC LIMIT 1) AS last_multiple,
              (SELECT MAX(ts) FROM observations WHERE experiment_id = e.id) AS updated
       FROM experiments e WHERE e.process_id = ? ORDER BY e.started_at DESC LIMIT 1`).get(p.id) ?? null;
        p.latest = latest;
        p.policy_raw = p.policy;
        p.policy = JSON.parse(p.policy || "{}");
        p.candidates = listCandidates(p.id).map((c) => ({ ...c, power: c.power ? JSON.parse(c.power) : null }));
        p.experiments = db.prepare(`SELECT e.id, e.status, e.field, e.control_value, e.variant_value, e.started_at, e.ends_at,
              e.final_multiple, e.record_id, e.launch_note, e.share, e.goal_id, e.holdout_share, e.holdout_field, e.holdout_value, e.object, e.baseline, e.baseline_unit, e.baseline_inverse, e.value_basis, e.power,
              (SELECT multiple FROM observations WHERE experiment_id = e.id AND missing = 0 ORDER BY hour DESC LIMIT 1) AS last_multiple,
              (SELECT status FROM holdouts WHERE experiment_id = e.id) AS holdout_status
       FROM experiments e WHERE e.process_id = ? ORDER BY e.started_at DESC`).all(p.id);
        p.analyze_eta = p.created_at + ANALYZE_MS;
        p.autonomy_stats = autonomyStats(p.id);
        p.map = db.prepare("SELECT content FROM knowledge WHERE source_id = ? AND kind = 'map'").get(p.id)?.content ?? null;
        const g = ratifiedGoal(p.id);
        p.goal = g ? { ...g, guardrails: parseGuardrails(g.guardrails) } : null;
        p.goal_options = alternativeGoals(p.id).map((o) => ({ ...o, guardrails: parseGuardrails(o.guardrails) }));
        p.outcomes = outcomeCounts(p.id);
        p.kits = listKits(p.id);
        p.execution_mode = "manual";
        p.can_learn = !!playbookFor(p.tool);
        const browserJob = activeLearningJob(p.id);
        const learning = db.prepare("SELECT content FROM knowledge WHERE source_id = ? AND key = 'learning-status'").get(p.id);
        p.learning = learning ? { ...JSON.parse(learning.content), active: !!browserJob, kind: browserJob?.kind ?? null,
            continue_requested: !!browserJob?.continue_requested, cancel_requested: !!browserJob?.cancel_requested } : null;
        p.adopted = adoptedState(p.id);
        p.experiments = p.experiments.map((e) => ({
            ...e,
            split: splitFor(e.id),
            power: e.power ? JSON.parse(e.power) : null,
            outcome: db.prepare(`SELECT o.verdict, o.winner, o.final_multiple, o.review_state, o.reviewed_at, o.holdout_state, o.holdout_multiple,
                o.goal_id, o.record_id, o.decided_at, g.metric AS goal_metric, g.inverse AS goal_inverse,
                h.share AS holdout_share, h.ends_at AS holdout_ends_at
         FROM outcomes o
         LEFT JOIN goals g ON g.id = o.goal_id
         LEFT JOIN holdouts h ON h.experiment_id = o.experiment_id
         WHERE o.experiment_id = ?`).get(e.id) ?? null,
        })).map((e) => {
            const er = e;
            const o = e.outcome;
            const vm = JSON.parse(p.policy_raw || "{}").value_model ?? null;
            const adoption = p.adopted.rows.find((r) => r.experiment_id === er.id);
            return {
                ...e,
                value_state: adoption?.state === "live" ? "active" : adoption?.state === "pending" ? "potential" : "historical",
                annual_value: o
                    ? annualValue(o.winner ??
                        (o.verdict === "won" ? "variant" : "control"), o.final_multiple, o.holdout_multiple, o.goal_metric ? { metric: o.goal_metric, inverse: Number(o.goal_inverse) } : null, vm, er.value_basis)
                    : null,
            };
        });
    }
    return procs;
}
export function ui(port, openBrowser) {
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
                let tooLarge = false;
                req.on("data", (c) => {
                    if (tooLarge)
                        return;
                    raw += c;
                    if (Buffer.byteLength(raw) > 17 * 1024 * 1024) {
                        tooLarge = true;
                        res.writeHead(413, { "content-type": "application/json" });
                        res.end(JSON.stringify({ error: "Request too large" }));
                    }
                });
                req.on("end", () => {
                    if (tooLarge)
                        return;
                    try {
                        const b = JSON.parse(raw || "{}");
                        let msg;
                        if (url.pathname === "/api/signin/continue") {
                            msg = signalLearningJob(b.id, "continue");
                        }
                        else if (url.pathname === "/api/learning/cancel") {
                            msg = signalLearningJob(b.id, "cancel");
                        }
                        else if (url.pathname === "/api/signin") {
                            msg = startSignin(b.id);
                        }
                        else if (url.pathname === "/api/kits/prepare") {
                            const kit = requestKit(b.candidate);
                            json(res, { ok: true, kit });
                            return;
                        }
                        else if (url.pathname === "/api/kits/retry") {
                            json(res, { ok: true, kit: retryKit(b.id) });
                            return;
                        }
                        else if (url.pathname === "/api/kits/image") {
                            if (typeof b.image !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(b.image))
                                throw new Error("Upload a PNG image");
                            json(res, { ok: true, kit: attachKitImage(b.id, Buffer.from(b.image, "base64")) });
                            return;
                        }
                        else if (url.pathname === "/api/kits/launched") {
                            json(res, { ok: true, kit: recordKitLaunch(b.id, b.note, b.confirmed) });
                            return;
                        }
                        else if (url.pathname === "/api/approve")
                            msg = approve(b.record);
                        else if (url.pathname === "/api/reject")
                            msg = reject(b.record);
                        else if (url.pathname === "/api/extend")
                            msg = extend(b.experiment, Number(b.days ?? 7));
                        else if (url.pathname === "/api/kill") {
                            msg = kill(b.experiment);
                            harvest();
                        }
                        else if (url.pathname === "/api/enroll")
                            msg = enrollProcess(b);
                        else if (url.pathname === "/api/start") {
                            msg = startExperiment(b.process, b.field, b.control, b.variant, Number(b.days ?? 7), "running", b.share != null ? Number(b.share) : undefined, b.object);
                            harvest();
                        }
                        else if (url.pathname === "/api/connectors/delete")
                            msg = deleteConnector(b.id, b.confirmed);
                        else if (url.pathname === "/api/add") {
                            const r = addSource(b.id, b.tool);
                            msg = r.message;
                        }
                        else if (url.pathname === "/api/accept") {
                            msg = acceptCandidate(b.candidate);
                        }
                        else if (url.pathname === "/api/dismiss")
                            msg = dismissCandidate(b.candidate);
                        else if (url.pathname === "/api/rescout") {
                            const connector = db.prepare("SELECT tool FROM processes WHERE id = ?").get(b.id);
                            if (!connector || !playbookFor(connector.tool))
                                throw new Error("Browser learning is not supported for this connector");
                            spawnDetachedScout(b.id);
                            msg = `Learning queued for ${b.id}. Existing suggestions are kept until the new observations are ready.`;
                        }
                        else if (url.pathname === "/api/autonomy") {
                            msg = setAutonomy(b.id, b.level);
                            harvest();
                        }
                        else if (url.pathname === "/api/ratify") {
                            msg = ratifyGoal(b.goal);
                            maybeAnalyze();
                        }
                        else if (url.pathname === "/api/policy") {
                            msg = setPolicy(b.id, b.patch);
                        }
                        else if (url.pathname === "/api/guardrails") {
                            msg = setGoalGuardrails(b.id, b.rails);
                        }
                        else if (url.pathname === "/api/regoal") {
                            const r = regoal(b.id);
                            msg = `re-opened goal selection for ${b.id} — ${r.length} north stars proposed`;
                        }
                        else {
                            res.writeHead(404);
                            return res.end();
                        }
                        json(res, { ok: true, message: msg });
                    }
                    catch (e) {
                        res.writeHead(400, { "content-type": "application/json" });
                        res.end(JSON.stringify({ error: String(e) }));
                    }
                });
                return;
            }
            if (url.pathname === "/api/kits/file") {
                const id = url.searchParams.get("id") || "";
                const name = url.searchParams.get("name");
                const kit = getKit(id);
                let body, type;
                if (name === "kit.html") {
                    body = kitHtml(kit);
                    type = "text/html; charset=utf-8";
                }
                else if (name === "copy.txt") {
                    body = kitText(kit);
                    type = "text/plain; charset=utf-8";
                }
                else if (name === "kit.json") {
                    body = JSON.stringify(kit, null, 2);
                    type = "application/json";
                }
                else if (name === "creative.png") {
                    const image = kitImage(id);
                    if (!image) {
                        res.writeHead(404);
                        res.end("No image attached");
                        return;
                    }
                    body = image;
                    type = "image/png";
                }
                else {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, { "content-type": type, "content-disposition": `${name === "creative.png" && url.searchParams.get("preview") === "1" ? "inline" : "attachment"}; filename="${name}"`, "x-content-type-options": "nosniff", "cache-control": "no-store" });
                res.end(body);
            }
            else if (url.pathname === "/") {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(readFileSync(CONSOLE_HTML, "utf8").replace("__OPENXPLI_TOKEN__", token));
            }
            else if (url.pathname === "/api/export.csv") {
                const rows = experiments(db, Number(url.searchParams.get("days") ?? 365));
                const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
                const csv = ["experiment,process,tool,field,control,variant,started,ended,status,final_multiple,p_improvement"]
                    .concat(rows.map((e) => [e.id, e.process_id, e.tool, e.field, e.control_value, e.variant_value,
                    new Date(e.started_at).toISOString(), new Date(e.ends_at).toISOString(),
                    e.status, e.final_multiple ?? "", e.p_improvement == null ? "" : e.p_improvement.toFixed(4)].map(esc).join(",")))
                    .join("\n");
                res.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=openxpli-experiments.csv" });
                res.end(csv);
            }
            else if (url.pathname === "/api/summary") {
                json(res, summary(db));
            }
            else if (url.pathname === "/api/experiments") {
                json(res, experiments(db, Number(url.searchParams.get("days") ?? 30)));
            }
            else if (url.pathname === "/api/records") {
                json(res, records());
            }
            else if (url.pathname === "/api/processes") {
                json(res, processes(db));
            }
            else {
                res.writeHead(404, { "content-type": "text/plain" });
                res.end("not found");
            }
        }
        catch (e) {
            if (!res.headersSent)
                res.writeHead(500, { "content-type": "text/plain" });
            res.end(String(e));
        }
    });
    // 127.0.0.1 on purpose: this console must never be reachable from the
    // network by accident. Remote access is the hosted cloud's job.
    server.listen(port, "127.0.0.1", () => {
        const addr = `http://localhost:${port}`;
        console.log(`openxpli console: ${addr}  (Ctrl-C to stop)`);
        if (openBrowser && process.platform === "darwin")
            spawn("open", [addr], { stdio: "ignore" });
    });
}
