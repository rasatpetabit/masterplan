# masterplan

> A Claude Code & Codex CLI plugin for durable multi-hour engineering work — brainstorm → plan → execute → finish on top of `obra/superpowers` skills.

Current release: **v10.0.2** · **License:** MIT · **Works with:** Claude Code, Codex CLI · See [CHANGELOG.md](./CHANGELOG.md)

---

## What is masterplan

masterplan provides the `/masterplan` slash command. It orchestrates a **brainstorm → plan → execute → finish** development lifecycle on top of the `obra/superpowers` skills suite.

The core design principle: **state lives on disk, not in the chat session.** A run bundle at `docs/masterplan/<slug>/` is the single source of truth. The orchestrator sequences decisions; all real work is delegated to short-lived subagents that return digests, never raw logs. If the session crashes, compacts, or is cleared, `/masterplan` re-reads the bundle and picks up exactly where it left off.

---

## The Four-Phase Lifecycle

```
brainstorm  →  plan  →  execute  →  finish
```

| Phase | What happens |
|---|---|
| **brainstorm** | Codebase discovery; `spec.md` authored and reviewed |
| **plan** | `spec.md` → task decomposition → `plan.index.json` + `plan.md` |
| **execute** | Wave-by-wave task dispatch; each wave is one `mp dispatch-wave` launch |
| **finish** | Verification → `retro.md` → branch-finish gate → archive |

The `state.yml` `phase` field holds the enum `brainstorm|plan|execute`. **finish** is a terminal finalization flow that fires automatically when the last execute wave completes — it is not a phase value.

---

## Architecture

masterplan v8 is a five-layer system. Each layer delegates downward and never writes state on behalf of the layer above it.

```
┌─────────────────────────────────────────────────────────────┐
│  L0 — Run bundle (disk)                                      │
│  docs/masterplan/<slug>/state.yml  spec.md  plan.md          │
│  plan.index.json  events.jsonl  retro.md  handoff.md         │
└───────────────────────┬─────────────────────────────────────┘
                        │ read / atomic write (CD-7)
┌───────────────────────▼─────────────────────────────────────┐
│  L1 — Thin shell                                             │
│  commands/masterplan.md  (~600-line verb sequencer)          │
│  bin/masterplan.mjs  (mp — filesystem-only subcommands)      │
│  lib/resume.mjs  (pure decideNextAction)                     │
│  ← SOLE durable state writer; git commit/checkout live here  │
└───────────────────────┬─────────────────────────────────────┘
                        │ launch + receive digests
┌───────────────────────▼─────────────────────────────────────┐
│  L2 — Fabric dispatch path (`mp dispatch-wave` →             │
│  `dispatchWaveViaFabric` in `lib/dispatch-wave.mjs`; the     │
│  deleted Workflow engine's replacement — native spawn plans  │
│  (descriptors for the harness subagent API))                 │
│  lib/plan-merge.mjs  lib/dispatch/  lib/wave.mjs             │
│  ← returns digests/fragments only; never writes disk/git     │
└───────────────────────┬─────────────────────────────────────┘
                        │ bounded briefs / structured digests
┌───────────────────────▼─────────────────────────────────────┐
│  L3 — Agents                                                 │
│  agents/mp-goal-assessor.md   agents/mp-adversarial-reviewer.md │
│  agents/mp-planner.md         agents/mp-plan-reviewer.md       │
│  agents/mp-plan-reviewer.md   agents/mp-subsystem-planner.md │
│  agents/mp-spec-decomposer.md agents/mp-alignment-auditor.md │
│  ← no session history; return structured output only         │
└───────────────────────┬─────────────────────────────────────┘
                        │ node bin/doctor.mjs
┌───────────────────────▼─────────────────────────────────────┐
│  L4 — Doctor                                                 │
│  bin/doctor.mjs  dispatcher                                  │
│  lib/doctor/*.mjs  (24 check modules, auto-discovered)       │
│  ← Finding {id, severity, summary, fix}; non-zero on ERROR   │
└─────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- L1 (`commands/masterplan.md` + `mp`) is the **only** durable state writer (CD-7). All state mutations go through `mp` subcommands; L2 and below never commit to git or write `state.yml`.
- `bin/masterplan.mjs` is **filesystem-only** — git (`commit`, `checkout`, `clean`) is the shell's job.
- L2 fabric dispatch communicates via descriptors on launch and return digests in the completion notification.

---

## Installation

### Claude Code

Run inside the Claude Code CLI:

```
/plugin marketplace add rasatpetabit/masterplan
/plugin install masterplan@rasatpetabit-masterplan
/reload-plugins
```

> The marketplace commands register the catalog and install the `masterplan-detect` skill. The upstream `superpowers` core plugin is declared as a dependency and will be automatically resolved. See [docs/install.md](docs/install.md) for offline, desktop-app, or manual installation paths.

### Codex CLI

```sh
codex plugin marketplace add rasatpetabit/masterplan
```

Codex hosts the orchestrator under `/masterplan:masterplan`. See [Codex hosting](#codex-hosting) below for suppression and behavior details.

---

## Usage / Quick Start

**Start a new run end-to-end:**

```
/masterplan full <topic>
```

**Start step-by-step:**

```
/masterplan brainstorm <topic>   # discovery + spec
/masterplan plan                 # decompose spec into tasks
/masterplan execute              # wave-by-wave execution
```

**Resume after a crash or clear:**

```
/masterplan                      # bare — re-reads bundle, continues
```

**Check run health:**

```
/masterplan status               # active bundle summary
/masterplan doctor               # structural lint (24 check modules)
```

---

## Verbs

All verbs route through the single `/masterplan <verb>` command. v8 ships no per-verb skills.

| Verb | What it does |
|---|---|
| `full <topic>` | End-to-end pipeline: brainstorm → plan → execute → finish |
| `brainstorm <topic>` | Codebase discovery; produce `spec.md` |
| `plan [<topic>]` | Decompose the approved spec into `plan.index.json` + `plan.md` |
| `execute [<path>]` | Run one wave of tasks; resume an active bundle |
| `finish [--retro-only]` | Finalization flow (verify → retro → branch-finish gate → archive). `--retro-only` regenerates `retro.md` only |
| `import` | Migrate legacy planning artifacts into a v8 run bundle (`mp migrate-bundle`) |
| `doctor [--fix]` | Structural lint across all bundles; `--fix` repairs repairable issues |
| `status` | Visual summary of the active bundle: phase, wave, recent events |
| `validate` | Schema-validity check on `state.yml` bundles |
| `stats` | Telemetry roll-up — a `jq` summary over the bundle's `events.jsonl` |
| `clean` | Archive stale bundles (`mp set-status --status=archived`) and prune orphan artifacts |
| `next` | Route to the next actionable in-progress bundle |
| `verbs` | Print this verb list |
| `render` | Re-render `plan.html` with live per-task status from `state.tasks` (read-only; static `plan.html` is also auto-emitted at plan-finalize) |
| `retro` | **Deprecated alias** → `finish --retro-only` |
| `publish` | Lead → GitHub: project the current wave onto GitHub issues + provision refs (spec §7.1) |
| `follow` | Follower session: claim one task, build it, and open a PR against the integration branch (spec §7.1) |
| `interview` | §5.3 intent interview ledger verbs: `ask`, `answer`, `withdraw`, `draft`, `critic`, `replay` (via `mp interview`) |
| `context-status` | Report measured/unknown context usage (via `mp context-status`) |
| `resume-brief` | Resolve active bundles + render a carry-forward brief (via `mp resume-brief --repo-root`) |
| *(bare)* | Resume controller — re-reads active bundle and continues |

---

## Run Bundle & State (L0)

The run bundle at `docs/masterplan/<slug>/` is the portable database for a run:

| File | Purpose |
|---|---|
| `state.yml` | Single source of truth (CD-7). Atomic writes via tmp-file + rename |
| `spec.md` | Product design specification |
| `plan.md` | Human-readable projection of `plan.index.json` |
| `plan.index.json` | Machine-canonical task list with wave assignments and routing |
| `events.jsonl` | Append-only operational log (commits, decisions, completions) |
| `retro.md` | Development retrospective (written at finish) |
| `handoff.md` | Optional carry-forward notes |

The bundle + artifacts are sufficient to resume any run losslessly — including across model swaps, host changes, and session compactions.

---

## Deterministic Planning

The L2 plan path produces `plan.index.json` without the LLM ever authoring the final bytes:

1. Approved `spec.md` → `mp-spec-decomposer` carves file-disjoint **subsystems**.
2. `dispatch-plan` fans out one `mp-subsystem-planner` per subsystem in parallel; each returns a task **fragment**.
3. `lib/plan-merge.mjs` merges deterministically:
   - Assigns integer task ids.
   - Assigns wave numbers via **Kahn topological order** with a file-conflict bump (dependency-free, file-disjoint tasks share the lowest wave = maximal safe parallelism).
   - Normalizes the `codex` routing annotation to the string enum `"ok"|"no"|null`.
   - Validates the schema.
   - Renders `plan.md` as a pure projection of `plan.index.json`.

A simpler serial path exists: `mp-planner` writes the plan directly; L1 still validates the schema.

---

## Wave Execution & Scope Verification

The L2 execute path runs **one wave per `mp dispatch-wave` launch**:

- `pipeline(tasks, implement, review)` is **non-barrier**: a task's review starts the moment its implement finishes.
- Implementation is **inline-only** via native spawn descriptors (no separate implementer agent path). Each implementer runs the task's `verify_commands` and returns a digest citing real output.
- Review is **config-gated and class-resolved**: it runs only when the bundle's review is armed (`state.review.adversary`, which `mp prepare-wave` surfaces to the L2 path as the `"on"` payload it gates on), and the wave dispatcher resolves the `adversary` class from the routing policy (breaker role, frontier lane; adversarial panel for cross-vendor coverage) — `agents/mp-adversarial-reviewer.md` is the contract document for that review, not a runtime-named file.

After the wave barrier, L1 runs **D6 scope verification**:

1. Compute the set of files touched since the git baseline.
2. Compare against the union of the wave tasks' declared `files`.
3. Any out-of-scope paths are **reverted** (`git checkout`/`git clean --` scoped to those paths) and left pending for re-dispatch.
4. L1 commits state + in-scope edits together (state leads git, per CD-7).

---

## The Finish Flow

When the last execute wave's tasks are all `done`, the orchestrator **auto-fires the finalization flow** instead of silently archiving:

1. **Verify** — run the project's verification via `superpowers:verification-before-completion`, citing real output. A failing suite opens a hard-stop gate (fix-first / proceed-anyway-reviewed / abort). No silent archive over red.
2. **Goal check** — on a `goals_enabled` bundle, `mp-goal-assessor` runs per-goal checks in `implementation` mode (base..tip diff + verify output) before disposition and in `final` mode after the live check (binding tuple `{deploy_base_sha, deploy_chain_hash, live_check_digest}` via `mp record-goal-check --final`).
3. **Retro** — write `retro.md` if absent; the `## Completion` block reports the completion class and (for install-pushed runs) `pushed: yes/no`.
4. **Branch-finish gate** — open a durable `branch_finish` gate and surface an `AskUserQuestion`:
   - Merge to base locally
   - Push + open PR
   - Keep branch as-is
   - Discard

   This gate delegates to `superpowers:finishing-a-development-branch` and **always halts** regardless of autonomy level (it is a risky-action gate).
5. **Final intent confirmation** — for deployed runs, the `intent_confirm` gate opens **after** a final assessment receipt bound to the latest deploy base; `--intent-confirmed` re-audits the boundary and the receipt must still be valid and `met`. Only an accepted confirmation writes `completion_confirmed`.
6. **Archive** — last, after the user resolves the gate. The archive writes `state.completion` from durable authorization events (`completion_confirmed` / `incomplete_authorized`); an archive whose state carries a completion the ledger does not authorize is refused.
7. **Push publication** — install-group runs that moved `origin/<base>` open the post-archive `push_archive` gate (`--archive-pushed <sha>` / `--archive-push-skipped`); re-entry without `archive_pushed` re-emits the gate and reports `pushed: no`.

`/masterplan finish` runs this flow manually. `/masterplan finish --retro-only` regenerates just `retro.md`.

### Completion and push classes

`state.completion` is one of:

- `complete` — fully deployed and confirmed (`completion_confirmed` bound to the latest deploy base, plus a met final assessment).
- `merged` — done with no deploy (code merged, no definition of done satisfied).
- `incomplete:<reason>` — an authorized shortfall, where `<reason>` is exactly the terminal reason the archive derives from the ledger: `no_definition_of_done`, `deploy_abort`, `version_not_bumped`, `kept`, `discarded`, `attested`, `intent_waived` (bare), or a qualified prefix `deploy_skip:<group>[<index>]` / `deploy_abort:<gate>` / `intent_rejected:<class>` (`isStageTerminalReason` in `lib/finish-step.mjs`).
- `legacy` — a pre-v10 archive with no completion field (reported as `legacy`, never guessed).

`archive_pushed` / `archive_push_skipped` are the only events accepted after archive; `pushed: no` persists until `archive_pushed` lands.

### Required successors

An `intent_rejected:<class>` archive writes `required_successor {slug, reason}` (slug from the mandatory `--successor` flag; a rejection without it is refused before any event is written). `mp runs list` and `mp status` print the open obligation with the exact seed command (`mp seed --predecessor=<slug>`); for class `intent`, the stored correction text opens the successor's interview as quoted context. The `required-successor` doctor check verifies the obligation resolves to a seeded bundle.

### Overlap review (before every seed)

Every `mp seed` runs `mp runs list` to build the inventory, requires an `--overlap-review=<json>` decision, and records the `overlap_review` event second (after `bundle_created`). A review whose `inventory_sha256` no longer matches the runs inventory is refused as `overlap_review_stale`, and a refused seed leaves no bundle directory. `mp record-overlap-review --review-file=<json>` writes the decision; the seed lock is held across validate-then-create and `mp sweep --apply` breaks a dead-pid lock.

### Intent interview

The §5.3 intent interview is a bounded, ledger-backed sequence of `mp interview` subcommands: `ask` / `answer` / `withdraw` / `draft` / `critic` (each an `events.jsonl` append through `lib/interview.mjs`). `mp interview replay` prints every question, answer, withdrawal, draft, and critic receipt in order. The `mp-intent-critic` agent receives exactly three quoted-data blocks (the verbatim `goals.md` topic anchor, the verbatim replay ledger, and the current intent draft); its receipt is recorded through `mp interview critic --receipt=<json> --payload-file=<json>`. Intent is consumed during planning and assessment, and the terminal states are `converged | exhausted | critic_off`.

---

## Resume & Durability (Gates)

`lib/resume.mjs` exports a pure `decideNextAction(state, opts)` that returns one of a small set of action types. The shell (`commands/masterplan.md`) executes the action and loops.

**`surface_gate` has top priority:** if a named gate is open in `state.yml`, the resume controller re-renders its `AskUserQuestion` before anything else — regardless of context compaction. This makes gates **compaction-safe** (CD-9): a gate opened in turn N is still visible in turn N+100 after a full session compaction.

Crash before a commit is safe: `state.yml` leads git, so `decideNextAction` re-derives the correct action from already-marked task state.

---

## Doctor

`node bin/doctor.mjs` runs 24 check modules under `lib/doctor/*.mjs`, auto-discovered alphabetically. Each module exports:

```js
check(repoRoot, opts) -> Finding[]
```

A Finding has the shape `{id, severity, summary, fix}` where `severity` is one of `PASS | WARN | ERROR | SKIP`. The process exits non-zero if any Finding has severity `ERROR`.

`/masterplan doctor --fix` applies safe automatic repairs for checks that implement an autofix handler, then reruns the doctor. Findings whose remedies require human judgment remain report-only.

See [docs/internals/doctor.md](docs/internals/doctor.md) for the full check catalog and crash-isolation contract.

---

## Configuration

Configuration resolves through a **four-layer hierarchy — CLI > repo > user > default** (`lib/config.mjs`, `resolveRunConfig`):

1. **CLI** — `mp seed` / `mp continue` flags win over everything.
2. **Repo** — `.masterplan.yaml` at the repository root.
3. **User** — `~/.masterplan.yaml` in the home directory.
4. **Default** — the schema default when no layer sets the value.

Each recognized key is validated against the schema enum and its **source layer** is reported (`config show` prints the resolved values and `*_source` for every key). `done` and `context_watch` support whole-object replacement with partial `context_watch` defaults; `auto_compact` is a deprecated alias for `context_watch` (both present → refused). Unsupported keys are warned and ignored; a malformed file or an invalid enum value is a hard error — a value never silently falls through to a lower layer.

**Recognized config keys** (schema `CONFIG_SCHEMA`):

| Key | Values | Default | Notes |
|---|---|---|---|
| `complexity` | `low \| medium \| high` | `medium` | Influences planning depth; `--complexity-source` records how it was set. `low` defaults `planning_mode` to `serial`, otherwise `auto` |
| `autonomy` | `gated \| loose` (alias `full` → `loose`) | `gated` | `gated` halts at every gate; `loose` auto-advances through successful gates; the branch-finish gate always halts regardless |
| `planning_mode` | `serial \| parallel \| auto` | derived from complexity | `serial` = one `mp-planner`; `parallel` = `mp-subsystem-planner` fan-out merged by `lib/plan-merge.mjs` |
| `adversary_review` | `on \| off` | `on` | Default-on finish-time adversary review; new bundles arm `state.review.adversary: true` |
| `render_images` | `on \| off` | `off` | Gates the optional shell-side image *generation*; embedding is by-presence |
| `fabric` | `on \| off` | `on` | The schema accepts `on\|off`; the legacy L2 wave path is deleted, so `off` marks a bundle **unexecutable** (no `state.dispatch.fabric: true` → dispatch refused, nothing restored) |
| `context_watch` | object | `{threshold: 70, focus: null}` | `context_watch.threshold` is an int 1–99; `context_watch.focus` is a string or null |
| `done` | object | none | The definition of done: `version_from`, `release` steps in **fixed deploy order** (see below), `${version}` substitution, `commit_paths` |

**Seed-time flags** (`mp seed`, persisted into `state.yml` at run creation): `--complexity`, `--autonomy`, `--planning-mode`, `--adversary-review=on|off` (alias `--codex-review`), `--render-images=on|off`, `--fabric=on`, `--overlap-review=<json>` (required — see Overlap below), `--predecessor=<slug>`. `mp continue` accepts `--planning-mode` on the command line and resolves it through the same chain.

**Definition of done (`done`)** — deploy groups run in a **fixed order** across `release → install → user_only → live_check` (`DEPLOY_GROUP_ORDER` in `lib/finish.mjs`): every `release` step runs first, then every `install` step, then `user_only`, then the `live_check` run. Group order is normative; **within** a group, steps run in their list order. A `done: none` definition deploys nothing. `version_from` points at a version-bearing file (e.g. `.claude-plugin/plugin.json`) and `${version}` is substituted into release commands. Deploy steps are recorded via `mp finish-step --deploy-step-done=<group>[<index>] --exit=<code>`; a failing step opens a hard gate.

**Review config** (`mp set-review-config`, a CD-7 write on an existing bundle — *not* a seed flag; alias: `mp set-codex-config`): `--review=true|false` arms/disarms `state.review.adversary`; `--routing=auto|on|off` is the legacy per-task dispatch default.

### Environment

Every `readEnv`-backed control — set these in the environment, not in config files (the seam is `readEnv`/`readEnvAll` in `bin/masterplan.mjs`; `env.X` property reads in `bin/` + `lib/` go through the same seam):

| Variable | Controls | Default |
|---|---|---|
| `CLAUDE_CODE_SESSION_ID` | **Guard-D session identity** (the owner lock's identity is the LLM session, not the process). Companion flags: `--session=<id>`, `--host=<host>` to `mp seed` / `mp continue` / `mp record-result` | none — Guard-D refuses without a session id unless the bundle opted out (`--owner-lock=off`) |
| `MP_DISPATCH_WAVE_CONCURRENCY` | Caps the wave fan-out parallelism (`lib/continue.mjs`, clamped to the descriptor count) | `8` |
| `MP_ROUTING_POLICY` | Path to an override routing policy for work-class resolution (defaults to the checked-in `policy/workflow-map.json`) | checked-in repo copy |
| `SKYNET_VERIFY_ALLOWLIST` | Recorded verify allowlist for audit continuity (historical name; local verification does not gate on it — the value surfaces in the wave record) | `bash -c` |
| `MP_CONTEXT_WINDOW` | Explicit context window override for `mp context-status` window resolution (takes precedence over harness-model/`[1m]` markers, below the explicit flag) | auto |
| `MP_BIN` | Path to the `bin/masterplan.mjs` entrypoint | `bin/` beside the command file |
| `MP_MARKETPLACE_DIR` / `MASTERPLAN_RUNS_DIR` | Install/run-discovery roots | auto-derived |
| `CLAUDE_CONFIG_DIR` / `HOME` | Config and home roots for the user layer | platform defaults |
| `CLAUDE_PLUGIN_ROOT` | Claude plugin install root — `readPluginVersion` resolves the installed plugin's `version` from `$CLAUDE_PLUGIN_ROOT/.claude-plugin/plugin.json` (falls back to the repo-local `.claude-plugin`) | repo-local `.claude-plugin` |
| `PI_CODING_AGENT` | Set by the Pi harness: routes `shouldSuppressWorkflow` to the no-Workflow path (foreground-sequential waves, no Workflow handle) — `=true` changes execution routing | unset (Claude Code host) |

`mp context-status` reports the measured context window (`tokens_at_last_request`, `appended_est`, `window`) and one of `current` / `post-compaction` / `malformed` / `not-found` / `unsupported` (`lib/context-status.mjs`; `not-found` when no transcript resolves, `unsupported` when there is no session id). When no measurement is available (`not-found` / `malformed` / `unsupported`) the reported `window` is `null` and `used_pct` is `null` — there is no `unknown` state. `MP_CONTEXT_WINDOW` overrides the window (or `--window=<n>` explicitly). `mp resume-brief --repo-root=<path>` resolves zero, one, or several active bundles and renders a carry-forward brief — wired as a SessionStart hook on hosts that register hooks.

### Finish-time review audit channel

Every finish-time review outcome — success, skip, or defensive arm — emits a durable event to `events.jsonl`. Searchable by `adversary_review*` prefix (legacy `codex_review*` events from in-flight bundles still satisfy the re-entry guard):

- `adversary_review` — review completed (summary: `adversary review complete ...`).
- `adversary_review_skipped` — review was configured but didn't run (summary includes a typed reason: `state.review.adversary not armed`, `codex_host_suppressed`, or `no_base_branch`).
- `adversary_review_defensively_armed` — legacy bundle missing the review config was defensively armed once at the finish gate (one-time per bundle, presence-scoped).

A future `adversary_review_configured_but_zero_invocations` audit (not yet implemented) would flag bundles where review is armed but no `adversary review` event landed.

---

## Codex Hosting

Codex can host the command via `/masterplan:masterplan` through `skills/masterplan/SKILL.md`. When Codex-hosted:

- The orchestrator runs `mp detect-host --agent-is-codex` at boot.
- A Codex host (`isCodex`) lacks Claude Code's Workflow tool, so waves run on the foreground-sequential path (`mp continue --codex-suppressed`) instead of a background workflow launch.
- Persisted review config (`state.review.adversary`, or legacy `state.codex.{routing,review}`) in `state.yml` continues to apply to Claude Code runs unaffected. Whole-branch adversary review runs the same on either host — it runs the harness-native adversary class/panel (resolved from the routing policy `policy/workflow-map.json`), not Codex, so there is no recursion to suppress.

## The v10 Bootstrap Boundary

v10.0.0 is released through a **one-off bootstrap driver** (`scripts/bootstrap-v10.mjs`) rather than a normal run: it arms the release targets, walks a fixed step order (verify → review → assessment → release → tag → CI → install both surfaces → `surfaces_live`), and records every command as a durable `bootstrap_armed` / `bootstrap_step` / `bootstrap_pass` event on the run bundle. The bootstrap stage is **not a plan task and not an `mp` verb** — it runs at the branch-finish boundary: `node scripts/bootstrap-v10.mjs status` must report the pass complete through `surfaces_live` before `mp finish` begins, and `arm --step=gate` / `record --step=gate` execute inside the `branch_finish` handling before `--choice=merge` (the `gate` step is the only bootstrap step permitted after finish begins). The bootstrap rows record `required_successor {slug: v10-validation, reason}` through the pinned v9 `mp event` before `mp finish` on the current run.

---

## Development

**Run the test suite:**

```sh
node --test test/*.test.mjs
```

**Run the doctor health check:**

```sh
node bin/doctor.mjs
```


**Verify a specific edit (grep discriminator pattern):**

```sh
grep -n '<pattern>' commands/masterplan.md
```

There is no conventional build step. The "source" is `commands/masterplan.md` (the L1 sequencer) plus the Node modules under `bin/`, `lib/`, and `agents/`.

---

## Further Reading

| Document | What it covers |
|---|---|
| [docs/internals.md](./docs/internals.md) | Architecture index; links to all leaf docs |
| [docs/internals/bundle-resume.md](./docs/internals/bundle-resume.md) | Resume controller: how `lib/resume.mjs` decides the next action |
| [docs/internals/wave-dispatch.md](./docs/internals/wave-dispatch.md) | Routing decisions and one-wave dispatch |
| [docs/internals/plan-parser.md](./docs/internals/plan-parser.md) | Deterministic plan compile: fragment merge, wave assignment, schema |
| [docs/internals/task-verification.md](./docs/internals/task-verification.md) | D6 scope verification and the review stage |
| [docs/internals/doctor.md](./docs/internals/doctor.md) | Doctor contract: check modules, Finding shape, crash isolation |
| [commands/masterplan.md](./commands/masterplan.md) | The L1 sequencer (the primary source for orchestrator behavior) |
| [docs/conventions/cd-rules.md](./docs/conventions/cd-rules.md) | CD-1…CD-11 canonical rule bodies |
