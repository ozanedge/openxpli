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

export function ensureDirs(): void {
  for (const d of [DATA_DIR, LEDGER_DIR, LOG_DIR]) mkdirSync(d, { recursive: true });
}

export const HOUR_MS = 3_600_000;
export const DEFAULT_RUN_HOURS = 168; // 7 days of hourly reads

// Trailing regression finder: after a winner is promoted, a small share of
// traffic stays on the old control to validate the win persists.
export const HOLDOUT_SHARE = 0.05; // 5% stays on the old version
export const VALIDATION_HOURS = 336; // 14 days of hourly reads vs holdout
export const REGRESS_WINDOW_HOURS = 48; // sustained-drop early-exit window
