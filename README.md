# superpowers-masterplan

> A Claude Code & Codex CLI plugin for multi-hour engineering work — durable run bundles, four-phase brainstorm/plan/execute/retro lifecycle, wave-mode parallel dispatch, and asymmetric Codex review.

**Version:** 5.8.0 · **License:** MIT · **Works with:** Claude Code, Codex CLI

---

## What this is

`superpowers-masterplan` is a Claude Code (and Codex CLI) plugin that runs multi-hour software-engineering tasks as a four-phase, durable workflow: **brainstorm → plan → execute → retro**. Each run lives in a self-contained on-disk *run bundle* (`docs/masterplan/<slug>/`) holding `state.yml`, `spec.md`, `plan.md`, `events.jsonl`, and `retro.md`. The bundle — not your conversation context — is the source of truth, so a `/clear`, a session compaction, an IDE crash, or switching from Claude Code to Codex CLI mid-run all resume cleanly: `/masterplan` (no args) lists in-progress slugs and picks up exactly where the events log left off.

It is built for engineers running multi-hour work that wants three things at once: **auditability** (every dispatch, every wave, every Codex/Claude decision is appended to `events.jsonl` as it happens), **parallelism** (wave dispatch fans N independent tasks to N subagents in one assistant turn), and **asymmetric trust** (Codex-produced work is annotated `decision_source: codex-produced` and skipped by Codex review — the model doesn't grade its own homework). If you want a one-shot copilot, you don't need this; if you want a workflow that can survive a 6-hour task and a model swap, you do.

### Why durability matters

A long-running coding task that lives only in the chat window is one accidental `/clear`, one context compaction, or one host crash away from being unrecoverable. The loss isn't "the code I was about to write" — it's the *plan*: which tasks were already committed, which wave was in flight, which dispatch paired with which Codex/Claude decision. Reconstructing that from memory on a 6-hour task is effectively starting over. Masterplan's answer is to externalize the state into an on-disk run bundle (§2), so any of those failure modes degrades to "type `/masterplan` again."

### Why context-window management matters

Long inline sessions degrade two ways. **Correctness:** even on a 200k-token window, after a dozen tasks the orchestrator is reasoning against accumulated stale experiments, partial diffs, and verbose verification output it no longer needs; attention degrades well before the window is full, and the same agent that nailed task 3 quietly misroutes task 14. **Token efficiency:** every accumulated byte is rebilled on every turn, so a long inline run pays compound interest on context that should have been discarded — even when the answer is still right, you've paid several multiples of the necessary token cost to get there. The fix isn't a bigger window (those degrade too, just later); it's structural, and §2 is how it's wired.

## Subagent dispatch & context-window management

Forward references in this section — *wave*, *digest*, *dispatch brief*, *autonomy level* — are all defined in §4 (Core concepts). Here's how they fit together in practice.

The architecture's most consequential design choice: **the orchestrator never executes substantive work itself**. Every step that would otherwise bloat its context — file reading, code generation, library-doc lookups, verification, log triage — fans out to a bounded subagent that gets a fresh context window, a single dispatch brief (goal, inputs, allowed scope, constraints, return shape), and returns only a *digest* (≤5120 bytes: commit SHA, verify result, short note). The orchestrator never sees raw subagent output.

Subagents are tiered explicitly by task class. `/masterplan` pays for the model the work actually needs, not whatever the parent happens to be running:

| Phase | Model | Why |
|---|---|---|
| Discovery scans (Step I1) | **Haiku** | Mechanical extraction, parallel, bounded |
| Per-task implementation | **Sonnet** | Default workhorse via `superpowers:subagent-driven-development` |
| Conversion / rewriting | **Sonnet** | Generation, not just extraction |
| Architecture, ambiguous specs | **Opus** | Reserved for tasks that genuinely need deep reasoning |
| Small, well-defined coding tasks | **Codex** | Per the routing toggle, via `codex:codex-rescue` |
| Asymmetric Codex REVIEW | **Codex (review mode)** | Fresh-eyes review of Sonnet/Claude diffs against spec, when `codex_review: on` |
| Completion inference | **Haiku** | One per task chunk, parallel, bounded |

Activity records carry only what the orchestrator needs to resume — typically commit SHA, route, and (only on anomalies) a short note. Wave 1 of the real `docs/masterplan/codex-routing-fix/` run, three Codex EXECs dispatched in parallel in a single assistant turn:

```jsonl
{"ts":"2026-05-16T16:01:00Z","event":"wave_routing_summary","wave":1,"members_by_route":{"codex":3,"inline_review":0,"inline_no_review":0},"members":["T1","T2","T3"]}
{"ts":"2026-05-16T16:10:00Z","event":"wave_task_completed","wave":1,"task":"T1","commit":"80b96d5","dispatched_by":"codex"}
{"ts":"2026-05-16T16:10:00Z","event":"wave_task_completed","wave":1,"task":"T2","commit":"0e0ce06","dispatched_by":"codex"}
{"ts":"2026-05-16T16:10:00Z","event":"wave_task_completed","wave":1,"task":"T3","commit":"322dac8","dispatched_by":"codex"}
{"ts":"2026-05-16T16:10:00Z","event":"wave_complete","wave":1,"members":["T1","T2","T3"],"commits":["80b96d5","0e0ce06","322dac8"]}
```

Three Codex transcripts that would otherwise eat ~30k tokens of orchestrator window each collapse to four lines of JSONL — fixed cost regardless of wave width. That's what makes `/clear` between waves lossless and `ScheduleWakeup` into a fresh session every ~3 tasks survivable: mid-session context is disposable. The same pattern extends beyond execute — doctor scans, situation reports, and per-worktree frontmatter parsing parallelize identically when N ≥ 2 worktrees. §7 covers wave-mode dispatch end-to-end; full per-step model + parallelism table: [`docs/internals.md`](./docs/internals.md).

## Install

### Claude Code

```text
/plugin marketplace add rasatpetabit/superpowers-masterplan
/plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan
/reload-plugins
```

The marketplace add registers the catalog; the install step actually loads the plugin and its `masterplan-detect` skill. `superpowers` resolves automatically as a declared dependency. For desktop-app, manual, or offline setup, see [docs/install.md](docs/install.md).

### Codex CLI

```sh
codex plugin marketplace add rasatpetabit/superpowers-masterplan
```

Codex hosts the orchestrator under `/superpowers-masterplan:masterplan`; see [parts/codex-host.md](parts/codex-host.md) for suppression rules and Codex-specific behavior differences.

### Optional telemetry hook

Optional. Wire `hooks/masterplan-telemetry.sh` as a global Stop hook in `~/.claude/settings.json`; required only if you want `/masterplan stats`. For signal definitions and opt-out, see [docs/design/telemetry-signals.md](docs/design/telemetry-signals.md).

---

Requires Claude Code or Codex CLI; depends on the upstream `superpowers` plugin (auto-installed via the marketplace).

## Core concepts

**Run bundle** — the directory `docs/masterplan/<slug>/` containing `state.yml`, `spec.md`, `plan.md`, `plan.index.json`, `events.jsonl`, `retro.md`, `.lock`, and `eligibility-cache.json`. The single source of truth for a run; survives `/clear` and host swap because it lives in the repo, not in conversation context. See [`parts/contracts/run-bundle.md`](./parts/contracts/run-bundle.md).

**Phase + gate** — the run lifecycle moves through four phases: B0–B1 (brainstorm), B2–B3 (plan), C1–C6 (execute), R (retro). Gates are validators at phase boundaries that block forward progress until their conditions are met; under `gated` autonomy most gates pause for user confirmation, under `loose` and `full` they auto-advance when conditions are satisfied. See [`docs/internals.md`](./docs/internals.md).

**Wave** — N tasks from the same `**parallel-group:**` annotation dispatched as one batch in a single assistant message. Introduced in v2.0.0; per-member review gating refined in v5.8.0 (see *Asymmetric review* below and §7). See [`parts/contracts/agent-dispatch.md`](./parts/contracts/agent-dispatch.md).

**Autonomy levels** — `gated` (default) | `loose` | `full`. Controls which gates fire interactively: `gated` prompts at every phase boundary; `loose` auto-advances through successful gates; `full` suppresses even mid-task confirmation prompts. Set via `.masterplan.yaml`, CLI flag, or per-run in `state.yml`. See [`docs/config-schema.md`](./docs/config-schema.md).

**Subagent dispatch contract** — every lifecycle dispatch site must carry a `DISPATCH-SITE:` tag and a registered `contract_id` in `commands/masterplan-contracts.md`. The orchestrator validates return shapes against the contract before acting; a mismatched or missing `contract_id` triggers a `contract_violation` event. Doctor check `--brief-style` enforces no orphan dispatch sites. See [`parts/contracts/agent-dispatch.md`](./parts/contracts/agent-dispatch.md).

**Asymmetric review** — when `dispatched_by ∈ {codex, codex+claude-fixup}` on a completion event, Step 4b skips Codex review and emits `review→SKIP(codex-produced)` with `decision_source: codex-produced`. Prevents Codex from grading its own output, applied uniformly across serial and wave-mode paths. New in v5.8.0. See [`docs/internals.md`](./docs/internals.md).

**Guard C (flock)** — `flock <bundle>/.lock` wraps every `state.yml` / `events.jsonl` write sequence with a 5-second timeout. The helper in `bin/masterplan-state.sh` exits with ERROR on timeout, leaving the orchestrator to decide whether to queue the would-be update (the intended contention recovery, drained by doctor check #24) or abort the turn. On hosts without `flock(1)`, the helper degrades unguarded and emits a `state_lock_unavailable` event. Doctor check #42 warns when `<bundle>/.lock` is older than 1 hour, indicating a wedged writer. See [`parts/step-c.md`](./parts/step-c.md).

## Verbs

Each invocation matches its first token against the routing table below; unrecognized tokens fall through to the resume picker.

| Verb | Phase | What it does | Output |
|---|---|---|---|
| `/masterplan` | intake | Resume picker or new-topic prompt | (interactive) |
| `/masterplan brainstorm <topic>` | brainstorm | Discovery + spec; halts at B1 gate | `spec.md` |
| `/masterplan plan [<topic>\|--from-spec=]` | plan | Spec (if absent) then plan; halts at B3 | `plan.md` |
| `/masterplan full <topic>` | all | Full brainstorm → plan → execute pipeline | all artifacts |
| `/masterplan execute [<topic>\|<state>]` | execute | Resume or pick an in-progress plan | `events.jsonl` |
| `/masterplan retro [<state>]` | retro | Generate retrospective; archive bundle | `retro.md` |
| `/masterplan import [--pr=\|--issue=\|--file=\|--branch=]` | intake | Migrate legacy artifacts to run bundle | `state.yml` |
| `/masterplan doctor [--fix]` | diagnostics | 43 lint checks across bundles | stdout report |
| `/masterplan status` | diagnostics | Current plan, phase, and activity | stdout report |
| `/masterplan stats` | diagnostics | Telemetry roll-up (per-turn + per-subagent) | stdout report |
| `/masterplan validate` | diagnostics | Config + state schema check | stdout report |
| `/masterplan clean` | diagnostics | Archive completed; prune legacy artifacts | `archive/` |
| `/masterplan next` | intake | Route to next actionable plan | (interactive) |

Flags and per-verb options: see [`docs/verbs.md`](./docs/verbs.md). Doctor checks: see [`parts/doctor.md`](./parts/doctor.md).

## Configuration

Configuration loads from three tiers (later overrides earlier): `~/.masterplan.yaml` → `<repo-root>/.masterplan.yaml` → CLI flag → per-run override in `state.yml`. Most installs leave the defaults alone; the knobs below are the ones that get changed in practice.

```yaml
autonomy: gated              # gated | loose | full
complexity: medium           # low | medium | high
runs_path: docs/masterplan
parallelism:
  enabled: true              # wave dispatch on; set false to force serial
codex:
  routing: auto              # auto | on | off (per-task **Codex:** annotation governs `auto`)
  review: on                 # on | off — controls Step 4b Codex REVIEW dispatch
  detection_mode: scan-then-ping   # scan-then-ping | trust | ping
  unavailable_policy: degrade-loudly   # degrade-loudly | block
```

`autonomy` is the most-touched setting — `gated` for new users, `loose` for trusted multi-hour runs, `full` only for autonomous pipelines (e.g., `/loop /masterplan full ...`). `codex.detection_mode` defaults to `scan-then-ping` (v5.3.0+): cheap scan first, ping only on miss. Set `trust` on locked-down accounts where the ping fails for non-availability reasons. `codex.unavailable_policy: degrade-loudly` is the safe default — if Codex is unreachable the run continues Claude-only but emits a `codex_degraded` event the doctor + telemetry will surface. Full schema and per-field semantics: [`docs/config-schema.md`](./docs/config-schema.md).

## Parallelism, Codex routing, asymmetric review

These three mechanisms turn the linear "draft a plan, work through it" model into something that survives a 6-hour task without the orchestrator's context window collapsing.

**Wave dispatch (v2.0.0+).** Plan tasks share a `**parallel-group:**` annotation; the orchestrator fans every member of a group into one assistant turn as N parallel subagent calls under a single barrier. Each subagent returns a digest (commit SHA, verify result, ≤5120-byte note), never raw diff output, so context cost is fixed at digest size × wave width rather than full transcript × N. Wave-completion is recorded once per wave as `wave_complete` with `{members, commits}` — the orchestrator never reads back per-member files. Wave width is bounded only by the task graph; the largest shipped run was a 4-member parallel batch (`codex-routing-fix` wave 4: T9–T12 in commit `c94b5cb`).

**Codex routing (aggressive default in v5.8.0).** The plan-writer (`parts/step-b.md`) now annotates `**Codex:** ok` by default for any single-file edit, code or doc, with verifiable acceptance criteria. It only marks `**Codex:** no` when the task is multi-file, scope is ambiguous, no known verification exists, or the user explicitly scoped Codex out. At Step C dispatch, `codex.routing: auto` (the default) consults the per-task annotation; `codex.routing: on/off` overrides it. The plan-writer aggressiveness reverses the prior conservative default, which left a majority of Codex-eligible tasks routing to Claude SDD — measurably under-using the cheaper, bounded path.

**Asymmetric review (new in v5.8.0).** When a `wave_task_completed` or serial task-completion event carries `dispatched_by ∈ {codex, codex+claude-fixup}`, Step 4b skips Codex REVIEW and emits `review→SKIP(codex-produced)` with `decision_source: codex-produced`. The principle: the model that produced the code should not also grade it. Codex-produced work is held to spec-fit verification (tests, doctor, post-condition checks) rather than fresh-eyes Codex review; Sonnet-produced work goes through full Codex REVIEW. Applied uniformly across serial and per-wave-member paths; doctor check #43 (`codex_review_coverage`) enforces 100% paired-review coverage across every `wave_task_completed` event.

All three mechanisms compose on the wave shown in §2. After the three Codex EXECs return with `dispatched_by` of `codex` or `codex+claude-fixup`, Step 4b emits three `review→SKIP(codex-produced)` events with `decision_source: codex-produced` — no Codex REVIEW is dispatched. Doctor check #43 later confirms every `wave_task_completed` has a paired review event (either a `review→CODEX` or a `review→SKIP`); absence triggers failure class `wave_codex_review_skip` and the run halts. The asymmetric-review path is what keeps Codex-produced work cheap (no second Codex pass) without losing audit coverage (doctor #43 enforces 100%).

Full mechanism + dispatch contract surface: [`docs/internals.md`](./docs/internals.md), [`parts/step-c.md`](./parts/step-c.md), [`commands/masterplan-contracts.md`](./commands/masterplan-contracts.md).

## Doctor, failure classes, self-host audit

### Doctor

`/masterplan doctor` runs 43 lint checks across all run bundles. The check set is complexity-aware: `low` plans skip ~14 checks (sidecar, annotation, ledger, cache, and per-subagent-telemetry checks that those plans never produce); `high` plans add 2 additional checks (#22 rigor evidence, #40 Codex/parallel-group annotation coverage). New in v5.8.0: check #43 (`codex_review_coverage`) validates that every `wave_task_completed` event has a paired `review→CODEX` or `review→SKIP` event with explicit `decision_source`. Auto-fix available for repairable findings: `/masterplan doctor --fix`.

### Failure classes

`parts/failure-classes.md` catalogues anomaly classes the orchestrator detects at runtime. v5.8.0 added four: `wave_codex_review_skip` (wave review coverage < 100%), `subagent_return_oversized` (return text > 5120 bytes), `eligibility_cache_event_missing` (mandatory cache event absent at Step C entry), and `dispatch_brief_unregistered` (lifecycle dispatch site lacking a registered `contract_id`). Each entry includes a name, description, and recommended response.

### Self-host audit

`bin/masterplan-self-host-audit.sh` is a developer-only script that validates the plugin against its own contracts: deployment drift across shipped files, dispatch-brief registration, doctor check consistency, and CD-9 free-text-question compliance. v5.8.0 strengthened `--brief-style` to enforce Pattern D (contract_id within 30 lines of each lifecycle dispatch site). Run pre-release; exit code 1 blocks release.

Details: [`parts/doctor.md`](./parts/doctor.md), [`parts/failure-classes.md`](./parts/failure-classes.md).

## Troubleshooting

**Q: My session got `/clear`'d mid-execute. How do I resume?**
A: Run `/masterplan` (no args). The intake picker lists in-progress plans by recency; pick one. State lives in `docs/masterplan/<slug>/state.yml`.

**Q: Can I run two plans at once?**
A: Yes — different slugs, different worktrees. Guard C (`bin/masterplan-state.sh`) serializes writes per-bundle via `<bundle>/.lock`; concurrent writes to the same bundle would corrupt `events.jsonl` without it.

**Q: Doctor is WARNing on check #43 for old bundles.**
A: Expected. `codex_review_coverage` (v5.8.0) WARNs on bundles predating wave-review events. No auto-fix exists; ignore or accept the WARN.

**Q: Codex isn't being detected.**
A: Verify `detection_mode` (default `scan-then-ping`, v5.3.0+). On locked-down accounts, set `detection_mode: trust` in `~/.masterplan.yaml`. See `parts/codex-host.md`.

**Q: `/masterplan stats` shows duplicated `parent_turn` counts.**
A: Fixed in the patch release immediately before v5.8.0. Upgrade or deduplicate pre-patch `subagents.jsonl` by `ts+session_id` when querying historical data.

## Versioning, contributing, links

Semantic versioning: **patch** for bug fixes and bundle maintenance, **minor** for additive event types / new doctor checks / new failure classes / new contracts, **major** reserved for breaking changes to `state.yml` schema or the verb router. Each release tags a single commit on `main`; see [`CHANGELOG.md`](./CHANGELOG.md) for per-version rationale.

- Design: [`docs/internals.md`](./docs/internals.md) — orchestrator architecture, subagent context-control, run-bundle state model
- Contracts: [`commands/masterplan-contracts.md`](./commands/masterplan-contracts.md), [`parts/contracts/run-bundle.md`](./parts/contracts/run-bundle.md), [`parts/contracts/cd-rules.md`](./parts/contracts/cd-rules.md)
- Verbs: [`docs/verbs.md`](./docs/verbs.md) · Config schema: [`docs/config-schema.md`](./docs/config-schema.md)
- Doctor checks: [`parts/doctor.md`](./parts/doctor.md) · Failure classes: [`parts/failure-classes.md`](./parts/failure-classes.md)
- License: [`LICENSE`](./LICENSE) (MIT) · Repository: <https://github.com/rasatpetabit/superpowers-masterplan>

LLMs working on this repo should start with [`CLAUDE.md`](./CLAUDE.md) — it pins the canonical reading order, anti-patterns, and operating principles for orchestrator-context work.
