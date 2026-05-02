---
slug: superflow-subcommands
status: design
target_release: v0.3.0
---

# `/superflow` explicit phase subcommands — design

## Problem

`/superflow`'s entry-point grammar mixes named verbs (`import`, `doctor`, `status`) with two implicit modes that are not addressable as verbs:

- **Empty args** → list-and-pick across worktrees (Step A).
- **Anything else as the first token** → treat as a kickoff topic (Step B).

The pipeline phases — brainstorm, plan, execute — are not addressable either: a kickoff always runs all three end-to-end. Users who want to stop after brainstorm (iterate the spec before committing to a plan) or stop after plan (review or hand off before execution) have no clean way to express that, and the catch-all behavior makes the available verbs invisible at the call site.

## Goal

Add explicit phase verbs so every flow has a named entry point, and so the pipeline can halt cleanly after brainstorm or after plan. Discoverability is the primary motivation; halt-after-phase falls out of expressing the verbs.

This change is **additive**. The existing bare-topic shortcut, the empty-args list-and-pick, and `--resume=<path>` continue to work unchanged. No deprecation notices.

## Non-goals

- No new doctor checks.
- No changes to Step A, Step C, Step I, Step S, Step D internals.
- No `/superflow help` verb — Claude Code's slash-command picker already surfaces the command's `description` field.
- No deprecation of bare-topic, empty-args, or `--resume=`.

## Design

### Routing table (Step 0)

The first-token routing table gains four verbs (`new`, `brainstorm`, `plan`, `execute`). All existing entries are preserved.

| First token | Branch | `halt_mode` |
|---|---|---|
| _(empty)_ | Step A — list+pick across worktrees | `none` |
| `new <topic>` | Step B — full kickoff (B0→B1→B2→B3→C) | `none` |
| `brainstorm` (no topic) | Prompt for topic, then Step B0+B1; halt at B1 close-out gate | `post-brainstorm` |
| `brainstorm <topic>` | Step B0+B1; halt at B1 close-out gate | `post-brainstorm` |
| `plan` (no args) | Step P — pick spec-without-plan; treat pick as `plan --from-spec=<picked>` | `post-plan` |
| `plan <topic>` | Step B0+B1+B2+B3; halt at B3 close-out gate | `post-plan` |
| `plan --from-spec=<path>` | cd into spec's worktree, run B2+B3 only; halt at B3 close-out gate | `post-plan` |
| `execute` (no path) | Step A — same as bare empty | `none` |
| `execute <status-path>` | Step C — resume that plan | `none` |
| `import [...]` | Step I (unchanged) | `none` |
| `doctor [--fix]` | Step D (unchanged) | `none` |
| `status [--plan=<slug>]` | Step S (unchanged) | `none` |
| `--resume=<path>` | Step C (alias for `execute <path>`) | `none` |
| anything else | Treat as topic, Step B (back-compat catch-all) | `none` |

`halt_mode` is an internal orchestrator variable set in Step 0 and consumed by Steps B1, B2, B3, and C to determine whether to dispatch the next phase or surface a halt gate. Values: `none | post-brainstorm | post-plan`.

**Verb tokens are reserved.** A topic literally named `new`, `brainstorm`, `plan`, or `execute` cannot be a kickoff topic via the catch-all because the verb match wins. Workaround: prepend any other word — `/superflow refactor brainstorm logic` parses fine because `refactor` isn't a verb. Document this in the README's verb table.

### Step 0 — argument parsing additions

After the existing config-load and git-state-cache work, the subcommand-routing block gains:

1. Match the first token against the verb set `{new, brainstorm, plan, execute, import, doctor, status}`.
2. If matched: set `halt_mode` per the routing table; consume the verb; pass remaining args to the matched step.
3. If unmatched and the first arg starts with `--`: treat as a flag-only invocation; route to Step A.
4. If unmatched and the first arg is a non-flag word: catch-all → Step B with the full arg string as the topic (existing behavior).

Flag-interaction rules (one-line warning emitted at Step 0 when triggered):

- `halt_mode = post-brainstorm` → `--autonomy=`, `--codex=`, `--codex-review=`, `--no-loop` are ignored. Warning: `flags <list> ignored: brainstorm halts before execution`.
- `halt_mode = post-plan` → those same flags are persisted to the status file (Step B3 records them in frontmatter) but do not fire this run. No warning.
- `halt_mode = none` → flags fire as today.

### Step B1 — brainstorm close-out gate

The existing re-engagement gate after `superpowers:brainstorming` returns gains a `halt_mode`-aware variant.

- **`halt_mode = none`** (current behavior, unchanged): present the existing approve/refine/abort gate.
- **`halt_mode = post-brainstorm`** (new): present:
  ```
  AskUserQuestion(
    "Spec written at <path>. What next?",
    options=[
      "Done — close out this run (Recommended)",
      "Continue to plan now — run B2+B3 as if /superflow plan --from-spec=<path>",
      "Open spec to review before deciding — then ping me",
      "Re-run brainstorming to refine"
    ]
  )
  ```
  - "Done" — end the turn cleanly. No status file written, no plan written.
  - "Continue to plan now" — flip in-session `halt_mode` to `post-plan` and proceed to Step B2. The spec was already written; B2 reuses it.
  - "Open spec" — end the turn; user reviews and re-invokes whatever they want next.
  - "Re-run brainstorming to refine" — re-invoke `superpowers:brainstorming` against the existing topic; the previous spec is overwritten.

When `halt_mode != post-brainstorm`, this new gate is not surfaced.

### Step B2 — dispatch guard

Before invoking `superpowers:writing-plans`, check `halt_mode`. If `halt_mode == post-brainstorm`, skip B2 and B3 entirely (the B1 close-out gate already ended the turn or transitioned the user to `post-plan`).

### Step B3 — plan close-out gate

The existing approval prompt after the status file is created gains a `halt_mode`-aware variant.

- **`halt_mode = none`** (current behavior, unchanged): present the existing "Start execution / Open plan / Cancel" gate.
- **`halt_mode = post-plan`** (new): present:
  ```
  AskUserQuestion(
    "Plan written at <path>. Status file at <status-path>. What next?",
    options=[
      "Done — resume later with /superflow execute <status-path> (Recommended)",
      "Start execution now — flip halt_mode to none and proceed to Step C",
      "Open plan to review before deciding",
      "Discard plan + status file (status file removed; spec kept)"
    ]
  )
  ```
  - "Done" — end the turn. Status file persists with `status: in-progress` and `current_task` set to the first task.
  - "Start execution now" — flip in-session `halt_mode` to `none` and proceed to Step C.
  - "Open plan" — end the turn; user re-invokes `/superflow execute <status-path>` later.
  - "Discard" — `git rm` the plan and status file; commit; end the turn. The spec is kept.

The status file's `autonomy`, `codex_routing`, `codex_review`, and `loop_enabled` fields are populated from the flags passed in this invocation (per the post-plan flag-persistence rule). They take effect on the eventual `execute` invocation.

### Step C — dispatch guard

Before invoking `superpowers:subagent-driven-development` or `superpowers:executing-plans`, check `halt_mode`. If `halt_mode != none`, skip Step C entirely (the B1 or B3 gate already ended the turn or transitioned `halt_mode` to `none` for in-session continuation).

### Step P — plan-only no-args picker

New short step. Triggered by `/superflow plan` with no topic and no `--from-spec=`. Inserted after Step B in the document for proximity, but logically distinct.

1. Glob `<config.specs_path>/*-design.md` across all worktrees as one parallel Bash batch.
2. For each candidate spec, check whether a sibling plan exists at `<config.plans_path>/<same-slug>.md`. Filter to specs **without** a plan.
3. Sort filtered list by mtime descending.
4. **If ≥ 1 candidate:** present top 3 via `AskUserQuestion` (with the 4th option "Other — paste a path"). User picks → treat as `plan --from-spec=<picked>` and proceed to Step B2 (after cd into the spec's worktree).
5. **If zero candidates:** present:
   ```
   AskUserQuestion(
     "No specs without plans found across <N> worktrees. What next?",
     options=[
       "Start a new feature — /superflow new <topic>",
       "Brainstorm-only — /superflow brainstorm <topic>",
       "Cancel"
     ]
   )
   ```
   First two redirect to the corresponding verb's flow with topic prompted next; "Cancel" ends the turn.

`halt_mode` for this step's outputs is `post-plan` (set in Step 0 when the verb is matched).

### `plan --from-spec=<path>` worktree handling

When this form is used directly (i.e. not via Step P, which already resolves the path), Step B0's worktree decision is **skipped**. The spec's location is authoritative:

1. Resolve `<path>` to its containing git worktree via `git rev-parse --show-toplevel` from the spec's parent directory.
2. `cd` into that worktree before invoking `superpowers:writing-plans`.
3. Verify the worktree appears in `git_state.worktrees` (Step 0 cache). If it doesn't, surface `AskUserQuestion` with options "Refresh worktree list and retry / Abort".
4. If the spec is outside any git worktree (resolution fails): error with `Spec at <path> is not inside a git worktree. Move it under a worktree, or run /superflow brainstorm <topic> to recreate.`
5. If the resolved worktree's current branch is in `config.trunk_branches`, surface `AskUserQuestion` BEFORE invoking writing-plans — this mirrors Step B0's stay-option warning so the trunk-branch problem isn't punted to execute time:
   ```
   AskUserQuestion(
     "Spec lives on `<branch>` (a trunk branch). superpowers:subagent-driven-development will refuse to start on this branch at execute time. What now?",
     options=[
       "Create a new worktree for the plan and copy the spec into it (Recommended)",
       "Continue on `<branch>` anyway — I'll handle SDD's refusal manually later",
       "Abort"
     ]
   )
   ```
   "Create new worktree" runs the same flow as Step B0's "Create new" branch (with directory pre-decided per the existing AskUserQuestion + `superpowers:using-git-worktrees` pattern), then `git mv`s the spec into the new worktree's `<config.specs_path>/` and commits. After that, proceed to writing-plans in the new worktree.

Step B0 still runs under `plan <topic>` (the brainstorm-then-plan form) because no spec exists yet — same flow as bare-topic kickoff today.

### Doctor and status interactions

No new checks needed:

- A status file with an empty `## Activity log` and `status: in-progress` is already a valid state today (the kickoff-but-pre-Step-C moment). Halt-after-plan plans land in this state by design.
- `/superflow status` already lists in-progress plans by `last_activity` desc; halt-after-plan plans appear naturally.
- `/superflow doctor`'s schema check (#9) already enforces all required frontmatter fields, including `current_task` and `next_action`, both of which Step B3 populates regardless of halt mode.

### Documentation

1. **`commands/superflow.md` frontmatter description** (line 2):
   - **Before:** "Brainstorm → plan → execute development workflow that delegates work to bounded subagents, preserves orchestrator context for routing/state, and self-paces long runs across sessions"
   - **After:** "Brainstorm → plan → execute workflow. Verbs: new, brainstorm, plan, execute, import, doctor, status. Bare-topic shortcut still works."
2. **`commands/superflow.md` Step 0 routing table:** replace the existing 6-row table with the 14-row table above. Add a one-paragraph note below summarizing `halt_mode` semantics.
3. **`commands/superflow.md` Step B1, B2, B3:** each gains a "When halt_mode != none" subsection with the variant gate text. No prose duplicated.
4. **`commands/superflow.md` Step P:** new section inserted between Step B and Step C, ~15 lines per the design above.
5. **`README.md`:** new "Subcommands" subsection at the top of "Common usage" with the verb table:

   | Verb | Phases | Halts at |
   |---|---|---|
   | `new <topic>` | brainstorm + plan + execute | (runs through) |
   | `brainstorm <topic>` | brainstorm only | spec written |
   | `plan <topic>` | brainstorm + plan | plan written |
   | `plan --from-spec=<path>` | plan only (against existing spec) | plan written |
   | `execute [<path>]` | execute (list+pick or resume) | (runs through) |
   | `import [...]` | (unchanged) | n/a |
   | `doctor [--fix]` | (unchanged) | n/a |
   | `status [--plan=<slug>]` | (unchanged) | n/a |

   Existing examples below stay as-is. Add one-liner: "Topics literally named after a verb (`new`, `brainstorm`, `plan`, `execute`) need to be prefixed with another word, e.g. `/superflow add brainstorm session timer`."
6. **`CHANGELOG.md`:** v0.3.0 entry with three bullets:
   - Added: explicit phase verbs (`new`, `brainstorm`, `plan`, `execute`).
   - Added: halt-after-brainstorm and halt-after-plan modes.
   - Unchanged: bare-topic shortcut and `--resume=<path>` keep working as before.
7. **`WORKLOG.md`:** dated entry summarizing scope, why (discoverability + halt-after-phase), and key decisions (additive, no deprecation, halt_mode internal var, verb-token reservation).

## Edge cases

- **`/superflow new` (no topic):** error with usage hint. (`new` is the explicit-form alias of bare-topic; without a topic there's nothing to do.)
- **`/superflow execute` with zero in-progress plans:** Step A's existing flow handles this — surfaces "Start fresh" which routes back to Step B (kickoff). No verb-specific handling required.
- **`/superflow plan --from-spec=<path>` where the spec already has a plan:** writing-plans would overwrite the plan. Mirror Step I3's import-overwrite policy: surface `AskUserQuestion("Plan at <path> already exists. Overwrite / Write to <slug>-v2 / Abort")` before invoking writing-plans.
- **In-session `halt_mode` flips:** allowed only via the explicit B1/B3 close-out gate options ("Continue to plan now", "Start execution now"). No other code path mutates `halt_mode` after Step 0.
- **`/loop /superflow brainstorm <topic>`:** the loop wakes up after the brainstorm halts. The wakeup re-fires `/superflow brainstorm <topic>` — but the spec already exists, so brainstorming would re-run from scratch (overwriting). This is a foot-gun. Mitigation: at Step 0, when `halt_mode != none` and `ScheduleWakeup` is available, emit one-line warning: `note: <verb> halts before execution; --no-loop recommended for this verb`. Don't disable the loop automatically — user might have a specific reason.
- **Verb-token collision with topics:** `/superflow new` consumes `new` as a verb. To use `new` as a topic word, put it after another word: `/superflow add new feature`. Documented in README.

## Build sequence

1. Step 0 routing table + `halt_mode` plumbing + flag-interaction rules.
2. Step B1 close-out gate variant + Step B2 dispatch guard.
3. Step B3 close-out gate variant + Step C dispatch guard.
4. Step P (plan no-args picker) + `plan --from-spec=<path>` worktree handling.
5. Doc surface: command description, README verb table, CHANGELOG, WORKLOG.
6. Manual smoke test against all 9 verb forms (the 7 unique entry points + bare-topic + bare-empty).

Each step is a small markdown edit to `commands/superflow.md` (or one of the doc files); each step has an obvious verification (grep for the new verb token, render the routing table, dry-run an invocation by reading the prompt).
