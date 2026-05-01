# /superflow small-fixes pass — design spec

**Date:** 2026-05-01
**Worktree:** `.worktrees/superflow-small-fixes/`
**Branch:** `feat/superflow-small-fixes`

## Background

A pre-implementation analysis of `/superflow` (commands/superflow.md, the three named superpowers integration points: subagent-driven-development, dispatching-parallel-agents, finishing-a-development-branch, and the supporting skills) surfaced six small-to-medium issues that share two properties: each is independently small, and each lands either in the same file (`commands/superflow.md`) or in a tightly-related sibling. Bundling them into one improvement pass minimizes orchestration overhead and lets us ship a coherent "v0.1.1" of the orchestrator without spinning up six separate spec/plan/execute cycles.

Two of the six are direct user feedback during the analysis session ("don't make me approve every Codex routing decision and review I already pre-configured"); one is a verified bug (Step 4b's SHA fallback returns HEAD); the other three are documented gaps the analysis exposed.

The pass is deliberately scoped to small fixes. Larger architectural threads — the SDD × Codex routing per-task loop boundary (#3), the 4-review pile-up under default + codex-review (#5), intra-plan task parallelism (#12) — get their own dedicated specs later.

## Goal

Ship a single coherent improvement pass to `commands/superflow.md` (and supporting docs) that fixes one verified bug, makes default `gated` autonomy quieter for pre-configured runs, eliminates duplicated verification work between Step 4a and SDD's TDD, persists the eligibility cache to disk, documents the plan-annotation schema so the eligibility cache's `annotated` branch becomes live code, and adds a Step B0 warning when "Stay" would land the user on a trunk branch SDD will refuse to start on.

## Scope

In scope (this pass):

1. **Fix Step 4b SHA fallback bug** — make task-start SHA mandatory; remove the broken fallback.
2. **Gated permissiveness defaults** — under `gated`, honor pre-configured Codex auto-routing silently; auto-accept clean and low-only Codex reviews silently. New config keys for users who want the legacy chatty behavior back.
3. **Step 4a × SDD TDD redundancy** — implementer return digest gains `tests_passed` + `commands_run`; Step 4a skips redundant test re-runs.
4. **Persist eligibility cache** — write `<slug>-eligibility-cache.json` sibling to status; invalidate on plan-mtime change.
5. **Document plan annotation schema** — define where `codex: ok` / `codex: no` go in plan task blocks; thread the convention through superflow's docs and the eligibility cache builder's brief.
6. **Step B0 worktree warning** — when current branch is in `config.trunk_branches`, the "Stay" option's description includes an SDD-refuses-trunk warning.

Out of scope (deferred to dedicated specs):

- SDD × Codex routing per-task loop boundary (#3 from the analysis).
- 4-review pile-up under default + codex-review (#5).
- `dispatching-parallel-agents` skill integration (#8) — documentation-only, low value.
- `finishing-a-development-branch` mandatorily interactive under `--autonomy=full` (#10).
- Telemetry per-task model usage (#11) — small but isolated; separate hook + telemetry-doc change.
- Intra-plan task parallelism (#12) — XL effort, deserves its own deep spec.
- New `/superflow abort=<slug>` subcommand (advisor-flagged as low-priority).
- Restructuring status `## Notes` (advisor de-emphasized).

## Design

### 1. Step 4b SHA fallback fix

**Problem statement:** `commands/superflow.md:371` — Step 4b falls back to `git merge-base HEAD <branch-of-status>` when the implementer doesn't return a task-start SHA. Step C step 1 enforces `current branch == status.branch` (`commands/superflow.md:296`), so this becomes `git merge-base HEAD <same-branch>`, which equals HEAD. Verified: `git merge-base HEAD master` returns the HEAD SHA when on master tip. Codex review then receives an empty diff range and produces a meaningless review.

**Approach:** Make task-start SHA a required field in the implementer's return digest. Remove the fallback entirely. If the implementer fails to return one, treat as a protocol violation: surface a one-line blocker, set `status: blocked`, do not proceed to Step 4b. (The blocker is recoverable — user re-dispatches the implementer with a corrected brief.)

**Why no fallback:** Every fallback we considered has a worse failure mode than "block and ask." `git merge-base HEAD origin/<trunk>` requires a remote ref that may not exist locally. `HEAD~1` is wrong for multi-commit and zero-commit tasks. Walking `config.trunk_branches` adds complexity for a path that should never trigger.

**Affected files:**
- `commands/superflow.md` — Step 4b text (line ~371) drops the fallback; the architecture-section row for "Step C (per-task implementation)" return shape gains `task_start_sha` as required.
- `commands/superflow.md` — operational rules note the protocol-violation handling.

### 2. Gated permissiveness defaults

**Problem statement:** Under default `--autonomy=gated`, two over-prompts:
- Step C step 3 (`commands/superflow.md:307`) — when `codex_routing == auto`, the per-task question expands to four options including a Codex override. Asks every task even when the user pre-configured auto-routing.
- Step 4b decision matrix (`commands/superflow.md:392`) — every Codex review prompts regardless of severity. Clean and low-only reviews shouldn't gate.

**Approach:** Change the `gated` defaults so they honor pre-configured automation:

- **Step C step 3** — under `gated`, ask only the simple `(continue / skip / stop)` question. The Codex routing decision (when `auto`) executes silently per the eligibility cache. Add `codex.confirm_auto_routing: false` config (default `false`) — when `true`, restore the expanded four-option question.
- **Step 4b** — under `gated`, auto-accept reviews silently when severity is `clean` or `low-only`. Only prompt at `medium+`. Add `codex.review_prompt_at: "medium"` config (default `"medium"`, options `"low" | "medium" | "high" | "never"`).
- Activity log still tags every routing/review decision so the user sees what happened post-hoc, just doesn't gate on it.

**Backward compatibility:** This changes default behavior. Document as a behavior change in CHANGELOG `[Unreleased]`. Users who want the old chatty behavior set `codex.confirm_auto_routing: true` and `codex.review_prompt_at: "low"`.

**Affected files:**
- `commands/superflow.md` — Step C step 3 text, Step 4b decision matrix (gated case only), Configuration schema.
- `README.md` — config docs, useful flag combinations table updated to reflect new gated semantics.
- `CHANGELOG.md` — Changed: gated mode no longer prompts on pre-configured automation by default.

### 3. Step 4a × SDD TDD redundancy

**Problem statement:** SDD's implementer subagent runs project tests as part of TDD (`subagent-driven-development/SKILL.md:43-58`). Step 4a (`commands/superflow.md:349`) then runs verification commands again, capturing output. Either redundant (re-runs the same commands, burning tokens) or independent (then SDD's report is ignored, undermining its TDD discipline).

**Approach:** Extend the implementer subagent's return digest contract:
- `tests_passed: bool` — whether the implementer's TDD run completed cleanly.
- `commands_run: [str]` — list of verification commands the implementer executed (test harness, linter, etc.).

Step 4a logic becomes:
- If `tests_passed == true` and the task's verification commands are all in `commands_run`: skip 4a entirely. Activity log records "verified by implementer."
- If `tests_passed == true` but additional verification commands are configured (lint, typecheck not run by implementer): run only those. Activity log records "verified by orchestrator (complementary)."
- If `tests_passed == false`: run 4a as today (full verification), or treat as blocker per autonomy policy.

**Why this matters:** On a 30-task plan, 4a re-runs are 30 × test-suite-time of duplicated work. For long-running test suites (build + test = minutes) this is significant. Also reduces noise in CC-2's "noisy verification" detection — fewer duplicate noisy commands tripped.

**Affected files:**
- `commands/superflow.md` — Step 4a text, implementer-subagent return-shape row in the architecture section.
- `commands/superflow.md` — operational rule documenting the implementer-trust contract.

### 4. Persist eligibility cache

**Problem statement:** Step C step 1 (`commands/superflow.md:298`) builds `eligibility_cache` via Haiku dispatch on every Step C entry. Operational rules (`:770`) say "never persisted to disk." But the cache is a pure function of plan-file content. For a 30-task plan running under `loose` with wakeup-every-3-tasks (~10 wakeups), that's ~10 redundant Haiku dispatches across the run.

**Approach:** Persist cache to `<slug>-eligibility-cache.json` (sibling to the status file, per the JSONL/archive sibling convention). On Step C step 1:

1. If `codex_routing == off`: skip cache (current behavior).
2. Else: stat both the plan file and the cache file.
   - If cache file missing → dispatch Haiku, write cache, proceed.
   - If `cache.mtime > plan.mtime` → load cache from disk, skip Haiku.
   - If `plan.mtime >= cache.mtime` → dispatch Haiku, overwrite cache.
3. Step 4d invalidation: when Step 4d edits the plan inline, also `touch` the plan file so mtime invariant holds.

Cache file format: JSON, `{plan_path, plan_mtime_at_compute, generated_at, tasks: [{idx, name, eligible, reason, annotated}]}`.

**Doctor support:** Add check #14 — orphan eligibility-cache file (cache exists with no sibling `<slug>-status.md`). Warning severity. `--fix` action: suggest moving to `<config.archive_path>/<date>/`.

**Affected files:**
- `commands/superflow.md` — Step C step 1 text (cache load logic), operational rules (drop "never persisted to disk"), doctor checks table (new check #14), schema-violation check #9 widened? — no, eligibility cache is sidecar, not status frontmatter.
- `CHANGELOG.md` — Added: eligibility cache persists across wakeups.

### 5. Plan annotation schema documentation

**Problem statement:** `commands/superflow.md:325-327` references plan annotations `codex: ok` / `codex: no`, and the eligibility cache stores `annotated: "ok" | "no" | null`. But there's no documented location for the annotation in plan task blocks. `superpowers:writing-plans` doesn't mention them. Today the `annotated` branch is dead code — the cache builder has nothing to parse.

**Approach:** Define annotation location as a `**Codex:**` line in the per-task `**Files:**` block. Concrete example:

```markdown
### Task 3: Add memory adapter

**Files:**
- Create: `src/memory/adapter.py`
- Test: `tests/memory/test_adapter.py`

**Codex:** ok    # eligible for Codex auto-delegation under codex_routing=auto

- [ ] Step 1: Write the failing test
...
```

Or:

```markdown
**Codex:** no    # never delegate; requires understanding of the storage layer
```

**Eligibility cache builder's brief** (in Step C step 1) gains: "When the task block contains a `**Codex:** ok` line, set `annotated: 'ok'`. When it contains `**Codex:** no`, set `annotated: 'no'`. Otherwise `null`."

**Update points:**
- `commands/superflow.md` — Step C 3a's plan-annotations subsection shows the concrete syntax with example.
- `README.md` — new "Plan annotations" subsection under Configuration.
- `commands/superflow.md` — Step C step 1's eligibility-cache builder brief mentions the annotation syntax.

**Note on writing-plans skill:** We can't modify the upstream `superpowers:writing-plans` skill from this repo. Instead, superflow can pass a brief to writing-plans (in Step B2) noting "if you judge a task obviously suited or unsuited for Codex, add `**Codex:** ok` or `**Codex:** no` after the **Files:** block." That brief lives in `commands/superflow.md` Step B2.

**Affected files:**
- `commands/superflow.md` — Step C 3a (annotation subsection), Step C step 1 (cache builder brief), Step B2 (writing-plans brief).
- `README.md` — new "Plan annotations" subsection.

### 6. Step B0 worktree warning when "Stay" lands on trunk

**Problem statement:** `subagent-driven-development/SKILL.md:267-271` lists `using-git-worktrees` as REQUIRED and refuses to start on main/master without explicit consent. Step B0 (`commands/superflow.md:230`) presents "Stay in current worktree" as a valid option even when the current branch is in `config.trunk_branches`. If the user picks Stay on trunk, SDD halts/warns at Step C — surprise gate after the worktree decision was supposedly settled.

**Approach:** Step B0 step 3, when constructing the AskUserQuestion options, if current branch is in `config.trunk_branches`, the "Stay in current worktree" option's description gains: "(SDD will refuse to start on this branch — choose Create new if you'll execute via subagents.)"

When current branch is non-trunk, no warning shown (no surprise to warn about).

**Affected files:**
- `commands/superflow.md` — Step B0 step 3 text.

---

## Acceptance criteria (for the pass as a whole)

1. `commands/superflow.md` Step 4b text drops the broken `git merge-base HEAD <branch-of-status>` fallback; the implementer return-shape contract requires `task_start_sha`.
2. Under `--autonomy=gated --codex=auto`, no per-task routing prompts unless `codex.confirm_auto_routing: true` is set.
3. Under `--autonomy=gated --codex-review=on`, no review prompts when severity is `clean` or `low-only`.
4. Implementer subagent return digest documented to include `tests_passed` and `commands_run`. Step 4a spec describes the skip-redundant logic.
5. `<slug>-eligibility-cache.json` is written to disk after first compute, loaded on subsequent Step C entries when fresh, and invalidated on plan-mtime change. Doctor check #14 catches orphans.
6. Plan annotation `**Codex:** ok|no` is documented in `commands/superflow.md` and `README.md`. Step C step 1's eligibility cache builder brief includes annotation parsing.
7. Step B0's "Stay in current worktree" option includes the SDD-trunk-warning description when current branch is in `config.trunk_branches`.
8. CHANGELOG `[Unreleased]` entries updated under Added / Changed / Fixed for each scoped change.
9. README's flag-combinations table reflects the new gated semantics.
10. No regression in existing parallel dispatch sites, status file format, or doctor checks #1–#13.

## Risks / edge cases

- **Behavior change in #2 is user-visible.** Some users might rely on the old chatty gated behavior. CHANGELOG entry must call this out clearly. The opt-back-in path (`codex.confirm_auto_routing: true`, `codex.review_prompt_at: "low"`) is documented in the README.
- **#4 (eligibility cache persistence) interacts with #5 (annotations).** When annotations are added/removed in a plan, the cache invalidates via mtime. No special handling needed.
- **#3 (Step 4a redundancy fix) requires the implementer return-shape extension.** Existing implementer subagents (in SDD) don't return `tests_passed`/`commands_run` today. Two implementations options:
  - (a) Brief the implementer subagent at dispatch time (in Step C step 2) to include these fields. Doesn't require modifying SDD itself.
  - (b) Modify SDD's `implementer-prompt.md` to always return them. Cleaner but cross-repo.
  - **Recommended: (a).** Superflow already passes a CD-1/2/3/6 brief; extending it with the return-shape contract is consistent with the bounded-brief pattern.
- **#5 (plan annotation docs) doesn't change writing-plans skill.** We can't push annotation guidance upstream. Plans will gain annotations only when written via superflow's Step B2 (which now passes the brief). Pre-existing plans without annotations behave exactly as today (`annotated: null`, fall through to heuristic).
- **Test coverage:** This repo has no test suite (markdown + one shell hook). Verification will be: re-read the modified prompt, grep for the changed strings, run `bash -n hooks/superflow-telemetry.sh` after any hook touch, and a manual end-to-end mental trace of one /superflow invocation through the changed paths. Document this verification approach in the plan's tasks.

## Out-of-scope reminders (so they don't bleed in during execution)

- Don't modify SDD's `implementer-prompt.md` directly. Brief from superflow.
- Don't refactor unrelated sections of `commands/superflow.md`. Bug fixes + targeted changes only.
- Don't add new doctor checks beyond #14.
- Don't change the status frontmatter schema (no new required fields).
- Don't touch the autonomy modes (`gated`/`loose`/`full`) themselves — only their per-mode behavior on Codex routing/review prompts under `gated`.

## Verification plan

1. **String-grep verification:** for each changed section, grep for the specific old text and confirm it's gone; grep for the specific new text and confirm it's present.
2. **Mental end-to-end trace:** walk through one /superflow invocation under `--autonomy=gated --codex=auto --codex-review=on` and confirm no per-task routing prompts and no clean/low-only review prompts.
3. **Bash syntax check:** `bash -n hooks/superflow-telemetry.sh` if hook is touched (this pass doesn't touch it, but include the check as a safety net).
4. **Cross-reference check:** every config key added is documented in (a) the YAML schema in `commands/superflow.md`, (b) the README config section. Every flag-combinations table entry in the README is internally consistent with the new semantics.
5. **CHANGELOG sanity:** every change has a `[Unreleased]` entry under the right heading (Added / Changed / Fixed).
