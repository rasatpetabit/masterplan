# Step C — Execute: Verification (post-task finalize + per-task gate)

<!-- Loads on demand: sub-file 3 of 4 after step-c-dispatch.md.
     Contains: Step C step 4 (post-task finalization: 4a verify, 4b Codex review,
     4c state commit, 4d wave single-writer funnel, 4e per-task router + gate).
     Continues in parts/step-c-completion.md (loop scheduling + plan completion).
     DISPATCH-SITE: step-c-verification.md:per-task-verify -->

**Entry breadcrumb.** Emit on first line after this comment block:

```
<masterplan-trace step=step-c-verification phase=in verb={requested_verb} halt_mode={halt_mode} autonomy={autonomy}>
/masterplan {verb} › Execute (verify)  [{slug}]
```

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

   **Dispatch coordinator-task-verify** (when 4a does run commands):

   ```
   DISPATCH-SITE: coordinator-task-verify
   contract_id: "coordinator-task-verify-v1"
   Tier: haiku
   Goal: Run verify commands for task <N>; evaluate against PASS pattern; return status + excerpt.
   Inputs: commands=<verify_commands_list>, pattern=<verify_pattern or default>, task_name=<name>, timeout_s=60
   Scope: run commands (read filesystem as needed); no state writes.
   Constraints: timeout 60s per command; return exit_code even on timeout.
   Return shape: {status, exit_code, excerpt (≤ 2000 chars), commands_run (≤ 10 items), pattern_matched, coordinator_version}
   ```

   **Fallback** (coordinator errors or timeout): run commands inline; evaluate against default PASS pattern. Log `coordinator_fallback`.

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
   - `codex_host_suppressed` is not `true`. When running inside Codex, skip 4b with reason `running inside Codex — recursive Codex review disabled`; do not run the mid-plan Codex availability re-check in this branch. ↳ codex review (C4b): SKIPPED — codex-host recursion guard
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

   2. Dispatch the `codex:codex-rescue` subagent **via the Agent tool** (`subagent_type: "codex:codex-rescue"`) in REVIEW mode with this bounded brief (Goal/Inputs/Scope/Constraints/Return shape per the architecture section). `codex:codex-rescue` is fully model-invocable; this is **NOT the /codex:adversarial-review slash command**, so never refuse citing `disable-model-invocation` and never punt to the user to type a slash command (see `parts/contracts/codex-review.md` §Dispatch mechanism). **Codex sites are exempt from §Agent dispatch contract** — do NOT pass a `model:` parameter:
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
      Return: JSON matching the contract in parts/contracts/codex-review.md §Return JSON shape.
              Schema: {"verdict": "pass"|"fail"|"warn", "dimensions": [...], "findings": [{"severity":"high"|"medium"|"low","file":"<path>","line":<int>,"issue":"<text>"}], "summary":"<1-2 line gist>"}
              If findings list is empty, return it as []. Do NOT return prose.
      ```

      Why diff-by-SHA: Codex agent runs in the worktree with full git access; passing a SHA range avoids inlining 5K–10K tokens of diff into the brief on multi-file tasks. (Zero-commit tasks are handled in step 1, which skips 4b entirely.)
   3. **Parse and emit inline.** Parse the return per `parts/contracts/codex-review.md` §Parse algorithm. On JSON parse failure (D5, D21): preserve first 2048 bytes in `raw_excerpt`, apply D23 regex fallback, annotate `(degraded-parse)`. Immediately (D6 — before decision matrix, before state write) emit:
      ```
      ↳ codex review (C4b[, degraded-parse]): <VERDICT> — <N> findings
        • [top-3 by severity]
      ```
      On degraded-parse, append `raw excerpt: <first ~500 chars>` line.
      Append `{"event":"codex_review_returned","gate":"C4b","task":"<task name>","verdict":"<v>","dimensions":[...],"findings":[...full list...],"summary":"<s>","raw_excerpt":"<≤2KB or null>","ts":"<now>"}` to `events.jsonl`.
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

   3. **Batched dispatch.** Emit ALL N Codex REVIEW dispatches in a **single assistant message**, with N `Agent` tool_use blocks (`subagent_type: "codex:codex-rescue"`, one per qualifying member) — these are model-invocable Agent dispatches, **NOT the /codex:adversarial-review slash command**; never refuse citing `disable-model-invocation` (see `parts/contracts/codex-review.md` §Dispatch mechanism). This is the reviewer-batching rule: serial dispatch turns an O(N×latency) job into an O(latency) job for no benefit because reviewers don't conflict. Each per-member brief uses `contract_id: codex.review_wave_member_v1` (see `commands/masterplan-contracts.md`) and follows the same brief shape as serial 4b (Goal/Inputs/Scope/Constraints/Return) but with:
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

