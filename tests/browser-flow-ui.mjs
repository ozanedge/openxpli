import "./browser-flow.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import http from "node:http";
import { chromium } from "playwright-core";
const { queueLearningJob, runLearningJob, getLearningJob } = await import("../dist/learning-jobs.js");
const { openBrowserSession, finishSignin } = await import("../dist/browser-session.js");
const { crawl } = await import("../dist/browser-scout.js");
const account = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  if (req.url === "/challenge") { res.end("<html><body>Performing security verification. This website verifies you are not a bot.<a href='/should-not-read'>Continue</a></body></html>"); return; }
  res.end(`<html><body><h1>Test account signed in</h1><p>${"Account settings visible for read-only learning. ".repeat(15)}</p></body></html>`);
});
await new Promise(resolve => account.listen(0, "127.0.0.1", resolve));
const accountUrl = `http://127.0.0.1:${account.address().port}`;
const profile = join(process.env.OPENXPLI_DATA_DIR, "browser-profile");
const server = spawn(process.execPath, ["dist/cli.js", "ui", "--port", "41202", "--no-open"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
let uiBrowser, oldContext, work;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Scratch console timeout")), 10000);
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Scratch console exited ${code}`)); });
    server.stderr.on("data", data => process.stderr.write(data));
    server.stdout.on("data", data => { if (String(data).includes("41202")) { clearTimeout(timeout); resolve(); } });
  });
  const base = "http://127.0.0.1:41202";
  // Simulate the old uncoordinated browser instance that caused the real failure.
  oldContext = await chromium.launchPersistentContext(profile, { channel: "chrome", chromiumSandbox: true, headless: true });
  let job = queueLearningJob("one", "signin", false);
  let observedPages = 0;
  let launches = 0;
  const handlers = {
    signin: async (_, options) => {
      const context = await openBrowserSession(() => { launches++; return chromium.launchPersistentContext(profile, { channel: "chrome", chromiumSandbox: true, headless: true }); }, { ...options, pollMs: 100 });
      const tab = context.pages()[0];
      await tab.goto(accountUrl);
      // finishSignin watches the task's own tab, never the whole browser.
      await finishSignin({ page: tab, close: () => context.close() }, { ...options, pollMs: 100 });
    },
    learn: async (_, options) => { observedPages = (await crawl({ url: accountUrl, name: "Fixture", signinUrl: accountUrl, headedRead: false }, 1, options)).length; },
  };
  work = runLearningJob(job.id, handlers);
  await work;
  assert.equal(getLearningJob(job.id).status, "failed");
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(launches, 1, "busy profile must not repeatedly launch Chrome");
  uiBrowser = await chromium.launch({ channel: "chrome", chromiumSandbox: true, headless: true });
  const page = await uiBrowser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => { errors.push(dialog.message()); void dialog.dismiss(); });
  await page.goto(base);
  await page.getByText("The saved browser session is still in use.", { exact: false }).waitFor();
  await page.getByText("Browser in use — retry needed", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Cancel browser task", exact: true }).count(), 0);
  const token = await page.evaluate(() => TOKEN);
  await oldContext.close(); oldContext = null;
  job = queueLearningJob("one", "signin", false);
  work = runLearningJob(job.id, handlers);
  await page.reload();
  await page.getByRole("button", { name: "I’m signed in — continue", exact: true }).waitFor();
  await page.getByRole("button", { name: "I’m signed in — continue", exact: true }).click();
  await work;
  await page.getByText("Account learned", { exact: true }).waitFor();
  const lastWindow = await openBrowserSession(() => chromium.launchPersistentContext(profile, { channel: "chrome", chromiumSandbox: true, headless: true }));
  const lastTab = lastWindow.pages()[0];
  const lastWindowDone = finishSignin({ page: lastTab, close: () => lastWindow.close() });
  await lastTab.close();
  await lastWindowDone;
  await assert.rejects(() => crawl({ url: accountUrl + "/challenge", name: "Challenge fixture", signinUrl: accountUrl, headedRead: false }, 2), /SECURITY_VERIFICATION/);
  assert.equal(observedPages, 1);
  assert.equal(getLearningJob(job.id).status, "done");
  assert.equal(await page.getByRole("button", { name: "Cancel browser task", exact: true }).count(), 0);
  const unauthorized = await fetch(base + "/api/signin/continue", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "one" }) });
  assert.equal(unauthorized.status, 403);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/openxpli-browser-flow-fixed.png", fullPage: true });
  console.log("PASS: real Chrome profile contention → single failed attempt → explicit retry after profile release → explicit Continue → read-only account learning; duplicate requests and endpoint auth");
} finally {
  if (oldContext) await oldContext.close();
  if (uiBrowser) await uiBrowser.close();
  server.kill("SIGTERM");
  await new Promise(resolve => account.close(resolve));
}
