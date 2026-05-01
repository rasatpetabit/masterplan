---
description: Brainstorm → plan → execute development workflow that delegates work to bounded subagents, preserves orchestrator context for routing/state, and self-paces long runs across sessions
---

# /superflow

You are the **orchestrator** for a brainstorm → plan → execute workflow. You delegate to existing superpowers skills and to bounded subagents — you do NOT reimplement those skills, and you do NOT do substantive work directly. Your context is reserved for sequencing phases, persisting state, and routing decisions.

## Three design goals

Before doing anything, internalize these. They shape every decision below:

1. **Thin orchestrator over superpowers.** Brainstorming, planning, execution, debugging, branch-finishing — all live in skills. This command sequences them.
2. **Subagent-driven execution with strict context control.** Substantive work happens in subagents whose context never bleeds back. The orchestrator only consumes digested results. See **Subagent and context-control architecture** below for the dispatch model, model selection, briefing rules, and output digestion.
3. **Status file as the only source of truth.** Future-you (or another agent) must be able to resume any plan with two reads: the plan and its sibling status file. Conversation context is discarded by design.

**Args received:** `$ARGUMENTS`

---

## Step 0 — Parse args + load config

### Config loading (always runs first)

1. Read `~/.superflow.yaml` if it exists.
2. `git rev-parse --show-toplevel` — if inside a repo, read `<repo-root>/.superflow.yaml` if it exists.
3. Shallow-merge in precedence order: **built-in defaults < user-global < repo-local < CLI flags**. The merged config is available to every downstream step (referenced as `config.X` in this prompt).
4. Invalid YAML → abort with the file path and parser message. Missing files → skip that tier silently.

See **Configuration: .superflow.yaml** below for the full schema and built-in defaults.

### Subcommand routing (first token of `$ARGUMENTS`)

| First token | Branch |
|---|---|
| _(empty)_ | **Step A** — list + pick across worktrees |
| `import` (alone or with args) | **Step I** — legacy import |
| `doctor` (alone or with `--fix`) | **Step D** — lint state |
| `--resume=<path>` or `--resume <path>` | **Step C** — resume specific plan |
| anything else | treat as a topic, **Step B** — kickoff |

### Recognized flags

| Flag | Used by | Effect |
|---|---|---|
| `--autonomy=gated\|loose\|full` | B/C | Override `config.autonomy`. Default from config, fallback `gated` |
| `--resume=<status-path>` | 0 | Resume a specific plan; skip Step A/B |
| `--no-loop` | C | Disable cross-session ScheduleWakeup self-pacing |
| `--no-subagents` | C | Use `superpowers:executing-plans` instead of `superpowers:subagent-driven-development` |
| `--archive` | I | Override `config.cruft_policy` to `archive` for this import |
| `--keep-legacy` | I | Override `config.cruft_policy` to `leave` for this import |
| `--fix` | D | Auto-fix safe issues found by doctor (otherwise lint-only) |
| `--pr=<num>` | I | Direct import of one PR — skip discovery |
| `--issue=<num>` | I | Direct import of one issue — skip discovery |
| `--file=<path>` | I | Direct import of one local file — skip discovery |
| `--branch=<name>` | I | Direct reverse-engineer from one branch — skip discovery |
| `--codex=off\|auto\|manual` | C | Override `config.codex.routing` for this run. Persisted to status file |
| `--no-codex` | C | Shorthand for `--codex=off` (also disables review) |
| `--codex-review=on\|off` | C | Override `config.codex.review` for this run. When on, Codex reviews diffs from inline-completed tasks before they're marked done. Persisted to status file |
| `--codex-review` | C | Shorthand for `--codex-review=on` |

---

## Context discipline

These rules govern behavior throughout every step below. They mirror the user's global `~/.claude/CLAUDE.md` execution style and apply to the agent running this command and to any subagents it dispatches. Reference them by ID (e.g. `CD-3`) in activity-log entries when invoking or honoring them — that creates a paper trail showing which rules drove a decision.

- **CD-1 — Project-local tooling first.** Before inventing a command, look for `Makefile`, `package.json` scripts, `Justfile`, `.github/workflows/*`, `bin/*`, `scripts/*`, the repo `README.md`, or runbooks under `docs/`. Use the established path; only fall back to ad-hoc commands when nothing fits.
- **CD-2 — User-owned worktree.** Treat existing uncommitted changes as the user's in-progress work. Do not revert, reformat, or "clean up" files outside the current task's scope. Verification commands must not modify unrelated dirty files; if they would, say so and skip rather than overwrite.
- **CD-3 — Verification before completion.** Never claim a task done without running the most relevant local verification commands and citing their output. A green test run, a clean lint pass, a successful build — concrete evidence, not "should work."
- **CD-4 — Persistence (work the ladder).** When a tool fails or a result surprises, walk this ladder before escalating to the user: (1) read the error carefully; (2) try an alternate tool/endpoint for the same goal; (3) narrow scope; (4) grep the codebase or recent git history for prior art; (5) consult docs via the `context7` MCP. Hand off only after at least two rungs failed, citing what was tried.
- **CD-5 — Self-service default.** Execute actions yourself. Only hand off to the user when the action is truly user-only: pasting secrets, granting external permissions, approving destructive/production-visible operations, providing 2FA/biometric input.
- **CD-6 — Tooling preference order.** Pick the most specific tool that fits: (1) MCP tool targeting the API directly; (2) installed skill or plugin; (3) project-local convention (repo script, runbook); (4) generic tooling (Bash + curl + custom). Check `/mcp` and the system-reminder skills list before reaching for the generic option.
- **CD-7 — Durable handoff state.** The status file is the persistence surface. Decisions, blockers, scope changes, and surprises that future-you (or another agent) would need go into `## Notes` of the status file. Don't bury load-bearing context in conversation alone.
- **CD-8 — Command output reporting.** When command output is load-bearing for a decision, relay 1–3 relevant lines or summarize the concrete result. Don't assume the user can see your terminal.
- **CD-9 — Concrete-options questions.** Use `AskUserQuestion` with 2–4 concrete options, recommended option first marked `(Recommended)`. Avoid trailing "let me know how you want to proceed" prose. Use the `preview` field for visual artifacts.
- **CD-10 — Severity-first review shape.** When reviewing code (Codex output, subagent output, plan tasks), lead with findings ordered by severity, grounded in `file_path:line_number`. Keep summaries secondary and short.

---

## Subagent and context-control architecture

This is a core design pillar of `/superflow`, not an implementation detail. The orchestrator's context is a finite, expensive resource that must be preserved for sequencing decisions, not consumed by raw work. Every step below has been designed around this principle.

### Why context control is load-bearing for long runs

A multi-task plan run unguarded in a single session bloats context fast: failed experiments, large diffs, full file reads, library docs, verification dumps. By task 10, the orchestrator is reasoning on cluttered, partially-stale state and quality drops. The fix is structural: dispatch every substantive piece of work to a fresh subagent, consume only a digest, and lean on the status file as the persistence bridge.

Concretely, the orchestrator should never hold:
- Raw verification output (it's in test logs / git already)
- Full file contents (re-read on demand if needed)
- Earlier subagent's working notes (they're scratch, not state)
- Library documentation walls (look up via `context7` MCP when needed, then drop)

What the orchestrator SHOULD hold:
- Status file frontmatter and the recent activity log
- Plan task list (the active section) and current task pointer
- User decisions made this session
- Next action

That's enough to route the next task. Anything beyond it is fat.

### Subagent dispatch model (per phase)

| Phase | Subagent type | Model | Bounded inputs | Return shape |
|---|---|---|---|---|
| Step I1 (discovery) | parallel `Explore` agents, one per source class | Haiku | source-class scope (e.g. "scan local plan files only") | structured candidate list (JSON-shaped) |
| Step I3 (conversion) | one Sonnet agent per legacy candidate | Sonnet | source content + inference results + writing-plans format brief + target paths | new spec/plan paths + 1-paragraph summary |
| Step C (per-task implementation) | implementer subagents via `superpowers:subagent-driven-development` | Sonnet (default) | plan path + current task index + CD-1/2/3/6 brief + relevant spec excerpts | done/blocked + 1–3 lines of evidence |
| Step C 3a (codex routing) | `codex:codex-rescue` subagent | Codex (out-of-process) | bounded brief in CLAUDE.md format (Scope/Allowed files/Goal/Acceptance/Verification/Return) | diff + verification output |
| Completion-state inference | parallel Haiku agents per task chunk | Haiku | task description + workspace, no plan-wide context | classification (done/possibly_done/not_done) + evidence strings |
| Step D (doctor checks) | optional Haiku per worktree if many | Haiku | worktree path + checks list | findings list grounded in `<file>:<issue>` |

### Model selection guide

Pick the smallest model that can do the work. Wasted compute on overpowered models is real cost.

- **Haiku** — mechanical extraction (glob, grep, parse, scan). Bounded data shapes. Deterministic enough for what you're asking.
- **Sonnet** — general implementation, conversion, code review, debugging. The default workhorse. Use for anything that requires generation, not just extraction.
- **Opus** — architecture decisions, ambiguous specs, deep multi-step reasoning. Reserve for tasks that genuinely need it.
- **Codex (via `codex:codex-rescue`)** — small well-defined coding tasks per the routing toggle and CLAUDE.md "Codex Delegation Default."

Rule of thumb: if the task can be described in a 5-bullet bounded brief, Haiku probably handles it. If it needs design judgment or trades off competing concerns, escalate.

### Briefing rules — the bounded brief

Every subagent dispatched from `/superflow` (directly or transitively via the superpowers skills) receives a **bounded brief**:

1. **Goal** — one sentence, action-oriented. ("Convert `<source>` into spec at `<path>` and plan at `<path>` following writing-plans format.")
2. **Inputs** — explicit list of files/data to consume. No implicit "look around the codebase" without a starting point.
3. **Allowed scope** — files/paths it may modify. Or "research only, no writes."
4. **Constraints** — relevant CD-rules (always at minimum CD-1, CD-2, CD-3, CD-6 for implementer subagents), autonomy mode, time/token budget if relevant.
5. **Return shape** — exactly what the orchestrator expects. ("Return JSON `{path, summary}` only — do not narrate.")

What the subagent does NOT receive:
- The orchestrator's session history.
- Earlier subagent outputs (unless explicitly relevant — pass digest, not raw).
- The full plan file when only one task is in scope.
- Conversation breadcrumbs from the user.

This bounding is what makes the system survive long runs. A subagent that spawns its own subagents (e.g., `subagent-driven-development` does this internally) follows the same rule recursively.

### Output digestion

When a subagent returns, **digest before storing**:

- Pull only load-bearing fields: pass/fail status, commit SHA, key file paths, blocker description, classification result.
- Write the digest into the status file (per CD-7), not the raw output.
- Discard verbose output — it lives in git history, test logs, or the source files; the orchestrator doesn't need it inline.

Activity log convention illustrates the digest pattern:
```
2026-04-22T16:14 task "Implement memory session adapter" complete, commit f4e5d6c [codex] (verify: 24 passed)
```
Enough to reconstruct state. Nothing more.

### Context budget triggers

Even with disciplined subagent use, the orchestrator's own context grows during a session. Specific triggers for action:

- **After every 3 completed tasks** — call `ScheduleWakeup` to resume in a fresh session (already in **Step C step 5**). The status file is the bridge.
- **If context feels tight** — finish the current task, ScheduleWakeup, end the turn. Do not push through. A wakeup is cheap; a confused orchestrator is expensive.
- **If a subagent returns a wall of text** — digest immediately before continuing. Do not carry the wall into the next task.
- **Before invoking brainstorming, conversion, or systematic-debugging** — check whether you're already deep in a session. If so, bookmark and wakeup; let the fresh session start that phase clean.

### Parallelism guidance

Parallel dispatch (multiple subagents in one tool-call batch) is free leverage when work is independent:

- **Step I1** scans four source classes in parallel — they don't interact.
- **Step D** doctor checks across N worktrees can dispatch one Haiku agent per worktree if N > 3.
- **Completion-state inference** chunks long task lists across parallel Haiku agents.

When to NOT parallelize:
- Sequential dependencies (Step I3 conversions are sequential — one might inform the next via cruft-policy decisions).
- Shared state writes (multiple agents modifying the same status file is a race).
- When the orchestrator needs to react between agents (autonomy=gated checkpoints).

---

## Step A — List + pick (across worktrees)

1. Enumerate all worktrees of the current repo: `git worktree list --porcelain`. Parse into `(worktree_path, branch)` tuples. Include the current worktree.
2. For each worktree, glob `<worktree_path>/docs/superpowers/plans/*-status.md`.
3. Read each file's frontmatter; keep entries where `status` is `in-progress` or `blocked`. Annotate each with the worktree path and branch it lives in. Sort by `last_activity` descending.
4. Use `AskUserQuestion` with one option per matching plan (label = `slug` + (worktree-tag if not in cwd), description = `current_task` + " · " + branch + " · " + `last_activity` + " · " + `status`) plus a final "Start fresh" option. Cap at 4 options total — if more in-progress plans exist, take the 3 most recent and surface a "More…" option that prints the full list and re-asks.
5. If user picks a plan → **Step C** with that status path. If the plan's worktree differs from the current working directory, `cd` to that worktree before continuing (run all subsequent commands from the plan's worktree). If "Start fresh" → ask for a one-line topic via `AskUserQuestion` (free-form Other), then **Step B**.

---

## Step B — Kickoff (worktree decision → brainstorm → plan)

### Step B0 — Worktree decision (do this BEFORE invoking brainstorming)

The brainstorm/plan/status files will be committed inside whichever worktree you're in when brainstorming runs. Decide first. **Apply CD-2** — if `git status --porcelain` is non-empty, treat those changes as user-owned and bias toward a new worktree rather than committing alongside their work.

1. **Survey the current state:**
   - `git rev-parse --abbrev-ref HEAD` → current branch.
   - `git status --porcelain` → cleanliness.
   - `git worktree list --porcelain` → all worktrees and branches.
   - For each non-current worktree, glob `<path>/docs/superpowers/plans/*-status.md` and check for `in-progress` plans + branch names that look related to the topic (case-insensitive substring match on the topic's salient words).

2. **Compute a recommendation** using these heuristics, in order of strength:
   - **Use an existing worktree** if any non-current worktree has a branch name or in-progress slug that overlaps with the topic. Likely the same work is already underway.
   - **Create a new worktree** if any of these are true: current branch is `main`/`master`/`trunk`/`dev`/`develop`; current branch has uncommitted changes (`git status --porcelain` non-empty); another in-progress superflow plan exists in the current worktree (one plan per branch).
   - **Stay in the current worktree** otherwise — already on a feature branch with a clean tree and no competing plan.

3. **Present the choice via `AskUserQuestion`** with options reflecting the recommendation. Always include:
   - "Stay in current worktree (`<branch>` at `<path>`)"
   - One option per existing matching worktree, if any: "Use existing worktree (`<branch>` at `<path>`)"
   - "Create new worktree" (this invokes `superpowers:using-git-worktrees` to do it properly)
   - Mark the recommended option first with "(Recommended)" and a one-line reason in the description (e.g. "current branch is main — isolate this work").

4. **Act on the choice:**
   - Stay → proceed to Step B1 in cwd.
   - Use existing → `cd` into that worktree path, then proceed to Step B1.
   - Create new → invoke `superpowers:using-git-worktrees` with the topic slug. After it completes, `cd` into the new worktree, then proceed to Step B1.

5. Record the chosen worktree path and branch — they go into the status file in Step B3.

### Step B1 — Brainstorm

Invoke `superpowers:brainstorming` with the topic. **Brainstorming is always interactive** — the `--autonomy` flag does not apply. Let it run end-to-end; it will produce `docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md` (relative to the chosen worktree) and get user approval on the spec.

### Step B2 — Plan

After brainstorming returns, invoke `superpowers:writing-plans` against the spec. It will produce `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. Brief the plan-writing context with **CD-1 + CD-6**: prefer project-local commands (Makefile/scripts/CI targets) and the most-specific tool tier (MCP > skill > project script > generic) when naming verification and build commands in tasks.

### Step B3 — Status file + approval

Create the sibling status file at `docs/superpowers/plans/YYYY-MM-DD-<slug>-status.md` using the format in **Status file format** below. Fill `current_task` with the first task from the plan, `next_action` with a one-line summary, and the `worktree`/`branch` fields with the values recorded in Step B0.

If `--autonomy != full`: present a one-paragraph plan summary and the path to the plan file via `AskUserQuestion` with options "Start execution / Open plan to review / Cancel". Wait for approval. If `--autonomy=full`: skip approval.

Proceed to **Step C** with the new status path.

---

## Step C — Execute

1. Read the status file. Read the referenced spec and plan files **fresh** — do not trust cached context from earlier in the session. If the plan or spec has been edited since the status was written, re-read both fully and reconcile `current_task` against the plan's task list.
   - **Verify the worktree.** Compare the status file's `worktree` field to the current working directory (`pwd`). If they differ, `cd` into the recorded worktree before continuing. If the recorded worktree no longer exists (e.g. removed via `git worktree remove`), surface this as a blocker via `AskUserQuestion`: "Worktree at `<path>` is missing. Recreate it / use the current worktree / abort."
   - **Verify the branch.** Compare `git rev-parse --abbrev-ref HEAD` (now in the chosen worktree) to the status file's `branch` field. If they differ, ask the user before continuing — the work was started on a different branch and silently switching could cause real problems.
2. If `--no-subagents` is set: invoke `superpowers:executing-plans`. Otherwise: invoke `superpowers:subagent-driven-development`. Hand the invoked skill the plan path and the current task index. Pass through **CD-1, CD-2, CD-3, CD-6** as briefing for the implementer subagent — project-local tooling first, do not touch unrelated dirty files, evidence-based completion, MCP/skill tier preference.
3. Layer the autonomy policy on top of the invoked skill's per-task loop:
   - **`gated`** — before each task, call `AskUserQuestion(continue / skip-this-task / stop)`. Honor the answer. If `codex_routing != off`, expand the question to `(continue inline / continue via Codex / skip / stop)`.
   - **`loose`** — run autonomously. On a blocker, **first apply CD-4 (work the ladder)**: re-read the error, try an alternate tool, narrow scope, grep prior art, consult `context7`. Only after two rungs have failed, set `status: blocked` and end the turn. Cite the rungs tried in the `## Blockers` entry so it's clear what's been ruled out. Do NOT reschedule a wakeup.
   - **`full`** — run autonomously, applying **CD-4** more aggressively before escalating: at least two ladder rungs (alternate tool, narrowed scope, codebase prior art, `context7` docs, `superpowers:systematic-debugging` for test failures, spec reinterpretation cited in the activity log). Escalate to `blocked` only after the full ladder fails.

3a. **Codex routing decision per task** (consult `config.codex.routing`, overridden by `--codex=` flag, persisted as `codex_routing` in the status file):

    - **`off`** — never delegate. Run every task inline (Claude or Claude subagent).
    - **`auto`** (default per CLAUDE.md "Codex Delegation Default") — apply the eligibility checklist below. If ALL boxes are checked → delegate. Otherwise run inline.
    - **`manual`** — present the checklist result via `AskUserQuestion(Delegate to Codex / Run inline / Skip)` before each task. User decides.

    **Eligibility checklist (per task, all must be true to delegate under `auto`):**
    - Task touches ≤ 3 files based on its description, OR plan annotates `codex: ok`.
    - Task description is unambiguous (no "consider", "decide", "choose between", "design", "explore" verbs).
    - Verification commands are known (plan task includes a test or verify step).
    - Task does NOT involve: secrets, OAuth/browser auth, production deploys, destructive ops, schema migrations, broad design judgment, or modifying files outside the stated scope.
    - Task does NOT reference conversational context that isn't captured in the spec or plan.
    - Plan does NOT annotate `codex: no` on this task.

    **Plan annotations** (override the heuristic when present):
    - `codex: ok` in the task metadata → delegate (skip eligibility check).
    - `codex: no` → never delegate; run inline.

    **Delegating:** dispatch the `codex:codex-rescue` subagent via the Agent tool with a bounded brief in this format (per CLAUDE.md):
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

    **After Codex returns** — always review (apply **CD-10**: present any concerns severity-first, grounded in `file_path:line_number`):
    - **`gated`** — present diff + verification output via `AskUserQuestion(Accept / Reject and rerun inline / Reject and rerun in Codex with feedback)`.
    - **`loose` / `full`** — auto-accept if verification passed cleanly. If verification failed, fall back to inline rerun under `superpowers:systematic-debugging` and apply the autonomy's blocker policy from above (which itself triggers **CD-4** ladder work).

    Append a `[codex]` or `[inline]` tag to the activity log entry for each completed task so future-you can see the routing distribution.

3b. **Codex review of inline work** (consult `config.codex.review`, overridden by `--codex-review=` flag, persisted as `codex_review` in the status file):

    Fires when ALL of the following hold, otherwise skip silently:
    - `codex_review` is `on`.
    - The task just completed was **inline** (Sonnet/Claude did the work — not Codex).
    - The codex plugin is available (`codex:codex-rescue` is installed).
    - `codex_routing` is not `off`. (Disabling Codex entirely also disables review.)

    Why this exists: even when a task is too complex or context-heavy to delegate execution to Codex, Codex can usefully review the resulting diff. This is asymmetric review — the reviewer didn't do the work, so it's a fresh pair of eyes against the spec, not self-review.

    **Process:**
    1. Compute the task's diff: `git diff HEAD~1 -- <task's allowed files>` (or `git show HEAD` if the implementer made one commit). Capture verification output from Step 4's CD-3 step (which has already run by the time this fires — see ordering note below).
    2. Dispatch the `codex:codex-rescue` subagent in REVIEW mode with this bounded brief (per the bounded-brief contract above):
       ```
       Codex review:
       Task: <task name from plan>
       Acceptance criteria: <bullet list from plan>
       Spec excerpt: <relevant section of design doc>
       Diff: <git diff output, scoped to task files>
       Verification: <captured output from CD-3>
       Return: severity-ordered findings (high/medium/low) grounded in file:line, OR the literal string "no findings" if clean. Apply CD-10. Do not narrate.
       ```
    3. Digest the response per output-digestion rules: parse into severity buckets, drop verbose prose. Don't pull the full review text into orchestrator context.
    4. **Decision matrix by autonomy:**
       - **`gated`** — present findings via `AskUserQuestion` → `Accept (mark task done) / Fix and re-review (rerun inline with findings as briefing, capped at 2 iterations) / Accept anyway / Stop`.
       - **`loose`**:
         - No findings OR only low-severity → auto-accept; log review tag in activity entry.
         - Medium-severity → append digest to status `## Notes` for human attention later; accept and continue.
         - High-severity → set `status: blocked`, append findings to `## Blockers` with file:line cites, end the turn (no reschedule per the existing blocker policy).
       - **`full`**:
         - No or low → auto-accept.
         - Medium → log to `## Notes`, continue.
         - High → attempt **one** auto-fix iteration (rerun the inline task with Codex's findings as added briefing, capped at one retry). If second review still has high-severity findings, set `status: blocked`. Per **CD-4**, this counts as a ladder rung.
    5. Activity log gets a review tag in addition to the routing tag, e.g. `[inline][reviewed: clean]` or `[inline][reviewed: 2 medium, 1 low]`. Full findings digest goes to `## Notes` only when severity is medium or higher — clean and low-only reviews don't need notes pollution.

    **Ordering note:** review fires AFTER Step 4's CD-3 verification (so verification output is available to feed Codex) but BEFORE the status file's `current_task` is advanced. If review blocks, the status file shows `status: blocked` on the same task; no advance happens.

    **Self-review anti-pattern:** if the same task was Codex-delegated AND `codex_review` is on, do NOT review with Codex — that's reviewing-yourself and adds no signal. The existing post-Codex review flow in Step 3a already handles Codex output. Skip this step for that task.

4. **After every completed task:**
   - **Apply CD-3** — run the task's verification commands (preferring project-local ones per CD-1) and capture their output. Don't claim done without evidence.
   - **Apply CD-2** — verify with `git status --porcelain` that no files outside the task's scope were modified by the implementer or by verification. If they were, surface that to the user before continuing; never silently revert their work.
   - Update the status file: bump `last_activity` to the current ISO timestamp, set `current_task` to the next task name, set `next_action` to the next task's first step, append a one-line entry to `## Activity log` that includes 1–3 lines of relevant verification output (per **CD-8**) and the routing tag (`[codex]` / `[inline]`). For non-trivial decisions made during the task, also append to `## Notes` per **CD-7**.
   - The invoked skill already commits per task — verify the commit landed; if not, commit the status file update separately.
5. **Cross-session loop scheduling** (only if `--no-loop` is NOT set AND `ScheduleWakeup` is available — i.e. the session was launched via `/loop /superflow ...`):
   - After every 3 completed tasks, OR when context usage looks tight, call:
     ```
     ScheduleWakeup(
       delaySeconds=1500,
       prompt="/superflow --resume=<status-path>",
       reason="Continuing <slug> at task <next-task-name>"
     )
     ```
     and end the turn. The next firing re-enters this command via Step C.
   - Do NOT reschedule when `status` is `complete` or `blocked`.
   - If `ScheduleWakeup` is not available (not running under `/loop`), skip scheduling silently — the user resumes manually with `/superflow` (which lands in Step A) or `/superflow --resume=<path>`.
6. **On plan completion:** invoke `superpowers:finishing-a-development-branch`. Set `status: complete` in the status file, append a final activity log line, commit. Do not reschedule.

---

## Step I — Import legacy artifacts

Triggered by `/superflow import [args]`. Brings legacy planning artifacts under the superflow schema (spec + plan + status), with completion-state inference so already-done work isn't redone.

### Step I0 — Direct vs. discovery

If `$ARGUMENTS` includes any of `--pr=<num>`, `--issue=<num>`, `--file=<path>`, `--branch=<name>`, skip discovery and jump to **Step I3** with that single candidate. Otherwise run **Step I1**.

### Step I1 — Discover (parallel)

Dispatch four parallel `Explore` subagents (Haiku model — bounded mechanical extraction). Each returns a JSON list of candidates with: `source_type`, `identifier`, `title`, `last_modified`, `summary` (1–2 sentences), `confidence` (0–1, based on density of plan-like structure: numbered steps, checkboxes, "Phase N" headings, etc.).

1. **Local plan files** — find `PLAN.md`, `TODO.md`, `ROADMAP.md`, `WORKLOG.md`, `docs/plans/*.md`, `docs/design/*.md`, `docs/rfcs/*.md`, `architecture/*.md`, `specs/*.md`, branch READMEs. Skip files inside `node_modules/`, `vendor/`, `.git/`, `legacy/.archive/`, and any path already under `config.specs_path` or `config.plans_path`.

2. **Git artifacts** — local + remote branches not yet merged into the trunk (`git branch -avv`, then filter against `git log <trunk>..<branch>` non-empty); cross-reference `gh pr list --state=all --head=<branch>` to flag branches with no merged PR; named git stashes (`git stash list`).

3. **GitHub issues + PRs** — only if `gh` is authenticated. `gh issue list --state=open --limit=50 --json=number,title,body,updatedAt,labels` and `gh pr list --state=open --limit=50 --json=number,title,body,updatedAt,headRefName`. Filter to entries whose body contains a task list (`- [ ]`/`- [x]`/numbered steps) OR whose labels include planning-shaped strings (`design`, `planning`, `epic`, `roadmap`, `in-progress`).

4. **Stale superpowers state** — glob `<config.plans_path>/*.md` and find files with no sibling `-status.md`. These are pre-status-file plans from earlier superpowers versions.

### Step I2 — Rank + pick

Dedupe across scans (the same project may appear as a PLAN.md AND an issue AND a branch — match by slug similarity). Sort by `last_modified` desc, breaking ties by `confidence` desc. Surface the top 8 via `AskUserQuestion(multiSelect=true)` with one option per candidate (label = title + source_type tag, description = `last_modified` + `summary`). Include a "Show more" option if the list exceeds 8 — re-asks with the next 8. User picks 1+ to import.

### Step I3 — Convert (per candidate, sequential)

For each picked candidate:

1. **Fetch source content.**
   - Local file → `Read` it.
   - Git branch → dispatch a Sonnet subagent with the full diff vs trunk (`git diff <trunk>...<branch>`) and commit list (`git log --reverse <trunk>..<branch> --format='%h %s%n%b'`). Prompt: "Reverse-engineer the goal, scope, and intended task list from this branch's history. Output structured sections: Goal, Scope, Inferred tasks (in commit order), Open questions."
   - GH issue → `gh issue view <num> --json=body,comments,labels`. Include comment text for context.
   - GH PR → `gh pr view <num> --json=body,commits,comments,headRefName`. Treat the body as candidate spec, the commits as candidate progress, comments as notes.
   - Stale superpowers plan → `Read` it (already half-formed).

2. **Decide slug + dates.** Sanitize the candidate's title to a slug. Use today's date as the kickoff date for the new spec/plan filenames.

3. **Run completion-state inference** (see **Completion-state inference** below) over the candidate's task list. Produce a per-task classification: `done` / `possibly_done` / `not_done`, plus evidence strings.

4. **Dispatch a Sonnet conversion subagent.** Hand it: source content, inference results, target paths, and this brief:
   > Rewrite this legacy planning artifact into superpowers spec format (`<spec-path>`) and plan format (`<plan-path>`) following the writing-plans skill conventions. Drop tasks classified `done`. Move `possibly_done` tasks into a `## Verify before continuing` checklist at the top of the plan, each with its evidence. Keep `not_done` tasks as the active task list, reformatted into bite-sized steps (writing-plans style). Preserve constraints, decisions, and stakeholder context in the spec's Background section. Discard pure status narration. Do not invent tasks the source didn't mention.

5. **Generate status file** at `<config.plans_path>/<slug>-status.md` with:
   - `worktree`, `branch`, `started`, `last_activity` set to current values
   - `current_task` = first `not_done` task
   - `next_action` = its first step
   - `## Notes` seeded with: link back to source (path/URL/branch/issue#), inference evidence summary, list of `possibly_done` items the user should verify before execution

6. **Cruft handling.** Apply `config.cruft_policy` (overridden by `--archive`/`--keep-legacy` flags). If policy is `ask` (the default), present `AskUserQuestion` per candidate:
   - **Local file:** Leave + banner / Archive to `<config.archive_path>/<date>/` / Delete (irreversible).
   - **Branch:** Keep / Rename to `archive/<branch>` / Delete local ref.
   - **GH issue or PR:** Comment with link to new spec / Comment + close / Do nothing.
   - **Stale superpowers plan:** Replace with new plan / Move to `<config.archive_path>/<date>/` / Leave both.
   
   Apply the chosen action.

7. **Commit.** `git add` the new spec, plan, status file (and any banner edits or moves). Commit with: `superflow: import <slug> from <source-type>`.

### Step I4 — Hand off

After all candidates are converted, list the new status file paths. `AskUserQuestion`: "Resume one now? / All done — exit." If resume → jump to **Step C** with the chosen status path.

---

## Step D — Doctor

Triggered by `/superflow doctor [--fix]`. Lints all superflow state across all worktrees of the current repo.

### Scope

`git worktree list --porcelain` → for each worktree, scan `<worktree>/<config.specs_path>/` and `<worktree>/<config.plans_path>/`.

### Checks

For each worktree, run all checks. Report findings grouped by worktree → check → file.

| # | Check | Severity | `--fix` action |
|---|---|---|---|
| 1 | **Orphan plan** — plan file with no sibling `-status.md`. | Warning | Suggest `/superflow import --file=<path>`. No auto-fix. |
| 2 | **Orphan status** — `status.md` whose `plan` field points at a missing file. | Error | Move status to `<config.archive_path>/<date>/`. |
| 3 | **Wrong worktree path** — status's `worktree` doesn't match any current `git worktree list` entry. | Error | Try to match by branch name; rewrite if unique match. Otherwise report. |
| 4 | **Wrong branch** — status's `branch` doesn't exist in `git branch --list`. | Error | Report only (manual fix). |
| 5 | **Stale in-progress** — `status: in-progress` with `last_activity` > 30 days. | Warning | Report only. |
| 6 | **Stale blocked** — `status: blocked` with `last_activity` > 14 days. | Warning | Report only. |
| 7 | **Plan/log drift** — plan task count differs from activity-log task references by >50%. | Warning | Report only. |
| 8 | **Missing spec** — status's `spec` field points at a missing spec doc. | Error | Report only. |
| 9 | **Schema violation** — status frontmatter missing required fields (`slug`, `status`, `plan`, `worktree`, `branch`). | Error | Add missing fields with sentinel/derived values where possible; report the rest. |

### Output

Plain-text grouped report. Apply **CD-10**: order findings by severity (errors first, then warnings), each line grounded in `<worktree>:<file>` so the user can jump straight to the offender. Summary line at the end with counts: `<E> errors, <W> warnings across <N> worktrees`. If `--fix` ran, include a list of files changed/moved.

If no issues: `superflow doctor: clean (<N> worktrees, <P> plans)`.

---

## Status file format

Path: `docs/superpowers/plans/<slug>-status.md` (sibling to the plan file).

```markdown
---
slug: <feature-slug>
status: in-progress | blocked | complete
spec: docs/superpowers/specs/<slug>-design.md
plan: docs/superpowers/plans/<slug>.md
worktree: /absolute/path/to/worktree
branch: <git-branch-name>
started: 2026-05-01
last_activity: 2026-05-01T14:32:00Z
current_task: <task name from plan>
next_action: <one-line summary of what comes next>
autonomy: gated | loose | full
loop_enabled: true | false
codex_routing: off | auto | manual
codex_review: off | on
---

# <Feature Name> — Status

## Activity log
- 2026-05-01T14:00 brainstorm complete, spec at docs/superpowers/specs/<slug>-design.md
- 2026-05-01T14:15 plan written, beginning execution under autonomy=loose
- 2026-05-01T14:32 task "Add foo helper" complete, commit abc123

## Blockers
(empty unless status: blocked)

## Notes
(append-only context for the next session — decisions, scope changes, surprises a fresh agent should know)
```

This file is the single source of truth for resumption. A future agent picking up this work should be able to read this file plus the spec and plan and have everything they need — never assume conversational context carries over.

---

## Completion-state inference

Used by **Step I3** (and optionally **Step C** on resume to validate the plan against current reality). For a list of plan tasks, classify each as `done`, `possibly_done`, or `not_done` with cited evidence.

### Process

For each task in the candidate's task list:

1. **Extract keywords** — pull 2–5 distinctive tokens from the task description (function/file/symbol names, distinctive concept words). Drop stopwords and generic verbs ("add", "fix").

2. **Gather signals.** For long task lists, dispatch a Haiku subagent per chunk so this step parallelizes. For each task, check:
   - **Git log signal** — `git log --all --oneline --grep=<keyword>` and `git log --all -G<keyword> --oneline` (the latter searches diffs). Hit = signal, capture the commit SHA(s).
   - **Filesystem signal** — if the task names a file or symbol, `Glob` for the file or `Grep` for the symbol. Hit = signal.
   - **Test signal** — `Grep` for the keywords inside `test/`, `tests/`, `__tests__/`, `*.test.*`, `*.spec.*`. Hit + tests presumed passing = strong signal.
   - **Checkbox signal** — if the source had `- [x] <this task>`, that's a signal but **not sufficient alone** (people forget to check or check ahead).

3. **Classify (conservative):**
   - `done` — **2+ signals**, AND at least one is git log OR filesystem (test alone or checkbox alone is not enough).
   - `possibly_done` — exactly 1 signal, OR checkbox-only.
   - `not_done` — 0 signals.

4. **Record evidence** in the result so the conversion subagent can cite it in the new plan's `## Verify before continuing` block, and so the user can audit.

### Why conservative

Skipping a real not-done task is more harmful than re-verifying a done task. The `## Verify before continuing` block in imported plans exists precisely so the agent (or user) can quickly confirm `possibly_done` items via a glance at the cited evidence before execution begins. Defaulting to `possibly_done` when uncertain is the correct trade-off.

---

## Configuration: .superflow.yaml

### Precedence (shallow merge, top-level keys only)

1. CLI flags (highest)
2. Repo-local `<repo-root>/.superflow.yaml`
3. User-global `~/.superflow.yaml`
4. Built-in defaults (below)

Step 0 loads + merges these into a single `config` object referenced throughout this prompt. Missing files = skip that tier silently. Invalid YAML = abort with file path + parser message.

### Schema (with built-in defaults)

```yaml
# Default execution autonomy
autonomy: gated  # gated | loose | full

# Cross-session loop scheduling (Step C)
loop_enabled: true
loop_interval_seconds: 1500   # ScheduleWakeup delay between chunks
loop_max_per_day: 24          # cap to prevent runaway scheduling

# Subagent execution mode (Step C)
use_subagents: true           # false → fall back to executing-plans

# Doc paths (relative to worktree root)
specs_path: docs/superpowers/specs
plans_path: docs/superpowers/plans

# Worktree base directory for newly-created worktrees (Step B0)
worktree_base: ../            # sibling-of-repo by default

# Branch names that trigger "create new worktree" recommendation (Step B0)
trunk_branches: [main, master, trunk, dev, develop]

# Cruft handling for /superflow import (Step I3)
cruft_policy: ask             # ask | leave | archive | delete
archive_path: legacy/.archive # relative to repo root

# /superflow doctor auto-fix policy (overridden by --fix flag)
doctor_autofix: false

# Codex routing + review for Step C task execution
# (overridden by --codex= / --no-codex / --codex-review= flags)
codex:
  routing: auto              # off | auto | manual — who executes a task
  review: off                # off | on — Codex reviews diffs from inline-completed tasks
  review_diff_under_full: false  # if true, even autonomy=full pauses to show Codex output
  max_files_for_auto: 3      # eligibility heuristic threshold for `auto` routing
  review_max_fix_iterations: 2  # cap on "fix and re-review" retries before bailing

# External integration refs (NEVER secrets — secrets live in env or MCP config)
integrations:
  github:
    enabled: true             # auto-detected via gh auth status if unset
    auto_link_pr_to_plan: true
  linear:
    project: null             # e.g. INGEST; requires Linear MCP
  slack:
    blocked_channel: null     # post here when status: blocked, requires Slack MCP
```

### Adding new keys

Treat the schema as additive — new keys land in built-in defaults first, then become configurable. Unknown keys in user files are tolerated (forward-compat) but logged once at load time.

---

## Operational rules

These are command-specific rules; they complement (not replace) the **Context discipline** list above. CD-rules cover general execution behavior — these cover superflow's own state machine.

- **Re-read on resume.** Every Step C entry re-reads the spec, plan, and status from disk. Cached context is not trusted across wakeups or sessions.
- **Atomic checkpoints.** Update the status file only after a task is fully complete (tests pass, commit landed). If a wakeup fires mid-task, the next session resumes from the last clean checkpoint, which is correct.
- **One plan at a time per branch.** If `/superflow <topic>` finds another `in-progress` plan in the current worktree at Step B0, the heuristic recommends a new worktree. Don't run two plans in the same branch.
- **Worktree is recorded, not assumed.** The status file's `worktree` and `branch` fields are authoritative on resume. Always verify pwd matches before doing anything; `cd` if it doesn't, blocker if the recorded worktree is gone.
- **Cross-worktree visibility.** Step A scans every worktree of the current repo for in-progress plans, not just the current one. A plan started in `~/dev/foo-feature-wt/` shows up when you run `/superflow` from `~/dev/foo/`.
- **Stay a thin wrapper.** Logic that belongs to brainstorming, planning, execution, debugging, or branch-finishing lives in those skills. This command's job is sequencing them and persisting the status file.
- **Subagents do the work; orchestrator preserves context.** Per the **Subagent and context-control architecture** section: every substantive piece of work goes to a bounded subagent, and only digests come back. Never let raw verification output, full diffs, or library docs accumulate in the orchestrator's context. When in doubt, digest and ScheduleWakeup.
- **Bounded briefs, not implicit context.** Subagents receive Goal + Inputs + Scope + Constraints + Return shape. They do not inherit session history. If a subagent needs context from an earlier subagent's output, hand it the digest, not the raw return.
- **Stop conditions.** End the turn (no reschedule) when: plan is complete, status is blocked, user says stop in a `gated` checkpoint, or two consecutive task attempts fail under `loose`/`full`.
- **Config is loaded once per invocation.** Step 0 reads `.superflow.yaml` files and merges them. Downstream steps reference `config.X` rather than re-reading files. Treat `config` as immutable for the run.
- **Import never overwrites existing superflow state silently.** If a target spec/plan/status path already exists at Step I3, ask the user: overwrite / write to a `-v2` slug / abort. Never clobber.
- **Doctor is read-only by default.** Without `--fix` it only reports — even an obvious orphan stays in place. `--fix` only acts on errors marked auto-fixable in the checks table.
- **Inference is conservative by design.** When in doubt, classify `possibly_done`, not `done`. The cost of re-verifying is small; the cost of skipping real work is large.
- **External writes are gated.** Posting comments to GitHub issues/PRs, sending Slack messages, or closing issues during import always passes through `AskUserQuestion` first — even under `--autonomy=full`. These are blast-radius actions per the system prompt's "executing actions with care" guidance.
- **Codex routing is locked at kickoff, switchable on resume.** `codex_routing` and `codex_review` both land in the status file at Step B3 (or at first Step C invocation for imported plans without them). Mid-run flips happen by re-invoking `/superflow --resume=<path> --codex=<mode> --codex-review=<on|off>`, which rewrites the fields and continues. Per-task overrides come from plan annotations (`codex: ok` / `codex: no`), not inline edits.
- **Never delegate non-eligible tasks under `auto`.** The eligibility checklist is conservative on purpose: a wrong delegation costs more than running inline. When the heuristic is uncertain, run inline. Plan annotations are the right escape hatch when you need to override.
- **Codex review is asymmetric — never self-review.** If a task was executed by Codex and `codex_review` is on, skip the review step for that task. Codex reviewing its own output adds no signal. The post-Codex review flow in Step 3a already handles delegated work; Step 3b's review only fires after inline tasks.
