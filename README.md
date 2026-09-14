# OpenXPLI

**Open experiments, loops, and iteration.** OpenXPLI learns a business tool through
the browser and prepares an experiment kit: copy, creative, source observations,
and instructions you can use to set it up yourself.

**Current milestone: learn → prepare → review → manual launch.** You control the
account. Preparing a kit does not publish ads, change settings, allocate budget,
or start an experiment clock. Browser writes and automatic starting/merging are
disabled in code, including for connectors with older saved autonomy settings.

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
openxpli add ads-openai/main-account --tool "ChatGPT Ads"
openxpli signin ads-openai/main-account       # sign in yourself, then close Chrome
openxpli goals ads-openai/main-account
openxpli ratify main-account#g1              # choose the north star
openxpli rescout ads-openai/main-account     # read the account, propose grounded ideas
openxpli ui                                 # Connectors → Prepare experiment kit
```

The browser learns through bounded navigation without clicking or filling account
controls. Mutating HTTP methods and action-like navigation URLs are blocked during
learning. A dashboard that needs POST-based reporting may require a reviewed read
adapter; a blocked/failed crawl is not presented as successful account learning.
Template suggestions are labeled and cannot produce an account-specific kit.

In the console, **Sign in with Chrome** queues a sign-in window. After signing in,
click **I’m signed in — continue**; OpenXPLI closes its window and learns the account.
Closing the last sign-in window also continues. **Learn account** refreshes observations.

All connectors and scheduled browser readers share one queue for the saved browser
profile. Tasks queued behind another managed task show **Waiting for browser**.
If an older OpenXPLI window holds the profile, launch stops after one attempt.
Close that window, then explicitly retry; regular Chrome windows can stay open. **Cancel browser task** stops only the task you selected.
Repeated clicks reuse the same task, and interrupted workers become retryable.
Failed learning preserves previous suggestions and does not replace them with templates.

Choose **Prepare experiment kit** beside a suggestion. The saved kit includes:

- The source ad, control, exact proposed change, and observed source pages.
- Copy buttons for the new text and the existing strings to preserve.
- For image tests, a generated PNG and image brief; for copy tests, instructions
  to reuse the original image (optionally attach it to the package).
- A preview, setup instructions, and checks for details the browser could not verify.
- A self-contained HTML download with the attached image embedded, a text guide,
  JSON, and the PNG separately. The HTML can be opened offline or printed to PDF.

A kit changes **one variable**. New copy belongs in a copy test; a new image
belongs in an image test with unchanged copy. Unknown account values remain
explicitly unknown. Existing strings are checked against the cited observations.
A draft still requires your review of claims, placement requirements, and settings.

After setting it up in the ad tool, **I launched this myself** records your notes
and confirmation. It does not verify activation, enroll a running experiment, or
start automatic measurement. Existing experiment reporting remains available as
a legacy view; kit preparation is separate from that engine.

For the CLI, `openxpli prepare <candidate-id>` waits for a kit, while
`openxpli accept <candidate-id>` queues preparation and returns immediately.
Both produce a kit, not a running experiment. Failed preparation is retryable;
an image failure preserves the completed copy and setup guide.

## Text and image generation

Text uses the existing authenticated `claude` CLI, with built-in tools and MCP
servers disabled for generation. The selected candidate, its observed account
pages, and the declared brand policy are supplied as context.

Image tests use the [OpenAI Images API](https://developers.openai.com/api/docs/guides/image-generation).
Set `OPENAI_API_KEY` in the environment of the console/CLI process. The default
image model is `gpt-image-2.5-sunburst`; override with `OPENXPLI_IMAGE_MODEL`.
Generation requests one PNG at 1536 × 1024 with medium quality. This is a draft
size, not a claim about the ad platform's accepted dimensions. Only the creative
brief is sent to the image provider, not the browser session or credentials.

If the provider is unavailable or unconfigured, the kit shows **Image needed**.
You can attach a PNG up to 12 MB, or configure the provider and retry. Successful
images are reused on retries; there is no automatic repeat purchase. API keys
stay on the server and are never requested in the console or included in exports.

Kits and images are stored locally in SQLite under `OPENXPLI_DATA_DIR` (default
`~/.openxpli`). Browser observations are private account data; review a kit before
sharing its exports. The live install is never needed for testing:

```sh
npm run build
node tests/adopted.mjs
node tests/kits.mjs
node tests/kits-ui.mjs   # scratch data + headless Chrome, port 41201
node tests/browser-flow.mjs
node tests/browser-flow-ui.mjs # real profile contention + Continue flow, port 41202
```

The tests cover preparation, copy/image isolation, retries, missing providers,
image upload, downloads, manual launch recording, and blocked automatic actions.
The image API contract is tested with a mock; no API calls are billed by tests.

## Existing measurement engine

The sections below describe the earlier measurement/review machinery, retained
for existing runs. It is not activated by the manual kit flow. Automatic browser
execution and autonomy remain disabled until a later milestone.

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

Guardrails are recorded, but review does not yet enforce measured guardrail results. They are **not** read
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

The console separates **active annualized value** (approved, unreplaced changes)
from **potential value** (finished wins awaiting approval). Rejected results,
reopened runs, and regressed or reverted changes do not contribute to the active
estimate. Replacement is scoped to the experiment's object and field; reverting
a replacement can restore the preceding approved configuration. Historical
adoptions and holdout reversions are counted separately, without adding recovery
estimates to the active total. These are estimates from the declared value model,
not realized savings; changes without a value model contribute no dollar estimate.

To verify value reporting against an isolated scratch database:
`npm run build && node tests/adopted.mjs`.

Every **Connector** initializes in shadow mode with read-only permissions — account changes are made manually. Accepting a suggestion now prepares a kit.
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
- **Real scouting where a playbook exists.** For supported tools (first: ads.openai.com), `openxpli signin <connector>` opens a Chrome window to sign in once — the session lives in `~/.openxpli/browser-profile`, and OpenXPLI rides it **read-only**, never seeing credentials. Scouting then scrapes the live account state and has the model propose grounded candidates that cite what it actually saw. `openxpli rescout <connector>` (or the console's ↻ New suggestions) queues browser learning and replaces proposals only after it succeeds. Supported connectors require a successful browser read; failed learning keeps previous suggestions. Tools without a playbook may show templates, which cannot produce an account-specific kit.
- **The ledger is git.** Decision records are commits: diffable, portable, tamper-evident. Approval is a review; promotion is a merge.
- **Legacy holdouts.** Older runs may have trailing holdouts. New engine runs use an in-run holdout arm; this is separate from manual kits and is not proof that an external rollback occurred.

## Layout

- `src/kits.ts` — saved manual experiment kits, image generation, exports, and launch confirmations
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
