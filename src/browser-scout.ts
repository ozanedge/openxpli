import { chromium, type Page, type BrowserContext } from "playwright-core";
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "./db.js";
import { spawn } from "node:child_process";
import { rmSync, statSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR } from "./paths.js";

// The real connector loop for tools with a playbook (first: ads.openai.com):
//   signin  — user authenticates once in a visible Chrome; session persists,
//             OpenXPLI never sees credentials
//   learn   — crawl the tool read-only, store what was seen in the knowledge
//             store, and have the model derive the top 3 grounded candidates
//   act     — on accept, drive the same browser to create the objects for the
//             experiment and start it (screenshot receipts every step)

export const BROWSER_PROFILE = join(DATA_DIR, "browser-profile");
export const RECEIPTS_DIR = join(DATA_DIR, "receipts");

export interface Playbook { url: string; name: string; }
export function playbookFor(tool: string): Playbook | null {
  const t = tool.toLowerCase();
  if (/openai|chatgpt ads/.test(t)) return { url: process.env.OPENXPLI_SCOUT_URL ?? "https://ads.openai.com", name: "ads.openai.com" };
  if (process.env.OPENXPLI_SCOUT_URL) return { url: process.env.OPENXPLI_SCOUT_URL, name: "override" };
  return null;
}

async function openCtx(headless: boolean): Promise<BrowserContext> {
  return chromium.launchPersistentContext(BROWSER_PROFILE, {
    channel: "chrome", headless, viewport: { width: 1600, height: 1000 },
  });
}

export async function signin(url: string): Promise<void> {
  const ctx = await openCtx(false);
  const pg = ctx.pages()[0] ?? await ctx.newPage();
  await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  console.log(`signin: sign in to ${url} in the Chrome window, then close the window.`);
  console.log(`signin: the session is kept in ${BROWSER_PROFILE} — OpenXPLI rides it read-only and never sees your password.`);
  await new Promise<void>((res) => ctx.on("close", () => res()));
}

// ── model helper ──
function ask(prompt: string, timeoutMs = 240_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("claude", ["-p", prompt, "--model", "claude-opus-5"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => err ? reject(new Error(`model call failed: ${String(err).slice(0, 200)}`)) : resolve(stdout));
  });
}
function jsonFrom<T>(raw: string, opener: string): T {
  const start = raw.indexOf(opener);
  if (start === -1) throw new Error("no JSON in model output");
  // walk to the matching close bracket
  const open = opener === "[" ? "[" : "{", close = opener === "[" ? "]" : "}";
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === open) depth++;
    else if (raw[i] === close && --depth === 0) return JSON.parse(raw.slice(start, i + 1)) as T;
  }
  throw new Error("unbalanced JSON in model output");
}

// ── learn: bounded read-only crawl -> knowledge store -> top-3 candidates ──
async function pageText(pg: Page): Promise<string> {
  return (await pg.evaluate(() => document.body.innerText)).replace(/\n{3,}/g, "\n\n");
}

export async function crawl(pb: Playbook, maxPages = 8): Promise<{ url: string; text: string }[]> {
  const ctx = await openCtx(true);
  try {
    const pg = ctx.pages()[0] ?? await ctx.newPage();
    const origin = new URL(pb.url).origin;
    const seen = new Set<string>([pb.url]);
    const queue = [pb.url];
    const pages: { url: string; text: string }[] = [];
    while (queue.length && pages.length < maxPages) {
      const url = queue.shift()!;
      try {
        await pg.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await pg.waitForTimeout(5_000); // hydrate
      } catch { continue; }
      const text = (await pageText(pg)).slice(0, 12_000);
      if (pages.length === 0 && text.length < 400 && /sign in|log ?in|welcome back/i.test(text))
        throw new Error("NEED_SIGNIN");
      pages.push({ url: pg.url(), text });
      // discover same-origin nav links, shallow-first
      const links: string[] = await pg.$$eval("a[href]", (as) => as.map((a) => (a as HTMLAnchorElement).href));
      for (const l of links) {
        try {
          const u = new URL(l);
          if (u.origin !== origin) continue;
          const clean = u.origin + u.pathname;
          if (!seen.has(clean) && u.pathname.split("/").filter(Boolean).length <= 3) { seen.add(clean); queue.push(clean); }
        } catch { /* bad href */ }
      }
    }
    return pages;
  } finally {
    await ctx.close();
  }
}

export interface RawCandidate {
  field: string; control_value: string; variant_value: string;
  metric: string; inverse: boolean; rationale: string; expected_multiple: number;
}

export async function learn(sourceId: string, toolName: string, pb: Playbook): Promise<RawCandidate[]> {
  const pages = await crawl(pb);
  const db = openDb();
  const put = db.prepare("INSERT OR REPLACE INTO knowledge (source_id, key, kind, content, updated_at) VALUES (?,?,?,?,?)");
  pages.forEach((p, i) => put.run(sourceId, `page:${new URL(p.url).pathname || i}`, "page", `# ${p.url}\n\n${p.text}`, Date.now()));

  const corpus = pages.map((p) => `=== PAGE: ${p.url} ===\n${p.text}`).join("\n\n").slice(0, 28_000);
  const raw = await ask(`You are the scout inside OpenXPLI, an experimentation engine. Below is everything visible in the user's ${toolName} account, crawled READ-ONLY.

Reply with ONLY a JSON object, no markdown fences, with exactly two keys:
"map": a compact plain-text account map (what exists: campaigns/objects, their key settings, budgets, metrics visible — under 200 words, cite real names/numbers from the pages),
"candidates": an array of exactly 3 experiment candidates grounded in what you actually see. Each changes ONE variable, is measurable from the tool's own reporting, keeps blast radius small, and has keys: field, control_value (the real current value), variant_value, metric, inverse (true if lower is better), rationale (one sentence citing something specific), expected_multiple (1.01-1.15, conservative).

ACCOUNT PAGES:
${corpus}`);
  const out = jsonFrom<{ map: string; candidates: RawCandidate[] }>(raw, "{");
  put.run(sourceId, "map", "map", out.map, Date.now());
  if (!Array.isArray(out.candidates) || !out.candidates.length) throw new Error("scout: no candidates from model");
  return out.candidates.slice(0, 3);
}

// ── act: on accept, drive the browser to create the experiment's objects ──
interface ExpSpec { id: string; field: string; control_value: string; variant_value: string; tool: string; }

interface Action { action: "click" | "fill" | "goto" | "press" | "wait" | "done" | "fail"; index?: number; value?: string; url?: string; reason?: string; }

export async function act(exp: ExpSpec, pb: Playbook): Promise<string> {
  const receipts = join(RECEIPTS_DIR, exp.id.replace(/[^a-z0-9]/gi, "-"));
  mkdirSync(receipts, { recursive: true });
  const ctx = await openCtx(true);
  const history: string[] = [];
  try {
    const pg = ctx.pages()[0] ?? await ctx.newPage();
    await pg.goto(pb.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await pg.waitForTimeout(4_000);

    for (let step = 1; step <= 18; step++) {
      // enumerate interactable elements with stable markers
      const els: { i: number; tag: string; label: string }[] = await pg.evaluate(() => {
        const out: { i: number; tag: string; label: string }[] = [];
        document.querySelectorAll("a,button,[role=button],input,select,textarea,[role=tab],[role=menuitem]").forEach((e, i) => {
          if (i >= 150) return;
          (e as HTMLElement).setAttribute("data-openxpli-i", String(i));
          const el = e as HTMLElement;
          const label = (el.innerText || (el as HTMLInputElement).placeholder || el.getAttribute("aria-label") || (el as HTMLInputElement).value || "").trim().slice(0, 80);
          if (label || ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName)) out.push({ i, tag: el.tagName.toLowerCase(), label });
        });
        return out;
      });
      const state = (await pageText(pg)).slice(0, 6_000);

      const raw = await ask(`You are OpenXPLI's hands, operating ${exp.tool} through a browser to set up ONE experiment. Work step by step; reply with ONLY a JSON object for the SINGLE next action.

GOAL: create what is needed to run this experiment, then start it:
- change: ${exp.field}
- control (unchanged, keep serving): ${exp.control_value}
- variant (create this): ${exp.variant_value}
Prefer duplicating an existing object and applying the single change. Keep any budget at the minimum the UI allows. HARD RULES: never enter or confirm payment details; never delete anything; never touch billing settings; if the flow demands payment info or something irreversible beyond launching this small experiment, reply {"action":"fail","reason":"..."}.

STEPS SO FAR:
${history.join("\n") || "(none)"}

CURRENT URL: ${pg.url()}
PAGE TEXT (truncated):
${state}

INTERACTABLE ELEMENTS (click/fill by index):
${els.map((e) => `[${e.i}] <${e.tag}> ${e.label}`).join("\n").slice(0, 6_000)}

Reply with ONE of:
{"action":"click","index":N,"reason":"..."}
{"action":"fill","index":N,"value":"...","reason":"..."}
{"action":"press","value":"Enter","reason":"..."}
{"action":"goto","url":"...","reason":"..."}
{"action":"wait","reason":"..."}
{"action":"done","reason":"what was created and started"}
{"action":"fail","reason":"..."}`, 180_000);
      const a = jsonFrom<Action>(raw, "{");
      history.push(`${step}. ${a.action}${a.index != null ? ` [${a.index}]` : ""}${a.value ? ` "${a.value}"` : ""} — ${a.reason ?? ""}`);
      if (a.action === "done") {
        await pg.screenshot({ path: join(receipts, `step-${step}-done.png`) }).catch(() => {});
        return a.reason ?? "done";
      }
      if (a.action === "fail") throw new Error(`act: agent stopped: ${a.reason}`);
      try {
        if (a.action === "click" && a.index != null) await pg.click(`[data-openxpli-i="${a.index}"]`, { timeout: 8_000 });
        else if (a.action === "fill" && a.index != null) await pg.fill(`[data-openxpli-i="${a.index}"]`, a.value ?? "", { timeout: 8_000 });
        else if (a.action === "press") await pg.keyboard.press(a.value ?? "Enter");
        else if (a.action === "goto" && a.url && new URL(a.url).origin === new URL(pb.url).origin)
          await pg.goto(a.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        else if (a.action === "wait") { /* just settle */ }
      } catch (e) {
        history.push(`   -> action failed: ${String(e).slice(0, 120)}`);
      }
      await pg.waitForTimeout(3_500);
      await pg.screenshot({ path: join(receipts, `step-${step}.png`) }).catch(() => {});
    }
    throw new Error("act: step limit reached without done");
  } finally {
    await ctx.close();
  }
}

// ── measurement: model writes a read recipe ONCE; hourly ticks apply it
//    deterministically; extraction failure spawns a recipe-repair child ──
export interface Recipe { url: string; control_regex: string; variant_regex: string; }

function lockFresh(name: string, ms: number): boolean {
  const lock = join(DATA_DIR, name);
  try {
    const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < ms) return false;
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    return true;
  } catch { return false; }
}
export function clearLock(name: string): void { rmSync(join(DATA_DIR, name), { recursive: true, force: true }); }
export function spawnDetachedRecipe(expId: string): boolean {
  if (!lockFresh(`recipe-${expId.replace(/[^a-z0-9]/gi, "-")}.lock`, 6 * 3_600_000)) return false;
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  spawn(process.execPath, [cli, "recipe", expId, "--child"], { detached: true, stdio: "ignore" }).unref();
  return true;
}

const num = (s: string) => parseFloat(s.replace(/[$,%\s]/g, "").replace(/,/g, ""));

export async function makeRecipe(expId: string): Promise<Recipe> {
  const db = openDb();
  const exp = db.prepare(
    "SELECT e.*, p.tool, p.metric, p.id AS source_id FROM experiments e JOIN processes p ON p.id = e.process_id WHERE e.id = ?"
  ).get(expId) as { id: string; field: string; control_value: string; variant_value: string; tool: string; metric: string; source_id: string } | undefined;
  if (!exp) throw new Error(`recipe: no such experiment: ${expId}`);
  const pb = playbookFor(exp.tool);
  if (!pb) throw new Error(`recipe: no playbook for ${exp.tool}`);
  const ctx = await openCtx(true);
  try {
    const pg = ctx.pages()[0] ?? await ctx.newPage();
    await pg.goto(pb.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await pg.waitForTimeout(5_000);
    const text = (await pageText(pg)).slice(0, 12_000);
    const raw = await ask(`You write EXTRACTION RECIPES for OpenXPLI's hourly metric reader.

Experiment in ${exp.tool}: field "${exp.field}", CONTROL arm = "${exp.control_value}", VARIANT arm = "${exp.variant_value}", metric = "${exp.metric}".
The reader will load a page hourly and extract the metric value for each arm from the page's plain innerText using JavaScript regexes.

Below is the innerText of ${pg.url()}. If the numbers needed live on a different page of the same site, give that url; otherwise reuse this one.

Reply ONLY a JSON object: {"url":"...","control_regex":"...","variant_regex":"..."}
Each regex: JavaScript syntax (no flags needed beyond default; the reader adds none), matching the innerText, with EXACTLY ONE capture group that captures the metric NUMBER for that arm (commas/$/% allowed in the capture). Anchor on stable nearby labels, not on the numbers themselves.

PAGE TEXT:
${text}`);
    const recipe = jsonFrom<Recipe>(raw, "{");
    // validate immediately against the recipe's own page
    if (recipe.url !== pg.url()) {
      await pg.goto(recipe.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await pg.waitForTimeout(5_000);
    }
    const t2 = await pageText(pg);
    const c = t2.match(new RegExp(recipe.control_regex)), v = t2.match(new RegExp(recipe.variant_regex));
    if (!c?.[1] || !v?.[1] || !isFinite(num(c[1])) || !isFinite(num(v[1])))
      throw new Error(`recipe: validation failed (control=${c?.[1] ?? "no match"}, variant=${v?.[1] ?? "no match"})`);
    db.prepare("INSERT OR REPLACE INTO knowledge (source_id, key, kind, content, updated_at) VALUES (?,?,?,?,?)")
      .run(exp.source_id, `recipe:${expId}`, "recipe", JSON.stringify(recipe), Date.now());
    console.log(`recipe: stored for ${expId} — url ${recipe.url}; control sample ${c[1]}, variant sample ${v[1]}`);
    return recipe;
  } finally {
    await ctx.close();
  }
}

// Deterministic hourly reads for real experiments: no model involved.
export async function browserReads(): Promise<void> {
  const db = openDb();
  const HOUR = 3_600_000;
  const exps = db.prepare(
    "SELECT e.*, p.tool, p.inverse FROM experiments e JOIN processes p ON p.id = e.process_id WHERE e.status = 'running'"
  ).all() as { id: string; process_id: string; tool: string; inverse: number; started_at: number; ends_at: number }[];
  const holdouts = db.prepare(
    "SELECT h.*, e.started_at AS e_start, e.ends_at AS e_end, p.tool, p.inverse FROM holdouts h JOIN experiments e ON e.id = h.experiment_id JOIN processes p ON p.id = h.process_id WHERE h.status = 'validating'"
  ).all() as { experiment_id: string; process_id: string; started_at: number; ends_at: number; e_start: number; e_end: number; tool: string; inverse: number }[];
  const holdTargets = holdouts.filter((h) => playbookFor(h.tool) && existsSync(BROWSER_PROFILE));
  const targets = exps.filter((e) => playbookFor(e.tool) && existsSync(BROWSER_PROFILE));
  if (!targets.length && !holdTargets.length) return;

  let ctx: BrowserContext | null = null;
  try {
    for (const e of targets) {
      const rec = db.prepare("SELECT content FROM knowledge WHERE source_id = ? AND key = ?").get(e.process_id, `recipe:${e.id}`) as { content: string } | undefined;
      if (!rec) { spawnDetachedRecipe(e.id); continue; }
      const recipe = JSON.parse(rec.content) as Recipe;
      const runHours = Math.max(1, Math.round((e.ends_at - e.started_at) / HOUR));
      const due = Math.min(runHours, Math.floor((Date.now() - e.started_at) / HOUR));
      if (due < 1) continue;
      const have = db.prepare("SELECT 1 FROM observations WHERE experiment_id = ? AND hour = ?").get(e.id, due);
      if (have) continue;
      ctx = ctx ?? await openCtx(true);
      const pg = ctx.pages()[0] ?? await ctx.newPage();
      try {
        await pg.goto(recipe.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await pg.waitForTimeout(5_000);
        const text = await pageText(pg);
        const c = text.match(new RegExp(recipe.control_regex)), v = text.match(new RegExp(recipe.variant_regex));
        const cv = c?.[1] != null ? num(c[1]) : NaN, vv = v?.[1] != null ? num(v[1]) : NaN;
        if (!isFinite(cv) || !isFinite(vv) || cv === 0) throw new Error(`extraction failed (control=${c?.[1] ?? "∅"}, variant=${v?.[1] ?? "∅"})`);
        const multiple = e.inverse ? cv / vv : vv / cv;
        const prior = (db.prepare(
          "SELECT multiple FROM observations WHERE experiment_id = ? AND missing = 0 AND phase = 'run' ORDER BY hour DESC LIMIT 24"
        ).all(e.id) as { multiple: number }[]).map((r) => r.multiple);
        const mean = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : multiple;
        const sigma = prior.length >= 4
          ? Math.max(0.004, Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / prior.length))
          : 0.05;
        db.prepare(
          "INSERT OR IGNORE INTO observations (experiment_id, hour, ts, multiple, sigma, source, missing, phase) VALUES (?,?,?,?,?, 'browser', 0, 'run')"
        ).run(e.id, due, e.started_at + due * HOUR, multiple, sigma);
        console.log(`read: ${e.id} h${due} -> x${multiple.toFixed(4)} (control ${cv}, variant ${vv})`);
      } catch (err) {
        console.log(`read: ${e.id} failed — ${String(err).slice(0, 140)}; queuing recipe repair`);
        spawnDetachedRecipe(e.id);
      }
    }
    // holdout phase: same recipe, hour numbering continues past the run
    for (const h of holdTargets) {
      const rec = db.prepare("SELECT content FROM knowledge WHERE source_id = ? AND key = ?").get(h.process_id, `recipe:${h.experiment_id}`) as { content: string } | undefined;
      if (!rec) continue;
      const recipe = JSON.parse(rec.content) as Recipe;
      const runHours = Math.max(1, Math.round((h.e_end - h.e_start) / HOUR));
      const offset = Math.max(168, runHours);
      const due = Math.min(336, Math.floor((Date.now() - h.started_at) / HOUR));
      if (due < 1) continue;
      if (db.prepare("SELECT 1 FROM observations WHERE experiment_id = ? AND hour = ?").get(h.experiment_id, offset + due)) continue;
      ctx = ctx ?? await openCtx(true);
      const pg = ctx.pages()[0] ?? await ctx.newPage();
      try {
        await pg.goto(recipe.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await pg.waitForTimeout(5_000);
        const text = await pageText(pg);
        const c = text.match(new RegExp(recipe.control_regex)), v = text.match(new RegExp(recipe.variant_regex));
        const cv = c?.[1] != null ? num(c[1]) : NaN, vv = v?.[1] != null ? num(v[1]) : NaN;
        if (!isFinite(cv) || !isFinite(vv) || cv === 0) throw new Error("extraction failed");
        const multiple = h.inverse ? cv / vv : vv / cv;
        db.prepare(
          "INSERT OR IGNORE INTO observations (experiment_id, hour, ts, multiple, sigma, source, missing, phase) VALUES (?,?,?,?, 0.03, 'browser', 0, 'holdout')"
        ).run(h.experiment_id, offset + due, h.started_at + due * HOUR, multiple);
        console.log(`read: ${h.experiment_id} holdout h${due} -> x${multiple.toFixed(4)}`);
      } catch (err) {
        console.log(`read: holdout ${h.experiment_id} failed — ${String(err).slice(0, 120)}`);
      }
    }
  } finally {
    if (ctx) await ctx.close();
  }
}
