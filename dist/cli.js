#!/usr/bin/env node
import { openDb } from "./db.js";
import { harvest } from "./harvest.js";
import { init } from "./init.js";
import { doctor } from "./doctor.js";
import { HOUR_MS, DEFAULT_RUN_HOURS, HEARTBEAT_PATH } from "./paths.js";
import { existsSync, readFileSync } from "node:fs";
const cmd = process.argv[2];
async function enrollDemo() {
    // Seeds the ads.openai.com connector — the wedge this engine is being built
    // for — with one finished experiment (exercises finalize -> ledger -> record)
    // and one mid-flight run started 30h ago (exercises catch-up backfill).
    const db = openDb();
    const now = Date.now();
    const id = "ads-openai/main-account";
    db.prepare("INSERT OR IGNORE INTO processes (id, tool, metric, inverse, autonomy, status, policy, created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, "ChatGPT Ads", "cost per acquisition", 1, "human-gated", "running", JSON.stringify({ guardrails: ["conversion volume must not drop", "daily spend must not rise"], blast_radius: "$250/day spend cap" }), now);
    const { ratifiedGoal, adoptGoal } = await import("./goals.js");
    const gid = ratifiedGoal(id)?.id
        ?? adoptGoal(id, "cost per acquisition", 1, ["conversion volume must not drop", "daily spend must not rise"], "Ties the account to what a customer actually costs. Guardrailed on volume because CPA is trivially improved by simply buying less.");
    const { startExperiment } = await import("./enroll.js");
    const ins = db.prepare(`INSERT OR IGNORE INTO experiments (id, process_id, field, control_value, variant_value, started_at, ends_at,
       status, goal_id, share, holdout_field, holdout_value, holdout_share) VALUES (?,?,?,?,?,?,?, 'running', ?,?,?,?,?)`);
    // Old enough that it finalizes on the first harvest. Its holdout arm is A/A:
    // nothing had been adopted when it started.
    const doneStart = now - 520 * HOUR_MS;
    ins.run("main-account/0819", id, "creative format", "static image", "short motion loop", doneStart, doneStart + DEFAULT_RUN_HOURS * HOUR_MS, gid, 0.4, "creative format", "static image", 0.2);
    // The live run's holdout is A/A too: the first experiment has not been merged,
    // so there is still no adopted change to re-test.
    const liveStart = now - 30 * HOUR_MS;
    ins.run("main-account/0825", id, "bid", "current CPC bid", "bid -15% with dayparting", liveStart, liveStart + DEFAULT_RUN_HOURS * HOUR_MS, gid, 0.4, "bid", "current CPC bid", 0.2);
    void startExperiment;
    console.log(`enrolled demo connector ${id} (ChatGPT Ads, goal: cost per acquisition) with 2 experiments (1 completed, 1 running)`);
}
function status() {
    const db = openDb();
    const procs = db.prepare("SELECT COUNT(*) c FROM processes").get().c;
    const byStatus = db.prepare("SELECT status, COUNT(*) c FROM experiments GROUP BY status").all();
    const obs = db.prepare("SELECT COUNT(*) c FROM observations").get().c;
    const holdouts = db.prepare("SELECT status, COUNT(*) c FROM holdouts GROUP BY status").all();
    console.log(`processes: ${procs}`);
    console.log(`experiments: ${byStatus.map((r) => `${r.c} ${r.status}`).join(", ") || "none"}`);
    console.log(`holdouts: ${holdouts.map((r) => `${r.c} ${r.status}`).join(", ") || "none"}`);
    console.log(`observations: ${obs}`);
    if (existsSync(HEARTBEAT_PATH))
        console.log(`heartbeat: ${readFileSync(HEARTBEAT_PATH, "utf8").trim()}`);
}
switch (cmd) {
    case "init":
        init();
        break;
    case "ui": {
        const pi = process.argv.indexOf("--port");
        const { ui } = await import("./ui.js");
        ui(pi > -1 ? Number(process.argv[pi + 1]) : 41100, !process.argv.includes("--no-open"));
        break;
    }
    case "harvest":
        harvest();
        break;
    case "goals": {
        const { proposeGoals, listGoals, ratifiedGoal, regoal, parseGuardrails, ensureGoalsBackfilled } = await import("./goals.js");
        ensureGoalsBackfilled();
        const id = process.argv[3];
        if (!id) {
            console.error("usage: openxpli goals <connector> [--regoal]");
            process.exitCode = 1;
            break;
        }
        try {
            const live = ratifiedGoal(id);
            if (live && !process.argv.includes("--regoal")) {
                console.log(`${id} is accountable to: ${live.metric}${live.inverse ? " (lower is better)" : ""}`);
                const gr = parseGuardrails(live.guardrails);
                console.log(gr.length ? gr.map((g) => `  guardrail: ${g.metric} ${g.direction}`).join("\n") : "  guardrail: none declared");
                if (live.record_id)
                    console.log(`  ledger: ${live.record_id}`);
                console.log(`\nTo change it: openxpli goals ${id} --regoal`);
                break;
            }
            const rows = process.argv.includes("--regoal") ? regoal(id) : proposeGoals(id);
            console.log(`North stars proposed for ${id} — ratify one with \`openxpli ratify <goal-id>\`:\n`);
            for (const g of rows) {
                console.log(`  ${g.id}  ${g.metric}${g.inverse ? " (lower is better)" : ""}`);
                console.log(`      ${g.rationale}`);
                const gr = parseGuardrails(g.guardrails);
                if (gr.length)
                    console.log(`      guardrails: ${gr.map((x) => `${x.metric} ${x.direction}`).join(", ")}`);
                console.log("");
            }
            void listGoals;
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "ratify": {
        const { ratifyGoal } = await import("./goals.js");
        const { maybeAnalyze } = await import("./scout.js");
        try {
            console.log(ratifyGoal(process.argv[3]));
            maybeAnalyze();
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "tick": {
        const { browserReads } = await import("./browser-scout.js");
        await browserReads().catch((e) => console.log(`tick: browser reads skipped — ${String(e).slice(0, 140)}`));
        harvest();
        break;
    }
    case "recipe": {
        const { makeRecipe, clearLock } = await import("./browser-scout.js");
        const expId = process.argv[3];
        try {
            if (!expId)
                throw new Error("usage: openxpli recipe <experiment-id>");
            await makeRecipe(expId);
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        finally {
            if (expId && process.argv.includes("--child"))
                clearLock(`recipe-${expId.replace(/[^a-z0-9]/gi, "-")}.lock`);
        }
        break;
    }
    case "doctor":
        doctor();
        break;
    case "status":
        status();
        break;
    case "add": {
        const { addSource } = await import("./scout.js");
        const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
        try {
            const { message, candidates } = addSource(process.argv[3] ?? "", flag("tool") ?? "");
            console.log(message + "\n");
            for (const c of candidates)
                console.log(`  [${c.id}] ${c.field}: ${c.control_value} -> ${c.variant_value}\n         metric: ${c.metric}${c.inverse ? " (1/x)" : ""} · expected ~x${c.expected_multiple.toFixed(2)}\n         ${c.rationale}\n         accept: openxpli accept ${c.id}\n`);
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "candidates": {
        const { listCandidates, maybeAnalyze } = await import("./scout.js");
        maybeAnalyze();
        for (const c of listCandidates(process.argv[3]))
            console.log(`[${c.id}] ${c.source_id} — ${c.field}: ${c.control_value} -> ${c.variant_value} (${c.metric}, ~x${c.expected_multiple.toFixed(2)})`);
        break;
    }
    case "rescout": {
        const { rescout } = await import("./scout.js");
        try {
            if (!process.argv[3])
                throw new Error("usage: openxpli rescout <connector>");
            const cands = await rescout(process.argv[3], process.argv.includes("--child"));
            for (const c of cands)
                console.log(`[${c.id}] ${c.field}: ${c.control_value} -> ${c.variant_value}\n       ${c.rationale}\n       ${c.metric}${c.inverse ? " (1/x)" : ""} · expected ~x${c.expected_multiple.toFixed(2)} · accept: openxpli accept ${c.id}`);
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "signin": {
        const { signin, playbookFor, BROWSER_PROFILE } = await import("./browser-scout.js");
        const { openDb } = await import("./db.js");
        const { spawnDetachedScout } = await import("./scout.js");
        try {
            const arg = process.argv[3];
            let url = arg && /^https?:/.test(arg) ? arg : undefined;
            const db = openDb();
            let connector;
            if (!url && arg) {
                const p = db.prepare("SELECT tool FROM processes WHERE id = ?").get(arg);
                const pb = p && playbookFor(p.tool);
                if (pb) {
                    url = pb.url;
                    connector = arg;
                }
            }
            if (!url)
                throw new Error("usage: openxpli signin <connector-id|url>");
            await signin(url);
            console.log(`session saved to ${BROWSER_PROFILE}`);
            if (connector) {
                // the browser just closed: learning begins now
                db.prepare("UPDATE candidates SET status = 'dismissed' WHERE source_id = ? AND status = 'proposed'").run(connector);
                db.prepare("UPDATE processes SET status = 'shadow', created_at = ? WHERE id = ?").run(Date.now(), connector);
                spawnDetachedScout(connector);
                console.log(`learning: OpenXPLI is crawling the account read-only and building the knowledge map — fresh suggestions land on the connector shortly`);
            }
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "act": {
        const { act, playbookFor: pbFor, RECEIPTS_DIR } = await import("./browser-scout.js");
        const { openDb } = await import("./db.js");
        const { harvest } = await import("./harvest.js");
        const db = openDb();
        const expId = process.argv[3];
        try {
            if (!expId)
                throw new Error("usage: openxpli act <experiment-id>");
            const exp = db.prepare("SELECT e.*, p.tool FROM experiments e JOIN processes p ON p.id = e.process_id WHERE e.id = ?").get(expId);
            if (!exp)
                throw new Error(`no such experiment: ${expId}`);
            const pb = pbFor(exp.tool);
            if (!pb)
                throw new Error(`no playbook for ${exp.tool}`);
            const summary = await act(exp, pb);
            const now = Date.now();
            db.prepare("UPDATE experiments SET status = 'running', started_at = ?, ends_at = ?, launch_note = ? WHERE id = ?")
                .run(now, now + 7 * 24 * 3_600_000, `launched: ${summary}`.slice(0, 500), expId);
            console.log(`act: ${expId} launched — ${summary}`);
            console.log(`act: receipts in ${RECEIPTS_DIR}`);
            harvest();
        }
        catch (e) {
            const msg = String(e instanceof Error ? e.message : e).slice(0, 500);
            if (expId)
                db.prepare("UPDATE experiments SET launch_note = ? WHERE id = ?").run(`launch failed: ${msg}`, expId);
            console.error(msg);
            process.exitCode = 1;
        }
        break;
    }
    case "accept":
    case "dismiss": {
        const { acceptCandidate, dismissCandidate } = await import("./scout.js");
        try {
            if (!process.argv[3])
                throw new Error(`usage: openxpli ${cmd} <candidate-id>`);
            console.log(cmd === "accept" ? acceptCandidate(process.argv[3]) : dismissCandidate(process.argv[3]));
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "enroll": {
        if (process.argv[3] === "--demo") {
            await enrollDemo();
            break;
        }
        const { enrollProcess } = await import("./enroll.js");
        const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
        const guardrails = process.argv.flatMap((a, i) => (a === "--guardrail" ? [process.argv[i + 1]] : []));
        try {
            console.log(enrollProcess({
                id: flag("id") ?? "", tool: flag("tool") ?? "", metric: flag("metric") ?? "",
                inverse: process.argv.includes("--inverse"),
                autonomy: flag("autonomy"), guardrails, blastRadius: flag("blast-radius"),
            }));
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "start": {
        const { startExperiment } = await import("./enroll.js");
        const flag = (n) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : undefined; };
        try {
            if (!process.argv[3] || process.argv[3].startsWith("--"))
                throw new Error("usage: openxpli start <process-id> --field X --control A --variant B [--on \"ad name\"] [--days N] [--share 0.5]");
            console.log(startExperiment(process.argv[3], flag("field") ?? "", flag("control") ?? "", flag("variant") ?? "", Number(flag("days") ?? 7), "running", flag("share") != null ? Number(flag("share")) : undefined, flag("on"), flag("baseline") != null ? Number(flag("baseline")) : undefined, flag("unit")));
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "autonomy": {
        const { setAutonomy } = await import("./autonomy.js");
        const li = process.argv.indexOf("--level");
        try {
            if (!process.argv[3] || li < 0)
                throw new Error("usage: openxpli autonomy <connector> --level human-gated|auto-start|auto-merge");
            console.log(setAutonomy(process.argv[3], process.argv[li + 1]));
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "approve":
    case "reject":
    case "extend":
    case "kill": {
        const { approve, reject, extend, kill } = await import("./review.js");
        const arg = process.argv[3];
        try {
            if (!arg)
                throw new Error(`usage: openxpli ${cmd} <${cmd === "approve" || cmd === "reject" ? "record-id" : "experiment-id"}>${cmd === "extend" ? " [--days N]" : ""}`);
            if (cmd === "approve")
                console.log(approve(arg));
            else if (cmd === "reject")
                console.log(reject(arg));
            else if (cmd === "kill")
                console.log(kill(arg));
            else {
                const di = process.argv.indexOf("--days");
                console.log(extend(arg, di > -1 ? Number(process.argv[di + 1]) : 7));
            }
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    default:
        console.log(`openxpli — the loop engine (scaffold)

usage: openxpli <command>
  init            create data dir, db, git ledger; install hourly launchd job
  add <account>   add a Connector (--tool "Klaviyo") — starts in shadow mode,
                  read-only; OpenXPLI analyzes it and suggests top 3 experiments
  candidates      list proposed experiment candidates [for one connector]
  accept <cand>   accept a candidate — starts the experiment
  dismiss <cand>  dismiss a candidate
  rescout <conn>  throw away proposed candidates and scout 3 fresh ones
  signin <conn>   open a Chrome window to sign in to the tool once — enables
                  real scouting (OpenXPLI rides the session, read-only)
  autonomy <conn> dial autonomy up/down (--level auto-start|auto-merge; up must be earned)
  tick            hourly heartbeat: real browser reads, then harvest
  harvest         fill all due hourly observations (idempotent, backfilling)
  recipe <exp>    (re)build the metric-extraction recipe for an experiment
  ui              open the local console (http://localhost:41100, 127.0.0.1-only)
  approve <rec>   approve & merge an open decision record
  reject <rec>    reject an open record (control unchanged, holdout cancelled)
  extend <exp>    grant more runtime (--days N, default 7; reopens if decided)
  kill <exp>      kill a running experiment (variant reverted)
  status          counts + last heartbeat
  doctor          health checks (db, ledger, launchd, heartbeat freshness)`);
        if (cmd)
            process.exitCode = 2;
}
