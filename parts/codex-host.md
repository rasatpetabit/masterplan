# Codex Host Suppression

Loaded by the router only when `/masterplan` is hosted by Codex (slash path resolves to `/superpowers-masterplan:masterplan`).

## When this file applies

Codex hosts `/masterplan` through the `/superpowers-masterplan:masterplan` route. Detect this by examining the active system/developer prompt and tool contracts: if the session identifies the agent as Codex, exposes Codex-native tools (`apply_patch` / `update_plan` / `request_user_input`), or uses an `AGENTS.md` compatibility map rather than Claude Code's native tool names, set in-memory `codex_host_suppressed = true` and load this file.

## Suppression rule

While hosted by Codex, **DO NOT dispatch the Claude Code `codex:codex-rescue` companion subagent**. The dispatch would be recursive (Codex calling Codex). This overrides any persisted `codex.routing` or `codex.review` config for the duration of the invocation.

## What stays in effect

Persisted `codex.routing` and `codex.review` configuration in `state.yml` remain active for Claude Code-hosted runs. This file only governs Codex-hosted invocations. Never mutate those config fields solely because the current invocation is Codex-hosted.

## Step 0 detection (v3.1.0+)

Before running any Codex availability detection, evaluate the host signal described above. If `codex_host_suppressed = true`:

1. **Skip `codex:codex-rescue` health checks entirely.** Do not run the `ping`, `scan`, or `trust` availability modes. The issue is not plugin absence; it is recursive Codex dispatch.

2. **Emit a visible stdout notice** (do not abort):
   > Running inside Codex — skipping `codex:codex-rescue` routing/review to avoid recursive Codex dispatch. Persisted config is unchanged.

3. **In-memory only:** treat effective `codex_routing` as `off` and `codex_review` as `off` for this invocation. Preserve the configured values for state fields and future Claude Code invocations unless the user explicitly changes them.

4. **Record in `events.jsonl`** on the next state write:
   ```
   <ISO-ts> codex host suppression — running inside Codex; codex_routing+codex_review forced off for this invocation (configured: routing=<configured>, review=<configured>).
   ```
   If no other state write occurs this turn, force a small state write: append the event, update `last_activity`, set `last_warning: codex host suppression this run — recursive codex dispatch disabled`.

5. **Downstream Step C** must use `decision_source: host-suppressed` whenever a task would otherwise have considered Codex routing or review.

## Eligibility cache: skipped under host suppression

When `codex_host_suppressed == true`, skip the entire eligibility-cache decision tree — the cache file is NOT built, loaded, or required. Step C step 3a routes inline with `decision_source: host-suppressed`; Step C step 4b skips Codex review for the same reason.

This is distinct from missing-plugin degradation: the Codex host is available, but recursive `codex:codex-rescue` dispatch is disabled by design.

Evidence-of-attempt entry for `events.jsonl` when skipped due to host suppression:
```
<ISO-ts> eligibility cache: skipped (running inside Codex — recursive codex dispatch disabled; see codex_host_suppressed event)
```

## Step C routing override

Per-task routing banner when host-suppressed:
```
→ Task T<idx> (<task name>) → INLINE (running inside Codex — recursive codex:codex-rescue disabled)
```

`decision_source` field: `"host-suppressed"`.

The host-suppressed branch is mandatory even when persisted `codex_routing` is `auto` or `manual`. Running inside Codex must never recursively call `codex:codex-rescue`.

## Codex user-facing resume syntax

Set in-memory `codex_user_entrypoint = "Use masterplan"` for visible close-out instructions. Any user-facing resume, next, pause, blocker, or budget-stop hint rendered while `codex_host_suppressed == true` MUST use the normal-chat form:

- `Use masterplan next`
- `Use masterplan execute <state-path>`
- `Use masterplan --resume=<state-path>`

Do NOT surface `$masterplan ...` as the primary hint: in Codex TUI shell-command mode, Bash expands `$masterplan` before executing. Do NOT call `Bash`/`exec_command` with `$masterplan ...`, `masterplan ...`, or `/masterplan ...`. Do NOT tell a Codex user to resume with Claude Code's `/masterplan ...` form unless the user explicitly asks for Claude Code instructions.

## Codex shell-trap recovery

If the latest user turn is a Codex shell transcript such as:
```
<user_shell_command><command>masterplan next</command> ... command not found
<user_shell_command><command>$masterplan next</command> ... next: command not found
```
Reinterpret it as a normal-chat invocation: `Use masterplan <args>`. Append `shell_invocation_trap_recovered` to `events.jsonl` on the next state write when a plan bundle is available. Render one visible warning line, then continue through the normal verb router. Stop for re-entry only when the arguments cannot be recovered.

## Codex host performance guard

Host-suppressed mode is a bounded interactive mode — not a license to execute the whole workflow inline, and not a blanket halt after every answered gate.

Set in-memory `codex_host_perf_guard` for the invocation (unless the user explicitly supplied both `/loop` and `--autonomy=full`):

```yaml
codex_host_perf_guard:
  tool_budget: 40        # orchestrator shell/tool calls this invocation
  gate_budget: 1         # unresolved structured gates this invocation
  large_read_budget: 2   # large reads (>500 lines or >20k chars) of prompt/plan/spec/transcript/event-log files
  phase_budget: 1        # automatic top-level phase transitions
```

These budgets are hard close checkpoints, not persisted config.

- An explicit gate answer that directly asks to keep moving (`full`, `continue`, `approve and run`, `start execution`, `run full kickoff`) does NOT consume the gate or phase checkpoint for the transition it authorizes; set in-memory `codex_host_gate_continuation = true` for that answered gate.
- When any budget is reached: write the smallest durable state update available (`last_activity`, `next_action`, `pending_gate` or `background` if present), set `stop_reason: scheduled_yield`, append `continuation_scheduled`, render `Codex host budget reached: <reason>; state preserved; send a normal Codex chat message: Use masterplan next or Use masterplan execute <state-path>.`, then → CLOSE-TURN.
- After any Codex `request_user_input`, resolve that gate result before doing anything else. If the result contains no answer, use the no-selection terminal render and → CLOSE-TURN. If it returns an answer label or free-form text (including the first/recommended option), treat that as explicit interactive selection: apply the selected option and persist `gate_closed`. Then continue when `halt_mode == none`, `requested_verb in {full, execute}`, `codex_host_gate_continuation == true`, or the selected option is a continuation option (`Continue to plan now`, `Approve and run writing-plans`, `Start execution now`, `Run full kickoff`). Close only for true halt gates (`post-brainstorm`, `post-plan`, resume/status/doctor/clean/retro pickers), no-selection gates, sensitive live-auth blockers, or an actual budget hit.
- Never close with a generic Codex-hosted structured-gate rationale as the sole reason.

## Summary-first loading (Codex host only)

For bare, `next`, `status`, `doctor`, `audit`, and transcript-review-style invocations, inspect run state through summary commands first (`rg --files docs/masterplan` plus targeted `state.yml` reads). Do not read the full `commands/masterplan.md`, full plans/specs, full transcripts, or full event logs unless the user explicitly asked to edit/audit that file or the targeted summary proves the full file is required.

## Sensitive live-auth stop

For workflows involving credentials, MFA, browser login, tax/finance/government portals, or other sensitive live-auth surfaces, Codex-hosted masterplan may perform at most one login/auth attempt per explicit user instruction. Never echo, store, or summarize secret values from transcripts. If auth blocks, persist/return a blocker with the next required user action and → CLOSE-TURN; do not loop through additional prompts or retries.

## Codex native goal pursuit

When running inside Codex and the native goal tools are available, Masterplan uses them as the cross-turn pursuit wrapper around the durable run bundle.

- Do NOT add `goal` as a Masterplan verb.
- Do NOT send `/goal`, `$goal`, or `goal` to Bash.
- On plan-ready and Step C resume paths, call `get_goal` once.
- If no active goal exists for an in-progress plan, call `create_goal` with objective `Complete Masterplan plan <slug>: <plan title or first task summary>`; set `token_budget` only when the user explicitly supplied one.
- Persist advisory `codex_goal: {objective, linked_at, created_by_masterplan}` in `state.yml`; append `codex_goal_created` or `codex_goal_linked` to `events.jsonl`.
- If a different active goal exists, persist `pending_gate` and ask whether to continue that goal, switch by ending/clearing it outside Masterplan, or pause; do not overwrite silently.
- On verified Step C completion, call `update_goal(status="complete")` only if the active goal still matches `codex_goal.objective`; otherwise append `codex_goal_complete_skipped` and leave the native goal untouched.
