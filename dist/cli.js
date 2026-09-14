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
    case "browser": {
        const { startChrome, endpoint, chromeAlive, ensureTarget, pageTargets } = await import("./chrome.js");
        const { BROWSER_MODE, BROWSER_PROFILE } = await import("./paths.js");
        if (BROWSER_MODE !== "attach") {
            console.log('browser: OPENXPLI_BROWSER_MODE=launch — no shared browser is used. Unset it to use one.');
            break;
        }
        if (process.argv.includes("--import-profile")) {
            const { importChromeProfile, chromeUserDataDir, chromeProfileDir, profileNames } = await import("./profile.js");
            const { execSync } = await import("node:child_process");
            // Chrome must not be writing the profile while it is copied, and it must
            // not be holding the destination either.
            const busy = (pattern) => { try {
                return execSync(`pgrep -f ${JSON.stringify(pattern)} | head -1`, { encoding: "utf8" }).trim();
            }
            catch {
                return "";
            } };
            if (busy(`user-data-dir=${BROWSER_PROFILE}`))
                throw new Error('The OpenXPLI browser is open on the destination. Quit it, then run this again.');
            const userData = chromeUserDataDir();
            const profile = chromeProfileDir(userData);
            if (busy("MacOS/Google Chrome"))
                console.log("note: Chrome is running — quitting it first gives a cleaner copy of the cookie store.");
            console.log(`importing "${profile}" from ${userData}${profileNames(userData).length > 1 ? ` (profiles: ${profileNames(userData).join(", ")})` : ""}`);
            const r = importChromeProfile({ userData, profile, force: process.argv.includes("--force") });
            console.log(`browser: imported ${(r.bytes / 1e6).toFixed(0)} MB — the OpenXPLI browser now carries your sign-ins.`);
            console.log("Saved passwords, cards and addresses were NOT copied; sessions come from cookies and site storage.");
            console.log('Run "openxpli browser" to open it.');
            break;
        }
        if (process.argv.includes("--reset-checks")) {
            const { playbookFor, clearChallengeCookies } = await import("./browser-scout.js");
            const { attachSession } = await import("./chrome.js");
            const pb = playbookFor("ChatGPT Ads");
            if (!pb)
                throw new Error("no playbook to reset");
            await startChrome(false);
            await ensureTarget();
            const session = await attachSession(false);
            try {
                const dropped = await clearChallengeCookies(session.ctx, pb);
                console.log(`browser: dropped ${dropped.length} challenge cookie(s) for ${pb.name}${dropped.length ? ":\n  " + dropped.join("\n  ") : ""}`);
                console.log("Your sign-ins are untouched — these were bot-check cookies only.");
            }
            finally {
                await session.close();
            }
            break;
        }
        const already = await chromeAlive();
        await startChrome(false);
        // A running Chrome with every window closed still answers the port, so
        // "already open" is not the same as "has a window".
        const windows = already ? (await pageTargets()).length : 0;
        await ensureTarget();
        console.log(`browser: ${!already ? "opened" : windows ? "already open" : "was running with no window — reopened one"} on ${endpoint()}`);
        console.log(`profile: ${BROWSER_PROFILE}`);
        console.log("Sign in to your tools in this window as you normally would. Leave it open; OpenXPLI attaches to it when it needs to read or act.");
        break;
    }
    case "browser-job": {
        const { runLearningJob } = await import("./learning-jobs.js");
        try {
            await runLearningJob(process.argv[3]);
        }
        catch (e) {
            console.error(String(e));
            process.exitCode = 1;
        }
        break;
    }
    case "kit-build": {
        const { buildKit } = await import("./kits.js");
        try {
            const kit = await buildKit(process.argv[3]);
            console.log(`${kit.id}: ${kit.state}${kit.error ? " — " + kit.error : ""}`);
            if (kit.state === "failed" || kit.state === "needs-input")
                process.exitCode = 1;
        }
        catch (e) {
            console.error(String(e));
            process.exitCode = 1;
        }
        break;
    }
    case "prepare": {
        const { requestKit, buildKit } = await import("./kits.js");
        try {
            if (!process.argv[3])
                throw new Error("usage: openxpli prepare <candidate-id>");
            const queued = requestKit(process.argv[3], false);
            const kit = await buildKit(queued.id);
            console.log(`Kit ${kit.id}: ${kit.state}. Open the console to review and download. Nothing has been launched.${kit.error ? " " + kit.error : ""}`);
            if (kit.state === "failed" || kit.state === "needs-input")
                process.exitCode = 1;
        }
        catch (e) {
            console.error(String(e));
            process.exitCode = 1;
        }
        break;
    }
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
    case "plan": {
        // Read-only rehearsal against the live account: what WOULD change.
        const { act, playbookFor: pbf } = await import("./browser-scout.js");
        const expId = process.argv[3];
        try {
            if (!expId)
                throw new Error("usage: openxpli plan <experiment-id>");
            const row = openDb().prepare("SELECT e.*, p.tool FROM experiments e JOIN processes p ON p.id = e.process_id WHERE e.id = ?").get(expId);
            if (!row)
                throw new Error(`plan: no such experiment: ${expId}`);
            const pb = pbf(row.tool);
            if (!pb)
                throw new Error(`plan: no playbook for ${row.tool}`);
            console.log(await act(row, pb, "plan"));
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
        break;
    }
    case "activate": {
        const { act, playbookFor: pbf } = await import("./browser-scout.js");
        const expId = process.argv[3];
        try {
            if (!expId)
                throw new Error("usage: openxpli activate <experiment-id>");
            const db = openDb();
            const row = db.prepare("SELECT e.*, p.tool, p.autonomy FROM experiments e JOIN processes p ON p.id = e.process_id WHERE e.id = ?").get(expId);
            if (!row)
                throw new Error(`activate: no such experiment: ${expId}`);
            if (row.status !== "launching")
                throw new Error(`activate: ${expId} is ${row.status}, not awaiting activation`);
            const pb = pbf(row.tool);
            if (!pb)
                throw new Error(`activate: no playbook for ${row.tool}`);
            console.log(await act(row, pb, "apply", false));
            db.prepare("UPDATE experiments SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), expId);
            console.log(`${expId} is live — hour 0 is now.`);
        }
        catch (e) {
            console.error(String(e instanceof Error ? e.message : e));
            process.exitCode = 1;
        }
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
    case "rescout":
    case "signin": {
        const { queueLearningJob, runLearningJob, getLearningJob } = await import("./learning-jobs.js");
        const { signin, playbookForUrl } = await import("./browser-scout.js");
        try {
            const sourceId = process.argv[3];
            if (!sourceId)
                throw new Error(`usage: openxpli ${cmd} <connector-id>`);
            if (cmd === "signin" && /^https?:/.test(sourceId))
                await signin(playbookForUrl(sourceId));
            else {
                const job = queueLearningJob(sourceId, cmd === "signin" ? "signin" : "learn", false);
                await runLearningJob(job.id);
                const result = getLearningJob(job.id);
                console.log(`${sourceId}: browser task ${result.status}. See the console for status and next steps.`);
                if (result.status === "failed")
                    process.exitCode = 1;
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
  prepare <cand>  prepare copy, image and instructions for manual setup
  accept <cand>   queue an experiment kit (alias; never launches)
  dismiss <cand>  dismiss a candidate
  rescout <conn>  throw away proposed candidates and scout 3 fresh ones
  browser [--import-profile [--force]] [--reset-checks]
                  --import-profile clones your signed-in Chrome profile once, so
                  OpenXPLI inherits your logins (SSO included) with no new
                  sign-in; passwords and cards are not copied. Plain "browser"
                  opens the OpenXPLI browser — a real Chrome you sign into
                  normally (SSO, password manager, 2FA all work); it stays open
                  and OpenXPLI attaches to it instead of driving its own profile
  signin <conn>   open the tool's sign-in page in that browser — you sign in,
                  OpenXPLI never sees the password, and the session persists
  autonomy <conn> set shadow or human-gated mode; automatic execution is disabled
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
