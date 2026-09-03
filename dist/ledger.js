import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_DIR, ensureDirs } from "./paths.js";
function git(args) {
    return execFileSync("git", ["-C", LEDGER_DIR, ...args], { encoding: "utf8" }).trim();
}
export function ensureLedger() {
    ensureDirs();
    if (!existsSync(join(LEDGER_DIR, ".git"))) {
        execFileSync("git", ["init", "-q", LEDGER_DIR]);
        writeFileSync(join(LEDGER_DIR, "README.md"), "# OpenXPLI Ledger\n\nEvery decision record in this repository was written by the OpenXPLI loop.\nApproval is a review; promotion is a merge; history is tamper-evident because git hash-chains it.\n");
        git(["add", "-A"]);
        git(["commit", "-qm", "ledger: init"]);
    }
}
function nextRecId() {
    const n = readdirSync(LEDGER_DIR).filter((f) => f.startsWith("REC-")).length;
    return `REC-${String(101 + n).padStart(4, "0")}`;
}
export function writeDecisionRecord(proc, exp, finalMultiple, observedHours, missingHours, won = finalMultiple > 1.0) {
    ensureLedger();
    const id = nextRecId();
    const date = new Date(exp.ends_at).toISOString().slice(0, 10);
    const body = `# ${id} — ${exp.field}: ${exp.control_value} → ${exp.variant_value}

- **status:** ${won ? "open (awaiting review)" : "reverted (below ×1.00, never adopted)"}
- **process:** ${proc.id} (${proc.tool})
- **experiment:** ${exp.id}
- **agent:** openxpli/loop
- **run:** ${new Date(exp.started_at).toISOString()} → ${new Date(exp.ends_at).toISOString()}

## Hypothesis
Changing \`${exp.field}\` from \`${exp.control_value}\` to \`${exp.variant_value}\` improves \`${proc.metric}\`.

## Evidence — read from ${proc.tool}
| Metric | Control | Variant | Δ |
|---|---|---|---|
| ${proc.metric} | 1.00× | ${finalMultiple.toFixed(2)}× | ${((finalMultiple - 1) * 100).toFixed(1)}% |

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
export function appendValidation(recordId, outcome, vsHoldout, observedHours, share, early) {
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
