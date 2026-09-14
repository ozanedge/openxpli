import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { BROWSER_PROFILE, CHROME_BINARY, CHROME_PORT } from "./paths.js";

export function endpoint(): string { return `http://127.0.0.1:${CHROME_PORT}`; }

export async function chromeAlive(timeoutMs = 2_000): Promise<boolean> {
  try { return (await fetch(`${endpoint()}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })).ok; }
  catch { return false; }
}

interface Target { type?: string; id?: string }
export async function pageTargets(timeoutMs = 3_000): Promise<Target[]> {
  try {
    const response = await fetch(`${endpoint()}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return [];
    const list = await response.json() as Target[];
    return Array.isArray(list) ? list.filter((t) => t.type === "page") : [];
  } catch { return []; }
}

// macOS keeps Chrome running after its last window closes. The debugging port
// still answers, so the browser looks up — but with no page target the attach
// fails with "Browser context management is not supported". A browser with no
// window is not ready to be attached to; give it a tab first.
export async function ensureTarget(waitMs = 6_000): Promise<void> {
  if ((await pageTargets()).length) return;
  await fetch(`${endpoint()}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5_000) }).catch(() => {});
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if ((await pageTargets()).length) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`The OpenXPLI browser answers on ${endpoint()} but has no window open. Quit Chrome for that profile and run "openxpli browser" again.`);
}

// These two must travel together.
//   --enable-automation: without it Chrome answers browser-level DevTools
//     commands with "Browser context management is not supported" and the
//     attach fails outright. But it also sets navigator.webdriver.
//   --disable-blink-features=AutomationControlled: clears navigator.webdriver.
//     An interactive bot check (Cloudflare Turnstile) will spin and reset
//     forever against a browser that reports it, so the user can never solve
//     the checkbox by hand. Dropping the flag is what makes the window usable
//     by a human, which is the whole point of working in their own browser.
// The "controlled by automated test software" bar stays visible on purpose:
// it is how the user tells this window apart from their personal Chrome.
const FLAGS = [
  `--remote-debugging-port=${CHROME_PORT}`,
  "--remote-allow-origins=*",
  "--enable-automation",
  "--disable-blink-features=AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
];
export const LAUNCH_FLAGS = FLAGS;

// Headless Chrome reports itself in the User-Agent ("HeadlessChrome/152.0.0.0"),
// which bot protection rejects on sight. The browser is otherwise the same
// build the user runs, so it states the version it actually is, rendered
// offscreen. Derived from the installed binary rather than pinned, so it does
// not drift into claiming a version that is not there.
export function chromeMajor(): string {
  try {
    const out = spawnSync(CHROME_BINARY, ["--version"], { encoding: "utf8" }).stdout ?? "";
    return (/\b(\d+)\./.exec(out)?.[1]) ?? "";
  } catch { return ""; }
}
export function headlessUserAgent(): string {
  const major = chromeMajor();
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major || "152"}.0.0.0 Safari/537.36`;
}
export function flagsFor(headless: boolean): string[] {
  return headless ? [...FLAGS, "--headless=new", `--user-agent=${headlessUserAgent()}`] : FLAGS;
}

// Which mode the browser on this profile is in, read from its own argv. The
// two modes cannot share a profile directory, so starting one stops the other.
export function runningMode(): "headless" | "headed" | null {
  try {
    const pids = (spawnSync("pgrep", ["-f", `user-data-dir=${BROWSER_PROFILE}`], { encoding: "utf8" }).stdout ?? "").trim().split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      const cmd = spawnSync("ps", ["-o", "command=", "-p", pid], { encoding: "utf8" }).stdout ?? "";
      if (!cmd.includes("MacOS/Google Chrome") || cmd.includes("--type=")) continue;
      return cmd.includes("--headless") ? "headless" : "headed";
    }
  } catch { /* nothing running */ }
  return null;
}

export async function stopChrome(waitMs = 8_000): Promise<boolean> {
  const pids = (spawnSync("pgrep", ["-f", `user-data-dir=${BROWSER_PROFILE}`], { encoding: "utf8" }).stdout ?? "").trim().split(/\s+/).filter(Boolean);
  if (!pids.length) return false;
  for (const pid of pids) { try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ } }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await chromeAlive(800)) && runningMode() === null) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  for (const pid of pids) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* already gone */ } }
  await new Promise((resolve) => setTimeout(resolve, 800));
  return true;
}

export async function startChrome(headless = false, waitMs = 25_000): Promise<void> {
  const mode = headless ? "headless" : "headed";
  const running = runningMode();
  if (running === mode && await chromeAlive()) return;
  // One profile directory, one Chrome. Swapping modes means replacing it.
  if (running && running !== mode) await stopChrome();
  else if (await chromeAlive()) return;
  if (!existsSync(CHROME_BINARY)) throw new Error(`Chrome was not found at ${CHROME_BINARY}. Set OPENXPLI_CHROME to its path.`);
  mkdirSync(BROWSER_PROFILE, { recursive: true });
  for (const lock of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) rmSync(join(BROWSER_PROFILE, lock), { force: true });
  spawn(CHROME_BINARY, [...flagsFor(headless), `--user-data-dir=${BROWSER_PROFILE}`, "about:blank"], { detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await chromeAlive()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`The OpenXPLI browser did not answer on ${endpoint()} within ${Math.round(waitMs / 1000)}s. Run "openxpli browser" to open it.`);
}

// One browser, many tasks. A task owns only the tab it opened: the user's own
// tabs are never navigated, and closing a task never closes their browser.
export interface Session { page: Page; ctx: BrowserContext; close: () => Promise<void>; }

export async function attachSession(headless = true): Promise<Session> {
  await startChrome(headless);
  await ensureTarget();
  const browser = await chromium.connectOverCDP(endpoint());
  try {
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    const page = await ctx.newPage();
    return {
      page, ctx,
      // browser.close() on a CDP-attached browser detaches only; Chrome stays up.
      close: async () => { await page.close().catch(() => {}); await browser.close().catch(() => {}); },
    };
  } catch (e) { await browser.close().catch(() => {}); throw e; }
}
