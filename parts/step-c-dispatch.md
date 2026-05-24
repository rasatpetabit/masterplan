# Step C — Execute: Dispatch (wave assembly + routing)

<!-- Loads on demand: sub-file 2 of 4 after step-c-resume.md.
     Contains: wave assembly pre-pass (Slice α), Step C step 2 (skill invoke),
     step 3 (autonomy policy + blocker re-engagement), step 3a (Codex routing per task).
     Continues in parts/step-c-verification.md (post-task finalization + verify).
     DISPATCH-SITE: step-c-dispatch.md:wave-dispatch -->

**Entry breadcrumb.** Emit on first line after this comment block:

```
<masterplan-trace step=step-c-dispatch phase=in verb={requested_verb} halt_mode={halt_mode} autonomy={autonomy}>
/masterplan {verb} › Execute (dispatch)  [{slug}]
```

**Wave assembly pre-pass (Slice α v2.0.0+).** Before invoking the per-task implementer, scan the upcoming task list against the eligibility cache for parallel-eligible tasks (`parallel_eligible == true`).

1. **Parse plan via coordinator-plan-parser** (when eligibility cache is stale or absent):

   ```
   DISPATCH-SITE: coordinator-plan-parser
   contract_id: "coordinator-plan-parser-v1"
   Tier: haiku
   Goal: Parse plan.md; return structured task list with eligibility annotations.
   Inputs: plan_path=<docs/masterplan/<slug>/plan.md>
   Scope: read plan.md only.
   Constraints: read-only; CD-7.
   Return shape: {total_tasks, schema_version, tasks: [{idx, name, files, codex_eligible, parallel_group, verify_commands, status}] (≤ 100 items), eligibility_cache_hash, coordinator_version}
   ```

   **Fallback** (coordinator errors): read plan.md inline and build eligibility cache from heuristic checklist. Log `coordinator_fallback`.

   Read upcoming task pointer from `state.yml` (`current_task` + coordinator-returned task list).
2. Walk forward in plan-order from `current_task`. Collect contiguous tasks with the SAME `parallel_group` value into a wave candidate. Stop at the first task that has a different `parallel_group`, has no `parallel_group`, or has `parallel_eligible == false`.
3. Wave size: ≥ 2 tasks, capped at `config.parallelism.max_wave_size` (default `5`). Tasks beyond cap roll into the next wave.
4. Edge case: wave candidate of size 1 → execute serially (fall through to standard per-task dispatch).
5. **Interleaved groups do not parallelize.** Plan-order is authoritative; the contiguous-walk rule produces multiple single-task wave candidates if parallel-grouped tasks are interleaved with serial tasks. Planner is responsible for ordering parallel-grouped tasks contiguously to enable wave dispatch.
6. **If `config.parallelism.enabled == false`** (global kill switch from `--no-parallelism` flag or config), skip wave assembly entirely — fall through to the standard serial loop.

**Run-policy gate (v5.9.0+, first wave only).** When a wave of ≥ 2 tasks assembles and `run_policy` is not yet set for this session, fire the upfront gate before dispatching:

<masterplan-trace gate=fire id=run_policy auq-options=4>

```
AskUserQuestion(
  question="About to dispatch a parallel wave of <N> tasks (group: <name>). Set run policy for this session:",
  options=[
    "Parallel + ask on each blocker (Recommended) — fastest; pauses at each block to ask",
    "Parallel + async hold on blocker — fastest; holds blocked tasks and surfaces them at next check-in",
    "Serial + ask on each blocker — safest; one task at a time",
    "Serial + halt on any blocker — serial execution; stops everything on first block"
  ]
)
```

Set `run_policy` from selection:
- Option 1: `{parallelism: parallel, on_blocker: ask}`
- Option 2: `{parallelism: parallel, on_blocker: async_hold}`
- Option 3: `{parallelism: serial, on_blocker: ask}`
- Option 4: `{parallelism: serial, on_blocker: halt}`

**Default (gate dismissed / `run_policy` not yet set):** `{parallelism: serial, on_blocker: ask}` — no behavior change from current.

After gate: if `run_policy.parallelism == serial`, fall through to standard per-task serial dispatch (skip wave assembly). If `parallel`, proceed to wave dispatch below.

On subsequent wave assemblies this session: `run_policy` is already set — read it directly without re-firing the gate.

**`on_blocker: async_hold` semantics.** When a wave member returns `status: blocked` and `run_policy.on_blocker == async_hold`: mark the task as `held` (not `blocked`) in session memory. Continue dispatching remaining tasks and subsequent waves. Accumulate all held tasks. At plan completion (or at the next `/masterplan` invocation), surface held tasks in a single AUQ: `"<N> tasks were held during this run."` with options `[Review and retry each / Skip all held tasks / Abort run]`.

**When a wave assembles** (≥ 2 tasks): append a `wave_routing_summary` visibility event at wave-entry with shape `{wave, members_by_route: {codex: N, inline_review: N, inline_no_review: N}}`, where `wave` identifies the parallel group / task-index span and `members_by_route` counts the assembled wave members by their Step 3a route bucket. Then set `cache_pinned_for_wave: true`. Dispatch all N implementer subagents as parallel `Agent` tool calls in a single assistant turn (existing pattern in Step I3.2/I3.4). **Pass `model: "sonnet"` on each Agent call** per §Agent dispatch contract — wave members are general-purpose implementers, not Opus-grade reasoning. Each instance gets the standard implementer brief PLUS three wave-specific clauses:

> *"WAVE CONTEXT: You are dispatched as part of a parallel wave of N tasks (group: `<name>`). Your declared scope is `**Files:**` (exhaustive — do not read or modify anything outside this list, including plan.md, state.yml, events.jsonl, sibling tasks' scopes, or the eligibility cache). Capture `git rev-parse HEAD` BEFORE any work; return as `task_start_sha` (required per existing implementer-return contract). DO NOT commit your work — return staged-changes digest only. DO NOT update run state — orchestrator handles batched wave-end updates. Failure handling: if you BLOCK or NEEDS_CONTEXT, return immediately; orchestrator's blocker re-engagement gate handles you alongside the rest of the wave."*

> *"Return shape: `{task_idx, status: completed|blocked, task_start_sha, files_changed: [paths ≤ 20 items], staged_changes_digest: 1-3 lines, tests_passed: bool, commands_run: [str ≤ 20 items], commands_run_excerpts: {cmd → [str ≤ 3 items each]}, blocker_reason?: str}`. NO commits. NO run-state writes. `commands_run_excerpts` is REQUIRED (v2.8.0+, G.1 mitigation): 1–3 trailing output lines per executed command, used by Step 4a's excerpt-validator before honoring the trust-skip. (The orchestrator's post-barrier reconciliation may reclassify `completed` to `protocol_violation` if it detects a commit, an out-of-scope write, or a state modification.)"*

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
    - `**Codex:** ok` (or `true`) → `eligible: true`, `annotated: "ok"` (overrides the heuristic; delegate even for tasks the checklist would reject).
    - `**Codex:** no` (or `false`) → `eligible: false`, `annotated: "no"` (never delegate; run inline).
    - No annotation → fall through to the heuristic checklist above; `annotated: null`.

    The eligibility-cache builder Haiku (Step C step 1) parses these annotations: scan each task block's `**Files:**` section for a following `**Codex:**` line; record the annotation alongside the heuristic decision.

    **Host-suppressed override:** if `codex_host_suppressed == true`, do NOT dispatch the `codex:codex-rescue` subagent even when the task is annotated `**Codex:** ok`, the eligibility cache says `eligible: true`, or manual mode would normally ask. Route inline and record `decision_source: host-suppressed`.

    **Linked-worktree guard:** Before dispatching, detect whether the current run is inside a linked git worktree. Run: `git_dir="$(git rev-parse --git-dir 2>/dev/null)"; git_common="$(git rev-parse --git-common-dir 2>/dev/null)"; superproject="$(git rev-parse --show-superproject-working-tree 2>/dev/null)"`. Linked worktree detected when `git_dir` ≠ `git_common` AND `superproject` is empty (the superproject guard prevents submodules from falsely matching). In this topology the `.git` index lives outside the workspace path; the Codex sandbox restricts writes to the workspace, so `git add`/`git commit` fail silently — Codex appears to complete the task but no commits appear. Action: route inline, record `decision_source: linked-worktree`, and log `{"event":"codex_skip_linked_worktree","task":"<task>","git_dir":"<git_dir>","git_common":"<git_common>"}` to `events.jsonl`. **Do NOT use a `touch` probe** — the orchestrator runs with full user permissions and can write to `.git` regardless of sandbox topology, making a touch-probe always return writable.

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

    **API error handling.** If the `codex:codex-rescue` dispatch fails with a transport or rate-limit error, apply the retry schedule in `docs/conventions/api-retry-policy.md` before promoting to a blocker. The same policy applies to inline `Agent()` dispatch.

    **After Codex returns** — always review (apply **CD-10**):
    - **Background return** — triggered when the orchestrator dispatched with `run_in_background: true` (Agent tool returns a task ID immediately rather than blocking). **Detection:** (a) `run_in_background: true` was set on the dispatch call (deliberate background), OR (b) the Agent return does not contain `staged_changes_digest` or `status: completed|blocked` and does contain an `agent_id` / `task_id` field — i.e., it is an acknowledgement, not a result. **Wave dispatch is NOT background** — parallel Agent calls in a single turn block synchronously at the wave-completion barrier; no `background:` marker is written for wave members. **Pre-dispatch `output_path` setup:** Before calling Agent with `run_in_background: true`, compute `output_path = "<run-dir>/task-<idx>-bg-output.json"` (where `<run-dir>` is the bundle directory, e.g. `docs/masterplan/<slug>`, and `<idx>` is the task index). Include in the brief: `"Write your complete digest as a JSON object to <output_path> immediately upon completion, before returning — this persists the result across session boundaries."` This file is the cross-session fallback when `TaskGet` is unavailable in a new session (see `parts/contracts/run-bundle.md §background`). When detected: do not close with free text like "when it finishes I'll review." Under `<run-dir>/state.lock`, keep `status: in-progress`, keep `current_task` on the dispatched task, set `phase: executing`, set `next_action: poll background task for <task>`, write `background: {task: "<task>", agent_id: "<id-from-tool-result>", started_at: "<iso-now>", wave: null, output_path: "<computed-output_path>"}` (schema in `parts/contracts/run-bundle.md §background`), and append `background_started`.
      - **ScheduleWakeup** (preferred): schedule `/masterplan --resume=<state-path>` at `delaySeconds: 270` (within 5-minute cache window) and append `wakeup_scheduled`, then close.
      - **No ScheduleWakeup**: persist `pending_gate` and surface `AskUserQuestion("Codex is still running <task>. What next?", options=["Poll now (Recommended)", "Pause here — resume later", "Schedule wakeup"])`.
      - The next Step C entry MUST execute the Background-dispatch resume check before any new routing or redispatch.
    - **`gated`** — present diff + verification output via `AskUserQuestion(Accept / Reject and rerun inline / Reject and rerun in Codex with feedback)`.
    - **`loose` / `full`** — auto-accept if verification passed cleanly. If verification failed, fall back to inline rerun under `superpowers:systematic-debugging` and apply the autonomy's blocker policy from above (which itself triggers **CD-4** ladder work).
    - **Silent exit (infra failure)** — if Codex returns but the expected file changes didn't happen, treat as an infrastructure failure (distinct from a semantic `blocked` result). Apply the policy in `docs/conventions/codex-failure-policy.md`:
      - **Detection (primary):** `git diff --stat <task_start_sha>..HEAD` is empty (serial dispatch) or `staged_changes_digest` is null/empty (wave members), AND the task's `**Files:**` section declared `Create:` or `Modify:` paths.
      - **Detection (secondary):** return text contains `app-server control socket`, `ECONNREFUSED`, or `socket already in use` → classify as daemon-broken sub-type.
      - **Auth-degraded fast path:** if `~/.codex/auth.json` `last_refresh` > 7 days (non-chatgpt mode), skip streak and route inline immediately with `⚠ Codex auth degraded — routing <task> inline. Run: codex login`.
      - **Streak 1:** emit `⚠ Codex silent exit on <task> (attempt 1/2) — retrying dispatch` and redispatch once.
      - **Streak ≥ 2:** emit `⚠ Codex infrastructure failure on <task> (2 consecutive silent exits) — routing inline` and run inline. Track in session-only `codex_failure_streak[task_name]`; reset to 0 on successful Codex return.

    Append a `[codex]`, `[inline]`, or `[inline:codex-fallback]` tag to the completion event for each completed task so future-you can see the routing distribution. Use `[inline:codex-fallback]` when the inline run was triggered by the silent-exit threshold above.

