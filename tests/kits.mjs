import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.OPENXPLI_BROWSER_MODE = "launch";
process.env.OPENXPLI_DATA_DIR = mkdtempSync(join(tmpdir(), "openxpli-kits-test-"));
const { openDb } = await import("../dist/db.js");
const { requestKit, buildKit, retryKit, attachKitImage, recordKitLaunch, getKit, listKits, kitHtml, kitText, generateKitImage, assembleKit } = await import("../dist/kits.js");
const { act, jsonFrom, safeCrawlUrl } = await import("../dist/browser-scout.js");
const { setAutonomy, runAutonomy } = await import("../dist/autonomy.js");
const { acceptCandidate } = await import("../dist/scout.js");
const db = openDb();
db.prepare("INSERT INTO processes (id, tool, metric, autonomy, status, policy, created_at) VALUES ('ads/test', 'ChatGPT Ads', 'CTR', 'auto-merge', 'proposed', '{}', 0)").run();
db.prepare("INSERT INTO goals (id, source_id, metric, inverse, rationale, status, created_at) VALUES ('goal', 'ads/test', 'CTR', 0, 'Test', 'ratified', 0)").run();
const url = "https://ads.openai.com/ads/test";
const evidence = JSON.stringify([{ url, text: 'Signal Search\nFind signals faster\nSearch your logs in one place.\nLearn more\nhttps://example.com\nBlue product diagram', observedAt: Date.now(), ads: [{ object: "Signal Search", fields: { headline: "Find signals faster", description: "Search your logs in one place.", CTA: "Learn more", "destination URL": "https://example.com", image: "Blue product diagram" } }] }]);
const insert = db.prepare("INSERT INTO candidates (id, source_id, field, control_value, variant_value, metric, inverse, rationale, expected_multiple, status, created_at, evidence) VALUES (?, 'ads/test', ?, ?, ?, 'CTR', 0, 'A focused creative test.', 1.05, 'proposed', 0, ?)");
insert.run("headline", "headline", "Find signals faster", "Find the signal in your logs", evidence);
insert.run("image", "image", "Blue product diagram", "A clean diagram connecting logs to a clear answer", evidence);
insert.run("template", "headline", "current headline", "better headline", null);
insert.run("image-fail", "image", "Blue product diagram", "Minimal illustration of searching logs", evidence);
const draft = {
  title: "A clearer path to the signal", object: "Signal Search",
  fields: [
    { label: "headline", value: "Find signals faster", source: url },
    { label: "description", value: "Search your logs in one place.", source: url },
    { label: "CTA", value: "Learn more", source: url },
    { label: "destination URL", value: "https://example.com", source: url },
    { label: "invented claim", value: "Guaranteed 90% cheaper", source: url },
  ],
  imagePrompt: "A clean blue product diagram illustrating log search. No text or unsupported claims.", checks: ["Confirm the source ad and placement dimensions."],
};
// Two ads share a page, but their values must never be mixed.
const candidate = db.prepare("SELECT * FROM candidates WHERE id = 'image'").get();
const pages = JSON.parse(evidence);
pages[0].ads.push({ object: "Other ad", fields: { headline: "Other headline", CTA: "Buy now" } });
pages[0].text += "\nOther ad\nOther headline\nBuy now";
const mixedDraft = { ...draft, fields: [{ label: "CTA", value: "Buy now", source: url }] };
const assemble = (source, output = draft) => assembleKit({ ...candidate, evidence: JSON.stringify(source) }, {}, output);
assert.equal(assemble(pages, mixedDraft).fields.find(f => f.label === "CTA").value, null);
assert.equal(assemble(pages).fields.find(f => f.label === "CTA").value, "Learn more");
assert.equal(assemble(pages, { ...draft, object: "Signal" }).object, "Source ad needs confirmation");
assert.equal(assemble(pages, { ...draft, fields: [{ label: "CTA", value: "Learn", source: url }] }).fields.find(f => f.label === "CTA").value, null);
assert.equal(assemble(pages, { ...draft, fields: [{ label: "CTA", value: "Learn more", source: "https://wrong.example" }] }).fields.find(f => f.label === "CTA").value, null);
assert.ok(assemble([{ ...pages[0], ads: undefined }]).fields.every(f => f.value === null));
assert.ok(assemble([pages[0], pages[0]]).fields.every(f => f.value === null));
const wrongControl = assembleKit({ ...candidate, control_value: "Other headline", evidence: JSON.stringify(pages) }, {}, draft);
assert.ok(wrongControl.checks.some(check => check.includes("current control value")));
const png = readFileSync(new URL("../assets/logo/openxpli-lockup-horizontal.png", import.meta.url));
let textCalls = 0, imageCalls = 0;
const providers = {
  text: async () => { textCalls++; return JSON.stringify(draft); },
  image: async () => { imageCalls++; return png; },
};
assert.throws(() => requestKit("template", false), /Learn this account/);
const h = requestKit("headline", false);
assert.equal(requestKit("headline", false).id, h.id);
assert.match(acceptCandidate("headline"), /Nothing is launched/);
await Promise.all([buildKit(h.id, providers), buildKit(h.id, providers)]);
assert.equal(textCalls, 1);
assert.equal(imageCalls, 0, "copy test must not silently replace the image");
let ready = getKit(h.id);
assert.equal(ready.state, "ready");
assert.equal(ready.content.variant, "Find the signal in your logs");
assert.ok(!ready.content.fields.some(f => f.label === "headline"));
assert.equal(ready.content.fields.find(f => f.label === "invented claim").value, null);
assert.equal(db.prepare("SELECT COUNT(*) n FROM experiments").get().n, 0);
assert.equal(db.prepare("SELECT status FROM candidates WHERE id = 'headline'").get().status, "proposed");
assert.ok(kitHtml({ ...ready, content: { ...ready.content, title: '<script>alert("bad")</script>' } }).includes("&lt;script&gt;"));
assert.ok(!kitHtml(ready).includes("<script>"));
assert.match(kitText(ready), /not launched/);
const imageKit = requestKit("image", false);
await buildKit(imageKit.id, providers);
assert.equal(imageCalls, 1);
assert.equal(getKit(imageKit.id).has_image, true);
assert.equal(getKit(imageKit.id).content.fields.find(f => f.label === "headline").value, "Find signals faster");
await buildKit(imageKit.id, providers);
assert.equal(imageCalls, 1, "repeated build must not purchase another image");
const missing = requestKit("image-fail", false);
await buildKit(missing.id, { ...providers, image: async () => { throw new Error("Provider unavailable"); } });
assert.equal(getKit(missing.id).state, "needs-input");
assert.match(kitHtml(getKit(missing.id)), /Provider unavailable/);
assert.throws(() => recordKitLaunch(missing.id, "IDs", true), /Review the kit/);
retryKit(missing.id, false);
const beforeText = textCalls;
await buildKit(missing.id, { ...providers, text: async () => { throw new Error("must reuse saved brief"); }, image: async () => { throw new Error("Provider unavailable"); } });
assert.equal(textCalls, beforeText);
assert.throws(() => attachKitImage(missing.id, Buffer.from("not a png")), /PNG/);
assert.equal(attachKitImage(missing.id, png).state, "ready");
assert.throws(() => recordKitLaunch(h.id, "Control A, variant B", false), /confirm/);
assert.throws(() => recordKitLaunch(h.id, "", true), /launch details/);
ready = recordKitLaunch(h.id, "Control A, variant B; manually started at 10:00 UTC", true);
assert.equal(ready.state, "launched");
assert.equal(recordKitLaunch(h.id, "duplicate click", true).launch_note, ready.launch_note);
assert.ok(ready.launched_at, "save when the user reported the launch");
assert.equal(ready.experiment_id, null, "a launch report must not enroll an experiment");
assert.equal(recordKitLaunch(h.id, "duplicate click", true).launched_at, ready.launched_at);
assert.equal(db.prepare("SELECT COUNT(*) n FROM experiments").get().n, 0,
  "initial and repeated launch reports must not create runs or enable measurement");
assert.throws(() => attachKitImage(h.id, png), /before attaching/);
await assert.rejects(() => act({}, { url: "https://ads.openai.com", name: "ads" }), /Browser writes are disabled/);
assert.equal(existsSync(join(process.env.OPENXPLI_DATA_DIR, "receipts")), false);
assert.throws(() => setAutonomy("ads/test", "auto-start"), /not available/);
const beforeAutonomy = db.prepare("SELECT COUNT(*) n FROM experiments").get().n;
runAutonomy();
assert.equal(db.prepare("SELECT COUNT(*) n FROM experiments").get().n, beforeAutonomy,
  "autonomy must never start a run on its own");
db.prepare("UPDATE goals SET status = 'superseded' WHERE id = 'goal'").run();
assert.throws(() => recordKitLaunch(imageKit.id, "IDs", true), /goal changed/);
db.prepare("UPDATE goals SET status = 'ratified' WHERE id = 'goal'").run();
assert.equal(safeCrawlUrl("https://ads.openai.com/ads", "https://ads.openai.com"), true);
for (const target of ["https://evil.example/ads", "https://ads.openai.com/logout", "https://ads.openai.com/ads?action=delete", "javascript:alert(1)"])
  assert.equal(safeCrawlUrl(target, "https://ads.openai.com"), false);
assert.deepEqual(jsonFrom('prefix {"x":"a } [ bracket", "y":[1]} suffix', "{"), { x: "a } [ bracket", y: [1] });
const savedKey = process.env.OPENAI_API_KEY;
const savedFetch = globalThis.fetch;
try {
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(() => generateKitImage("brief"), /not configured/);
  process.env.OPENAI_API_KEY = "test-key-never-sent";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/images/generations");
    assert.equal(JSON.parse(options.body).n, 1);
    assert.equal(JSON.parse(options.body).output_format, "png");
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }), { status: 200 });
  };
  assert.deepEqual(await generateKitImage("brief"), png);
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  await assert.rejects(() => generateKitImage("brief"), /HTTP 503/);
} finally {
  globalThis.fetch = savedFetch;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
}
assert.equal(listKits("ads/test").length, 3);
db.close();
console.log("PASS: grounded kits, copy/image isolation, idempotency, retries, PNG upload, safe export, manual launch, goal drift, blocked browser writes/autonomy, and image API contract");
console.log(`Scratch data: ${process.env.OPENXPLI_DATA_DIR}`);
