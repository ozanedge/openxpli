// Connector deletion through the console, using an isolated account and data directory.
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

const server = spawn(process.execPath, ["dist/cli.js", "ui", "--port", "41405", "--no-open"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("console did not start")), 10000);
    server.once("exit", (c) => { clearTimeout(t); reject(new Error(`console exited ${c}`)); });
    server.stdout.on("data", (d) => { if (String(d).includes("41405")) { clearTimeout(t); resolve(); } });
  });
  browser = await chromium.launch({ channel: "chrome", chromiumSandbox: true, headless: true });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:41405/", { waitUntil: "networkidle" });
  await page.waitForSelector("#proc-table tr.row");

  const endpoint = "http://127.0.0.1:41405/api/connectors/delete";
  const denied = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "ads-openai/demo", confirmed: true }) });
  assert.equal(denied.status, 403);
  await page.locator(".connector-menu summary").click();
  await page.getByRole("button", { name: "Delete connector", exact: true }).click();
  await page.locator("#modal-root").getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.locator("#proc-table tr.row").count(), 1);
  await page.locator(".connector-menu summary").click();
  await page.getByRole("button", { name: "Delete connector", exact: true }).click();
  await page.locator("#form-submit").click();
  await page.getByText("No connectors yet — Add Connector to begin.", { exact: true }).waitFor();
  const remaining = await (await fetch("http://127.0.0.1:41405/api/processes")).json();
  assert.equal(remaining.length, 0);
  console.log("PASS: connector deletion UI, cancel confirmation, authenticated endpoint, and refreshed empty state");
} finally {
  if (browser) await browser.close();
  server.kill();
}
