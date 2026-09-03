import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { ensureLedger } from "./ledger.js";
import { ensureDirs, LOG_DIR, PLIST_LABEL, UI_PLIST_LABEL } from "./paths.js";
// openxpli init: create data dirs + db + git ledger, then install and load a
// launchd LaunchAgent that fires `openxpli harvest` at least hourly. launchd
// coalesces missed intervals on wake, and harvest backfills — so a sleeping
// laptop heals instead of failing.
export function init() {
    ensureDirs();
    openDb();
    ensureLedger();
    const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
    const uid = userInfo().uid;
    const installAgent = (label, args, schedule) => {
        const plistPath = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
        const name = label.split(".").pop();
        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
${args.map((a) => `    <string>${a}</string>`).join("\n")}
  </array>
${schedule}
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(LOG_DIR, `${name}.log`)}</string>
  <key>StandardErrorPath</key><string>${join(LOG_DIR, `${name}.err.log`)}</string>
</dict></plist>
`;
        writeFileSync(plistPath, plist);
        const target = `gui/${uid}/${label}`;
        try {
            execFileSync("launchctl", ["bootout", target], { stdio: "ignore" });
        }
        catch { /* not loaded yet */ }
        for (let attempt = 0;; attempt++) {
            try {
                execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { stdio: "ignore" });
                break;
            }
            catch (e) {
                if (attempt >= 4)
                    throw e;
                execFileSync("sleep", [String(1 + attempt)]); // KeepAlive teardown race: wait and retry
            }
        }
        execFileSync("launchctl", ["enable", target]);
    };
    installAgent(PLIST_LABEL, ["tick"], "  <key>StartInterval</key><integer>3600</integer>");
    // The console is supervised: always up at localhost:41100, restarted on crash.
    installAgent(UI_PLIST_LABEL, ["ui", "--no-open"], "  <key>KeepAlive</key><true/>");
    console.log(`init: data dir, db, and git ledger ready`);
    console.log(`init: LaunchAgent ${PLIST_LABEL} installed and loaded (hourly + on load)`);
    console.log(`init: LaunchAgent ${UI_PLIST_LABEL} installed — console always on at http://localhost:41100`);
    console.log(`init: logs -> ${LOG_DIR}`);
}
