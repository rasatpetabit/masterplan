# superpowers-masterplan — internal documentation for LLM contributors

**Audience:** Future LLMs (Claude, Codex, others) that pick up this codebase to develop features, fix bugs, debug stuck plans, or extend the orchestrator. The intent is that this document, plus `commands/masterplan.md` and `docs/masterplan/<slug>/state.yml` run bundles, is enough to operate without reading deleted history (pre-v1.1.0 plans/specs were pruned in the v2.0.0 release).

**Token budget warning:** This doc is ~6000 words. It's not always-loaded. CLAUDE.md (always-loaded, ~500 words) points here for deep-dive when needed. Read selectively — use the table of contents.

**Companion docs:**
- [`CLAUDE.md`](../CLAUDE.md) — always-loaded short orientation + top anti-patterns.
- [`commands/masterplan.md`](../commands/masterplan.md) — the orchestrator prompt (the "source code"; ~2250 lines).
- [`README.md`](../README.md) — public-facing project overview, install, usage, configuration reference.
- [`CHANGELOG.md`](../CHANGELOG.md) — release history with full per-version detail.
- [`docs/design/intra-plan-parallelism.md`](./design/intra-plan-parallelism.md) — Slice α status doc + sharpened revisit trigger for Slice β/γ.
- [`docs/design/telemetry-signals.md`](./design/telemetry-signals.md) — Stop hook record schema + jq query examples.

---

## Table of contents

1. [Project orientation](#1-project-orientation)
2. [The three design pillars](#2-the-three-design-pillars)
3. [Subagent + context-control architecture](#3-subagent--context-control-architecture)
4. [Run bundle format (the only source of truth)](#4-run-bundle-format-the-only-source-of-truth)
5. [Context discipline rules (CD-1 through CD-10)](#5-context-discipline-rules-cd-1-through-cd-10)
6. [Operational rules](#6-operational-rules)
7. [Wave dispatch (Slice α) + failure-mode catalog (FM-1 to FM-6)](#7-wave-dispatch-slice-α--failure-mode-catalog-fm-1-to-fm-6)
8. [Codex integration](#8-codex-integration)
9. [Telemetry signals + jq recipes](#9-telemetry-signals--jq-recipes)
10. [Doctor checks (full table with rationale)](#10-doctor-checks-full-table-with-rationale)
11. [Verb routing + halt_mode flow](#11-verb-routing--halt_mode-flow)
12. [Design decisions + deferred items](#12-design-decisions--deferred-items)
13. [Common dev recipes](#13-common-dev-recipes)
14. [Anti-patterns + contributor pitfalls](#14-anti-patterns--contributor-pitfalls)
15. [Cross-references](#15-cross-references)

---

## 1. Project orientation

`superpowers-masterplan` ships one orchestrator command for Claude Code and Codex. In Claude Code the command is `/masterplan`; in Codex the portable invocation is `/superpowers-masterplan:masterplan` unless the host exposes a bare alias. The command orchestrates a complete development workflow — brainstorm a spec, plan the implementation, execute task-by-task, generate a retrospective when complete — by sequencing the upstream `superpowers` skills (`brainstorming`, `writing-plans`, `subagent-driven-development`, `executing-plans`, `using-git-worktrees`, `systematic-debugging`, `finishing-a-development-branch`).

**It's a thin orchestrator, not a re-implementation.** The pipeline phases live in superpowers; `/masterplan` sequences them, persists state in `docs/masterplan/<slug>/state.yml`, and routes decisions (which model executes a task; whether Codex reviews; whether a wave dispatches in parallel; etc.).

### What's in the repo

```
superpowers-masterplan/
├── CLAUDE.md                       # always-loaded LLM orientation (~500 words)
├── README.md                       # public-facing project overview
├── CHANGELOG.md                    # release history (always preserved verbatim)
├── LICENSE                         # MIT
├── .claude-plugin/
│   ├── plugin.json                 # plugin manifest (name, version, description, URL)
│   └── marketplace.json            # direct-install marketplace catalog
├── .codex-plugin/
│   └── plugin.json                 # Codex plugin manifest
├── .agents/
│   └── plugins/marketplace.json    # Codex marketplace catalog
├── plugins/
│   └── superpowers-masterplan -> .. # Codex marketplace path symlink back to repo root
├── commands/
│   └── masterplan.md               # THE orchestrator prompt (~2250 lines, single source of truth for behavior)
├── skills/
│   └── masterplan-detect/
│       └── SKILL.md                # auto-suggest /masterplan import on legacy artifacts
├── hooks/
│   └── masterplan-telemetry.sh     # opt-in Stop hook for per-turn JSONL telemetry
└── docs/
    ├── internals.md                # THIS FILE
    ├── design/
    │   ├── intra-plan-parallelism.md   # Slice α status + Slice β/γ deferral notes
    │   └── telemetry-signals.md        # Stop hook record schema + jq queries
    └── masterplan/                 # self-hosted run bundles for this repo
        └── <slug>/
            ├── state.yml
            ├── spec.md
            ├── plan.md
            └── events.jsonl
```

### What this codebase IS NOT

- Not a code project in the conventional sense — there is no compile/build/test pipeline.
- Not a runtime — the plugin's logic IS the prompt that Claude Code loads when the user types `/masterplan`.
- Not stateful at the plugin level — every plan's state lives in a run bundle in the user's repo, not in the plugin install.

### How to operate

When the user types `/masterplan <args>` in Claude Code or `/superpowers-masterplan:masterplan <args>` in Codex, the host loads `commands/masterplan.md` as the command prompt with `$ARGUMENTS` bound to `<args>`. The prompt directs the orchestrator through Steps 0 → A or B or C or D or I or R or S or T or CL, depending on the verb. Each Step has bounded responsibilities documented inline. Codex-specific tool substitutions live in the runtime compatibility block near the top of the command.

---

## 2. The three design pillars

These shape every decision in `commands/masterplan.md`. Internalize before making changes.

### Pillar 1: Thin orchestrator over composable skills

Brainstorming, planning, execution, debugging, branch-finishing — all live in `obra/superpowers` skills. The orchestrator's job is to **sequence** them, persist state, and route decisions. Improvements to upstream skills compound automatically.

**Implication:** When tempted to add logic that duplicates an upstream skill, don't — extend the brief instead. Example: when writing-plans needed to know about Codex annotations, the brief gained a paragraph; writing-plans itself didn't change.

### Pillar 2: Subagent-driven execution with strict context control

The orchestrator's context is a finite, expensive resource. Substantive work goes to **fresh subagents** whose context never bleeds back. Only digested results return to the orchestrator. By task 10 of a long plan, the orchestrator is reasoning on cluttered, stale state if this discipline is broken.

**Implication:** Every Step that reads files, runs verification, performs analysis, or generates content does so via a subagent dispatch with a bounded brief. The orchestrator consumes only the digest. See [Section 3](#3-subagent--context-control-architecture).

### Pillar 3: Run bundle as the only source of truth

Future-you (or another agent) must be able to resume any plan from `docs/masterplan/<slug>/state.yml` plus the bundled `plan.md`, `spec.md`, and recent `events.jsonl` entries. Conversation context is discarded by design.

**Implication:** Decisions, blockers, scope changes, and surprises that future-you would need go into explicit state fields or `events.jsonl`. Don't bury load-bearing context in conversation alone (CD-7).

### Run bundle state (v3.0.0+)

The canonical runtime layout is:

```text
docs/masterplan/<slug>/
  state.yml
  spec.md
  plan.md
  retro.md
  events.jsonl
  eligibility-cache.json
  telemetry.jsonl
  subagents.jsonl
```

`state.yml` is created immediately after worktree selection, before brainstorming. This fixes earlier compaction failures where no durable state existed yet and the orchestrator could only guess from conversation context. Every `AskUserQuestion` gate must first persist `pending_gate` in `state.yml`; the selected option clears it and appends a `gate_closed` event.

Legacy state from earlier versions remains supported. `bin/masterplan-state.sh inventory` discovers old `docs/superpowers/{plans,specs,retros,archived-*}` artifacts, and `bin/masterplan-state.sh migrate --write` copies them into the new run-bundle layout while preserving old paths under `legacy:`. Migration is copy-only; `/masterplan clean` owns broad archive/delete of legacy files after the bundle has been verified.

Successful Step C completion now runs a default finalizer: mark the run complete, generate `retro.md`, archive the run by updating `state.yml`, and run an archive-only cleanup subset for verified legacy/orphan state. That subset never deletes, never moves the current `docs/masterplan/<slug>/` bundle, and skips stale/crons/worktrees; manual `/masterplan clean` remains the broad maintenance surface.

---

## 3. Subagent + context-control architecture

This is the most important architectural surface. The dispatch model below tells you which subagent handles which kind of work — and what bounded brief to give it.

### What the orchestrator holds vs. discards

**Hold:** `state.yml` fields + recent `events.jsonl` tail; plan task list + current task pointer; this-session user decisions; next action.

**Never hold:** raw verification output (in test logs / git), full file contents (re-read on demand), earlier subagent working notes (scratch), library docs (look up via `context7`, then drop).

### Dispatch model (per phase)

| Phase | Subagent type | Model | Why this model |
|---|---|---|---|
| Step A state parse | parallel Haiku per worktree (when worktrees ≥ 2) | Haiku | Mechanical YAML extraction; bounded |
| Step I1 discovery | parallel `Explore`, one per source class | Haiku | Mechanical glob + grep + `gh` calls |
| Step I3 source fetch | parallel agents per candidate | Haiku (Sonnet for branch reverse-engineering) | Read / git diff / gh issue view; reverse-engineering needs judgment |
| Step I3 conversion | parallel Sonnet per candidate | Sonnet | Generation, not just extraction |
| Step C step 1 eligibility cache build | one Haiku at plan-load | Haiku | Apply checklist to each task; emit JSON |
| Step C per-task implementation | implementer subagents via `superpowers:subagent-driven-development` | Sonnet (default) | The default workhorse |
| Step C 3a Codex execution | `codex:codex-rescue` in EXEC mode | Codex (out-of-process) | Per the routing toggle; small well-defined tasks |
| Step C 4b Codex review | `codex:codex-rescue` in REVIEW mode | Codex (out-of-process) | Asymmetric review — fresh eyes on Sonnet's diff |
| Completion-state inference (Step I3.3) | parallel Haiku per task chunk | Haiku | Classify done/possibly_done/not_done per task |
| Step D doctor checks | parallel Haiku per worktree (when N ≥ 2) | Haiku | Apply checks per worktree; return findings JSON |
| Step S situation report | parallel Haiku per worktree (when N ≥ 2) | Haiku | Collect run state + recent commits + telemetry tails |

### The bounded brief contract

Every subagent dispatched from `/masterplan` (directly OR transitively via upstream skills) receives:

1. **Goal** — one sentence, action-oriented. Example: *"Convert `<source>` into spec at `<path>` and plan at `<path>` following writing-plans format."*
2. **Inputs** — explicit list of files/data to consume. No implicit "look around the codebase" without a starting point.
3. **Allowed scope** — files/paths it may modify. Or "research only, no writes."
4. **Constraints** — relevant CD-rules (always at minimum CD-1, CD-2, CD-3, CD-6 for implementer subagents), autonomy mode, time/token budget if relevant.
5. **Return shape** — exactly what the orchestrator expects. *"Return JSON `{path, summary}` only — do not narrate."*

**Subagents do NOT receive:** orchestrator session history; earlier subagent outputs (unless explicitly digested); the full plan file when only one task is in scope; conversation breadcrumbs from the user.

### Output digestion

When a subagent returns:
- Pull only load-bearing fields: pass/fail, commit SHA, key file paths, blocker description, classification result.
- Write the digest into `events.jsonl` or explicit `state.yml` fields (per CD-7), not the raw output.
- Discard verbose output — it lives in git history, test logs, or source files.

Activity log convention illustrates the digest pattern:
```
2026-04-22T16:14 task "Implement memory session adapter" complete, commit f4e5d6c [codex] (verify: 24 passed)
```
Enough to reconstruct state. Nothing more.

### Context budget triggers

- **After every 3 completed tasks** — call `ScheduleWakeup` to resume in a fresh session (already in Step C step 5). `state.yml` + `events.jsonl` are the bridge.
- **If context feels tight** — finish the current task, ScheduleWakeup, end the turn. A wakeup is cheap; a confused orchestrator is expensive.
- **If a subagent returns ≥ 5K characters** — digest immediately before continuing.
- **Before invoking brainstorming, conversion, or systematic-debugging** — check whether you're already deep in a session. If so, bookmark and wakeup; let the fresh session start that phase clean.

### Parallelism guidance — when YES, when NO

**YES (independent work):**
- Step A state parsing per worktree
- Step B0 git surveys (one parallel Bash batch)
- Step C step 1 re-reads (state + spec + plan + pwd + branch as one tool batch)
- Step C 4a verification commands (when no shared mutable artifacts)
- Step I1 discovery (4 source classes in parallel)
- Step I3 source-fetch + conversion waves
- Step D doctor checks per worktree
- Step S situation report per worktree
- Wave dispatch in Step C step 2 — Slice α (read-only tasks only, see [Section 7](#7-wave-dispatch-slice-α--failure-mode-catalog-fm-1-to-fm-6))

**NO (intentional sequencing):**
- Per-candidate cruft handling and `git commit` in Step I3 (single-writer git index)
- Per-task implementation in Step C for committing tasks (concurrent commits race the git index — Slice β/γ deferred per [Section 7](#7-wave-dispatch-slice-α--failure-mode-catalog-fm-1-to-fm-6))
- Shared-state writes (multiple agents modifying `state.yml` or `events.jsonl` is a race)
- When the orchestrator needs to react between agents (autonomy=gated checkpoints)

---

## 4. Run bundle format (the only source of truth)

Every plan has a run bundle at `docs/masterplan/<slug>/`. `state.yml` is the durable phase pointer and `events.jsonl` is the append-only activity log. A future agent resumes from the bundle, not from conversation context.

```yaml
schema_version: 2
slug: <feature-slug>
status: in-progress | blocked | complete | archived
phase: worktree_decided | brainstorming | spec_gate | planning | plan_gate | executing | task_gate | blocked | complete | retro_gate | archived
worktree: /absolute/path/to/worktree
branch: <git-branch-name>
started: YYYY-MM-DD
last_activity: YYYY-MM-DDTHH:MM:SSZ
current_task: <task name from plan>
next_action: <one-line summary of what comes next>
autonomy: gated | loose | full
loop_enabled: true | false
codex_routing: off | auto | manual
codex_review: off | on
compact_loop_recommended: true | false
complexity: low | medium | high
pending_gate: null
artifacts:
  spec: docs/masterplan/<slug>/spec.md
  plan: docs/masterplan/<slug>/plan.md
  retro: docs/masterplan/<slug>/retro.md
  events: docs/masterplan/<slug>/events.jsonl
  events_archive: docs/masterplan/<slug>/events-archive.jsonl
  eligibility_cache: docs/masterplan/<slug>/eligibility-cache.json
  telemetry: docs/masterplan/<slug>/telemetry.jsonl
  telemetry_archive: docs/masterplan/<slug>/telemetry-archive.jsonl
  subagents: docs/masterplan/<slug>/subagents.jsonl
  subagents_archive: docs/masterplan/<slug>/subagents-archive.jsonl
  state_queue: docs/masterplan/<slug>/state.queue.jsonl
# Optional: telemetry: off  # silences per-plan telemetry capture
# Optional v2.1.0+: gated_switch_offer_dismissed: true  # permanent per-plan suppression of gated→loose offer (Step C step 1)
# Optional v2.1.0+: gated_switch_offer_shown: true      # per-session suppression of gated→loose offer (re-fires on cross-session resume)
legacy: {}
```

### Required fields

Core required fields above are enforced by doctor check #9. Step A and Step C both depend on that set. Archive/sidecar artifact keys are stable optional addresses; migrated archived records may leave values empty when the legacy source never had that artifact.

### Events format

`events.jsonl` records one JSON object per line. Required fields are `ts`, `type`, and `message` or type-specific fields. Task-completion events preserve the same searchable routing tags (`[codex]`, `[inline]`, `[wave: <group>]`) in `message`.

For wave-completed tasks (Slice α v2.0.0+), emit one task event per completed member and one wave summary event; read-only wave members still do not commit.

### Event retention

When `events.jsonl` exceeds the retention threshold, rotate older entries to `events-archive.jsonl` and keep the most recent entries active. Resume behavior is unchanged because Step C reads `state.yml` plus the active event tail; retros may read the archive.

Under wave dispatch (v2.0.0+), rotation is wave-aware — fires once per wave (not per task) per FM-2 mitigation.

### Sibling files

| Path | Purpose |
|---|---|
| `state.yml` | Canonical run state and phase pointer |
| `spec.md` | Design/spec artifact |
| `plan.md` | Execution plan |
| `retro.md` | Retrospective, when generated |
| `events.jsonl` | Activity and decision log |
| `events-archive.jsonl` | Event overflow archive (created on demand) |
| `eligibility-cache.json` | Per-task Codex routing + parallel-eligibility cache (rebuilt on plan.md mtime change) |
| `telemetry.jsonl` | Per-turn JSONL records emitted by the Stop hook + Step C step 1 inline snapshots; local-only and ignored before write |
| `subagents.jsonl` | Per-Agent-dispatch telemetry emitted by the Stop hook; local-only and ignored before write |

---

## 5. Context discipline rules (CD-1 through CD-10)

These rules govern behavior throughout every Step. They mirror the user's global `~/.claude/CLAUDE.md` execution style and apply to the orchestrator AND to any subagents it dispatches. **Cite by ID** in activity-log entries when invoking or honoring them — that creates a paper trail.

| ID | Rule | Why it exists |
|---|---|---|
| **CD-1** | **Project-local tooling first.** Use `Makefile`/`package.json`/`Justfile`/`bin/`/`scripts/`/runbooks before inventing commands. | Established conventions encode constraints not visible in code (CI integration, env setup, etc.). |
| **CD-2** | **User-owned worktree.** Don't revert/reformat/clean-up files outside the current task's scope. Verification commands must not modify unrelated dirty files. | The user's in-progress work is sacred. A "helpful" cleanup can destroy hours of unsaved work. |
| **CD-3** | **Verification before completion.** Cite real command output. "Should work" is not evidence. | False completions are the most expensive bug class — they propagate through the plan. |
| **CD-4** | **Persistence — work the ladder.** When a tool fails: (1) read the error; (2) try alternate tool; (3) narrow scope; (4) grep prior art; (5) consult `context7`. Hand off only after 2+ rungs failed. | Premature handoff trains the user to expect handoff; hides root causes. |
| **CD-5** | **Self-service default.** Execute actions yourself. Hand off only when the action is truly user-only (secrets, OAuth, 2FA, destructive ops). | Friction-free agent work is the value prop. |
| **CD-6** | **Tooling preference order.** (1) MCP > (2) installed skill/plugin > (3) project-local convention > (4) generic Bash. Check `/mcp` and the system-reminder skills list before reaching for generic. | Specific tools encode safety and convenience the generic path lacks. |
| **CD-7** | **Durable handoff state.** `state.yml` and `events.jsonl` are the persistence surface. Decisions, blockers, scope changes, surprises that future-you needs go into explicit state fields or events. | Conversation context is volatile; run state persists. |
| **CD-8** | **Command output reporting.** When command output is load-bearing for a decision, relay 1–3 relevant lines. | The user may not have your terminal visible. Don't assume they can see what you saw. |
| **CD-9** | **Concrete-options questions.** `AskUserQuestion` with 2–4 concrete options; recommended option first marked `(Recommended)`. Avoid free-text "let me know how you want to proceed." | Sessions can compact between turns; free-text questions become dead ends. Concrete options are decidable. |
| **CD-10** | **Severity-first review shape.** Lead with findings ordered by severity, grounded in `file_path:line_number`. Keep summaries short. | Reviewers parse severity tags faster than prose; line citations enable jump-to-source. |

**Anti-pattern to watch for:** Long prose justifications inside the orchestrator that re-explain why CD-N matters. The canonical CD definitions block in `commands/masterplan.md` is the single source; cite by ID elsewhere. An earlier audit trimmed ~10 inline restatements for ~690 tokens saved per `/loop` wakeup.

---

## 6. Operational rules

These are command-specific rules covering cross-cutting policy not stated inline in any single Step. CD-rules cover general execution; these cover masterplan's own state machine.

### The non-negotiables

- **Stay a thin wrapper.** Logic that belongs to brainstorming, planning, execution, debugging, or branch-finishing lives in those skills. The command's job is sequencing them and persisting run state.
- **Subagents do the work; orchestrator preserves context.** Every substantive piece of work goes to a bounded subagent. Only digests come back. When in doubt, digest and ScheduleWakeup.
- **Bounded briefs, not implicit context.** Goal + Inputs + Scope + Constraints + Return shape. Subagents do not inherit session history.
- **Import never overwrites existing masterplan state silently.** If a target run bundle already exists at Step I3, ask the user: overwrite / write to a `-v2` slug / abort.
- **Doctor is read-only by default.** Without `--fix` it only reports — even an obvious orphan stays in place. `--fix` only acts on errors marked auto-fixable.
- **Inference is conservative by design.** When in doubt, classify `possibly_done`, not `done`. Cost of re-verifying < cost of skipping real work.
- **Don't stop silently anywhere.** Always close with `AskUserQuestion` if input might be needed. Recursively pre-empt upstream-skill free-text prompts (`finishing-a-development-branch`'s "Which option?", `using-git-worktrees`' "Which directory?", `writing-plans`' "Which approach?", `brainstorming`'s "Wait for the user's response").
- **External writes are gated.** Posting comments to GitHub issues/PRs, Slack messages, closing issues during import always passes through `AskUserQuestion` first — even under `--autonomy=full`.
- **Codex routing is locked at kickoff, switchable on resume.** `codex_routing` and `codex_review` land in `state.yml` at Step B3 (or first Step C invocation for imported plans). Mid-run flips happen via re-invocation: `/masterplan --resume=<path> --codex=<mode> --codex-review=<on|off>`.
- **Never delegate non-eligible tasks under `auto`.** The eligibility checklist is conservative on purpose: a wrong delegation costs more than running inline. When uncertain, run inline.
- **Codex review is asymmetric — never self-review.** If a task was executed by Codex and `codex_review` is on, skip the review for that task. Codex reviewing its own output adds no signal.
- **Implementer must return `task_start_sha` (required).** Step C step 2's brief includes: "Capture `git rev-parse HEAD` BEFORE any work; return as `task_start_sha`." Step 4b (Codex review) and Step 4c (worktree integrity) depend on it.
- **Implementer-return trust contract.** When the implementer reports `tests_passed: true` and lists `commands_run`, Step 4a trusts the report and skips redundant verification. SDD's TDD discipline is first-class. Protocol violation: if `tests_passed: true` but a complementary check or Codex review surfaces a test failure, the discrepancy goes into `events.jsonl`.
- **Eligibility cache persists to `docs/masterplan/<slug>/eligibility-cache.json`.** Step C step 1 loads from disk when `cache.mtime > plan.mtime`; dispatches Haiku otherwise. Step 4d's plan edits `touch` the plan file to invalidate.
- **Git state cache excludes `git status --porcelain`.** Step 0's `git_state` cache holds `worktrees` and `branches` only. Dirty state must always be live (CD-2).
- **In-wave scope rule (Slice α).** Wave members MUST NOT modify `plan.md`, `state.yml`, `events.jsonl`, or the eligibility cache. Violating is a `protocol_violation` (orchestrator detects post-barrier and reclassifies). See [Section 7](#7-wave-dispatch-slice-α--failure-mode-catalog-fm-1-to-fm-6).
- **CC-1 — Compact-suggest on observable symptoms.** End-of-turn check (before next wakeup) for: (a) `file_cache` ≥3 hits same path; (b) ≥3 consecutive tool failures same target; (c) events rotated this session; (d) subagent returned ≥5K characters. On trigger: surface a non-blocking one-line notice. Per-plan dismissal via `compact_suggest: off` in `state.yml`.
- **CC-2 — Subagent-delegate triggers.** Before issuing a Bash command expected to print >100 lines, dispatch a Haiku. Before reading a file >300 lines as part of substantive work, dispatch a Haiku to extract the relevant section. Self-check: scan upcoming task verification for known-noisy commands (`build`, `test --verbose`, `cargo build`, `npm run build`, full-tree `find`); route through subagent that returns pass/fail + ≤3 evidence lines.

---

## 7. Wave dispatch (Slice α) + failure-mode catalog (FM-1 to FM-6)

Slice α (v2.0.0+) ships read-only parallel waves: contiguous tasks sharing the same `parallel-group:` annotation dispatch as one wave in Step C step 2. Implementation tasks (anything that commits) remain serial — that's deferred to Slice β (~8-10d) or Slice γ (~10-15d) per [Section 12](#12-design-decisions--deferred-items).

### Plan annotation schema

```markdown
### Task 4: Run lint pass on src/auth/

**Files:**
- Lint: src/auth/*.py

**Codex:** no
**parallel-group:** verification
```

The existing `**Files:**` block becomes **exhaustive scope** when `parallel-group:` is set. The task may not read or modify any path outside this list.

### Eligibility rules (computed by Step C step 1 cache builder Haiku)

A task is parallel-eligible if ALL of:

1. `parallel-group:` is set.
2. `**Files:**` block is present and non-empty.
3. Task is non-committing — declared scope is read-only OR write-to-gitignored-paths only (`coverage/`, `.tsbuildinfo`, `dist/`, `build/`, `target/`, `out/`, `.next/`, `.nuxt/`, `node_modules/`). Heuristic: no Create/Modify paths under tracked dirs. Edge case: `**non-committing: true**` annotation override.
4. `**Codex:**` is NOT `ok` (FM-4 mitigation — Codex falls out of waves).
5. No file-path overlap with any other task in the same `parallel-group:`. Cache-build-time check.

### Failure-mode catalog (FM-1 to FM-6)

This catalog drove Slice α's design. Each FM has a worked example, old-design impact, and Slice α mitigation. Future contributors weighing Slice β/γ should re-read these.

#### FM-1: Eligibility-cache invalidation under in-wave plan edits

A wave member edits `plan.md` mid-wave (e.g., adding `**Codex:** ok` to a sibling task). Step C step 1's `cache.mtime > plan.mtime` invariant is violated. Sibling tasks already in flight made routing decisions based on a now-stale cache.

**Slice α mitigation:** Snapshot `eligibility_cache` at wave-start; pin it for the wave's duration via `cache_pinned_for_wave: true`; declare in-wave plan edits out-of-scope per CD-2 (in-wave scope rule).

#### FM-2: Event rotation race

A wave produces N concurrent appends to `events.jsonl`. If `len(active_events) + N > 100`, rotation to `events-archive.jsonl` is non-atomic. Concurrent writes lose or duplicate entries.

**Slice α mitigation:** Wave members return digests; do not write run state. Orchestrator collects digests at wave-end and applies one batched update. Rotation fires once at end-of-batch (wave-aware).

#### FM-3: State write contention

Concurrent updates from N wave members race on `current_task` (single-pointer field), `last_activity`, and event appends. Even with file locking, semantics break — `current_task` is single-valued.

**Slice α mitigation:** Single-writer funnel via Step C 4d. `current_task` semantics: lowest-indexed not-yet-complete task. Telemetry attribution via two new fields (`tasks_completed_this_turn`, `wave_groups`) in the Stop hook.

#### FM-4: Codex routing per-task as a serializing sync point

A wave with mixed Codex + inline tasks can't usefully parallelize: Codex execution is out-of-process; concurrency depends on user's Codex CLI / API rate limits (unverified). Step C 3a's per-task `AskUserQuestion(Accept / Reject)` doesn't compose under N concurrent Codex executions.

**Slice α mitigation:** Codex-routed tasks (`**Codex:** ok`) are NOT parallel-eligible. They fall out of waves and run in their own serial slot. Mutually exclusive with `**parallel-group:**`.

> **Research item:** Codex's actual concurrency model is unverified. If `codex:codex-rescue` agents run truly concurrent without resource-pool constraints, FM-4 weakens substantially. Worth verifying via `codex:setup` before designing Slice β/γ.

#### FM-5: Worktree integrity check (4c) ambiguity

Step C 4c filters `git status --porcelain` against task-scope files. Under a wave, after Task 1 completes, porcelain shows files from Tasks 2–5 (still in flight) as "unexpected." 4c either fires false positives (every wave triggers human review) or gets skipped (loses CD-2 guarantee).

**Slice α mitigation:** Per-task `**Files:**` declared-scope filter. 4c filters against the union of in-flight wave members' files (post-glob-expansion). Implicit-paths whitelist (`state.yml`, `events.jsonl`, eligibility cache, `.git/`) added to the union only for orchestrator writes. Telemetry sidecars must be ignored and absent from porcelain rather than whitelisted.

#### FM-6: SDD is structurally serial

`superpowers:subagent-driven-development` has no parallel-dispatch primitive. Each SDD instance commits to the same branch — concurrent commits race the git index. The "wrap SDD in parallel-dispatch layer" mitigation alone doesn't solve this for committing work.

**Slice α mitigation (restricted to non-committing work):** Wrap SDD in /masterplan-side parallel-dispatch layer. Each SDD instance is serial within itself; wrapper waits for all to return. Wave members are read-only by Slice α design — no commits, no race. **Slice β/γ inherits the unsolved committing-work problem** — per-task git worktree subsystem (Slice γ) is the cheapest mitigation.

### Wave-level outcomes (failure handling)

- **All completed** → wave succeeds. Single-writer 4d update applies all N completions.
- **All blocked** → wave fails. Blocker re-engagement gate fires once at wave-end with the union of all N blocked.
- **Partial (K completed, N-K blocked)** → wave completes-with-blockers. K completions applied to run state; N-K blocker events appended; status flips to `blocked`. Gate fires once with the N-K subset.
- **Protocol violation detected** (orchestrator's post-barrier reconciliation finds a wave member that committed despite "DO NOT commit", wrote outside `**Files:**` scope, or modified run state): if `config.parallelism.abort_wave_on_protocol_violation: true` (default), the entire 4d batch is suppressed.

### Mid-wave interruption recovery

If the orchestrator crashes mid-wave (after dispatch, before barrier returns), the next session re-enters Step C step 1 with `state.yml` showing `current_task = <first wave task>` (unchanged). Re-build cache (mtime invariant kicks in); re-dispatch the wave from scratch. **Idempotent by Slice α design** — read-only members can be safely re-run.

---

## 8. Codex integration

### Codex as a plugin host

Codex support is packaged by `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json`. The Codex marketplace entry points at `./plugins/superpowers-masterplan`, a Git symlink back to the repo root, so the existing `commands/`, `skills/`, `bin/`, and docs stay single-source while satisfying Codex's plugin-path convention. Do not duplicate `commands/masterplan.md` under `plugins/`; if Codex packaging changes, update the packaging manifests and self-host audit instead.

The portable Codex invocation is `/superpowers-masterplan:masterplan`. A bare `/masterplan` alias is host-dependent and must not be documented as required unless a live smoke proves it.

When Codex is the host, the orchestrator suppresses the separate Claude Code `codex:codex-rescue` companion path for that invocation. Step 0 sets `codex_host_suppressed=true`, skips the ping/scan/trust availability checks, and treats effective `codex_routing` / `codex_review` as off without rewriting persisted config. This prevents recursive Codex-on-Codex dispatch while preserving the same command surface.

### Why Codex with /masterplan

Cross-model review catches blind spots — Sonnet's preferred patterns and Codex's preferred patterns don't perfectly overlap. Codex is bounded for small well-defined tasks (≤3 files, unambiguous, known verification, no design judgment). The combination is asymmetric: Codex doesn't review its own work (no signal there), but it DOES review Sonnet/Claude inline work and vice versa via routing.

### Defaults in v2.0.0

- `codex.routing: auto` — eligible tasks auto-delegate to Codex
- `codex.review: on` — every inline-completed task gets reviewed by `codex:codex-rescue` against the spec

If the codex plugin isn't installed, both default to off-for-the-run with a one-line warning at Step 0. Persisted config is unchanged.

### How it works

1. **Step C step 1 — eligibility cache build.** A Haiku scans the plan and computes `eligible: bool` per task per the eligibility checklist (≤3 files, unambiguous, known verification, no scope-out, no `**Codex:** no`). Caches to `docs/masterplan/<slug>/eligibility-cache.json`. Loaded from disk when `cache.mtime > plan.mtime`. Skipped when `codex_host_suppressed=true`.
2. **Step C 3a — routing decision per task.** Under `auto`: if `eligible: true`, dispatch via `codex:codex-rescue` (EXEC mode); else inline. Under `manual`: ask the user per task. Under Codex host suppression: route inline with `decision_source: host-suppressed`.
3. **Step C 4b — Codex review of inline work.** When `codex_review: on`, after a task completes inline, dispatch `codex:codex-rescue` (REVIEW mode) with the spec excerpt + diff range `<task_start_sha>..HEAD`. Severity-bucketed findings (high/medium/low). Decision matrix per autonomy mode. Skipped inside Codex with reason `running inside Codex — recursive Codex review disabled`.
4. **Plan annotations override the heuristic.** `**Codex:** ok` forces eligible (delegate even if heuristic rejects); `**Codex:** no` forces ineligible.

### Disabling

- CLI: `--no-codex` (or `--codex=off`), `--no-codex-review` (or `--codex-review=off`)
- Config: `codex.routing: off` + `codex.review: off` in `.masterplan.yaml`

### Graceful degrade

If `codex:codex-rescue` is not installed but config has `codex.routing != off` OR `codex.review == on`, Step 0 emits one-line warning and degrades both to `off` for the run. Doctor check #18 surfaces this misconfiguration as a Warning during lint. Persisted config is unchanged — re-installing codex restores configured behavior.

Host suppression is not plugin-missing degradation. Inside Codex, Step 0 emits a different notice, records a `codex host suppression` event on the next state write, and does not tell users to install the Claude Code companion plugin.

---

## 9. Telemetry signals + jq recipes

### Stop hook record schema

Each Stop turn while `/masterplan` is operating on a managed plan, the hook (`hooks/masterplan-telemetry.sh`) appends one JSONL record to `docs/masterplan/<slug>/telemetry.jsonl`:

```json
{
  "ts": "2026-05-04T02:08:37Z",
  "plan": "<slug>",
  "turn_kind": "stop",
  "transcript_bytes": 1234567,
  "transcript_lines": 391,
  "status_bytes": 554,
  "activity_log_entries": 12,
  "wakeup_count_24h": 3,
  "tasks_completed_this_turn": 1,
  "wave_groups": ["verification"],
  "branch": "feat/<branch>",
  "cwd": "/path/to/worktree"
}
```

### Field semantics

- `tasks_completed_this_turn` (v2.0.0+): delta of `activity_log_entries` between this and previous Stop record. **First-turn caveat:** when no previous record exists, reports 0 (no baseline). Activity log rotation can decrement; clamps to 0.
- `wave_groups` (v2.0.0+): distinct `[wave: <group>]` tags from the last `tasks_completed_this_turn` log entries. Empty for serial turns.
- See [`docs/design/telemetry-signals.md`](./design/telemetry-signals.md) for the canonical field reference.

### Useful jq queries

**Tokens-per-turn estimate (transcript bytes growth between Stops):**
```bash
jq -s '
  [.[] | select(.turn_kind=="stop")] as $entries
  | [range(1; $entries | length) as $i
     | {ts: $entries[$i].ts,
        growth: ($entries[$i].transcript_bytes - $entries[$i-1].transcript_bytes)}
     | select(.growth >= 0)]
' <plan>-telemetry.jsonl
```

**Average tasks-per-wave-turn:**
```bash
jq -s '
  [.[] | select(.turn_kind=="stop" and .tasks_completed_this_turn > 0)]
  | {wave_turns: ([.[] | select(.tasks_completed_this_turn > 1)] | length),
     serial_turns: ([.[] | select(.tasks_completed_this_turn == 1)] | length),
     avg_tasks_per_wave_turn: (
       ([.[] | select(.tasks_completed_this_turn > 1) | .tasks_completed_this_turn] | add // 0)
       /
       (([.[] | select(.tasks_completed_this_turn > 1)] | length) // 1)
     ),
     groups_seen: ([.[] | .wave_groups[]] | unique)}
' <plan>-telemetry.jsonl
```

Use the result to evaluate whether parallel-group annotations are being authored AND exercised. Non-zero `wave_turns` is a candidate trigger for the deferred Slice β/γ revisit (per [Section 12](#12-design-decisions--deferred-items)).

### Hook portability notes

- Linux smoke-tested. macOS portable-by-construction (uses `head -n1` instead of GNU `find -quit`; uses `stat -c '%Y' || stat -f '%m'` dual form instead of GNU `find -printf`). Not smoke-tested on macOS.
- Hook bails silently if `jq` is not installed (presence check at startup).
- Defensive bail: hook exits 0 in any session not on a /masterplan-managed plan branch (matches branch frontmatter).

---

## 10. Doctor checks (full table with rationale)

`/masterplan doctor [--fix]` lints run bundles and legacy state across all worktrees. Read-only by default; `--fix` only acts on checks marked auto-fixable in `commands/masterplan.md`.

The authoritative check table is in Step D of `commands/masterplan.md`. Keep that table and the Step D worker brief in sync first; this section is orientation only.

Current check families:

- **Migration and orphan cleanup:** legacy `docs/superpowers/...` artifacts not migrated, orphan legacy statuses, orphan events archives, orphan telemetry/subagents/cache files. Step C's completion-safe cleanup archives the verified subset automatically; full cleanup remains manual.
- **State integrity:** malformed `state.yml`, missing required fields, bad worktree/branch, missing phase-required `spec.md` or `plan.md`.
- **Execution drift:** stale in-progress/blocked plans, plan/log drift, cache-build evidence missing, routing configured but eligibility cache absent.
- **Parallelism safety:** malformed `parallel-group` tasks, overlapping file scopes, wave protocol violations, model attribution drift in `subagents.jsonl`.
- **Operational hygiene:** telemetry growth, non-empty `state.queue.jsonl`, missing compact loop for plans that requested it, completed plan without retro.

When adding a check, update the Step D table, the Step D parallelization brief count, and this family list if the new check creates a new class.

---

## 11. Verb routing + halt_mode flow

`/masterplan` accepts these verbs as the first token of `$ARGUMENTS`:

| First token | Branch | `halt_mode` |
|---|---|---|
| _(empty)_ | Step M0 → resume-first routing — inline status orientation + tripwire check, then auto-resume current/only in-progress plan, list+pick if ambiguous, or menu if none | `none` |
| `full` (no topic) | Prompt for topic, then Step B — full kickoff | `none` |
| `full <topic>` | Step B — full kickoff (B0→B1→B2→B3→C) | `none` |
| `brainstorm` (no topic) | Prompt for topic, then Step B0+B1; halt at B1 | `post-brainstorm` |
| `brainstorm <topic>` | Step B0+B1; halt at B1 | `post-brainstorm` |
| `plan` (no args) | Step P — pick spec-without-plan; treat as `plan --from-spec=<picked>` | `post-plan` |
| `plan <topic>` | Step B0+B1+B2+B3; halt at B3 | `post-plan` |
| `plan --from-spec=<path>` | cd into spec's worktree, run B2+B3 only; halt at B3 | `post-plan` |
| `execute` (no path) | Step A | `none` |
| `execute <state-path>` | Step C — resume that plan | `none` |
| `import` (alone or with args) | Step I | `none` |
| `doctor` (alone or with `--fix`) | Step D | `none` |
| `status` (alone or with `--plan=<slug>`) | Step S | `none` |
| `retro` (alone or with `<slug>`) | Step R | `none` |
| `stats` (alone or with `--plan=<slug>` / `--format=table\|json\|md` / `--all-repos` / `--since=<date>`) | Step T — codex-vs-inline routing distribution; shells out to `bin/masterplan-routing-stats.sh` | `none` |
| `clean` (alone or with args) | Step CL | `none` |
| `next` | Step N — "what's next?" router; scans state files inline, surfaces AUQ with resume/new-plan/status options | `none` |
| `--resume=<path>` | Step C | `none` |
| anything else | Step B (catch-all) | `none` |

### Bare `/masterplan` resume-first behavior

Since the post-v2.3.0 audit, empty `$ARGUMENTS` is resume-first. Step M0 emits the inline orientation and then:

- Auto-routes directly to Step C when exactly one in-progress plan is unambiguous (current worktree+branch match wins; otherwise the only in-progress plan across worktrees wins).
- Routes to Step A list+pick when active work exists but is ambiguous, including any blocked plan.
- Shows the broad category menu only when no active plan exists.

The empty-state broad menu asks for a category:

- **Phase work** — choose `brainstorm`, `plan`, `execute`, or `full`.
- **Operations** — choose `import`, `status`, `doctor`, `retro`, `stats`, or `clean`.

The reserved verb tokens are: `full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`, `stats`, `clean`, `next`. Topics literally named after a verb need a leading word (e.g. `/masterplan add brainstorm session timer`).
- **Resume in-flight** — delegates to Step A's existing list+pick flow.
- **Cancel** — exits without further tool calls.

This keeps interrupted work one command away while preserving verb discovery for repos with no active plan.

**Step M0 inline orientation (added post-v2.2.0).** Before resume-first routing, M0 emits a structured plain-text preamble: a one-line headline (`<N> in-flight, <M> blocked across <W> worktrees [· <K> issue(s) detected — consider /masterplan doctor]`), up to 3 in-flight/blocked plan bullets with `current_task` + age, and a truncation tail if there are more. It runs 7 cheap inline tripwire checks (a latency-bounded subset of doctor checks #2, #3, #4, #5, #6, #9, #10) — all derivable from frontmatter + the `git_state` cache already in memory. The full parsed plan list is cached in `step_m_plans_cache`; if routing falls through to Step A, Step A's step 0 short-circuits to the cache and skips its own worktree scan + Haiku dispatch. The "Stay on script" guardrail explicitly bounds the preamble to this format — no prose tangents, no per-check enumeration (that's `doctor`'s job).

### Verb tokens are reserved

Topics literally named `full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`, `stats`, `clean`, or `next` need a leading word (e.g., `/masterplan add brainstorm session timer`).

### `halt_mode` state machine

Set in Step 0 from the verb match. Read by Steps B1, B2, B3, C to choose between gate behavior and halt-aware variant.

- **`halt_mode == none`** — full kickoff or execute path. Existing behavior.
- **`halt_mode == post-brainstorm`** — fires when invoked via `/masterplan brainstorm <topic>`. B1's close-out gate ends the turn after spec is written. B2 + B3 dispatch guards skip themselves.
- **`halt_mode == post-plan`** — fires when invoked via `/masterplan plan ...` or via Step P's pick. B3's close-out gate ends the turn after `state.yml` and bundled artifacts are written. Step C's dispatch guard skips Step C.

### In-session halt_mode flips

The halt_mode close-out gates offer "Continue to plan now" (B1) or "Start execution now" (B3) options. Picking either flips `halt_mode` in-session:

- B1's "Continue to plan now" → `post-brainstorm` flips to `post-plan`. Falls through B2 to B3, where the user picks again.
- B3's "Start execution now" → `post-plan` flips to `none`. Step C dispatch guard then allows entry.

### Three-place verb-list invariant

Adding/renaming a verb requires updating three sync'd locations in `commands/masterplan.md`:

1. The frontmatter `description:` line (~line 2). Powers autocomplete.
2. The verb routing table (~line 46).
3. The reserved-verbs warning (~line 70).

Doctor check candidate (deferred): scan for drift across these three locations.

---

## 12. Design decisions + deferred items

This section captures the WHY of significant architectural decisions. Distilled from pre-v2.0.0 internal handoff notes that were pruned in the v2.0.0 release.

### Why a thin orchestrator over re-implementation

Brainstorming, planning, execution all live in `obra/superpowers`. /masterplan sequences them. Reasoning:
- Improvements to upstream skills compound without local changes.
- Smaller surface to maintain (one orchestrator prompt).
- No re-implementation drift risk.

Cost: dependencies on superpowers skills (their evolution can break /masterplan in subtle ways). Mitigation: pre-empt upstream skill prompts via `AskUserQuestion` so silent-stop bugs don't propagate (per the audit pass that closed five such gates).

### Why subagent-driven by default

Long autonomous runs accumulate context (failed experiments, big diffs, library docs, verification dumps). By task 10, the orchestrator reasons on cluttered state and quality drops. Solution: every substantive piece of work goes to a fresh subagent; only digests come back. The run bundle is the persistence bridge.

This is what makes ScheduleWakeup'ing into a fresh session every ~3 tasks lossless.

### Why run bundle as only source of truth

Conversation context evaporates between sessions, especially after compaction. A future agent (or future-you) needs deterministic resume — `state.yml`, `plan.md`, `spec.md`, and recent `events.jsonl` entries are enough to continue. Anything in conversation is bonus, not load-bearing.

### Why the 4-option blocker re-engagement gate (v1.0.0 audit)

Original gate had 5 options, violating CD-9's 2–4 cap. Audit dropped option 3 ("Break this task into smaller pieces") because it overlapped semantically with option 1 ("Provide context and re-dispatch"). Option 5 (the legacy `status: blocked` end-turn) is preserved — resume-from-blocker depends on it being the only path to that state.

### Why explicit phase verbs

Original kickoff was all-or-nothing — the bare topic catch-all triggered full B0→B1→B2→B3→C. Adding `brainstorm` / `plan` / `execute` as first-token verbs makes pipeline phases addressable. `halt_mode` state machine cleanly handles "stop after spec" / "stop after plan" without per-step boolean flags.

### Why Codex defaults flipped to on

Earlier default: `codex.review: off`. Most users who installed Codex wanted adversarial review by default but had to explicitly enable it. v2.0.0 flips both `codex.routing: auto` and `codex.review: on`. Graceful degrade on missing-codex makes this safe (one-line warning, run continues).

### Why intra-plan parallelism Slice α first

Three slices were considered:
- **Slice α — read-only parallel waves only.** ~5-7 days. Sidesteps git-index race. Ships supporting infrastructure (single-writer funnel, scope-snapshot, files-filter) reusable for β/γ.
- **Slice β — serialized-commit waves.** ~8-10 days. Parallel work, serial commits funneled through orchestrator. Latency win is partial — work parallelizes, commits serialize.
- **Slice γ — full per-task git worktree subsystem.** ~10-15 days. Real parallel committing-task execution. Original deferred-design ambition.

Slice α picked because the depth-pass on candidate mitigations found that the SDD-wrapper (M-4a) ALONE doesn't solve the central git-index-race for committing work. Read-only work sidesteps it entirely.

### Deferred items (Slice β/γ + others)

Sharpened revisit trigger for Slice β/γ (in `docs/design/intra-plan-parallelism.md`):

> *"Revisit Slice β when a real /masterplan plan shows ≥3 parallel-grouped committing tasks where the wave's serial wall-clock cost exceeds 10 minutes AND the committed work is independent enough for the Slice α `**Files:**` exhaustive-scope rule to apply. Revisit Slice γ when ≥3 such β-eligible waves accumulate within a single plan's lifecycle."*

Other deferrals:
- Doctor check candidate that scans for the Slice β/γ revisit trigger condition (telemetry-derived).
- Canned-`$ARGUMENTS` self-test specs for routing-table drift detection.
- `depends-on:` DAG-style task ordering (only meaningful for Slice β/γ).
- Auto-detection of "obvious" parallel-friendly patterns without explicit `parallel-group:` annotation.
- Plan-task reordering to maximize wave size.
- Cross-worktree wave dispatch.
- Wave dispatch under `--no-subagents` mode (subagent dispatch IS the mechanism).
- Codex CLI/API concurrency-model verification (affects whether a future slice could allow Codex tasks in waves).
- macOS smoke verification of the telemetry hook (gated on access to a macOS env).

---

## 13. Common dev recipes

### Recipe: Add a new verb to /masterplan

1. Update the **three sync'd locations** in `commands/masterplan.md`:
   - Frontmatter `description:` (~line 2)
   - Verb routing table (~line 46) — add row
   - Reserved-verbs warning (~line 70) — add to list
2. Add a new `## Step X` section implementing the verb's logic.
3. If the verb halts (like `brainstorm` / `plan`), set the appropriate `halt_mode` value and ensure dispatch guards in B1/B2/B3/C respect it.
4. Add to README's Verb reference table.
5. Add to CHANGELOG `### Added` section.
6. Grep verification: positive grep for verb name in all four locations (description, routing table, warning, README); negative grep for old behavior.

### Recipe: Add a new doctor check

1. Add a new row to the Step D checks table in `commands/masterplan.md`. Severity: Warning unless the check identifies state that prevents resumption (then Error).
2. Update Step D's parallelization brief: increment "all N checks" to N+1.
3. Document the check's rationale in [Section 10](#10-doctor-checks-full-table-with-rationale) of this file.
4. If the check is auto-fixable, document the `--fix` action in the table.
5. Grep verification: doctor table row count matches the brief's N (use `awk '/^### Checks/,/^### Auto-fix/' commands/masterplan.md | grep -cE '^\| [0-9]+ \|'`).

### Recipe: Debug a stuck plan

1. Read the run state: `cat docs/masterplan/<slug>/state.yml` and `tail -20 docs/masterplan/<slug>/events.jsonl`. Look at `current_task`, `next_action`, pending gates, recent blockers, and warning/decision events.
2. Verify worktree integrity: `cd <worktree>; git status --porcelain`. Files outside the current task's `**Files:**` scope are CD-2 violations or in-flight wave members.
3. Verify branch matches: `git rev-parse --abbrev-ref HEAD` should equal `state.yml`'s `branch:`.
4. Check eligibility cache freshness: compare `docs/masterplan/<slug>/eligibility-cache.json` mtime to `docs/masterplan/<slug>/plan.md` mtime. If cache.mtime < plan.mtime, cache rebuild is overdue (next Step C entry will rebuild).
5. Run `/masterplan doctor` for the worktree. Errors blocking resumption surface here.
6. If a wave appears stuck mid-execution: check whether the wave-completion barrier returned by inspecting events for partial completions. If yes, the resume path is "re-dispatch the wave from scratch" (Slice α is idempotent for read-only work).

### Recipe: Write a new spec via /masterplan

1. From a clean worktree: `/masterplan brainstorm <topic>`. Halts at the spec-written gate.
2. Review the spec at `docs/masterplan/<slug>/spec.md`. Edit if needed.
3. Continue: `/masterplan plan --from-spec=docs/masterplan/<slug>/spec.md`. Halts at the plan-written gate.
4. Review plan at `docs/masterplan/<slug>/plan.md`. Edit if needed (but don't break the writing-plans format).
5. Execute when ready: `/masterplan execute docs/masterplan/<slug>/state.yml`.

### Recipe: Run smoke verification on the telemetry hook

```bash
TMPREPO=$(mktemp -d)
cd "$TMPREPO"
git init -q && git checkout -q -b feat/test
git config user.email test@example.com && git config user.name "Test"
mkdir -p docs/masterplan/test
cat > docs/masterplan/test/state.yml <<'EOF'
schema_version: 2
slug: test
status: in-progress
phase: executing
artifacts:
  spec: docs/masterplan/test/spec.md
  plan: docs/masterplan/test/plan.md
  events: docs/masterplan/test/events.jsonl
worktree: /tmp/dummy
branch: feat/test
started: 2026-05-04
last_activity: 2026-05-04T12:00:00Z
current_task: "test"
next_action: "test"
autonomy: gated
loop_enabled: true
codex_routing: off
codex_review: off
compact_loop_recommended: false
complexity: medium
pending_gate: null
legacy: {}
EOF
printf '%s\n' '{"ts":"2026-05-04T12:00:00Z","type":"task_completed","message":"task complete"}' > docs/masterplan/test/events.jsonl
git add -A && git commit -q -m "init"
bash /path/to/superpowers-masterplan/hooks/masterplan-telemetry.sh
cat docs/masterplan/test/telemetry.jsonl | jq .
cd / && rm -rf "$TMPREPO"
```

Expected: a JSONL record with all fields populated. Defensive bail confirmed if branch doesn't match any state file.

### Recipe: Run smoke verification on wave dispatch

Hand-craft a 3-task plan with `parallel-group: smoke-verify` annotations on all three tasks (each task with a unique `**Files:**` block listing nonexistent paths so they're trivially read-only). Run `/masterplan execute` against it. Verify:

- Step C step 1 builds eligibility cache; computes `parallel_eligible: true` for all three.
- Step C step 2 wave assembly gathers all three into one wave.
- Three concurrent SDD dispatches via `Agent` tool.
- Wave-completion barrier returns three digests.
- Step C 4d single-writer applies three events in plan-order, each tagged `[inline][wave: smoke-verify]`.
- Single git commit: `masterplan: wave complete (group: smoke-verify, 3 tasks)`.

Delete the test plan files before commit.

### Recipe: Fix a halt_mode flow regression

The halt_mode flow is the highest-risk surface (tendrils across B1/B2/B3/C/P).

1. Run the discriminator suite: `grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/masterplan.md | wc -l`. Baseline count is ~22; significant deviation indicates an issue.
2. After any edit to B1/B2/B3/C, re-grep. Look for: orphan references to a removed option label, or new references that haven't been wired into the dispatch guards.
3. Dispatch a fresh-eyes Explore subagent to read commands/masterplan.md end-to-end with the prompt: "find any contradictions, dangling references, or stale draft remnants in the halt_mode flow." Catches confirmation-bias misses.

### Recipe: Add a new CHANGELOG entry

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Section headings: Added / Changed / Deprecated / Removed / Fixed / Security. Subsections like `### Notes` or `### Migration notes` are accepted but don't claim Keep-a-Changelog conformance for them.

For a major release (breaking change / version 2.0.0+), include explicit `### Migration notes` enumerating user-facing changes that require action.

---

## 14. Anti-patterns + contributor pitfalls

### Architectural anti-patterns

- **Adding logic to the orchestrator that belongs to a superpowers skill.** Brainstorming, planning, executing — all live in `obra/superpowers`. /masterplan sequences. Resist re-implementing.
- **Holding raw subagent output in the orchestrator's context.** Always digest. The dispatch model exists precisely so the orchestrator stays small.
- **Ending a turn with a free-text prose question.** Sessions can compact; free-text becomes a dead end. Use `AskUserQuestion` with 2–4 concrete options (CD-9).
- **Editing the orchestrator without re-running the halt_mode discriminator suite.** The flow has tendrils across B1/B2/B3/C/P. Drift here is hard to spot without targeted grep.

### Codex anti-patterns

- **Self-review.** Codex executing a task and then reviewing its own diff adds no signal. The asymmetric review rule prevents this — never relax it.
- **Forcing parallel waves to allow Codex-routed tasks.** FM-4 mitigation: Codex falls out of waves. Don't try to "make it work" by serializing review prompts inside the wave — the gate UX collapses.
- **Trusting `codex_review: on` to catch logic bugs.** Codex review is adversarial code review against the spec, not deep reasoning about correctness. Treat findings as data; trust your own analysis for high-stakes decisions.

### Wave dispatch anti-patterns (Slice α)

- **Letting a wave member modify plan.md, state.yml, events.jsonl, or eligibility cache.** Detected as `protocol_violation`. CD-2 in-wave scope rule forbids this.
- **Letting a wave member commit.** For Slice α, wave members are read-only by design. Committing is a `protocol_violation`. The default `abort_wave_on_protocol_violation: true` suppresses the entire 4d batch when this happens.
- **Reordering plan tasks to make a wave bigger.** Plan-order is authoritative; the wave-assembly walk is contiguous-only. If parallel-grouped tasks are interleaved with serial tasks, none parallelize. Authors are responsible for ordering.
- **Adding `parallel-group:` to a task without `**Files:**`.** Eligibility rule 2 violated; falls back to serial. Doctor check #15 surfaces this.

### Run-state anti-patterns

- **Writing to `state.yml` or `events.jsonl` from inside an implementer subagent.** Orchestrator is the canonical writer (CD-7). Implementers return digests; orchestrator updates.
- **Burying decisions in conversation instead of events.** Future agents have no access to your conversation. `events.jsonl` and explicit `state.yml` fields are the persistence surface.
- **Letting `current_task` go out of sync with the plan.** Step C step 1 reconciles on every entry; if you see drift, trust the plan and update `state.yml`.

### Verification anti-patterns

- **Claiming "should work" without running the verification commands.** CD-3 violation. Cite real output.
- **Re-running the implementer's tests in Step 4a.** Trust the implementer's `tests_passed` + `commands_run` digest. Run only complementary verifiers.
- **Running noisy commands directly in the orchestrator's context.** CC-2 violation. Route via Haiku subagent that returns pass/fail + ≤3 evidence lines.

### Edit anti-patterns

- **Bulk sed without per-extension boundary regex.** Substitutions on YAML/JSON/markdown/bash have different escape rules. Use `\bword\b` boundaries; verify with negative grep per file.
- **Trusting your own confirmation bias on multi-edit passes to a single file.** Dispatch a fresh-eyes Explore subagent to read end-to-end after the pass.
- **Adding a doctor check without updating the parallelization-brief count.** Step D dispatches Haiku with "all N checks"; drift means workers silently skip checks.

---

## 15. Cross-references

| Topic | Authoritative source |
|---|---|
| Behavior of any Step / verb / flag | [`commands/masterplan.md`](../commands/masterplan.md) |
| Public-facing usage / install / config | [`README.md`](../README.md) |
| Per-version what-changed | [`CHANGELOG.md`](../CHANGELOG.md) |
| Slice α design + deferred Slice β/γ | [`docs/design/intra-plan-parallelism.md`](./design/intra-plan-parallelism.md) |
| Telemetry record schema + queries | [`docs/design/telemetry-signals.md`](./design/telemetry-signals.md) |
| Active in-flight plans | `docs/masterplan/*/state.yml` |
| Plan execution state | `docs/masterplan/<slug>/state.yml` + `events.jsonl` (single source of truth per CD-7) |
| Eligibility cache | `docs/masterplan/<slug>/eligibility-cache.json` (mtime-invalidated) |
| Telemetry data | `docs/masterplan/<slug>/telemetry.jsonl` and `subagents.jsonl` (local-only, ignored before write) |
| Codex plugin | `openai/codex-plugin-cc` (cross-plugin dependency, optional) |
| Superpowers skills | `obra/superpowers` (cross-plugin dependency, required) |

### Outbound references (not in this repo)

- **`obra/superpowers`** — `brainstorming`, `writing-plans`, `subagent-driven-development`, `executing-plans`, `using-git-worktrees`, `systematic-debugging`, `finishing-a-development-branch`. /masterplan is a thin orchestrator over these.
- **`openai/codex-plugin-cc`** — provides `codex:codex-rescue` subagent. Optional dependency; gracefully degrades when absent (Step 0 detection + doctor check #18).
- **`context7` MCP** — used by the CD-4 ladder for library documentation lookups.
- **`gh` CLI** — required for `/masterplan import` of GitHub issues and PRs.

### When this doc gets out of date

The most likely sources of staleness:
- Verb routing table (Section 11) — when verbs change, sync this with `commands/masterplan.md` Step 0.
- Doctor checks table (Section 10) — when checks are added, append a row + update the count.
- Failure-mode catalog (Section 7) — when v2.0.x discovers new failure modes, append (don't renumber existing FMs).
- CD rules (Section 5) — rare but possible. CD definitions live in `commands/masterplan.md`; this doc reflects them.
- Operational rules (Section 6) — when the orchestrator gains a new operational rule, mirror here.

When updating, dispatch a fresh-eyes Explore subagent after a multi-section edit to catch contradictions.

---

*End of internals.md. ~6500 words. Last updated for v2.3.1.*
