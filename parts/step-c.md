# Step C — Execute (wave dispatch + verify + archive)

<!-- Loads on demand: sourced from commands/masterplan.md L1372-2080
     Spec: docs/masterplan/v5-lazy-phase-prompts/spec.md#L70
     Allocated size: ~90K (execute: wave dispatch + verify + archive)
     Router loads this file when: user invokes /masterplan full, execute,
     or --resume=; or when Step A pick resolves to an in-progress plan;
     or when Step B's plan-emit B3 gate selects "Start execution now".
     Step 0 (parts/step-0.md) must already have run before this loads. -->

---

> **v5 DISPATCH-SITE convention.** All Agent dispatches originating from this phase file MUST tag their first prompt line as `DISPATCH-SITE: step-c.md:<label>` (e.g., `DISPATCH-SITE: step-c.md:wave-dispatch`, `DISPATCH-SITE: step-c.md:per-task-verify`, `DISPATCH-SITE: step-c.md:codex-eligibility-build`). This re-tags the v4 convention (which used step-name values like `Step C step 1`) to file-path-scoped values per spec §L70. The router's dispatch-site table (in `commands/masterplan.md`) is updated by Task 20.

> **Completion-event provenance (`dispatched_by`).** Every Step C event that records a task, wave, review, cache, or phase outcome MUST include `dispatched_by` using this canonical enum:
>
> | Value | Meaning |
> |---|---|
> | `codex` | Task dispatched via codex EXEC or codex REVIEW. |
> | `claude` | Task dispatched as a Claude inline action (no subagent). |
> | `wave-claude` | Task dispatched as a Claude Agent wave-member implementer. |
> | `user` | Task created/initiated by user action (for example, bundle bootstrap or Step C session/cache/finalizer outcomes). |

## Step C — Execute

**Entry breadcrumb.** Emit on first line of this step (per Step 0 §Breadcrumb emission contract):

```
<masterplan-trace step=step-c phase=in verb={requested_verb} halt_mode={halt_mode} autonomy={autonomy}>
```

Where `{requested_verb}` is the verb parsed by Step 0 (`full`, `execute`, `resume`, etc.), `{halt_mode}` is the resolved halt mode (always `none` here — the dispatch guard below skips Step C for other values), and `{autonomy}` is the resolved autonomy (`gated`/`loose`/`full`). The exit breadcrumb (per CC-3-trampoline) fires when Step C returns or closes the turn.

**Dispatch guard.** If `halt_mode != none`, skip Step C entirely — the B1 or B3 close-out gate already ended the turn. The only paths into Step C are: (a) `halt_mode == none` from kickoff or `execute`/`--resume=`; (b) the user explicitly flipped `halt_mode` to `none` via B3's "Start execution now" gate option. B3's gate is reached directly from `/masterplan plan` (and `plan --from-spec=`, Step A's spec-without-plan variant), or via `brainstorm` → B1's "Continue to plan now" → B2 → B3 (which still requires the user to pick "Start execution now" at B3 to enter Step C).

**Rehydrate or reconcile TaskCreate projection (Claude Code only — split by session signature).** Before entering the task loop, if `codex_host_suppressed == false`, branch on the new `state.step_c_session_init_sha` field:

1. **Compute current session signature** by shelling out: `current_sig=$(bin/masterplan-state.sh session-sig)`. This returns `${CLAUDE_SESSION_ID}` when set or a fresh v4 UUID otherwise. Do NOT read `CLAUDE_SESSION_ID` directly — the helper is the single source of truth.
2. **First entry of this session** (`state.step_c_session_init_sha == ""` OR `state.step_c_session_init_sha != current_sig`):
   - Run the full rehydration procedure from *TaskCreate projection layer — Rehydration trigger*.
   - Write `state.step_c_session_init_sha = current_sig` atomically with the rehydration write.
   - Append `step_c_init_complete` to `events.jsonl` with payload `{session_sig: <current_sig>, rehydrated: true, dispatched_by: "user"}`.
   - Issue the per-state-write `TaskUpdate(current_task, status=in_progress)` touch per *Per-state-write priming* below.
3. **Subsequent entry in same session** (`state.step_c_session_init_sha == current_sig`):
   - Run *Drift recovery* per *TaskCreate projection layer — Drift recovery*, scoped to `current_task` alignment + status counts (`in_progress count == 1` mid-wave; `pending count > 0` if waves remain).
   - Append `step_c_drift_check_complete` to `events.jsonl` with payload `{session_sig: <current_sig>, drift_corrected: <bool>, dispatched_by: "user"}`.
   - Issue the per-state-write `TaskUpdate(current_task, status=in_progress)` touch.

If `TaskCreate` / `TaskUpdate` dispatch errors at any point, append `taskcreate_mirror_failed` with the error string and proceed — `state.yml` is canonical and the next rehydration reconciles. Skip the entire block silently when `codex_host_suppressed == true`.

**Mirror every state.yml task-transition to TaskList (Claude Code only).** Throughout Step C, every write that changes `current_task`, dispatches a wave, records a wave-member digest, or flips `status` to `pending_retro` / `complete` / `blocked` MUST be followed by a `TaskUpdate` call per the transition table in *TaskCreate projection layer — Lifecycle mirror hooks*. The mirror call comes AFTER the `state.yml` write and the `events.jsonl` append, never before. If the `TaskUpdate` call errors, append `taskcreate_mirror_failed` to `events.jsonl` with `{call, task_idx, error}` and continue; **do NOT roll back the `state.yml` write** — `state.yml` is canonical and the next rehydration reconciles. Skip the entire mirror when `codex_host_suppressed == true`. The transition sites in Step C are: step 4 task-advance, step 3a wave dispatch, step 4b wave-member digest, step 6a-guard `pending_retro` flip, step 6 (post-retro) `complete` flip, and any `status: blocked` / `critical_error` write throughout the section.

**Per-state-write priming (v4.1.1, Claude Code only).** In addition to the per-transition mirror above, every Step C `state.yml` write — including writes that do NOT change `current_task` or wave state (e.g. `last_activity` bumps, `pending_gate` writes, `background` marker writes, `next_action` updates) — MUST be followed by:

```
if codex_host_suppressed == false AND state.current_task != "":
    TaskUpdate(task_id=<state.current_task's TaskList id>, status="in_progress")
```

This is an idempotent re-stamp; the task is already `in_progress` if the session is healthy. The purpose is to refresh the harness's recent-`Task*`-usage signal so the per-turn `<system-reminder>` is suppressed during idle-turn gaps between true transitions. The touch runs AFTER the `state.yml` write and AFTER the corresponding `events.jsonl` append. Failures append `taskcreate_mirror_failed` with `{call: "TaskUpdate-priming", task_idx, error}` and do NOT roll back the state write. Skip silently when `codex_host_suppressed == true` OR `current_task == ""` (between-task and pre-wave gaps).

The touch is **NOT** applied outside Step C (brainstorm, plan, halt-gate, doctor, import, audit, etc.) — those phases legitimately benefit from the harness reminder.

1. **Batched re-read.** Issue these as one parallel tool batch (not sequential):
   - Read `state.yml` (or a legacy status file only when the user explicitly chose one-invocation legacy mode).
   - Read the referenced bundled spec file.
   - Read the referenced bundled plan file.
   - `pwd` (Bash).
   - `git rev-parse --abbrev-ref HEAD` (Bash).

   **In-session mtime gating.** Maintain an orchestrator-memory cache `file_cache: {path → (mtime, content)}`. On a Step C entry within the **same session**, if a file's current mtime matches the cached mtime, reuse the cached content and skip the Read for that file. Cross-session entries (i.e. after a `ScheduleWakeup` resumption) start with an empty cache and always re-read. `state.yml` is **never** mtime-gated — always re-read live, since the orchestrator wrote it last and the user may have edited it between turns. Fail-safe: re-read on any doubt.

   Reconcile `current_task` against the plan's task list if the plan has been edited since the status was written.

   - **Parse guard.** If `state.yml` fails to parse as YAML, treat this as a safety-only critical error. If `events.jsonl` is still addressable from the path, append `critical_error_opened` with `code: state_parse_failed`; if not, render the recovery gate without writing. Surface immediately via `AskUserQuestion`: "State file at `<path>` is corrupted. Open it for manual fix / Run /masterplan doctor / Abort." Do NOT attempt to silently regenerate — the user's edits may have been intentional and partial.
   - **Pending-gate resume.** If `pending_gate` is non-null, set `stop_reason: question` if it is missing or stale, then re-render that exact structured question before doing any new routing. Clear it only after CD-7's explicit selection-evidence rule is satisfied, applying the selected option, appending `gate_closed` to `events.jsonl`, and clearing `stop_reason` unless the chosen option itself closes the turn.
   - **Background-dispatch resume.** If `background` is non-null, poll/re-read the recorded `agent_id` or `output_path` before any new task dispatch. Do not redispatch the current task until this check resolves:
     - If the background task is still running, persist `pending_gate`, set `stop_reason: question`, and surface `AskUserQuestion("Background task for <task> is still running. What next?", options=["Poll again now (Recommended)", "Schedule wakeup — resume this state later", "Pause here"])`. Under `/loop`, scheduling sets `stop_reason: scheduled_yield` after `wakeup_scheduled`; outside `/loop`, a plain pause remains resumable from the same `background` marker.
     - If the background task finished successfully, ingest the returned digest, append `background_finished`, set `background: null`, and continue at Step C step 4a/4d with that digest as the implementer result.
     - If the background task failed, timed out, or produced no readable output, append `background_failed`, persist `pending_gate`, set `stop_reason: question`, clear or keep the marker according to an `AskUserQuestion("Background task did not return usable output. What next?", options=["Rerun inline (Recommended)", "Keep waiting", "Clear marker and pause"])`, then route accordingly.
     - If the recorded output path is missing, treat that as ambiguous rather than success. The default route is inline rerun only after the user picks it.
   - **Complexity resolution on resume.** Re-run the Step 0 complexity-resolution rules using the just-loaded `state.yml` fields as the new tier-2 input.
     - If the resumed state lacks a `complexity:` field (legacy or hand-authored state), treat as `medium` and DO NOT write the field unless the user explicitly passes `--complexity=<level>` on this turn.
     - If `--complexity=<new>` is on the CLI AND `<new>` differs from the state value: update `complexity:` in `state.yml`, append a `complexity_changed` event with old/new/source, and use the new value for this run.
     - On every Step C entry (kickoff first entry OR resume), emit ONE `complexity_resolved` event per the format in Step 0's Complexity resolution subsection. Cite the resolved knob values that diverge from the complexity-derived defaults table (per Operational rules' Complexity precedence).
   - **Codex native goal reconciliation.** When `codex_host_suppressed == true`, call `get_goal` before task dispatch. If `codex_goal.objective` exists in `state.yml`, require the active native goal to match it before continuing; mismatch opens `pending_gate.id: codex_goal_conflict`. If no native goal exists and the plan is still `in-progress`, call `create_goal`, persist `codex_goal`, and append `codex_goal_created`. If the goal exists and matches, append at most one `codex_goal_linked` event per session and continue. This goal is not the source of task truth; `state.yml` remains authoritative for `phase`, `current_task`, `next_action`, and recovery.
   - **Verify the worktree.** Compare `state.yml`'s `worktree` field to the current working directory (from the `pwd` above). If they differ, `cd` into the recorded worktree before continuing. If the recorded worktree no longer exists (e.g. removed via `git worktree remove`), persist `pending_gate`, set `stop_reason: question`, append `question_opened`, then surface this as a safety gate via `AskUserQuestion`: "Worktree at `<path>` is missing. Recreate it / use the current worktree / abort."
   - **Verify the branch.** Compare the captured branch to `state.yml`'s `branch` field. If they differ, persist `pending_gate`, set `stop_reason: question`, append `question_opened`, then surface `AskUserQuestion`: "HEAD is on `<current-branch>` but the plan was started on `<recorded-branch>`. Switching silently could lose work." with options: **(1) Switch to `<recorded-branch>` first (Recommended)**, **(2) Continue on `<current-branch>` — I accept the divergence risk**, **(3) Abort the resume**. Apply the chosen action before proceeding to Step C step 1.

   **Complexity gate (eligibility cache).** When `resolved_complexity == low`, skip the entire eligibility-cache decision tree below — the cache file is NOT built and is NOT loaded. Step 3a's per-task lookup falls back to: `codex_routing` resolves to its complexity-derived default `off` at low (per Operational rules' Complexity precedence), so no delegation decision is needed per task. Doctor check #14 (orphan eligibility cache) does not flag absence on low plans (handled by Task 12's check-set gate).

   **Codex-host gate (eligibility cache).** When `codex_host_suppressed == true`, skip the entire eligibility-cache decision tree below — the cache file is NOT built, loaded, or required. Step 3a routes inline with `decision_source: host-suppressed`; Step 4b skips Codex review for the same reason. This is distinct from missing-plugin degradation: the Codex host is available, but recursive `codex:codex-rescue` dispatch is disabled by design.

   **Build eligibility cache.** When `codex_routing` is `auto` or `manual`, the cache lives at `<config.runs_path>/<slug>/eligibility-cache.json`. Decision tree for cache load (evaluated in order; first matching bullet wins):

   - **Wave-pin short-circuit.** If `cache_pinned_for_wave == true` (set by Step C step 2's wave dispatch), append the `eligibility_cache` event using the **Skip-with-pinned-cache** activity-log variant (see below) BEFORE short-circuiting, then skip the rest of this decision tree — the in-memory cache is already loaded and reused for the wave's duration. This emission satisfies the **Evidence-of-attempt event (v2.4.0+, MANDATORY)** rule below, which requires exactly one `eligibility_cache` event per Step C entry even when no cache rebuild/load occurs. The annotation-completeness scan does NOT run under wave pin.
   - **Skip entirely** when `codex_routing == off`.
   - **Cache file present, `cache.mtime > plan.mtime`** → load JSON from disk; **schema-version validate** (D.2 mitigation): if the loaded JSON lacks `cache_schema_version` OR `cache_schema_version != "1.0"`, treat as cache-miss → enter the Build path AND emit the **rebuilt — schema version mismatch** activity-log variant (see below). Otherwise load into `eligibility_cache`; skip both inline and Haiku paths.
   - **Cache file missing OR (present AND `plan.mtime >= cache.mtime`)** → enter the Build path:
     1. **Annotation-completeness scan** (orchestrator inline). For every `### Task N:` block in the plan, confirm BOTH (a) a `**Files:**` block is present and non-empty, AND (b) a `**Codex:** ok|no` line is present (case-sensitive on the literal tokens `ok` / `no`; any other value disqualifies — including `ok ` with trailing whitespace, `OK`, or `maybe`).
     2. **If the scan returns "complete"** → orchestrator builds cache **inline**: parse `**Codex:**`, `**parallel-group:**`, `**Files:**`, optional `**non-committing:**` annotations per task; apply the parallel-eligibility rules 1-5 below; emit the cache JSON shape including top-level `cache_schema_version: "1.0"` (see schema below); atomic-write per the **Cache write timing** contract below; load into `eligibility_cache`. Every task's `decision_source` field is stamped `"annotation"` by Step 3a (no heuristic was used, by construction). Inline path skips Haiku dispatch entirely.
     3. **If the scan returns "incomplete"** (any task lacks a well-formed annotation pair) → shard the build across N parallel Haikus and merge (v5.4.0+); orchestrator writes `eligibility-cache.json`; load into orchestrator memory as `eligibility_cache`. Reason: tasks without annotations require heuristic application (judgment), which belongs in a subagent per the context-control architecture. **Sharding strategy** (preserves rule-5 cohort visibility): if the plan has any `**parallel-group:**` annotations, one Haiku per distinct group plus one Haiku for the unassigned-tasks remainder (every task in a given group lands in the same shard so rule-5's no-file-overlap check sees the full cohort). If the plan has NO `**parallel-group:**` annotations, shard the task list into `ceil(task_count / 10)` ranges of ~10 tasks each (min 1, max 4 shards — beyond 4 the dispatch overhead exceeds the wall-clock win; plans of <10 tasks dispatch a single Haiku as before). **Merge.** Orchestrator dispatches all shards in ONE assistant message; once all shards return, concatenate every shard's `tasks` array, sort by `idx` ascending, validate contiguity (no gaps, no duplicates — any anomaly triggers fall-back to a single-shard rebuild), then atomic-write the merged JSON per the **Cache write timing** contract below. Set `cache_pinned_for_wave: false` on the merged cache (the pin flag is set later, at wave entry — sharding never sets it). **Plans with task_count ≤ 9 AND no parallel-groups** skip the shard logic entirely and dispatch a single Haiku as before (pre-v5.4.0 path) — added latency exceeds the win for small plans.
   - When Step 4d edits the plan inline, also `touch` the plan file so the mtime invariant holds for the next Step C entry's cache check.

   **Evidence-of-attempt event (v2.4.0+, MANDATORY).** Step C step 1 MUST append exactly one `eligibility_cache` event to `events.jsonl` per Step C entry recording the cache-build outcome — including the trivial `codex_routing == off` skip. This makes the silent-skip failure mode (the optoe-ng project-review pattern, where Step C step 1 ran zero times across an entire plan and no evidence remained) impossible to hide. Doctor check #21 surfaces the absence as a Warning at lint time.

   Format (one of these seven variants per Step C entry):

   ```
   - <ISO-ts> eligibility cache: built (<N> tasks; <K> codex-eligible) — first build for this plan
   - <ISO-ts> eligibility cache: built inline (<N> tasks; <K> codex-eligible) — all tasks annotated; first build for this plan
   - <ISO-ts> eligibility cache: rebuilt (<N> tasks; <K> codex-eligible) — plan.mtime > cache.mtime
   - <ISO-ts> eligibility cache: rebuilt inline (<N> tasks; <K> codex-eligible) — all tasks annotated; plan.mtime > cache.mtime
   - <ISO-ts> eligibility cache: loaded from disk (<N> tasks; <K> codex-eligible) — cache.mtime > plan.mtime
   - <ISO-ts> eligibility cache: skipped (codex_routing=off)
   - <ISO-ts> eligibility cache: skipped (codex degraded — plugin not detected this run; see codex_degraded event)
   - <ISO-ts> eligibility cache: skipped (running inside Codex — recursive codex dispatch disabled; see codex_host_suppressed event)
   - <ISO-ts> eligibility cache: rebuilt — schema version mismatch (<found>; expected 1.0)
   ```

   The event is appended ONCE per Step C entry, before any task-routing decisions. Every `eligibility_cache` event includes `dispatched_by: "user"` because the cache outcome is initiated by the current Step C invocation, not by a task implementer. Subsequent re-entries (e.g., resume after compaction) emit a new event per re-entry — that's intentional, `events.jsonl` becomes the canonical record of "did Step 1 run, when, and what did it conclude?" Cost is one small JSON object per Step C entry; negligible against the rotation threshold.

   **Inline-build verifier (CD-3 evidence anchor).** The annotation-completeness scan in the Build path step 1 IS the verifier that licenses the inline shortcut — analogous to Step 4a's implementer-return trust contract (see line ~996), where structured fields gate skipping redundant verification. The scan must pass for ALL tasks before the inline path activates: any malformed annotation, missing `**Files:**` block, or unknown `**Codex:**` value (e.g., `**Codex:** maybe`, `OK`, `ok ` with trailing whitespace) disqualifies the inline path and silently falls back to Haiku dispatch. Silent fallback is correct here — the Haiku is the standard path, not an error path; the orchestrator never trusts data it can't structurally validate. At `complexity == high`, writing-plans guarantees every task carries a well-formed `**Codex:**` annotation pair (see line ~540), so the inline path activates by construction; at `medium`, it activates opportunistically when annotations happen to be complete; at `low`, the entire decision tree is skipped per the **Complexity gate** above. Doctor #21's regex (`eligibility cache:`) matches both inline and Haiku-built variants — no doctor-side change is required.

   **Skip-with-pinned-cache exception**: when `cache_pinned_for_wave == true` (M-2 mitigation; see below), Step C step 1 skips the entire decision tree for the duration of the wave. In that case emit:

   ```
   - <ISO-ts> eligibility cache: pinned for wave (<group-name>; cache.mtime <T>)
   ```

   **Cache file shape** (JSON):
   ```json
   {
     "cache_schema_version": "1.0",
     "plan_path": "docs/masterplan/<slug>/plan.md",
     "plan_mtime_at_compute": "2026-05-01T14:32:00Z",
     "generated_at": "2026-05-01T14:32:01Z",
     "tasks": [
       {"idx": 1, "name": "...", "eligible": true,  "reason": "...", "annotated": null,
        "parallel_group": null, "files": [], "parallel_eligible": false, "parallel_eligibility_reason": "no parallel-group annotation",
        "dispatched_to": null, "dispatched_at": null, "decision_source": null},
       {"idx": 2, "name": "...", "eligible": false, "reason": "...", "annotated": "no",
        "parallel_group": "verification", "files": ["src/auth/*.py"], "parallel_eligible": true, "parallel_eligibility_reason": "all rules satisfied",
        "dispatched_to": "inline", "dispatched_at": "2026-05-01T14:33:12Z", "decision_source": "annotation"}
     ]
   }
   ```

   *Cache files lacking `parallel_group` / `files` / `parallel_eligible` / `parallel_eligibility_reason` (pre-v2.0.0 caches) are valid; load with `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today.*

   *`cache_schema_version` is bumped when the eligibility checklist or annotation parser changes; mismatch triggers rebuild. Current version: `1.0`. Pre-v2.8.0 caches lacking the field are treated as mismatch and rebuilt on next Step C entry per the schema-version validate rule above.*

   **Runtime-audit fields** (v2.4.0+): `dispatched_to` / `dispatched_at` / `decision_source` start as `null` at cache build time and are stamped by Step 3a at task-routing time:
   - `dispatched_to`: `"codex" | "inline" | "skipped" | null` — what the orchestrator actually did with this task. `null` until Step 3a routes the task.
   - `dispatched_at`: ISO-8601 UTC timestamp when Step 3a stamped `dispatched_to` (banner emit time, not task-completion time).
   - `decision_source`: `"annotation" | "heuristic" | "user-override-gated" | "user-override-manual" | "degraded-no-codex" | null` — *why* the routing decision was made.
     - `"annotation"` — `**Codex:** ok` or `**Codex:** no` in plan
     - `"heuristic"` — eligibility checklist made the call (no annotation)
     - `"user-override-gated"` — gated autonomy: user picked the routing in the per-task gate question
     - `"user-override-manual"` — manual codex_routing: user picked the routing in Step 3a's per-task `AskUserQuestion`
     - `"degraded-no-codex"` — Step 0 detected codex unavailable; `dispatched_to` will always be `"inline"` in this case
   Cache files lacking these fields (pre-v2.4.0 caches) are valid; treat as `null` and stamp on next routing.

   **Cache write timing**: Step 3a stamps the three runtime-audit fields *before* dispatching the task (so a mid-task crash leaves an honest record of intent, not pretending the task never started). Persist via in-place atomic JSON write (write to `<run-dir>/eligibility-cache.json.tmp`, fsync, rename) so a partial write can't corrupt the cache.

   **Bounded brief for the Haiku** (when dispatched): Goal=apply the Step C 3a Codex eligibility checklist AND the parallel-eligibility rules below to each task in the shard; emit a JSON object with top-level `cache_schema_version: "1.0"`, a `shard_id` field (string — e.g. `"group:verification"`, `"unassigned:1-10"`, or `"full"` when not sharded), and a `tasks` array of `{idx, name, eligible, reason, annotated, parallel_group, files, parallel_eligible, parallel_eligibility_reason, dispatched_to: null, dispatched_at: null, decision_source: null}` records covering ONLY the shard's task subset. Inputs=full plan task list + the shard's `task_indices` subset + plan annotations (`**Codex:**`, `**parallel-group:**`, `**Files:**` blocks, optional `**non-committing:**` override). The full plan is provided so rule-5 (no file-path overlap within a `parallel-group`) sees the entire cohort; the `task_indices` subset gates which tasks appear in the return. Scope=read-only. Return=JSON only — no narration. Runtime-audit fields are always `null` at cache build time; Step 3a fills them. When sharding is bypassed (≤9 tasks, no parallel-groups), the single Haiku receives `task_indices` covering all tasks and returns `shard_id: "full"` — orchestrator's merge step is a no-op pass-through.

   **Parallel-eligibility rules** (apply per task; record `parallel_eligible: true` only when ALL hold):
   1. `**parallel-group:** <name>` annotation is set.
   2. `**Files:**` block is present and non-empty.
   3. Task is non-committing — declared scope is read-only OR write-to-gitignored-paths only (`coverage/`, `.tsbuildinfo`, `dist/`, `build/`, `target/`, `out/`, `.next/`, `.nuxt/`, `node_modules/`, generated/codegen output dirs). Heuristic: no Create/Modify paths under tracked dirs. Edge case: explicit `**non-committing: true**` annotation overrides.
   4. `**Codex:**` is NOT `ok` (FM-4 mitigation — Codex-routed tasks fall out of waves).
   5. No file-path overlap with any other task in the same `parallel-group:`. Cache-build-time check across the parallel-group cohort.

   When a rule fails, set `parallel_eligible: false` and `parallel_eligibility_reason` to a one-line explanation citing the failing rule. Overlap (rule 5) emits the involved task indices in the reason.

   **Cache pin during parallel waves (M-2 mitigation, Slice α v2.0.0+).** Maintain an in-memory `cache_pinned_for_wave: bool` flag (default `false`). Set to `true` at the START of a parallel wave dispatch (Step C step 2 wave-mode entry). When `cache_pinned_for_wave == true`, the `cache.mtime > plan.mtime` invariant is suppressed — the loaded cache is reused for the wave's duration regardless of plan.md edits. Wave-end clears the pin (sets to `false`) and re-evaluates the invariant; cache rebuild fires if the user (not an implementer) edited plan.md mid-wave. Wave members are forbidden from editing plan.md per the in-wave scope rule in **Operational rules**.

   **Resume sanity check (v2.4.0+, P3 from Fix 1-5 follow-up).** After cache load completes (whether built fresh, loaded from disk, or skipped per `codex_routing == off`), AND when this Step C entry is a *resume* (not first entry — detected by ≥1 prior task-completion event in `events.jsonl` or the legacy status adapter), perform a **silent-skip footprint scan**:

   1. Parse task-completion events for any entry that:
      - Refers to a task whose plan annotation is `**Codex:** ok` (cross-reference: load plan, find the `**Codex:**` line in that task's `**Files:**` block).
      - AND lacks both `[codex]` and `[inline]` post-completion tags (the optoe-ng pattern — no routing tag at all).
      - OR carries `[inline]` BUT no preceding `routing→INLINE` pre-dispatch entry with `decision_source: degraded-no-codex` (the "ran inline silently with no degradation explanation" case).
   2. Count matching entries as `silent_skip_count`.
   3. If `silent_skip_count == 0`, no warning. Continue Step C.
   4. If `silent_skip_count > 0` AND no prior `silent_codex_skip_warning` event already records the finding (suppress duplicate warnings across resumes):
      - Append one `silent_codex_skip_warning` event: `<N> previously-completed task(s) annotated **Codex:** ok ran inline without a recorded codex-degradation reason. Likely cause: an earlier session's Step 0 codex-availability detection silently bypassed routing. Tasks: <comma-separated task indices>.`
      - Surface via `AskUserQuestion`:
        - Question: `"Detected <N> previously-completed task(s) annotated **Codex:** ok that ran inline without a recorded codex-degradation reason. This usually means a prior session silently bypassed codex routing. How to proceed?"`
        - Options:
          1. `Continue, accept the gap` (Recommended for completed plans) — keeps the warning event, proceeds with Step C.
          2. `Run /masterplan doctor now` — exit Step C, route to Step D for repo-wide lint.
          3. `Investigate transcript` — print the suspected session-id from the corresponding telemetry record (parse `<run-dir>/telemetry.jsonl` or the legacy telemetry path for the entry whose `tasks_completed_this_turn` delta covers the silent-skip task, emit `session_id` if present), then continue Step C.
          4. `Suppress (this plan)` — set `silent_skip_warning_dismissed: true` in `state.yml`; future resumes skip this warning. For users who've decided the gap is acceptable.

   **Why P3 exists**: even with P1's mandatory cache-build evidence entry (above) AND P2's Step 3a precondition (below), pre-v2.4.0 plans have no such evidence and would slip through forever without an explicit forensic pass. P3 catches them on the next resume — one-shot recovery, then suppress.

   **Why persist:** the cache is a pure function of plan-file content. Recomputing on every wakeup (~10 wakeups for a 30-task plan under `loose`) burns Haiku calls for no signal change. Disk persistence with mtime invalidation costs one stat per Step C entry.

   **Auto-compact nudge (resume).** If `config.auto_compact.enabled && compact_loop_recommended == false && !auto_compact_nudge_suppressed`, output the same one-line passive notice as Step B3, then flip `compact_loop_recommended: true` in `state.yml`. Once-per-plan suppression catches kickoffs that didn't fire (e.g., imported plans).

   **CC-1 dismissal scan.** Scan state/events for `compact_suggest: off`. If present, set `cc1_silenced: true` in orchestrator memory for this run. CC-1 (operational rules) honors this flag.

   **Telemetry inline snapshot.** If `resolved_complexity == low`, skip telemetry entirely (no JSONL append regardless of `config.telemetry.enabled` or `telemetry: off`; doctor #13 does not flag absence on low plans). Otherwise: if `config.telemetry.enabled` and `state.yml` does NOT include `telemetry: off`, first ensure local Git excludes protect all telemetry sidecars before writing, including `**/docs/masterplan/*/telemetry.jsonl` and `**/docs/masterplan/*/subagents.jsonl`; then verify the would-be sidecar path is untracked and ignored. If any sidecar is tracked or cannot be ignored, skip telemetry for this turn and append a `telemetry_suppressed` event explaining why. Otherwise append one JSONL record (kind=`step_c_entry`) to `<config.runs_path>/<slug>/telemetry.jsonl`. Per-subagent dispatch details are captured separately by the Stop hook into `<config.runs_path>/<slug>/subagents.jsonl`. Cheap (one append).

   **Gated→loose switch offer (v2.1.0+).** When `autonomy == gated` AND `config.gated_switch_offer_at_tasks > 0`, check whether to offer the user a one-time switch to `--autonomy=loose` for the remainder of this plan. Skip conditions (any one suppresses the offer):

   - `state.yml` has `gated_switch_offer_dismissed: true` (per-plan permanent dismissal — set when user picks "Stay on gated AND don't ask again on this plan").
   - `state.yml` has `gated_switch_offer_shown: true` (per-session suppression — set when user picks "Stay on gated").
   - Plan's task count < `config.gated_switch_offer_at_tasks` (default 15).

   Otherwise, surface:

   ```
   AskUserQuestion(
     question="This plan has <N> tasks under --autonomy=gated. Each task fires a continue/skip/stop gate. Switch to --autonomy=loose for the remainder?",
     options=[
       "Switch to --autonomy=loose (CD-4 ladder + blocker re-engagement gate handle surprises) (Recommended for trusted plans)",
       "Stay on gated — I want to review each task",
       "Switch to loose AND don't ask again on any plan",
       "Stay on gated AND don't ask again on this plan"
     ]
   )
   ```

   On each option:
   - **"Switch to --autonomy=loose"** → flip in-session `autonomy` to `loose`; persist to `state.yml`'s `autonomy:` field; append a `gated_loose_offer` event. Continue Step C step 1.
   - **"Stay on gated"** → set `gated_switch_offer_shown: true` in `state.yml` (suppresses the offer for this session; re-fires on cross-session resume by design — gives the user another chance after a break). Continue.
   - **"Switch to loose AND don't ask again on any plan"** → flip autonomy to loose AND append an event: *"User opted out of gated->loose offer on all plans. Add `gated_switch_offer_at_tasks: 0` to your `~/.masterplan.yaml` to suppress permanently."* The orchestrator does NOT modify the user's config file (CD-2 — config files are user-owned). Continue.
   - **"Stay on gated AND don't ask again on this plan"** → set `gated_switch_offer_dismissed: true` in `state.yml` (permanent for this plan). Continue.

   `events.jsonl` records which option was picked: `gated->loose offer: <picked option>`.

   **Competing-scheduler check.** Defends against the duplicate-pacer footgun where this plan has both a `/loop`-driven `ScheduleWakeup` AND a separate cron entry that targets `/masterplan` on the same `state.yml` (typically a stale `/schedule` one-shot, or a cron from a prior session). Two pacers race on the state file, double-write event entries, and may trigger overlapping subagent dispatch. Note: this check fires AFTER the current resume already started — it cannot prevent the very-next concurrent firing, only future ones.

   Skip conditions (any one suppresses the check):
   - `ScheduleWakeup` is not available this session (not invoked under `/loop`, so there is no second pacer to compete with).
   - `state.yml` has `competing_scheduler_acknowledged: true` (per-plan permanent dismissal — set when user picks "Keep both" below). Note: this field is OPTIONAL; it is intentionally NOT in doctor check #9's required-fields list.

   Otherwise: ensure the deferred-tool schemas are loaded — if `CronList` / `CronDelete` are not callable in this session, call `ToolSearch(query="select:CronList,CronDelete")` first. If `ToolSearch` itself fails or the schemas don't load, skip the check silently (graceful degrade).

   Then call `CronList` once. **Match heuristic:** a cron is competing iff its prompt **starts with `/masterplan`** AND its prompt contains either the `state.yml` path, the legacy status basename, or the run slug. If zero matches, no question is surfaced (silent skip).

   On match, surface ONE `AskUserQuestion`:

   ```
   AskUserQuestion(
     question="A cron entry (id <cron-id>, schedule <human-readable>, prompt <prompt>) is already scheduled to invoke /masterplan on this plan. Combined with /loop's ScheduleWakeup self-pacing, this resumes the plan twice on each firing — racing on the state file. How to proceed?",
     options=[
       "Delete the cron, keep /loop wakeups (Recommended)",
       "Keep the cron, suspend wakeups this session",
       "Keep both — I know what I'm doing",
       "Abort — end turn so I can investigate manually"
     ]
   )
   ```

   On each option:
   - **"Delete the cron, keep /loop wakeups"** → call `CronDelete(<cron-id>)`; append a `competing_scheduler_removed` event with the cron id/prompt and timestamp. Continue Step C step 1.
   - **"Keep the cron, suspend wakeups this session"** → set in-memory `competing_scheduler_keep: true`. Step C step 5 reads this flag and skips its `ScheduleWakeup` call for the rest of the session. Cross-session resume re-fires this check, giving the user another chance to reconsider. Continue Step C step 1.
   - **"Keep both — I know what I'm doing"** → append a `competing_scheduler_acknowledged` event noting the cron id/prompt and risk, AND set `competing_scheduler_acknowledged: true` in `state.yml` (suppresses this check on future resumes). Continue normally; both pacers run.
   - **"Abort"** → end turn without further action; user resolves manually.

   If multiple competing crons match (unusual), batch them into a single question — list each `<cron-id>: <prompt>` line in the question body, and apply the chosen option to ALL of them (e.g., delete all on option 1).

**Wave assembly pre-pass (Slice α v2.0.0+).** Before invoking the per-task implementer, scan the upcoming task list against the eligibility cache for parallel-eligible tasks (`parallel_eligible == true`).

1. Read upcoming task pointer from `state.yml` (`current_task` + plan task list).
2. Walk forward in plan-order from `current_task`. Collect contiguous tasks with the SAME `parallel_group` value into a wave candidate. Stop at the first task that has a different `parallel_group`, has no `parallel_group`, or has `parallel_eligible == false`.
3. Wave size: ≥ 2 tasks, capped at `config.parallelism.max_wave_size` (default `5`). Tasks beyond cap roll into the next wave.
4. Edge case: wave candidate of size 1 → execute serially (fall through to standard per-task dispatch).
5. **Interleaved groups do not parallelize.** Plan-order is authoritative; the contiguous-walk rule produces multiple single-task wave candidates if parallel-grouped tasks are interleaved with serial tasks. Planner is responsible for ordering parallel-grouped tasks contiguously to enable wave dispatch.
6. **If `config.parallelism.enabled == false`** (global kill switch from `--no-parallelism` flag or config), skip wave assembly entirely — fall through to the standard serial loop.

**When a wave assembles** (≥ 2 tasks): append a `wave_routing_summary` visibility event at wave-entry with shape `{wave, members_by_route: {codex: N, inline_review: N, inline_no_review: N}}`, where `wave` identifies the parallel group / task-index span and `members_by_route` counts the assembled wave members by their Step 3a route bucket. Then set `cache_pinned_for_wave: true`. Dispatch all N implementer subagents as parallel `Agent` tool calls in a single assistant turn (existing pattern in Step I3.2/I3.4). **Pass `model: "sonnet"` on each Agent call** per §Agent dispatch contract — wave members are general-purpose implementers, not Opus-grade reasoning. Each instance gets the standard implementer brief PLUS three wave-specific clauses:

> *"WAVE CONTEXT: You are dispatched as part of a parallel wave of N tasks (group: `<name>`). Your declared scope is `**Files:**` (exhaustive — do not read or modify anything outside this list, including plan.md, state.yml, events.jsonl, sibling tasks' scopes, or the eligibility cache). Capture `git rev-parse HEAD` BEFORE any work; return as `task_start_sha` (required per existing implementer-return contract). DO NOT commit your work — return staged-changes digest only. DO NOT update run state — orchestrator handles batched wave-end updates. Failure handling: if you BLOCK or NEEDS_CONTEXT, return immediately; orchestrator's blocker re-engagement gate handles you alongside the rest of the wave."*

> *"Return shape: `{task_idx, status: completed|blocked, task_start_sha, files_changed: [paths], staged_changes_digest: 1-3 lines, tests_passed: bool, commands_run: [str], commands_run_excerpts: {cmd → [str]}, blocker_reason?: str}`. NO commits. NO run-state writes. `commands_run_excerpts` is REQUIRED (v2.8.0+, G.1 mitigation): 1–3 trailing output lines per executed command, used by Step 4a's excerpt-validator before honoring the trust-skip. (The orchestrator's post-barrier reconciliation may reclassify `completed` to `protocol_violation` if it detects a commit, an out-of-scope write, or a state modification.)"*

**Wave-completion barrier.** Orchestrator waits for all N Agent calls to return before proceeding. Returns aggregate as a digest list. Wave-end clears `cache_pinned_for_wave` (sets to `false`).

**Post-hoc slow-member detection (E.1 mitigation, v2.8.0+).** The LLM orchestrator has no async/cancel primitive — it cannot actively kill a hung wave member while the harness is still gathering tool results. Instead, after the barrier returns, the orchestrator reads `<run-dir>/subagents.jsonl` (written by `hooks/masterplan-telemetry.sh` Stop hook on the *previous* turn — so this scan runs at the NEXT Step C entry, not in the current turn) and classifies each wave member with `duration_ms > config.parallelism.member_timeout_sec * 1000` as `slow_member` per `config.parallelism.on_member_timeout`. If the telemetry hook is not installed, the scan emits a `slow_member_scan_skipped` event and otherwise no-ops. Detection is observability, not active cancellation: a truly hung member is bounded by the harness's own timeout, not by anything the orchestrator can write into this prompt.

After the wave-completion barrier, proceed to Step C 4-series (4a/4b/4c/4d) for the wave per the wave-mode notes in those sub-steps. Then Step C step 5's wakeup-scheduling threshold uses wave count, not task count (a wave-end counts as ONE completion regardless of N).

2. If `--no-subagents` is set: invoke `superpowers:executing-plans`. Otherwise: invoke `superpowers:subagent-driven-development`. Hand the invoked skill the plan path and the current task index.

   **Emit skill-invoke breadcrumb** immediately before the `Skill` tool call (per Step 0 §Breadcrumb emission contract):

   ```
   <masterplan-trace skill-invoke name={subagent-driven-development|executing-plans} args=task=<idx>>
   ```

   **On skill return**, emit skill-return breadcrumb on the first orchestrator line of the post-skill assistant turn:

   ```
   <masterplan-trace skill-return name={subagent-driven-development|executing-plans} expected-next-step=step-c-4a-verify>
   ```

   The skill-return marker MUST appear before any other Step C work resumes; absence of this marker after a `Skill` tool result is the `silent-stop-after-skill` anomaly class.
 Brief the implementer subagent with **CD-1, CD-2, CD-3, CD-6** AND prepend the verbatim SDD model-passthrough preamble (defined in §Agent dispatch contract recursive-application — copy the fenced text block literally; do not paraphrase). The preamble's signature string `For every inner Task / Agent invocation you make` is what the audit script and downstream tools key on. This preamble is required because SDD's prompt-template files (`implementer-prompt.md`, `spec-reviewer-prompt.md`, `code-quality-reviewer-prompt.md`) are upstream and don't carry model parameters by default — without the override, the inner Task calls inherit the orchestrator's Opus and the wave's `model: "sonnet"` discipline doesn't propagate. (Wave-mode tasks bypass this step's serial dispatch — they were already dispatched in the wave assembly pre-pass above.)
3. Layer the autonomy policy on top of the invoked skill's per-task loop:
   - **`gated`** — before each task, call `AskUserQuestion(continue / skip-this-task / stop).` Honor the answer. **Routing decisions made via the eligibility cache (under `codex_routing == auto`) are honored silently** — the per-task question is NOT expanded with a Codex-override option, since the user pre-configured auto-routing and `events.jsonl` records every decision post-hoc. Users who want the legacy expanded prompt set `codex.confirm_auto_routing: true` in `.masterplan.yaml`; in that case the question expands to `(continue inline / continue via Codex / skip / stop)`. Under `codex_routing == manual`, do NOT expand here — Step 3a's per-task `AskUserQuestion` already handles routing.
   - **`loose`** — run autonomously. On a blocker, **apply CD-4** first; only after two rungs have failed, persist a blocker event and surface the **blocker re-engagement gate** below. Keep `status: in-progress` unless the user explicitly marks the condition as a critical error. Cite the rungs tried in the blocker event. Do NOT reschedule a wakeup unless the gate option selected is a scheduled continuation.
   - **`full`** — run autonomously, applying **CD-4** more aggressively before escalating: at least two ladder rungs, plus `superpowers:systematic-debugging` for test failures and spec reinterpretation cited in `events.jsonl`. Escalate to the **blocker re-engagement gate** only after the full ladder fails.

   **Blocker re-engagement gate (applies under all autonomy modes when a blocker surfaces).** Before closing the turn for an ordinary blocker, the orchestrator MUST persist `pending_gate`, set `stop_reason: question`, append `question_opened`, and surface `AskUserQuestion` so the user has a clear continuation path. Never just write a blocker event and end silently — the user wakes up later to a state update with no clear next move, the same UX the spec/plan-gate fix addressed. Concrete pattern (covers SDD's BLOCKED/NEEDS_CONTEXT escalations AND CD-4-exhausted gates):

   **Emit gate breadcrumb** immediately before the AskUserQuestion call (per Step 0 §Breadcrumb emission contract):

   ```
   <masterplan-trace gate=fire id=blocker_reengagement auq-options=4>
   ```

   ```
   AskUserQuestion(
     question="Task <name> is blocked. <one-line summary of what was tried via CD-4 ladder>. How to proceed?",
     options=[
       "Provide context and re-dispatch — I'll type the missing context, you re-dispatch the implementer with it",
       "Re-dispatch with a stronger model (Opus instead of Sonnet) — escalate model tier",
       "Skip this task and continue with the next one — append a blocker event but keep status: in-progress",
       "Record critical error and stop — continuing would risk user work or invalid state"
     ]
   )
   ```

   The first three options KEEP the plan moving (`status: in-progress`). The fourth option is safety-only: set `status: blocked`, `phase: critical_error`, `stop_reason: critical_error`, populate `critical_error`, append `critical_error_opened`, then close. Under `--autonomy=full`, do not pre-select the fourth option; a critical-error stop requires explicit evidence or one of the safety-only critical-error classes listed in the Loop-first stop contract. (Option count is capped at 4 per CD-9.)

   Activity log records which option was picked (e.g., `task X blocked, user chose: re-dispatch with Opus`).

   **Re-dispatch handling for option 2 (stronger model).** When the user picks "Re-dispatch with a stronger model," the orchestrator re-dispatches the implementer with `model: "opus"` on the Agent call (overriding the default `model: "sonnet"` per §Agent dispatch contract). The override applies to ONE re-dispatch attempt per blocker pick; subsequent retries fall back to `model: "sonnet"` unless the user picks option 2 again. Activity log entry: `task X re-dispatched with model=opus per blocker gate`.

   **Wave-mode failure handling (Slice α v2.0.0+).** When Step C step 2's wave assembly dispatched a wave, blocker handling differs from serial:

   **Per-member outcomes.** Two are returned by SDD instances; one is detected by the orchestrator post-barrier:

   - `completed` — returned by SDD instance: task succeeded; verification passed; staged-changes digest captured.
   - `blocked` — returned by SDD instance: task hit a blocker; reason returned.
   - `protocol_violation` — **detected by orchestrator post-return** (not returned by SDD). After the wave-completion barrier, orchestrator runs `git status --porcelain` and `git log <task_start_sha>..HEAD` per wave member; if a member committed despite "DO NOT commit", wrote outside its `**Files:**` scope, or modified `state.yml` / `events.jsonl` directly, orchestrator reclassifies the SDD-reported `completed` outcome as `protocol_violation`. Treated as blocked + flagged for manual review.
   - `slow_member` — **detected by orchestrator at the NEXT Step C entry** via the post-hoc scan above (E.1 mitigation, v2.8.0+). A member that returned `completed` or `blocked` but whose `duration_ms` exceeded `config.parallelism.member_timeout_sec * 1000` is annotated as `slow_member` *in addition to* its primary outcome (the digest is still honored — slow ≠ wrong). Wave-level outcome computation treats `slow_member` as a tag, not a state — see wave-level rules below for handling per `config.parallelism.on_member_timeout`.

   **Wave-level outcome.** Computed from per-member outcomes:

   - **All completed** → wave succeeds. Single-writer 4d update applies all N completions. Status remains `in-progress` (or flips to `complete` if last task in plan).
   - **All blocked** → wave pauses for recovery. 4d appends N blocker events; status remains `in-progress`; the blocker re-engagement gate (above) fires ONCE, listing all N blocked tasks together. Each option's semantics extend naturally (Provide context: re-dispatch all N as a sub-wave; Stronger model: re-dispatch all N with Opus override; Skip: all N get blocker events, wave-count advances; Record critical error: status flips to `blocked` with `stop_reason: critical_error`).
   - **Partial (K completed, N-K blocked, K ≥ 1, N-K ≥ 1)** → wave completes-with-blockers. 4d appends K completed events AND N-K blocker events. Status remains `in-progress`; the blocker re-engagement gate fires once, listing the N-K blocked tasks. **The completed K tasks' digests are NOT discarded** — applied by the single-writer 4d update BEFORE the gate fires (standard partial-failure case).

   **Protocol violation handling.** If `config.parallelism.abort_wave_on_protocol_violation: true` (default), orchestrator **suppresses the 4d batch entirely** when ANY wave member is reclassified as `protocol_violation` — none of the K completed digests are applied. Wave is treated as fully blocked; completed digests remain in orchestrator memory and become available to the gate's "Skip" branch (re-applied as events when advancing past the wave). Append a `protocol_violation` event: *"task `<name>` committed `<commit-sha>` despite wave instruction. Verify manually before continuing — wave-end state update was suppressed."* If `abort_wave_on_protocol_violation: false`, the standard partial-failure path applies (K digests applied, N-K blockers including the violator).

   **Slow-member handling (E.1 mitigation, v2.8.0+).** Per the post-hoc scan in the per-member outcomes section, members with `duration_ms > config.parallelism.member_timeout_sec * 1000` get the `slow_member` tag at the NEXT Step C entry. Behavior depends on `config.parallelism.on_member_timeout`:
   - **`warn`** (default) — append a `slow_member` warning event: *"Slow wave member: task `<name>` (idx `<i>`) ran `<dur>s` (member_timeout_sec=`<N>`s). Wave: `<group-name>`. Digest was honored normally; investigate the underlying task or raise the threshold."* The completed/blocked outcome is honored as-is — slow does not block forward progress.
   - **`blocker`** — re-classify the slow member as blocked at the next Step C entry: append a corrective event that supersedes the prior completion, restore the prior `current_task` pointer to the slow member's index, append a blocker event: *"Wave member `<name>` exceeded member_timeout_sec (`<dur>s` vs `<N>s`). Operator review required before continuing."*, keep `status: in-progress`, and route through the blocker re-engagement gate. Use this when the plan's correctness depends on bounded wave times (e.g., CI-bounded plans where slow members would push downstream tasks past a deadline).

   **Edge case: SDD escalates BLOCKED/NEEDS_CONTEXT mid-wave.** When an SDD instance returns BLOCKED/NEEDS_CONTEXT BEFORE the wave-completion barrier, orchestrator does NOT immediately fire the blocker re-engagement gate — it waits for the rest of the wave. Gate fires once at wave-end with the union of all blocked members. Cleanest UX: one gate firing per wave, not N firings.

   **Mid-wave orchestrator interruption.** If orchestrator crashes / context-resets after dispatch but before barrier returns, next session enters Step C step 1 with `state.yml` showing `current_task = <first wave task>` (unchanged — wave-end update never fired). Re-build cache, re-dispatch the wave from scratch. **Idempotent by Slice α design** — wave members are read-only, so re-dispatching is safe (no double-commits, no double-writes).

3a. **Codex routing decision per task** (consult `config.codex.routing`, overridden by `--codex=` flag, persisted as `codex_routing` in `state.yml`):

    **Precondition (v2.4.0+; P2 from Fix 1-5 follow-up).** Before evaluating routing for ANY task, verify orchestrator runtime state. This is the **fail-loud-don't-fall-through** rule that catches the optoe-ng failure pattern (where Step C step 1 was silently skipped and routing fell through to inline forever).

    - IF `codex_host_suppressed == true` → no precondition; skip the cache lookup; proceed inline with `decision_source: host-suppressed`. This branch is mandatory even when persisted `codex_routing` is `auto` or `manual`, because running inside Codex must never recursively call `codex:codex-rescue`.
    - IF `codex_routing == off` → no precondition; skip the cache lookup; proceed to inline routing as today.
    - ELIF `eligibility_cache` is loaded in orchestrator memory AND has an entry for this task (`eligibility_cache[task_idx]` exists) → proceed with routing per the bullets below.
    - ELSE → **HALT.** This is a Failure-2 footprint (Step C step 1 was skipped, returned without building the cache, or the cache load failed silently). Do NOT silently fall through to inline. Behavior depends on `config.codex.unavailable_policy` (P4):
      - **`degrade-loudly`** (default) — surface via `AskUserQuestion`:
        - Question: `"Codex routing is set to '<routing>' but the eligibility cache is missing or has no entry for task <task_idx>. This usually means Step 0's codex-availability detection silently bypassed cache build. How to proceed?"`
        - Options:
          1. `Rebuild cache now` (Recommended) — re-enter Step C step 1's Haiku dispatch path; on success, retry routing for this task. Append the rebuild evidence entry per P1's format.
          2. `Run inline this run with degradation marker` — behave as if Step 0 had detected codex unavailable: write the Fix 1 degradation event, set in-memory `codex_routing = off` for the rest of the session, proceed inline. Each subsequent task's pre-dispatch banner uses `decision_source: degraded-no-codex` per Fix 5 step 1.
          3. `Set codex_routing: off in state.yml and proceed` — this IS a state-file modification beyond the hard-coded Step 4d writes; it requires explicit user opt-in via this question, and the change is announced via an event. Proceed without codex permanently for this plan. Future resumes won't see the precondition halt.
          4. `Abort` — → CLOSE-TURN, status unchanged, no inline fallthrough. User investigates manually.
      - **`block`** — skip the AskUserQuestion entirely. **Single-writer exception under explicit user opt-in**: this is one of the few state writes outside Step 4d. The opt-in is `config.codex.unavailable_policy: block` itself — the user explicitly chose hard-halt over silent inline. Wave-mode interaction: if currently dispatched within a parallel wave, defer the block-write until wave-end (when the wave-completion barrier returns) and apply it through Step 4d's same write path with the blocker event appended to the wave-end batch. This preserves the single-writer rule for waves. For serial routing (no wave active), the block-write happens immediately as described.

        Effects: Set `status: blocked`, `phase: critical_error`, `stop_reason: critical_error`, and `critical_error.code: codex_routing_precondition_failed`. Append `critical_error_opened`: *"Codex routing precondition failed: eligibility_cache missing under codex_routing=<routing>. config.codex.unavailable_policy=block; user opted into hard-halt over silent inline. Re-run with codex installed (orchestrator will rebuild cache) OR set codex_routing: off in state.yml."*. → CLOSE-TURN [pre-close: critical-error state + event done above].

    **Why P2 exists**: the orchestrator's previous default (silent fallthrough to inline when cache was missing) was the root cause of the optoe-ng project-review zero-codex pattern. P2 turns that silent failure into a loud one. Combined with P1's evidence-of-attempt entry, the orchestrator either has cache + tags OR has loud user-facing prompts + persistent markers — never quiet inline-bypass.

    - **Host-suppressed** (`codex_host_suppressed == true`) — never delegate. Run every task inline in the current Codex host and record `decision_source: host-suppressed`; do not consult or build `eligibility_cache`.
    - **`off`** — never delegate. Run every task inline (Claude or Claude subagent). Skip the cache lookup.
    - **`auto`** (default per CLAUDE.md "Codex Delegation Default") — look up `eligibility_cache[task_idx]` (computed in Step 1). If `eligible == true` → delegate. Otherwise run inline.
    - **`manual`** — present `eligibility_cache[task_idx]` via `AskUserQuestion(Delegate to Codex / Run inline / Skip)` before each task. User decides.

    **Pre-dispatch routing visibility** (v2.4.0+, mandatory for every task whose `state.yml` has `codex_routing != off` AND every task affected by Step 0 codex degradation):

    1. **Stdout banner** — emit ONE visible top-level line at the moment the routing decision is made, BEFORE any subagent or Codex dispatch:
       ```
       → Task T<idx> (<task name>) → CODEX (<one-line reason>)
       → Task T<idx> (<task name>) → INLINE (<one-line reason>)
       ```
       Reason templates by `decision_source`:
       - `"annotation"` → `annotated **Codex:** ok` or `annotated **Codex:** no — <reason text from plan if present>`
       - `"heuristic"` → `heuristic: <eligibility checklist short-form, e.g. "small + bounded + clear acceptance" or "rejected: design-judgment-required">`
       - `"user-override-gated"` → `gated gate: user chose <continue via Codex|continue inline>`
       - `"user-override-manual"` → `manual mode: user picked <Delegate to Codex|Run inline>`
       - `"degraded-no-codex"` → `inline (codex degraded — plugin missing)` — append the Step 0 degradation suffix per Fix 1 step 4
       - `"host-suppressed"` → `inline (running inside Codex — recursive codex:codex-rescue disabled)`

       The banner exists because today /masterplan loops are observed via stdout/transcript with no other surface signal that a task is being routed; the post-completion `[codex]/[inline]` tag arrives after work is done, not before. The banner makes routing observable in real-time.

    2. **Pre-dispatch event** — append ONE event to `events.jsonl` BEFORE dispatching:
       ```
       - <ISO-ts> task "<task name>" routing→CODEX (<decision_source>; <files-count> files in scope; dispatched_by: "codex")
       - <ISO-ts> task "<task name>" routing→INLINE (<decision_source>; <reason>; dispatched_by: "claude")
       ```
       The post-completion event is unchanged — it still appears as a SECOND event per task with the existing `[codex]` or `[inline]` tag and verification details in `message`. Two events per task is the price for being able to grep `routing→` across state bundles for an unambiguous, searchable routing-decision audit independent of completion outcomes.

    3. **Cache stamp** — before dispatching, update `eligibility_cache[task_idx]`:
       - `dispatched_to: "codex" | "inline"` (matching the banner)
       - `dispatched_at: <ISO-ts>` (matching the banner timestamp)
       - `decision_source: <one of the values listed in §Cache file shape>`
       Persist via atomic JSON write (see §Runtime-audit fields above). A mid-task crash leaves the cache truthful about routing intent.

    **Skip rule**: when `codex_routing == off` (no codex consideration was ever in scope), the pre-dispatch banner and event are SKIPPED — there's no routing decision to surface, only execution. The post-completion event has no `[codex]/[inline]` tag in this mode either; current behavior is preserved.

    **Eligibility checklist** (applied once at plan-load by the Step 1 cache builder, then reused per task — listed here for reference and so the cache builder's brief is reproducible):
    - Task touches ≤ 3 files based on its description, OR plan annotates `**Codex:** ok`.
    - Task description is unambiguous (no "consider", "decide", "choose between", "design", "explore" verbs).
    - Verification commands are known (plan task includes a test or verify step).
    - Task does NOT involve: secrets, OAuth/browser auth, production deploys, destructive ops, schema migrations, broad design judgment, or modifying files outside the stated scope.
    - Task does NOT reference conversational context that isn't captured in the spec or plan.
    - Plan does NOT annotate `**Codex:** no` on this task.

    **Plan annotations** (override the heuristic when present, recorded in cache as `annotated: "ok"|"no"`):

    Annotations live as a `**Codex:**` line in the per-task `**Files:**` block of the plan. Concrete syntax:

    ```markdown
    ### Task 3: Add memory adapter

    **Files:**
    - Create: `src/memory/adapter.py`
    - Test: `tests/memory/test_adapter.py`

    **Codex:** ok    # eligible for Codex auto-delegation under codex_routing=auto
    ```

    Or:

    ```markdown
    **Codex:** no    # never delegate; requires understanding of the storage layer
    ```

    Effect on the eligibility cache:
    - `**Codex:** ok` → `eligible: true`, `annotated: "ok"` (overrides the heuristic; delegate even for tasks the checklist would reject).
    - `**Codex:** no` → `eligible: false`, `annotated: "no"` (never delegate; run inline).
    - No annotation → fall through to the heuristic checklist above; `annotated: null`.

    The eligibility-cache builder Haiku (Step C step 1) parses these annotations: scan each task block's `**Files:**` section for a following `**Codex:**` line; record the annotation alongside the heuristic decision.

    **Host-suppressed override:** if `codex_host_suppressed == true`, do NOT dispatch the `codex:codex-rescue` subagent even when the task is annotated `**Codex:** ok`, the eligibility cache says `eligible: true`, or manual mode would normally ask. Route inline and record `decision_source: host-suppressed`.

    **Delegating:** dispatch the `codex:codex-rescue` subagent via the Agent tool with a bounded brief in this format (per CLAUDE.md). **Codex sites are exempt from §Agent dispatch contract** — `codex:codex-rescue` is its own `subagent_type` with out-of-process routing; do NOT pass a `model:` parameter on these calls.
    ```
    Codex task:
    Scope: <task name from plan>
    Allowed files: <explicit list or glob>
    Do not touch: <out-of-scope paths>
    Goal: <one sentence>
    Acceptance criteria: <bullet list, copied from plan>
    Verification: <test commands>
    Return: <expected diff + verification output>
    ```

    **After Codex returns** — always review (apply **CD-10**):
    - **Background return** — if Codex returns a background handle instead of a final digest, do not close with free text like "when it finishes I'll review." Under `<run-dir>/state.lock`, keep `status: in-progress`, keep `current_task` on the dispatched task, set `phase: executing`, set `next_action: poll background task for <task>`, write the `background:` object described in the run-bundle contract, and append `background_started`.
      - If `ScheduleWakeup` is available, schedule `/masterplan --resume=<state-path>` and append `wakeup_scheduled`, then close.
      - If `ScheduleWakeup` is unavailable, persist `pending_gate` and surface `AskUserQuestion("Codex is still running <task>. What next?", options=["Poll now (Recommended)", "Pause here — resume later", "Schedule wakeup"])`.
      - The next Step C entry MUST execute the Background-dispatch resume check before any new routing or redispatch.
    - **`gated`** — present diff + verification output via `AskUserQuestion(Accept / Reject and rerun inline / Reject and rerun in Codex with feedback)`.
    - **`loose` / `full`** — auto-accept if verification passed cleanly. If verification failed, fall back to inline rerun under `superpowers:systematic-debugging` and apply the autonomy's blocker policy from above (which itself triggers **CD-4** ladder work).

    Append a `[codex]` or `[inline]` tag to the completion event for each completed task so future-you can see the routing distribution.

4. **Post-task finalization** — runs in this fixed order after every completed task:

   **4a — Verify (CD-3 verification).** Run the task's verification commands (per CD-1) and capture output for 4b. Trust-but-verify the implementer: read `tests_passed`, `commands_run`, and `commands_run_excerpts` from the implementer's return digest (required fields per the dispatch model table) and skip what the implementer already ran cleanly **AND for which the excerpt validator passes (G.1 mitigation, v2.8.0+)**.

   **Excerpt validator (G.1, v2.8.0+).** The trust-skip is no longer license alone — it requires evidence of execution. For each command in `commands_run`, look up its excerpt in `commands_run_excerpts[cmd]` (a list of 1–3 trailing output lines) and regex-match each excerpt against:
   - The plan task's `**verify-pattern:** <regex>` annotation if present (case-sensitive); OR
   - The default PASS pattern: `(PASSED?|OK|0 errors|0 failures|exit 0|✓|^all tests passed)` (case-insensitive).
   A command's trust-skip activates ONLY when ≥1 excerpt line matches. On miss, that command falls through to inline re-run AND a verification event tags `(verify: excerpt missed for <cmd>; re-ran inline)`. On `commands_run_excerpts` missing entirely (pre-v2.8.0 implementer brief, or buggy SDD), all commands fall through to re-run AND an `implementer_excerpt_missing` event fires once per session: *"⚠ Implementer return missing `commands_run_excerpts` — Step 4a excerpt-validator skipped; running full re-verification. Update SDD prompt to capture command output excerpts."*

   **Decision logic:**
   - If `tests_passed == true` AND every verification command in the plan task is in `commands_run` AND the excerpt validator passes for each: skip 4a's command execution entirely. Completion event records `(verify: trusted implementer; <N> commands; excerpts validated)`. 4b still consumes the implementer's captured output.
   - If `tests_passed == true` AND the plan task lists additional verification commands the implementer didn't run (lint, typecheck, etc.): run only the *complementary* commands. The trust-skip for the implementer-run subset still requires excerpt-validator pass; commands whose excerpts miss fall through to re-run alongside the complement. Completion event records `(verify: trusted implementer for <subset>; ran <complement>; excerpts validated for <subset>)`.
   - If `tests_passed == false` OR `tests_passed` is missing OR the excerpt validator misses for any command: run the full verification per CD-1 (or the complement of validated commands). Completion event records `(verify: full re-run)` or `(verify: excerpt-validator miss; partial re-run)`. If the implementer claimed done but tests fail on re-run, treat as a protocol violation (block per autonomy policy).

   **Why:** SDD's implementer subagent runs project tests as part of TDD discipline. Re-running them in 4a duplicates token cost and CI time without adding signal — but trust-without-evidence (the pre-v2.8.0 contract) opened a gap where a fabricated `tests_passed: true` would silently pass. The excerpt-validator closes that gap with one line of regex per command: cheap to compute, cheap for the implementer to capture (`tail -3` of each command), and the ground truth lives in real terminal output rather than implementer self-report.

   **Parallelize independent verifiers** (when 4a does run commands). Lint, typecheck, and unit-test commands typically don't share mutable state and should be issued as one parallel Bash batch. Run them sequentially when commands write to the same shared artifacts:
   - `node_modules/`, `dist/`, `build/`, `target/`, `out/`
   - `.tsbuildinfo`, `coverage/`, `.next/`, `.nuxt/`
   - generated/codegen output directories
   - any path the plan's task notes as "writes to X"

   When in doubt, run sequentially — a wrong-batch race that corrupts a build artifact costs more than the seconds saved. Brief the implementer subagent on this rule when dispatching it for the task; the rule applies recursively if the implementer dispatches its own verification subagents.

   **4b — Codex-review (Codex review of inline work)** (consult `config.codex.review`, overridden by `--codex-review=` flag, persisted as `codex_review` in `state.yml`).

   First handle the asymmetric-review skip branch: if the task record has `dispatched_by == "codex"`, do not run serial 4b because Step 3a's post-Codex flow owns review of Codex-produced work. Skip with reason `task was codex-routed (asymmetric-review rule)` (the reason template below) and emit:
   ```
   - <ISO-ts> task "<task name>" review→SKIP(task was codex-routed (asymmetric-review rule); decision_source: codex-produced)
   ```

   Fires when ALL of the following hold, otherwise skip silently:
   - `codex_host_suppressed` is not `true`. When running inside Codex, skip 4b with reason `running inside Codex — recursive Codex review disabled`; do not run the mid-plan Codex availability re-check in this branch.
   - `codex_review` is `on`.
   - The task just completed was **inline** (Sonnet/Claude did the work — not Codex). Codex-delegated tasks are reviewed by Step 3a's post-Codex flow, not here. Skipping for those is the asymmetric-review rule.
   - The codex plugin is available (re-check inline at gate time per the heuristic in Step 0). On miss, write the same degradation event as Step 0's degrade-loudly path, set in-memory `codex_review = off` for the rest of the session, and skip 4b. This catches mid-plan plugin uninstall (D.4 mitigation).
   - `codex_routing` is not `off`. (See Step 0's flag-conflict warning — `--codex=off --codex-review=on` is treated as a no-op for review.)

   Why this exists: even when a task is too complex or context-heavy to delegate execution to Codex, Codex can usefully review the resulting diff. The reviewer didn't do the work, so it's a fresh pair of eyes against the spec.

   **Process:**

   1. Compute the task's diff against the **task-start commit SHA** captured by the implementer at task start (passed back as part of its return digest, where it is a **required** field — see the Subagent dispatch model table). If the implementer omitted it, treat as a protocol violation: surface a one-line blocker via `AskUserQuestion` ("Implementer subagent did not return `task_start_sha`. Re-dispatch with corrected brief / Skip 4b for this task / Abort"), and do NOT silently fall back to a SHA range — every fallback considered (`HEAD~1`, `git merge-base HEAD <status.branch>`, `git merge-base HEAD origin/<trunk>`) has a worse failure mode than blocking. If zero commits were made (task aborted before commit), there is no diff to review; skip 4b and let 4a's verification result drive the autonomy policy.

   1a. **Pre-dispatch review-routing visibility** (v2.4.0+; symmetric with Step 3a's pre-dispatch visibility). When 4b's gate-conditions all hold and the orchestrator IS about to dispatch a Codex review, emit:
       - **Stdout banner** (one top-level line):
         ```
         → Reviewing task T<idx> (<task name>) via CODEX (codex_review=on; diff <task-start SHA>..HEAD)
         ```
       - **Pre-dispatch event**:
         ```
         - <ISO-ts> task "<task name>" review→CODEX (codex_review=on; dispatched_by: "codex")
         ```
       The post-review event is unchanged — still tagged `[reviewed: <severity-summary or "no findings">]` per the decision matrix below. Two events per reviewed task — the pre-dispatch event is greppable as `review→CODEX` independent of severity outcome.

       **Skip-with-reason variants** — when 4b's gate-conditions cause the review to skip silently in current behavior, instead emit a one-line stdout AND event so the user can tell skips from omissions:
       ```
       → Reviewing task T<idx> SKIPPED (<reason>)
       - <ISO-ts> task "<task name>" review→SKIP (<reason>)
       ```
       Reason templates:
       - `codex_review=off` (config or `--no-codex-review`)
       - `task was codex-routed (asymmetric-review rule)`
       - `running inside Codex — recursive Codex review disabled`
       - `codex plugin unavailable — Step 0 degradation`
       - `codex_routing=off — review treated as no-op per Step 0 flag-conflict warning`
       - `zero commits made — nothing to review`

       This makes both the firing and not-firing of Codex review visible at the moment of decision, not after completion.

   2. Dispatch the `codex:codex-rescue` subagent in REVIEW mode with this bounded brief (Goal/Inputs/Scope/Constraints/Return shape per the architecture section). **Codex sites are exempt from §Agent dispatch contract** — do NOT pass a `model:` parameter:
      ```
      Codex review:
      Goal: Adversarial review of this task's diff against the spec and acceptance criteria.
      Inputs:
        Task: <task name from plan>
        Acceptance criteria: <bullet list from plan>
        Spec excerpt: <relevant section of design doc>
        Diff range: <task-start SHA>..HEAD
        Files in scope: <list of task files>
        Verification: <captured output from 4a>
      Scope: Review only — no writes, no commits, no file modifications.
             Run `git diff <range> -- <files>` yourself to obtain the diff.
      Constraints: CD-10. Be adversarial about correctness, not style.
      Return: severity-ordered findings (high/medium/low) grounded in file:line, OR the literal string "no findings" if clean.
      ```

      Why diff-by-SHA: Codex agent runs in the worktree with full git access; passing a SHA range avoids inlining 5K–10K tokens of diff into the brief on multi-file tasks. (Zero-commit tasks are handled in step 1, which skips 4b entirely.)
   3. Digest the response per output-digestion rules: parse into severity buckets, drop verbose prose. Don't pull the full review text into orchestrator context.
   4. **Decision matrix by autonomy** (retry caps come from `config.codex.review_max_fix_iterations`, default 2):
      - **`gated`** — auto-accept silently when severity is `clean` or strictly below `config.codex.review_prompt_at` (default `"medium"`). `events.jsonl` records the auto-accept; clean and low-only reviews don't need extra state. When severity is at or above the threshold, persist `pending_gate` and present findings via `AskUserQuestion` → `Accept / Fix and re-review (rerun inline with findings as briefing; capped at config.codex.review_max_fix_iterations) / Accept anyway / Stop`. Users who want every review prompted set `codex.review_prompt_at: "low"` in `.masterplan.yaml`.
      - **`loose`**:
        - No or low-severity → auto-accept; tag events.
        - Medium → append a `review_medium_findings` event for human attention later; accept and continue.
        - High → run the CD-4 recovery ladder first. If the finding still reproduces after the allowed fix/re-review attempt, set `status: blocked`, `phase: critical_error`, `stop_reason: critical_error`, populate `critical_error.code: codex_review_high_severity`, append `critical_error_opened` with file:line cites, → CLOSE-TURN. High-severity review stops are critical errors because continuing would knowingly advance broken or unsafe code.
      - **`full`**:
        - No or low → auto-accept.
        - Medium → append a `review_medium_findings` event; continue.
        - High → attempt up to `config.codex.review_max_fix_iterations` fix iterations (rerun inline with findings as added briefing). If still high-severity afterward, set `status: blocked`, `phase: critical_error`, `stop_reason: critical_error`, populate `critical_error.code: codex_review_high_severity`, and append `critical_error_opened`. Each iteration counts as a CD-4 ladder rung.
   5. Completion events get a review tag alongside the routing tag, e.g. `[inline][reviewed: clean]` or `[inline][reviewed: 2 medium, 1 low]`. Full findings digest goes to events only when severity is medium or higher — clean and low-only reviews don't need extra event noise.

   **4c — Worktree-integrity (CD-2 check).** Apply CD-2: `git status --porcelain` should show only task-scope files. If unexpected files appear, surface to the user before continuing; never silently revert their work.

   **Under wave (Slice α v2.0.0+).** Compute the union of all wave-task `**Files:**` declarations (post-glob-expansion). Run `git status --porcelain` once at wave-end. Filter: files matching the union are expected (they belong to a wave member); files outside ALL declared scopes are CD-2 violations — surface to user. Implicit-paths whitelist (`docs/masterplan/<slug>/state.yml`, `docs/masterplan/<slug>/events.jsonl`, `docs/masterplan/<slug>/eligibility-cache.json`, `.git/`) added to the union only for orchestrator writes. Telemetry sidecars are intentionally NOT whitelisted here because they must be ignored and absent from porcelain; if `telemetry.jsonl`, `subagents.jsonl`, or legacy telemetry/subagent sidecars appear in porcelain, stop and fix the local exclude guard before continuing. The per-task per-wave-member 4c check is replaced by this single union-filter — runs once per wave, not N times.

   **Complexity gate (event density + rotation).**
   - At `resolved_complexity == low`: each task-completion event has a compact `message`: `<task-name> <pass|fail>`. No `[routing→...]`, `[review→...]`, or `[verification: ...]` tags. No `decision_source:` cite. The pre-dispatch `routing→` and `review→` events from Step 3a/4b are SKIPPED entirely at low (codex is off; nothing to log).
   - At `resolved_complexity == medium`: current entry shape (full tags as already documented below).
   - At `resolved_complexity == high`: current entry shape PLUS an explicit `decision_source: <annotation|heuristic|cache>` cite when the task was Codex-eligible.

   **Rotation threshold:**
   - low: rotate when `events.jsonl` exceeds 50 entries; archive all but the most recent 25.
   - medium / high: rotate when log exceeds 100 entries; archive all but the most recent 50 (current behavior, unchanged).

   **4d — State update (single-writer run-state update + archive-and-schedule).** Emit state-write breadcrumb immediately BEFORE the write (per Step 0 §Breadcrumb emission contract):

   ```
   <masterplan-trace state-write field=current_task from=<previous-task> to=<next-task>>
   ```

   Update `state.yml`: bump `last_activity` to the current ISO timestamp, set `current_task` to the next task name, set `next_action` to the next task's first step, and append a task-completion event to `events.jsonl` that includes 1–3 lines of relevant verification output (per **CD-8**), the routing+review tags, `progress_kind`, and `dispatched_by: "codex"` for Codex EXEC completions or `dispatched_by: "claude"` for serial inline completions. For non-trivial decisions made during the task, add dedicated events per **CD-7**.

   `progress_kind` is mandatory on every Step C close. Values:
   - `product_change` — runtime/source/docs behavior requested by the user changed.
   - `implementation_plan_created` — the task converted a finding/follow-up into a runnable implementation plan or structured follow-up.
   - `verification` — no product change, but the task performed acceptance verification that changes the durable confidence state.
   - `metadata_only` — state, audit, import, status, or hygiene changed without creating an implementation path.
   - `no_progress` — inspection happened but no durable state advanced.

   If a completed meta-plan (`plan_kind != implementation`) has confirmed implementation gaps and the next event would be `metadata_only`, do not advance to completion until Step C writes structured `follow_ups` and records `progress_kind: implementation_plan_created`.

   When Step 4d can identify the completed task's checkbox in `plan.md` without fuzzy matching, update it from unchecked to checked in the same state-update commit. If it cannot do this mechanically, leave `plan.md` unchanged and rely on `state.yml` + `events.jsonl`; never let stale checkboxes override a completed `state.yml`.

   **Concurrent-write guard (F.4 mitigation, v2.8.0+).** Wrap the entire 4d update sequence (rotation + append + atomic temp+fsync+rename) in `flock <run-dir>/state.lock -c '<the-write-sequence>'` with a 5-second timeout. On contention (lock not acquired within 5s — typically a user-editor saving `state.yml` in another window or an overlapping pacer), do NOT block: instead append a single JSON-line entry describing this would-be update to `<run-dir>/state.queue.jsonl`, surface a one-line stdout warning *"State write contention — entry queued; retry on next 4d cycle."*, and continue. The next 4d run drains the queue file BEFORE its own append: read each queued entry oldest-first, replay against the current `state.yml` and `events.jsonl`, then truncate the queue file. Replays are idempotent — a queued entry whose state is already reflected in events is a no-op (match by `last_activity` + event `id` or first 80 chars of the message). On `flock` unavailable (Windows / hosts without util-linux), the orchestrator falls through to the unguarded write path AND emits one `state_lock_unavailable` event per session. Doctor check #24 (below) surfaces non-empty queue files post-session.

   **Event rotation.** Before appending the new entry, count lines in `events.jsonl`. If count exceeds the threshold, move older entries to `events-archive.jsonl` (create if missing; append in chronological order so the archive itself reads oldest-to-newest), keep the most recent active tail, then append one `events_rotated` marker event. Resume behavior is unchanged — Step C step 1 reads only the active event tail; the archive is consulted on demand by `/masterplan retro` (Step R2).

   **Two-entry-per-task accounting (v2.4.0+).** Step 3a's pre-dispatch `routing→CODEX|INLINE` event and Step 4b's pre-dispatch `review→CODEX|SKIP` event both count against the rotation threshold. A typical inline task with codex_review on emits up to three events: `routing→INLINE`, `review→CODEX`, then 4d's post-completion `[inline][reviewed: …]` event. Rotation arithmetic still works (the active tail will keep the post-completion event and likely its sibling pre-dispatch events), but plan re-readers should expect 2-3 events per task, not 1.

   **Under wave (Slice α v2.0.0+ — single-writer funnel).**

   1. **Aggregate digest list.** Collect all wave members' digests from the wave-completion barrier. Compute `current_task` = lowest-indexed not-yet-complete task in the plan (across the union of completed wave members + remaining serial tasks).
   2. **Append N events in plan-order** (NOT completion-order — predictable for human readers). Each event tags routing as `[inline][wave: <group>]`, includes verification result from the digest, references `task_start_sha`, and includes `dispatched_by: "wave-claude"`. (No completion SHA for read-only tasks — they don't commit.)
   3. **Event rotation pre-check (wave-aware per FM-2).** If `len(active_events) + N` exceeds the threshold, rotate ONCE at the END of the batch append (not mid-batch). Move older entries to `events-archive.jsonl`; append an `events_rotated` marker; then append the N new wave events.
   4. **Update `last_activity`** to the wave-completion timestamp.
   5. **Append decision/blocker events for any partial-failure context** per the wave-mode failure handling rules in Step C step 3.
   6. **Single git commit for the run-state update** with subject `masterplan: wave complete (group: <name>, N tasks)`.

   This single-writer funnel is the M-1 / M-3 mitigation (FM-2 + FM-3). Wave members do NOT write to run state directly (per the per-instance brief in the wave assembly pre-pass). The orchestrator is the canonical writer per CD-7.

   **4b under wave (v5.8.0+).** Wave members don't commit, but the wave-end commit produces a reviewable SHA range — `<wave_start_sha>..<wave_end_sha>` filtered per member's declared `**Files:**`. At wave-end, dispatch **N parallel Codex REVIEW calls — one per wave member** (NOT one giant review). The principle is the reviewer-batching trigger (read-only review subagents can run in parallel because they don't conflict on shared state); per-member granularity preserves findings attribution to the originating task.

   1. **Gate eval (per wave member).** Apply the same gate conditions enumerated for serial 4b above (`codex_host_suppressed`, `codex_review`, codex plugin availability, `codex_routing`). Additionally apply the asymmetric-review rule per member: read that member's recorded `dispatched_by` from its `wave_task_completed` provenance event (T5 field). If `dispatched_by == "codex"`, skip review for that member with reason `task was codex-routed (asymmetric-review rule)` per Step 3a's post-Codex flow and emit:
      ```
      - <ISO-ts> task "<task name>" review→SKIP(codex-produced; wave-member; T<idx>; decision_source: codex-produced)
      ```
      The asymmetric skip is per-member, not per-wave: other members in the same wave continue through normal gate eval.

   2. **Pre-dispatch visibility events (v2.4.0+, MANDATORY).** For each member that passes gate eval, emit a per-member pre-dispatch event:
      ```
      - <ISO-ts> task "<task name>" review→CODEX (wave-member; codex_review=on; diff <wave_start_sha>..<wave_end_sha> -- <files>; dispatched_by: "codex")
      ```
      For each member that fails gate eval, emit the matching `review→SKIP(<reason>)` variant from serial 4b's reason templates.

   3. **Batched dispatch.** Emit ALL N Codex REVIEW dispatches in a **single assistant message**, with N `Agent` tool_use blocks (one per qualifying member). This is the reviewer-batching rule: serial dispatch turns an O(N×latency) job into an O(latency) job for no benefit because reviewers don't conflict. Each per-member brief uses `contract_id: codex.review_wave_member_v1` (see `commands/masterplan-contracts.md`) and follows the same brief shape as serial 4b (Goal/Inputs/Scope/Constraints/Return) but with:
      - Diff range = `<wave_start_sha>..<wave_end_sha>` filtered to the member's `**Files:**` (Codex runs `git diff <range> -- <files...>` itself; no inlined diff in the brief).
      - Task name + acceptance criteria from the member's plan entry only.
      - **Codex sites are exempt from §Agent dispatch contract** — do NOT pass `model:`.

   4. **Per-member decision matrix per autonomy.** Apply the serial 4b decision matrix (gated/loose/full) independently per member's findings digest. The wave-end completion-event batch (step 4d under wave) tags each per-member completion as `[inline][wave: <group>][reviewed: <severity-summary or "no findings">]` (or `[reviewed: SKIP(<reason>)]` for skipped members). High-severity findings still drive the CD-4 ladder per the existing autonomy semantics, but on a per-member basis: a high-severity finding on member T-i doesn't block member T-j's auto-accept.

   5. **Post-review barrier.** Orchestrator waits for all N Codex REVIEW returns before writing the wave-end state-update commit (step 4d under wave). The wave-completion barrier (above) and the post-review barrier are distinct: the first gates wave members' implementation returns, the second gates Codex reviewers' returns.

   **Why this is not a "skip with empty diff" case anymore.** The pre-v5.8.0 rule claimed "the diff range `<task_start_sha>..HEAD` is empty for wave members" — mechanically true at the individual-member level (members don't commit; their `task_start_sha` equals HEAD throughout the wave) but the wave-end commit SHA range *is* reviewable. Filtering that range to each member's declared files yields the per-member diff. Closes F2 (wave-mode Step 4b skip).

   The invoked skill already commits per task (serial mode only) — verify the commit landed; if not, commit the run-state update (and any rotation-created archive file) separately.

   **4e — Post-task router (CD-9 hot-spot; never improvise a gate).** After 4d's state commit, route the next action deterministically using THIS table — do not emit free-text "Want me to continue?" / "Should I proceed?" / "Continue to T<N>?" / similar phrasings, and do not stop without dispatching either step 5 or step 6 or the per-task gate below.

   | Condition | Route |
   |---|---|
   | All tasks in plan are `done` | → Step C step 6 (finishing-branch wrap) |
   | `critical_error` was just populated (from 4a / 4b high severity / 4c CD-2 violation) | → CLOSE-TURN [pre-close: 4a/4b/4c already wrote `critical_error_opened` + critical-error state] |
   | `ScheduleWakeup` available (running under `/loop`) | → Step C step 5 (loop scheduling — fires every 3 tasks or when context tight) |
   | `ScheduleWakeup` unavailable AND `resolved_autonomy == full` | → re-enter Step C step 2 with `current_task` = next not-done task. Do NOT close turn. Same-turn dispatch. |
   | `ScheduleWakeup` unavailable AND `resolved_autonomy ∈ {gated, loose}` | → fire **per-task gate** (below) |

   **Per-task gate (autonomy ∈ {gated, loose}, no /loop).** Emit gate breadcrumb immediately before the AskUserQuestion (per Step 0 §Breadcrumb emission contract):

   ```
   <masterplan-trace gate=fire id=per_task auq-options=3>
   ```

   Surface:
   ```
   AskUserQuestion(
     question="Task <T-idx> (<task name>) complete. Continue to <next-task name>?",
     options=[
       "Continue (Recommended) — dispatch <next-task name> now",
       "Pause here — re-invoke <manual-resume-command> when ready",
       "Schedule wakeup — set up <loop-resume-command> at the configured interval"
     ]
   )
   ```
   Resolve `<manual-resume-command>` by host: Claude Code uses `/masterplan --resume=<state-path>`; Codex uses `normal Codex chat: Use masterplan execute <state-path>`. Resolve `<loop-resume-command>` as `/loop /masterplan --resume=<state-path>` only when the host actually supports `/loop`/`ScheduleWakeup`. Do not surface `/masterplan --resume=<state-path>` as the manual Codex resume command.
   Routing of choices:
   - **Continue** → re-enter Step C step 2 with `current_task` updated. Same-turn dispatch.
   - **Pause here** → set `stop_reason: question` and → CLOSE-TURN [pre-close: 4d already committed].
   - **Schedule wakeup** → call `ScheduleWakeup(delaySeconds=config.loop_interval_seconds, prompt="/masterplan --resume=<state-path>", reason="Continuing <slug> at task <next-task name>")`, set `stop_reason: scheduled_yield`, append a `wakeup_scheduled` event, → CLOSE-TURN. (Honors `config.loop_max_per_day` quota — same check as step 5's daily-quota branch.)

   **Why this gate uses AskUserQuestion, not silent-continue.** Per-user contract (May 7 2026 review of the petabit-www T10→T11 free-text exit): under `gated` and `loose` autonomy without `/loop`, every task boundary is a checkpoint. Free-text gates ("Want me to continue?") are forbidden by CD-9; structured AskUserQuestion is the only legal close at this site. Under `--autonomy=full` the gate is suppressed and tasks advance silently — that's the explicit autonomy contract. Under `/loop`, step 5's wakeup-scheduling runs instead — that's the explicit cross-session contract.

   **Wave-end variant.** When 4d ran in single-writer wave-funnel mode, the per-task gate fires ONCE at wave-end (not N times), with task name = `<wave-group> wave (<N> tasks)` and `<next-task name>` = the lowest-indexed not-yet-complete task remaining in the plan.

5. **Cross-session loop scheduling** (entered only via Step C step 4e's "ScheduleWakeup available" route — i.e. `--no-loop` is NOT set AND `ScheduleWakeup` IS available because the session was launched via `/loop /masterplan ...`):
   - **Complexity gate.** If `resolved_complexity == low`, wakeup ledger events are NOT maintained (per Operational rules' Complexity precedence: `loop_enabled` defaults to `false` at low, so no `ScheduleWakeup` is even called; however, if the user explicitly enabled the loop via override, `ScheduleWakeup` runs but the ledger event below is SKIPPED). Doctor checks #19 + #20 do not fire on low plans (handled by Task 12's check-set gate).
   - **Competing-scheduler suppression.** If `competing_scheduler_keep == true` (in-memory flag set by Step C step 1's competing-scheduler check when the user picked "Keep the cron, suspend wakeups this session"), skip scheduling silently for the rest of the session. The user-acknowledged cron is the sole pacer.
   - **CC-1 check.** Before scheduling the wakeup, apply CC-1 (operational rules): if `cc1_silenced` is not set and any symptom (file_cache ≥3 hits same path, ≥3 consecutive same-target tool failures, events rotated this session, subagent ≥5K-char return) accumulated this session, surface the non-blocking compact-suggest notice. Continue with scheduling regardless — CC-1 is informational, never blocks.
   - **Daily quota check.** Track wakeup count for this plan via `wakeup_scheduled` events in `events.jsonl`. Before scheduling, count entries from the last 24 hours; if `>= config.loop_max_per_day` (default 24), do NOT schedule another wakeup. Keep `status: in-progress`, persist `pending_gate` with `id: loop_quota_exhausted`, set `stop_reason: question`, append `question_opened`, and ask whether to extend quota, pause until manual resume, or disable loop for this plan. This prevents runaway scheduling under unexpected loop conditions without converting quota exhaustion into a false critical error.
   - Otherwise, after every 3 completed tasks (where a wave-end counts as ONE completion regardless of N — so a wave of 5 doesn't trigger 5 wakeup-threshold increments), OR when context usage looks tight, call:
     ```
     ScheduleWakeup(
       delaySeconds=config.loop_interval_seconds,
       prompt="/masterplan --resume=<state-path>",
       reason="Continuing <slug> at task <next-task-name>"
     )
     ```
     set `stop_reason: scheduled_yield`, append the `wakeup_scheduled` event, then → CLOSE-TURN [pre-close: ScheduleWakeup + event append done above]. The next firing re-enters this command via Step C.
   - Do NOT reschedule when `status` is `complete` or `blocked`.
   - If `ScheduleWakeup` is not available (not running under `/loop`), step 5 is **not the entry point** — Step C step 4e's post-task router has already routed to the per-task gate or to silent-continue under `--autonomy=full`. This bullet exists for documentation only; step 5's body is reachable only when 4e selects it.
6. **On plan completion:** run the completion finalizer, then pre-empt the skill's "Which option?" prompt. `superpowers:finishing-a-development-branch` will otherwise present a free-text `1. Merge / 2. Push+PR / 3. Keep / 4. Discard — Which option?` question. That free-text prompt can stall a session if it compacts before the user answers (same silent-stop bug pattern). Avoid this by handling durable completion state first, then surfacing `AskUserQuestion` for the branch-finish choice.

   **6a-worktree-refresh.** First action of Step C step 6a (before the git status --porcelain dirty check): refresh `worktree_disposition` from live `git worktree list --porcelain`:

  1. Run `git worktree list --porcelain` and parse the entries.
  2. Compare `state.yml.worktree` against the listed paths.
  3. If recorded worktree path is NOT in `git worktree list`:
     - Set `worktree_disposition: missing`, clear `worktree:` field (set to ""), set `worktree_last_reconciled: <now>`.
     - Append `{"event":"worktree_orphan_cleaned","path":"<old-path>","ts":"..."}`.
     - Proceed (do not block completion).
  4. If recorded worktree path IS in `git worktree list` AND disposition was empty (v2 bundle):
     - Set `worktree_disposition: active`, set `worktree_last_reconciled: <now>`.
  5. Emit notice for untracked worktrees (worktrees in git list with no bundle pointer): if this completion run detects a worktree path in `git worktree list` that no bundle's `state.yml.worktree` points to, append `{"event":"worktree_untracked_detected","path":"<path>","ts":"..."}` to events.jsonl but do NOT block completion.

   **6a — Pre-completion dirty check, then mark complete.** Before writing `status: complete`, run live `git status --porcelain` in the plan's recorded worktree. Classify output into task-scope changes (files touched by the plan, run-bundle state, generated artifacts that belong to this plan) and unrelated dirty user work.

   - If task-scope changes are dirty/uncommitted, do NOT mark complete. Under `<run-dir>/state.lock`, keep `status: in-progress`, set `phase: finish_gate`, set `current_task: "finish branch"`, set `next_action: commit remaining task-scope work before completion`, set `pending_gate` for the finish choice, set `stop_reason: question`, append `completion_dirty_gate`. Emit gate breadcrumb (per Step 0 §Breadcrumb emission contract):
     ```
     <masterplan-trace gate=fire id=completion_dirty auq-options=4>
     ```
     Then surface:
     ```
     AskUserQuestion(
       question="All plan tasks are done, but task-scope work is still uncommitted. What next?",
       options=[
         "Commit remaining task-scope work and rerun completion finalizer (Recommended)",
         "Show status and pause",
         "Keep plan in-progress; I'll handle manually",
         "Abort completion"
       ]
     )
     ```
     The recommended path commits only task-scope files, reruns the relevant verification if the commit contents changed code, then re-enters Step C step 6a. Never hide this as a completed plan with `next_action: completion finalizer`.
   - If unrelated dirty user work exists but task-scope work is clean, mark the plan complete but include the unrelated paths in `plan_completed` as ignored dirt. Do not stage or clean unrelated files.
   - If the worktree is clean for task scope, proceed.

   Before the completion write, if `plan_kind != implementation`, scan bundled artifacts for implementation gaps using the same adapter as Step N: `gap-register.md` rows with verdict `confirmed_gap`, explicit "confirmed implementation gaps" sections in `audit-report.md`, or existing pending `follow_ups`. If confirmed implementation gaps exist and `follow_ups` is empty, write concrete structured follow-up records first, set `next_action: materialize pending implementation follow-ups`, append `followups_materialized` with `progress_kind: implementation_plan_created`, and only then continue the completion write. The `petabit-os-mgmt` archived-plans audit pattern is the regression target: DNS operational rows `gap-late-008`/`gap-late-009` become `dns-oper-reporting-cleanup`, and datastore row `gap-late-005` becomes `datastore-list-key-merge`.

   **6a-guard — Retro presence check.** Before writing `status: complete`, invoke `bin/masterplan-state.sh transition-guard <run-dir> complete` inline (not as a subagent dispatch — this is the orchestrator's main-turn synchronous check). Parse the JSON result:

   - `disposition: ok` → proceed to the `status: complete` write below.
   - `disposition: gate` with `reason: retro_missing` → do NOT write `status: complete`. Instead write `status: pending_retro`, `phase: pending_retro`, `pending_retro_attempts: 0`, `next_action: generate completion retro (pending)`, preserve all other completion fields, append `{"event":"completion_retro_gate_opened","ts":"...","run_dir":"<run-dir>"}` to `events.jsonl`. Then continue Step C step 6b (retro generation) — do NOT surface an AskUserQuestion at this point; let step 6b attempt generation first.
   - `disposition: abort` (unexpected state) → set `status: in-progress`, `phase: finish_gate`, append `{"event":"completion_guard_abort","reason":"<reason>"}`, surface `AskUserQuestion("Completion guard aborted for <slug>: <reason>. How to proceed?", options=["Inspect state.yml and retry (Recommended)", "Force complete with --no-retro flag", "Abort completion"])`.

   Emit state-write breadcrumb immediately BEFORE the completion write (per Step 0 §Breadcrumb emission contract):

   ```
   <masterplan-trace state-write field=status from=in-progress to=complete>
   ```

   Under `<run-dir>/state.lock`, set `status: complete`, `phase: complete`, `current_task: ""`, `next_action: none` unless pending `follow_ups` remain, `pending_gate: null`, `background: null`, `stop_reason: complete`, `critical_error: null`, and `last_activity: <now>`. Append a `plan_completed` event to `events.jsonl` with the final task count, final verification summary, completion SHA if available, the dirty-check summary, `progress_kind: product_change | implementation_plan_created | verification` as appropriate, and `dispatched_by: "user"`. Commit this state update with subject `masterplan: complete <slug>` unless the same commit already contains the final task's state update. Do not reschedule.

   **Codex native goal completion.** If `codex_host_suppressed == true` and `state.yml` has `codex_goal.objective`, call `get_goal` immediately after the state update. If the active goal objective matches, call `update_goal(status="complete")`, then append `codex_goal_completed` to `events.jsonl`. If no active goal exists or the objective differs, do not mark any native goal complete; append `codex_goal_complete_skipped` with the observed/missing objective.

   **6b — Auto-retro by default.** Unless `--no-retro` was passed OR `config.completion.auto_retro == false`, invoke Step R internally with the resolved slug and `completion_auto=true`. This is not an `AskUserQuestion` option and does not depend on `resolved_complexity`: low, medium, and high plans all get a retro by default. Step R writes `docs/masterplan/<slug>/retro.md`; Step R3.5 archives the run state when `config.retro.auto_archive_after_retro != false`; Step R4 commits the retro/state/events directly in internal mode.

   **Safety net at next /masterplan touch.** If Step C 6 is bypassed entirely — for example, by a manual `state.yml` edit that flips `status: complete` from outside Step C, or by a brainstorm-only completion under `halt_mode=post-brainstorm` that never enters Step C 6 — the resume controller at Step 0 §Run bundle state model item 4 fires Step R as a backfill on next `/masterplan` touch. The guard above (6a-guard) is for the in-flight Step C completion path; the resume-controller clause is the catch-all for everything that reaches `status: complete` without it.

   If retro generation fails AND the current status is `pending_retro` (set by 6a-guard):
   - Increment `pending_retro_attempts` (write to state.yml).
   - Append `{"event":"retro_generation_failed","ts":"...","attempt":<N>}` to events.jsonl.
   - If `pending_retro_attempts == 1`: set `status: pending_retro`, leave bundle in this state. Do NOT write `status: complete`. Continue to step 6c (completion cleanup) and step 6d (branch finish gate) — the bundle is partially complete; those steps are still safe to run.
   - If `pending_retro_attempts >= 2`: surface `AskUserQuestion("Retro generation failed twice for <slug>. Disposition?", options=["Regenerate now — will re-dispatch retro subagent (Recommended)", "Mark complete_no_retro with waiver — will prompt for reason", "Leave pending (re-check on next /masterplan)"])`.
     - "Regenerate now" → re-dispatch retro subagent; on success set `status: complete` and proceed; on failure leave `pending_retro`.
     - "Mark complete_no_retro with waiver" → `AskUserQuestion("Waiver reason for skipping retro on <slug>?", options=["<free-text Other field>"])`. Write `retro_policy.waived: true`, `retro_policy.reason: <user input>`, set `status: complete`, append `{"event":"retro_waived","reason":"..."}`.
     - "Leave pending" → persist state as-is, → CLOSE-TURN.

   If retro generation fails AND the current status is already `complete` (legacy path, pre-Wave2 bundles): append `completion_retro_failed` event, leave `status: complete` (backward-compatible; the auto-retro backfill at Step 0 §Run bundle state model item 4 will catch it on next `/masterplan` touch for schema_v3+ bundles, or Doctor #28's `--fix` for legacy schema_v2 bundles). Do NOT lose the completed run.

   **6a-worktree-completion.** After retro generation succeeds (or `retro_policy.waived: true`), evaluate `worktree_disposition`:

- `active`: Run `git worktree remove <state.yml.worktree>`.
  - On success: set `worktree_disposition: removed_after_merge`, clear `worktree:` field, set `worktree_last_reconciled: <now>`. Append `{"event":"worktree_removed_at_completion","path":"<path>","ts":"..."}`.
  - On failure (uncommitted changes, locked worktree, path doesn't resolve): emit `{"event":"worktree_removal_failed","path":"<path>","error":"<git error text>","ts":"..."}`, set `worktree_disposition: missing`, clear `worktree:` field. Do NOT block completion — continue to 6d.
- `kept_by_user`: No removal attempt. Append `{"event":"worktree_kept_per_user_flag","path":"<path>","ts":"..."}`. Continue.
- `removed_after_merge`: Already removed. No action. Continue.
- `missing`: Already cleared. No action. Continue.

No AskUserQuestion at this step — this honors the loose-autonomy contract. The user pre-flags intent via `--keep-worktree` or `worktree_disposition: kept_by_user` in state.yml.

   **6c — Completion cleanup by default.** Unless `--no-cleanup` was passed OR `config.completion.cleanup_old_state == false`, run Step CL in **completion-safe mode** after the retro attempt:
   - Categories: `legacy` and `orphans` only.
   - Action mode: `archive` only; never delete.
   - Worktree scope: the current plan's worktree only.
   - Prompts: none. This mode is noninteractive and skips stale plans, crons, worktrees, and completed-run bundle archival.
   - Legacy safety: archive a legacy file only when a matching bundle exists and that bundle's `legacy:` pointers match the source path. If verification is ambiguous, leave the legacy file in place and append a `completion_cleanup_skipped` event with the reason.
   - CD-2 safety: before staging archive moves, capture `git status --porcelain`. After moves, verify the only new changes are the expected archive moves/additions. If unrelated dirty files appear, abort cleanup, append `completion_cleanup_aborted`, and leave the run otherwise complete.
   - Idempotence: a second completion finalizer pass should report `completion cleanup: nothing to archive`.

   **6d — Branch finish gate.** After 6a-6c, emit gate breadcrumb (per Step 0 §Breadcrumb emission contract) then surface the existing branch-finish `AskUserQuestion`:

   ```
   <masterplan-trace gate=fire id=branch_finish auq-options=4>
   ```

   ```
   AskUserQuestion(
     question="Plan complete. How should I finish the branch?",
     options=[
       "Merge to <base-branch> locally (Recommended) — fast-forward if possible, then delete the feature branch + remove worktree",
       "Push and open a PR — git push -u origin <branch>; gh pr create",
       "Keep branch + worktree as-is — handle later",
       "Discard everything — requires typed 'discard' confirmation"
     ]
   )
   ```

   Then invoke `superpowers:finishing-a-development-branch` with a brief that pre-decides the option: `"Skip Step 1's test verification (this repo has no test suite — verification done by other means; cite [briefly]) IF that's true, otherwise let it run normally. User has chosen Option <N>: <description>. Skip Step 3's free-text 'Which option?' prompt; execute Step 4's chosen-option branch directly. For Option 4 (Discard), still require the typed 'discard' confirmation per the skill's safety rule."` After the skill completes its chosen option's branch, append a `branch_finish_<choice>` event when the run directory still exists. Also clear stale `next_action` to `none`, or set it to exactly one real deferred item if the branch-finish skill intentionally left one (for example, "push branch after network returns"). Do not flip archived runs back to complete, and do not reschedule.

---
