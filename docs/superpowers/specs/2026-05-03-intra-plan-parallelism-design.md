# Intra-plan task parallelism (Slice α — read-only parallel waves) — Design

**Slug:** `intra-plan-parallelism`
**Date:** 2026-05-03
**Status:** brainstorm complete; ready for plan
**Targets:** /masterplan v1.1.0
**Supersedes:** `docs/design/intra-plan-parallelism.md` (earlier deferred-design notes, retained as historical context).

---

## Background

Intra-plan task parallelism was deferred prior to v1.0.0. Earlier notes (`docs/design/intra-plan-parallelism.md`) sketched annotation schema (`parallel-group:`, `depends-on:`, `files:`), required machinery (per-task git worktree isolation, single-writer status file, per-task verification with rollback policy), and deferred the work because "the per-task worktree subsystem is a meaningful undertaking and warrants its own dedicated plan."

This spec is the result of a fresh-eyes re-evaluation triggered by `/masterplan revisit intra-plan task parallelism` immediately after the v1.0.0 stable public release. The brainstorm catalogued six v1.0.0-era failure modes (FM-1 through FM-6 below), did a depth-pass on candidate mitigations, and concluded that a substantially smaller slice — **read-only parallel waves only** — is shippable in days, ships value, and lands the supporting infrastructure that a future Slice β (parallel committing tasks) or Slice γ (full per-task worktree subsystem) can build on additively.

The key insight from the depth-pass: the central git-index-race problem from the prior notes is unchanged for committing work, but **read-only tasks (verification, inference, lint, type-check, doc-generation) sidestep it entirely**. Most of the supporting infrastructure (single-writer status funnel, scope-snapshot, files-filter) is reusable for the deferred slices.

---

## Failure-mode catalog (the canonical "why")

Six failure modes for parallel task execution under the v1.0.0 architecture. Slice α addresses or sidesteps all six; the deferred Slice β/γ inherits the addressed ones and re-grapples with the sidestepped ones.

### FM-1: Eligibility-cache invalidation under in-wave plan edits

A wave member edits `plan.md` mid-wave (e.g., adding a `**Codex:** ok` annotation to a sibling task). Step C step 1's `cache.mtime > plan.mtime` invariant is violated. Sibling tasks already in flight made routing decisions based on a now-stale cache.

**Old-design impact:** Not in prior notes — the eligibility cache didn't exist at the time.

**Slice α mitigation (M-2 + CD-2 scope rule):** Snapshot the eligibility cache at wave-start; pin it for the wave's duration; declare in-wave plan edits out-of-scope (CD-2: implementer subagents in a parallel wave may not modify `plan.md`, status file, or eligibility cache).

### FM-2: Activity log rotation race

A wave produces N concurrent appends to `## Activity log`. If `len(active_log) + N > 100`, the rotation step (move all but most recent 50 to `<slug>-status-archive.md`, insert marker) is non-atomic. Concurrent writes can lose or duplicate entries.

**Old-design impact:** Rotation didn't exist when prior notes were written. The "single-writer status file" requirement covered the family but didn't name this operation.

**Slice α mitigation (M-1 single-writer funnel):** Wave members return digests; do not write to status file directly. Orchestrator collects digests at wave-end and applies one batched update. Rotation fires once at end-of-batch (wave-aware), not mid-wave.

### FM-3: Status file write contention

Concurrent updates from N wave members race on `current_task` (single-pointer field), `last_activity`, `## Activity log` appends, `## Blockers` appends. Even with file locking, semantics break — `current_task` is single-valued, so whichever write lands last wins arbitrarily.

**Old-design impact:** Was in prior notes ("single-writer status file" requirement). v1.0.0 made it sharper: more state in the status file (`compact_loop_recommended`, `codex_routing`, `codex_review`, telemetry-related fields) means more contention surface. Requirement unchanged; cost of violation grew.

**Slice α mitigation (M-1):** Same single-writer funnel. `current_task` semantics: orchestrator computes it as "lowest-indexed not-yet-complete task" at wave-end. Telemetry attribution per-wave: `tasks_completed_this_turn: N` field added to the Stop hook (FM-3 sub-mitigation, see Section 6).

### FM-4: Codex routing per-task as a serializing sync point

A wave with mixed Codex-eligible and inline tasks can't usefully parallelize: Codex execution is out-of-process, concurrency limits depend on the user's Codex CLI / API rate limits. Step C 3a's per-task `AskUserQuestion(Accept / Reject)` under `gated` doesn't compose under N concurrent Codex executions. Step C 4b's per-task review subagents under wave dispatch hit the same Codex resource pool.

**Old-design impact:** Not in prior notes — Codex routing didn't exist. Prior notes assumed Claude inline only.

**Slice α mitigation (M-4 fall-out rule):** Codex-routed tasks (`**Codex:** ok`) are explicitly NOT parallel-eligible — they fall out of any wave they'd join and run in their own serial slot. Mutually exclusive with `**parallel-group:**`.

> **Research item (carries forward):** Codex's actual concurrency model is unverified. If `codex:codex-rescue` agents run truly concurrent without resource-pool constraints, FM-4 weakens substantially and a future slice could reconsider. Worth verifying via the `codex:setup` skill before committing to a Slice β/γ design that depends on this.

### FM-5: Worktree integrity check (Step C 4c) ambiguity

Step C 4c filters `git status --porcelain` against task-scope files. Under a parallel wave, after Task 1 completes, porcelain shows files from Tasks 2–5 (still in flight) as "unexpected." 4c either fires false positives (every wave triggers human review) or gets skipped (loses CD-2 guarantee).

**Old-design impact:** Not in prior notes. The proposed `files: [...]` task annotation was meant to address this but the integration with 4c wasn't spelled out.

**Slice α mitigation (M-3 files-filter):** Per-task `**Files:**` block becomes exhaustive scope for parallel-eligible tasks. 4c filters porcelain against the **union** of all in-flight wave members' declared files (post-glob-expansion). Implicit-paths whitelist (status file, eligibility cache, archive file, telemetry file, `.git/`) added to the union. Files outside ALL declared scopes remain real CD-2 violations.

### FM-6: Upstream `superpowers:subagent-driven-development` is structurally serial

SDD's per-task loop is `dispatch → wait → process digest → loop` — no parallel-dispatch primitive. Bypassing SDD entirely (using `Agent` directly) loses TDD discipline + commit conventions + escalation handling. Modifying SDD upstream is cross-plugin coordination cost (superpowers is `obra/superpowers`).

**Old-design impact:** Partially in prior notes (per-task git worktree isolation framing implies this). Sharper now: SDD is a concrete shipping skill with a stable contract.

**Slice α mitigation (M-4a SDD wrapper, restricted to non-committing work):** /masterplan's wave-dispatch layer dispatches N concurrent SDD invocations via the `Agent` tool. Each SDD instance runs serial within itself; /masterplan's wrapper waits for all to return. **Critical constraint:** wave members do not commit (Section 3 per-instance brief enforces this). This sidesteps the central git-index-race because no concurrent commits happen.

> **Depth-pass correction:** The original catalog claimed the SDD wrapper alone was sufficient. The depth-pass found this was wrong for committing work — concurrent commits to the same branch race the git index even with the wrapper. The wrapper is sufficient ONLY for non-committing work. Slice β/γ inherits the unsolved committing-work problem; per-task git worktrees (the original deferred subsystem) is the cheapest known mitigation, ~10-15 days.

---

## Scope

**In scope (Slice α — v1.1.0):**

- Plan annotation: `parallel-group: <name>` per task; existing `**Files:**` block becomes exhaustive scope when `parallel-group:` is set.
- Eligibility cache extension: `parallel_eligible: bool` per task, computed from the eligibility rules in Section 2.
- Wave dispatch in Step C step 2: pre-pass that groups parallel-eligible tasks; parallel `Agent` dispatch; wave-completion barrier.
- Single-writer wave-end status update (Step C 4d): batched application of all wave members' digests.
- Wave-aware activity log rotation (Step C 4d): rotates once at end-of-batch, not mid-wave.
- Files-filter for Step C 4c: union of in-flight wave members' declared scopes.
- Failure handling: per-member outcomes (completed / blocked / protocol_violation), wave-level outcomes (all completed / all blocked / partial), blocker re-engagement gate fires once at wave-end with the union of blockers.
- Idempotent mid-wave-interruption recovery (read-only by design).
- Three new doctor checks (#15, #16, #17 — total 17).
- Telemetry attribution: two new fields in the Stop hook (`tasks_completed_this_turn`, `wave_groups`).
- Config schema additions: `parallelism: {enabled, max_wave_size, abort_wave_on_protocol_violation}`.
- New CLI flag: `--no-parallelism`.
- `superpowers:writing-plans` brief update (Step B2): one paragraph guidance for the planner.
- Major revision of `docs/design/intra-plan-parallelism.md` to reference this spec + the failure-mode catalog + the sharpened revisit trigger.

**Out of scope (deferred to Slice β / Slice γ — v1.x or v2.0.0):**

- Parallel committing work (implementation tasks that produce git commits).
- Per-task git worktree subsystem (the original deferred design's central machinery).
- Codex-routed tasks inside waves (Codex falls out of waves; runs serial).
- `depends-on:` DAG-style task ordering (not needed for read-only waves; deferred to slices with cross-task dependencies).
- Auto-detection of "obvious" parallel-friendly patterns without explicit `parallel-group:` annotation.
- Plan-task reordering to maximize wave size (plan-order is authoritative).
- Cross-worktree parallel waves (single-worktree, single-branch only).
- Wave dispatch under `--no-subagents` mode (the subagent dispatch IS the mechanism).
- Doctor check candidate that scans for the Slice β/γ revisit trigger condition (sharpened trigger documented in Section 5; doctor check is a follow-up for v1.1.x).

---

## Design

### Section 1: Architecture overview

A read-only parallel-wave dispatch primitive for Step C of /masterplan's plan-execution loop. When a plan declares mutually-independent verification, inference, lint, type-check, or doc-generation tasks via `parallel-group:` annotations, /masterplan dispatches them as a single concurrent wave instead of serial per-task execution. Implementation tasks (anything that commits) continue to run serially under the existing per-task Step C loop.

**Where it lives in /masterplan.** Inside Step C step 2 (per-task implementation dispatch). Today it's a serial loop calling `superpowers:subagent-driven-development` once per task. Gains a wave-detection pre-pass that groups parallel-eligible tasks. Each wave dispatches as N concurrent SDD invocations via the `Agent` tool. After a wave completes (barrier wait), the orchestrator applies a single batched Step C 4d update covering all wave members.

**v1.x roadmap slot.** v1.0.0 just shipped (2026-05-03). This is the first feature-pass on the v1.x track. Targets v1.1.0 — additive, no breaking changes to existing plans, status files, or skills. Plans authored before this lands fall back to serial execution naturally (no `parallel-group:` declarations means no waves).

**Honest deferral framing.** This slice doesn't unlock parallel *implementation* execution, which is what most readers will assume "intra-plan parallelism" means. The CHANGELOG, README, and updated `docs/design/intra-plan-parallelism.md` must call this out clearly so users don't expect a TDD-implementation latency win from v1.1.0.

### Section 2: Plan annotation schema

`parallel-group: <name>` lives alongside the existing `**Codex:**` annotation in each task's `**Files:**` block. Tasks sharing the same `parallel-group:` name dispatch as one wave. Names are arbitrary string identifiers (suggested convention: thematic — `verification`, `lint-pass`, `inference-batch`). Missing annotation → serial; not part of any wave (backwards-compatible default).

Concrete syntax:

```markdown
### Task 4: Run lint pass on src/auth/

**Files:**
- Lint: src/auth/*.py

**Codex:** no
**parallel-group:** verification
```

The existing `**Files:**` block (already lists Create/Modify/Test/Lint paths in /masterplan-authored plans) is repurposed: when `parallel-group:` is set, the file paths there are treated as the **exhaustive scope** of the task. The task may not read or modify any path outside this list (FM-5 mitigation). Glob support (`src/auth/*.py`). Tasks **without** `parallel-group:` retain the current informational treatment of `**Files:**` — no breaking change.

**Eligibility rules (computed by the eligibility cache builder Haiku at Step C step 1).** A task is parallel-eligible if ALL of:

1. `parallel-group:` is set.
2. `**Files:**` block is present and non-empty.
3. Task is **non-committing** — declared scope is read-only OR write-to-gitignored-paths only (`coverage/`, `.tsbuildinfo`, `dist/`, etc.). Heuristic: no Create/Modify paths under tracked dirs. Edge case: a task that writes to a tracked path but doesn't intend to commit requires explicit `**non-committing: true**` override.
4. `**Codex:**` is NOT `ok` (FM-4 mitigation).
5. No file-path overlap with any other task in the same `parallel-group:`. Cache-build-time check. Overlap → drop the offending tasks from the wave (run serially) and append a `## Notes` warning.

### Section 3: Wave dispatch flow

The flow inserts as a pre-pass inside Step C step 2. When the eligibility cache identifies parallel-eligible tasks, Step C step 2 enters wave-mode; serial tasks before/after the wave run unchanged.

**Wave assembly (Step C step 2 pre-pass).**

1. Read upcoming task pointer from status file.
2. Walk forward in plan-order. Collect contiguous tasks with the SAME `parallel-group:` value into a wave candidate. Stop at the first task that either has a different `parallel-group:`, has no `parallel-group:`, or fails any eligibility rule.
3. Wave size: ≥ 2 tasks, capped at `config.parallelism.max_wave_size` (default `5`). Tasks beyond cap roll into the next wave.
4. Edge case: wave candidate of size 1 → execute serially.
5. **Interleaved groups do not parallelize.** If the plan has Task 5 (`parallel-group: A`), Task 6 (`parallel-group: B`), Task 7 (`parallel-group: A`), the contiguous-walk rule produces three single-task wave candidates (5, 6, 7), all of which fall back to serial per the size-1 edge case. Plan-order is authoritative; the planner is responsible for ordering parallel-grouped tasks contiguously to enable wave dispatch. The doctor `--fix` candidate (deferred) could surface this as a Warning to the author; not in v1.1.0 scope.

**Eligibility cache pin (M-2).** At wave-start, set `cache_pinned_for_wave: true` in orchestrator memory; mtime invariant suppressed for the wave's duration. Wave-end clears the pin and re-checks; rebuild fires if the user (not an implementer) edited plan.md mid-wave.

**Per-instance bounded brief.** Each SDD instance receives the standard implementer brief plus three wave-specific clauses:

> *"WAVE CONTEXT: You are dispatched as part of a parallel wave of N tasks (group: `<name>`). Your declared scope is `**Files:**` (exhaustive — do not read or modify anything outside this list, including plan.md, status file, or sibling tasks' scopes). Capture `git rev-parse HEAD` BEFORE any work; return as `task_start_sha` (required per existing implementer-return contract). DO NOT commit your work — return staged-changes digest only. DO NOT update the status file — orchestrator handles batched wave-end updates. Failure handling: if you BLOCK or NEEDS_CONTEXT, return immediately; orchestrator's blocker re-engagement gate handles you alongside the rest of the wave."*

> *"Return shape: `{task_idx, status: completed|blocked, task_start_sha, files_changed: [paths], staged_changes_digest: 1-3 lines, tests_passed: bool, commands_run: [str], blocker_reason?: str}`. NO commits. NO status file writes. (The orchestrator's post-barrier reconciliation may reclassify `completed` to `protocol_violation` if it detects a commit, an out-of-scope write, or a status file modification — see Section 4 Per-member outcomes.)"*

This is a stronger contract than the existing per-task SDD brief — wave implementers do not commit. For Slice α (read-only waves), implementers typically run verification commands not generating diffs, so "no commits" is naturally enforced; `files_changed: []` is usually empty.

**Parallel dispatch.** Issue all N SDD invocations as parallel `Agent` tool calls in a single assistant turn (existing pattern in Step I3.2/I3.4). The harness's parallel-dispatch model handles concurrency; if rate-limited, dispatched agents queue rather than fail.

**Wave-completion barrier.** Orchestrator waits for all N Agent calls to return before proceeding. Returns aggregate as a digest list.

**Step C 4a (verification) under wave.** Each task's verification ran inside its SDD instance per the implementer-return trust contract. Orchestrator reads `tests_passed` + `commands_run` per-task. Step 4a's complementary-command check fires per-task; additional verifiers batch as one parallel Bash batch.

**Step C 4c (worktree integrity) under wave.** Compute the union of all wave-task `**Files:**` declarations (post-glob-expansion). Run `git status --porcelain` once at wave-end. Filter: files matching the union are expected; files outside ALL declared scopes are CD-2 violations — surface to user. Implicit-paths whitelist (status file, eligibility cache, archive file, telemetry file, `.git/`) added to the union.

**Step C 4d (status file update) under wave — single-writer funnel.**

1. Aggregate digest list. Compute `current_task` = lowest-indexed not-yet-complete task in the plan.
2. Append N entries to `## Activity log` in plan-order. Each entry tags routing as `[inline][wave: <group>]`, includes verification result, references `task_start_sha`. (No completion SHA for read-only tasks — they don't commit.)
3. Activity log rotation pre-check: if `len(active_log) + N > 100`, rotate ONCE at end of batch append (wave-aware per FM-2).
4. Update `last_activity` to wave-completion timestamp.
5. Append `## Notes` entries for any partial-failure context.
6. Single git commit for the status file update: `masterplan: wave complete (group: <name>, N tasks)`.

**Step C 5 (wakeup scheduling) under wave.** Currently fires after every 3 completed tasks. Under wave: a wave-end counts as ONE completion (so a wave of 5 doesn't trigger 5 wakeups). The "every 3 completed tasks" threshold uses wave count, not task count.

### Section 4: Failure handling

Wave failures are richer than serial failures because partial outcomes are possible.

**Per-member outcomes.** Two are returned by the SDD instance, one is detected by the orchestrator:
- `completed` — returned by SDD instance: task succeeded; verification passed; staged-changes digest captured.
- `blocked` — returned by SDD instance: task hit a blocker; reason returned.
- `protocol_violation` — **detected by the orchestrator post-return** (not returned by SDD itself). The orchestrator runs `git status --porcelain` and `git log <task_start_sha>..HEAD` after the wave-completion barrier; if a wave member committed despite "DO NOT commit", wrote outside its `**Files:**` scope, or modified the status file directly, the orchestrator reclassifies the SDD-reported outcome as `protocol_violation`. Treated as blocked + flagged for manual review.

**Wave-level outcome.** Computed from per-member outcomes:
- **All completed** → wave succeeds. Single-writer 4d update applies all N completions. Status remains `in-progress` (or flips to `complete` if last task in plan).
- **All blocked** → wave fails. 4d update appends N blocker entries to `## Blockers`; status flips to `blocked`. Blocker re-engagement gate fires **once**, listing all N blocked tasks together.
- **Partial (K completed, N-K blocked)** → wave completes-with-blockers. 4d update appends K completed entries to `## Activity log` AND N-K blocker entries to `## Blockers`. Status flips to `blocked`. Blocker re-engagement gate fires once, listing the N-K blocked tasks.

**Blocker re-engagement gate integration.** Existing 4-option gate (Step C step 3, post-v1.0.0 audit) extends naturally:
- *"Provide context and re-dispatch"* → orchestrator collects free-text context once; re-dispatches all N-K blocked members in a new sub-wave.
- *"Re-dispatch with stronger model (Opus)"* → re-dispatch all N-K blocked members with Opus override.
- *"Skip and continue"* → all N-K blocked tasks get `## Blockers` entries; wave-count advances; status returns to `in-progress`.
- *"Set blocked and end turn"* → status remains `blocked`; orchestrator ends the turn.

The completed K tasks' digests are NOT discarded under any option in the **standard partial-failure case** — they're already applied by the single-writer 4d update **before** the gate fires. The protocol-violation case below is the documented exception.

**Protocol violation handling.** A wave member committing despite "DO NOT commit" is detected by the orchestrator's post-barrier reconciliation (see Per-member outcomes above). The committed work is preserved on the branch but not aggregated cleanly into the wave's batched 4d update.

If `config.parallelism.abort_wave_on_protocol_violation: true` (default), the orchestrator **suppresses the 4d batch entirely** — none of the K completed members' digests are applied to the status file (no rollback needed, since they were never applied). The wave is treated as fully blocked. The completed digests remain in orchestrator memory and become available to the gate's "Skip and continue" branch (which would re-apply them as `## Notes` entries when advancing past the wave).

Append a `## Notes` entry per CD-7: *"Protocol violation: task `<name>` committed `<commit-sha>` despite wave instruction. Verify manually before continuing — wave-end status update was suppressed."*

If `config.parallelism.abort_wave_on_protocol_violation: false`, the standard partial-failure path applies (K completed members' digests applied, N-K blocked entries appended including the violator).

**Mid-wave orchestrator interruption.** If the orchestrator crashes or context-resets mid-wave (after dispatch but before barrier returns), the next session enters Step C step 1 with status file showing `current_task = <first wave task>` (unchanged) and the eligibility cache file on disk (last persisted state, pre-wave).

**Resume semantics.** Re-enter Step C, re-build cache, re-dispatch the wave from scratch. **Idempotent by Slice α design**: each wave member is read-only, so re-dispatching is safe (no double-commits, no double-writes — only re-running verification commands). Lost transcripts from the interrupted session are inexpensive because read-only tasks are fast.

**Edge case: SDD escalates mid-wave.** When an SDD instance returns BLOCKED/NEEDS_CONTEXT *before* the wave-completion barrier, orchestrator does NOT immediately fire the blocker re-engagement gate — it waits for the rest of the wave. Gate fires once at wave-end with the union of all blocked members. Cleanest UX: one gate firing per wave.

### Section 5: Out-of-scope + deferred for v2

(See **Scope** above for the canonical list. This section captures the *why* and the sharpened revisit trigger.)

**Why these are deferred — the depth-pass realization.** The catalog implied "smallest slice ships in days" via the M-1/M-2/M-3/M-4 mitigation set. Depth-pass corrected M-4: the SDD wrapper alone doesn't address the central git-index-race for committing work. The cheapest path for committing work is the per-task git worktree subsystem (~10-15 days), which is the original deferred scope, sharper now.

**Sharpened revisit trigger for Slice β/γ:**

> *"Revisit Slice β when a real /masterplan plan shows ≥3 parallel-grouped committing tasks where the wave's serial wall-clock cost exceeds 10 minutes AND the committed work is independent enough for the Slice α `**Files:**` exhaustive-scope rule to apply. Revisit Slice γ when ≥3 such β-eligible waves accumulate within a single plan's lifecycle, indicating a structural pattern that warrants the full per-task worktree subsystem."*

Doctor check candidate (deferred to v1.1.x): scan completed-and-recent plans for the trigger condition; surface as a one-line note in `/masterplan status`.

**Why ship Slice α even if no current plan exercises it.**

1. **Annotation availability changes plan-authoring behavior.** Without `parallel-group:` available, the `superpowers:writing-plans` skill (briefed by /masterplan Step B2) doesn't think in terms of parallel-friendly task structure. With it available — and Step B2's brief explicitly mentioning verification/inference/lint as parallel-friendly — new plans may naturally surface parallel groups. Trigger may fire faster post-shipment than pre-shipment.
2. **Infrastructure-on-the-shelf for Slice β/γ.** Single-writer funnel, scope-snapshot, files-filter, wave-aware activity log rotation — all reusable for Slice β/γ when (if) implemented. The expensive piece deferred (per-task worktree subsystem) becomes a smaller incremental cost on top.

### Section 6: Migration + integration

**Existing plans behave unchanged.** Plans authored before v1.1.0 have no `parallel-group:` annotations. Step C step 1's eligibility cache builder treats their tasks as serial-only. Step C step 2 wave-detection finds no waves, falls through to the existing serial loop. Status file format unchanged. No migration script needed.

**`superpowers:writing-plans` brief update (Step B2).** Adds one paragraph to the bounded brief:

> *"When you identify mutually-independent verification, inference, lint, type-check, or doc-generation tasks, group them with `parallel-group: <thematic-name>` (e.g. `verification`, `lint-pass`, `inference-batch`). Each parallel-grouped task MUST have a complete `**Files:**` block declaring its exhaustive scope. Codex-eligible tasks (those you'd mark `**Codex:** ok`) should NOT be parallel-grouped — they fall out of waves at dispatch time. Use `parallel-group:` for tasks that are read-only or write to gitignored paths only (no commits)."*

**Status file schema.** No new required frontmatter fields. Activity log entry format gains an optional `[wave: <group>]` tag for wave-completed tasks.

**Eligibility cache JSON schema.** Per-task record extends with three new optional fields (`parallel_group`, `files`, `parallel_eligible`, plus `parallel_eligibility_reason`). Cache files lacking these fields are valid; load as `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today.

**Doctor checks (3 new, total 14 → 17).** Step D parallelization brief updates from "all 14 checks" to "all 17 checks":

| # | Check | Severity |
|---|---|---|
| 15 | `parallel-group:` set but `**Files:**` block missing/empty (eligibility rule 2 violated) | Warning |
| 16 | `parallel-group:` and `**Codex:** ok` both set on the same task (FM-4 conflict) | Warning |
| 17 | File-path overlap detected within a `parallel-group:` (eligibility rule 5 violated) | Warning |

These are informational — Step C step 1 catches violations and degrades gracefully to serial; doctor surfaces them early.

**Telemetry attribution (FM-3 sub-mitigation).** `hooks/masterplan-telemetry.sh` gains two new fields: `tasks_completed_this_turn: int` (1 for serial, N for wave) and `wave_groups: [str]` (array of wave-group names dispatched this turn, empty for serial). Backward-compatible: existing telemetry consumers ignore unknown fields. `docs/design/telemetry-signals.md` updated with the new fields + a `jq` example for "average tasks-per-wave-turn."

**Step C 4b (Codex review of inline work) under wave.** Skipped entirely for wave members — wave members don't commit, so the diff range `<task_start_sha>..HEAD` is empty. 4b's existing skip-on-zero-commit branch (per the v1.0.0 audit fix B4) handles this naturally — no new code.

**Config schema additions.** New top-level `parallelism:` block in `.masterplan.yaml`:

```yaml
parallelism:
  enabled: true                              # off | on — global kill switch
  max_wave_size: 5                           # cap on concurrent Agent dispatches per wave
  abort_wave_on_protocol_violation: true     # if true, protocol violations always block the wave-end update
```

Backward-compatible.

**New CLI flag.** `--no-parallelism` (shorthand for `--parallelism=off`). Useful for debugging.

**Status file `## Notes` audit trail.** When the orchestrator detects an eligibility-rule violation at cache-build time (e.g., file overlap within a group), append a `## Notes` entry: *"Parallel-group `<name>` had file overlap between tasks `<n1>` and `<n2>`; both tasks dropped from the wave and run serially. Consider splitting the group or adjusting `**Files:**` scopes."*

---

## Acceptance criteria

A v1.1.0 release is ready when ALL of the following hold:

1. `commands/masterplan.md` Step C step 2 has a wave-detection pre-pass that groups parallel-eligible tasks per the eligibility rules in Section 2.
2. `commands/masterplan.md` Step C step 1's eligibility cache builder Haiku brief is updated to compute `parallel_eligible` per task.
3. `commands/masterplan.md` Step B2's `superpowers:writing-plans` brief has the new paragraph from Section 6.
4. `commands/masterplan.md` Step C 4d is the single writer for status updates during waves; per-instance briefs forbid wave members from writing to status file or committing.
5. `commands/masterplan.md` Step C 4c filters porcelain against the union of wave members' declared scopes during wave operations.
6. `commands/masterplan.md` Step C 5's wakeup-scheduling threshold uses wave count, not task count.
7. `commands/masterplan.md` Step D's parallelization brief updates "all 14 checks" → "all 17 checks" and the checks table includes #15, #16, #17.
8. `hooks/masterplan-telemetry.sh` emits `tasks_completed_this_turn` and `wave_groups` fields.
9. `docs/design/telemetry-signals.md` documents the new telemetry fields.
10. `.masterplan.yaml` schema documentation in `commands/masterplan.md` includes the new `parallelism:` block.
11. `docs/design/intra-plan-parallelism.md` is rewritten to reference this spec, the failure-mode catalog, and the sharpened revisit trigger.
12. README.md updated: "Phase verbs" / "Operation verbs" sections in "What you get" mention `parallel-group:` annotation as a v1.1.0 addition; "Plan annotations" section gains a `**parallel-group:**` entry alongside `**Codex:**`.
13. CHANGELOG.md `[1.1.0]` block documents the additive change with the failure-mode catalog as the canonical "why."
14. `plugin.json` version bumped to `1.1.0`.
15. WORKLOG.md gains a v1.1.0 entry.
16. Smoke verification: a hand-crafted test plan with 3 parallel-eligible verification tasks dispatches them concurrently in Step C, applies a single batched 4d update, and surfaces the wave-tag in the activity log. Doctor lint passes on the test plan. The test plan can be discarded after verification.

The verification is hand-crafted because /masterplan has no automated test suite (the orchestrator is markdown). Future v1.x candidate: canned-`$ARGUMENTS` self-test specs in `docs/superpowers/specs/` exercising every routing branch — would catch wave-detection drift.

---

## Open questions / unknowns

1. **Codex concurrency model verification.** FM-4's mitigation (Codex falls out of waves) is conservative because Codex's actual concurrency limits are unverified. If Codex CLI / API supports N concurrent executions cleanly, a future slice could allow Codex tasks in waves with a serialized review-gate funnel. Action item: verify via `codex:setup` or codex CLI docs before designing Slice β/γ. **Not a Slice α blocker.**
2. **Agent tool concurrency limits.** Dispatching N parallel `Agent` calls from a single assistant turn — does the Claude Code harness rate-limit, queue, or fail? Slice α's `max_wave_size: 5` default is a guess. Smoke-test on a real wave during the plan-execute phase to confirm. May need adjustment in v1.1.0 plan tasks.
3. **`tasks_completed_this_turn` derivation.** The Stop hook reads `activity_log_entries` count from the status file at Stop time. `tasks_completed_this_turn` derives from the delta vs the previous Stop record. Edge case: if the previous Stop record doesn't exist (first turn), the field reports the absolute count rather than the delta. Acceptable: documented as "first-turn caveat" in `telemetry-signals.md`.
4. **Wave dispatch under `--codex=off`.** If Codex routing is globally off, the eligibility rule 4 (`**Codex:**` not `ok`) is trivially satisfied for every task. All other rules still apply. Behavior should be: parallelism works as designed. No special-case handling needed.
5. **Wave dispatch under `--autonomy=gated`.** The `gated` mode's per-task `AskUserQuestion(continue / skip / stop)` gate currently fires per-task. Under wave, the gate would fire **once at wave-start** with the wave's task list shown (4 options remain: continue all / skip wave / stop after wave / stop now). Spec needs to confirm this UX detail. Documented as a follow-up clarification for the implementation plan.

---

## Implementation plan handoff

Per /masterplan's Step B2/B3 flow, this spec hands off to `superpowers:writing-plans` for plan generation. The plan will be written to `docs/superpowers/plans/2026-05-03-intra-plan-parallelism.md` with sibling status file at `docs/superpowers/plans/2026-05-03-intra-plan-parallelism-status.md`.

Status file frontmatter at handoff:
- `worktree:` will record `main` (per the user's choice during /masterplan Step B0).
- `branch:` will record `main`.
- Future `/masterplan execute` will need to either (a) reconcile main-as-worktree (SDD will refuse), or (b) relocate the plan into a feature worktree first via the post-plan close-out gate's "Open plan to review" → user-led handoff path.

The brainstorm halts at /masterplan's Step B3 close-out gate (`halt_mode = post-plan`). The user can then choose: "Done — resume later" (recommended), "Start execution now" (will hit SDD's main-branch refusal — handle by relocating to a feature worktree first), "Open plan to review", or "Discard."

---

## Codex review note (pre-shipment)

The user added `--codex-review=on` to this /masterplan run. The flag persisted to status frontmatter at Step B3 (`codex_review: on`). When `/masterplan execute` eventually runs this plan, every inline-completed implementation task gets reviewed by `codex:codex-rescue` in REVIEW mode against this spec. Findings auto-accept under `gated` autonomy mode below severity `medium` (per the v1.0.0 default `codex.review_prompt_at: medium`). Higher-severity findings prompt with `Accept / Fix and re-review / Accept anyway / Stop`.

This is appropriate for v1.1.0: the infrastructure changes (single-writer funnel, eligibility cache extension, wave dispatch) are correctness-sensitive, and Codex-as-fresh-eyes review will catch implementation drift from the spec.
