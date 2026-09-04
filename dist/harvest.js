import { writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { resolveBinding, readHoldout } from "./bindings.js";
import { maybeAnalyze } from "./scout.js";
import { existsSync } from "node:fs";
import { playbookFor, BROWSER_PROFILE } from "./browser-scout.js";
import { runAutonomy } from "./autonomy.js";
import { recordOutcome, setHoldoutState } from "./outcomes.js";
import { writeDecisionRecord, appendValidation } from "./ledger.js";
import { HEARTBEAT_PATH, HOUR_MS, DEFAULT_RUN_HOURS, ensureDirs, DATA_DIR, HOLDOUT_SHARE, VALIDATION_HOURS, REGRESS_WINDOW_HOURS, } from "./paths.js";
// The hourly read is a data contract, not a cron contract: every invocation
// computes which observations are DUE and fills them (backfilling missed
// hours when the binding can read history). Idempotent; safe to run anytime.
export function harvest(now = Date.now()) {
    ensureDirs();
    // Single-instance lock: launchd's RunAtLoad tick and a manual run can
    // race. Observations are race-safe (PK), but git ledger commits are not.
    const lockDir = join(DATA_DIR, "harvest.lock");
    try {
        mkdirSync(lockDir);
    }
    catch {
        const age = Date.now() - (statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs ?? 0);
        if (age < 10 * 60_000) {
            console.log("harvest: another harvest is running, skipping (lock held)");
            return;
        }
        rmSync(lockDir, { recursive: true, force: true }); // stale lock (>10m): crashed run
        mkdirSync(lockDir);
    }
    const started = Date.now();
    let filled = 0, gaps = 0, finalized = 0, errors = [];
    try {
        const db = openDb();
        maybeAnalyze();
        // Self-heal: a crash between finalize and the ledger write leaves a
        // decided experiment with no record. Repair before doing new work.
        const unledgered = db.prepare("SELECT * FROM experiments WHERE status IN ('won','failed') AND record_id IS NULL").all();
        for (const exp of unledgered) {
            const proc = db.prepare("SELECT * FROM processes WHERE id = ?").get(exp.process_id);
            const counts = db.prepare("SELECT SUM(missing = 0) AS ok, SUM(missing = 1) AS miss FROM observations WHERE experiment_id = ? AND phase = 'run'").get(exp.id);
            const rec = writeDecisionRecord(proc, exp, exp.final_multiple ?? 1.0, counts.ok ?? 0, counts.miss ?? 0, exp.status === "won");
            db.prepare("UPDATE experiments SET record_id = ? WHERE id = ?").run(rec, exp.id);
            if (exp.status === "won") {
                db.prepare("INSERT OR IGNORE INTO holdouts (experiment_id, process_id, started_at, ends_at, share, status) VALUES (?,?,?,?,?, 'validating')").run(exp.id, exp.process_id, exp.ends_at, exp.ends_at + VALIDATION_HOURS * HOUR_MS, HOLDOUT_SHARE);
            }
            console.log(`repaired: ledgered ${exp.id} (${exp.status}) -> ${rec}`);
        }
        const exps = db
            .prepare("SELECT * FROM experiments WHERE status = 'running'")
            .all();
        for (const exp of exps) {
            const proc = db.prepare("SELECT * FROM processes WHERE id = ?").get(exp.process_id);
            const real = !!(playbookFor(proc.tool) && existsSync(BROWSER_PROFILE));
            const binding = real ? { name: "browser", canBackfill: false, read: () => null } : resolveBinding(exp.process_id);
            const runHours = Math.max(1, Math.round((exp.ends_at - exp.started_at) / HOUR_MS));
            const dueHours = Math.min(runHours, Math.floor((now - exp.started_at) / HOUR_MS));
            const have = new Set(db.prepare("SELECT hour FROM observations WHERE experiment_id = ?").all(exp.id).map(r => r.hour));
            const insert = db.prepare("INSERT OR IGNORE INTO observations (experiment_id, hour, ts, multiple, sigma, source, missing) VALUES (?,?,?,?,?,?,?)");
            for (let hour = 1; hour <= dueHours; hour++) {
                if (have.has(hour))
                    continue;
                const isPast = hour < dueHours;
                const reading = (isPast && !binding.canBackfill) ? null : binding.read(exp, hour);
                if (reading) {
                    insert.run(exp.id, hour, exp.started_at + hour * HOUR_MS, reading.multiple, reading.sigma, reading.source, 0);
                    filled++;
                }
                else {
                    // Unfillable gap: recorded honestly; the stats know less, the UI shows it.
                    insert.run(exp.id, hour, exp.started_at + hour * HOUR_MS, null, null, binding.name, 1);
                    gaps++;
                }
            }
            // Finalize: 7 days elapsed -> verdict. Below or at x1.00 is never adopted.
            if (now >= exp.ends_at) {
                const last = db.prepare("SELECT multiple FROM observations WHERE experiment_id = ? AND missing = 0 ORDER BY hour DESC LIMIT 1").get(exp.id);
                const finalMultiple = last?.multiple ?? 1.0;
                const status = finalMultiple > 1.0 ? "won" : "failed";
                const counts = db.prepare("SELECT SUM(missing = 0) AS ok, SUM(missing = 1) AS miss FROM observations WHERE experiment_id = ?").get(exp.id);
                db.prepare("UPDATE experiments SET status = ?, final_multiple = ? WHERE id = ?").run(status, finalMultiple, exp.id);
                const rec = writeDecisionRecord(proc, exp, finalMultiple, counts.ok ?? 0, counts.miss ?? 0);
                db.prepare("UPDATE experiments SET record_id = ? WHERE id = ?").run(rec, exp.id);
                recordOutcome({ ...exp, status, final_multiple: finalMultiple }, status, finalMultiple, rec);
                // Trailing regression finder: a won variant is promoted, but a small
                // share stays on the old control to validate the win persists.
                if (status === "won") {
                    db.prepare("INSERT OR IGNORE INTO holdouts (experiment_id, process_id, started_at, ends_at, share, status) VALUES (?,?,?,?,?, 'validating')").run(exp.id, exp.process_id, exp.ends_at, exp.ends_at + VALIDATION_HOURS * HOUR_MS, HOLDOUT_SHARE);
                    console.log(`holdout opened for ${exp.id}: ${HOLDOUT_SHARE * 100}% stays on old control for ${VALIDATION_HOURS / 24}d`);
                }
                console.log(`finalized ${exp.id}: ${status} ${finalMultiple.toFixed(3)}x -> ledger ${rec}`);
                finalized++;
            }
        }
        // ── Validation phase: harvest holdout reads and decide exits ──
        const holdouts = db.prepare("SELECT * FROM holdouts WHERE status = 'validating'").all();
        for (const h of holdouts) {
            const exp = db.prepare("SELECT * FROM experiments WHERE id = ?").get(h.experiment_id);
            const procH = db.prepare("SELECT * FROM processes WHERE id = ?").get(h.process_id);
            const realH = !!(playbookFor(procH.tool) && existsSync(BROWSER_PROFILE));
            const hourOffset = Math.max(DEFAULT_RUN_HOURS, Math.round((exp.ends_at - exp.started_at) / HOUR_MS));
            const dueHours = Math.min(VALIDATION_HOURS, Math.floor((now - h.started_at) / HOUR_MS));
            const have = new Set(db.prepare("SELECT hour FROM observations WHERE experiment_id = ? AND phase = 'holdout'").all(exp.id)
                .map((r) => r.hour - hourOffset));
            const insert = db.prepare("INSERT OR IGNORE INTO observations (experiment_id, hour, ts, multiple, sigma, source, missing, phase) VALUES (?,?,?,?,?,?,?, 'holdout')");
            for (let hour = 1; hour <= dueHours; hour++) {
                if (have.has(hour))
                    continue;
                if (realH) {
                    // real connectors: holdout hours are read by the browser tick; past
                    // misses are honest gaps, never synthetic
                    if (hour < dueHours) {
                        insert.run(exp.id, hourOffset + hour, h.started_at + hour * HOUR_MS, null, null, "browser", 1);
                        gaps++;
                    }
                    continue;
                }
                const r = readHoldout(exp, hour, VALIDATION_HOURS);
                insert.run(exp.id, hourOffset + hour, h.started_at + hour * HOUR_MS, r.multiple, r.sigma, r.source, 0);
                filled++;
            }
            // Early exit: sustained drop — trailing window mean at/below x1.00.
            const trail = db.prepare("SELECT AVG(multiple) m, COUNT(*) n FROM (SELECT multiple FROM observations WHERE experiment_id = ? AND phase = 'holdout' AND missing = 0 ORDER BY hour DESC LIMIT ?)").get(exp.id, REGRESS_WINDOW_HOURS);
            const windowFull = trail.n >= REGRESS_WINDOW_HOURS;
            const sustainedDrop = windowFull && (trail.m ?? 1) <= 1.0;
            const windowDone = now >= h.ends_at;
            if (sustainedDrop || windowDone) {
                const last = db.prepare("SELECT multiple FROM observations WHERE experiment_id = ? AND phase = 'holdout' AND missing = 0 ORDER BY hour DESC LIMIT 1").get(exp.id);
                const vsHoldout = sustainedDrop ? (trail.m ?? 1) : (last?.multiple ?? 1);
                const outcome = vsHoldout > 1.0 ? "validated" : "regressed";
                db.prepare("UPDATE holdouts SET status = ?, final_multiple = ? WHERE experiment_id = ?").run(outcome, vsHoldout, exp.id);
                setHoldoutState(exp.id, outcome, vsHoldout);
                if (outcome === "regressed")
                    db.prepare("UPDATE processes SET status = 'reverted' WHERE id = ?").run(h.process_id);
                if (exp.record_id)
                    appendValidation(exp.record_id, outcome, vsHoldout, dueHours, h.share, sustainedDrop && !windowDone);
                console.log(`holdout ${outcome} for ${exp.id}: ${vsHoldout.toFixed(3)}x vs holdout${sustainedDrop && !windowDone ? " (early, sustained drop)" : ""}`);
                finalized++;
            }
        }
        runAutonomy();
    }
    catch (e) {
        errors.push(String(e));
    }
    finally {
        rmSync(lockDir, { recursive: true, force: true });
    }
    const beat = {
        last_tick: new Date(now).toISOString(),
        ok: errors.length === 0,
        filled, gaps, finalized,
        duration_ms: Date.now() - started,
        errors,
    };
    writeFileSync(HEARTBEAT_PATH, JSON.stringify(beat, null, 2));
    console.log(`harvest: +${filled} observations, ${gaps} gaps, ${finalized} finalized${errors.length ? `, ERRORS: ${errors.join("; ")}` : ""}`);
    if (errors.length)
        process.exitCode = 1;
}
