# Step C — Execute: Resume (state read + eligibility cache)

<!-- Loads on demand: sub-file 1 of 4. Router loads this on execute/full/--resume=.
     Contains: Step C preamble + dispatch guard + TaskCreate projection + Step C step 1
     (batched re-read, state resolution, eligibility cache build, competing-scheduler check).
     Continues in parts/step-c-dispatch.md (wave assembly + routing).
     DISPATCH-SITE: step-c-resume.md:eligibility-cache-build -->

---

> **v5 DISPATCH-SITE convention (split step-c).** Agent dispatches in this sub-file use
> `DISPATCH-SITE: step-c-resume.md:<label>`. Sub-file dispatch-site labels:
> `step-c-resume.md:eligibility-cache-build`, `step-c-dispatch.md:wave-dispatch`,
> `step-c-dispatch.md:codex-eligibility-build`, `step-c-verification.md:per-task-verify`.
> Dispatched_by enum unchanged — see step-c-resume.md:1-23 for the table.

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
/masterplan {verb} › Execute  [{slug}]
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

1. **Resume state via coordinator-bundle-resume.** On every execute-turn entry:

   ```
   DISPATCH-SITE: coordinator-bundle-resume
   contract_id: "coordinator-bundle-resume-v1"
   Tier: haiku
   Goal: Read bundle state; return compact situation report.
   Inputs: bundle_path=<docs/masterplan/<slug>/>
   Scope: read state.yml (full), events.jsonl (limit 200 lines), plan.md (limit 100 lines); run pwd + git rev-parse --abbrev-ref HEAD.
   Constraints: read-only; CD-7.
   Return shape: {phase, current_task, next_action, pending_gate, autonomy, last_5_events, task_summary, coordinator_version}; ≤ 1000 tokens total
   ```

   **Fallback** (coordinator errors): read state.yml inline with the Read tool (pre-v6 behavior). Log `coordinator_fallback`.

   **In-session mtime gating.** Maintain an orchestrator-memory cache `file_cache: {path → (mtime, content)}`. On a Step C entry within the **same session**, if a file's current mtime matches the cached mtime, reuse the cached content and skip the Read for that file. Cross-session entries (i.e. after a `ScheduleWakeup` resumption) start with an empty cache and always re-read. `state.yml` is **never** mtime-gated — always re-read live, since the orchestrator wrote it last and the user may have edited it between turns. Fail-safe: re-read on any doubt.

   Reconcile `current_task` against the plan's task list if the plan has been edited since the status was written.

   - **Parse guard.** If `state.yml` fails to parse as YAML, treat this as a safety-only critical error. If `events.jsonl` is still addressable from the path, append `critical_error_opened` with `code: state_parse_failed`; if not, render the recovery gate without writing. Surface immediately via `AskUserQuestion`: "State file at `<path>` is corrupted. Open it for manual fix / Run /masterplan doctor / Abort." Do NOT attempt to silently regenerate — the user's edits may have been intentional and partial.
   - **Pending-gate resume.** If `pending_gate` is non-null, set `stop_reason: question` if it is missing or stale, then re-render that exact structured question before doing any new routing. Clear it only after CD-7's explicit selection-evidence rule is satisfied, applying the selected option, appending `gate_closed` to `events.jsonl`, and clearing `stop_reason` unless the chosen option itself closes the turn.
   - **Background-dispatch resume.** If `background` is non-null, poll the recorded task before any new task dispatch. **Polling algorithm:** load deferred tools — `ToolSearch(query: "select:TaskGet,TaskOutput", max_results: 2)` — then call `TaskGet(id=background.agent_id)`. Status `running|queued` → still in-flight. Status `completed` → call `TaskOutput(id=background.agent_id)` to retrieve result. Status `failed|cancelled|error` → background_failed. If `TaskGet` is unavailable or errors, fall back: `test -s <background.output_path>` — non-empty file indicates available output; empty/missing file means still running. Do not redispatch the current task until this check resolves:
     - If the background task is still running, persist `pending_gate`, set `stop_reason: question`, and surface `AskUserQuestion("Background task for <task> is still running. What next?", options=["Poll again now (Recommended)", "Schedule wakeup at 270s — resume this state later", "Pause here"])`. Under `/loop`, scheduling sets `stop_reason: scheduled_yield` after `wakeup_scheduled`; outside `/loop`, a plain pause remains resumable from the same `background` marker.
     - If the background task finished successfully, ingest the returned digest, append `background_finished`, set `background: null`, and continue at Step C step 4a/4d with that digest as the implementer result.
     - If the background task failed, timed out, or produced no readable output, append `background_failed`, persist `pending_gate`, set `stop_reason: question`, clear or keep the marker according to an `AskUserQuestion("Background task did not return usable output. What next?", options=["Rerun inline (Recommended)", "Keep waiting — poll again in 270s", "Clear marker and pause"])`, then route accordingly.
     - If `background.agent_id` is absent and `background.output_path` is missing/empty, treat as ambiguous. The default route is inline rerun only after the user picks it.
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
     1. **Annotation-completeness scan** (orchestrator inline). For every `### Task N:` block in the plan, confirm BOTH (a) a `**Files:**` block is present and non-empty, AND (b) a `**Codex:** ok|no|true|false` line is present (case-sensitive; `true` is an alias for `ok`, `false` is an alias for `no`; any other value disqualifies — including `ok ` with trailing whitespace, `OK`, or `maybe`).
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

   **Inline-build verifier (CD-3 evidence anchor).** The annotation-completeness scan in the Build path step 1 IS the verifier that licenses the inline shortcut — analogous to Step 4a's implementer-return trust contract (see line ~996), where structured fields gate skipping redundant verification. The scan must pass for ALL tasks before the inline path activates: any malformed annotation, missing `**Files:**` block, or unknown `**Codex:**` value (e.g., `**Codex:** maybe`, `OK`, `ok ` with trailing whitespace) disqualifies the inline path and silently falls back to Haiku dispatch. Accepted values: `ok`, `no`, `true` (alias for `ok`), `false` (alias for `no`). Silent fallback is correct here — the Haiku is the standard path, not an error path; the orchestrator never trusts data it can't structurally validate. At `complexity == high`, writing-plans guarantees every task carries a well-formed `**Codex:**` annotation pair (see line ~540), so the inline path activates by construction; at `medium`, it activates opportunistically when annotations happen to be complete; at `low`, the entire decision tree is skipped per the **Complexity gate** above. Doctor #21's regex (`eligibility cache:`) matches both inline and Haiku-built variants — no doctor-side change is required.

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
