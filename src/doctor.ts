import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { DB_PATH, HEARTBEAT_PATH, LEDGER_DIR, PLIST_LABEL } from "./paths.js";

interface Check { name: string; ok: boolean; detail: string; }

export function doctor(): void {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  try {
    const db = openDb();
    const p = (db.prepare("SELECT COUNT(*) c FROM processes").get() as { c: number }).c;
    const e = (db.prepare("SELECT COUNT(*) c FROM experiments WHERE status='running'").get() as { c: number }).c;
    const gaps = (db.prepare("SELECT COUNT(*) c FROM observations WHERE missing=1").get() as { c: number }).c;
    add("database", true, `${DB_PATH} — ${p} processes, ${e} running experiments, ${gaps} recorded gaps`);
  } catch (err) {
    add("database", false, String(err));
  }

  try {
    execFileSync("git", ["-C", LEDGER_DIR, "rev-parse", "HEAD"], { stdio: "ignore" });
    add("ledger", true, `${LEDGER_DIR} — git history present`);
  } catch {
    add("ledger", false, `${LEDGER_DIR} — no git history (run: openxpli init)`);
  }

  const plistPath = join(homedir(), "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
  add("plist", existsSync(plistPath), plistPath);

  try {
    execFileSync("launchctl", ["print", `gui/${userInfo().uid}/${PLIST_LABEL}`], { stdio: "ignore" });
    add("launchd", true, `${PLIST_LABEL} loaded (fires hourly + on load)`);
  } catch {
    add("launchd", false, `${PLIST_LABEL} not loaded (run: openxpli init)`);
  }

  if (existsSync(HEARTBEAT_PATH)) {
    const beat = JSON.parse(readFileSync(HEARTBEAT_PATH, "utf8"));
    const ageMin = (Date.now() - Date.parse(beat.last_tick)) / 60_000;
    const fresh = ageMin < 120;
    add("heartbeat", fresh && beat.ok, `last tick ${ageMin.toFixed(0)}m ago, ok=${beat.ok}, +${beat.filled} obs, ${beat.gaps} gaps${fresh ? "" : " — STALE (>2h)"}`);
  } else {
    add("heartbeat", false, "no heartbeat yet (run: openxpli harvest)");
  }

  for (const c of checks) console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(10)} ${c.detail}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}
