import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
export const DATA_DIR = process.env.OPENXPLI_DATA_DIR ?? join(homedir(), ".openxpli");
export const DB_PATH = join(DATA_DIR, "openxpli.db");
export const LEDGER_DIR = join(DATA_DIR, "ledger");
export const LOG_DIR = join(DATA_DIR, "logs");
export const HEARTBEAT_PATH = join(DATA_DIR, "heartbeat.json");
export const PLIST_LABEL = "com.openxpli.harvest";
export const UI_PLIST_LABEL = "com.openxpli.ui";
export function ensureDirs() {
    for (const d of [DATA_DIR, LEDGER_DIR, LOG_DIR])
        mkdirSync(d, { recursive: true });
}
export const HOUR_MS = 3_600_000;
export const DEFAULT_RUN_HOURS = 168; // 7 days of hourly reads
// Trailing regression finder: after a winner is promoted, a small share of
// traffic stays on the old control to validate the win persists.
export const HOLDOUT_SHARE = 0.05; // 5% stays on the old version
// The variant's share of the traffic an experiment controls. Declared at start
// and stored on the row, so a record says what split it ran at instead of the
// console inferring one. Nothing verifies the tool honoured it until bindings
// land — declared intent, same standing as HOLDOUT_SHARE.
export const DEFAULT_VARIANT_SHARE = 0.5;
// Three arms race and the top one wins: holdout v(current--), control
// v(current), variant v(current++). The holdout is not a monitoring tranche any
// more — it can win, which means reverting the previous change — so it needs
// enough traffic to be estimated, not just watched. At 5% the holdout/control
// comparison carries ~1.9x the standard error of the primary one and needs ~26
// days to resolve on a 7-day cycle: it could only ever fail to lose. 20% brings
// that to ~9 days while costing the control/variant comparison little, and caps
// deliberate exposure to a configuration we already have evidence is worse.
// Per-connector override: policy.holdout_share.
export const DEFAULT_HOLDOUT_ARM_SHARE = 0.20;
// The first experiment under a goal has no adopted change to re-test, so its
// holdout arm carries the SAME configuration as control: an A/A arm. It should
// read x1.00 and nothing else. If it doesn't, the measurement is lying — which
// is worth knowing before you trust any variant result. Set 0 to run those
// experiments on two arms instead.
export const AA_HOLDOUT = process.env.OPENXPLI_AA_HOLDOUT !== "0";
export const VALIDATION_HOURS = 336; // 14 days of hourly reads vs holdout
export const REGRESS_WINDOW_HOURS = 48; // sustained-drop early-exit window
// ── the browser OpenXPLI works in ──
// A real Chrome profile the user signs into themselves, so SSO, the password
// manager and 2FA all behave normally. OpenXPLI attaches to it over the
// DevTools protocol instead of driving a throwaway profile. Borrowing the
// everyday Chrome profile is not possible: Chrome refuses remote debugging on
// the default profile directory, and binds cookies to the profile that created
// them — a copied cookie jar is wiped on first launch.
export const BROWSER_PROFILE = join(DATA_DIR, "browser-profile");
export const CHROME_PORT = Number(process.env.OPENXPLI_CHROME_PORT ?? 41200);
export const CHROME_BINARY = process.env.OPENXPLI_CHROME
    ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// "attach" (default): work in the user's signed-in browser. "launch": drive a
// private context per task, which has no session — kept for fixtures and CI.
export const BROWSER_MODE = process.env.OPENXPLI_BROWSER_MODE === "launch" ? "launch" : "attach";
