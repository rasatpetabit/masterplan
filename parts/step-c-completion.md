# Step C — Execute: Completion (loop scheduling + plan finalizer)

<!-- Loads on demand: sub-file 4 of 4 after step-c-verification.md.
     Contains: Step C step 5 (cross-session loop scheduling via ScheduleWakeup)
     and Step C step 6 (plan completion finalizer: dirty check, retro, branch finish).
     DISPATCH-SITE: step-c-completion.md:plan-completion -->

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
