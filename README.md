# OpenXPLI

**Open experiments, loops, and iteration** — an open-source experimentation agent that enrolls
business processes running in the tools you already use, runs one controlled single-variable
experiment per process at a time, and merges winners like PRs. Every decision ships as a
git-committed, human-verifiable record.

> Engine scaffold. Current scope: the scheduling story end to end — hourly harvest as a *data contract* (idempotent, backfilling), launchd installation, heartbeat, and health checks. Playbooks, bindings (API → CLI → browser), stats, and the review verbs land next.

## Install

Build from source for now — no releases are published yet:

```sh
git clone https://github.com/ozanedge/openxpli.git && cd openxpli
npm install && npm run build
npm install -g .
openxpli doctor
```

Once releases start, install from a **versioned** tarball URL rather than a stable "latest"
one — npm caches tarballs by URL, so a stable name can silently serve stale bytes.

## Quick start

```sh
openxpli init                                  # data dir + sqlite + git ledger + hourly launchd job
openxpli add klaviyo/main-account --tool Klaviyo   # add a Connector: shadow mode, read-only
#   -> OpenXPLI analyzes it and proposes north star metrics it could be held to
openxpli goals klaviyo/main-account            # see the proposed goals and their guardrails
openxpli ratify main-account#g1                # ratify one — ledgered; this defines winning
#   -> experiments are then proposed *against* that goal, each with a rationale
openxpli accept main-account#1                 # accept a candidate to start the experiment
openxpli ui                                    # console at http://localhost:41100
openxpli harvest                               # fill all due hourly observations (safe anytime)
openxpli doctor                                # health: db, ledger, launchd, heartbeat
```

## Goals come before experiments

A connector is accountable to exactly one **goal**: a north star metric, a
direction, and the guardrails that must not regress while chasing it. The scout
proposes goals; a human ratifies one; the ratification is a git-committed ledger
record like any other decision.

Everything below the goal is measured against it:

- Candidates are generated **against** the ratified goal, and `accept` refuses a
  candidate that measures anything else. Accepting an experiment can never
  redefine what winning means — only ratifying a new goal can.
- An experiment is stamped with the goal it started under, so re-goaling a
  connector mid-flight cannot retroactively change what a finished run meant.
- Re-goaling **resets earned autonomy** to `human-gated`. The wins that earned
  self-starting were measured against a different definition of winning, so they
  do not transfer.

That last rule is the point. Without it, a self-starting connector picks the
candidate with the highest expected multiple every cycle — which means it picks
whichever metric it can most easily move, and grades itself on that.

Guardrails are recorded and checked at review. They are **not** read
automatically yet: that needs live bindings, and `resolveBinding` is still a
stub returning synthetic readings.

Autonomy is earned **per goal**, not per connector. Wins measured against a
metric you have since abandoned do not count toward self-starting.

## Outcomes

`connector → goals → experiments → outcome`. When a run ends, its outcome
becomes a row: verdict, final multiple, ledger record, review state, and
trailing-holdout state. The database is the **state machine**; the ledger record
is the **narrative** a human reads.

That separation matters because review state used to live *only* inside the
markdown record, and an autonomous merge was decided by string-matching
`"open (awaiting review)"` against prose. Now `approve` / `reject` / `extend`
move a real column, and autonomy reads it.

An outcome is stamped with the goal its run was bound to, so a finished result
always reports the metric it was actually measured against — even if the
connector has been re-goaled since. Multiples only compound within one goal;
the console refuses to blend across metrics and says so.

Every **Connector** initializes in shadow mode with read-only permissions — nothing is
changed until you accept an experiment, and autonomy beyond that is earned per-connector.
(`openxpli enroll`/`openxpli start` remain as power-user verbs for manual setups;
`openxpli enroll --demo` seeds the dogfood connector.)

## From source

```sh
git clone https://github.com/ozanedge/openxpli.git && cd openxpli
npm install && npm run build
node dist/cli.js doctor
```

## Design invariants

- **One experiment per process at a time.** Default run: 7 days — 168 hourly reads vs control. End above ×1.00 and the variant is adopted; at or below, it dies and is never adopted.
- **The hourly read is a data contract, not a cron contract.** `harvest` computes which observations are *due* and fills them, backfilling missed hours from sources that expose history. Unfillable hours are recorded as honest gaps. A sleeping laptop heals on wake.
- **Ticks are model-free.** The hourly loop is deterministic code; an agent is involved only at the edges (scouting, proposing, repairing broken browser steps).
- **Real scouting where a playbook exists.** For supported tools (first: ads.openai.com), `openxpli signin <connector>` opens a Chrome window to sign in once — the session lives in `~/.openxpli/browser-profile`, and OpenXPLI rides it **read-only**, never seeing credentials. Scouting then scrapes the live account state and has the model propose grounded candidates that cite what it actually saw. `openxpli rescout <connector>` (or the console's ↻ New suggestions) throws away the current proposals and scouts 3 fresh ones. Without a session or playbook, scouting falls back to template suggestions, honestly labeled.
- **The ledger is git.** Decision records are commits: diffable, portable, tamper-evident. Approval is a review; promotion is a merge.
- **Winners are validated, not just declared.** When a variant wins and is promoted, a small share of traffic (default 5%) stays on the old control for a 14-day trailing holdout. If the advantage persists, the ledger record is amended **VALIDATED**; if it decays (48h sustained at or below ×1.00 exits early), it's amended **TRAILING REGRESSION** with revert recommended — so a lucky week never quietly becomes the new baseline.

## Layout

- `src/cli.ts` — verbs: `init`, `enroll`, `harvest`, `status`, `doctor`
- `src/harvest.ts` — due-observation computation, backfill, finalize → ledger
- `src/bindings.ts` — reading interface (API → CLI → browser resolution; `synthetic` included for end-to-end exercise)
- `src/ledger.ts` — git ledger + decision records (`REC-XXXX.md`)
- `src/init.ts` — data dir, db, ledger, launchd LaunchAgent (hourly + on load)
- `src/doctor.ts` — health checks
- `src/ui.ts` + `web/console.html` — local console: read API over the db + the experiments chart, metric cards, and ledger list (binds 127.0.0.1 only)

State lives in `~/.openxpli/` (`openxpli.db`, `ledger/` git repo, `heartbeat.json`, `logs/`).

## License

Apache-2.0
