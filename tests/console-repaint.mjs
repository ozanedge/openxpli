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

  // A connector with a live session must not be told to sign in again: the
  // prominent action is reading the account, and sign-in drops to a fallback.
  const signedOut = await page.evaluate(() => {
    const html = document.getElementById("proc-table").innerHTML;
    return { offersSignin: /Sign in with Chrome/.test(html), offersAgain: /Sign in again/.test(html) };
  });
  assert.equal(signedOut.offersSignin, true, "with no session, sign-in is the offered action");
  assert.equal(signedOut.offersAgain, false);

  const signedIn = await page.evaluate(() => {
    (window.__procs || [])[0].signed_in_at = Date.now();
    renderProcesses(window.__procs);
    const html = document.getElementById("proc-table").innerHTML;
    return { offersSignin: /Sign in with Chrome/.test(html), offersAgain: /Sign in again/.test(html),
             stillLearns: /data-kit-action="learn"/.test(html) };
  });
  assert.equal(signedIn.offersSignin, false, "an established session must not ask to sign in again");
  assert.equal(signedIn.offersAgain, true, "sign-in stays reachable as a fallback for an expired session");
  assert.equal(signedIn.stillLearns, true, "reading the account stays the primary action");

  // A session belongs to the login, not the connector: every connector for a
  // tool shares one browser profile, so a second connector on the same tool
  // must never be told to sign in again.
  {
    const { openDb: db1 } = await import("../dist/db.js");
    const { setSignedIn, signedInForTool, clearSignedInForTool } = await import("../dist/learning-jobs.js");
    const conn = db1();
    conn.prepare("INSERT OR IGNORE INTO processes (id, tool, metric, created_at) VALUES ('ads-openai/second','ChatGPT Ads','CTR',?)").run(Date.now());
    conn.prepare("INSERT OR IGNORE INTO processes (id, tool, metric, created_at) VALUES ('other/one','Klaviyo','CTR',?)").run(Date.now());
    conn.close();
    assert.equal(signedInForTool("ChatGPT Ads"), null, "no session to begin with");
    setSignedIn("ads-openai/demo", 1700000000000);
    assert.equal(signedInForTool("ChatGPT Ads"), 1700000000000,
      "a sign-in on one connector counts for every connector on that tool");
    assert.equal(signedInForTool("Klaviyo"), null, "but never for a different tool");
    clearSignedInForTool("ChatGPT Ads");
    assert.equal(signedInForTool("ChatGPT Ads"), null, "losing the session loses it tool-wide");
  }

  // The card must never ask for something already done. The job's kind stays
  // "signin" for its whole life — it signs in, then reads the account — so any
  // copy keyed off the kind kept telling the user to finish signing in while
  // OpenXPLI was already reading their account.
  const phases = await page.evaluate(() => {
    const p = (window.__procs || [])[0];
    const read = (learning) => {
      p.learning = learning;
      renderProcesses(window.__procs);
      const t = document.getElementById("proc-table");
      return { html: t.innerHTML, continueBtn: !!t.querySelector('[data-kit-action="continue-signin"]') };
    };
    const base = { active: true, kind: "signin", continue_requested: false, cancel_requested: false, at: Date.now() };
    return {
      waiting: read({ ...base, state: "signin", message: "Sign in in the OpenXPLI Chrome window." }),
      recognised: read({ ...base, state: "signed-in", message: "Signed in. Closing the window and reading your account." }),
      reading: read({ ...base, state: "learning", message: "Reading the current account through the browser." }),
      done: read({ ...base, active: false, state: "ready", message: "Account observations saved." }),
    };
  });
  assert.ok(phases.waiting.html.includes("Finish signing in"), "while waiting, ask for the sign-in");
  assert.equal(phases.waiting.continueBtn, true, "and offer the manual Continue");
  for (const phase of ["recognised", "reading", "done"]) {
    assert.ok(!phases[phase].html.includes("Finish signing in"),
      `"${phase}" must not still ask the user to finish signing in`);
    assert.equal(phases[phase].continueBtn, false,
      `"${phase}" must not still offer Continue`);
  }
  assert.ok(phases.recognised.html.includes("Signed in"), "recognised says so");
  assert.ok(phases.reading.html.includes("Learning your account"), "reading says so");
  assert.ok(phases.done.html.includes("Account learned"), "finished says so");

  // Account connection earns its place only while it needs something. Once the
  // account is simply connected it drops into one collapsed drawer at the end
  // alongside the launched kits — both worth keeping, neither worth re-reading.
  const settled = await page.evaluate(() => {
    const p = (window.__procs || [])[0];
    const kitFor = (state) => ({ id: "k9", candidate_id: "cand-1", state,
      content: { title: "Kit", field: "headline", control: "A", variant: "B", metric: "click-through rate",
        inverse: 0, object: "ad", runDays: 7, imageMode: "none", imagePrompt: "", imageNote: "", imageSize: "",
        fields: [], checks: [], instructions: [], evidence: [], id: "k9", rationale: "r" } });
    const read = (signedIn, learning, kits) => {
      p.signed_in_at = signedIn; p.learning = learning; p.kits = kits;
      renderProcesses(window.__procs);
      const t = document.getElementById("proc-table");
      const drawer = t.querySelector('details[data-disclosure^="settled-"]');
      const card = t.querySelector('[data-workspace-section="learning"]');
      const goalEl = t.querySelector('[data-workspace-section="goal"]');
      return {
        goalInDrawer: !!(goalEl && drawer && drawer.contains(goalEl)),
        goalPresent: !!goalEl,
        goalCount: t.querySelectorAll('[data-workspace-section="goal"]').length,
        drawer: drawer ? drawer.querySelector("summary").innerText.replace(/\s+/g, " ").trim() : null,
        cardInDrawer: !!(card && drawer && drawer.contains(card)),
        cardPresent: !!card,
        drawerOpen: drawer ? drawer.open : null,
      };
    };
    const live = { active: true, kind: "signin", state: "signin", message: "m", at: Date.now() };
    const ok = { active: false, kind: "signin", state: "ready", message: "m", at: Date.now() };
    const goal = { id: "g1", metric: "click-through rate", inverse: 0, rationale: "r", guardrails: [] };
    const withGoal = (g) => { p.goal = g; p.goal_options = []; };
    const out = {};
    withGoal(null);
    out.never = read(null, null, []);
    out.trouble = read(Date.now(), { ...ok, state: "needs-signin" }, []);
    out.running = read(Date.now(), live, []);
    out.noGoal = read(Date.now(), ok, []);
    withGoal(goal);
    out.connected = read(Date.now(), ok, []);
    out.withKits = read(Date.now(), ok, [kitFor("launched")]);
    return out;
  });
  for (const phase of ["never", "trouble", "running"]) {
    assert.equal(settled[phase].cardPresent, true, `"${phase}" still shows the account card`);
    assert.equal(settled[phase].cardInDrawer, false, `"${phase}" must not be buried in the drawer`);
  }
  assert.equal(settled.connected.cardInDrawer, true, "a connected account moves into the drawer");
  assert.equal(settled.connected.drawerOpen, false, "and the drawer starts collapsed");
  assert.match(settled.connected.drawer, /^Reference/, "one drawer, named for what it holds");
  assert.match(settled.connected.drawer, /Account connection/);
  assert.match(settled.withKits.drawer, /Account connection · 1 launched kit/,
    "the drawer says what it holds, so it can be skipped knowingly");

  // The goal is the decision everything else is measured against, so it stays
  // in front until it exists — then it is something you look up, not act on.
  assert.equal(settled.noGoal.goalPresent, true, "with no goal chosen, ask for one");
  assert.equal(settled.noGoal.goalInDrawer, false, "and never bury that ask");
  assert.equal(settled.connected.goalInDrawer, true, "a chosen goal moves into the drawer");
  assert.match(settled.connected.drawer, /Goal · click-through rate/,
    "and the drawer names it, so it stays findable");
  for (const phase of ["noGoal", "connected", "withKits"])
    assert.equal(settled[phase].goalCount, 1, `"${phase}" renders the goal exactly once`);

  // A run that has started but has not been read yet has no point to plot. The
  // chart used to return early on exactly that case, so a just-launched
  // experiment was drawn as nothing at all — indistinguishable from not
  // existing, which is the one reading it must never give.
  const chart = await page.evaluate(() => {
    setView("experiments");
    const started = Date.now() - 3600000;
    renderChart([
      { id: "new/0914", process_id: "p1", status: "running", started_at: started, ends_at: started + 6048e5, series: [] },
      { id: "old/0901", process_id: "p1", status: "running", started_at: started - 6048e5, ends_at: started,
        series: [{ hour: 1, phase: "run", multiple: 1.02, sigma: 0.01 }] },
    ]);
    const svg = document.querySelector("#chartwrap svg");
    const box = svg.getBoundingClientRect();
    const label = [...svg.querySelectorAll("text")].find((t) => t.textContent.includes("new/0914"));
    const nucleus = svg.querySelectorAll(".atom-core");
    return {
      labelled: !!label,
      labelInside: label ? label.getBoundingClientRect().right <= box.right + 1 : null,
      nuclei: nucleus.length,
      electrons: svg.querySelectorAll("animateMotion").length,
      orbits: svg.querySelectorAll("ellipse").length,
      glow: !!svg.querySelector("radialGradient"),
      plottedOther: [...svg.querySelectorAll("polyline")].length,
    };
  });
  assert.equal(chart.labelled, true, "an unmeasured run must still be named on the chart");
  assert.equal(chart.labelInside, true, "and its label must stay inside the plot");
  assert.equal(chart.nuclei, 1, "one nucleus for the one unmeasured run");
  assert.ok(chart.electrons >= 6, `the shell should be populated, got ${chart.electrons}`);
  assert.ok(chart.glow, "the nucleus is lit, not a flat dot");
  assert.equal(chart.orbits, 3, "three orbits");
  assert.ok(chart.plottedOther >= 1, "a measured run is still drawn as a line, not an atom");
  await page.evaluate(() => setView("processes"));

  // The kit button must say what is true. It used to read "View kit" as soon as
  // a kit row existed — while it was still queued — and the action underneath
  // was still "prepare", so clicking it re-requested preparation and appeared
  // to do nothing.
  const kitStates = await page.evaluate(() => {
    const p = (window.__procs || [])[0];
    const cand = { id: "cand-1", field: "headline", control_value: "A", variant_value: "B",
      rationale: "r", metric: "click-through rate", inverse: 0, expected_multiple: 1.05, evidence: [{ url: "u" }] };
    p.candidates = [cand];
    const read = () => {
      renderProcesses(window.__procs);
      const b = document.querySelector('#proc-table [data-kit-action="prepare"], #proc-table [data-kit-action="view-kit"], #proc-table button[disabled][title*="drafting"]');
      return { label: (b?.innerText || "").trim(), action: b?.getAttribute("data-kit-action"), disabled: !!b?.disabled };
    };
    const out = {};
    p.kits = [];                                                    out.none = read();
    p.kits = [{ id: "k1", candidate_id: "cand-1", state: "queued" }];    out.queued = read();
    p.kits = [{ id: "k1", candidate_id: "cand-1", state: "preparing" }]; out.preparing = read();
    const content = { title: "Kit", field: "headline", control: "A", variant: "B", metric: "click-through rate",
      inverse: 0, object: "ad", runDays: 7, imageMode: "none", imagePrompt: "", imageNote: "", imageSize: "",
      fields: [], checks: [], instructions: [], evidence: [], id: "k1", rationale: "r" };
    p.kits = [{ id: "k1", candidate_id: "cand-1", state: "ready", content }]; out.ready = read();
    return out;
  });
  assert.equal(kitStates.none.action, "prepare", "with no kit, the action is to prepare one");
  assert.match(kitStates.none.label, /Prepare experiment kit/);
  for (const state of ["queued", "preparing"]) {
    assert.equal(kitStates[state].disabled, true, `a ${state} kit must not offer to be viewed`);
    assert.match(kitStates[state].label, /Preparing/, `a ${state} kit must say it is still being built`);
    assert.notEqual(kitStates[state].action, "view-kit");
  }
  assert.equal(kitStates.ready.action, "view-kit", "a finished kit opens, it does not re-prepare");
  assert.match(kitStates.ready.label, /View kit/);

  console.log("PASS: unchanged polls leave the connector table untouched; real changes still render; focus returns to the same control; a live session is not asked to sign in again; the sign-in prompt clears once recognised; settled work collapses into one drawer; a just-started run shows as an atom; the kit button matches the kit state");
} finally {
  if (browser) await browser.close();
  server.kill();
}
