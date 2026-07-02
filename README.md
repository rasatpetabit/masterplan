# masterplan

> A Claude Code & Codex CLI plugin for durable multi-hour engineering work — brainstorm → plan → execute → finish on top of `obra/superpowers` skills.

Current release: **v9.3.0** · **License:** MIT · **Works with:** Claude Code, Codex CLI · See [CHANGELOG.md](./CHANGELOG.md)

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
| **execute** | Wave-by-wave task dispatch; each wave is one workflow launch |
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
│  commands/masterplan.md  (~800-line verb sequencer)          │
│  bin/masterplan.mjs  (mp — filesystem-only subcommands)      │
│  lib/resume.mjs  (pure decideNextAction)                     │
│  ← SOLE durable state writer; git commit/checkout live here  │
└───────────────────────┬─────────────────────────────────────┘
                        │ launch + receive digests
┌───────────────────────▼─────────────────────────────────────┐
│  L2 — Workflow engine                                        │
│  workflows/execute.workflow.js  (one wave per launch)        │
│  workflows/plan.workflow.js     (subsystem fan-out)          │
│  lib/plan-merge.mjs  lib/dispatch/  lib/wave.mjs             │
│  ← returns digests/fragments only; never writes disk/git     │
└───────────────────────┬─────────────────────────────────────┘
                        │ bounded briefs / structured digests
┌───────────────────────▼─────────────────────────────────────┐
│  L3 — Agents                                                 │
│  agents/mp-explorer.md        agents/mp-implementer.md       │
│  agents/mp-planner.md         agents/mp-adversarial-reviewer.md │
│  agents/mp-plan-reviewer.md   agents/mp-subsystem-planner.md │
│  agents/mp-spec-decomposer.md                                │
│  ← no session history; return structured output only         │
└───────────────────────┬─────────────────────────────────────┘
                        │ node bin/doctor.mjs
┌───────────────────────▼─────────────────────────────────────┐
│  L4 — Doctor                                                 │
│  bin/doctor.mjs  dispatcher                                  │
│  lib/doctor/*.mjs  (14 check modules, auto-discovered)       │
│  ← Finding {id, severity, summary, fix}; non-zero on ERROR   │
└─────────────────────────────────────────────────────────────┘
```

**Key invariants:**

- L1 (`commands/masterplan.md` + `mp`) is the **only** durable state writer (CD-7). All state mutations go through `mp` subcommands; L2 and below never commit to git or write `state.yml`.
- `bin/masterplan.mjs` is **filesystem-only** — git (`commit`, `checkout`, `clean`) is the shell's job.
- L2 workflows communicate via `args` on launch and return digests in the completion notification.

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
/masterplan doctor               # structural lint (14 check modules)
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
2. `plan.workflow.js` fans out one `mp-subsystem-planner` per subsystem in parallel; each returns a task **fragment**.
3. `lib/plan-merge.mjs` merges deterministically:
   - Assigns integer task ids.
   - Assigns wave numbers via **Kahn topological order** with a file-conflict bump (dependency-free, file-disjoint tasks share the lowest wave = maximal safe parallelism).
   - Normalizes the `codex` routing annotation to the string enum `"ok"|"no"|null`.
   - Validates the schema.
   - Renders `plan.md` as a pure projection of `plan.index.json`.

A simpler serial path exists: `mp-planner` writes the plan directly; L1 still validates the schema.

---

## Wave Execution & Scope Verification

The L2 execute path runs **one wave per workflow launch**:

- `pipeline(tasks, implement, review)` is **non-barrier**: a task's review starts the moment its implement finishes.
- Implementation is **inline-only** via `mp-implementer` (no Codex implementer path). Each implementer runs the task's `verify_commands` and returns a digest citing real output.
- Review is **config-gated**: `mp-adversarial-reviewer` runs only when the bundle's review is armed (`state.review.adversary`, which `mp prepare-wave` surfaces to the L2 path as the `"on"` payload it gates on).

After the wave barrier, L1 runs **D6 scope verification**:

1. Compute the set of files touched since the git baseline.
2. Compare against the union of the wave tasks' declared `files`.
3. Any out-of-scope paths are **reverted** (`git checkout`/`git clean --` scoped to those paths) and left pending for re-dispatch.
4. L1 commits state + in-scope edits together (state leads git, per CD-7).

---

## The Finish Flow

When the last execute wave's tasks are all `done`, the orchestrator **auto-fires the finalization flow** instead of silently archiving:

1. **Verify** — run the project's verification via `superpowers:verification-before-completion`, citing real output. A failing suite opens a hard-stop gate (fix-first / proceed-anyway-reviewed / abort). No silent archive over red.
2. **Retro** — write `retro.md` if absent.
3. **Branch-finish gate** — open a durable `branch_finish` gate and surface an `AskUserQuestion`:
   - Merge to base locally
   - Push + open PR
   - Keep branch as-is
   - Discard

   This gate delegates to `superpowers:finishing-a-development-branch` and **always halts** regardless of autonomy level (it is a risky-action gate).
4. **Archive** — last, after the user resolves the gate.

`/masterplan finish` runs this flow manually. `/masterplan finish --retro-only` regenerates just `retro.md`.

---

## Resume & Durability (Gates)

`lib/resume.mjs` exports a pure `decideNextAction(state, opts)` that returns one of a small set of action types. The shell (`commands/masterplan.md`) executes the action and loops.

**`surface_gate` has top priority:** if a named gate is open in `state.yml`, the resume controller re-renders its `AskUserQuestion` before anything else — regardless of context compaction. This makes gates **compaction-safe** (CD-9): a gate opened in turn N is still visible in turn N+100 after a full session compaction.

Crash before a commit is safe: `state.yml` leads git, so `decideNextAction` re-derives the correct action from already-marked task state.

---

## Doctor

`node bin/doctor.mjs` runs 14 check modules under `lib/doctor/*.mjs`, auto-discovered alphabetically. Each module exports:

```js
check(repoRoot, opts) -> Finding[]
```

A Finding has the shape `{id, severity, summary, fix}` where `severity` is one of `PASS | WARN | ERROR | SKIP`. The process exits non-zero if any Finding has severity `ERROR`.

`/masterplan doctor --fix` applies safe automatic repairs for checks that implement an autofix handler, then reruns the doctor. Findings whose remedies require human judgment remain report-only.

See [docs/internals/doctor.md](docs/internals/doctor.md) for the full check catalog and crash-isolation contract.

---

## Configuration

There is no `.masterplan.yaml` config-file hierarchy in v8. Configuration lives on the run bundle in `state.yml` — set at seed time, or via `mp set-review-config` — and read back at runtime.

**Seed-time flags** (`mp seed`, persisted into `state.yml` at run creation):

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--autonomy` | `gated \| loose \| full` | unset | `gated`/unset halts at every gate; `loose` auto-advances through successful gates; `full` runs maximally non-interactive (even the finish-flow verification auto-fires). The branch-finish gate always halts regardless. |
| `--complexity` | `low \| medium \| high` | auto-detected | Influences planning depth; `--complexity-source` records how it was set |
| `--planning-mode` | `serial \| parallel \| auto` | `auto` | `serial` = one `mp-planner`; `parallel` = `mp-subsystem-planner` fan-out merged by `lib/plan-merge.mjs` |
| `--adversary-review` | `on \| off` | `on` | Default-on finish-time adversary review (routed through the agent-dispatch adversary lane). New bundles arm `state.review.adversary: true` automatically; pass `off` to opt out. Alias: `--codex-review`. Legacy bundles (no `state.review.adversary` and no legacy `state.codex.review`) are defensively armed at the finish gate with an `adversary_review_defensively_armed` audit event. |

**Review config** (`mp set-review-config`, a CD-7 write on an existing bundle — *not* a seed flag; alias: `mp set-codex-config`):

| Flag | Values | Default | Notes |
|---|---|---|---|
| `--review` | `true \| false` | inherits seed | Arms/disarms `state.review.adversary`. New bundles inherit `true` from `--adversary-review=on`; pass `--review=false` to opt out post-seed. |
| `--routing` | `auto \| on \| off` | `auto` | Legacy per-task dispatch default (`state.codex.routing`), still read by `prepare-wave` for in-flight bundles. New bundles no longer write it (routing defaults to `auto`). |

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
- Persisted review config (`state.review.adversary`, or legacy `state.codex.{routing,review}`) in `state.yml` continues to apply to Claude Code runs unaffected. Whole-branch adversary review runs the same on either host — it routes to agent-dispatch's cross-vendor lane (the reviewer is resolved by agent-dispatch — see `agent-dispatch digest`), not Codex, so there is no recursion to suppress.

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

There is no conventional build step. The "source" is `commands/masterplan.md` (the L1 sequencer) plus the Node modules under `bin/`, `lib/`, `workflows/`, and `agents/`.

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
| [docs/conventions/cd-rules.md](./docs/conventions/cd-rules.md) | CD-1…CD-10 canonical rule bodies |
