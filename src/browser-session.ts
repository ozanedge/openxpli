import { randomUUID } from "node:crypto";
import type { BrowserContext } from "playwright-core";
import { openDb } from "./db.js";

export class BrowserCancelled extends Error {
  constructor() { super("Browser task cancelled. Your account has not been changed."); }
}
export class BrowserBusy extends Error {
  constructor() { super("The saved browser session is still in use. Close the OpenXPLI sign-in window, then retry. Other Chrome windows can stay open."); }
}
export function processAlive(pid: number | null): boolean {
  if (!pid || !Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
export interface BrowserWait {
  cancelled?: () => boolean;
  onWaiting?: (external: boolean) => void;
  onOpened?: () => void;
  onSignedIn?: () => void;
  timeoutMs?: number;
  pollMs?: number;
}
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// All persistent contexts, including scheduled reads, share this FIFO queue.
// A live owner is never evicted merely because a wall-clock timeout elapsed.
export async function acquireBrowser(options: BrowserWait = {}): Promise<() => void> {
  const db = openDb(), id = randomUUID();
  db.prepare("INSERT INTO browser_requests (id, pid, created_at) VALUES (?,?,?)").run(id, process.pid, Date.now());
  const release = () => {
    const connection = openDb();
    try { connection.prepare("DELETE FROM browser_requests WHERE id = ?").run(id); }
    finally { connection.close(); }
  };
  const started = Date.now();
  try {
    for (;;) {
      if (options.cancelled?.()) throw new BrowserCancelled();
      const first = db.transaction(() => {
        const requests = db.prepare("SELECT id, pid FROM browser_requests ORDER BY sequence").all() as { id: string; pid: number }[];
        for (const request of requests) if (!processAlive(request.pid)) db.prepare("DELETE FROM browser_requests WHERE id = ?").run(request.id);
        return db.prepare("SELECT id FROM browser_requests ORDER BY sequence LIMIT 1").get() as { id: string } | undefined;
      }).immediate();
      if (first?.id === id) return release;
      options.onWaiting?.(false);
      if (Date.now() - started >= (options.timeoutMs ?? 15 * 60_000)) throw new BrowserBusy();
      await delay(options.pollMs ?? 1000);
    }
  } catch (e) { release(); throw e; }
  finally { db.close(); }
}
export function profileInUse(error: unknown): boolean {
  return /ProcessSingleton|SingletonLock|profile.*(?:in use|already used)|user data directory is already in use/i.test(String(error));
}
export async function openBrowserSession(launch: () => Promise<BrowserContext>, options: BrowserWait = {}): Promise<BrowserContext> {
  const release = await acquireBrowser(options);
  let closed = false;
  const once = () => { if (!closed) { closed = true; release(); } };
  try {
    if (options.cancelled?.()) throw new BrowserCancelled();
    let context: BrowserContext;
    try { context = await launch(); }
    catch (e) {
      // Relaunching a busy profile can send new tabs to the existing Chrome.
      // Never use Chrome launch as a polling mechanism; require an explicit retry.
      if (profileInUse(e)) throw new BrowserBusy();
      throw e;
    }
    context.once("close", once);
    if (options.cancelled?.()) { await context.close(); throw new BrowserCancelled(); }
    options.onOpened?.();
    return context;
  } catch (e) { once(); throw e; }
}

// Closing the final window does not reliably exit Chrome on macOS, and in
// attach mode the browser belongs to the user and must outlive the task. So
// what is watched, and what gets closed, is the task's own tab — never the
// browser it lives in.
export interface SigninTarget {
  page: {
    on(event: "close", listener: () => void): unknown;
    off?(event: "close", listener: () => void): unknown;
    isClosed?(): boolean;
  };
  close(): Promise<void>;
}
// beforeClose runs while the tab is still alive, so the sign-in can be
// acknowledged on screen before the window it is shown in goes away.
export async function finishSignin(session: SigninTarget, options: BrowserWait & { continued?: () => boolean; pollMs?: number; beforeClose?: () => Promise<void> } = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const settle = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      session.page.off?.("close", onPageClose);
      error ? reject(error) : resolve();
    };
    let closing = false;
    const done = async (error?: Error) => {
      if (closing) return;
      closing = true;
      if (!error) { try { await options.beforeClose?.(); } catch { /* the tab may already be gone */ } }
      try { await session.close(); } catch { /* the tab may already be gone */ }
      settle(error);
    };
    const onPageClose = () => { void done(options.cancelled?.() ? new BrowserCancelled() : undefined); };
    const timer = setInterval(() => {
      try {
        if (options.cancelled?.()) void done(new BrowserCancelled());
        else if (options.continued?.()) void done();
      } catch (e) { void done(e instanceof Error ? e : new Error("Sign-in status could not be read")); }
    }, options.pollMs ?? 500);
    session.page.on("close", onPageClose);
    if (session.page.isClosed?.()) void done();
  });
}
