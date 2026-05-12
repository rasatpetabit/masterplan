# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [3.2.8] — 2026-05-11 — User-facing scrub of `bin/masterplan-state.sh`

### Fixed

- **Broken path recommendations in user-facing surfaces.** The plugin runs in
  *other* projects, so `bin/masterplan-state.sh` does not exist in the user's
  CWD — it lives inside the plugin install dir
  (`~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/bin/...`).
  Suggesting that path to end-users (or to the orchestrator running in the
  user's CWD) always 404s. Removed every user-facing reference and replaced
  with the corresponding slash-command flow:
  - `skills/masterplan-detect/SKILL.md` — frontmatter and the rendered legacy
    artifact suggestion now recommend only `/masterplan import`.
  - `skills/masterplan/SKILL.md` — Codex summary-first inventory phrasing now
    uses `rg --files docs/masterplan` plus targeted `state.yml` reads; removed
    the "if `bin/masterplan-state.sh` is present, prefer" fallback block.
  - `commands/masterplan.md` — Step 0 host loading, legacy migration prose,
    Step D next-feature discovery, the doctor `--fix` action for
    "Legacy plan not migrated", the clean `legacy` category detector, and the
    state.yml schema-example comment all stop pointing at the script. The
    doctor `--fix` action now reads "invoke `/masterplan import` and select
    `<slug>` from the picker" (Step I itself is unchanged — no new `--slug`
    short-circuit was introduced).
  - `README.md` — removed `bin/masterplan-state.sh inventory` /
    `migrate --write` from the prose paragraph and from the user-runnable
    command block (`/masterplan import` was already listed there).
  - `docs/masterplan/README.md` — the run-bundle README now recommends
    `/masterplan import` for legacy migration.

### Unchanged

- `bin/masterplan-state.sh` itself stays in the repo as plugin-internal dev
  tooling. Repo-internal references in `CLAUDE.md`, `docs/internals.md`,
  earlier `CHANGELOG.md` entries, and `bin/masterplan-self-host-audit.sh` are
  preserved — they describe the plugin's own dev surfaces for plugin
  developers, not end-user instructions.

## [3.2.7] — 2026-05-12 — Forward-progress audit instrumentation

### Added

- **Structured follow-up routing for completed meta-plans.** Run state now
  carries `plan_kind` and `follow_ups` so audit/doctor/import/status work that
  discovers confirmed implementation gaps must materialize routable follow-up
  records instead of leaving prose `next_action` text behind. The archived
  petabit-os-mgmt audit class is explicitly mapped to implementation follow-ups
  for DNS/oper reporting cleanup and datastore list-key merging.
- **Forward-progress session audit warnings.** `bin/masterplan-session-audit.sh`
  now scans run state in addition to Claude/Codex transcripts and telemetry,
  reporting stable warning codes for meta-resume loops, shell invocation traps,
  activity without outcome events, unroutable prose next actions, and completed
  meta-plans whose confirmed gaps were not materialized as structured
  follow-ups.
- **Recurring local audit loop.** Added `bin/masterplan-recurring-audit.sh` to
  persist redacted audit snapshots and `bin/masterplan-audit-schedule.sh` to
  install/status/uninstall a managed cron block without touching unrelated
  crontab entries.

### Fixed

- **Codex shell-trap recovery.** Codex-hosted Masterplan now treats
  `<user_shell_command>` transcripts for `$masterplan ...` or `masterplan ...`
  as recoverable normal-chat invocations, records the recovery on the next state
  write, and routes through the normal verb handler instead of asking the user
  to retype.
- **Implementation work outranks completed audit resumption.** Resume selection
  prefers in-progress implementation plans and pending implementation
  follow-ups over completed meta-plans, preventing the orchestrator from looping
  on an already-finished audit.

## [3.2.6] — 2026-05-12 — Codex native goal pursuit

### Added

- **Codex native goal bridge.** Codex-hosted Masterplan runs now use Codex's
  native goal tools as the cross-turn pursuit wrapper after a plan exists:
  reconcile with `get_goal`, create a matching plan goal with `create_goal` when
  needed, and call `update_goal(status="complete")` only after Masterplan's own
  completion finalizer succeeds. `/goal` remains a Codex host feature, not a
  Masterplan verb or shell command.

### Fixed

- **Cleanup preserves completed plans with follow-up work.** The `completed`
  clean detector now skips `status: complete` bundles whose `next_action` still
  names concrete follow-up work, classifying them as `completed_with_follow_up`
  for Step N instead of archiving them as done.
- **Session audit detects unfinished native goals.** The Codex session audit now
  recognizes `create_goal` and `update_goal(status="complete")` tool calls and
  reports native goals that were created but never completed.

## [3.2.5] — 2026-05-12 — Codex normal-chat resume hints

### Fixed

- **Codex resume hints avoid shell mode.** Codex-facing close-out and
  budget-stop text now tells users to send a normal chat message such as
  `Use masterplan execute <state-path>` instead of printing `$masterplan ...`,
  which Codex TUI shell-command mode sends to Bash as environment-variable
  expansion.
- **Codex goal outcome audit.** `bin/masterplan-session-audit.sh` now classifies
  Codex guardian approval sub-sessions as auxiliary, reads Codex
  `task_complete.last_agent_message` stop signals, exposes `session_role`,
  `goal_outcome`, and `goal_failure_reasons` in JSON output, and prints a
  redacted "Started goals at risk" section for primary sessions.

## [3.2.4] — 2026-05-12 — loop-first resume contract

### Added

- **Session audit regression harness.** `bin/masterplan-session-audit.sh` is now
  a thin wrapper around `lib/masterplan_session_audit.py`, with fixture-backed
  unit tests covering ambient `/masterplan` mentions, active sessions with and
  without telemetry, duplicate warning collapse, stable JSON warning codes, and
  legacy environment-variable defaults. `bin/masterplan-self-host-audit.sh`
  also includes a `--session-audit` gate so future prompt/docs changes cannot
  silently regress the incident-audit contract.
- **Loop-first resume contract.** `state.yml` now distinguishes
  `stop_reason` from execution `status`, reserves `status: blocked` for
  safety-only `critical_error` recovery, and documents the resume controller
  that re-renders gates, polls background work, or continues the active plan
  without operator-maintained state.

### Fixed

- **Codex interactive gate selections.** Codex-hosted `request_user_input`
  results now count as explicit interactive selection evidence whenever the
  tool returns an answer label, including the first/recommended option with no
  free-form note. Masterplan no longer preserves `pending_gate` or emits a
  no-action terminal response solely because the selected option was marked
  recommended.
- **Session audit masterplan classification.** `bin/masterplan-session-audit.sh`
  now treats `/masterplan` telemetry coverage as active only when a user
  invocation or orchestrator runtime marker is present, avoiding false missing-
  telemetry warnings from ambient repo names, skill listings, docs, and
  developer prompt text. The warning report also de-duplicates identical
  source/repo/session/code warning entries before computing repo warning totals,
  and JSON output exposes stable `code` fields for automation.
- **Codex resume hints.** Codex-hosted close-out and budget-stop text now uses
  the portable `$masterplan ...` skill form, such as
  `$masterplan execute <state-path>`, instead of telling Codex users to resume
  with Claude Code's `/masterplan ...` slash command. The Codex self-host audit
  now checks that command prompt, README, and skill docs keep this contract.
- **Session audit stop classification.** Active Masterplan sessions now report
  `stop_kind` (`question`, `critical_error`, `complete`, `scheduled_yield`, or
  `unknown`) and warn with `active_masterplan_unclassified_stop` when a session
  closes without a classified loop-first stop signal.

## [3.2.3] — 2026-05-11 — adaptive brainstorm interviews

### Added

- **Adaptive brainstorm interview contract.** Step B1 now briefs every spec-creating kickoff (`brainstorm`, `plan`, and `full`) to ask enough structured interview questions before approaches/spec writing, scaling depth by resolved complexity, issue seriousness, and current understanding.

## [3.2.2] — 2026-05-11 — Codex host budget and telemetry audit fixes

### Added

- **Redacted session telemetry audit.** Added `bin/masterplan-session-audit.sh`, a read-only audit over Claude JSONL, Codex JSONL, and `docs/masterplan/*/telemetry*.jsonl` that reports repo-level totals, top offending sessions, Codex runaway thresholds, Claude fanout/SessionStart payload warnings, telemetry-size warnings, and missing-telemetry coverage gaps without printing prompts, commands, tool results, or secrets.

### Fixed

- **Codex-host runaway execution.** Codex-hosted `/masterplan` now has explicit performance budgets, summary-first loading, unresolved-gate/phase budget checkpoints, and a sensitive live-auth stop rule so host-suppressed runs do not turn a status/audit request into hundreds of inline tool calls.
- **Codex post-gate continuation.** Explicit Codex `request_user_input` continuation answers now keep `full` / `execute` flows moving after `gate_closed`; host suppression blocks recursive Codex dispatch, not same-turn continuation requested by the user.
- **Codex entrypoint prompt loading.** The Codex-visible `masterplan` skill now instructs Codex to load targeted sections of `commands/masterplan.md` instead of dumping the full canonical prompt on ordinary runtime invocations.
- **Claude SessionStart prompt exposure.** The SessionStart self-healing hook now installs a compact `/masterplan` shim (`<!-- masterplan-shim: v3 -->`) instead of symlinking the full orchestrator prompt into `~/.claude/commands/masterplan.md`; the full prompt is loaded only when the plugin command is invoked.

## [3.2.1] — 2026-05-10 — Codex gate-consent hardening

### Fixed

- **Codex recommended-answer guard.** Codex-hosted `request_user_input` results that select only the first/recommended option with no `user_note` are now treated as weak evidence, not consent. Masterplan preserves `pending_gate`, avoids phase/artifact mutation, and renders a no-action terminal message instead of writing `gate_closed`.
- **Doctor legacy-reference false positives.** Legacy `docs/superpowers/...` artifacts referenced from bundle `state.yml` `artifacts.*` or `legacy.*` entries no longer report as unmigrated just because the legacy filename slug differs from the bundle slug.

### Added

- **Self-host Codex audit coverage.** `bin/masterplan-self-host-audit.sh --codex` now verifies the recommended-answer guard remains present in the shipped orchestrator prompt.

## [3.2.0] — 2026-05-10 — anchored brainstorming and Codex config bootstrap

### Added

- **Brainstorm intent anchor.** Step B1 now reads cheap repo truth before invoking `superpowers:brainstorming`, classifies the topic (`feature-ideas`, `implementation-design`, `audit-review`, `deferred-task`, `execution-resume`, or `unclear`), persists `brainstorm_anchor` in `state.yml`, and records `brainstorm_anchor_resolved` before spec writing.
- **Anchor regression fixtures and audit coverage.** The self-host audit now checks the prompt contract and the transcript-derived fixtures for meta-petabit Yocto review drift, deferred ERROR_QA work, image/package policy scoping, and the one feature-ideas case that should still use an idea funnel.

### Fixed

- **Broad brainstorming drift.** Audit/review prompts, deferred task prompts, and cross-repo Yocto layer prompts now get structured anchor gates and scope boundaries before spec writing instead of immediately expanding into unconstrained feature planning.
- **Codex config bootstrap.** The Codex-visible `masterplan` skill now explicitly loads `~/.masterplan.yaml` and repo-local `.masterplan.yaml` before deriving defaults, so Codex-hosted invocations preserve user-global settings like `autonomy` and `complexity` while still suppressing recursive `codex:codex-rescue` routing/review inside Codex.

## [3.1.1] — 2026-05-09 — continuation and Codex prompt exposure fixes

### Fixed

- **Codex masterplan entrypoint.** Added a Codex-visible `masterplan` skill so fresh Codex sessions can see the workflow, load `commands/masterplan.md`, and recognize Claude-created `docs/masterplan/<slug>/state.yml` run bundles. The previous packaging only proved marketplace registration; it did not prove prompt exposure.
- **`next` follow-up hardening.** Step N now treats completed plans with a concrete `next_action` as follow-up work instead of routing straight to "start a new plan." Follow-ups route to the branch finish gate, retro, doctor/status, or background polling as appropriate, and stale `plan.md` checkboxes no longer override completed `state.yml`.
- **Background dispatch continuations.** Codex/Agent returns that keep running in the background must persist a `background:` marker plus an exact poll `next_action`; the next Step C entry polls that marker before any redispatch instead of ending on an informal "I'll review when it finishes" handoff.
- **Completion dirty gate.** Step C now runs live `git status --porcelain` before writing `status: complete`. Task-scope dirt keeps the run in `finish_gate` with a concrete commit/finish action, preventing "complete" state from hiding uncommitted work.

## [3.1.0] — 2026-05-09 — Codex host compatibility

### Added

- **`next` verb — "what's next?" router (Step N).** `/masterplan next` now intercepts the word "next" before it can fall through to the bare-topic catch-all. Without this, typing "next" after a completed phase launched a new `/masterplan full next` brainstorm cycle, bloated context, triggered auto-compaction, wrote `last-prompt: next` metadata, and replayed "next" into a cascade. Step N scans state files inline (no subagent dispatch) and presents an `AskUserQuestion` gate: resume an active plan, start a new plan, or check status. Routing to Step C / Step A / Step B / Step S / Step M as appropriate. Updated all six sync'd locations per the anti-pattern #4 rule: routing table, arg-parse match set, reserved-verbs warning, README command table, internals routing table, and frontmatter `description:`.
- **Codex-native plugin packaging.** Added `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, and the `plugins/superpowers-masterplan -> ..` symlink so Codex can discover the repository as a plugin marketplace while keeping `commands/masterplan.md` as the single behavior source. The portable Codex invocation is `/superpowers-masterplan:masterplan`.
- **Codex host suppression.** Step 0 now detects when `/masterplan` is already running inside Codex and suppresses `codex:codex-rescue` ping/routing/review for that invocation. Step C routes inline with `decision_source: host-suppressed`, skips eligibility-cache requirements, and records a host-suppression event instead of misreporting the Claude Code companion as missing.

### Changed

- README, internals, release notes, and the orchestrator prompt now distinguish Codex as a plugin host from the separate Claude Code `codex:codex-rescue` companion used for delegated execution/review.
- Codex compatibility docs now state that Codex-hosted runs use `/superpowers-masterplan:masterplan` directly, while Claude Code-hosted runs may still use the optional `openai/codex-plugin-cc` companion for cross-model execution/review.

## [3.0.0] — 2026-05-08 — run bundles, migration, and default completion finalization

Major release that moves `/masterplan` state to run bundles and makes successful completion durable by default.

### Added

- **Run bundles under `docs/masterplan/<slug>/`.** `state.yml`, `spec.md`, `plan.md`, `retro.md`, `events.jsonl`, archives, telemetry, subagent records, eligibility cache, and queued state writes now live together. `state.yml` is created before brainstorming so compaction or a stopped session has a durable resume pointer from the start.
- **Legacy migration helper.** New `bin/masterplan-state.sh` inventories and copy-migrates pre-v3 `docs/superpowers/...` plans, standalone specs, standalone retros, archives, and sidecars into run bundles. Migration is copy-only and preserves source paths under `legacy:`.
- **Default completion finalizer.** When Step C finishes all tasks, `/masterplan` now marks the run complete, generates `retro.md`, archives the run state in `state.yml`, and then runs a completion-safe archive-only cleanup for verified legacy/orphan state. Use `--no-retro`, `--no-cleanup`, `completion.auto_retro: false`, or `completion.cleanup_old_state: false` to opt out.
- **Run-bundle-aware tooling.** Routing stats, telemetry capture, detect skill guidance, internals docs, and README examples now read/write the new layout while retaining legacy compatibility where needed.

### Changed

- `/masterplan retro` remains available manually, but successful completion auto-invokes the retro path by default for low, medium, and high complexity plans.
- `/masterplan clean` remains the broad manual cleanup verb. Step C's automatic cleanup uses only the safe subset: `legacy` and `orphans`, archive mode, current worktree, no prompts, no deletes, no stale/crons/worktrees.

### Migration Notes

- Existing pre-v3 artifacts are not deleted by migration. Run `bin/masterplan-state.sh migrate --write` or `/masterplan import` to copy them into bundles, then let completion cleanup or `/masterplan clean --category=legacy` archive verified originals. This release dogfooded that path: six legacy records were migrated to `docs/masterplan/`, and verified originals were archived under `legacy/.archive/2026-05-08/`.
- Archived legacy records with no original spec keep `artifacts.spec` empty; consumers must tolerate empty artifact values for migrated archived records.

## [2.17.1] — 2026-05-08 — version bump (no functional changes)

Patch release to advance version numbering; no functional changes since v2.17.0.

## [2.17.0] — 2026-05-07 — `--resume=<path>` worktree-aware path resolution

Folds in a fix surfaced during the AUQ-violation investigation (see WORKLOG `2026-05-07 (PM)`). When `/masterplan --resume=<rel-path>` is invoked from a parent of the worktree containing the status file (typical `xcvr-tools-fresh` / `optoe-ng` layout — repo root has `.worktrees/<feature>/docs/superpowers/plans/...`), the path doesn't resolve at cwd and Step 0 previously had no fallback. The user had to manually `cd` into the worktree before re-invoking.

### Added

- **`--resume=<path>` worktree-aware path resolution (`commands/masterplan.md` Step 0; v2.17.0+).** When `--resume=<path>` (or `--resume <path>` / `execute <path>`) is given AND `<path>` is relative AND `test -e <path>` is false against the current working directory, the orchestrator now searches `.worktrees/*/<path>` glob candidates against both `<cwd>` and `<repo-root>` before erroring. Resolution rules:
  - **Exactly one match** → `cd` to that worktree before Step 0's repo-local config reload, emit a one-line stdout notice (`↻ --resume path resolved into worktree <path>; cd'd before Step C config load.`), then proceed to Step C step 1's batched re-read with the resolved absolute path. The repo-local `<worktree>/.masterplan.yaml` is now picked up.
  - **Zero matches** → surface `AskUserQuestion("--resume path '<path>' not found at cwd or in any .worktrees/*/ subdirectory of <cwd> or <repo-root>. What now?", options=["Abort and let me re-run with a correct path (Recommended)", "Search the entire repo for matching status files (slower; uses find . -path '*/<path>')", "Treat <path> as a topic and route to Step A"])`. Preserves the existing `execute <topic>` fallback semantics.
  - **Multiple matches** → surface `AskUserQuestion("--resume path '<path>' matches multiple candidates. Which one?", options=[<one option per candidate, label = '<worktree-path>/<path>', up to 4>, ...])`. If more than 4 candidates, the first 3 are ordered by `last_activity` from each matching status file's frontmatter (descending), plus a fourth "List all in stdout and abort" option.

  Absolute paths bypass the search (existing direct-load behavior unchanged — Step C step 1's parse guard catches missing absolute paths at file-read time).

### Notes

- The orchestrator-side fix complements an out-of-orchestrator hardening pass landing in the same release window: a new `~/.claude/skills/auq-override/SKILL.md` user-level skill plus `hooks/auq-guard.sh` Stop hook (registered in `~/.claude/settings.json`) that warn when an assistant turn ends on a prose question outside an `AskUserQuestion` tool call. These pieces live outside the plugin (user-config territory) and are not shipped via the marketplace; the orchestrator change in this version is the only plugin-side delta.

## [2.16.0] — 2026-05-07 — May 7 failure resolution: per-task CD-9 hole, verb-explicit routing, compaction notice, invocation sentinel

Synthesizes findings from a transcript audit of every May 7, 2026 `/masterplan` session across `~/dev` (16 transcripts, ~36 MB). Two parallel Sonnet survey agents plus a deep-read of `commands/masterplan.md` triangulated four root causes that survived v2.10.x–v2.15.x. Three are orchestrator bugs with prompt-level fixes; one is a Claude Code harness bug we mitigate with a sentinel + docs.

### Fixed

- **Per-task CD-9 hole at Step C step 4→5 (Bug A; `commands/masterplan.md`).** When `/loop` was not active, Step C's post-task finalization fell into step 5's `"skip scheduling silently — the user resumes manually"` branch with no positive directive on what to do next. The orchestrator improvised free-text gates like *"Want me to continue to T11 (per-page content rendering …)? It's a bigger task"* and ended the turn (`stop_reason: end_turn`), violating CD-9. Reproducer: petabit-www 2026-05-07 23:26 (T10→T11 boundary). New **Step C step 4e — Post-task router** routes deterministically by autonomy + `ScheduleWakeup` availability:
  - `/loop` active → step 5 (existing wakeup scheduling, every 3 tasks).
  - `/loop` inactive AND `--autonomy=full` → re-enter step 2 silently with `current_task` updated.
  - `/loop` inactive AND `--autonomy ∈ {gated, loose}` → fire structured per-task gate via `AskUserQuestion(Continue (Recommended) / Pause here / Schedule wakeup)`. Continue dispatches the next task in the same turn; Pause here closes turn via CC-3-TRAMPOLINE; Schedule wakeup calls `ScheduleWakeup` honoring `loop_max_per_day`.
  - All-tasks-done → step 6 (finishing-branch wrap, unchanged).
  - Status flipped to `blocked` → → CLOSE-TURN (4a/4b/4c already wrote `## Blockers`).
  - Wave-end variant: gate fires once per wave (not N times), with task name = `<wave-group> wave (<N> tasks)`.

  New operational rule reinforces this at the top level: *"Per-task boundaries are not natural stopping points. Step C step 4e is the only legal close site between tasks."*

- **`/masterplan execute <topic>` silently routes to brainstorm (Bug B; `commands/masterplan.md`).** When the user typed `/masterplan execute phase 7 restconf`, the routing table only matched `execute <status-path>` — non-path arguments fell into Step A which discarded the explicit `execute` verb when no status files matched. Step A then routed to "Start fresh → Step B" (brainstorm). Reproducer: petabit-os-mgmt 2026-05-07 00:53 (`/masterplan execute phase 7 restconf --complexity=high` produced *"Routing: Step A → no active plans → fresh start → Step B1 (brainstorm)"*; the word "execute" never appeared in any orchestrator output). Three changes:
  - **New routing-table row.** `execute <topic-or-fuzzy-slug>` → Step A with `requested_verb=execute`, `topic_hint=<remaining args>`. The path-vs-topic disambiguation is `test -e <remaining>`.
  - **Argument-parse precedence stash.** Step 0's verb-match step now stashes `requested_verb = <matched-verb>` for downstream steps to consult.
  - **Step A verb-explicit override (new step 7).** Before the existing "Start fresh → Step B" branch, consult `requested_verb`. When `requested_verb == 'execute'` AND user picked Start fresh OR `topic_hint` did not match: surface `AskUserQuestion(Run full kickoff (Recommended) / Pick from existing / Brainstorm-only / Cancel)`. The user's explicit `execute` verb is no longer silently discarded.

- **Compaction-recent state ignored on re-entry (Bug C; `commands/masterplan.md`).** After `/compact` fired, `/masterplan` re-derived state from the filesystem (status files via Step M0) and discarded the compaction summary's workflow position. Reproducer: petabit-os-mgmt 2026-05-07 00:46→00:54 (compaction summary said *"interrupted before Step B1"*; orchestrator at 00:54 re-ran Step 0 + Step A from scratch, output *"Zero status files found across all worktrees"*). New **Step 0 Compaction-recent notice** detects (a) `"session was compacted"` / `"post-compaction"` in the first system reminder, (b) literal `/compact` in the preceding user message, (c) optional best-effort: a `type:summary` jsonl message ≤ 30 minutes old. When detected, emits a single non-blocking line: *"↻ Compaction detected this session — verifying plan state from filesystem. If you intended to resume specific work: `/masterplan --resume=<status-path>`. Otherwise this run will route per the args you typed."* Pairs with Bug B's verb-explicit override — together they catch the case where the user expected to resume but the filesystem disagrees. Conservative by design: no JSONL parsing in the hot path, no pre-routing prompts.

### Added

- **Invocation sentinel (Bug D mitigation; `commands/masterplan.md`).** Before config load, before git_state cache, before verb routing, every `/masterplan` turn emits ONE plain-text first line: *"→ /masterplan v\<version-from-plugin.json\> args: '\<$ARGUMENTS or empty\>' cwd: \<repo-root or pwd\>"*. Makes "did `/masterplan` run?" trivially observable. Reproducer: optoe-ng 2026-05-07 23:14→23:19 (sequence `/compact` → `/plugin` → `/reload-plugins` → `/masterplan --complexity=high` produced **zero assistant response** — last record was a queue-operation, no orchestrator output at all). The sentinel makes the harness-level command-de-registration visible: if the user sees no `→ /masterplan` line, they know to re-install via `/plugin`. CC-3-TRAMPOLINE does not apply — the sentinel is an unconditional first-line render.

- **Self-host audit catches the new free-text gate phrasings (`bin/masterplan-self-host-audit.sh`).** `check_cd9`'s regex extended to flag: `Want me to (continue|proceed|advance|run|execute)`, `Should I (continue|proceed|advance)`, `Shall I (continue|proceed)`, `Let me know (when|if|how)`, `(when|after) you're ready, (let me|I'll)`, `Continue to T<N>?`. Existing exemption logic (cd9-exempt marker, AskUserQuestion proximity, CD-9 rule definition skip, "Don't stop silently" restatement) unchanged — auto-skips legitimate restatements inside the rule-definition section. Catches future regressions of Bug A at audit time before commit.

### Notes

- **Known issue: `/reload-plugins` may de-register `/masterplan`.** After `/reload-plugins`, the next `/masterplan` invocation can produce zero output (observed once on 2026-05-07 in optoe-ng session 0cbe737f). The Step 0 invocation sentinel introduced here makes this observable: if you don't see `→ /masterplan v…` on the first line, the harness has de-registered the command. **Workaround:** re-install via the marketplace (`/plugin` → uninstall → install `superpowers-masterplan`) and re-invoke. v2.13.1's marketplace install self-healing covers fresh installs but does not fire on `/reload-plugins`. Upstream tracking will be filed at the Claude Code repo with the optoe-ng transcript as the reproducer; the URL will be added to this note in a follow-up.
- **No regressions of v2.14.x or v2.15.0.** v2.14.0/2.14.1's `git for-each-ref` import discovery is preserved; v2.14.0's `doctor --fix` for checks #20/#21/#1a is preserved; v2.15.0's doctor end-gate `AskUserQuestion` and noargs precedence rule are preserved. The v2.16.0 fixes are additive.
- **Per-task gate is autonomy-aware by contract.** Under `--autonomy=full` the gate is suppressed (silent advance). Under `/loop` step 5 takes precedence (wakeup scheduling). Under `gated` and `loose` without `/loop`, every task boundary is a structured AskUserQuestion checkpoint per the user's chosen contract from the May 7 review.

## [2.15.0] — 2026-05-07 — doctor end-gate (`AskUserQuestion` offer `--fix`) + noargs resume-first routing fix

### Added

- **Doctor end-gate: offer `--fix` via `AskUserQuestion` after lint-only runs (`commands/masterplan.md`).** When `/masterplan doctor` (without `--fix`) finds at least one auto-fixable issue (checks #1a, #2, #3, #9, #12, #20, #21, #24), it now closes the turn with `AskUserQuestion` asking whether to run `--fix` inline. Picking "Run --fix now" re-executes Step D with `--fix` semantics, emitting only the changed-files list and updated summary (not the full detection report again). Gate is suppressed when `--fix` was already passed, when no auto-fixable findings exist, or when the report is clean. Previously, a lint-only run that found fixable issues was a dead end — the user had to manually type the `--fix` invocation.

### Fixed

- **Bare-invoke argument-parse missing step 0 (`commands/masterplan.md`).** The argument-parse precedence section (in Step 0) listed three match cases (known verb / `--` flag / non-flag word) but had no case for zero-token invocation. A Claude instance reading only this section could fall through all three without a match and route unpredictably (catch-all / Step B / Step A) on a bare `/masterplan` call. Added explicit step 0: "If no args → route to Step M (resume-first)." The verb routing table already had the `_(empty)_` row and Step M0 step 8 already implemented the correct resume-first logic — this closes the prose gap that caused intermittent wrong-step routing.

## [2.14.1] — 2026-05-07 — Step I1 brief tightening: filter symbolic `refs/remotes/<remote>/HEAD` by full refname

Follow-up to v2.14.0 issue #3 fix, surfaced by smoke-testing the v2.14.0 brief against `petabit-os-mgmt` with a Haiku Explore subagent.

### Fixed

- **Step I1 source class 2 brief — symbolic-HEAD ambiguity (`commands/masterplan.md`).** v2.14.0's brief said "exclude `HEAD`" but `git for-each-ref refs/remotes/ --format='%(refname:short)'` renders `refs/remotes/origin/HEAD` as the **bare token `origin`** — NOT catchable by `grep -v HEAD` on the short form. A Haiku running the v2.14.0 brief self-reported the ambiguity verbatim during smoke test: *"the brief says to exclude 'HEAD' but doesn't specify whether to filter on the literal substring 'HEAD' in refname:short output (doesn't appear here), [or] the `refs/remotes/<remote>/HEAD` symbolic ref nature."* It guessed right by interpretation, but a worse-luck run would either drop the bare `origin` (false negative) or flag it (phantom finding when HEAD diverges from `<trunk>`). New brief uses `--format='%(refname)|%(refname:short)'` to emit both forms in one line, instructs Haiku to **filter on the full refname** (drop any line whose full path ends in `/HEAD`), and **use the short name** for display + topology check. Removes the ambiguity at the source.

## [2.14.0] — 2026-05-07 — Step I1 ref enumeration fix + doctor `--fix` actionability (cache rebuild, stray-orphan rm, no-fix diagnostic)

Closes GitHub issues #1 and #3.

### Fixed

- **Step I1 git artifact scan misses remote-only branches (issue #3).** The Haiku brief's `git branch -avv` instruction was being silently downgraded to `git branch -v` (or to local-only iteration) by some agent runs, producing false negatives where remote branches with diverged commits were never flagged. Replaced with explicit `git for-each-ref refs/heads/ refs/remotes/ --format='%(refname:short)'` enumeration in `commands/masterplan.md` Step I1 source class 2. `git for-each-ref` returns one ref per line in a stable format (no parsing ambiguity), and the brief now mandates this command verbatim. Also clarified that the check is topology-based (`git log <trunk>..<ref>` non-empty SHA reachability), not content-based — rebased-equivalent branches are still flagged because the cleanup action is deleting the stale ref, not re-importing the content. Reproducer was petabit-os-mgmt `origin/phase-5-southbound-ipc` (3 commits ahead of main), silently skipped across two consecutive import sessions.

### Added

- **`doctor --fix` extends to checks #20 and #21 (eligibility cache rebuild) — issue #1 Fix 1.** Cache rebuild is deterministic from plan annotations (mirrors Step C step 1's Build path) — no judgment call. The new `--fix` action runs the annotation-completeness scan inline; if complete, the orchestrator builds the cache inline (no subagent dispatch); if incomplete, dispatches one Haiku per the existing fallback path. Writes `<slug>-eligibility-cache.json`, appends `eligibility cache: rebuilt (...) — via doctor --fix` to the status's `## Activity log`, and commits as `masterplan: rebuild eligibility cache for <slug> via doctor --fix`. When both #20 and #21 fire on the same plan (the common case — same root cause, different footprint), one `--fix` invocation resolves both. Closes the largest "10 warnings, 0 fixes" hole in steady-state mature-repo doctor runs.
- **`doctor --fix` extends to check #1 sub-class #1a (stray-duplicate-orphan plans) — issue #1 Fix 2.** New sub-classification fires when an orphan plan has an in-status counterpart in another worktree of the same repo, the orphan is at-or-behind the canonical copy (mtime/hash check), and the orphan's worktree is NOT the worktree the in-status frontmatter points at. The orphan is provably a stale snapshot from a sibling worktree (common after creating a worktree and finalizing the plan elsewhere); `--fix` runs `git rm <stale-path>` per stray plus one commit per affected worktree (`masterplan: remove <N> stray-duplicate orphan plan(s) via doctor --fix`). The original #1 (true orphan, no in-status counterpart anywhere) still has "no auto-fix" — judgment call: the user may have intentional rough notes that aren't ready for masterplan schema.
- **`doctor --fix` actionability diagnostic — issue #1 Fix 3.** When `--fix` ran but produced 0 file changes despite N > 0 findings, surface a top-line warning BEFORE the per-finding details: `⚠ doctor --fix found <N> warnings, 0 of which match the auto-fix action set.` followed by check-grouped one-line remediation hints. Suppresses when ≥ 1 file change occurred (the changed-files list is its own evidence) and when `--fix` was not passed (no-`--fix` runs are read-only by definition). Closes the historical UX failure where users would run `--fix`, get 10 warnings + a buried "0 files changed/moved" line, and conclude `--fix` was broken.

## [2.13.1] — 2026-05-07 — marketplace install self-healing: auto-symlink `/masterplan` slash command

### Fixed

- **`/masterplan` not found after marketplace install.** The Claude Code marketplace installer deploys command files to `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/commands/` but Claude Code's slash-command discovery only scans `~/.claude/commands/`. When the marketplace installer ran, it backed up any prior direct-install copy of `masterplan.md` but did not create a replacement in `~/.claude/commands/`, causing `/masterplan` to vanish from autocomplete.

### Added

- **`hooks/hooks.json` — self-healing SessionStart hook.** On each session start, checks whether `~/.claude/commands/masterplan.md` is a live symlink to the marketplace copy; if missing or dangling, recreates it silently. Mirrors the `hooks/hooks.json` convention used by `obra/superpowers`. Prevents the "upgrade broke /masterplan" class of failures for future reinstalls.

## [2.13.0] — 2026-05-06 — CC-2 threshold tightening + CC-3-TRAMPOLINE close-turn discipline + stats `--plan` slug fix

### Fixed

- **`/masterplan stats --plan=<bare-slug>`** silently returned zero records when callers passed a human-readable slug (e.g., `phase-4-cli-engine-mvp`) because the on-disk status filename includes a `YYYY-MM-DD-` prefix that the equality check never stripped. `bin/masterplan-routing-stats.sh` now falls back to a date-prefix-stripped match when the literal equality fails. Surfaced from real petabit-os-mgmt usage.

### Changed

- **CC-2 — Subagent-delegate triggers tightened (`commands/masterplan.md`).** Bash-output threshold lowered from `> 100 lines` → `> 50 lines`; file-read threshold lowered from `> 300 lines` → `> 50 lines` (orientation reads ≤ 50 still excepted; cumulative reads of the same file count). Added two new triggers: **coordinated edits to ≥ 2 files** for one conceptual change → dispatch a single Sonnet subagent with the full edit-set as the bounded brief; **cumulative inline Edits > 5 within a single turn** for any single file → at the 5th Edit, stop and dispatch Sonnet to complete the rest as a batched edit. Root cause: petabit-os-mgmt Phase 4 telemetry showed Opus consuming ~70%+ of session tokens via inline tool calls that the prior thresholds never caught — the v2.12.0 model-passthrough enforcement only governed *explicitly dispatched* subagents, not the inline work the orchestrator was doing itself.

### Added

- **CC-3-TRAMPOLINE — Canonical turn-close sequence (`commands/masterplan.md`).** New ~20-line operational rule defines a single enforcement point for CC-3. Every turn-close routes through: (1) CC-3 summary if `subagents_this_turn` is non-empty, (2) site-specific pre-close action (commit, status-file write, ledger append, etc.), (3) closer (`AskUserQuestion` / `ScheduleWakeup` / terminal render). Authoring convention: new turn-close sites write `→ CLOSE-TURN`; bare `"end the turn"` reserved for negation contexts ("never end the turn waiting on..."), AskUserQuestion option labels, and YAML/comment blocks. 19 existing turn-close sites converted to the new convention across Steps A/B/C/T/CL (Cancel/Abort/Done/Open spec/Open plan/Discard, blocker policies, daily quota exhaust, wakeup-ledger append, `stats` verb, `clean` verb).

### Notes

- Underlying fix landed in marketplace install copy as commit `24e6546d` during in-session work in `petabit-os-mgmt`; this release brings it into project HEAD with a proper version bump so subsequent plugin updates carry it everywhere.
- Followup for v2.14.0: extend `bin/masterplan-self-host-audit.sh` with a CD-style grep that flags non-negated `"end the turn"` occurrences in `commands/masterplan.md` (per CC-3-TRAMPOLINE's authoring rule).

## [2.12.0] — 2026-05-06 — per-turn subagent summary + model attribution enforcement

### Added

- **Per-turn subagent dispatch summary (`commands/masterplan.md`).** A new sub-section "Per-turn dispatch tracking and summary" mandates the orchestrator track every `Agent` invocation in a session-local list `subagents_this_turn` (reset at every top-level Step entry) and emit a one-line summary at end of every turn that dispatched ≥ 1 subagent. Format: `Subagents this turn: <N> dispatched (<count by model>) • <site> (<model>)`. Zero-dispatch turns emit nothing. The summary surfaces as plain stdout, NOT inside an `AskUserQuestion`, so the user has immediate visibility into what models were used. Cross-validation at next-turn-entry compares the in-memory tracker to the prior turn's `<plan>-subagents.jsonl` records and surfaces a `## Notes` warning on divergence (which would indicate the model-passthrough preamble was paraphrased or dropped by an upstream skill template). New operational rule **CC-3** at line 1981 codifies the end-of-turn render requirement.
- **Verbatim SDD model-passthrough preamble (Recursive application clause).** §Agent dispatch contract's recursive-application paragraph now requires the orchestrator to insert a literal fenced text block as the FIRST paragraph of every `superpowers:subagent-driven-development` and `superpowers:executing-plans` brief — not paraphrase it. The signature string `For every inner Task / Agent invocation you make` is the verifiable sentinel. This closes the gap where prose-only override clauses were being silently dropped, which is the root cause of the `model: "opus"` leakage on inner SDD Task calls.
- **`bin/masterplan-self-host-audit.sh --models` mode.** New `check_model_passthrough()` function: greps `commands/masterplan.md` for the verbatim preamble's signature string (must find ≥ 1), counts explicit `model:` attribution lines, warns on any `model: "opus"` occurrence outside blocker-stronger-model context. Run `bin/masterplan-self-host-audit.sh --models` to lint dispatch-site model attribution before commits.
- **`bin/masterplan-routing-stats.sh --models` mode.** New flag surfaces ONLY the model breakdown section (skips the routing table). Default render now also includes a "Model breakdown" section showing dispatches + token share per model (haiku / sonnet / opus / codex / unknown), plus the existing `opus_share` health metric. Users can run `bin/masterplan-routing-stats.sh --models` at any time to spot-check actual model distribution against the orchestrator's design intent.

### Fixed

- **Doctor check #23 (`Opus on bounded-mechanical dispatch sites`) now uses `AskUserQuestion` per CD-9.** The check itself shipped in v2.8.0 but its auto-fix cell printed plain text — violating the CD-9 rule introduced in later versions. Replaced with a 4-option `AskUserQuestion`: run audit script (Recommended) / investigate transcript / suppress for this plan / skip this finding. Stale `commands/masterplan.md:217-235` line citation also removed (post-merge drift); replaced with section-name reference (`§Agent dispatch contract recursive-application`).

### Notes

- **Why this exists.** User reported seeing nearly 100% Opus usage in `/masterplan` runs. Investigation found: telemetry hook captures the data correctly; Stop hook is wired; default models at each dispatch site are specified. **The gap was that recursive model passthrough through `superpowers:subagent-driven-development` was prose-only with zero programmatic enforcement** — if SDD's upstream prompt template stops parsing the override clause, every inner Task call silently inherits Opus from the parent, and there was no per-turn summary anywhere to surface this to the user. The verbatim-preamble + sentinel-grep pattern (Section 2 of the plan) closes the enforcement gap; the per-turn summary (Section 1) closes the visibility gap.
- **No telemetry data is required for the per-turn summary to work.** Tracking is in-orchestrator-memory; the JSONL cross-check is a safety net that runs only when the Stop hook is installed and a JSONL exists. Users without the hook still get accurate per-turn summaries.
- **Manual smoke-test deferred.** The cross-validation drift detection requires a real `/masterplan execute` turn against an existing plan to populate the JSONL. If the per-turn summary or drift detection misbehaves under real use, file as v2.12.1.
- **Upgrade hint for users with manual `~/.claude/bin/` copies.** v2.12.0 modified `bin/masterplan-routing-stats.sh` (added `--models` flag + Model breakdown render). After plugin update, run `bin/masterplan-self-host-audit.sh --fix` to re-sync the user-level copy, OR manually `cp` the new version over the stale user-level shim.

## [2.11.1] — 2026-05-06 — workflow simplification + skills/ drift detection

### Fixed

- **`/masterplan-detect` slash-command duplication.** A May-3 manual copy at `~/.claude/skills/masterplan-detect/` was shadowing the plugin's own registration, surfacing two `/masterplan-detect` entries in the slash-command list (one user-level, one plugin-namespaced). Cleaned up the user-level copy. The plugin's `skills/masterplan-detect/SKILL.md` continues to provide the registration.
- **`bin/masterplan-self-host-audit.sh` now detects `skills/` drift**, not just `commands/` and `hooks/`. New `check_skill_drift()` function iterates over every skill the plugin ships and warns on user-level shadow copies. Same shim-sentinel exemption pattern as the existing checks (skip if the user-level file contains `<!-- masterplan-shim: v[0-9]+ -->`). Closes the gap that allowed the masterplan-detect duplicate to slip past previous audits.

### Changed

- **Workflow simplification across `commands/masterplan.md`.** Ten sub-steps that existed primarily for documentation organization or pure routing have been inlined into their callers, flattening the structural surface from ~32 to ~21 distinct Step/sub-step headings (~30% reduction):
  - **Step M0 empty-state picker** — Tier 1 / Tier 2a / Tier 2b collapsed into one inline empty-state sub-block with the same option text and routing.
  - **Step P → Step A's spec-without-plan variant.** Step P had only one caller (the `plan` verb with no args/spec).
  - **Step I0 → Step I entry inline.** The "if direct args, skip to I3; else I1" routing is a one-line condition.
  - **Step I3.1 + I3.1.5 → Step I3's pre-flight collision checks.** Slug-collision and path-collision pre-passes combined under one section header.
  - **Step C 4a/4b/4c/4d → "Post-task finalization"** with four labeled internal sub-blocks (Verify, Codex-review, Worktree-integrity, Status-update). Conditional/ordering logic preserved.
  - **Step S4 → Step S3's `--plan` deep-dive branch.** The `--plan=<slug>` variant is a render-mode conditional, not a separate gather phase.
  - **Step I3.3 → inlined into Step I3.4's brief** as a pre-convert phase.
  - **Step I4 → inlined at end of Step I3.5.** The hand-off prompt was a single AskUserQuestion.
  - **Step CL0 → Step CL1's pre-flight block.** Banner emission and worktree-scope narrowing fold naturally into CL1's processing.
  - **Step CL4 → Step CL5's timer-status block.** Pure reporting; appended to the final report.

  All cross-references updated. No user-visible behavior change. No features removed. Wave dispatch, telemetry, complexity meta-knob, `clean` verb, doctor checks, AskUserQuestion options, and config knobs all stay intact. Net file delta: -14 lines (the structural value is in flattening, not byte-count).

### Notes

- The `/masterplan-detect` cleanup is a one-time fix for one user; future installs with deployment-drift will surface via the new `check_skill_drift()` audit.
- Step C's post-task finalization keeps its four internal sub-blocks clearly labeled — readability is preserved despite the flatter outer structure.
- Plugin cache may still contain old version directories under `~/.claude/plugins/cache/.../`. These are managed by Claude Code's plugin install path; `/plugin update` should clean them.

## [2.11.0] — 2026-05-06 — extract self-host checks; shim v2; retro auto-archive; doctor #28

### Fixed

- **`/masterplan` shim now uses slash-command re-invocation (sentinel `<!-- masterplan-shim: v2 -->`).** The v1 shim's body said "Invoke the `superpowers-masterplan:masterplan` skill with $ARGUMENTS", which routed through Claude Code's Skill tool. The Skill tool requires the skill to appear in the session's available-skills list — in some sessions it does not, and `/masterplan` returned "missing skill" forcing users to type the long form (`/superpowers-masterplan:masterplan`) manually. The v2 shim's body is just `/superpowers-masterplan:masterplan $ARGUMENTS`; Claude Code's slash-command resolver intercepts the qualified path at message-receive time, bypassing the Skill tool entirely. Forward-compatible: `bin/masterplan-self-host-audit.sh` matches any `<!-- masterplan-shim: v\d+ -->` sentinel so future shim revisions don't trigger drift warnings.
- **Architectural conflation: doctor checks #25 + #27 moved out of the runtime orchestrator.** Both checks silently skipped outside the `superpowers-masterplan` repo — they only fired when the developer was editing the orchestrator source. Living inside `commands/masterplan.md` meant they consumed prompt-token weight for every `/masterplan` invocation in every user's session despite never producing findings for end users. Extracted to `bin/masterplan-self-host-audit.sh` (developer-only shell script, mirrors the existing `bin/masterplan-routing-stats.sh` pattern). Run with `--fix` to apply drift repairs, `--drift` to scope to deployment-drift only, `--cd9` to scope to free-text-question grep only.

### Added

- **Step R3.5 — auto-archive after retro generation.** When `/masterplan retro` writes a retrospective, the source plan is now `git mv`'d to `docs/superpowers/archived-plans/` and the paired spec to `docs/superpowers/archived-specs/`. Spec collision avoidance: if other plans still reference the same spec, the user is prompted via `AskUserQuestion` whether to archive anyway (rewriting sibling status files), leave the spec, or abort. Behavior is opt-out via `retro.auto_archive_after_retro: false` config or `--no-archive` flag. Step R4 gains a commit-now option that bundles the retro file with the staged archive moves.
- **Doctor check #28 — `completed_plan_without_retro`.** Plan-scoped Warning that detects plans which look complete (status `complete`, OR all task checkboxes are `- [x]`, OR the activity log mentions `final ship` / `release v` / `merged`) but have no sibling retro file. For each finding, surfaces `AskUserQuestion`: "Generate retro + archive (Recommended) / Generate retro only / Skip / Skip all". The "Generate retro + archive" option chains into Step R + Step R3.5. A secondary stale-plan trigger (mtime > 30 days, status: in-progress, no recent activity) offers "Mark complete + retro + archive / Just archive without retro / Skip" so genuinely-abandoned plans can be cleaned without going through the full retro flow.
- **`bin/masterplan-self-host-audit.sh` — developer-only audit script** (new). Implements the deployment-drift comparison and CD-9 free-text-question grep that previously lived as doctor checks #25 and #27. Auto-skips when not run inside the `superpowers-masterplan` repo. Run before commits to catch regressions in the orchestrator source.

### Changed

- **Goal #4 (`Structured questions, never free-text`)** now references `bin/masterplan-self-host-audit.sh --cd9` for the regression guard instead of the (removed) doctor check #27.
- **Doctor parallelization brief** updated: only check #26 remains repo-scoped. Plan-scoped check count is **25** (was 24, +1 for the new check #28). Check #28 is interactive (surfaces `AskUserQuestion` per finding), so per-worktree Haiku doctors return candidate-lists rather than running the prompt themselves; the orchestrator drives the prompts inline after the parallel detection completes.
- **Doctor numbering gap.** Check #25 is removed (extracted to bin/) and check #27 is removed (extracted to bin/). Renumbering would invalidate CHANGELOG/retro references; leaving gaps. Active checks: #1–#24, #26, #28.

### Notes

- Ship sequence today: v2.9.1 (auto-compact nudge fixes) → v2.10.0 (codify CD-9, plugin-shim sentinel recognition for #25) → v2.11.0 (architectural correction + new automation features). v2.10.0's #25/#27 were stepping stones; v2.11.0 finishes the refactor by moving them out of the user-facing orchestrator entirely.
- Migration for users still on shim v1: edit `~/.claude/commands/masterplan.md` to replace the body. The bin script's regex matches both v1 and v2 sentinels, so drift detection won't fire either way.

## [2.10.0] — 2026-05-06 — codify CD-9 (no free-text user questions) + plugin-shim recognition

### Fixed

- **Line 660 branch-mismatch on resume.** Replaced free-text "ask the user before continuing" with explicit `AskUserQuestion` (3 options: switch / continue / abort), mirroring the line-659 worktree-mismatch precedent. CD-9 violation #1 of 2 in the orchestrator.
- **Line 1900 import collision rule + Step I3.1.5 implementation.** Replaced free-text "ask the user: overwrite / write to a -v2 slug / abort" with `AskUserQuestion` syntax. Added new sequential pre-pass step I3.1.5 (path-existence check) between I3.1 (slug-collision) and I3.2 (parallel fetch) — implements the rule (previously the rule had no actual call site). Aborted candidates skip the entire pipeline. CD-9 violation #2 of 2.

### Added

- **Design goal #4 — Structured questions, never free-text.** Promoted CD-9 from a deep-file rule (line 182) to a peer-level architectural goal at the top of the orchestrator (lines 9-16, "Three design goals" → "Four design goals"). First-time readers see the rule without scrolling.
- **Doctor check #27 `orchestrator_free_text_user_question`.** Repo-scoped Warning. Greps `commands/masterplan.md` for forbidden free-text patterns ("ask the user", "prompt the user", etc.) and scans ±20 lines for paired `AskUserQuestion` or `<!-- cd9-exempt: <reason> -->` exemption marker. Skips matches inside the CD-9 rule definitions themselves. Regression guard for Goal #4.
- **Shim exemption in doctor check #25 (self-host deployment drift).** When the user-level `~/.claude/commands/masterplan.md` contains the literal sentinel `<!-- masterplan-shim: v1 -->`, treat it as a managed plugin shim and skip the md5 comparison for that path (emits an info-line note instead of a drift Warning). Hook and bin/ script have no shim concept and compare normally. Closes Phase B from the prior planning session.

### Notes

- Investigation found CD-9 was *already* baked into the project (lines 182, 1903) and not actually dependent on user-level `~/.claude/` settings as initially suspected. The two known violations were within the orchestrator itself; doctor #27 is the regression guard.
- See plan: `~/.claude/plans/curious-coalescing-rose.md` (v2.10.0).

## [2.9.1] — 2026-05-06 — auto-compact nudge fixes

### Fixed

- **Auto-compact nudge wording.** The kickoff/resume nudge previously advised running `/loop … /compact …` "in another shell or session" — backward, since `CronCreate` jobs are session-scoped and the cron fires into the session that *created* it. Reworded to "in this same session" and added disclosure of the unconditional-firing tradeoff so users on shorter plans can self-select longer intervals or opt out via `auto_compact.enabled: false`.

### Added

- **Config validator** for `auto_compact.interval` empty/null when `auto_compact.enabled == true`. Prevents the silent degrade-to-dynamic-mode failure (no-interval `/loop` routes through `ScheduleWakeup`, which cannot fire built-in `/compact`). Skips the nudge for this run and warns.
- **Doctor check #26** `auto_compact_loop_attached`. Verifies a `/compact` cron is actually attached to the current session when one or more plans were nudged. Repo-scoped (runs once per doctor invocation), Warning severity. Surfaces the user error of running the loop in the wrong shell.

### Notes

- Mechanism critique resolved (no behavior change needed): fixed-interval `/loop 30m /compact …` does fire built-in compaction via the harness's `CronCreate`-mode interception path, per the documented `<<autonomous-loop>>` sentinel. Dynamic-mode `/loop /compact` (no interval) does NOT fire built-ins — the new validator is the guardrail against accidentally landing in dynamic mode.
- See spec: `docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md`.

## [2.9.0] — 2026-05-06

### Added

- **Doctor check #25 — Self-host deployment drift.** Repo-scoped check that
  fires once per `/masterplan doctor` run when `git config --get
  remote.origin.url` matches `superpowers-masterplan`. Compares md5 of
  three runtime files the user's Claude Code session loads against
  project HEAD: `~/.claude/commands/masterplan.md`,
  `~/.claude/hooks/masterplan-telemetry.sh`,
  `~/.claude/bin/masterplan-routing-stats.sh`. Each file flagged when md5
  differs OR is missing user-side AND the plugin is NOT registered in
  `~/.claude/plugins/installed_plugins.json` (plugin install is the
  legitimate "no legacy file" case). With `--fix`: per-file, backup as
  `<path>.bak-pre-<utc-ts>` and `cp` from HEAD; `chmod +x` on the hook +
  bin script; `mkdir -p ~/.claude/bin/` if absent; verify md5 match.
  Surfaces as Warning. Severity is intentional — drift doesn't break
  anything immediately; it just means recently-shipped fixes aren't
  loaded yet, which is exactly the foot-gun this check exists to catch.

### Why

In v2.8.0's release session we discovered that ~593 lines of fixes
shipped across v2.0.0 → v2.8.0 (model: passthrough contract, /masterplan
stats verb, opus_share telemetry metric, doctor check #23 model-leakage
detection) had been sitting at HEAD in the project repo without ever
reaching the user's runtime. Claude Code was loading the slash command
from `~/.claude/commands/masterplan.md` — a manual copy made before the
plugin system existed and never re-synced. The user reported "100% Opus
utilization" that prior fix attempts didn't dent; root cause was that
none of the fixes had actually deployed. Check #25 surfaces this drift
at lint time rather than at the next time the symptom recurs.

Companion cleanup: the parallelization brief now correctly says "all 24
plan-scoped checks" (was incorrectly "all 22 current checks PLUS new
check #22 (added by Task 13)" — leftover wording from the
complexity-levels plan that wasn't updated when v2.8.0 added checks #23
and #24). Repo-scoped #25 is called out separately in the brief since
it doesn't fit the per-plan complexity-aware check-set gate.

## [2.8.0] — 2026-05-05

### Added

- **Eligibility cache schema versioning (closes audit finding D.2).** The
  cache JSON now carries a top-level `cache_schema_version: "1.0"` field
  emitted on every write (inline-build path, Haiku brief, atomic rotate).
  Load-side validation rebuilds on missing-or-mismatch field with a new
  activity-log variant: `eligibility cache: rebuilt — schema version
  mismatch`. Pre-v2.8.0 caches lacking the field rebuild on next Step C
  entry. Closes the gap where a stale cache from a prior plugin version
  could silently consume routing decisions made under different
  eligibility rules.

- **Step 4b mid-plan codex availability re-check (closes D.4).** Step 4b's
  third gate condition now triggers an inline availability re-check (per
  the Step 0 detection heuristic) at gate time. On miss: writes the
  standard degradation marker (activity log + `## Notes`), flips in-memory
  `codex_review = off` for the rest of the session, and skips 4b. Catches
  the mid-plan plugin-uninstall case where Step 0 saw codex present but
  the plugin was removed before review fired.

- **Ping-based codex availability detection (closes D.1).** Step 0's
  fragile `codex:` prefix string-scan is replaced by an actual no-op
  dispatch ping that exercises the codex subagent_type. Result is cached
  as `codex_ping_result` per invocation; subsequent steps consult the
  cache. New config flag `codex.detection_mode` (`ping` | `scan` | `trust`,
  default `ping`) lets users opt into the legacy scan or the
  detection-skipping `trust` mode for locked-down accounts. New
  activity-log variant differentiates plugin-missing from
  plugin-present-but-broken.

- **Doctor check #23 — Opus on bounded-mechanical dispatch sites (closes
  C.1).** Telemetry-driven post-mortem detection of model-passthrough
  leakage. Scans the most recent 20 records in `<slug>-subagents.jsonl`
  for SDD/wave/Step-C-step-1 dispatches running on Opus, excluding the
  intentional-Opus-re-dispatch case (matched against
  `prompt_first_line`). Surfaces as Warning with mitigation advice
  pointing at `commands/masterplan.md:217-235` (the §Agent dispatch
  contract). Parallelization brief check-count bumps to 24.

- **Post-hoc slow-member detection (closes E.1, reframed).** The original
  E.1 design called for active wave-member cancellation at a 600s
  timeout, but an LLM orchestrator has no async/cancel primitive for
  in-flight Agent calls — the prose would have been runtime-unenforceable.
  Reframed as post-hoc detection: after the wave-completion barrier
  returns, the orchestrator reads each member's `duration_ms` from
  `<slug>-subagents.jsonl` (already captured by the telemetry hook) and
  tags any whose duration exceeds `config.parallelism.member_timeout_sec`
  (default 600s) as `slow_member` at the NEXT Step C entry. Behavior per
  `config.parallelism.on_member_timeout`: `warn` (default — Notes
  warning) or `blocker` (re-classify and route through the blocker gate).
  No-op when the telemetry hook is not installed. Detection is
  observability, not active cancellation.

- **Step 4d concurrent-write guard via `flock` (closes F.4).** The Step
  4d update sequence (rotation + append + atomic temp+fsync+rename) now
  wraps in `flock <status-file> -c '...'` with a 5s timeout. On
  contention (typically a user-editor saving the status file in another
  window), the would-be entry queues to `<slug>-status.queue.jsonl` and
  the next 4d cycle drains it BEFORE its own append; replays are
  idempotent (match-by `last_activity` + first 80 chars). flock-
  unavailable hosts (Windows / no util-linux) fall through to unguarded
  write with a once-per-session warning. New doctor check #24 surfaces
  non-empty queue files post-session; `--fix` replays the queue.

- **Step 4a excerpt-validator on the trust contract (closes G.1).** The
  trust-skip is no longer license alone — it requires evidence of
  execution. New required field `commands_run_excerpts: {cmd → [str]}` on
  the implementer's return digest carries 1–3 trailing output lines per
  command. The orchestrator regex-matches each excerpt against the plan
  task's `**verify-pattern:** <regex>` annotation (if present) or a
  default PASS pattern (`PASSED?|OK|0 errors|0 failures|exit 0|✓`). On
  miss, that command falls through to inline re-run with a tagged
  activity-log entry; on missing field entirely, all commands re-run with
  a once-per-session `## Notes` warning. Closes the gap where a
  fabricated `tests_passed: true` would silently pass.

### Why

The v2.8.0 cycle is the first defensive-correctness pass driven by
`docs/audit-2026-05-05-subagent-execution.md`, an end-to-end audit of the
orchestrator's subagent-dispatch and verification surfaces. Each closed
finding had a documented gap between "convention" and "structurally
enforceable"; this release converts the seven highest-severity cases.
The remaining audit findings (G.2-G.6, A.1, F.1-F.3, H-class, E.2-E.5)
are catalogued for v2.9.0+ as scoped follow-ups.

## [2.7.0] — 2026-05-05

### Added

- **Step C step 1 inline fast-path for the eligibility cache.** When every plan
  task carries a well-formed `**Codex:** ok|no` annotation paired with a
  non-empty `**Files:**` block, the orchestrator now builds the eligibility
  cache inline (parsing annotations + applying the parallel-eligibility rules
  directly) instead of dispatching the Haiku subagent. Two new activity-log
  variants distinguish the path: `eligibility cache: built inline (...)` and
  `eligibility cache: rebuilt inline (...)`. The Haiku is preserved for plans
  with under-annotated tasks, where heuristic application (judgment) still
  belongs in a subagent per the context-control architecture. Doctor #21's
  regex (`eligibility cache:`) matches both inline and Haiku-built variants —
  no doctor-side change required.
- **Annotation-completeness verifier (CD-3 evidence anchor).** The inline
  shortcut activates only when ALL tasks pass a structural validation: any
  malformed annotation, missing `**Files:**` block, or unknown `**Codex:**`
  value silently falls back to Haiku dispatch. Analogous to Step 4a's
  implementer-return trust contract — the orchestrator never trusts data it
  can't structurally validate.
- **Wave-pin precedence note (decision-tree clarification).** The Step C step
  1 decision tree now explicitly lists `cache_pinned_for_wave == true` as the
  first short-circuit, before any other bullet evaluates. Behavior is
  unchanged from prior (the **Skip-with-pinned-cache exception** block already
  documented this normatively); the new ordering removes ambiguity for
  readers landing in the imperative "step 1, 2, 3" Build-path structure.

### Why

Most measurable win: at `complexity == high`, every Step C step 1 cache build
is now mechanical extraction (no Haiku dispatch). Saves the Haiku roundtrip
(~10–30s wall + tokens) on every fresh build and every plan-edit-driven
rebuild. At `medium`, kicks in opportunistically when writing-plans happens to
annotate every task. At `low`, irrelevant — the cache is skipped entirely.

The change resolves feedback that called out the Step C step 1 Haiku as
re-derivation of structured data already present in the plan file. The
trust-contract anchor (plan-file annotations as the structured return)
generalizes the Step 4a `tests_passed` / `commands_run` pattern to
cache-build.

## [2.6.0] — 2026-05-05

### Added

- **New `/masterplan clean` verb** (Step CL) — automates the cleanup that
  previously required hand-running `git mv` + `mkdir` + commit per artifact.
  Doctor detects orphans + cruft; clean remediates. Five categories:
  - **Completed plans** — archive plan + status + every sidecar
    (`<slug>-eligibility-cache.json`, `<slug>-telemetry.jsonl`,
    `<slug>-subagents.jsonl`, `<slug>-status-archive.md`, etc.) to
    `<config.archive_path>/<status.last_activity-date>/`.
  - **Orphan sidecars** — reuses Step D check predicates (#11, #13, #14, #19)
    to find sidecars whose sibling status file no longer exists; archives them.
  - **Stale plans** — `status: in-progress | blocked` with `last_activity > 90
    days`. Per-item `AskUserQuestion` (Archive / Keep / Skip) — never
    auto-archives stale items because staleness is a judgment call.
  - **Dead crons** — calls `CronList`, finds duplicates by exact prompt match,
    `CronDelete`s the non-oldest. Same predicate as doctor #19 with `--fix`.
  - **Dead worktrees** — `git worktree list` entries whose path is missing on
    disk; `git worktree remove --force` per stale entry.
- **Flags:** `--dry-run` (preview without changes; skips confirmation gate),
  `--delete` (archival categories `git rm` instead of `git mv` to archive
  path; OS-level categories always delete), `--category=<name>` (limit to one
  or comma-separated subset of `completed|orphans|stale|crons|worktrees`),
  `--worktree=<path>` (limit per-worktree scan to one path).
- **Confirmation gate:** structured summary + `AskUserQuestion(Apply all /
  Apply selected categories / Cancel)` before any execution. `--dry-run`
  skips the gate. Mirrors `/masterplan import`'s cruft-handling pattern but
  with a single up-front confirm rather than per-candidate prompts.
- **Per-category atomic commits:** `clean: archive N completed plan(s)`,
  `clean: archive M orphan sidecar(s)`, `clean: archive K stale plan(s)`.
  OS-level categories (crons, worktrees) skip the commit step.
- **Skip rule:** Step CL never touches files inside `<archive_path>/` —
  re-running clean on an already-cleaned tree produces `clean: nothing to do`.

### Changed

- Doctor remains read-only by default. The destructive/archival path moved
  to the new clean verb so doctor's `--fix` action stays scoped to its
  current narrow set (auto-fix only on check #2 today). Future doctor `--fix`
  expansions will defer to clean for archival categories.

## [2.5.0] — 2026-05-05

### Added

- **3-level `complexity` variable** (`low | medium | high`) at every config tier
  (CLI flag `--complexity=<level>`, `~/.masterplan.yaml`, repo `.masterplan.yaml`,
  status frontmatter). Sets defaults for `autonomy`, `codex_routing`,
  `codex_review`, `parallelism.enabled`, `gated_switch_offer_at_tasks`, and
  `review_max_fix_iterations` per the precedence table in Operational rules.
  Explicit overrides (CLI flag, frontmatter, config) win over complexity-derived
  defaults. `medium` is the default and preserves all current behavior; existing
  plans without the field are read as `medium` (no migration needed).
- **`low` skips:** eligibility cache build, telemetry sidecar, wakeup ledger,
  parallelism waves, codex routing + codex review. Activity log uses one-line
  entries; rotation threshold drops to 50 (archives most recent 25). Plan-writing
  brief produces leaner plans (~3–7 tasks, optional `**Files:**`, no annotations).
  Doctor at low runs only checks #1–#10 + #18 (skips sidecar/annotation/ledger
  checks that don't apply).
- **`high` adds:** `codex_review` always on with `review_prompt_at: low`;
  required `**Files:**` + `**Codex:**` annotations per task; eligibility cache
  validated against the plan's `**Files:**` blocks; verification re-runs
  implementer's tests; retro becomes a recommended option at plan completion;
  new doctor check #22 (high-only) fires when a high plan lacks all three
  rigor signals (retro reference, codex review pass, `[reviewed: …]` tags).
- **Kickoff prompt:** when `--complexity` is not on the CLI and no config tier
  sets it, /masterplan surfaces one `AskUserQuestion` between worktree decision
  and brainstorm (kickoff verbs only). Setting any value in any config tier
  silences the prompt.
- **Activity-log audit line** at first Step C entry per session: cites the
  resolved complexity, its source (`flag` / `frontmatter` / `repo_config` /
  `user_config` / `default`), and any knobs whose final value differs from the
  complexity-derived default.

## [2.4.1] — 2026-05-05

### Added
- **Competing-scheduler check** at Step C step 1. Defensive guard against an
  externally-created cron (e.g., a stale `/schedule` one-shot, a leftover from
  a prior session) that targets the same plan as `/loop`'s `ScheduleWakeup`
  self-pacing. `/masterplan` itself never calls `CronCreate`, so this is not a
  fix for an internal code path — it is a runtime guard against a footgun
  introduced by other plugins or earlier user actions. When the orchestrator
  detects a cron whose prompt starts with `/masterplan` AND contains the
  status file's basename, it surfaces an `AskUserQuestion` with four options:
  delete the cron (Recommended), suspend `/loop` wakeups for the session, keep
  both (with a one-time acknowledgement that suppresses future warnings via
  `competing_scheduler_acknowledged: true` in frontmatter), or abort. Skips
  silently when `ScheduleWakeup` is unavailable, when `CronList`/`CronDelete`
  schemas can't be loaded via `ToolSearch`, or when the acknowledgement flag
  is set. Honest scope: the check fires after the current resume already
  started, so it cannot prevent the very-next concurrent firing — only future
  ones, after the user picks delete or acknowledges.

## [2.4.0] — 2026-05-04

### Added
- New `/masterplan stats` verb (Step T) — codex-vs-inline routing distribution,
  inline model breakdown (Sonnet/Haiku/Opus when activity logs carry
  `[subagent: <model>]` tags or `<plan>-subagents.jsonl` is populated), token
  totals by `routing_class`, decision-source breakdown, and per-plan health
  flags (degraded / cache-missing / silent-skip-suspected). Backed by new
  `bin/masterplan-routing-stats.sh` (~280-line bash + python3) supporting
  `--plan=<slug>`, `--format=table|json|md`, `--all-repos`, `--since=<date>`.
- New `unavailable_policy` config key under `codex:`. Default `degrade-loudly`
  preserves Fix 1 behavior (warn + degrade). Opt-in `block` halts before B/C/I
  with status: blocked when codex_routing != off and the codex plugin is
  unavailable. For users who'd rather a stuck plan than silent-codex-skip.
- Two new doctor checks. **#20**: codex_routing configured but eligibility
  cache file missing AND activity log shows ≥1 routing/completion entry —
  catches the cache-FILE footprint of silent codex degradation. **#21**: same
  symptom from the activity-log angle (no `eligibility cache:` evidence
  entries from Step C step 1) — catches the protocol-violation footprint.
  Total checks: 21.
- Pre-dispatch routing visibility. Step C step 3a now emits a `routing→CODEX`
  or `routing→INLINE` activity-log entry BEFORE dispatching, plus a stdout
  banner for real-time observability during /loop runs. Step 4b emits
  `review→CODEX` or `review→SKIP` symmetrically. Eligibility cache extended
  with `dispatched_to`/`dispatched_at`/`decision_source` runtime-audit fields.

### Changed
- Step 0 codex-availability detection no longer silently records degradation
  "on the next status-file write." Degradation now writes immediately on the
  next status update of the run (Step B3 close, Step C step 1's first write,
  or Step I3) AND emits a visible stdout warning + `## Notes` one-liner. If
  no status write would naturally happen this turn, the orchestrator forces a
  `## Notes`-only update so the marker lands. Per-task pre-dispatch banners
  (Fix 5) carry a `(codex degraded — plugin missing)` suffix when degradation
  is in effect.
- Step C step 1 now emits a mandatory `eligibility cache: <verdict>`
  activity-log entry per Step C entry (built / rebuilt / loaded / skipped
  variants + wave-pinned exception). Makes the silent-skip failure mode
  impossible to hide; doctor check #21 surfaces the absence at lint time.
- Step C step 3a now HALTS when codex_routing != off and eligibility_cache is
  missing — no more silent fallthrough to inline. Branches on
  `config.codex.unavailable_policy`: `degrade-loudly` surfaces a 4-option
  AskUserQuestion (Rebuild cache / Run inline with degradation marker / Set
  codex_routing: off / Abort); `block` sets status: blocked with a
  wave-mode-aware single-writer exception.
- Step C step 1 now performs a resume sanity check on every resume entry: scans
  the activity log for `**Codex:** ok`-annotated tasks completed inline without
  a `degraded-no-codex` decision_source. If found, surfaces a `## Notes`
  warning + 4-option AskUserQuestion (Continue / Run doctor / Investigate
  transcript / Suppress). Forensic recovery for plans that experienced silent
  codex-skip in a prior session.
- Stop hook (`hooks/masterplan-telemetry.sh`) now walks linked worktrees:
  fans out across `<root>/.worktrees/*/docs/superpowers/plans/`, matches by
  `worktree:` field equality OR `$PWD` prefix OR branch, picks
  most-recently-modified candidate. Resolves `plans_dir` to the chosen status
  file's parent so sidecar JSONLs land alongside worktree-resident plans
  (previously invisible to the hook).
- Stop hook subagent capture now dedups by `agent_id` (replacing the v2.3.0
  plan-keyed line cursor). Old cursor was invisible to multi-session runs and
  silently dropped dispatches — typical symptom: 0-line subagents.jsonl
  despite many actual dispatches. New mechanism reads existing JSONL into a
  seen-set and skips records already emitted. Each emission now carries a
  `routing_class` field (`"codex"` / `"sdd"` / `"explore"` / `"general"`)
  for greppable codex-routing distribution analytics.

### Fixed
- Codex degradation pattern silently bypassed all routing in optoe-ng
  project-review (root cause pinned to a specific transcript: 7 agents
  dispatched, zero codex-rescue, zero Step 0 warning text emitted, zero
  eligibility cache writes). Fixes 1-5 + P1-P5 prevention layer ensure
  silent recurrence is impossible: the orchestrator either has a populated
  eligibility cache + visible routing tags OR it has loud user-facing
  prompts + persistent markers — never quiet inline-bypass.
- Stop hook telemetry/subagents JSONL siblings now land for worktree-resident
  plans (previously invisible). Doctor check #19 description acknowledges the
  legacy `<slug>-subagents-cursor` files (deprecated v2.4.0) as harmless.
- Doctor table parallelization brief count synced across `commands/masterplan.md`
  and `docs/internals.md` (20 → 21 with the two new checks).

## [2.3.1] — 2026-05-04

### Changed
- Bare `/masterplan` is now resume-first: it auto-continues the current/only
  in-progress plan, opens the resume picker when active work is ambiguous, and
  shows the broad phase/operations menu only when no active plan exists.
- README install docs now include a Claude Desktop Code-tab path, scope guidance,
  and the `/superpowers-masterplan:masterplan` collision fallback.

### Fixed
- Runtime telemetry sidecars are now protected from accidental commits. This
  repo ignores generated `*-telemetry*.jsonl`, `*-subagents*.jsonl`, and
  `*-subagents-cursor` files, and downstream hook/Step C telemetry writers add
  matching patterns to `.git/info/exclude` before writing. If telemetry files
  are tracked or cannot be ignored, telemetry is skipped instead of written.

## [2.3.0] — 2026-05-04

**Model-dispatch contract + per-subagent telemetry layer.** Two threads bundled
into one minor release:

1. **Cost-leak fix.** Subagent dispatches now structurally require the `model:`
   parameter at every site (was prose-only). Without this, subagents inherited
   the orchestrator's Opus 4.7 silently — a real 2-day /masterplan-heavy session
   consumed 94% Opus ($458 of $487) despite the design intent of Haiku for
   mechanical extraction and Sonnet for general implementation.
2. **Per-subagent observability.** Stop hook now captures one record per Agent
   dispatch into `<plan>-subagents.jsonl`, with full token breakdown
   (`input/output/cache_creation/cache_read`), duration, dispatch-site
   attribution, subagent_type, model, and tool_stats. Six jq cookbook recipes
   added so "find the biggest token consumers and optimize them" is tractable
   instead of guessing.

### Added
- **`### Agent dispatch contract` subsection** under `## Subagent and
  context-control architecture` in `commands/masterplan.md`. Normative MUST
  language plus a value-by-use table (`haiku` = mechanical, `sonnet` =
  implementation, `opus` = user-escalated only). Includes a recursive-application
  clause for skill invocations and a Codex exemption.
- **Recursive override clause for SDD invocation** at Step C step 2. Tells
  `superpowers:subagent-driven-development` to pass `model: "sonnet"` on its
  inner Task calls (implementer / spec-reviewer / code-quality-reviewer) —
  required because SDD's prompt-template files are upstream and don't carry
  model parameters by default.
- **`<plan>-subagents.jsonl`** stream — one record per subagent dispatch
  emitted by `hooks/masterplan-telemetry.sh`. Cursor-based incremental parsing
  via `<plan>-subagents-cursor` keeps the hook fast on long sessions.
- **`DISPATCH-SITE:` tag convention** for every Agent brief — a central
  contract table in `commands/masterplan.md` enumerates the 14 dispatch-site
  values so the hook can attribute cost to orchestrator-step granularity
  (Step A vs Step C step 1 vs wave vs SDD vs etc.).
- **Doctor check #19** — orphan `<plan>-subagents.jsonl` /
  `<plan>-subagents-cursor` files (sibling to a missing status file). Suggests
  archive on `--fix`. Doctor check #12 extended to also catch
  `<plan>-subagents.jsonl > 5 MB`; rotates to `-archive.jsonl`.
- **Six jq cookbook recipes** in `docs/design/telemetry-signals.md`:
  top-N dispatches by total tokens, per-subagent_type aggregates,
  per-dispatch-site aggregates, per-model breakdown by site,
  anomaly detection (>2σ above type mean), cost trend over 14 days.
- **First automated runtime smoke test** for the project: hand-crafted JSONL
  fixture with three Agent dispatches verifies the hook's record emission,
  cursor advancement, and idempotence under re-runs.

### Fixed
- **14 inline dispatch sites** in `commands/masterplan.md` now carry explicit
  `model:` instructions: Step A status parse (`haiku`), Step B0 worktree scan
  (`haiku`), Step C step 1 eligibility cache builder (`haiku`), Step C step 2
  wave dispatch (`sonnet`), Step C step 2 SDD invocation (`sonnet`, recursive
  override), Step C step 3 Codex EXEC (exempt note), Step C 4b Codex REVIEW
  (exempt note), Step I1 discovery (`haiku`), Step I3.2 fetch (per-candidate
  `haiku` / `sonnet` / no-Agent), Step I3.4 conversion (`sonnet`), Step S1
  situation gather (`haiku`), Step R2 retro source (`haiku`), Step D doctor
  (`haiku`), Completion-state inference (`haiku`).
- **Blocker re-engagement gate option 2** ("Re-dispatch with a stronger model")
  now actually dispatches with `model: "opus"` on the re-dispatch Agent call.
  Previously a UI-only promise — the option label promised behavior the prompt
  didn't structurally deliver.

### Migration notes
- **Hook re-install required.** `hooks/masterplan-telemetry.sh` gained ~120
  lines (subagent-capture pipeline). Users with the hook installed at
  `~/.claude/hooks/masterplan-telemetry.sh` must `cp` the new version per the
  README install instructions. Old hook continues working (still emits
  per-turn records) but doesn't capture per-dispatch data.
- **Existing telemetry files keep working.** `<plan>-telemetry.jsonl` schema
  is unchanged from v2.2.x. New `<plan>-subagents.jsonl` and
  `<plan>-subagents-cursor` files appear once the new hook runs.
- **No config or status schema change.** Status frontmatter unchanged. Doctor
  table now 19 rows (was 18). CD-rule numbering (CD-1…CD-10) unchanged — the
  dispatch contract lives under `## Subagent and context-control architecture`,
  not as a new CD rule.
- **SDD upstream not modified.** The model-passthrough override contains the
  fix to `/masterplan`. If future upstream SDD changes ignore the override
  clause, fallback is to wrap SDD invocation in an outer `Agent(subagent_type:
  "general-purpose", model: "sonnet", ...)`.

### Verification
- 10 grep discriminators (contract section landed once, ≥14 `model:`
  parameters, Codex exemption notes ≥2, opus-on-blocker wire-up,
  `<plan>-subagents.jsonl` referenced in hook, 14 `DISPATCH-SITE` values in
  the contract table, doctor check #19 + Step D brief at "all 19 checks",
  new schema in telemetry-signals.md, version bumps consistent across
  CHANGELOG/README/plugin.json/marketplace.json).
- `claude plugin validate .` — clean.
- `bash -n hooks/masterplan-telemetry.sh` — clean.
- Smoke fixture against the new hook (3 dispatches → 3 records, cursor
  advancement, idempotence on re-run).

## [2.2.3] — 2026-05-04

**Marketplace-readiness patch.** Fixes Claude Code plugin validation blockers
and adds the missing repository marketplace catalog needed by the documented
install path.

### Added
- **`.claude-plugin/marketplace.json`** — publishes this repository as a
  self-contained marketplace named `rasatpetabit-superpowers-masterplan`, with
  the `superpowers-masterplan` plugin sourced from the repository root.
- **Dependency metadata** — declares `superpowers@claude-plugins-official` as
  the required upstream plugin and allowlists the official marketplace for that
  cross-marketplace dependency.
- **`docs/release-submission.md`** — durable submission checklist and form-copy
  draft for the Claude plugin directory / Anthropic Verified review request.

### Fixed
- **`plugin.json` schema drift** — `repository` is now the string form required
  by current Claude Code validation, not an npm-style `{type,url}` object.
- **`commands/masterplan.md` frontmatter** — quoted the description so the
  colon in `Verbs:` parses as YAML instead of dropping metadata at runtime.
- **Manifest description** — shortened to a marketplace-friendly summary rather
  than embedding release-history detail in plugin metadata.

### Verification
- `claude plugin validate .`
- `claude plugin validate .claude-plugin/plugin.json`
- `jq empty .claude-plugin/plugin.json .claude-plugin/marketplace.json .claude/settings.local.json`
- `bash -n hooks/masterplan-telemetry.sh`
- `git diff --check`
- Isolated clean install smoke with a temporary `HOME`, official marketplace
  dependency resolution, local marketplace add, and
  `claude plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan`.

## [2.2.2] — 2026-05-04

**Removed standing "no backward-compat / hard-cut renames" rule.** Documentation-only patch. Going forward, decisions about migration aliases for breaking renames are made case-by-case rather than dictated by a project-level prohibition.

### Removed
- **`CLAUDE.md` "Top anti-patterns" #2** — the "Don't add backward-compatibility shims when renaming things" rule. Surrounding 5 (renumbered) anti-patterns stay.
- **`docs/internals.md` `### Why hard-cut name changes` subsection** plus the corresponding bulleted entry under "Architectural anti-patterns".
- **Project-scoped auto-memory entry** (`feedback_no_backward_compat_aliases.md` + its `MEMORY.md` index line). Project memory is reset on this topic.

### Changed
- **README top-of-file rewritten.** New tagline and `## Key benefits` section with three structured categories (long-term planning consistency, token efficiency, cross-checking via Codex) replace the previous "Overview" + "What it provides" prose. Substance unchanged; framing now leads with concrete user-facing benefits before drilling into install + command surface.
- **`WORKLOG.md` v2.2.0 entry** — two policy-framing references scrubbed (the deleted `Why hard-cut renames` heading rewrite reference; the "Hard-cut, no alias." preface on the verb-rename narrative). Functional record of what changed in v2.2.0 unchanged.

### Migration notes
- **No code or behavior change.** Orchestrator, status schema, command surface, and config schema all unchanged. Past breaking renames (`new → full`, `claude-superflow → superpowers-masterplan`, etc.) stay shipped — only the rule that drove those decisions is being removed.
- **No replacement rule added.** Future renames are now case-by-case. If you want a heuristic: prefer hard-cuts for tiny user surfaces (e.g., a single command verb) and consider migration aliases when renaming high-traffic config keys or frequently-typed paths.

## [2.2.1] — 2026-05-04

**Inline status preamble on bare `/masterplan`.** Patch release adding orientation + doctor-tripwire signal to the bare-invocation flow; cleanup pass also removes stray feature branches + worktrees from origin in preparation for wider public visibility.

### Added
- **Step M0 — Inline status orientation on bare `/masterplan`.** Before the Tier-1 picker fires, the orchestrator emits a structured plain-text preamble: headline (`<N> in-flight, <M> blocked across <W> worktrees`), up to 3 in-flight/blocked plan bullets with `current_task` + age, optional `… and N more` tail, and an optional `· <K> issue(s) detected — consider /masterplan doctor` tripwire flag. The tripwire runs 7 cheap inline checks (subset of the 18 doctor checks: #2 orphan status, #3 wrong worktree, #4 wrong branch, #5/#6 stale, #9 schema violation, #10 unparseable) — all derivable from frontmatter + the `git_state` cache already in memory; no Haiku dispatch. The empty-state line is `No active plans.` Step A consumes a `step_m_plans_cache` short-circuit when invoked from "Resume in-flight" so the worktree scan doesn't run twice.

### Changed
- **"Stay on script" guardrail** at Step M's Notes updated (not replaced) to acknowledge M0's structured preamble while reaffirming the no-tangents rule and explicitly forbidding per-check enumeration in the preamble — that remains `/masterplan doctor`'s job. Doctor table size stays at 18; M0 reuses checks by name + semantics, no new check #19.

### Fixed
- Documentation now consistently describes the v2.2.0 surface: bare `/masterplan` opens the two-tier picker, README release/status text names v2.2.0 as current, README's full config schema matches the v2.x defaults, and `docs/internals.md` mirrors the Step M empty-argument route.
- README simplified into a tighter user guide, and command prompt docs now match the advertised public surface: `--no-codex-review` is listed as the `--codex-review=off` shorthand, `--parallelism` is documented as a run/config override rather than a status-frontmatter field, and stale future-only wording for Slice α parallelism is removed.

### Migration notes
- **Purely additive on bare `/masterplan`.** Direct verb invocations (`/masterplan full ...`, `/masterplan execute`, etc.) are unchanged — M0 only fires for empty `$ARGUMENTS`. Existing plans, status files, and `.masterplan.yaml` configs work unchanged.
- **No new doctor check.** M0's tripwire reuses existing checks #2/#3/#4/#5/#6/#9/#10 evaluated inline. The full `/masterplan doctor` lint surface is unchanged at 18 checks.

## [2.2.0] — 2026-05-04

**Doc revisionism + verb rename + no-args picker.** Three threads bundled. The bare `/masterplan` invocation now opens a two-tier picker menu (category → specific verb) so first-touch users don't have to memorize the verb table. The kickoff verb `new` is renamed to `full` (breaking — no alias). Doc revisionism cleanup removes pre-v1.0.0 release-history references throughout the repo.

### Added
- **Two-tier no-args picker (Step M).** `/masterplan` (no args) now surfaces an `AskUserQuestion` menu. Tier 1: Phase work / Operations / Resume in-flight / Cancel. Tier 2a (Phase work): brainstorm / plan / execute / full + topic prompt. Tier 2b (Operations): import / status / doctor / retro. "Resume in-flight" delegates to Step A's existing list+pick. "Cancel" exits cleanly.

### Changed
- **`new` verb renamed to `full`.** All sync'd locations updated: frontmatter description, Step 0 routing table rows, reserved-verbs warning, argument-parse precedence list, README verb table + quick-start examples + reserved-verb prose + Aliases-and-shortcuts table, `docs/internals.md` Step 0 mirror.
- **Doc revisionism pass.** Removed all pre-v1.0.0 (v0.x) release-history references from CHANGELOG (older blocks deleted entirely + remaining v0.x mentions in v1.0.0/v2.0.0 entries scrubbed), README ("Path to v2.0.0" → "Releases since v1.0.0", v0.x bullets removed), `docs/internals.md` (v0.x parentheticals dropped from "Why" section headings + audit-pass bullet wording), `docs/design/intra-plan-parallelism.md` + the v1.1.0 spec ("v0.1 → v0.2 → v0.3 → v0.4 → v1.0.0" deferral-chain framing rewritten as "deferred prior to v1.0.0"). WORKLOG v2.0.0 entry's rename narrative trimmed; functional deliverables (parallelism Slice α, Codex defaults, internal docs) preserved.

### Migration notes
- **Breaking:** `/masterplan new <topic>` is now `/masterplan full <topic>`. No alias. Memorize the new verb. (The bare-topic shortcut `/masterplan <topic>` continues to work and routes to the same flow as `full`.)
- **No-args picker is additive** for users who previously used bare `/masterplan` to reach the worktree picker — they now select "Resume in-flight" (one extra click) to land in the same Step A logic. Direct verb invocations (`/masterplan full ...`, `/masterplan execute`, etc.) bypass the picker entirely.
- **Doc revisionism is non-breaking** — only documentation surface changes; orchestrator behavior is unchanged for these edits.
- **No status-file or config schema changes.** Existing plans and `.masterplan.yaml` files work unchanged.

## [2.1.0] — 2026-05-04

**README polish + gated→loose switch offer + Roadmap section.** Additive release on the v2.x track; no breaking changes. Adds a benefits paragraph + a "Defaults at a glance" YAML block + a "Roadmap" section to README. Adds a one-time AskUserQuestion at Step C step 1 offering to switch from `--autonomy=gated` to `--autonomy=loose` when a long plan (≥15 tasks by default) is in progress — reduces friction for users who don't want to click through every per-task gate on a trusted plan.

### Added
- **README `## Why this exists` rewritten + reordered** to precede `## What you get`. New 6-bullet benefits paragraph: long-term complex planning, aggressive context discipline, dramatic token reduction, parallelism for faster operation, cross-session resume, cross-model review.
- **README `### Defaults at a glance`** sub-section under `## Configuration`. Compact YAML block (~50 lines) showing every default in one scannable view, with one-line comments for the most-overridden fields. Full schema with explanations follows below.
- **README `## Roadmap`** top-level section between `## Project status` and `## Author`. Surfaces 6 deferred items + 4 documented non-features. Each deferred item has a measurable revisit trigger.
- **Gated→loose switch offer (v2.1.0+).** New AskUserQuestion at Step C step 1 (after telemetry inline snapshot, before the per-task autonomy loop): when `autonomy == gated` AND `config.gated_switch_offer_at_tasks > 0` AND plan task count ≥ threshold AND not already dismissed/shown, offer 4-option switch:
  - Switch to `--autonomy=loose` (Recommended for trusted plans)
  - Stay on gated
  - Switch + don't ask again on any plan (recommends user edit `.masterplan.yaml`; orchestrator does NOT modify user's config per CD-2)
  - Stay + don't ask again on this plan (sets `gated_switch_offer_dismissed: true` in status frontmatter)
- **Config key `gated_switch_offer_at_tasks: 15`** (top-level; default 15). Set to 0 to disable the offer entirely.
- **Status file frontmatter optional fields:**
  - `gated_switch_offer_dismissed: true` — permanent per-plan suppression of the offer.
  - `gated_switch_offer_shown: true` — per-session suppression (re-fires on cross-session resume by design — gives the user another chance after a break).

### Changed
- README section ordering: `## Why this exists` now precedes `## What you get` (value pitch before surface area). Existing content of both sections preserved verbatim except for the new benefits paragraph appended to "Why this exists."
- Plugin.json description mentions the gated→loose offer.

### Migration notes
- **No breaking changes.** Additive release. Existing `.masterplan.yaml` files without `gated_switch_offer_at_tasks` get the default 15.
- Users who never want the gated→loose offer set `gated_switch_offer_at_tasks: 0` in `.masterplan.yaml`.
- Users who want the offer on but with a different threshold (e.g., 25 tasks) override per-repo or globally in `~/.masterplan.yaml`.
- Status frontmatter fields `gated_switch_offer_dismissed` and `gated_switch_offer_shown` are both optional. Doctor check #9 (schema-required-fields) is unchanged — these fields aren't required.

## [2.0.0] — 2026-05-04

**Intra-plan parallelism Slice α + Codex defaults on.** Single coherent v2.0.0 release bundling Slice α of intra-plan task parallelism (read-only parallel waves only — verification, inference, lint, type-check, doc-generation; implementation tasks remain serial), Codex defaults flipped to on with graceful-degrade when codex plugin isn't installed, a new `## Codex integration` README section, internal documentation for LLM contributors (`CLAUDE.md` + `docs/internals.md`), and pruning of older spec/plan/WORKLOG history (institutional knowledge migrated to `docs/internals.md`).

### Added
- **`**parallel-group:** <name>` plan annotation.** Tasks sharing the same `<name>` value dispatch as one parallel wave in Step C step 2. Read-only only (verification, inference, lint, type-check, doc-generation). Mutually exclusive with `**Codex:** ok`. Requires complete `**Files:**` block (becomes exhaustive scope under wave). See [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md) for the failure-mode catalog and Slice β/γ deferral.
- **Wave dispatch in Step C step 2** — contiguous-plan-order wave assembly; per-instance bounded brief (DO NOT commit, DO NOT update status); parallel `Agent` dispatch; wave-completion barrier.
- **Single-writer status funnel in Step C 4d** — orchestrator aggregates wave digests, computes `current_task` as lowest-indexed not-yet-complete, appends N entries to `## Activity log` in plan-order with `[wave: <group>]` tag, runs wave-aware activity log rotation (fires once per wave per FM-2), commits status file once per wave with subject `masterplan: wave complete (group: <name>, N tasks)`.
- **Files-filter in Step C 4c under wave** — single porcelain check filters against union of all wave-task `**Files:**` declarations (post-glob-expansion) plus implicit-paths whitelist.
- **Eligibility cache pin (M-2 mitigation)** — `cache_pinned_for_wave` flag suppresses mtime invariant during wave; new CD-2 in-wave scope rule forbids wave members from modifying plan/status/cache.
- **Per-member outcome reconciliation** — three outcomes (`completed` / `blocked` / `protocol_violation`); `protocol_violation` detected by orchestrator post-barrier (commits despite "DO NOT commit", out-of-scope writes, status file modification).
- **Wave-level outcomes** — all-completed / all-blocked / partial. Partial preserves K completed digests UNLESS `parallelism.abort_wave_on_protocol_violation: true` (default), in which case the entire 4d batch is suppressed.
- **Blocker re-engagement gate integration** — fires once at wave-end with the union of N-K blocked members; option semantics extend naturally.
- **Step C 5 wave-count threshold** — wave-end counts as ONE completion regardless of N (a wave of 5 doesn't trigger 5 wakeup-threshold increments).
- **3 new doctor checks (#15-17, total 14 → 18 with #18):** parallel-group without Files: block; parallel-group + Codex: ok mutual conflict; file-path overlap within parallel-group.
- **Doctor check #18: Codex config on but plugin missing.** Flags persistent misconfiguration when `codex.routing != off` OR `codex.review == on` AND no `codex:` skill in scope at lint time. Step 0's auto-degrade handles per-run; doctor surfaces persistent state.
- **Step 0 codex-availability detection (graceful degrade).** When config has codex on but plugin not installed, emit one-line warning and treat both routing + review as `off` for the run. Persisted config is unchanged.
- **`hooks/masterplan-telemetry.sh` gains `tasks_completed_this_turn` (int) + `wave_groups` (array of strings) fields** — FM-3 mitigation. Linux smoke-tested; macOS portable-by-construction (not smoke-tested).
- **New `parallelism:` config block** — `enabled` (kill switch, default true), `max_wave_size` (default 5), `abort_wave_on_protocol_violation` (default true).
- **New `--parallelism=on|off` and `--no-parallelism` CLI flags.**
- **Step B2 writing-plans brief paragraph** — guidance for the planner on emitting `parallel-group:` annotations.
- **README `## Codex integration` section** (~490 words). Covers why/how/defaults/install/disable/cross-references.
- **`CLAUDE.md` at repo root** (~620 words) — always-loaded project orientation for Claude Code sessions in this repo. Top anti-patterns, operating principles, doc index.
- **`docs/internals.md`** (~8000 words, 15 sections) — comprehensive deep-dive for future LLM contributors: architecture, dispatch model, status format, CD rules, operational rules, wave dispatch + failure-mode catalog FM-1 to FM-6, Codex integration, telemetry, doctor checks, verb routing, design history, common dev recipes, anti-patterns, cross-references.

### Changed
- **`codex.review` default flipped: `off` → `on`.** Behavior change. Users who don't want Codex to review every inline-completed task should set `codex.review: off` in `.masterplan.yaml` or pass `--no-codex-review`. (Auto-degrades to `off` when codex plugin not installed — no impact on users without Codex.)
- **Step C step 1 eligibility cache schema extended** with `parallel_group`, `files`, `parallel_eligible`, `parallel_eligibility_reason` (all optional; backward-compatible with prior cache files which load with `parallel_eligible: false`).
- **Step D parallelization brief: `each agent runs all 14 checks` → `each agent runs all 18 checks`.**
- **`docs/design/intra-plan-parallelism.md` rewritten** — replaces brief design notes with v2.0.0 status doc (what ships in Slice α, what's deferred, sharpened revisit trigger, failure-mode catalog summary).
- **`docs/design/telemetry-signals.md`** — documents the two new fields with first-turn caveat; adds "Average tasks-per-wave-turn" jq example.
- **README** — Plan annotations table adds `parallel-group:` + `non-committing:` rows; Useful flag combinations adds `--no-parallelism` row; "Path to v2.0.0" entry added; Project status bumped; Useful flag combinations row for default invocation updated to mention `codex.review: on` v2.0.0 default + graceful-degrade.

### Removed
- **5 older spec/plan files pruned.** Knowledge migrated to `docs/internals.md` §12 (Design decisions).
- **Older WORKLOG entries trimmed.** Only the v2.0.0 entry remains. CHANGELOG retains the full release history.

### Migration notes

**Required user steps for v1.0.0 → v2.0.0 upgrade:**

1. **`codex.review` is now on by default.** If you don't have the codex plugin installed, this auto-degrades silently with a one-line warning at Step 0. If you have codex installed but DON'T want auto-review, set `codex.review: off` in `.masterplan.yaml`.
2. **Existing in-flight plans keep working** — status file paths inside `docs/superpowers/plans/` are unchanged. Resume with `/masterplan execute <status-path>`.
3. **Eligibility cache files** (`<slug>-eligibility-cache.json`) created prior to v2.0.0 are valid — load with `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today.

**No status-file schema changes** beyond the optional new eligibility cache fields. Existing status files load unchanged.

---

## [1.0.0] — 2026-05-03

**First stable public release.** Consolidates retrospective generation into the `/masterplan retro` verb (replacing the previously-auto-firing `masterplan-retro` skill), standardizes terminology on "verbs" instead of mixing "subcommands" and "invocation forms," and applies a pre-release audit fix pass that closed 10 blockers and 13 polish items found by three parallel fresh-eyes Explore agents auditing the orchestrator, telemetry hook, remaining skill, and human-facing docs.

### Added
- **`/masterplan retro [<slug>]` verb.** Generates a retrospective doc for a completed plan and writes it to `docs/superpowers/retros/YYYY-MM-DD-<slug>-retro.md` with outcomes, blockers, deviations, follow-ups, and Codex routing observations. With no slug, picks from completed plans that don't yet have a retro; with one candidate, runs without a picker. New `Step R` section in `commands/masterplan.md` (R0 resolve target → R1 pre-write guard → R2 gather → R3 synthesize + write → R4 offer follow-ups). Pre-write guard globs `*-<slug>-retro.md` so re-runs surface `Open / Generate v2 / Abort` instead of silently duplicating.
- **`new` (no topic) verb routing row.** `/masterplan new` with no topic now prompts for a topic via `AskUserQuestion` before falling through to Step B, mirroring the established `brainstorm` (no topic) handling. Previously bare `new` silently passed empty args to brainstorming.

### Removed
- **`masterplan-retro` skill removed.** Functionality consolidated into the `/masterplan retro` verb. The skill's auto-fire-on-plan-completion behavior is gone — retro generation is now explicit. Users who relied on the auto-suggestion can run `/masterplan retro` after a plan completes (it picks the most recent completed plan without a retro). The skill deletion drops one auto-trigger surface from the install footprint; `masterplan-detect` (parallel-shape skill that suggests `/masterplan import`) is retained.

### Changed
- **README terminology standardized on "verbs."** `## Subcommand reference` → `## Verb reference`. "Other subcommands" header in "What you get" → "Operation verbs" (paired with the existing "Phase verbs"). `### Invocation forms (back-compat detail)` → `### Aliases and shortcuts` (back-compat framing dropped — the bare-topic shortcut and `--resume=<path>` are documented aliases, not legacy forms). Slash command's `### Subcommand routing` → `### Verb routing`.
- **Verb reference table now uses "Effect" column instead of "Phases."** The previous "Phases" column was inaccurate for operation verbs (import/doctor/status/retro aren't pipeline phases). Each row now has a one-line effect description rather than `(unchanged)` placeholders.
- **Reserved-verb list expanded.** Step 0's "Verb tokens are reserved" warning previously listed only the four phase verbs; now lists all eight (new, brainstorm, plan, execute, retro, import, doctor, status) — matches what the routing table actually consumes.
- **README install (Option A) rewritten.** Previous text was gated on a future condition. Replaced with the current `/plugin marketplace add rasatpetabit/superpowers-masterplan` + `/plugin install` flow, with the interactive `/plugin` Discover tab documented as a syntax-drift fallback.

### Fixed
- **Doctor section was missing its `## Step D` header.** The section started directly with `### Scope` after Step S4. Restored the `## Step D — Doctor` heading.
- **Doctor parallelization brief told each Haiku worker to run "all 10 checks"** but the doctor checks table has 14 entries. Workers were silently skipping orphan archive, telemetry growth, orphan telemetry, and orphan eligibility cache. Corrected to "all 14 checks."
- **Step I3.4's status-file conversion brief omitted `compact_loop_recommended`** from its required frontmatter enumeration. Doctor check #9 requires the field; every imported plan would have failed schema validation immediately. Field added to the brief.
- **Step 4b's zero-commit handling contradicted itself.** Step 1 said "skip 4b for zero-commit tasks"; step 2's rationale paragraph said "inline the diff via the existing fallback in step 1" (no such fallback existed). The stale fallback claim was removed.
- **Step C dispatch guard misstated B1's "Continue to plan now" path.** The guard described a non-existent composite option `"Continue to plan now → Start execution now"` blending B1 (which flips `halt_mode` to `post-plan`) with B3 (which flips it to `none`). Rewrote to clarify the actual flow: B1's flip falls through B2 to B3, where the user explicitly picks "Start execution now" to enter Step C. B3's `post-plan` close-out gate description and B2's dispatch guard prose were updated to match.
- **Blocker re-engagement gate had 5 options, violating CD-9's 2–4 cap.** Dropped option 3 ("Break this task into smaller pieces — pause so I can edit the plan to decompose, then continue") since it overlapped semantically with option 1 ("Provide context and re-dispatch"). Option 5 (the legacy `status: blocked` end-turn path) is preserved — resume-from-blocker depends on it being the only path to the legacy blocked state.
- **Dispatch model table cell referenced a nonexistent "Task 2."** Stale draft pointer; removed.
- **Codex annotation syntax was inconsistent across the orchestrator.** Eligibility checklist and the operational-rule mention used lowercase `codex: ok|no`; the canonical syntax block and the eligibility-cache builder used `**Codex:** ok|no` (bold, capital). Plan authors had no way to know which form the parser expected. Standardized on `**Codex:** ok|no` everywhere.
- **README verb-table cell** pointed readers to "see invocation forms below" — that section is now called `### Aliases and shortcuts`. Dangling anchor; updated.
- **`docs/design/telemetry-signals.md`'s "Tokens-per-turn estimate"** `jq foreach` query was broken: the UPDATE expression `$r` overwrote the accumulator each iteration, so `growth = $r.transcript_bytes - $r.transcript_bytes = 0` for every record. Rewrote using `range`-based indexed access; verified against a 3-record fixture that growth values are now real (non-zero where expected).
- **`hooks/masterplan-telemetry.sh` used GNU-only `find -quit` and `find -printf`** — both silently break on macOS BSD `find`. The most-used transcript-resolution fallback returned no output on macOS. Rewrote with portable `head -n1` and a `stat -c '%Y' || stat -f '%m'` dual form. Verified end-to-end on Linux; the macOS path is portable-by-construction but not smoke-tested (call for issues added to the README).
- **`hooks/masterplan-telemetry.sh` had no `jq` presence check** despite declaring jq as Required in the header. Without jq, the hook silently wrote nothing forever. Added explicit `command -v jq` guard at startup that bails silently if jq is absent.
- **`hooks/masterplan-telemetry.sh` wakeup-count cutoff** could become empty in stripped or musl-libc environments where neither GNU `date -d` nor BSD `date -v` works. Awk's `ts > ""` is true for every non-empty timestamp, so `wakeup_count_24h` would over-count every wakeup ever recorded. Added a sentinel cutoff (`9999-12-31T23:59:59Z`) that produces zero matches when both date forms fail — safe degraded behavior beats silent over-counting.

### Polish
- **Step P note** said "(Step B0a, below in Step B)"; B0a is *above* Step P. Direction corrected.
- **Completion-state inference header** claimed it was "(and optionally Step C on resume to validate the plan against current reality)"; no Step C site actually invokes it. Forward intention that was never wired up; claim removed.
- **B1 "Continue to plan now" option** didn't note that B0a's worktree check is skipped (already settled by the earlier B0 run). Parenthetical added.
- **Step I0 direct-import** ("skip discovery and jump to Step I3") didn't note that Step I2 (rank+pick) is also skipped — the candidate is already determined. Added.
- **Activity log archive description** overstated `/masterplan doctor`'s involvement — doctor only flags orphan archives via check #11, doesn't read content. Removed the misleading "and by `/masterplan doctor`" clause.
- **Telemetry hook had a dead `out_file` assignment** (line 80 was overwritten by line 82) with a comment that described line 82's behavior, not line 80's. Removed the dead line and the orphan comment.
- **`masterplan-detect` skill body** described two detection execution paths (Claude Code `Glob` tool vs shell `fd` snippets) as a single mechanism. Reframed as two layers: Glob is the always-available skill-tool path; the `fd` snippets in **Detection commands** give richer matching where `fd` is installed.
- **Historical status-file example** had a real `/home/ras/...` worktree path. Anonymized to `/home/you/...` to match the README's status-file example convention.
- **README hook section** softened to make the Linux-only smoke-test gap explicit: portable code paths are documented, but the macOS path hasn't been verified — readers are pointed at GitHub issues if telemetry doesn't land.

### Migration notes
- If you installed via Option B (manual copy) and copied `skills/masterplan-retro/` into `~/.claude/skills/`, you can safely `rm -rf ~/.claude/skills/masterplan-retro/`. The skill is no longer shipped or referenced.
- If you installed as a plugin (Option A), pulling v1.0.0 removes the skill automatically.
- No status-file or config schema changes. Existing plans, status files, and `.masterplan.yaml` files work unchanged.
