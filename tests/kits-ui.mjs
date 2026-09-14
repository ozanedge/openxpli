// Reuse the isolated fixture and behavioral assertions before exercising the HTTP/UI boundary.
import "./kits.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import http from "node:http";

const server = spawn(process.execPath, ["dist/cli.js", "ui", "--port", "41201", "--no-open"], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Scratch console did not start")), 10000);
    server.once("exit", code => { clearTimeout(timeout); reject(new Error(`Scratch console exited ${code}`)); });
    server.stderr.on("data", chunk => process.stderr.write(chunk));
    server.stdout.on("data", chunk => { if (String(chunk).includes("41201")) { clearTimeout(timeout); resolve(); } });
  });
  const base = "http://127.0.0.1:41201";
  const pageHtml = await (await fetch(base)).text();
  const token = pageHtml.match(/const TOKEN = "([a-f0-9]+)"/)[1];
  const api = (path, body, auth = true) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { "x-openxpli-token": token } : {}) }, body: JSON.stringify(body) });
  const procs = await (await fetch(base + "/api/processes")).json();
  assert.equal(procs[0].execution_mode, "manual");
  const kit = procs[0].kits.find(k => k.candidate_id === "image");
  assert.equal((await api("/api/kits/launched", { id: kit.id, note: "test", confirmed: true }, false)).status, 403);
  assert.equal((await api("/api/kits/image", { id: kit.id, image: "Zm9v" })).status, 400);
  assert.equal((await api("/api/kits/prepare", { candidate: "template" })).status, 400);
  assert.equal((await api("/api/kits/file", {})).status, 404);
  const download = await fetch(`${base}/api/kits/file?id=${kit.id}&name=kit.html`);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.ok((await download.text()).includes("data:image/png;base64,"));
  assert.equal((await fetch(`${base}/api/kits/file?id=${kit.id}&name=../../secrets`)).status, 404);
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  await page.route("**/*", route => route.request().url().startsWith(base) ? route.continue() : route.abort());
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", dialog => { errors.push(dialog.message()); void dialog.dismiss(); });
  await page.goto(base);
  await page.getByText("Your experiment kits", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Start", exact: true }).count(), 0);
  await page.evaluate(() => {
    const p = window.__procs[0];
    renderProcesses([{ ...p, goal: null, status: "goal", kits: [], goal_options: [{ id: "g2", metric: "CTR", inverse: 0, rationale: "Choose the goal", guardrails: [] }] }]);
  });
  await page.getByText("Choose the goal", { exact: true }).waitFor();
  await page.evaluate(() => refresh());
  await page.locator(`[data-kit-action="toggle"][data-kit="${kit.id}"]`).click();
  await page.locator(`[data-kit-action="copy-field"][data-kit="${kit.id}"]`).first().click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "Find signals faster");
  const [file] = await Promise.all([
    page.waitForEvent("download"),
    page.locator(`a[href="/api/kits/file?id=${kit.id}&name=kit.html"]`).click(),
  ]);
  assert.equal(file.suggestedFilename(), "kit.html");
  await page.locator(`[data-kit-action="launch"][data-kit="${kit.id}"]`).click();
  await page.locator("#kit-launch-note").fill("Control 12, variant 13; started at 11:00 UTC");
  await page.locator("#kit-launched-check").check();
  await page.getByRole("button", { name: "Record launch", exact: true }).click();
  await page.getByText("Your launch notes: Control 12, variant 13; started at 11:00 UTC").waitFor();
  const after = await (await fetch(base + "/api/processes")).json();
  assert.equal(after[0].experiments.length, 0, "recording a launch must not start synthetic monitoring");
  await page.locator(`[data-kit-action="toggle"][data-kit="${kit.id}"]`).scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/openxpli-kits-console.png", fullPage: true });
  const exportPage = await context.newPage();
  await exportPage.setContent(await (await fetch(`${base}/api/kits/file?id=${kit.id}&name=kit.html`)).text());
  await exportPage.screenshot({ path: "/tmp/openxpli-kit-export.png", fullPage: true });
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.screenshot({ path: "/tmp/openxpli-kits-console-narrow.png", fullPage: true });
  assert.deepEqual(errors, []);
  const { crawl } = await import("../dist/browser-scout.js");
  let mutations = 0;
  const account = http.createServer((req, res) => {
    if (req.method === "POST" || req.url === "/delete") mutations++;
    res.setHeader("content-type", "text/html");
    res.end(`<html><body><h1>Test ad account</h1><p>${"Campaign settings and reporting. ".repeat(30)}</p><a href="/reports">Reports</a><a href="/delete">Delete</a><a href="https://example.com">External</a><script>fetch('/mutation', {method:'POST'}).catch(()=>{})</script></body></html>`);
  });
  await new Promise(resolve => account.listen(0, "127.0.0.1", resolve));
  try {
    const pages = await crawl({ url: `http://127.0.0.1:${account.address().port}`, name: "Fixture account" }, 2);
    assert.equal(pages.length, 2);
    assert.equal(mutations, 0, "read-only crawl must not submit POSTs or visit action links");
    assert.ok(pages.every(p => !p.url.includes("example.com")));
  } finally { await new Promise(resolve => account.close(resolve)); }
  console.log("PASS: scratch HTTP auth, downloads, uploads validation, kit UI, copy buttons, manual launch, read-only fixture crawl, and no automatic experiment creation");
  console.log("Preview screenshot: /tmp/openxpli-kits-console.png");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
