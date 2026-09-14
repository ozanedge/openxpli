// The connectors view polls every 2s while a sign-in or kit is in flight.
// Re-rendering identical markup tore down the subtree each time — restarting
// CSS animations and dropping hover and focus, which is what showed up as the
// UI glitching. These assertions pin that a no-op poll leaves the DOM alone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OPENXPLI_BROWSER_MODE = "launch";
process.env.OPENXPLI_DATA_DIR = mkdtempSync(join(tmpdir(), "openxpli-repaint-"));
const { openDb } = await import("../dist/db.js");
const { chromium } = await import("playwright-core");

const db = openDb();
db.prepare("INSERT INTO processes (id, tool, metric, created_at) VALUES ('ads-openai/demo','ChatGPT Ads','CTR',?)").run(Date.now());
// A connector mid-sign-in: exactly the state that polls every 2 seconds.
db.prepare("INSERT OR REPLACE INTO knowledge (source_id, key, kind, content, updated_at) VALUES ('ads-openai/demo','learning-status','status',?,?)")
  .run(JSON.stringify({ state: "signin", message: "Sign in in the OpenXPLI Chrome window, then click continue.", at: Date.now() }), Date.now());
db.close();

const server = spawn(process.execPath, ["dist/cli.js", "ui", "--port", "41404", "--no-open"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("console did not start")), 10000);
    server.once("exit", (c) => { clearTimeout(t); reject(new Error(`console exited ${c}`)); });
    server.stdout.on("data", (d) => { if (String(d).includes("41404")) { clearTimeout(t); resolve(); } });
  });
  browser = await chromium.launch({ channel: "chrome", chromiumSandbox: true, headless: true });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:41404/", { waitUntil: "networkidle" });
  await page.waitForSelector("#proc-table tr.row");

  // Mark the live nodes, then re-render with byte-identical data.
  await page.evaluate(() => {
    document.querySelectorAll("#proc-table tr").forEach((n, i) => { n.__keep = i; });
    document.getElementById("proc-table").__probe = "alive";
  });
  const before = await page.evaluate(() => document.getElementById("proc-table").innerHTML.length);
  await page.evaluate(() => { renderProcesses(window.__procs || []); renderProcesses(window.__procs || []); });
  const survived = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#proc-table tr")).every((n, i) => n.__keep === i));
  assert.equal(survived, true, "an unchanged re-render must not replace the rows");

  // A real change must still reach the DOM.
  await page.evaluate(() => {
    const p = (window.__procs || [])[0];
    p.goal = { metric: "click-through rate", inverse: 0 };
    renderProcesses(window.__procs);
  });
  const changed = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#proc-table tr")).some((n) => n.__keep === undefined));
  assert.equal(changed, true, "a real change must re-render");
  assert.ok(await page.evaluate(() => document.getElementById("proc-table").innerHTML.includes("click-through rate")));
  assert.ok(before > 0);

  // Focus inside the table survives a re-render that does happen.
  // Focus is restored from the button's data attributes, which the re-rendered
  // markup also carries. Only a visible control can hold focus, so the test
  // proves focus was actually taken before asserting that it came back.
  const focused = await page.evaluate(() => {
    // Hover-reveal controls are laid out but visibility:hidden, so they report
    // an offsetParent and still refuse focus. Trust the result, not the style.
    for (const b of document.querySelectorAll("#proc-table [data-kit-action]")) {
      if (b.disabled) continue;
      b.focus();
      if (document.activeElement === b)
        return { action: b.getAttribute("data-kit-action"), conn: b.getAttribute("data-connector") };
    }
    return null;
  });
  assert.ok(focused, "the connector panel must expose a focusable control to test against");
  await page.evaluate(() => { (window.__procs || [])[0].tool = "ChatGPT Ads "; renderProcesses(window.__procs); });
  const restored = await page.evaluate(() => {
    const a = document.activeElement;
    return { inTable: !!a?.closest?.("#proc-table"), action: a?.getAttribute?.("data-kit-action") ?? null };
  });
  assert.equal(restored.inTable, true, "focus must return to the table after a re-render");
  assert.equal(restored.action, focused.action, "focus must return to the same control");

  console.log("PASS: unchanged polls leave the connector table untouched; real changes still render; focus returns to the same control");
} finally {
  if (browser) await browser.close();
  server.kill();
}
