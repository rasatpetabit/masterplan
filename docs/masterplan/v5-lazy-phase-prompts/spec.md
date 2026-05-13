# Spec: v5.0 Lazy-Load Phase Prompts

## Intent Anchor

The orchestrator prompt at `commands/masterplan.md` has grown to ~3000 lines / ~342KB. Every `/masterplan` invocation loads the entire file as system-prompt context. Because the user runs the command frequently in loops (`/loop /masterplan`, `ScheduleWakeup`, cron-driven audits) and crosses session boundaries (5-minute prompt-cache TTL, post-`/compact` resumes, fresh CLI sessions), the per-invocation cost compounds — both in tokens and in latency.

GPT-5.5 audit (2026-05-13) surfaced six findings:

1. **Prompt size at runtime** — phase content all sits in one file; nothing is loadable on demand.
2. **Step C re-reads** — full state.yml / spec.md / plan.md are re-read on each Step C turn instead of indexed.
3. **TaskCreate projection cost** — Claude-only one-to-one ledger mirror is net token/tool-call loss for plans with many tasks.
4. **state.yml handoff essays in scalars** — long narrative content lives in YAML scalars instead of overflow files, bloating state reads.
5. **`complexity: high` is too expensive as a built-in default** — cascades expensive knob settings across the run.
6. **Telemetry blind spot on parent tokens** — hook captures subagent token usage but not the orchestrator's parent-session usage.

v5.0 addresses all six. The headline change is **lazy-load phase prompts**: a thin router at `commands/masterplan.md` (~15KB) plus per-phase prompts under `parts/step-*.md` loaded on demand. Bundled fixes ship the same release.

## Architecture Overview

**Lazy-load model.** The router contains only verb dispatch, argument precedence, boot guards, Codex host detection, and the phase-prompt loader. When the router needs phase logic, it reads `parts/step-{current_phase}.md` based on `state.yml.current_phase`. Shared cross-phase rules live in `parts/contracts/*.md` and are loaded on demand by the active phase file.

**Cache behavior (load-bearing constraint).** Anthropic prompt cache TTL is 5 minutes. Savings are concentrated at **cache-miss boundaries** — cross-session resume, `/loop` wakeups crossing 5min idle, post-`/compact` resumes, fresh CLI sessions. Within a warm session, all subsequent reads after the first phase Read are cached, so intra-session savings flatten. The win is per cold-load: ~15KB router instead of ~342KB monolith, then one targeted phase load (~30–90KB) instead of the whole file.

**Net win surfaces:**
- `/loop /masterplan resume` (the hot loop) — every iteration past 5min TTL pays cold-load cost.
- Cron-driven recurring audits — each invocation is a fresh session.
- Cross-day resume after compact — common workflow.
- Status / doctor verbs — never load Step A/B/C body at all.

## Scope Boundary

**In scope:**

- File layout split: `commands/masterplan.md` (router, ~15KB) + `parts/step-{0,a,b,c}-*.md` + `parts/contracts/*.md` + `parts/codex-host.md` (conditional) + `docs/config-schema.md` (extracted) + `docs/verbs.md` (cheat sheet).
- plan.index.json (Full v5.0 schema): `idx`, `name`, `offset`, `lines`, `files`, `codex`, `parallel_group`, `verify_commands`, `spec_refs`. Built by `bin/masterplan-state.sh build-index <slug>`. Consumed by Step B3 (cross-link refs) and Step C (wave dispatch + verification).
- Plan-format change: structured `**Spec:**` and `**Verify:**` markers in plan.md tasks (required for build-index to extract).
- state.yml v5 schema: adds `current_phase`, `plan_hash`. Hard 200-char scalar cap with overflow to `handoff.md` / `blockers.md` and `*overflow at <file> L<n>*` pointer.
- TaskCreate projection threshold: default 15. Plans exceeding skip both projection AND per-state-write priming (currently fires at L1393). Configurable via `tasks.projection_threshold`.
- Complexity default flip: built-in default `high` → `medium`. User config wins. Doctor warns on explicit `high`.
- Parent-turn telemetry: `hooks/masterplan-telemetry.sh` emits one `parent_turn` JSONL record per turn from `transcript.where(type=="assistant").message.usage.*`. `bin/masterplan-routing-stats.sh` gains `--parent` flag.
- Codex host suppression preserved: `parts/codex-host.md` loaded conditionally; suppresses `codex:codex-rescue` companion dispatch when hosted by Codex.
- Migration: `bin/masterplan-state.sh migrate <slug>` (v4.x state.yml → v5.0), `migrate-plan <slug>` (best-effort wrap fenced bash → `**Verify:**`), `build-index <slug>` (regenerate index).
- New doctor checks #32–#36 (Warning, report-only).
- Self-host audit updates: per-phase-file checks for CC-3-trampoline, CD-9, DISPATCH-SITE, sentinel grep, plan-format conformance.
- `skills/masterplan/SKILL.md` updated in lockstep (Codex entrypoint).
- Plugin manifests bumped to 5.0.0 across `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (root + nested), `.codex-plugin/plugin.json`.
- `CHANGELOG.md` `## [5.0.0]` entry.
- Run bundle artifacts: spec.md (this file), plan.md, state.yml, retro.md, plan.index.json.
- Branch + commit + push to `origin/v5.0.0-lazy-phase-prompts`; local annotated tag `v5.0.0`.

**Out of scope (v5.x or v6 candidates):**

- Bash state-machine extraction (lift orchestrator state to a shell program). v6 candidate.
- Sub-step split (e.g., `parts/step-b/b0-clarify.md`). Deferred until a real load-pattern signal exists.
- Subagent context budgeting (orthogonal to lazy-load).
- routing-stats UI overhaul (text output sufficient for v5.0).
- Per-phase TaskCreate projection thresholds.
- Auto-fix logic for new doctor checks #32–#36 (report-only, like #30/#31).
- PR creation. Branch + tag + retro is the v5.0.0 deliverable; PR is user-authorized follow-up.

## File Layout

```
commands/
  masterplan.md ........ ~15K target / 20K hard ceiling (router)
parts/
  step-0.md ............ ~50K (bootstrap, verb dispatch helpers)
  step-a.md ............ ~30K (intake)
  step-b.md ............ ~80K (planning B0..B3)
  step-c.md ............ ~90K (execute: wave dispatch + verify + archive)
  contracts/
    agent-dispatch.md
    cd-rules.md
    taskcreate-projection.md
    run-bundle.md
  codex-host.md ........ conditional (loaded when hosted by Codex)
docs/
  verbs.md ............. cheat sheet (not a load target)
  config-schema.md ..... extracted from current ~187 lines
```

**Naming convention:** phase files are named `parts/step-<phase>.md` (one-letter or numeric phase identifier matching `state.yml.current_phase`). The router loader maps `current_phase` directly to filename: `parts/step-{current_phase}.md`. No lookup table needed. Descriptive purpose (bootstrap / intake / plan / execute) lives in `docs/verbs.md` and in the file's H1 heading.

`docs/verbs.md` — plain-markdown cheat sheet listing each verb (start, resume, status, doctor, import, archive, validate, retry) with one-line description, which phase file it routes through, and key flags. Intended for grep / onboarding; never loaded by the orchestrator.

Sizes are approximate targets; final sizes determined by content extraction. Router 15K is target, 20K is hard ceiling (doctor check #36 enforces).

## Router Contract

`commands/masterplan.md` (the router) is the only file always loaded. It MUST contain:

- Verb routing table (start, resume, status, doctor, import, archive, validate, retry).
- Argument precedence rules (CC-1 args-lock).
- Boot guards (CC-2 banner, CC-3-trampoline anchor).
- Codex host detection: if hosted by Codex (`/superpowers-masterplan:masterplan`), load `parts/codex-host.md`; otherwise skip.
- Phase-prompt loader: read `state.yml.current_phase`, load `parts/step-{current_phase}.md`.
- Doctor entry point: dispatch to per-check logic; check #36 verifies router ceiling.
- Pointer to `docs/config-schema.md` (loaded on validate verb only).

The router MUST NOT contain Step A/B/C logic, CD-rules verbatim, agent-dispatch contract, TaskCreate projection logic, or state.yml schema. Those live in phase files or contracts.

## Phase Prompt Contract

Each `parts/step-*.md` is self-contained for its phase. It:

- Loads `parts/contracts/*` on demand (typically once per phase entry).
- Emits DISPATCH-SITE tags scoped to its filename (e.g., `step-c.md:wave-1-dispatch`).
- Honors CC-3-trampoline: if it's an entry phase for resume, includes the anchor; doctor check #36 verifies.
- References CD-rules by ID; loads `parts/contracts/cd-rules.md` on first reference per turn.
- Calls into `bin/masterplan-state.sh` for state mutation (orchestrator is canonical writer per CD-7).

## Contracts Layout

- `parts/contracts/agent-dispatch.md` — subagent brief shape (Goal/Inputs/Scope/Constraints/Return), DISPATCH-SITE tagging convention, model-tier selection (Haiku/Sonnet/Opus per `~/.claude/refs/subagent-models.md`), Codex routing rules.
- `parts/contracts/cd-rules.md` — CD-1 .. CD-10 verbatim. Single source of truth.
- `parts/contracts/taskcreate-projection.md` — Claude-only projection layer + threshold logic + per-state-write priming logic (or skip when over threshold).
- `parts/contracts/run-bundle.md` — state.yml v5 schema, plan.index.json schema, overflow rules, `bin/masterplan-state.sh` invocation contract, build-index trigger.

## plan.index.json (Full v5.0 Schema)

```json
{
  "schema_version": "5.0",
  "plan_hash": "sha256:abc123...",
  "generated_at": "2026-05-13T12:34:56Z",
  "tasks": [
    {
      "idx": 1,
      "name": "Extract config schema",
      "offset": 142,
      "lines": 28,
      "files": ["docs/config-schema.md", "commands/masterplan.md"],
      "codex": false,
      "parallel_group": null,
      "verify_commands": [
        "test -f docs/config-schema.md",
        "grep -q schema_version docs/config-schema.md"
      ],
      "spec_refs": ["spec.md#L42-L67"]
    },
    {
      "idx": 2,
      "name": "Build parts/step-0.md",
      "offset": 170,
      "lines": 64,
      "files": ["parts/step-0.md"],
      "codex": false,
      "parallel_group": "wave-1",
      "verify_commands": ["test -f parts/step-0.md"],
      "spec_refs": ["spec.md#L78-L95"]
    }
  ]
}
```

- Built by: `bin/masterplan-state.sh build-index <slug>`.
- Trigger: `state.yml.plan_hash != sha256(plan.md)`. Computed lazily at Step B3 entry and Step C entry.
- Consumed by: Step B3 (cross-link refs back to spec), Step C wave dispatch (resolve `parallel_group` membership), Step C verification (run `verify_commands` per task).
- Stored alongside `state.yml` in the run bundle: `docs/masterplan/<slug>/plan.index.json`.

## Plan-Format Change (Required for Full v5.0)

Current plans put verify commands in fenced bash blocks (free-form) and spec refs in free text. v5.0 requires structured markers so `build-index` can extract. Example task block (using `~~~` outer fence so the inner triple-backtick bash fence renders intact):

~~~markdown
### Task 1: Extract config schema

**Files:** docs/config-schema.md, commands/masterplan.md
**Parallel-group:** none
**Codex:** false
**Spec:** [spec.md#L42-L67](spec.md#L42-L67), [spec.md#L102-L115](spec.md#L102-L115)
**Verify:**
```bash
test -f docs/config-schema.md
grep -q schema_version docs/config-schema.md
```

Task body / approach notes here…
~~~

- `writing-plans` skill (or the inline plan-emission template in Step B3) updated to emit `**Spec:**` and `**Verify:**` markers for every task.
- `bin/masterplan-state.sh migrate-plan <slug>`: best-effort. Scans plan.md for fenced bash blocks adjacent to task headings, wraps each with a `**Verify:**` label and prints a diff for review. Spec refs are NOT auto-rewritten — the tool warns "spec_refs missing on task N" and exits non-zero if any task is unannotated.
- Doctor check #35 enforces: warns when a v5.0 plan lacks `**Spec:**` or `**Verify:**` on any task.

## state.yml v5 Schema

```yaml
---
schema_version: "5.0"
slug: v5-lazy-phase-prompts
plan_hash: "sha256:abc123..."

current_phase: step-c
current_wave: 2
autonomy: loose
complexity: medium

tasks:
  - idx: 1
    status: complete
    started_at: "2026-05-13T12:00:00Z"
    completed_at: "2026-05-13T12:15:00Z"
  - idx: 2
    status: in_flight
    started_at: "2026-05-13T13:00:00Z"

handoff: "*overflow at handoff.md L1*"
blockers: []
recent_events:
  - "2026-05-13T13:05Z task-2 dispatched (wave-1)"
  - "2026-05-13T13:08Z task-1 complete (digest: abc...)"
```

- **Hard write-time rule:** any scalar > 200 chars rejected at write time by `bin/masterplan-state.sh`. Overflow moved to `<slug>/handoff.md` or `<slug>/blockers.md` with `*overflow at <file> L<n>*` pointer.
- `current_phase` enables router phase-prompt dispatch.
- `plan_hash` triggers plan.index.json regeneration when plan.md changes.
- Doctor check #32 verifies cap + pointer integrity.

## TaskCreate Projection Threshold

Default: `tasks.projection_threshold: 15`. Configurable in `~/.masterplan.yaml` or per-run config.

```
if len(plan.tasks) > 15:
    skip projection  (no TaskList mirroring of plan tasks)
    skip per-state-write priming  (current L1393 unconditional TaskUpdate)
    emit one TaskCreate at run start: "masterplan: <slug>"
    subsequent updates: state.yml only

if len(plan.tasks) <= 15:
    current behavior (projection + per-state-write priming)
```

Doctor check #33 warns on projection mode mismatch (e.g., ledger has stale entries from before the threshold was crossed).

## Complexity Default Flip

Built-in default in the router flips from `high` → `medium`. Resolution order unchanged:

1. Per-run `--complexity` flag (highest).
2. `~/.masterplan.yaml` `complexity` field.
3. Built-in default (`medium` post-v5.0).

Doctor emits a one-line note when explicit `high` is detected: "v5.0 lowered the built-in default to medium for cost reasons; explicit `high` is still supported — verify intent." Report-only.

## Parent-Turn Telemetry

`hooks/masterplan-telemetry.sh` adds a second emit pass:

- Iterates transcript entries `where type == "assistant"`.
- For each, extracts `message.usage.{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}`.
- Emits one `parent_turn` JSONL record per turn with: `ts`, `type="parent_turn"`, `session_id`, `model`, `verb`, `current_phase`, `current_wave`, `usage` (full object).

```json
{
  "ts": "2026-05-13T13:00:05Z",
  "type": "parent_turn",
  "session_id": "abc-123",
  "model": "opus-4-7",
  "verb": "resume",
  "current_phase": "step-c",
  "current_wave": 2,
  "usage": {
    "input_tokens": 12450,
    "output_tokens": 890,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 115200
  }
}
```

`bin/masterplan-routing-stats.sh --parent` splits parent vs subagent attribution in the report.

## Codex Host Suppression

`parts/codex-host.md` is loaded conditionally when the router detects it's hosted by Codex (slash command path resolves to `/superpowers-masterplan:masterplan`). Contents: suppresses `codex:codex-rescue` companion dispatch for that invocation to avoid recursive Codex → Codex calls. Persisted `codex.routing` / `codex.review` config remains in effect for Claude Code-hosted runs.

Doctor check (existing) extended to smoke-test from inside Codex during release verification.

## Self-Host Audit Updates

`bin/masterplan-self-host-audit.sh` gains per-phase-file checks (~100+ new bash lines):

- CC-3-trampoline anchor: present in router AND in entry phase files.
- CD-9 grep: across all `parts/step-*.md` and `parts/contracts/*.md`.
- DISPATCH-SITE tag presence: every phase file that dispatches subagents has scoped tags.
- Sentinel grep: no orphan refs to legacy v4.x file paths (e.g., string `commands/masterplan.md` referring to v4 Step C content).
- Plan-format wiring: doctor check #35 surface is wired through audit.

## SKILL.md Updates

`skills/masterplan/SKILL.md` (Codex entrypoint) updated in lockstep:

- References new file layout (router + parts/).
- References new doctor checks #32–#36.
- References v5.0 state.yml schema.
- References plan-format change.

## Migration & Compatibility

v5.0.0 is a **clean break** (per user direction). Migration tools handle existing run bundles:

- `bin/masterplan-state.sh migrate <slug>` — upgrades v4.x state.yml to v5.0 schema. Adds `current_phase` (inferred from existing fields), `plan_hash` (computed). Moves long handoff/blockers essays to `handoff.md`/`blockers.md` with overflow pointer. Preserves explicit `complexity: high`; flips unset → `medium`. Backs up to `state.yml.v4-backup` before rewrite. Idempotent.
- `bin/masterplan-state.sh migrate-plan <slug>` — best-effort plan-format migration (see Plan-Format Change above).
- `bin/masterplan-state.sh build-index <slug>` — regenerates plan.index.json after migration.
- Doctor on a v4.x run bundle: surfaces "v4.x state.yml detected — run `masterplan-state.sh migrate <slug>` to upgrade".

Plugin manifest version bump: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (root + nested), `.codex-plugin/plugin.json` → `5.0.0`.

## New Doctor Checks

| ID | Subject | Severity | Action |
|---|---|---|---|
| #32 | state.yml scalar length cap + overflow pointer integrity | Warning | Report-only |
| #33 | TaskCreate projection mode mismatch (config vs plan size vs ledger state) | Warning | Report-only |
| #34 | plan.index.json staleness (plan_hash drift) | Warning | Report-only |
| #35 | Plan-format conformance (`**Spec:**` + `**Verify:**` markers) | Warning | Report-only |
| #36 | parts/step-*.md presence + sanity (CC-3-trampoline anchor, DISPATCH-SITE tags, router ≤20KB) | Warning | Report-only |

Parallelization brief updated to include #32–#36 in the appropriate scope sets.

## Acceptance Criteria

1. `wc -c commands/masterplan.md` ≤ 20480 bytes after extraction. Phase content lives in `parts/step-*.md`.
2. Router contents match the Router Contract (verb dispatch + boot guards + Codex host detect + phase loader; no Step A/B/C logic). Verified by grep discriminators.
3. `bin/masterplan-state.sh build-index v5-lazy-phase-prompts` produces a valid `plan.index.json` conforming to Full v5.0 schema. `jq -e '.schema_version == "5.0"' plan.index.json` returns 0.
4. `bin/masterplan-state.sh migrate <test-fixture-v4-bundle>` produces a valid v5.0 state.yml with overflow pointers and `state.yml.v4-backup` present.
5. `~/.masterplan.yaml` with `complexity` unset reports `medium` as the effective value at boot (verified by `/masterplan status`).
6. `hooks/masterplan-telemetry.sh` emits at least one `parent_turn` JSONL record per turn (verified by running `/masterplan status` once and `jq 'select(.type == "parent_turn")' < session.jsonl` returning ≥1 entry).
7. `bin/masterplan-routing-stats.sh --parent` produces a parent-token split report (non-empty, includes both `parent_turn` and `subagent_turn` aggregates).
8. `bin/masterplan-self-host-audit.sh` passes against the new layout (CC-3-trampoline, CD-9, DISPATCH-SITE, sentinel, plan-format all green).
9. `/masterplan doctor` runs all 36 checks and returns no Errors against this run bundle.
10. `skills/masterplan/SKILL.md` updated; plugin manifests bumped to 5.0.0; `CHANGELOG.md` `## [5.0.0]` entry added.
11. Run bundle complete: spec.md (this file), plan.md (Full v5.0 format with `**Spec:**` + `**Verify:**` markers), state.yml (v5.0 schema), plan.index.json, retro.md.
12. Branch `v5.0.0-lazy-phase-prompts` pushed to origin; annotated local tag `v5.0.0` created.
13. Smoke run: `/masterplan resume` on this run bundle from a fresh CLI session loads router + active phase file only (verified by transcript inspection); does not load all four phase files.

## Risk Register

- **R1: Conditional contract loads cause cache-miss thrash.** If phase prompts reference `contracts/*` on every turn, the contract loads happen repeatedly across cold boundaries. *Mitigation:* phase prompts inline the rules they reference frequently (CD-rules summarized inline, full bodies in contract); contracts/* loaded only for cross-phase coordination work that genuinely needs the canonical version.
- **R2: Plan-format migration auto-converts wrong fenced bash blocks.** Some fenced bash blocks in v4.x plans are example code, not verify commands. *Mitigation:* `migrate-plan` is best-effort + warns on every conversion + prints a unified diff for user review before commit.
- **R3: writing-plans doesn't emit new markers.** If the skill body or the inline Step B3 plan-emission template is missed, new plans don't get verify/spec markers and doctor #35 warns on every fresh run. *Mitigation:* dogfood — v5.0's own plan.md must use the new format from day one; the writing-plans handoff includes an explicit post-emit check (`bin/masterplan-state.sh build-index <slug>` must succeed without `spec_refs missing` warnings) before brainstorming → writing-plans is considered complete.
- **R4: Cache savings overstated for warm sessions.** Intra-session, after first phase Read, subsequent reads are cached — savings flatten. *Mitigation:* spec explicitly states this (see Architecture Overview); marketing in CHANGELOG positions wins as cross-session / loop / post-compact, not "every turn faster."
- **R5: Per-turn parent_turn telemetry inflates JSONL size.** ~200 bytes per turn × many turns × many sessions. *Mitigation:* routing-stats supports tail-N filtering; the telemetry hook itself remains opt-in (no change to opt-in semantics).
- **R6: Codex host suppression regression.** A subtle conditional in the new `parts/codex-host.md` could re-enable `codex:codex-rescue` dispatch under Codex hosting, causing recursive Codex calls. *Mitigation:* doctor smoke check from inside Codex during release verification + acceptance criterion #6-adjacent smoke run.
- **R7: Schema migration corrupts existing v4.x run bundles.** `migrate` could mangle a v4.x state.yml in place. *Mitigation:* always back up to `state.yml.v4-backup` before rewriting; migrate is idempotent and verifiable by `diff state.yml.v4-backup state.yml` on re-run.
- **R8: Router ceiling drift.** As phases evolve, contributors may add inline router logic that grows the file past 20KB. *Mitigation:* doctor check #36 hard-fails (Warning) when router exceeds the ceiling; CI / pre-commit could lift to Error in v5.x.

## Dependencies + Assumptions

- **Branch base:** `v5.0.0-lazy-phase-prompts` branches from current main (HEAD at 4eedcfb, post-v4.2.1).
- **No prior v5 work.** Confirmed: `docs/masterplan/v5-lazy-phase-prompts/` did not exist before this spec.
- **Cache TTL:** Anthropic prompt cache TTL is 5 minutes (load-bearing for cost narrative). If TTL changes, the Architecture Overview's win surfaces need revisiting.
- **writing-plans skill scope.** v5.0 needs to update the skill body (or the inline plan-emission template in Step B3) to emit `**Spec:**` and `**Verify:**` markers. If the skill lives in a separate plugin (`obra/superpowers`), file an issue or propose a PR — fallback is the inline template path.
- **Telemetry hook is opt-in.** Users without the Stop hook installed won't get `parent_turn` records. Documented in CHANGELOG.
- **Doctor enforcement severity.** All new checks (#32–#36) ship Warning. Upgrade to Error is a v5.x decision after real-world signal.
