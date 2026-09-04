import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_DIR, ensureDirs } from "./paths.js";
import { openDb, type ExperimentRow, type ProcessRow, type GoalRow, type Guardrail } from "./db.js";

function git(args: string[]): string {
  return execFileSync("git", ["-C", LEDGER_DIR, ...args], { encoding: "utf8" }).trim();
}

export function ensureLedger(): void {
  ensureDirs();
  if (!existsSync(join(LEDGER_DIR, ".git"))) {
    execFileSync("git", ["init", "-q", LEDGER_DIR]);
    writeFileSync(
      join(LEDGER_DIR, "README.md"),
      "# OpenXPLI Ledger\n\nEvery decision record in this repository was written by the OpenXPLI loop.\nApproval is a review; promotion is a merge; history is tamper-evident because git hash-chains it.\n"
    );
    git(["add", "-A"]);
    git(["commit", "-qm", "ledger: init"]);
  }
}

function nextRecId(): string {
  const n = readdirSync(LEDGER_DIR).filter((f) => f.startsWith("REC-")).length;
  return `REC-${String(101 + n).padStart(4, "0")}`;
}

// Ratifying a goal is the most consequential decision in the system: it
// defines what winning means for everything run beneath it. It gets a record
// like any other, so the definition of success is itself auditable.
export function writeGoalRecord(
  proc: ProcessRow,
  goal: GoalRow,
  previous: GoalRow | null,
  demotedFrom: string | null
): string {
  ensureLedger();
  const id = nextRecId();
  const guardrails: Guardrail[] = (() => { try { const v = JSON.parse(goal.guardrails); return Array.isArray(v) ? v : []; } catch { return []; } })();
  const body = `# ${id} — goal: ${proc.id} is accountable to ${goal.metric}

- **status:** ratified
- **process:** ${proc.id} (${proc.tool})
- **goal:** ${goal.id}
- **north star:** ${goal.metric} ${goal.inverse ? "(lower is better — scored as 1/x)" : "(higher is better)"}
- **agent:** openxpli/loop
- **ratified:** ${new Date().toISOString()}
${previous ? `- **supersedes:** ${previous.id} — ${previous.metric}\n` : ""}
## Why this metric
${goal.rationale}

## Guardrails
${guardrails.length
  ? guardrails.map((g) => `- \`${g.metric}\` — ${g.direction === "must-not-rise" ? "must not rise" : "must not drop"}`).join("\n")
  : "- none declared"}

> Guardrails are recorded here and enforced at review. They are not yet read
> automatically — that needs live bindings (\`resolveBinding\` is still a stub),
> so today they are a stated contract a human checks, not an automatic kill.

## What this changes
Every experiment on ${proc.id} from here measures \`${goal.metric}\`. Candidates
proposed against a different metric are dismissed, and accepting a candidate can
no longer redefine the goal — only this record can.
${demotedFrom ? `
## Autonomy reset
${proc.id} was at **${demotedFrom}** and has been returned to **human-gated**. The
wins that earned that autonomy were measured against \`${previous?.metric}\`, so they
do not transfer to a new definition of winning. It re-earns from here.
` : ""}
## Revert steps
1. Ratify the superseding goal record${previous ? ` (${previous.id} — \`${previous.metric}\`)` : ""} to restore the previous north star.
2. \`git revert\` this record's commit.
`;
  writeFileSync(join(LEDGER_DIR, `${id}.md`), body);
  git(["add", "-A"]);
  git(["commit", "-qm", `${id}: goal ratified for ${proc.id} — ${goal.metric}${previous ? ` (was ${previous.metric})` : ""}`]);
  return id;
}

export function writeDecisionRecord(
  proc: ProcessRow,
  exp: ExperimentRow,
  finalMultiple: number,
  observedHours: number,
  missingHours: number,
  won: boolean = finalMultiple > 1.0
): string {
  ensureLedger();
  const id = nextRecId();
  // Report against the goal this run was bound to, not whatever the connector
  // is pointed at now — a re-goal must never rewrite what a finished run meant.
  const ranUnder = exp.goal_id
    ? (openDb().prepare("SELECT * FROM goals WHERE id = ?").get(exp.goal_id) as GoalRow | undefined)
    : undefined;
  const metric = ranUnder?.metric ?? proc.metric;
  const stale = ranUnder && ranUnder.status === "superseded";
  const body = `# ${id} — ${exp.field}: ${exp.control_value} → ${exp.variant_value}

- **status:** ${won ? "open (awaiting review)" : "reverted (below ×1.00, never adopted)"}
- **process:** ${proc.id} (${proc.tool})
- **experiment:** ${exp.id}
- **agent:** openxpli/loop
- **goal:** ${ranUnder ? `${ranUnder.id} — \`${metric}\`${stale ? " (superseded since this run started; this record reports the goal it ran under)" : ""}` : "none recorded (pre-goals experiment)"}
- **run:** ${new Date(exp.started_at).toISOString()} → ${new Date(exp.ends_at).toISOString()}

## Hypothesis
Changing \`${exp.field}\` from \`${exp.control_value}\` to \`${exp.variant_value}\` improves \`${metric}\`.

## Evidence — read from ${proc.tool}
| Metric | Control | Variant | Δ |
|---|---|---|---|
| ${metric} | 1.00× | ${finalMultiple.toFixed(2)}× | ${((finalMultiple - 1) * 100).toFixed(1)}% |

## Statistics
- Final multiple vs control: **${finalMultiple.toFixed(3)}×**
- Runtime: ${Math.round(observedHours / 24)}d of 7d default (${observedHours} hourly reads, ${missingHours} recorded gaps)

## Action
${won ? "Variant recommended for adoption. Awaiting Approve & merge." : "Variant ended at or below ×1.00 — auto-reverted, not adopted."}

## Revert steps
1. In ${proc.tool}: set \`${exp.field}\` back to \`${exp.control_value}\`.
2. \`git revert\` this record's commit.
`;
  writeFileSync(join(LEDGER_DIR, `${id}.md`), body);
  git(["add", "-A"]);
  git(["commit", "-qm", `${id}: ${exp.id} ${won ? "won" : "failed"} ${finalMultiple.toFixed(3)}x`]);
  return id;
}

// Trailing regression finder: validation outcomes amend the original record
// (a new commit — the ledger's history stays tamper-evident).
export function appendValidation(
  recordId: string,
  outcome: "validated" | "regressed",
  vsHoldout: number,
  observedHours: number,
  share: number,
  early: boolean
): void {
  ensureLedger();
  const path = join(LEDGER_DIR, `${recordId}.md`);
  const section = `
## Validation — trailing holdout
- **outcome:** ${outcome === "validated" ? "VALIDATED — win persists vs holdout" : `TRAILING REGRESSION${early ? " (caught early)" : ""} — advantage did not persist; revert recommended`}
- **holdout share:** ${(share * 100).toFixed(0)}% remained on the old control
- **vs holdout at exit:** ${vsHoldout.toFixed(3)}×
- **validation runtime:** ${observedHours} hourly reads${early ? " — stopped early on sustained drop" : ""}
${outcome === "regressed" ? "- **action:** execute this record's revert steps; holdout becomes control again\n" : ""}`;
  writeFileSync(path, readFileSync(path, "utf8") + section);
  git(["add", "-A"]);
  git(["commit", "-qm", `${recordId}: holdout ${outcome} ${vsHoldout.toFixed(3)}x`]);
}
