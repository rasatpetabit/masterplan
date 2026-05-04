# Intra-plan task parallelism (Slice α — read-only parallel waves) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land Slice α of intra-plan task parallelism in /superflow v1.1.0 — read-only parallel waves only (verification, inference, lint, type-check, doc-generation). Implementation tasks remain serial; that's deferred to Slice β/γ per the spec.

**Architecture:** Markdown-only orchestrator (`commands/superflow.md`) gains a wave-detection pre-pass in Step C step 2, single-writer funnel in Step C 4d, files-filter in Step C 4c, and pinned eligibility cache in Step C step 1. Plus: bash hook (`hooks/superflow-telemetry.sh`) gains two new fields; design docs + README + CHANGELOG + WORKLOG bookkeeping; doctor gains 3 new checks; smoke-verified by hand-crafted test plan.

**Tech Stack:** No build system. Markdown + bash. Verification = `grep` discriminators + `bash -n` syntax check + manual smoke runs (matches v1.0.0 release pass convention).

---

## Notes for implementers

- **Implementation order matters.** Tasks 1–4 touch the Step C orchestration loop (step 1, step 2, 4-series, 5). Each must be done sequentially with the halt-mode discriminator suite re-grepped after each (per v1.0.0 audit convention): `grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md` — should produce no orphan references.
- **Smoke verification (Task 14) requires ALL preceding tasks complete.** Don't run it earlier.
- **Codex review is on for this plan.** The status file's `codex_review: on` was persisted at Step B3. When this plan executes, every inline-completed task gets reviewed by `codex:codex-rescue` against the spec. Findings auto-accept under `gated` autonomy below severity `medium` (default `codex.review_prompt_at: medium`); higher severity prompts.
- **Per-task `**Codex:** ok|no` annotations** below tell the eligibility cache whether to delegate to Codex during execute. Most tasks touching `commands/superflow.md` are `**Codex:** no` (cross-section invariants need awareness of the whole orchestrator). Bounded single-file tasks (hook, telemetry-signals.md, plugin.json bump) are `**Codex:** ok`.
- **Do NOT add `**parallel-group:**` annotations to tasks in THIS plan.** Meta-recursive: the spec being implemented introduces that annotation; it isn't recognized until v1.1.0 ships. Plans authored AFTER v1.1.0 ships can use it.
- **Smoke test fixture cleanup:** Task 14's hand-crafted test plan files (`docs/superpowers/specs/2026-05-03-test-parallel-wave-design.md`, `docs/superpowers/plans/2026-05-03-test-parallel-wave.md`, `docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md`) MUST be deleted before Task 14 commits, so the smoke artifacts don't ship in the v1.1.0 release.
- **Map to spec acceptance criteria.** The spec has 16 acceptance criteria. Task → criteria coverage (Task IDs map to criteria IDs in spec):
  - Task 1 → criteria 2 (eligibility cache builder Haiku brief)
  - Task 2 → criterion 1 (Step C step 2 wave-detection pre-pass)
  - Task 3 → criteria 4 (Step C 4d single writer + per-instance briefs), 5 (Step C 4c union-filter)
  - Task 4 → (failure handling — supports criteria 1, 4)
  - Task 5 → criterion 7 (Step D parallelization brief + new checks)
  - Task 6 → criterion 3 (Step B2 writing-plans brief)
  - Task 7 → (Step 0 flag — supports criterion 1, 10)
  - Task 8 → criterion 10 (config schema)
  - Task 9 → criterion 8 (telemetry hook)
  - Task 10 → criterion 9 (telemetry-signals.md)
  - Task 11 → criterion 11 (design doc rewrite)
  - Task 12 → criterion 12 (README updates)
  - Task 13 → criteria 13 (CHANGELOG), 14 (plugin.json), 15 (WORKLOG)
  - Task 14 → criterion 16 (smoke verification); also confirms criterion 6 (Step C 5 wave-count threshold) by observation
  - Task 4 also confirms criterion 6 indirectly (Step C 5 wave-count is part of the wave-completion flow)

---

## Task 1: Step C step 1 — extend eligibility cache for parallel-group support

**Files:**
- Modify: `commands/superflow.md` (Step C step 1 — eligibility cache section, ~lines 385–425)

**Codex:** no

**What this does.** Extends the eligibility cache schema with three new optional fields (`parallel_group`, `files`, `parallel_eligible`, `parallel_eligibility_reason`); updates the cache builder Haiku's bounded brief to compute these per the spec's eligibility rules; adds the `cache_pinned_for_wave` flag logic for M-2 mitigation; adds a CD-2 clause forbidding in-wave edits to plan/status/cache.

- [ ] **Step 1: Define grep discriminators (run BEFORE editing)**

```bash
# Negatives — should return current count; expect to drop after edit
grep -c 'parallel_eligible' commands/superflow.md
grep -c 'cache_pinned_for_wave' commands/superflow.md
grep -c 'parallel-group' commands/superflow.md
```

Expected: all return `0` initially.

- [ ] **Step 2: Read current Step C step 1 eligibility cache section**

```bash
sed -n '385,440p' commands/superflow.md
```

Expected: shows the current cache-load decision tree, JSON shape, and Haiku brief.

- [ ] **Step 3: Edit cache JSON shape doc to include new fields**

Find the `**Cache file shape**` block (around line 405–420). Edit to add three new optional fields:

Old (illustrative — find the actual block in the file):
```json
{
  "plan_path": "docs/superpowers/plans/<slug>.md",
  "plan_mtime_at_compute": "2026-05-01T14:32:00Z",
  "generated_at": "2026-05-01T14:32:01Z",
  "tasks": [
    {"idx": 1, "name": "...", "eligible": true,  "reason": "...", "annotated": null},
    {"idx": 2, "name": "...", "eligible": false, "reason": "...", "annotated": "no"}
  ]
}
```

New:
```json
{
  "plan_path": "docs/superpowers/plans/<slug>.md",
  "plan_mtime_at_compute": "2026-05-01T14:32:00Z",
  "generated_at": "2026-05-01T14:32:01Z",
  "tasks": [
    {"idx": 1, "name": "...", "eligible": true,  "reason": "...", "annotated": null,
     "parallel_group": null, "files": [], "parallel_eligible": false, "parallel_eligibility_reason": "no parallel-group annotation"},
    {"idx": 2, "name": "...", "eligible": false, "reason": "...", "annotated": "no",
     "parallel_group": "verification", "files": ["src/auth/*.py"], "parallel_eligible": true, "parallel_eligibility_reason": "all rules satisfied"}
  ]
}
```

Add a one-line note immediately below: *"Cache files lacking `parallel_group`/`files`/`parallel_eligible` (pre-v1.1.0 caches) are valid; load with `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today."*

- [ ] **Step 4: Edit the cache-builder Haiku bounded brief to compute parallel-eligibility**

Find the **Bounded brief for the Haiku** paragraph (around line 422). Update to:

> **Bounded brief for the Haiku** (when dispatched): Goal=apply the Step C 3a Codex eligibility checklist AND the Section 2 parallel-eligibility rules to each task; emit `{task_idx → {eligible, reason, annotated, parallel_group, files, parallel_eligible, parallel_eligibility_reason}}`. Inputs=full plan task list + plan annotations (`**Codex:**`, `**parallel-group:**`, `**Files:**` blocks, optional `**non-committing:**` override). Scope=read-only. Return=JSON only — no narration.
>
> **Parallel-eligibility rules** (apply per task; record `parallel_eligible: true` only when ALL hold):
> 1. `**parallel-group:** <name>` annotation is set.
> 2. `**Files:**` block is present and non-empty.
> 3. Task is non-committing — declared scope is read-only OR write-to-gitignored-paths only (`coverage/`, `.tsbuildinfo`, `dist/`, `build/`, `target/`, `out/`, `.next/`, `.nuxt/`, `node_modules/`, generated/codegen output dirs). Heuristic: no Create/Modify paths under tracked dirs. Edge case: explicit `**non-committing: true**` annotation overrides.
> 4. `**Codex:**` is NOT `ok` (FM-4 mitigation — Codex-routed tasks fall out of waves).
> 5. No file-path overlap with any other task in the same `parallel-group:`. Cache-build-time check across the parallel-group cohort.
>
> When a rule fails, set `parallel_eligible: false` and `parallel_eligibility_reason` to a one-line explanation citing the failing rule. Overlap (rule 5) emits the involved task indices in the reason.

- [ ] **Step 5: Add cache pin logic to Step C step 1**

Find the **Decision tree for cache load** paragraph (around line 395). Add a new paragraph immediately AFTER the decision tree:

> **Cache pin during parallel waves (M-2 mitigation).** Maintain an in-memory `cache_pinned_for_wave: bool` flag (default `false`). Set to `true` at the START of a parallel wave dispatch (Step C step 2 wave-mode entry). When `cache_pinned_for_wave == true`, the `cache.mtime > plan.mtime` invariant is suppressed — the loaded cache is reused for the wave's duration regardless of plan.md edits. Wave-end clears the pin (sets to `false`) and re-evaluates the invariant; cache rebuild fires if the user (not an implementer) edited plan.md mid-wave. Wave members are forbidden from editing plan.md per the new CD-2 clause below — see "In-wave scope rule" in **Operational rules**.

- [ ] **Step 6: Add CD-2 in-wave scope rule to Operational rules section**

Find the **Operational rules** section (around line 1050). Add a new bullet (anywhere in the existing list — placement not load-bearing):

> - **In-wave scope rule (FM-1 + FM-3 mitigation).** Wave members (implementer subagents dispatched as part of a parallel wave per Step C step 2) MUST NOT modify `plan.md`, the status file (`<slug>-status.md`), or the eligibility cache (`<slug>-eligibility-cache.json`). These files are orchestrator-canonical during a wave. Violating this constraint is a `protocol_violation` per Section 4 of the spec — the orchestrator detects it post-barrier and reclassifies the wave member's outcome.

- [ ] **Step 7: Verify with grep**

```bash
echo "=== Negative greps (should be 0; we want NEW occurrences only) ===" 
# (none for this task — fields are all-new)
echo "=== Positive greps (each ≥1) ==="
grep -c 'parallel_eligible' commands/superflow.md           # expect ≥3 (in JSON shape, brief, and somewhere else)
grep -c 'cache_pinned_for_wave' commands/superflow.md        # expect ≥1
grep -c 'parallel-group' commands/superflow.md               # expect ≥3 (brief mentions 3+ times)
grep -c 'parallel_eligibility_reason' commands/superflow.md  # expect ≥2
grep -c 'In-wave scope rule' commands/superflow.md           # expect 1
grep -c 'cache_pinned_for_wave == true' commands/superflow.md # expect 1
echo "=== Halt-mode discriminator suite (no orphans) ==="
grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md | wc -l
# Expected count unchanged from before this task (~22 references)
```

- [ ] **Step 8: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: extend eligibility cache for parallel-group annotations (v1.1.0 task 1)

Step C step 1 cache schema gains parallel_group, files,
parallel_eligible, parallel_eligibility_reason fields (optional;
backward-compatible with pre-v1.1.0 cache files).

Cache builder Haiku brief updated to compute parallel-eligibility
per spec Section 2 rules.

cache_pinned_for_wave flag added for M-2 mitigation
(suppress mtime invariant during wave).

New CD-2 in-wave scope rule added to Operational rules:
wave members may not modify plan.md, status file, or eligibility
cache (FM-1 + FM-3 mitigation).

Foundation for the wave-dispatch infrastructure in Task 2.
No behavior change for plans without parallel-group annotations.
EOF
)"
```

---

## Task 2: Step C step 2 — wave dispatch infrastructure

**Files:**
- Modify: `commands/superflow.md` (Step C step 2, ~lines 460–510 area)

**Codex:** no

**What this does.** Adds the wave-detection pre-pass to Step C step 2, builds the per-instance bounded brief (DO NOT commit, DO NOT update status), implements parallel Agent dispatch + wave-completion barrier. Does NOT yet integrate with 4d (that's Task 3) or failure handling (that's Task 4) — but the dispatch surface is in place. Without 4d, wave members complete and their digests sit in orchestrator memory until Task 3 ships the funnel; intermediate state is harmless because no plans have `parallel-group:` annotations yet (the activation only happens via Task 14's smoke fixture).

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'wave assembly' commands/superflow.md          # expect 0 → ≥1
grep -c 'wave-completion barrier' commands/superflow.md # expect 0 → ≥1
grep -c 'DO NOT commit' commands/superflow.md           # expect 0 → ≥1
grep -c 'WAVE CONTEXT' commands/superflow.md            # expect 0 → ≥1
grep -c 'max_wave_size' commands/superflow.md           # expect 0 → ≥2
```

- [ ] **Step 2: Read current Step C step 2 section**

```bash
sed -n '460,520p' commands/superflow.md
```

- [ ] **Step 3: Insert wave assembly pre-pass at Step C step 2**

Find the start of Step C step 2 ("If `--no-subagents` is set..."). Insert a new paragraph immediately BEFORE that line:

> **Wave assembly pre-pass (Slice α — Section 3 of spec `2026-05-03-intra-plan-parallelism-design.md`).** Before invoking the per-task implementer, scan the upcoming task list against the eligibility cache for parallel-eligible tasks (`parallel_eligible == true`). Walk forward in plan-order from `current_task`. Collect contiguous tasks with the SAME `parallel_group` value into a wave candidate. Stop at the first task that has a different `parallel_group`, has no `parallel_group`, or has `parallel_eligible == false`. Wave size: ≥ 2 tasks, capped at `config.parallelism.max_wave_size` (default `5`). Tasks beyond cap roll into the next wave. Edge case: wave candidate of size 1 → execute serially (fall through to standard per-task dispatch).
>
> **Interleaved groups do not parallelize.** If the plan has Task 5 (`parallel-group: A`), Task 6 (`parallel-group: B`), Task 7 (`parallel-group: A`), the contiguous-walk produces three single-task wave candidates (5, 6, 7) — all serial. Plan-order is authoritative; planner is responsible for ordering parallel-grouped tasks contiguously. Doctor `--fix` candidate to surface this is deferred to v1.1.x.
>
> **If config.parallelism.enabled == false** (global kill switch), skip wave assembly entirely and fall through to the standard serial loop.

- [ ] **Step 4: Add per-instance bounded brief block**

Immediately after the wave assembly paragraph, add the bounded brief specification:

> **Per-instance bounded brief (when wave assembled, ≥ 2 members).** Each SDD instance dispatched in the wave receives the standard implementer brief PLUS three wave-specific clauses:
>
> > *"WAVE CONTEXT: You are dispatched as part of a parallel wave of N tasks (group: `<name>`). Your declared scope is `**Files:**` (exhaustive — do not read or modify anything outside this list, including plan.md, status file, sibling tasks' scopes, or the eligibility cache). Capture `git rev-parse HEAD` BEFORE any work; return as `task_start_sha` (required per existing implementer-return contract). DO NOT commit your work — return staged-changes digest only. DO NOT update the status file — orchestrator handles batched wave-end updates. Failure handling: if you BLOCK or NEEDS_CONTEXT, return immediately; orchestrator's blocker re-engagement gate handles you alongside the rest of the wave."*
>
> > *"Return shape: `{task_idx, status: completed|blocked, task_start_sha, files_changed: [paths], staged_changes_digest: 1-3 lines, tests_passed: bool, commands_run: [str], blocker_reason?: str}`. NO commits. NO status file writes. (The orchestrator's post-barrier reconciliation may reclassify `completed` to `protocol_violation` if it detects a commit, an out-of-scope write, or a status file modification — see Section 4 of the spec.)"*
>
> This is a stronger contract than the existing per-task SDD brief. For Slice α (read-only waves), implementers typically run verification commands not generating diffs, so "no commits" is naturally enforced; `files_changed: []` is usually empty.

- [ ] **Step 5: Add parallel dispatch + barrier**

Immediately after the per-instance brief paragraph:

> **Parallel dispatch + wave-completion barrier.** Set `cache_pinned_for_wave: true` (per Step C step 1 cache pin). Issue all N SDD invocations as parallel `Agent` tool calls in a single assistant turn (existing pattern in Step I3.2/I3.4 — multiple Agent tool calls in one message). The harness's parallel-dispatch model handles concurrency; if rate-limited, dispatched agents queue rather than fail. The orchestrator waits for all N Agent calls to return before proceeding. Returns aggregate as a digest list `[{task_idx, status, task_start_sha, files_changed, staged_changes_digest, tests_passed, commands_run, blocker_reason?}]`. Only after the wave-completion barrier returns does the orchestrator proceed to Step C 4-series (4a/4b/4c/4d) for the wave (per Task 3 of this implementation plan). Wave-end clears `cache_pinned_for_wave` (sets to `false`).

- [ ] **Step 6: Verify with grep**

```bash
echo "=== Positive greps (each ≥1) ==="
grep -c 'wave assembly' commands/superflow.md
grep -c 'wave-completion barrier' commands/superflow.md
grep -c 'WAVE CONTEXT' commands/superflow.md
grep -c 'DO NOT commit' commands/superflow.md
grep -c 'DO NOT update the status file' commands/superflow.md
grep -c 'protocol_violation' commands/superflow.md
grep -c 'cache_pinned_for_wave: true' commands/superflow.md
grep -c 'parallel_group' commands/superflow.md  # expect ≥4 now
echo "=== Halt-mode discriminator suite ==="
grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md | wc -l
# Expected count unchanged
```

- [ ] **Step 7: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step C step 2 wave dispatch infrastructure (v1.1.0 task 2)

Adds wave-detection pre-pass to Step C step 2:
- contiguous-plan-order walk groups parallel_eligible tasks
- max_wave_size cap (default 5, from config.parallelism.max_wave_size)
- size-1 fallback to serial; interleaved groups don't parallelize
- config.parallelism.enabled kill switch

Adds per-instance bounded brief: WAVE CONTEXT clauses
(DO NOT commit, DO NOT update status, exhaustive Files: scope)
plus extended Return shape with protocol_violation
reclassification note.

Adds parallel Agent dispatch + wave-completion barrier with
cache_pinned_for_wave management.

Step C 4-series under wave still per-task (Task 3 ships the
single-writer funnel). Failure handling per-task (Task 4 ships
the per-member outcome reconciliation). No plans use
parallel-group yet, so no behavior change for existing plans.
EOF
)"
```

---

## Task 3: Step C 4-series under wave — single-writer funnel + union-filter

**Files:**
- Modify: `commands/superflow.md` (Step C 4a, 4b, 4c, 4d, ~lines 545–615 area)

**Codex:** no

**What this does.** Edits the Step C 4-series to handle wave dispatch: 4a (per-task verification trust contract still applies), 4b (skip wave members — they don't commit, no diff to review), 4c (union-filter for porcelain), 4d (single-writer batched update + wave-aware activity log rotation).

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'union of in-flight wave' commands/superflow.md   # expect 0 → 1
grep -c 'wave-aware rotation' commands/superflow.md       # expect 0 → 1
grep -c 'single-writer funnel' commands/superflow.md      # expect 0 → ≥1
grep -c 'wave: <group>' commands/superflow.md             # expect 0 → ≥1
grep -c 'lowest-indexed not-yet-complete' commands/superflow.md # expect 0 → 1
```

- [ ] **Step 2: Read current Step C 4-series**

```bash
sed -n '545,620p' commands/superflow.md
```

- [ ] **Step 3: Edit Step C 4a header to add wave-mode note**

Find the **4a — CD-3 verification** paragraph header. Add a one-line note at the END of the existing "Why" paragraph:

> *Under wave (Slice α): each wave member's verification ran inside its SDD instance per the implementer-return trust contract. The orchestrator reads `tests_passed` + `commands_run` per-task from each wave member's digest. The complementary-command check fires per-task; additional verifiers (lint, typecheck, etc. that the implementer didn't run) batch as one parallel Bash batch per the existing CD-3 parallelization rule. No semantic change from serial 4a — just operates on a wave's worth of digests.*

- [ ] **Step 4: Edit Step C 4b to add wave-skip note**

Find the **4b — Codex review of inline work** paragraph header. Add a new bullet to the "Fires when ALL of the following hold" list:

```
- The task just completed was NOT part of a parallel wave (wave members don't commit per Section 3 of spec; diff range is empty; existing zero-commit branch in step 1 handles this naturally — no new code).
```

- [ ] **Step 5: Edit Step C 4c to add union-filter under wave**

Find the **4c — Worktree integrity check** paragraph. Add a paragraph immediately AFTER the existing one:

> **Under wave (Slice α — Section 3 of spec).** Compute the union of all wave-task `**Files:**` declarations (post-glob-expansion). Run `git status --porcelain` once at wave-end. Filter: files matching the union are expected (they belong to a wave member); files outside ALL declared scopes are CD-2 violations — surface to user before continuing. Implicit-paths whitelist (`<slug>-status.md`, `<slug>-eligibility-cache.json`, `<slug>-status-archive.md`, `<slug>-telemetry.jsonl`, `.git/`) added to the union. The per-task per-wave-member 4c check is replaced by this single union-filter — runs once per wave, not N times.

- [ ] **Step 6: Edit Step C 4d to add single-writer funnel under wave**

Find the **4d — Status file update** paragraph. Add a paragraph immediately AFTER the existing rotation rule:

> **Under wave (Slice α — single-writer funnel, M-1/M-2/M-3 mitigations).**
>
> 1. **Aggregate digest list.** Collect all wave members' digests from the wave-completion barrier. Compute `current_task` = lowest-indexed not-yet-complete task in the plan (across the union of completed wave members + remaining serial tasks).
> 2. **Append N entries to `## Activity log` in plan-order** (NOT completion-order — predictable for human readers). Each entry tags routing as `[inline][wave: <group>]`, includes verification result from the digest, references `task_start_sha`. (No completion SHA for read-only tasks — they don't commit.)
> 3. **Activity log rotation pre-check (wave-aware per FM-2).** If `len(active_log) + N > 100`, rotate ONCE at the END of the batch append (not mid-batch). Move all but the most recent 50 entries to `<slug>-status-archive.md` (create if missing); insert the marker at the top of the active log; then append the N new wave entries.
> 4. **Update `last_activity`** to the wave-completion timestamp.
> 5. **Append `## Notes` entries for any partial-failure context** per Task 4's failure-handling rules (next task in this plan).
> 6. **Single git commit for the status file update** with subject `superflow: wave complete (group: <name>, N tasks)`.
>
> This single-writer funnel is the M-1 / M-3 mitigation. Wave members do NOT write to the status file directly (per the per-instance brief in Step C step 2). The orchestrator is the canonical writer. Activity log rotation is wave-aware — fires at most once per wave (not per task in the wave) per FM-2.

- [ ] **Step 7: Verify with grep**

```bash
echo "=== Positive greps ==="
grep -c 'union of in-flight wave\|union of all wave-task' commands/superflow.md
grep -c 'single-writer funnel' commands/superflow.md
grep -c 'wave: <group>' commands/superflow.md
grep -c 'lowest-indexed not-yet-complete' commands/superflow.md
grep -c 'plan-order (NOT completion-order' commands/superflow.md
grep -c 'wave-aware per FM-2' commands/superflow.md
grep -c 'NOT part of a parallel wave' commands/superflow.md
echo "=== Halt-mode discriminator suite ==="
grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md | wc -l
```

- [ ] **Step 8: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step C 4-series single-writer funnel under wave (v1.1.0 task 3)

4a: per-task verification trust contract still applies; orchestrator
reads tests_passed + commands_run per wave member's digest.

4b: skip wave members — they don't commit, so the diff range
<task_start_sha>..HEAD is empty; existing zero-commit branch handles
this naturally (no new code).

4c: union-filter under wave — single porcelain check at wave-end
filters against union of all wave-task Files: declarations
(post-glob-expansion) plus implicit-paths whitelist.

4d: single-writer funnel — orchestrator aggregates wave digests,
computes current_task as lowest-indexed not-yet-complete, appends
N entries to ## Activity log in plan-order with [wave: <group>]
tag, runs wave-aware activity log rotation (fires once per wave
per FM-2), commits status file once with subject
"superflow: wave complete (group: <name>, N tasks)".

Mitigations: M-1 (single-writer funnel), M-3 (files-filter),
FM-2 (wave-aware rotation).
EOF
)"
```

---

## Task 4: Failure handling under wave + Step C 5 wave-count threshold

**Files:**
- Modify: `commands/superflow.md` (Step C step 3 blocker re-engagement gate area, ~line 535–595; Step C step 5 wakeup scheduling, ~line 615)

**Codex:** no

**What this does.** Adds per-member outcome reconciliation (with `protocol_violation` detection), wave-level outcome computation, blocker re-engagement gate integration (fires once at wave-end with the union of blockers), `abort_wave_on_protocol_violation` config behavior, mid-wave interruption recovery semantics, and updates Step C 5's "every 3 completed tasks" threshold to use wave count.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'protocol_violation' commands/superflow.md           # expect ≥2 (already added in Task 2)
grep -c 'abort_wave_on_protocol_violation' commands/superflow.md  # expect 0 → ≥2
grep -c 'fires once at wave-end' commands/superflow.md       # expect 0 → 1
grep -c 'idempotent by Slice α design' commands/superflow.md # expect 0 → 1
grep -c 'wave-end counts as ONE completion' commands/superflow.md # expect 0 → 1
```

- [ ] **Step 2: Read current Step C step 3 + step 5 sections**

```bash
sed -n '535,600p' commands/superflow.md
sed -n '615,640p' commands/superflow.md
```

- [ ] **Step 3: Add per-member + wave-level outcome reconciliation paragraph after Step C step 3 blocker gate**

Find the end of the **Blocker re-engagement gate** definition (the `Activity log records which option was picked...` line). Insert a new sub-section IMMEDIATELY AFTER it:

> **Wave-mode failure handling (Slice α — Section 4 of spec).** When Step C step 2 dispatched a wave, blocker handling differs from serial:
>
> **Per-member outcomes.** Two are returned by SDD instances; one is detected by the orchestrator post-barrier:
>
> - `completed` — returned by SDD instance: task succeeded; verification passed; staged-changes digest captured.
> - `blocked` — returned by SDD instance: task hit a blocker; reason returned.
> - `protocol_violation` — **detected by orchestrator post-return** (not returned by SDD). After the wave-completion barrier, the orchestrator runs `git status --porcelain` and `git log <task_start_sha>..HEAD` per wave member; if a member committed despite "DO NOT commit", wrote outside its `**Files:**` scope, or modified the status file directly, the orchestrator reclassifies the SDD-reported outcome as `protocol_violation`. Treated as blocked + flagged for manual review.
>
> **Wave-level outcome.** Computed from per-member outcomes:
>
> - **All completed** → wave succeeds. Single-writer 4d update applies all N completions. Status remains `in-progress` (or flips to `complete` if last task in plan).
> - **All blocked** → wave fails. 4d update appends N blocker entries to `## Blockers`; status flips to `blocked`. Blocker re-engagement gate (above) fires ONCE, listing all N blocked tasks together. Each option's semantics extend naturally (Provide context: re-dispatch all N as a sub-wave; Stronger model: re-dispatch all N with Opus override; Skip: all N get `## Blockers` entries, wave-count advances; End turn: status remains `blocked`).
> - **Partial (K completed, N-K blocked, K ≥ 1, N-K ≥ 1)** → wave completes-with-blockers. 4d update appends K completed entries to `## Activity log` AND N-K blocker entries to `## Blockers`. Status flips to `blocked`. Blocker re-engagement gate fires once, listing the N-K blocked tasks. **The completed K tasks' digests are NOT discarded** — applied by the single-writer 4d update BEFORE the gate fires (standard partial-failure case).
>
> **Protocol violation handling.** If `config.parallelism.abort_wave_on_protocol_violation: true` (default), the orchestrator **suppresses the 4d batch entirely** when ANY wave member is reclassified as `protocol_violation` — none of the K completed members' digests are applied. Wave is treated as fully blocked; completed digests remain in orchestrator memory and become available to the gate's "Skip and continue" branch (which re-applies them as `## Notes` entries when advancing past the wave). Append a `## Notes` entry: *"Protocol violation: task `<name>` committed `<commit-sha>` despite wave instruction. Verify manually before continuing — wave-end status update was suppressed."*
>
> If `config.parallelism.abort_wave_on_protocol_violation: false`, the standard partial-failure path applies (K completed members' digests applied, N-K blocked entries appended including the violator).
>
> **Edge case: SDD escalates BLOCKED/NEEDS_CONTEXT mid-wave.** When an SDD instance returns BLOCKED/NEEDS_CONTEXT BEFORE the wave-completion barrier, the orchestrator does NOT immediately fire the blocker re-engagement gate — it waits for the rest of the wave. Gate fires once at wave-end with the union of all blocked members. Cleanest UX: one gate firing per wave, not N firings.
>
> **Mid-wave orchestrator interruption.** If the orchestrator crashes / context-resets after dispatch but before the barrier returns, the next session enters Step C step 1 with status file showing `current_task = <first wave task>` (unchanged — wave-end update never fired) and the eligibility cache file on disk (last persisted state, pre-wave). Resume semantics: re-enter Step C, re-build cache (mtime invariant kicks in since plan.md unchanged), re-dispatch the wave from scratch. **Idempotent by Slice α design**: each wave member is read-only, so re-dispatching is safe (no double-commits, no double-writes — only re-running verification commands, which are fast). Lost transcripts from the interrupted session are inexpensive.

- [ ] **Step 4: Update Step C 5 wakeup-scheduling threshold**

Find the **5. Cross-session loop scheduling** section. Find the line `Otherwise, after every 3 completed tasks, OR when context usage looks tight, call:`. Edit to:

> Otherwise, after every 3 completed tasks (where a wave-end counts as ONE completion regardless of N — so a wave of 5 doesn't trigger 5 wakeup-threshold increments), OR when context usage looks tight, call:

- [ ] **Step 5: Verify with grep**

```bash
echo "=== Positive greps ==="
grep -c 'protocol_violation' commands/superflow.md
grep -c 'abort_wave_on_protocol_violation' commands/superflow.md
grep -c 'fires once at wave-end' commands/superflow.md
grep -c 'wave-end counts as ONE completion' commands/superflow.md
grep -c 'Idempotent by Slice α design' commands/superflow.md
grep -c 'Wave-mode failure handling' commands/superflow.md
echo "=== Halt-mode discriminator suite ==="
grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md | wc -l
```

- [ ] **Step 6: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: wave failure handling + Step C 5 wave-count (v1.1.0 task 4)

Adds per-member outcome reconciliation:
  completed | blocked (returned by SDD)
  protocol_violation (detected by orchestrator post-barrier)

Wave-level outcomes: all-completed / all-blocked / partial.
Partial preserves K completed digests UNLESS
abort_wave_on_protocol_violation=true (default), in which case
the entire 4d batch is suppressed.

Blocker re-engagement gate fires ONCE at wave-end with the union
of N-K blocked members; option semantics extend naturally
(re-dispatch all blocked, skip all blocked, etc.).

Mid-wave interruption recovery: idempotent by Slice α design
(read-only members; resume re-dispatches the wave from scratch).

Step C 5 wakeup-scheduling threshold: a wave-end counts as ONE
completion regardless of N (a wave of 5 doesn't trigger 5
wakeup-threshold increments).
EOF
)"
```

---

## Task 5: Doctor checks #15-17 + parallelization brief count update

**Files:**
- Modify: `commands/superflow.md` (Step D — Doctor section, ~lines 850–880 area)

**Codex:** no

**What this does.** Adds three new doctor checks to Step D's table, updates the parallelization-brief Haiku count from "all 14 checks" → "all 17 checks". Doctor surfaces parallel-group annotation mistakes early to plan authors.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'all 14 checks' commands/superflow.md   # expect 1 → 0
grep -c 'all 17 checks' commands/superflow.md   # expect 0 → 1
grep -c '^| 15 |' commands/superflow.md         # expect 0 → 1
grep -c '^| 16 |' commands/superflow.md         # expect 0 → 1
grep -c '^| 17 |' commands/superflow.md         # expect 0 → 1
```

- [ ] **Step 2: Update parallelization brief**

Find the line in Step D containing `each agent runs all 14 checks for its worktree`. Edit:

Old: `each agent runs all 14 checks for its worktree`
New: `each agent runs all 17 checks for its worktree`

- [ ] **Step 3: Add three new check rows to the doctor checks table**

Find the existing checks table (rows 1–14). After the row for check 14 ("Orphan eligibility cache"), append three new rows:

```markdown
| 15 | **`parallel-group:` set but `**Files:**` block missing/empty.** Section 2 eligibility rule 2 violated. Affects parallel-eligibility computation. | Warning | Report only. Author must add `**Files:**` block. |
| 16 | **`parallel-group:` and `**Codex:** ok` both set on the same task.** Section 2 eligibility rule 4 violated; FM-4 mitigation conflict. | Warning | Report only. Author must remove one of the annotations. |
| 17 | **File-path overlap detected within a `parallel-group:`.** Section 2 eligibility rule 5 violated. Multiple tasks in the same parallel-group declare overlapping `**Files:**` paths. | Warning | Report the overlapping task pairs. No auto-fix. |
```

- [ ] **Step 4: Verify with grep**

```bash
echo "=== Negative greps ==="
grep -c 'all 14 checks' commands/superflow.md   # expect 0
echo "=== Positive greps ==="
grep -c 'all 17 checks' commands/superflow.md   # expect 1
grep -c '^| 15 | \*\*' commands/superflow.md    # expect 1
grep -c '^| 16 | \*\*' commands/superflow.md    # expect 1
grep -c '^| 17 | \*\*' commands/superflow.md    # expect 1
echo "=== Doctor table size sanity ==="
awk '/^### Checks/,/^### Auto-fix policy|^### Output/' commands/superflow.md | grep -cE '^\| [0-9]+ \|'
# expect 17
```

- [ ] **Step 5: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: doctor checks #15-17 for parallel-group annotations (v1.1.0 task 5)

3 new doctor checks added to Step D:
  #15: parallel-group set but Files: block missing/empty
  #16: parallel-group and Codex: ok both set (mutually exclusive)
  #17: file-path overlap within a parallel-group

All Warning severity (Step C step 1 catches violations and degrades
gracefully to serial; doctor surfaces them early to plan authors).

Step D parallelization-brief count: "all 14 checks" → "all 17 checks".

Doctor checks-count discriminator after this task should return 17
(matches the table size).
EOF
)"
```

---

## Task 6: Step B2 writing-plans brief update

**Files:**
- Modify: `commands/superflow.md` (Step B2 — Plan section, ~lines 470–490 area)

**Codex:** no

**What this does.** Adds the parallel-group authoring guidance paragraph to the bounded brief that /superflow's Step B2 sends to `superpowers:writing-plans`. The brief makes the planner aware of the new annotation so future plans (post-v1.1.0) can include it.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'parallel-group: <thematic-name>' commands/superflow.md  # expect 0 → 1
grep -c 'mutually-independent verification' commands/superflow.md # expect 0 → 1
```

- [ ] **Step 2: Read current Step B2 brief**

```bash
sed -n '460,495p' commands/superflow.md
```

- [ ] **Step 3: Insert the parallel-group brief paragraph**

Find the existing Step B2 brief paragraph that begins with "When you judge a task as obviously well-suited for Codex...". Add a NEW paragraph IMMEDIATELY AFTER it (before the "Skip your Execution Handoff prompt" paragraph):

> > **Parallel-group annotation (v1.1.0+).** When you identify mutually-independent verification, inference, lint, type-check, or doc-generation tasks, group them with `parallel-group: <thematic-name>` (e.g., `verification`, `lint-pass`, `inference-batch`). Each parallel-grouped task MUST have a complete `**Files:**` block declaring its exhaustive scope (no implicit additional paths). Codex-eligible tasks (those you'd mark `**Codex:** ok`) should NOT be parallel-grouped — they fall out of waves at dispatch time per the FM-4 mitigation. Use `parallel-group:` for tasks that are read-only or write to gitignored paths only (no commits). Place parallel-grouped tasks contiguously in plan-order — interleaved groups don't parallelize. The orchestrator's eligibility cache parses these annotations; the writing-plans skill just emits them.

- [ ] **Step 4: Verify with grep**

```bash
grep -c 'parallel-group: <thematic-name>' commands/superflow.md  # expect 1
grep -c 'mutually-independent verification' commands/superflow.md # expect 1
grep -c 'Place parallel-grouped tasks contiguously' commands/superflow.md # expect 1
echo "=== Halt-mode discriminator suite ==="
grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md | wc -l
```

- [ ] **Step 5: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step B2 writing-plans brief — parallel-group guidance (v1.1.0 task 6)

Adds the parallel-group annotation guidance paragraph to the bounded
brief /superflow Step B2 sends to superpowers:writing-plans. Planner
becomes aware of the new annotation and the v1.1.0 conventions:
- mutually-independent verification/inference/lint/typecheck/docgen
- exhaustive Files: block required
- mutually exclusive with Codex: ok
- contiguous plan-order required (interleaved groups don't parallelize)

Plans authored AFTER v1.1.0 ships gain access to wave dispatch
naturally via planner-emitted annotations.
EOF
)"
```

---

## Task 7: Step 0 — `--no-parallelism` flag + recognized flags table

**Files:**
- Modify: `commands/superflow.md` (Step 0 — Recognized flags table, ~lines 84–105 area)

**Codex:** no

**What this does.** Adds `--no-parallelism` to the recognized flags table. Documented as shorthand for `--parallelism=off`; when set, suppresses wave dispatch globally for the run. Useful for debugging.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c '\-\-no-parallelism' commands/superflow.md   # expect 0 → ≥2
grep -c '\-\-parallelism=' commands/superflow.md     # expect 0 → ≥1
```

- [ ] **Step 2: Read current Recognized flags table**

```bash
sed -n '84,105p' commands/superflow.md
```

- [ ] **Step 3: Insert two new rows in the recognized flags table**

Find the row for `--codex-review` (the last row in the recognized flags table). After it, insert two new rows:

```markdown
| `--parallelism=on\|off` | C | Override `config.parallelism.enabled` for this run. When `off`, wave dispatch in Step C step 2 is suppressed globally — every task runs serially regardless of `parallel-group:` annotations. Persisted to status file via the post-plan flag-persistence rule (does not fire under halt_mode != none). |
| `--no-parallelism` | C | Shorthand for `--parallelism=off`. |
```

- [ ] **Step 4: Verify with grep**

```bash
grep -c '\-\-no-parallelism' commands/superflow.md   # expect ≥2 (one in this row, one in the shorthand definition)
grep -c '\-\-parallelism=on\|off' commands/superflow.md # expect 1
echo "=== Halt-mode discriminator suite ==="
grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md | wc -l
```

- [ ] **Step 5: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: --no-parallelism flag + recognized flags table (v1.1.0 task 7)

Adds two new flag rows to the Step 0 Recognized flags table:
  --parallelism=on|off  → override config.parallelism.enabled
  --no-parallelism      → shorthand for --parallelism=off

Useful for debugging wave dispatch issues by forcing serial.
Follows the existing --no-codex / --no-loop pattern.
EOF
)"
```

---

## Task 8: Configuration schema — `parallelism:` block

**Files:**
- Modify: `commands/superflow.md` (Configuration: .superflow.yaml section — Schema with built-in defaults, ~lines 950–1010 area)

**Codex:** no

**What this does.** Adds the new `parallelism:` block to the Configuration schema documentation in commands/superflow.md, with three keys: `enabled`, `max_wave_size`, `abort_wave_on_protocol_violation`.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c '^parallelism:' commands/superflow.md       # expect 0 → 1
grep -c 'max_wave_size:' commands/superflow.md      # expect 0 → 1
grep -c 'abort_wave_on_protocol_violation' commands/superflow.md # expect ≥2 (already in spec via Task 4) → ≥3
```

- [ ] **Step 2: Read current Configuration schema section**

```bash
sed -n '950,1015p' commands/superflow.md
```

- [ ] **Step 3: Insert parallelism block in the YAML schema example**

Find the existing `codex:` block in the schema example. After the `codex:` block ends (and before the `auto_compact:` block begins), insert:

```yaml

# Intra-plan task parallelism (v1.1.0+) — Slice α (read-only parallel waves)
# When enabled, contiguous tasks sharing the same `parallel-group:` annotation
# in a plan dispatch as one parallel wave (verification, inference, lint,
# type-check, doc-generation only — no committing work). Implementation tasks
# remain serial under the existing per-task Step C loop.
# See docs/design/intra-plan-parallelism.md for the failure-mode catalog
# and the deferred Slice β/γ trigger.
parallelism:
  enabled: true                              # off | on — global kill switch for wave dispatch
  max_wave_size: 5                           # cap on concurrent Agent dispatches per wave
  abort_wave_on_protocol_violation: true     # if true, suppress entire 4d batch when any wave
                                             # member is reclassified as protocol_violation
                                             # (false: standard partial-failure path applies)
```

- [ ] **Step 4: Verify with grep**

```bash
grep -c '^parallelism:' commands/superflow.md
grep -c 'max_wave_size: 5' commands/superflow.md
grep -c 'abort_wave_on_protocol_violation: true' commands/superflow.md
grep -c 'global kill switch for wave dispatch' commands/superflow.md
```

- [ ] **Step 5: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: parallelism config block (v1.1.0 task 8)

Adds new top-level parallelism: block to the Configuration schema:
  enabled: true                       — global kill switch
  max_wave_size: 5                    — cap on concurrent dispatches
  abort_wave_on_protocol_violation: true — wave-abort policy

Backward-compatible: existing .superflow.yaml files without
parallelism: block get the defaults.

Documented inline in the YAML schema example for adopters.
EOF
)"
```

---

## Task 9: Telemetry hook — FM-3 mitigation (`tasks_completed_this_turn` + `wave_groups`)

**Files:**
- Modify: `hooks/superflow-telemetry.sh`

**Codex:** ok

**What this does.** Adds two new fields to the Stop hook's JSONL output: `tasks_completed_this_turn` (derives from delta of `activity_log_entries` between consecutive Stop records — see Open Q3 in spec for first-turn caveat) and `wave_groups` (array of wave-group names dispatched this turn; empty for serial).

- [ ] **Step 1: Define grep discriminators (script side)**

```bash
grep -c 'tasks_completed_this_turn' hooks/superflow-telemetry.sh # expect 0 → ≥2
grep -c 'wave_groups' hooks/superflow-telemetry.sh               # expect 0 → ≥2
```

- [ ] **Step 2: Read current hook**

```bash
cat hooks/superflow-telemetry.sh
```

- [ ] **Step 3: Add tasks_completed_this_turn computation**

The delta is computed from the previous record's `activity_log_entries`. Read the previous record from the existing telemetry file (if any) and compute the delta. Add this BEFORE the `jq -nc` invocation:

```bash
# tasks_completed_this_turn — derives from delta of activity_log_entries.
# First-turn caveat (Open Q3 in spec): when out_file doesn't exist yet,
# report 0 (treat as "first turn, no delta available").
prev_entries=0
if [[ -f "$out_file" ]]; then
  prev_entries=$(tail -n1 "$out_file" 2>/dev/null | jq -r '.activity_log_entries // 0' 2>/dev/null || echo 0)
fi
tasks_completed_this_turn=$(( activity_log_entries - prev_entries ))
[[ $tasks_completed_this_turn -lt 0 ]] && tasks_completed_this_turn=0  # archive rotation can decrement; guard.
```

- [ ] **Step 4: Add wave_groups computation**

The wave_groups array is parsed from the recent activity log entries (the ones added since the last Stop). Wave entries are tagged `[wave: <group>]` per Task 3's 4d update. Add this AFTER the tasks_completed_this_turn computation:

```bash
# wave_groups — array of distinct [wave: <group>] tags from the last N activity-log entries.
# Looks at the last `tasks_completed_this_turn` entries; extracts unique group names.
if [[ $tasks_completed_this_turn -gt 0 ]]; then
  wave_groups_json=$(awk -v n=$tasks_completed_this_turn '
    /^## Activity log/{in_log=1; next} /^## /{in_log=0}
    in_log && /^- / { entries[NR] = $0 }
    END {
      total = length(entries); start = total - n + 1; if (start < 1) start = 1
      seen = ""; first = 1
      printf "["
      for (i = start; i <= total; i++) {
        match(entries[i], /\[wave: ([^]]+)\]/, m)
        if (m[1] != "" && index(seen, "|" m[1] "|") == 0) {
          seen = seen "|" m[1] "|"
          if (!first) printf ","
          printf "\"%s\"", m[1]
          first = 0
        }
      }
      printf "]"
    }' "$status_file" 2>/dev/null)
  [[ -z "$wave_groups_json" ]] && wave_groups_json="[]"
else
  wave_groups_json="[]"
fi
```

- [ ] **Step 5: Add the new fields to the jq -nc invocation**

Find the existing jq invocation. Add `--argjson` for the two new values, and add them to the JSON output:

```bash
jq -nc \
  --arg ts "$ts" \
  --arg plan "$slug" \
  --arg branch "$branch" \
  --arg cwd "$PWD" \
  --argjson transcript_bytes "${transcript_bytes:-0}" \
  --argjson transcript_lines "${transcript_lines:-0}" \
  --argjson status_bytes "${status_bytes:-0}" \
  --argjson activity_log_entries "${activity_log_entries:-0}" \
  --argjson wakeup_count_24h "${wakeup_count_24h:-0}" \
  --argjson tasks_completed_this_turn "${tasks_completed_this_turn:-0}" \
  --argjson wave_groups "${wave_groups_json}" \
  '{ts:$ts,plan:$plan,turn_kind:"stop",transcript_bytes:$transcript_bytes,transcript_lines:$transcript_lines,status_bytes:$status_bytes,activity_log_entries:$activity_log_entries,wakeup_count_24h:$wakeup_count_24h,tasks_completed_this_turn:$tasks_completed_this_turn,wave_groups:$wave_groups,branch:$branch,cwd:$cwd}' \
  >> "$out_file" 2>/dev/null
```

- [ ] **Step 6: Verify syntax**

```bash
bash -n hooks/superflow-telemetry.sh && echo "  syntax OK"
grep -c 'tasks_completed_this_turn' hooks/superflow-telemetry.sh  # expect ≥3 (computation + argjson + JSON output)
grep -c 'wave_groups' hooks/superflow-telemetry.sh                # expect ≥3
```

- [ ] **Step 7: Smoke-test on Linux**

```bash
TMPREPO=$(mktemp -d)
cd "$TMPREPO"
git init -q
git checkout -q -b feat/test-wave
git config user.email test@example.com
git config user.name "Test"
mkdir -p docs/superpowers/plans
cat > docs/superpowers/plans/2026-05-03-test-status.md <<'EOF'
---
slug: test
status: in-progress
spec: docs/superpowers/specs/2026-05-03-test-design.md
plan: docs/superpowers/plans/2026-05-03-test.md
worktree: /tmp/dummy
branch: feat/test-wave
started: 2026-05-03
last_activity: 2026-05-03T12:00:00Z
current_task: "task1"
next_action: "verify"
autonomy: gated
loop_enabled: true
codex_routing: off
codex_review: off
compact_loop_recommended: false
---

# Test — Status

## Activity log
- 2026-05-03T12:00 task "lint pass" complete [inline][wave: verification]
- 2026-05-03T12:00 task "type check" complete [inline][wave: verification]
- 2026-05-03T12:01 task "doc gen" complete [inline]

## Wakeup ledger
- 2026-05-03T12:00:00Z first wakeup
EOF
git add -A
git commit -q -m "init"

# First run (no prior telemetry — delta is 0)
bash /home/ras/dev/claude-superflow/hooks/superflow-telemetry.sh
echo "  exit: $?"
echo "  Output 1:"
cat docs/superpowers/plans/2026-05-03-test-telemetry.jsonl | jq .

# Second run (delta is 0 since activity log unchanged — no new completions)
bash /home/ras/dev/claude-superflow/hooks/superflow-telemetry.sh
echo "  Output 2:"
tail -n1 docs/superpowers/plans/2026-05-03-test-telemetry.jsonl | jq .

# Add an entry, then run again (delta should be 1)
echo "- 2026-05-03T12:02 task 'final' complete [inline]" >> docs/superpowers/plans/2026-05-03-test-status.md
bash /home/ras/dev/claude-superflow/hooks/superflow-telemetry.sh
echo "  Output 3 (expect tasks_completed_this_turn=1, wave_groups=[]):"
tail -n1 docs/superpowers/plans/2026-05-03-test-telemetry.jsonl | jq '{tasks_completed_this_turn, wave_groups}'

cd /home/ras/dev/claude-superflow
rm -rf "$TMPREPO"
```

Expected: Output 1 shows `tasks_completed_this_turn: 3` (first record, all entries counted as "this turn") and `wave_groups: ["verification"]`. Output 2 shows `tasks_completed_this_turn: 0` (no change since prior). Output 3 shows `tasks_completed_this_turn: 1, wave_groups: []` (one new non-wave entry).

(Actually first-record behavior is the Open Q3 caveat — it'll report the absolute count rather than a delta. This is documented in telemetry-signals.md (Task 10) as "first-turn caveat."  )

- [ ] **Step 8: Commit**

```bash
git add hooks/superflow-telemetry.sh
git commit -m "$(cat <<'EOF'
hook: tasks_completed_this_turn + wave_groups telemetry (v1.1.0 task 9)

Two new JSONL fields per Stop record:

  tasks_completed_this_turn (int)
    derives from delta of activity_log_entries between consecutive
    Stop records; 0 when no prior record exists (first-turn caveat
    documented in docs/design/telemetry-signals.md).

  wave_groups (array of strings)
    distinct [wave: <group>] tags found in the last
    tasks_completed_this_turn activity-log entries.
    Empty for serial turns; non-empty for wave turns.

FM-3 mitigation: analysts can distinguish wave turns from serial.

Linux smoke-tested with synthetic worktree fixture (3-record + delta
verification). macOS portable-by-construction (no GNU-only flags
introduced); not smoke-tested.

Backward-compatible: existing telemetry consumers ignore unknown
fields.
EOF
)"
```

---

## Task 10: telemetry-signals.md — document new fields + wave-aware jq examples

**Files:**
- Modify: `docs/design/telemetry-signals.md`

**Codex:** ok

**What this does.** Documents the two new fields from Task 9 in the canonical telemetry signals doc; adds a jq example for "average tasks-per-wave-turn"; documents the first-turn caveat for `tasks_completed_this_turn`.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'tasks_completed_this_turn' docs/design/telemetry-signals.md  # expect 0 → ≥2
grep -c 'wave_groups' docs/design/telemetry-signals.md                # expect 0 → ≥2
grep -c 'first-turn caveat' docs/design/telemetry-signals.md          # expect 0 → 1
```

- [ ] **Step 2: Read current telemetry-signals.md**

```bash
cat docs/design/telemetry-signals.md
```

- [ ] **Step 3: Add the two new fields to the Record shape section**

Find the "Record shape" or "Fields" section (the top of the doc). Add to the per-field documentation:

```markdown
- `tasks_completed_this_turn` (int, v1.1.0+): count of plan tasks that completed during the orchestrator turn that produced this Stop record. Derived from the delta of `activity_log_entries` between this record and the previous Stop record for the same plan. **First-turn caveat:** when no previous record exists (the first telemetry record for a plan), this field reports `0` rather than the absolute entry count — first-record telemetry doesn't have a baseline to subtract. Activity log rotation (entries moved to `<slug>-status-archive.md`) can decrement `activity_log_entries` between records; the hook guards against negative values by clamping to 0. Use to distinguish wave turns (>1) from serial turns (==1) from no-progress turns (==0).
- `wave_groups` (array of strings, v1.1.0+): distinct `[wave: <group>]` tags found in the last `tasks_completed_this_turn` activity-log entries. Empty array `[]` for serial-only turns. Use to identify which parallel-group(s) dispatched this turn — useful for measuring per-group latency wins.
```

- [ ] **Step 4: Add a wave-aware jq example**

Find the "Useful jq queries" section. Append a new example:

```markdown
### Average tasks-per-wave-turn

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

Returns a summary like `{"wave_turns": 4, "serial_turns": 12, "avg_tasks_per_wave_turn": 3.5, "groups_seen": ["verification", "lint-pass"]}`. Use to evaluate whether parallel-group annotations are actually being authored and exercised; non-zero `wave_turns` is the trigger condition for the v1.1.x doctor check that scans for Slice β/γ revisit.
```

- [ ] **Step 5: Verify with grep**

```bash
grep -c 'tasks_completed_this_turn' docs/design/telemetry-signals.md  # expect ≥3
grep -c 'wave_groups' docs/design/telemetry-signals.md                # expect ≥3
grep -c 'first-turn caveat' docs/design/telemetry-signals.md          # expect 1
grep -c 'Average tasks-per-wave-turn' docs/design/telemetry-signals.md # expect 1
```

- [ ] **Step 6: Commit**

```bash
git add docs/design/telemetry-signals.md
git commit -m "$(cat <<'EOF'
docs(telemetry): document tasks_completed_this_turn + wave_groups (v1.1.0 task 10)

Documents the two new v1.1.0+ fields in the canonical telemetry
signals doc:
  - tasks_completed_this_turn (int): per-turn delta with first-turn
    caveat documented; rotation-decrement guard clamps to 0
  - wave_groups (array): distinct [wave: <group>] tags from this
    turn's activity-log entries

Adds new jq query example: "Average tasks-per-wave-turn" — returns
wave/serial turn counts, average tasks per wave, and groups seen.
Useful for evaluating whether parallel-group annotations are being
authored and exercised in practice (trigger condition for v1.1.x
doctor check that scans for Slice β/γ revisit).
EOF
)"
```

---

## Task 11: docs/design/intra-plan-parallelism.md — rewrite for v1.1.0

**Files:**
- Modify: `docs/design/intra-plan-parallelism.md`

**Codex:** ok

**What this does.** Rewrites the original brief deferred-design notes to reference the new spec (`docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md`), embed the failure-mode catalog (FM-1 through FM-6), and document the sharpened revisit trigger for Slice β/γ.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'Slice α' docs/design/intra-plan-parallelism.md   # expect 0 → ≥2
grep -c 'FM-1' docs/design/intra-plan-parallelism.md       # expect 0 → ≥1
grep -c 'sharpened revisit trigger' docs/design/intra-plan-parallelism.md # expect 0 → 1
grep -c '2026-05-03-intra-plan-parallelism-design' docs/design/intra-plan-parallelism.md # expect 0 → 1
```

- [ ] **Step 2: Read current file (preserve as historical context if needed)**

```bash
cat docs/design/intra-plan-parallelism.md
```

- [ ] **Step 3: Rewrite the file**

Replace the entire contents with:

```markdown
# Intra-plan task parallelism (status notes)

**Status:** Slice α (read-only parallel waves) shipped in v1.1.0. Slice β (serialized-commit waves) and Slice γ (full per-task worktree subsystem) remain deferred with a sharpened, measurable revisit trigger (below).

**Spec for Slice α:** [`docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md`](../superpowers/specs/2026-05-03-intra-plan-parallelism-design.md) — read this for the full design, the failure-mode catalog (FM-1 through FM-6), the mitigation depth-pass, and the acceptance criteria.

## What ships in Slice α (v1.1.0)

Read-only parallel waves only — verification, inference, lint, type-check, doc-generation tasks declared via `parallel-group:` annotations dispatch as concurrent waves in Step C step 2. Implementation tasks (anything that commits) remain serial under the existing per-task Step C loop.

Supporting infrastructure (single-writer status funnel, scope-snapshot eligibility cache pin, files-filter, wave-aware activity log rotation, three new doctor checks, two new telemetry fields, new `parallelism:` config block) lands in v1.1.0 and is reusable for Slice β/γ when (if) implemented. The expensive piece deferred (per-task git worktree subsystem) becomes a smaller incremental cost on top.

See spec Section 1 (Architecture overview) and Section 6 (Migration + integration) for the integration surface.

## What's deferred (Slice β / Slice γ)

- **Slice β (~8-10 days estimated):** Parallel committing-task waves with serialized commits funneled through the orchestrator. Wave members do work concurrently but the commit step is serial. Latency win is partial; matches user expectation of "intra-plan parallelism" but the savings are smaller than the framing suggests.
- **Slice γ (~10-15 days estimated):** Full per-task git worktree subsystem — the original deferred design's ambition. Each parallel implementation task dispatches into its own temp worktree; merge commits back to canonical branch at wave-end (fast-forward when possible, conflict-abort otherwise per CD-2). Real parallel committing-task execution. Cost the prior deferral was honest about.

The choice between Slice β and Slice γ at next revisit is a function of how often the trigger condition fires and whether a serialized-commit funnel is sufficient or whether the latency cost demands true commit parallelism.

## Sharpened revisit trigger

The original v0.1 trigger was "real plans show parallel-friendly task patterns and the latency cost becomes felt" — unmeasurable. The v1.1.0 sharpened trigger:

> **Revisit Slice β** when a real /superflow plan shows ≥3 parallel-grouped committing tasks where the wave's serial wall-clock cost exceeds 10 minutes AND the committed work is independent enough for the Slice α `**Files:**` exhaustive-scope rule to apply.
>
> **Revisit Slice γ** when ≥3 such β-eligible waves accumulate within a single plan's lifecycle, indicating a structural pattern that warrants the full per-task worktree subsystem.

Doctor check candidate (deferred to v1.1.x): scan completed-and-recent plans for the trigger condition; surface as a one-line note in `/superflow status`. The telemetry fields `tasks_completed_this_turn` and `wave_groups` (added in v1.1.0) provide the data — see `telemetry-signals.md`'s "Average tasks-per-wave-turn" jq example.

## Failure-mode catalog (capsule summary)

The full catalog with worked examples lives in the spec. Brief summary of the six modes Slice α addresses:

- **FM-1: Eligibility-cache invalidation** under in-wave plan edits — addressed by M-2 (cache pin) + CD-2 in-wave scope rule.
- **FM-2: Activity log rotation race** — addressed by M-1 (wave-aware single-writer rotation).
- **FM-3: Status file write contention** — addressed by M-1 (single-writer funnel, orchestrator as canonical writer).
- **FM-4: Codex routing as serializing sync point** — addressed by Slice α eligibility rule 4 (Codex tasks fall out of waves).
- **FM-5: Worktree integrity check ambiguity** — addressed by M-3 (files-filter union under wave).
- **FM-6: SDD is structurally serial** — addressed for read-only work by M-4a (SDD wrapper). Committing work is the deferred concern; per-task worktree subsystem (Slice γ) is the cheapest mitigation.

## Original v0.1 notes (preserved as historical context)

The original `Future: intra-plan task parallelism (design notes)` lived inline in `commands/superflow.md` until v0.2.0, was relocated here, and held through v1.0.0. The original four sections — annotation schema, required machinery, why deferred, when to revisit — have been superseded by the v1.0.0-era catalog and the Slice α spec. Their substance is captured in:

- `parallel-group:`, `**Files:**`-as-exhaustive-scope, optional `**non-committing:**` annotations (the spec's Section 2)
- per-task git worktree isolation (deferred to Slice γ; documented as cheapest committing-work mitigation)
- single-writer status file (now M-1, shipped in Slice α)
- per-task verification with rollback policy (now Section 4 failure handling, partial Slice α scope)
- the original "when to revisit" trigger is sharpened and measurable in this doc (above)

The deferral history (v0.1 → v0.2 → v0.3 → v0.4 → v1.0.0) ended in v1.1.0 with the Slice α release. Future deferrals (Slice β/γ) are tracked via the sharpened trigger above and the v1.1.x doctor check candidate.
```

- [ ] **Step 4: Verify with grep**

```bash
grep -c 'Slice α' docs/design/intra-plan-parallelism.md
grep -c 'Slice β' docs/design/intra-plan-parallelism.md
grep -c 'Slice γ' docs/design/intra-plan-parallelism.md
grep -c 'FM-1' docs/design/intra-plan-parallelism.md
grep -c 'sharpened revisit trigger' docs/design/intra-plan-parallelism.md
grep -c '2026-05-03-intra-plan-parallelism-design' docs/design/intra-plan-parallelism.md
echo "Word count (was ~25 lines / ~200 words; expect ~150-200 lines / ~1000-1500 words):"
wc -lw docs/design/intra-plan-parallelism.md
```

- [ ] **Step 5: Commit**

```bash
git add docs/design/intra-plan-parallelism.md
git commit -m "$(cat <<'EOF'
docs(design): rewrite intra-plan-parallelism.md for v1.1.0 (task 11)

Replaces the original v0.1 deferred-design notes (4 sections, ~25
lines) with a v1.1.0 status doc:
  - what ships in Slice α (link to spec)
  - what's deferred (Slice β ~8-10d, Slice γ ~10-15d)
  - sharpened, measurable revisit trigger
  - failure-mode catalog capsule summary
  - original v0.1 notes preserved as historical context

The full v1.0.0-era catalog + mitigation depth-pass + design lives
in docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md.
This file is now the entry point for "where are we on intra-plan
parallelism?"
EOF
)"
```

---

## Task 12: README.md updates — Phase verbs, Plan annotations, Useful flag combinations

**Files:**
- Modify: `README.md`

**Codex:** no

**What this does.** Updates README.md to surface the v1.1.0 additions: Plan annotations section gains `**parallel-group:**` row alongside `**Codex:**`; Useful flag combinations gains a row showing `--no-parallelism` + recommended pairings; "Recent improvements" or "Path to v1.0.0" section gets a v1.1.0 entry.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c 'parallel-group' README.md           # expect 0 → ≥3
grep -c 'no-parallelism' README.md           # expect 0 → ≥1
grep -c 'v1.1.0' README.md                   # expect 0 → ≥2
```

- [ ] **Step 2: Read relevant README sections**

```bash
sed -n '1,50p' README.md       # head
grep -n '## Plan annotations\|## Useful flag combinations\|## Recent improvements\|## Path to' README.md
```

- [ ] **Step 3: Add a `**parallel-group:**` row to the Plan annotations section**

Find the existing **Plan annotations** section and its annotation table (the one with `**Codex:** ok` / `**Codex:** no` rows). After the `**Codex:** no` row, add:

```markdown
| `**parallel-group:** <name>` | (v1.1.0+) Tasks sharing the same `<name>` dispatch as one parallel wave in Step C step 2 — read-only verification, inference, lint, type-check, doc-generation only. Mutually exclusive with `**Codex:** ok`. Requires a complete `**Files:**` block declaring exhaustive scope. See [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md) for the failure-mode catalog and Slice β/γ deferrals. |
```

(If the annotations section uses a different format, match the existing format. The key data is: annotation key, semantics, link to design notes.)

- [ ] **Step 4: Add a Useful flag combinations row**

Find the **Useful flag combinations** section. Add a new row:

```markdown
| `/superflow <topic> --no-parallelism` | Force serial execution of all tasks regardless of `parallel-group:` annotations. Useful for debugging wave dispatch issues or when running on a system where parallel Agent dispatch is rate-limited. Persisted to status file as `parallelism: off`. |
```

- [ ] **Step 5: Update "Path to v1.0.0" / "Recent improvements" with a v1.1.0 entry**

Find the relevant section. Add a new bullet/entry at the top:

```markdown
- **v1.1.0 — intra-plan parallelism (Slice α — read-only waves).** First feature-pass on the v1.x track. Adds `parallel-group:` plan annotation and wave dispatch in Step C step 2 for read-only verification/inference/lint/type-check/doc-generation tasks. Implementation (committing) tasks remain serial — those are deferred to Slice β/γ with a sharpened, measurable revisit trigger documented in [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md). Supporting infrastructure (single-writer status funnel, eligibility cache pin, files-filter, wave-aware activity log rotation, 3 new doctor checks, 2 new telemetry fields, new `parallelism:` config block, `--no-parallelism` flag) is reusable for the deferred slices. See [CHANGELOG `[1.1.0]`](./CHANGELOG.md).
```

- [ ] **Step 6: Update Project status section**

Find the **Project status** section. Update the version pointer:

Old (illustrative): `This is the first stable public release (current: **v1.0.0**)...`
New: `This is a stable public release (current: **v1.1.0**). v1.1.0 ships Slice α of intra-plan task parallelism (read-only parallel waves). The orchestration logic has been used in real Petabit Scale workflows since v0.1 and is stable. Schema and flag surface continue to evolve under semver — additive changes and bug fixes land in v1.x; breaking changes (schema/flag/CLI) are called out in the changelog and gated behind a `--legacy` flag where reasonable.`

- [ ] **Step 7: Verify with grep**

```bash
grep -c 'parallel-group' README.md             # expect ≥3
grep -c 'no-parallelism' README.md             # expect ≥1
grep -c 'v1.1.0' README.md                     # expect ≥3
grep -c 'Slice α' README.md                    # expect ≥1
echo "Project status version pointer:"
grep -A2 '## Project status' README.md
```

- [ ] **Step 8: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): v1.1.0 surface — parallel-group annotation, --no-parallelism (task 12)

Surfaces v1.1.0 additions in README:

- Plan annotations table gains a parallel-group row
  alongside the existing Codex annotation
- Useful flag combinations table gains --no-parallelism row
- Path to v1.x / Recent improvements section gains v1.1.0 entry
- Project status section bumped to v1.1.0 with framing
  about Slice α / deferred Slice β/γ

Cross-links to docs/design/intra-plan-parallelism.md for the
failure-mode catalog and the sharpened revisit trigger.
EOF
)"
```

---

## Task 13: Release bookkeeping — CHANGELOG [1.1.0] + plugin.json + WORKLOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `.claude-plugin/plugin.json`
- Modify: `WORKLOG.md`

**Codex:** ok

**What this does.** Cuts the v1.1.0 release: CHANGELOG block with Added/Changed/Fixed/Migration sections, plugin.json version bump, WORKLOG dated entry capturing rationale + verification + known gaps. Matches the v1.0.0 release pass convention.

- [ ] **Step 1: Define grep discriminators**

```bash
grep -c '\[1.1.0\]' CHANGELOG.md             # expect 0 → 1
grep -c '"version": "1.1.0"' .claude-plugin/plugin.json  # expect 0 → 1
grep -c 'v1.1.0 — intra-plan' WORKLOG.md     # expect 0 → 1
```

- [ ] **Step 2: Add CHANGELOG `[1.1.0]` block**

Find the `## [Unreleased]` section. Replace it with:

```markdown
## [Unreleased]

## [1.1.0] — 2026-05-03

**Slice α of intra-plan task parallelism — read-only parallel waves.** First feature-pass on the v1.x track. Adds `parallel-group:` plan annotation and wave dispatch in Step C step 2 for read-only verification/inference/lint/type-check/doc-generation tasks. Implementation (committing) tasks remain serial; those are deferred to Slice β/γ with a sharpened, measurable revisit trigger documented in `docs/design/intra-plan-parallelism.md`. Spec: `docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md` (failure-mode catalog FM-1 through FM-6 + mitigation depth-pass).

### Added
- **`parallel-group: <name>` plan annotation.** Tasks sharing the same `<name>` value dispatch as one parallel wave in Step C step 2. Read-only only (verification, inference, lint, type-check, doc-generation). Mutually exclusive with `**Codex:** ok`. Requires complete `**Files:**` block (becomes exhaustive scope under wave).
- **Wave dispatch in Step C step 2** — contiguous-plan-order wave assembly; per-instance bounded brief (DO NOT commit, DO NOT update status); parallel `Agent` dispatch; wave-completion barrier.
- **Single-writer status funnel in Step C 4d** — orchestrator aggregates wave digests, computes `current_task` as lowest-indexed not-yet-complete, appends N entries to `## Activity log` in plan-order with `[wave: <group>]` tag, runs wave-aware activity log rotation (fires once per wave per FM-2), commits status file once per wave.
- **Files-filter in Step C 4c under wave** — single porcelain check filters against union of all wave-task `**Files:**` declarations (post-glob-expansion) plus implicit-paths whitelist.
- **Eligibility cache pin (M-2 mitigation)** — `cache_pinned_for_wave` flag suppresses mtime invariant during wave; CD-2 in-wave scope rule forbids wave members from modifying plan/status/cache.
- **Per-member outcome reconciliation** — three outcomes (`completed` / `blocked` / `protocol_violation`); `protocol_violation` detected by orchestrator post-barrier (commits despite "DO NOT commit", out-of-scope writes, status file modification).
- **Wave-level outcomes** — all-completed / all-blocked / partial. Partial preserves K completed digests UNLESS `parallelism.abort_wave_on_protocol_violation: true` (default), in which case the entire 4d batch is suppressed.
- **Blocker re-engagement gate integration** — fires once at wave-end with the union of N-K blocked members; option semantics extend naturally.
- **Step C 5 wave-count threshold** — wave-end counts as ONE completion regardless of N (a wave of 5 doesn't trigger 5 wakeup-threshold increments).
- **3 new doctor checks (#15-17, total 14 → 17):** parallel-group without Files: block; parallel-group + Codex: ok mutual conflict; file-path overlap within parallel-group.
- **`hooks/superflow-telemetry.sh` gains `tasks_completed_this_turn` (int) + `wave_groups` (array of strings) fields** — FM-3 mitigation. Linux smoke-tested; macOS portable-by-construction (not smoke-tested).
- **New `parallelism:` config block** — `enabled` (kill switch), `max_wave_size` (default 5), `abort_wave_on_protocol_violation` (default true).
- **New `--parallelism=on|off` and `--no-parallelism` CLI flags.**
- **Step B2 writing-plans brief paragraph** — guidance for the planner on emitting `parallel-group:` annotations.

### Changed
- `commands/superflow.md` Step C step 1 eligibility cache schema extended with `parallel_group`, `files`, `parallel_eligible`, `parallel_eligibility_reason` (all optional; backward-compatible with pre-v1.1.0 cache files).
- `commands/superflow.md` Step D parallelization brief: `each agent runs all 14 checks` → `each agent runs all 17 checks`.
- `docs/design/intra-plan-parallelism.md` rewritten — replaces v0.1 brief notes with v1.1.0 status doc (what ships in Slice α, what's deferred, sharpened trigger, failure-mode catalog summary).
- `docs/design/telemetry-signals.md` — documents the two new fields with first-turn caveat; adds "Average tasks-per-wave-turn" jq example.
- README.md — Plan annotations table adds parallel-group row; Useful flag combinations adds --no-parallelism row; Project status bumped; Path-to-v1.x section gains v1.1.0 entry.

### Fixed
- (None this release — v1.0.0 audit fixes were the last fix-only pass.)

### Migration notes
- **No breaking changes.** Existing plans without `parallel-group:` annotations behave unchanged (serial). Status files unchanged. `.superflow.yaml` files without the `parallelism:` block get defaults.
- **Eligibility cache files (`<slug>-eligibility-cache.json`) lacking the new fields are valid** — load with `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today.
- **Plans authored under v1.1.0+ may include `parallel-group:` annotations.** The writing-plans brief at /superflow Step B2 now mentions the convention so future plans can opt in naturally when the planner identifies parallel-friendly task patterns.
- **Doctor check count is now 17.** Existing `--fix` invocations that scoped to specific check IDs continue to work; the three new checks are Warning-only (no auto-fix).
```

- [ ] **Step 3: Bump plugin.json version**

```bash
sed -i 's/"version": "1.0.0"/"version": "1.1.0"/' .claude-plugin/plugin.json
grep '"version"' .claude-plugin/plugin.json   # expect "version": "1.1.0"
```

- [ ] **Step 4: Append WORKLOG entry**

Find the end of WORKLOG.md (after the v1.0.0 entry). Append:

```markdown

---

## 2026-05-03 — v1.1.0 — intra-plan task parallelism (Slice α — read-only parallel waves)

**Scope:** First feature-pass on the v1.x track. Ships Slice α of the intra-plan task parallelism design that's been deferred since v0.1 (across v0.2 → v0.3 → v0.4 → v1.0.0). Read-only parallel waves only — verification, inference, lint, type-check, doc-generation. Implementation tasks remain serial; that's deferred to Slice β (~8-10d) or Slice γ (~10-15d) with a sharpened, measurable revisit trigger documented in `docs/design/intra-plan-parallelism.md`. Spec: `docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md`.

**Key decisions (the why):**

- **Slice α picked over Slice β or γ** based on the depth-pass discovery that the original "wrap SDD in parallel-dispatch layer" mitigation doesn't actually solve the central git-index-race for committing work — concurrent commits to the same branch race the index regardless of wrapper. Read-only work sidesteps it entirely; that's the smallest useful slice. Slice β/γ inherits the unsolved committing-work problem.
- **Single-writer status funnel via Step C 4d batched update.** Wave members return digests; do not write to status file. Orchestrator is canonical writer per CD-7. Activity log rotation is wave-aware — fires once per wave (not per task in wave) per FM-2. `current_task` semantics under wave: lowest-indexed not-yet-complete task (single-pointer field; explicit rule).
- **Per-task `**Files:**` block becomes exhaustive scope under `parallel-group:`.** Repurposes existing block (no new schema). Step C 4c filters porcelain against the union for wave members. FM-5 mitigation.
- **Codex tasks fall out of waves explicitly.** Mutually exclusive with `parallel-group:` per Section 2 eligibility rule 4. Per-task `AskUserQuestion(Accept / Reject)` under `gated` doesn't compose under N concurrent Codex executions; review subagents under wave dispatch hit the same Codex resource pool. FM-4 mitigation. Codex's actual concurrency model remains unverified — flagged as research item, doesn't block Slice α.
- **`abort_wave_on_protocol_violation: true` is the default.** When ANY wave member commits despite "DO NOT commit" / writes outside scope / modifies status, the entire 4d batch is suppressed (K completed digests not applied). Conservative — prevents partial-application of state when the contract was violated. Configurable; users can flip to `false` for the standard partial-failure path.
- **Mid-wave interruption recovery is idempotent by Slice α design.** Read-only members can be safely re-dispatched. Status file unchanged until wave-end barrier returns; if interrupted before, re-enter Step C, re-dispatch wave from scratch. Slice β/γ would lose this property (committing work is not idempotent without per-task worktree isolation).
- **Telemetry attribution under wave** addressed via two new fields (`tasks_completed_this_turn`, `wave_groups`). Analysts can distinguish wave turns from serial. First-turn caveat documented (no prior record = no delta = report 0). Activity log rotation can decrement `activity_log_entries`; hook clamps to 0.
- **Step B2 brief update is meta-recursive.** This v1.1.0 plan itself doesn't use `parallel-group:` annotations because the v0.1.0 conventions (no parallel-group support) apply during the implementation. Plans authored AFTER v1.1.0 ships gain access naturally.
- **Doctor checks #15-17 are Warning, not Error.** Step C step 1 catches violations and degrades gracefully to serial; doctor surfaces them early to plan authors but doesn't block execution.

**Operational notes:**

- 14 implementation tasks per the plan. Most touch `commands/superflow.md` (the orchestrator) and need cross-section consistency awareness — marked `**Codex:** no`. Hook + telemetry-signals.md + plugin.json bump + this WORKLOG entry are bounded single-file tasks — `**Codex:** ok`.
- Halt-mode discriminator suite (`grep -nE 'halt_mode|Continue to plan now|Start execution now|post-brainstorm|post-plan' commands/superflow.md`) re-checked after every Step C / B1 / B2 / B3 edit — no orphans.
- Doctor checks-count discriminator after Task 5 should equal 17 (matches table size).
- Telemetry hook smoke-tested on Linux with synthetic worktree fixture (3-record + delta verification). macOS path is portable-by-construction (no GNU-only flags introduced); not smoke-tested. Same gap as v1.0.0 release; documented in CHANGELOG and README.
- Codex review of inline tasks: `--codex-review=on` was set on this /superflow run; persisted to status file at Step B3. Every inline-completed task gets reviewed by `codex:codex-rescue` against the spec during execute. Findings auto-accept under `gated` autonomy below severity `medium`.
- Smoke verification (Task 14): hand-crafted test plan with 3 parallel-eligible verification tasks. Confirms wave dispatch fires, single-writer 4d batch applies, activity log gets `[wave: <group>]` tags, 4c union-filter behaves. Test plan files deleted before commit so no smoke artifacts ship.

**Open questions / followups (per spec Section: Open questions):**

- **Codex concurrency model verification.** FM-4's mitigation (Codex falls out of waves) is conservative because Codex's actual concurrency limits are unverified. If Codex CLI / API supports N concurrent executions cleanly, a future slice could allow Codex tasks in waves with a serialized review-gate funnel. Action: verify via `codex:setup` or codex CLI docs before designing Slice β/γ.
- **Agent tool concurrency limits.** `max_wave_size: 5` default is a guess. Smoke-test on a real wave during Task 14 confirms behavior at N=3; N=5 untested. May need adjustment.
- **First-turn caveat for `tasks_completed_this_turn`.** Documented in telemetry-signals.md; acceptable degraded behavior.
- **Wave dispatch under `--autonomy=gated`.** The `gated` mode's per-task `AskUserQuestion(continue / skip / stop)` gate currently fires per-task. Under wave, the gate fires once at wave-start showing the wave's task list (4 options remain). Spec calls this out for clarification at execute time; not a v1.1.0 implementation blocker.
- **Doctor check candidate for the v1.1.x trigger condition.** Sharpened revisit trigger for Slice β/γ is documented but not yet a doctor check. Deferred — to be added in v1.1.x if any plan trips the trigger via the new telemetry fields.
- **Slice β / γ deferral.** Sharpened, measurable trigger lives in `docs/design/intra-plan-parallelism.md`. The next revisit will fire from real-plan evidence (telemetry-driven), not from "feels like time to revisit."

**Branch state at end of pass:**

- Tagged v1.1.0 on main (per the user's "in one push" preference matching the v1.0.0 release pattern).
- 14 commits ahead of v1.0.0 on `main` (one per task in the plan).
```

- [ ] **Step 5: Verify**

```bash
grep -c '\[1.1.0\]' CHANGELOG.md
grep -c '"version": "1.1.0"' .claude-plugin/plugin.json
grep -c 'v1.1.0 — intra-plan' WORKLOG.md
echo "=== plugin.json ==="
cat .claude-plugin/plugin.json
```

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md .claude-plugin/plugin.json WORKLOG.md
git commit -m "$(cat <<'EOF'
release: v1.1.0 — intra-plan task parallelism (Slice α)

First feature-pass on the v1.x track. Ships Slice α of the
intra-plan task parallelism design deferred since v0.1.

Read-only parallel waves only (verification, inference, lint,
type-check, doc-generation). Implementation tasks remain serial;
deferred to Slice β/γ with a sharpened, measurable revisit
trigger documented in docs/design/intra-plan-parallelism.md.

Spec: docs/superpowers/specs/2026-05-03-intra-plan-parallelism-design.md
(failure-mode catalog FM-1 through FM-6 + mitigation depth-pass).

CHANGELOG [1.1.0] block summarizes Added (12 items) and Changed
(5 items). Migration notes confirm no breaking changes.

WORKLOG entry captures the why (Slice α picked over β/γ based on
depth-pass), key decisions, operational notes, open questions
carried forward, and Codex review setup for the execute phase.
EOF
)"
```

---

## Task 14: Smoke verification — hand-crafted parallel-wave test plan

**Files:**
- Create: `docs/superpowers/specs/2026-05-03-test-parallel-wave-design.md` (temporary; deleted before commit)
- Create: `docs/superpowers/plans/2026-05-03-test-parallel-wave.md` (temporary; deleted before commit)
- Create: `docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md` (temporary; deleted before commit)

**Codex:** no

**What this does.** Smoke-verifies that the v1.1.0 wave dispatch infrastructure works end-to-end. Hand-crafts a tiny test plan with 3 parallel-eligible verification tasks, runs `/superflow execute` against it (in this same session — no need for a separate worktree), confirms wave dispatch fires, single-writer 4d batch applies, activity log gets `[wave: <group>]` tags, 4c union-filter behaves. Deletes the test files after verification so no smoke artifacts ship.

This is the canonical signal that acceptance criterion #16 is satisfied.

- [ ] **Step 1: Hand-craft the test spec**

Create `docs/superpowers/specs/2026-05-03-test-parallel-wave-design.md`:

```markdown
# Smoke test for v1.1.0 wave dispatch — Design

**TEMPORARY FILE — TO BE DELETED AFTER SMOKE VERIFICATION.**

## Background

Smoke test for the v1.1.0 intra-plan task parallelism Slice α implementation. Three trivial verification tasks; all should dispatch as ONE wave per the Section 2 eligibility rules.

## Scope

Three tasks, all in `parallel-group: smoke-verify`. Each runs a trivial read-only command. No commits. No file modifications outside the declared `**Files:**` block (which lists nothing modifiable since these are pure verification tasks).
```

- [ ] **Step 2: Hand-craft the test plan**

Create `docs/superpowers/plans/2026-05-03-test-parallel-wave.md`:

```markdown
# Smoke test for v1.1.0 wave dispatch Implementation Plan

> **TEMPORARY FILE — TO BE DELETED AFTER SMOKE VERIFICATION.**

**Goal:** Smoke-verify Slice α wave dispatch fires correctly.

### Task 1: Verify foo

**Files:**
- Lint: src/nonexistent-foo.txt

**Codex:** no
**parallel-group:** smoke-verify

- [ ] **Step 1:** Run `echo foo`. Expected output: `foo`.

### Task 2: Verify bar

**Files:**
- Lint: src/nonexistent-bar.txt

**Codex:** no
**parallel-group:** smoke-verify

- [ ] **Step 1:** Run `echo bar`. Expected output: `bar`.

### Task 3: Verify baz

**Files:**
- Lint: src/nonexistent-baz.txt

**Codex:** no
**parallel-group:** smoke-verify

- [ ] **Step 1:** Run `echo baz`. Expected output: `baz`.
```

- [ ] **Step 3: Hand-craft the test status file**

Create `docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md`:

```markdown
---
slug: test-parallel-wave
status: in-progress
spec: docs/superpowers/specs/2026-05-03-test-parallel-wave-design.md
plan: docs/superpowers/plans/2026-05-03-test-parallel-wave.md
worktree: /home/ras/dev/claude-superflow
branch: main
started: 2026-05-03
last_activity: 2026-05-03T20:00:00Z
current_task: "Verify foo"
next_action: "Run echo foo"
autonomy: gated
loop_enabled: false
codex_routing: off
codex_review: off
compact_loop_recommended: false
---

# Smoke test — Status

## Activity log
(none yet)

## Blockers
(none)

## Notes
- TEMPORARY smoke-test status file. Delete with the spec + plan after verification.
```

- [ ] **Step 4: Run /superflow execute against the test plan**

In a fresh /superflow invocation:

```
/superflow execute docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md
```

Expected behavior:
- Step C step 1 reads the status, plan, spec.
- Step C step 1 builds (or loads) the eligibility cache; computes `parallel_eligible: true` for all 3 tasks.
- Step C step 2 wave assembly assembles a wave of 3 tasks (group: `smoke-verify`).
- Per-instance bounded brief dispatched 3x in parallel via `Agent`.
- Wave-completion barrier returns 3 digests (all `completed`).
- Step C 4c union-filter runs once at wave-end; passes (no out-of-scope writes since all tasks are read-only).
- Step C 4d single-writer funnel applies 3 entries to `## Activity log` in plan-order, each tagged `[inline][wave: smoke-verify]`. Single status file commit with subject `superflow: wave complete (group: smoke-verify, 3 tasks)`.
- Step C 5: wave-end counts as one completion (not three).

- [ ] **Step 5: Verify wave dispatch behavior**

```bash
echo "=== Activity log entries ===" 
grep -A20 '## Activity log' docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md

echo "=== Wave tag check ==="
grep -c '\[wave: smoke-verify\]' docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md
# expect 3

echo "=== Plan-order check ==="
grep '^- ' docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md | head -3
# expect: order matches Verify foo / Verify bar / Verify baz

echo "=== Status field check ==="
grep -E '^(status|current_task|next_action):' docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md
# status should be `complete` (last task in plan completed); current_task pointer past last task

echo "=== Single wave-commit check ==="
git log --oneline | head -3
# expect a recent commit subject like "superflow: wave complete (group: smoke-verify, 3 tasks)"
```

If any check fails, the wave dispatch implementation has a bug — DO NOT proceed to Step 6 (cleanup). File a blocker via the blocker re-engagement gate ("Provide context and re-dispatch") and iterate on the relevant Task 1-4 implementation.

- [ ] **Step 6: Cleanup — delete the test files BEFORE committing**

```bash
git rm docs/superpowers/specs/2026-05-03-test-parallel-wave-design.md
git rm docs/superpowers/plans/2026-05-03-test-parallel-wave.md
git rm docs/superpowers/plans/2026-05-03-test-parallel-wave-status.md
# Also remove any sidecar files the smoke run created:
rm -f docs/superpowers/plans/2026-05-03-test-parallel-wave-eligibility-cache.json
rm -f docs/superpowers/plans/2026-05-03-test-parallel-wave-telemetry.jsonl
git status --short
# expect only the three deletions staged + maybe the wave-commit from /superflow execute
```

- [ ] **Step 7: Commit cleanup**

```bash
git add -u
git commit -m "$(cat <<'EOF'
test: remove smoke-test fixtures for v1.1.0 wave dispatch (task 14)

Smoke verification successful — wave dispatch infrastructure works
end-to-end. 3 parallel-eligible tasks dispatched as one wave; single
4d batch applied 3 entries to ## Activity log in plan-order with
[wave: smoke-verify] tags; wave-completion barrier returned cleanly;
4c union-filter passed.

Acceptance criterion #16 satisfied.

The temporary smoke-test files (spec, plan, status) and any sidecar
files (eligibility cache, telemetry) are removed so v1.1.0 ships
clean.
EOF
)"
```

- [ ] **Step 8: Tag the v1.1.0 release**

```bash
git tag -a v1.1.0 -m "$(cat <<'EOF'
v1.1.0 — intra-plan task parallelism (Slice α — read-only parallel waves)

Adds parallel-group: plan annotation and wave dispatch in Step C
step 2 for read-only verification/inference/lint/type-check/doc-gen
tasks. Implementation tasks remain serial; deferred to Slice β/γ.

See CHANGELOG [1.1.0] for the full breakdown.
See docs/design/intra-plan-parallelism.md for the failure-mode
catalog and the sharpened revisit trigger for Slice β/γ.
EOF
)"

git tag -v v1.1.0 2>&1 | head -10
git log --oneline -1
```

- [ ] **Step 9: Push to origin (if user-approved at execute time)**

```bash
git push origin main && git push origin v1.1.0
git ls-remote --tags origin | grep v1.1.0
```

(This step requires user approval per CLAUDE.md's risky-actions policy. The blocker re-engagement gate will fire if push is denied.)

---

## Self-review

Spec coverage check (mapping plan tasks to spec acceptance criteria):

| Acceptance criterion | Task |
|---|---|
| 1 (Step C step 2 wave-detection pre-pass) | Task 2 |
| 2 (Step C step 1 cache builder Haiku brief) | Task 1 |
| 3 (Step B2 writing-plans brief) | Task 6 |
| 4 (Step C 4d single writer + per-instance briefs) | Task 3 (4d) + Task 2 (per-instance briefs) |
| 5 (Step C 4c union-filter) | Task 3 |
| 6 (Step C 5 wave-count threshold) | Task 4 |
| 7 (Step D parallelization brief 14→17 + new checks) | Task 5 |
| 8 (Hook gains tasks_completed_this_turn + wave_groups) | Task 9 |
| 9 (telemetry-signals.md docs) | Task 10 |
| 10 (Configuration schema parallelism block) | Task 8 (also Task 7 for the CLI flag side) |
| 11 (docs/design/intra-plan-parallelism.md rewrite) | Task 11 |
| 12 (README updates) | Task 12 |
| 13 (CHANGELOG [1.1.0]) | Task 13 |
| 14 (plugin.json bump) | Task 13 |
| 15 (WORKLOG entry) | Task 13 |
| 16 (Smoke verification) | Task 14 |

All 16 criteria covered. Two criteria pair into Task 13 (release bookkeeping); rest are 1-task-per-criterion.

Type / annotation consistency:
- `parallel_group` (snake_case) used in JSON schemas (Task 1)
- `parallel-group:` (kebab-case) used in markdown annotations (Tasks 2, 6, 11, 12, 13)
- `parallel_eligible: bool` consistent across Tasks 1, 2
- `cache_pinned_for_wave: bool` consistent across Tasks 1, 2 (set true in Task 2 dispatch, defined in Task 1)
- `protocol_violation` consistent across Tasks 2, 4, 13
- `abort_wave_on_protocol_violation` consistent across Tasks 4, 8, 13

Placeholder scan: No "TBD" / "TODO" / vague requirements. Each step has a concrete grep discriminator or verification command.

Forward-references handled: Task 2 mentions Task 3 / Task 4 by ID for the "intermediate state OK because no plans use parallel-group yet" context. Task 14 references all preceding tasks for the "complete first" rule.

---
