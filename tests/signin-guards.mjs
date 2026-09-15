// Guards for the ads.openai.com sign-in path. The failure these cover: the
// login page sat behind a bot check that never cleared, every navigation error
// was swallowed, and the signed-out marketing page was ingested as account data.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OPENXPLI_DATA_DIR = mkdtempSync(join(tmpdir(), "openxpli-signin-"));
process.env.OPENXPLI_BROWSER_MODE = "launch";   // never start the user's browser
process.env.OPENXPLI_CHROME_PORT = "41999";     // nothing listens here
const { playbookFor, playbookForUrl, publicShell, securityChallenge, safeCrawlUrl } = await import("../dist/browser-scout.js");

// Verbatim body text served by the challenge, captured from ads.openai.com.
const CHALLENGE = `ads.openai.com
Performing security verification
This website uses a security service to protect against malicious bots. This page is displayed while the website verifies you are not a bot.
Ray ID: a3910c250d46c70a
Performance and Security by Cloudflare`;
// Verbatim nav + hero of the signed-out landing page.
const SIGNED_OUT = `Home
Customer Stories
Log in
Sign up
New to ChatGPT ads? Get $500 ad credit on us when you spend $500.
Start now to claim
Advertise in ChatGPT
Reach people as they explore options, compare choices, and make decisions in ChatGPT.`;
const DASHBOARD = `Campaigns
Competitive
ED Guardrails
Spend
$1,240.55
Impressions
84,210
Settings
Log out`;

// Sign-in lands on the account's login page, not the marketing homepage.
const pb = playbookFor("ChatGPT Ads");
assert.equal(pb.url, "https://ads.openai.com");
assert.equal(pb.signinUrl, "https://ads.openai.com/auth/login");
assert.equal(pb.headedRead, true, "bot protection fails headless Chrome, so reads must be headed");
assert.equal(playbookFor("github"), null);

// The challenge is recognised wherever it appears, so it is never mistaken for
// a sign-in prompt or recorded as account content.
assert.equal(securityChallenge(CHALLENGE), true);
assert.equal(securityChallenge(SIGNED_OUT), false);
assert.equal(securityChallenge(DASHBOARD), false);

// The signed-out shell is refused; a real dashboard is not.
assert.equal(publicShell(SIGNED_OUT), true);
assert.equal(publicShell(DASHBOARD), false);
assert.equal(publicShell("Manage your login preferences\nBilling"), false, "prose mentioning login is not the public shell");

// A bounce to the auth host leaves the crawl origin and is rejected there.
const origin = new URL(pb.url).origin;
assert.equal(safeCrawlUrl("https://auth.openai.com/log-in", origin), false);
assert.equal(safeCrawlUrl("https://ads.openai.com/campaigns", origin), true);

// A raw --url sign-in still yields a usable playbook.
const raw = playbookForUrl("https://example.test/panel");
assert.equal(raw.signinUrl, "https://example.test/panel");
assert.equal(raw.headedRead, false);

// The browser OpenXPLI works in: a real Chrome the user signs into, reached
// over DevTools rather than driven from a throwaway profile.
const { endpoint, chromeAlive, ensureTarget, pageTargets } = await import("../dist/chrome.js");
const { challengeMarkers } = await import("../dist/browser-scout.js");
assert.equal(endpoint(), "http://127.0.0.1:41999");
assert.equal(await chromeAlive(500), false, "a dead port must report no browser, not hang");

// The interstitial has no body text at domcontentloaded; the title and the
// challenge token on the URL are what is actually there to match.
assert.equal(challengeMarkers("Just a moment...", "https://ads.openai.com/auth/login"), true);
assert.equal(challengeMarkers("", "https://ads.openai.com/auth/login?__cf_chl_rt_tk=abc"), true);
assert.equal(challengeMarkers("Welcome back - OpenAI", "https://auth.openai.com/log-in"), false);
assert.equal(challengeMarkers("Advertise in ChatGPT | OpenAI Ads", "https://ads.openai.com/"), false);

// A browser whose last window was closed still answers the debugging port but
// has no page target, and attaching to it fails. It must be given a tab first.
const http = await import("node:http");
const serve = (handler) => new Promise((resolve) => {
  const server = http.createServer(handler);
  server.listen(41999, "127.0.0.1", () => resolve(server));
});
let created = 0;
let windowless = await serve((req, res) => {
  if (req.url === "/json/list") { res.end(JSON.stringify(created ? [{ type: "page", id: "a" }] : [])); return; }
  if (req.url.startsWith("/json/new") && req.method === "PUT") { created++; res.end("{}"); return; }
  res.statusCode = 404; res.end();
});
assert.equal((await pageTargets()).length, 0, "no windows means no page targets");
await ensureTarget(3_000);
assert.equal(created, 1, "ensureTarget must open a window when the browser has none");
assert.equal((await pageTargets()).length, 1);
await ensureTarget(3_000);
assert.equal(created, 1, "a browser that already has a window is left alone");
await new Promise((r) => windowless.close(r));

// Resetting bot state must touch only the tool's own site and only bot-check
// cookies: a session or a preference cookie caught here would sign the user out.
const { clearChallengeCookies } = await import("../dist/browser-scout.js");
const cleared = [];
const fakeCtx = {
  cookies: async () => ([
    { name: "cf_clearance", domain: ".ads.openai.com" },
    { name: "__cf_bm", domain: ".auth.openai.com" },
    { name: "cf_chl_rc_ni", domain: "ads.openai.com" },
    { name: "cf_clearance", domain: ".cloudflare.com" },    // another site
    { name: "__cf_bm", domain: ".chatgpt.com" },            // another site
    { name: "login_session", domain: ".auth.openai.com" },  // a real session
    { name: "oai-did", domain: ".openai.com" },             // a device id
  ]),
  clearCookies: async (filter) => { cleared.push(`${filter.domain} ${filter.name}`); },
};
const dropped = await clearChallengeCookies(fakeCtx, pb);
assert.deepEqual(dropped.slice().sort(), [
  ".ads.openai.com cf_clearance", ".auth.openai.com __cf_bm", "ads.openai.com cf_chl_rc_ni",
].sort());
assert.deepEqual(cleared.slice().sort(), dropped.slice().sort(), "it must clear exactly what it reports");
for (const kept of ["cloudflare.com", "chatgpt.com", "login_session", "oai-did"])
  assert.ok(!cleared.some((c) => c.includes(kept)), `${kept} must survive a bot-state reset`);

// The two automation flags are a pair: one makes the CDP attach possible, the
// other keeps an interactive bot check solvable by the person at the keyboard.
const { LAUNCH_FLAGS } = await import("../dist/chrome.js");
assert.ok(LAUNCH_FLAGS.includes("--enable-automation"), "the CDP attach needs it");
assert.ok(LAUNCH_FLAGS.includes("--disable-blink-features=AutomationControlled"),
  "without it navigator.webdriver is true and Turnstile spins forever");

// The console runs under launchd, whose PATH is /usr/bin:/bin:/usr/sbin:/sbin.
// A CLI in a user or Homebrew prefix is invisible there, and the failure used
// to surface as "check the Claude CLI sign-in" — which sent you after the wrong
// problem entirely. Resolve by path, and never ignore an explicit override.
const { claudeBinary } = await import("../dist/browser-scout.js");
const prevClaude = process.env.OPENXPLI_CLAUDE;
const prevPath = process.env.PATH;
process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";          // the launchd PATH
delete process.env.OPENXPLI_CLAUDE;
const resolved = claudeBinary();
assert.ok(resolved.startsWith("/"), "the CLI must resolve to an absolute path, not a PATH lookup");
assert.ok(existsSync(resolved), `${resolved} must exist`);
process.env.OPENXPLI_CLAUDE = "/definitely/not/here/claude";
assert.throws(() => claudeBinary(), /does not exist/, "a bad override must fail loudly, not fall back");
if (prevClaude === undefined) delete process.env.OPENXPLI_CLAUDE; else process.env.OPENXPLI_CLAUDE = prevClaude;
process.env.PATH = prevPath;

// Sign-in finishes when the tool's own pages answer. The user should not have
// to confirm what the page already shows — but this must never fire early, or
// the window closes mid-authentication.
const { reachedAccount } = await import("../dist/browser-scout.js");
const fakePage = (url, title, text) => ({ url: () => url, title: async () => title, evaluate: async () => text });
const DASH = "Ads Manager\nCampaigns\nSpend\n$3,306.82\nSettings";
const cases = [
  ["the account dashboard",        fakePage("https://ads.openai.com/manage/campaigns?act=x", "OpenAI Ads Manager", DASH), true],
  ["the auth host",                fakePage("https://auth.openai.com/log-in", "Welcome back - OpenAI", "Email address"), false],
  ["the tool's own /auth path",    fakePage("https://ads.openai.com/auth/login", "Sign in", "Email address"), false],
  ["the signed-out landing page",  fakePage("https://ads.openai.com/", "Advertise in ChatGPT", "Home\nLog in\nSign up\nAdvertise"), false],
  ["a bot check on the account",   fakePage("https://ads.openai.com/manage/campaigns", "Just a moment...", ""), false],
  ["an unrelated origin",          fakePage("https://example.com/", "Example", "Example"), false],
];
for (const path of ["/", "/manage/campaigns"]) {
  for (const text of ["", "Loading…", "Service unavailable", "Sign in\nEmail address\nPassword", "Campaigns", "Campaigns\nSpend", "Campaigns\nSpend\nSettings\nSign in"]) {
    cases.push([`incomplete or signed-out page ${path}: ${text}`, fakePage(`https://ads.openai.com${path}`, "OpenAI Ads Manager", text), false]);
  }
}
cases.push(["dashboard text on a public route", fakePage("https://ads.openai.com/", "", DASH), false]);
cases.push(["dashboard subpath is not yet recognized", fakePage("https://ads.openai.com/manage/campaigns/new", "", DASH), false]);
assert.equal(await reachedAccount(fakePage("https://example.test/manage/campaigns", "", DASH), playbookForUrl("https://example.test")), false, "unknown tools require explicit Continue");
for (const [label, page, want] of cases)
  assert.equal(await reachedAccount(page, pb), want, `reachedAccount on ${label}`);

// Headless Chrome names itself in the User-Agent, which bot protection rejects
// on sight — the single reason automated work could not run offscreen.
const { flagsFor, headlessUserAgent } = await import("../dist/chrome.js");
const ua = headlessUserAgent();
assert.ok(!/Headless/i.test(ua), "the headless User-Agent must not advertise headless");
assert.match(ua, /Chrome\/\d+\.0\.0\.0 Safari/, "it must still name a real Chrome version");
const head = flagsFor(false), less = flagsFor(true);
assert.ok(less.includes("--headless=new"));
assert.ok(less.some((f) => f.startsWith("--user-agent=")), "headless must override the User-Agent");
assert.ok(!head.includes("--headless=new"), "the sign-in window is never headless");
assert.ok(!head.some((f) => f.startsWith("--user-agent=")), "a real window needs no override");
for (const flags of [head, less]) {
  assert.ok(flags.includes("--enable-automation"));
  assert.ok(flags.includes("--disable-blink-features=AutomationControlled"));
}

// A browser that never produces a target is reported, not waited on forever.
const stuck = await serve((req, res) => {
  if (req.url === "/json/list") { res.end("[]"); return; }
  res.end("{}");
});
await assert.rejects(() => ensureTarget(1_200), /no window open/);
await new Promise((r) => stuck.close(r));
const { BROWSER_MODE } = await import("../dist/paths.js");
assert.equal(BROWSER_MODE, "launch", "tests must not start the user's browser");

console.log("PASS: sign-in URL, challenge detection, signed-out-page refusal, auth-origin bounce, raw-URL playbook, challenge markers, CLI resolution, sign-in detection, headless user-agent, windowless-browser recovery, and scoped bot-state reset");
