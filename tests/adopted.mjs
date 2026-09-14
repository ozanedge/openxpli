import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

process.env.OPENXPLI_DATA_DIR = mkdtempSync(join(tmpdir(), "openxpli-value-test-"));
const { openDb } = await import("../dist/db.js");
const { adoptedState } = await import("../dist/adopted.js");
const db = openDb();
db.prepare("INSERT INTO processes (id, tool, metric, policy, created_at) VALUES (?, ?, ?, ?, ?)")
  .run("test", "test", "CTR", JSON.stringify({ value_model: { annual_spend: 1200 } }), 0);
let seq = 0;
function outcome(id, review, { field = "title", object = "ad-a", winner = "variant", holdout = "none", status = "won" } = {}) {
  db.prepare(`INSERT INTO experiments (id, process_id, field, object, control_value, variant_value, started_at, ends_at, status)
    VALUES (?, 'test', ?, ?, 'old', 'new', 0, ?, ?)`).run(id, field, object, ++seq, status);
  db.prepare(`INSERT INTO outcomes (experiment_id, process_id, verdict, winner, final_multiple, review_state, holdout_state, decided_at)
    VALUES (?, 'test', 'won', ?, 2, ?, ?, ?)`).run(id, winner, review, holdout, seq);
}
function totals(active, potential, historical) {
  const s = adoptedState("test");
  assert.equal(s.activeAnnualValue, active);
  assert.equal(s.potentialAnnualValue, potential);
  assert.equal(s.historicalDecisions, historical);
  return s;
}
outcome("pending", "open");
assert.equal(totals(0, 600, 0).rows[0].state, "pending");
db.prepare("UPDATE outcomes SET review_state = 'merged' WHERE experiment_id = 'pending'").run();
totals(600, 0, 1);
outcome("rejected", "rejected");
outcome("reopened", "reopened", { status: "running" });
totals(600, 0, 1);
outcome("replacement", "merged");
assert.equal(totals(600, 0, 2).rows.find(r => r.experiment_id === "pending").superseded_by, "replacement");
outcome("other-object", "merged", { object: "ad-b" });
totals(1200, 0, 3);
db.prepare("UPDATE outcomes SET review_state = 'reverted' WHERE experiment_id = 'replacement'").run();
outcome("reversion", "no-change", { winner: "holdout", status: "failed" });
// The previous merged configuration becomes active again; the recovery adds no dollars.
totals(1200, 0, 4);
outcome("regressed", "merged", { holdout: "regressed", object: "ad-b" });
totals(600, 0, 5);
outcome("control", "no-change", { winner: "control", status: "failed" });
totals(600, 0, 5);
assert.equal(adoptedState("missing").activeAnnualValue, 0);
const html = readFileSync(new URL("../web/console.html", import.meta.url), "utf8");
for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
assert.ok(!html.includes("ad.banked") && !html.includes("adopted.banked"));
db.close();
console.log("PASS: pending, approval, rejection, reopened runs, supersession, object scope, reversion, regression, control, and console syntax");
console.log(`Scratch data: ${process.env.OPENXPLI_DATA_DIR}`);
