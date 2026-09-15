import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "./db.js";
import { processAlive, BrowserBusy, BrowserCancelled, type BrowserWait } from "./browser-session.js";

export interface LearningJob {
  id: string; source_id: string; kind: "signin" | "learn";
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  pid: number | null; continue_requested: number; cancel_requested: number;
  created_at: number; updated_at: number;
}
// Whether this connector's tool is signed in, recorded when we actually see it:
// the sign-in window reaching the account, or a read that returned authenticated
// pages. Cheap to read on every poll, unlike asking the browser.
export function setSignedIn(sourceId: string, at: number | null): void {
  const db = openDb();
  try {
    if (at === null) db.prepare("DELETE FROM knowledge WHERE source_id = ? AND key = 'signed-in'").run(sourceId);
    else db.prepare("INSERT OR REPLACE INTO knowledge (source_id, key, kind, content, updated_at) VALUES (?, 'signed-in', 'status', ?, ?)")
      .run(sourceId, JSON.stringify({ at }), at);
  } finally { db.close(); }
}
export function signedInAt(sourceId: string): number | null {
  const db = openDb();
  try {
    const row = db.prepare("SELECT content FROM knowledge WHERE source_id = ? AND key = 'signed-in'").get(sourceId) as { content: string } | undefined;
    return row ? (JSON.parse(row.content) as { at: number }).at : null;
  } catch { return null; } finally { db.close(); }
}

// A session belongs to the login, not to the connector. Every connector for a
// tool shares one browser profile and therefore one sign-in, so signing in for
// any of them signs in for all of them — and a second connector on the same
// tool must never be told to sign in again.
export function signedInForTool(tool: string): number | null {
  const db = openDb();
  try {
    const row = db.prepare(`SELECT MAX(json_extract(k.content, '$.at')) AS at
      FROM knowledge k JOIN processes p ON p.id = k.source_id
      WHERE k.key = 'signed-in' AND p.tool = ?`).get(tool) as { at: number | null } | undefined;
    return row?.at ?? null;
  } catch { return null; } finally { db.close(); }
}
// Losing the session loses it for the whole tool, for the same reason.
export function clearSignedInForTool(tool: string): void {
  const db = openDb();
  try {
    db.prepare(`DELETE FROM knowledge WHERE key = 'signed-in' AND source_id IN
      (SELECT id FROM processes WHERE tool = ?)`).run(tool);
  } finally { db.close(); }
}

export function writeLearningStatus(sourceId: string, state: string, message: string, jobId?: string): void {
  const db = openDb();
  try {
    if (jobId && !(db.prepare("SELECT 1 FROM learning_jobs WHERE id = ? AND status = 'running'").get(jobId))) return;
    db.prepare("INSERT OR REPLACE INTO knowledge (source_id, key, kind, content, updated_at) VALUES (?, 'learning-status', 'status', ?, ?)")
      .run(sourceId, JSON.stringify({ state, message, at: Date.now(), jobId }), Date.now());
  } finally { db.close(); }
}
function recoverJobs(db: ReturnType<typeof openDb>): void {
  const active = db.prepare("SELECT * FROM learning_jobs WHERE status IN ('queued','running')").all() as LearningJob[];
  for (const job of active) {
    if (job.pid ? processAlive(job.pid) : Date.now() - job.created_at < 30_000) continue;
    db.prepare("UPDATE learning_jobs SET status = 'failed', updated_at = ? WHERE id = ?").run(Date.now(), job.id);
    db.prepare("INSERT OR REPLACE INTO knowledge (source_id, key, kind, content, updated_at) VALUES (?, 'learning-status', 'status', ?, ?)")
      .run(job.source_id, JSON.stringify({ state: "failed", message: "The browser task stopped before finishing. Retry learning or open sign-in again.", at: Date.now() }), Date.now());
  }
}
export function activeLearningJob(sourceId: string): LearningJob | null {
  const db = openDb();
  try {
    recoverJobs(db);
    return (db.prepare("SELECT * FROM learning_jobs WHERE source_id = ? AND status IN ('queued','running')").get(sourceId) as LearningJob | undefined) ?? null;
  } finally { db.close(); }
}
export function getLearningJob(id: string): LearningJob {
  const db = openDb();
  try {
    const job = db.prepare("SELECT * FROM learning_jobs WHERE id = ?").get(id) as LearningJob | undefined;
    if (!job) throw new Error("No such browser task");
    return job;
  } finally { db.close(); }
}
export function queueLearningJob(sourceId: string, kind: LearningJob["kind"], launchWorker = true): LearningJob {
  const db = openDb();
  let created = false;
  let job: LearningJob;
  try {
    job = db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM processes WHERE id = ?").get(sourceId)) throw new Error("No such connector");
      recoverJobs(db);
      const existing = db.prepare("SELECT * FROM learning_jobs WHERE source_id = ? AND status IN ('queued','running')").get(sourceId) as LearningJob | undefined;
      if (existing) return existing;
      const id = randomUUID();
      db.prepare("INSERT INTO learning_jobs (id, source_id, kind, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, sourceId, kind, Date.now(), Date.now());
      db.prepare("INSERT OR REPLACE INTO knowledge (source_id, key, kind, content, updated_at) VALUES (?, 'learning-status', 'status', ?, ?)")
        .run(sourceId, JSON.stringify({ state: "queued", message: kind === "signin" ? "Sign-in is queued for the shared browser." : "Learning is queued for the shared browser.", at: Date.now(), jobId: id }), Date.now());
      created = true;
      return db.prepare("SELECT * FROM learning_jobs WHERE id = ?").get(id) as LearningJob;
    }).immediate();
    if (created && launchWorker) {
      const child = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "cli.js"), "browser-job", job.id], { detached: true, stdio: "ignore" });
      db.prepare("UPDATE learning_jobs SET pid = ? WHERE id = ? AND status = 'queued'").run(child.pid ?? null, job.id);
      child.on("error", () => {
        const connection = openDb();
        try { connection.prepare("UPDATE learning_jobs SET status = 'failed' WHERE id = ? AND status = 'queued'").run(job.id); }
        finally { connection.close(); }
        writeLearningStatus(sourceId, "failed", "Could not start the browser task. Try again.");
      });
      child.unref();
    }
    return job;
  } finally { db.close(); }
}
export function signalLearningJob(sourceId: string, action: "continue" | "cancel"): string {
  const job = activeLearningJob(sourceId);
  if (!job) throw new Error("No active browser task. Start learning or sign in again.");
  if (action === "continue" && job.kind !== "signin") throw new Error("This connector has no sign-in task to finish");
  const db = openDb();
  try {
    if (action === "continue") db.prepare("UPDATE learning_jobs SET continue_requested = 1 WHERE id = ?").run(job.id);
    else db.prepare("UPDATE learning_jobs SET cancel_requested = 1 WHERE id = ?").run(job.id);
  } finally { db.close(); }
  return action === "continue" ? "Finishing sign-in, then learning the account." : "Stopping this browser task. Your saved observations are kept.";
}
export interface LearningJobHandlers {
  signin: (sourceId: string, options: BrowserWait & { continued: () => boolean }) => Promise<void>;
  learn: (sourceId: string, options: BrowserWait) => Promise<void>;
}
export async function runLearningJob(id: string, handlers?: LearningJobHandlers): Promise<void> {
  const db = openDb();
  const claimed = db.prepare("UPDATE learning_jobs SET status = 'running', pid = ?, updated_at = ? WHERE id = ? AND status = 'queued'").run(process.pid, Date.now(), id);
  db.close();
  if (!claimed.changes) return;
  const job = getLearningJob(id);
  const cancelled = () => !!getLearningJob(id).cancel_requested;
  const status = (state: string, message: string) => writeLearningStatus(job.source_id, state, message, id);
  const waiting = (external: boolean) => status("waiting-browser", external
    ? "The saved session is open in another Chrome window. Close the OpenXPLI sign-in window to free it; learning will continue automatically. You can leave your regular Chrome windows open."
    : "Waiting for another OpenXPLI browser task to finish. This task will continue automatically.");
  try {
    if (!handlers) {
      const browser = await import("./browser-scout.js");
      const scout = await import("./scout.js");
      handlers = {
        signin: async (sourceId, options) => {
          const connection = openDb();
          let tool: string;
          try { tool = (connection.prepare("SELECT tool FROM processes WHERE id = ?").get(sourceId) as { tool: string }).tool; }
          finally { connection.close(); }
          const pb = browser.playbookFor(tool);
          if (!pb) throw new Error("Browser learning is not supported for this connector");
          await browser.signin(pb, options);
        },
        learn: async (sourceId, options) => { await scout.rescout(sourceId, false, options); },
      };
    }
    if (cancelled()) throw new BrowserCancelled();
    if (job.kind === "signin") {
      await handlers.signin(job.source_id, {
        cancelled, onWaiting: waiting,
        onOpened: () => status("signin", "Sign in in the OpenXPLI Chrome window. It closes itself as soon as you are in — or click ‘I’m signed in — continue’ here."),
        // A distinct state, not "signin" again: once the sign-in is recognised
        // the card must stop asking for one.
        onSignedIn: () => { setSignedIn(job.source_id, Date.now()); status("signed-in", "Signed in. Closing the window and reading your account."); },
        continued: () => !!getLearningJob(id).continue_requested,
      });
    }
    if (cancelled()) throw new BrowserCancelled();
    status("learning", "Reading the account, then preparing grounded suggestions.");
    await handlers.learn(job.source_id, { cancelled, onWaiting: waiting, onOpened: () => status("learning", "Reading the current account through the browser.") });
    if (cancelled()) throw new BrowserCancelled();
    // A read that returned pages proves the session works, whether it came from
    // an interactive sign-in or an imported profile.
    setSignedIn(job.source_id, Date.now());
    status("ready", "Account observations saved. Review the grounded suggestions below.");
    const connection = openDb();
    try { connection.prepare("UPDATE learning_jobs SET status = 'done', updated_at = ? WHERE id = ?").run(Date.now(), id); }
    finally { connection.close(); }
  } catch (e) {
    const wasCancelled = e instanceof BrowserCancelled || cancelled();
    const message = String(e instanceof Error ? e.message : e);
    if (/NEED_SIGNIN/.test(String(e instanceof Error ? e.message : e))) {
      const connection = openDb();
      let tool: string | undefined;
      try { tool = (connection.prepare("SELECT tool FROM processes WHERE id = ?").get(job.source_id) as { tool: string } | undefined)?.tool; }
      finally { connection.close(); }
      if (tool) clearSignedInForTool(tool); else setSignedIn(job.source_id, null);
    }
    const state = wasCancelled ? "cancelled" : /SECURITY_VERIFICATION/.test(message) ? "verification-blocked" : /NEED_SIGNIN/.test(message) ? "needs-signin" : e instanceof BrowserBusy ? "browser-busy" : "failed";
    status(state, wasCancelled ? "Browser task cancelled. Previous observations and suggestions are kept."
      : state === "needs-signin" ? "The saved session needs sign-in. Open Chrome, sign in, then use Continue."
      : message.slice(0, 400));
    const connection = openDb();
    try { connection.prepare("UPDATE learning_jobs SET status = ?, updated_at = ? WHERE id = ?").run(wasCancelled ? "cancelled" : "failed", Date.now(), id); }
    finally { connection.close(); }
  }
}
