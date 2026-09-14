import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OPENXPLI_BROWSER_MODE = "launch";
process.env.OPENXPLI_DATA_DIR = mkdtempSync(join(tmpdir(), "openxpli-browser-flow-"));
const { openDb } = await import("../dist/db.js");
const { acquireBrowser, openBrowserSession, finishSignin, BrowserBusy, BrowserCancelled } = await import("../dist/browser-session.js");
const { queueLearningJob, runLearningJob, getLearningJob, activeLearningJob, signalLearningJob } = await import("../dist/learning-jobs.js");
const { rescout } = await import("../dist/scout.js");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const db = openDb();
for (const id of ["one", "two", "three"]) {
  db.prepare("INSERT INTO processes (id, tool, metric, created_at) VALUES (?, 'ChatGPT Ads', 'CTR', 0)").run(id);
}
let waiting = false;
const first = await acquireBrowser();
let secondAcquired = false;
const second = acquireBrowser({ pollMs: 5, onWaiting: () => { waiting = true; } }).then(release => { secondAcquired = true; return release; });
await pause(20);
assert.equal(waiting, true);
assert.equal(secondAcquired, false, "a second connector must wait");
await assert.rejects(() => acquireBrowser({ timeoutMs: 10, pollMs: 5 }), BrowserBusy);
assert.equal(secondAcquired, false, "a timeout must never evict the live owner");
first();
const releaseSecond = await second;
releaseSecond();
assert.equal(db.prepare("SELECT COUNT(*) n FROM browser_requests").get().n, 0);
db.prepare("INSERT INTO browser_requests (id, pid, created_at) VALUES ('dead-owner', 2147483647, 0)").run();
const recovered = await acquireBrowser({ timeoutMs: 100 });
recovered();
assert.equal(db.prepare("SELECT COUNT(*) n FROM browser_requests").get().n, 0);
class FakeContext extends EventEmitter {
  constructor() { super(); this.closed = false; this.page = new EventEmitter(); this.page.closed = false; this.page.isClosed = () => this.page.closed; }
  pages() { return [this.page]; }
  async close() { if (!this.closed) { this.closed = true; this.emit("close"); } }
}
let launches = 0;
await assert.rejects(() => openBrowserSession(async () => {
  launches++;
  throw new Error("Failed to create a ProcessSingleton");
}, { pollMs: 5, timeoutMs: 100 }), BrowserBusy);
await new Promise(resolve => setTimeout(resolve, 150));
assert.equal(launches, 1, "a busy profile must never trigger automatic Chrome relaunches");
assert.equal(db.prepare("SELECT COUNT(*) n FROM browser_requests").get().n, 0);
const context = await openBrowserSession(async () => new FakeContext());
assert.equal(db.prepare("SELECT COUNT(*) n FROM browser_requests").get().n, 1);
await context.close();
assert.equal(db.prepare("SELECT COUNT(*) n FROM browser_requests").get().n, 0);
const windowClosed = new FakeContext();
const finishedByWindow = finishSignin(windowClosed, { pollMs: 5 });
windowClosed.page.closed = true;
windowClosed.page.emit("close");
await finishedByWindow;
assert.equal(windowClosed.closed, true, "closing the last page must explicitly release the persistent context");
const continued = new FakeContext();
await finishSignin(continued, { continued: () => true, pollMs: 5 });
assert.equal(continued.closed, true);
const cancelled = new FakeContext();
await assert.rejects(() => finishSignin(cancelled, { cancelled: () => true, pollMs: 5 }), BrowserCancelled);
const job = queueLearningJob("one", "signin", false);
assert.equal(queueLearningJob("one", "signin", false).id, job.id);
assert.equal(queueLearningJob("one", "learn", false).id, job.id);
let signedIn = false, learned = 0;
const work = runLearningJob(job.id, {
  signin: async (_, options) => {
    signedIn = true;
    options.onOpened?.();
    await finishSignin(new FakeContext(), { ...options, pollMs: 5 });
  },
  learn: async () => { learned++; },
});
while (!signedIn) await pause(5);
assert.equal(activeLearningJob("one").id, job.id);
signalLearningJob("one", "continue");
await work;
assert.equal(learned, 1, "Continue must automatically advance to learning");
assert.equal(getLearningJob(job.id).status, "done");
assert.equal(activeLearningJob("one"), null);
const toCancel = queueLearningJob("two", "learn", false);
signalLearningJob("two", "cancel");
await runLearningJob(toCancel.id, { signin: async () => assert.fail("must not sign in"), learn: async () => assert.fail("must not learn") });
assert.equal(getLearningJob(toCancel.id).status, "cancelled");
const blocked = queueLearningJob("two", "learn", false);
const owner = await acquireBrowser();
let queued = false;
const blockedWork = runLearningJob(blocked.id, {
  signin: async () => {},
  learn: async (_, options) => {
    const release = await acquireBrowser({ ...options, pollMs: 5, onWaiting: () => { queued = true; } });
    release();
  },
});
while (!queued) await pause(5);
signalLearningJob("two", "cancel");
await blockedWork;
assert.equal(getLearningJob(blocked.id).status, "cancelled");
assert.equal(db.prepare("SELECT COUNT(*) n FROM browser_requests").get().n, 1, "cancelling a waiter must not release another task's browser");
owner();
const abandoned = queueLearningJob("three", "signin", false);
db.prepare("UPDATE learning_jobs SET status = 'running', pid = 2147483647 WHERE id = ?").run(abandoned.id);
assert.equal(activeLearningJob("three"), null);
assert.equal(getLearningJob(abandoned.id).status, "failed");
const retry = queueLearningJob("three", "learn", false);
assert.notEqual(retry.id, abandoned.id);
db.prepare("INSERT INTO candidates (id, source_id, field, control_value, variant_value, metric, rationale, expected_multiple, created_at, evidence) VALUES ('preserved', 'three', 'headline', 'Old copy', 'New copy', 'CTR', 'Observed rationale', 1.05, 0, '[]')").run();
await assert.rejects(() => rescout("three"), /NEED_SIGNIN/);
assert.equal(db.prepare("SELECT status FROM candidates WHERE id = 'preserved'").get().status, "proposed");
assert.equal(db.prepare("SELECT COUNT(*) n FROM candidates WHERE source_id = 'three'").get().n, 1);
await runLearningJob(retry.id, { signin: async () => {}, learn: async () => { throw new Error("NEED_SIGNIN"); } });
assert.equal(getLearningJob(retry.id).status, "failed");
assert.equal(JSON.parse(db.prepare("SELECT content FROM knowledge WHERE source_id = 'three' AND key = 'learning-status'").get().content).state, "needs-signin");
assert.equal(db.prepare("SELECT COUNT(*) n FROM experiments").get().n, 0);
db.close();
console.log("PASS: shared FIFO browser queue, single-attempt busy-profile handling, safe cancellation, last-window close, Continue-to-learning, deduplicated jobs, interrupted-worker recovery, and preserved suggestions");
console.log(`Scratch data: ${process.env.OPENXPLI_DATA_DIR}`);
