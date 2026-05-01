# /superflow Small-Fixes Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship six bundled improvements to `commands/superflow.md` (and supporting docs) per `docs/superpowers/specs/2026-05-01-superflow-small-fixes-design.md`.

**Architecture:** Targeted prompt/text edits inside `commands/superflow.md` plus parallel updates to `README.md` and `CHANGELOG.md`. Each task fixes one finding, ends with a CHANGELOG entry under the right heading, and commits. The final task is a cross-cutting verification pass.

**Tech Stack:** Markdown editing (Edit + Write tools), bash for verification (`grep`, `bash -n`), git for commits. No test runner — this is a Claude Code plugin (markdown commands + skills + one shell hook).

**Verification convention** (used in every task — read this once, then later steps reference it as "verify-grep"):

> After each Edit, run two greps to confirm the change landed:
> 1. `grep -nF '<unique substring of old_string>' <file>` → expect 0 matches.
> 2. `grep -nF '<unique substring of new_string>' <file>` → expect ≥ 1 match.
>
> Pick substrings short enough to be stable, long enough to be unique to that change. Don't grep for words like "task" or "Codex" alone — they appear hundreds of times. Use 6–10-word phrases unique to the edit.

**Spec reference:** `docs/superpowers/specs/2026-05-01-superflow-small-fixes-design.md` — re-read the relevant section at the start of each task. Sections in the spec map 1:1 to tasks below.

---

## Files modified by task

| Task | `commands/superflow.md` | `README.md` | `CHANGELOG.md` | Other |
|---|---|---|---|---|
| 1. SHA fallback fix | Step 4b (~371), arch row (~117), op rules (~755) | — | Fixed | — |
| 2. Step 4a × SDD TDD | Step 4a (~349), arch row (~117), op rules | — | Changed | — |
| 3. Eligibility cache to disk | Step C step 1 (~298), op rule (~770), doctor table (~588) | — | Added | — |
| 4. Plan annotation docs | Step C 3a (~325), Step C 1 builder brief (~298), Step B2 (~248) | new "Plan annotations" subsection | Added | — |
| 5. Gated permissiveness | Step C 3 (~307), Step 4b decision matrix (~392), config schema (~715) | config + flag-combinations table | Changed | — |
| 6. Step B0 trunk warning | Step B0 step 3 (~230) | — | Changed | — |
| 7. Cross-cutting verification | — | — | (final sanity entry) | — |

Each task is independent in scope. Lines shift as edits land — the line numbers above are pre-edit reference points; later tasks should re-read the file to confirm sections before editing.

---

## Task 1: Fix Step 4b SHA fallback bug; require task_start_sha

**Files:**
- Modify: `commands/superflow.md` — Step 4b process step 1 (~line 371), Subagent dispatch model row for "Step C (per-task implementation)" (~line 117), Operational rules section (~line 755)
- Modify: `CHANGELOG.md` — `[Unreleased]` Fixed section

**Codex:** ok    # well-bounded textual edit + grep verification, no design judgment

- [ ] **Step 1: Re-read spec section 1**

Read `docs/superpowers/specs/2026-05-01-superflow-small-fixes-design.md` lines covering "1. Step 4b SHA fallback fix" to refresh the approach in mind. Concrete change: replace the broken fallback with a protocol-violation blocker; require `task_start_sha` in the implementer's return digest.

- [ ] **Step 2: Replace Step 4b process step 1 fallback text**

In `commands/superflow.md`, find the line starting with "1. Compute the task's diff against the **task-start commit SHA**" (currently around line 371). Replace this text:

```
   1. Compute the task's diff against the **task-start commit SHA** captured by the implementer at task start (passed back as part of its return digest). If the implementer didn't record one, fall back to `git merge-base HEAD <branch-of-status>` — but `HEAD~1` is wrong for multi-commit or zero-commit tasks and must NOT be used. If zero commits were made (task aborted before commit), there is no diff to review; skip 4b and let 4a's verification result drive the autonomy policy.
```

With:

```
   1. Compute the task's diff against the **task-start commit SHA** captured by the implementer at task start (passed back as part of its return digest, where it is a **required** field — see the Subagent dispatch model table). If the implementer omitted it, treat as a protocol violation: surface a one-line blocker via `AskUserQuestion` ("Implementer subagent did not return `task_start_sha`. Re-dispatch with corrected brief / Skip 4b for this task / Abort"), and do NOT silently fall back to a SHA range — every fallback considered (`HEAD~1`, `git merge-base HEAD <status.branch>`, `git merge-base HEAD origin/<trunk>`) has a worse failure mode than blocking. If zero commits were made (task aborted before commit), there is no diff to review; skip 4b and let 4a's verification result drive the autonomy policy.
```

- [ ] **Step 3: Verify Step 4b edit**

Run:
```
grep -nF "fall back to \`git merge-base HEAD <branch-of-status>\`" commands/superflow.md
```
Expected: 0 matches (the broken fallback is gone).

Run:
```
grep -nF "treat as a protocol violation: surface a one-line blocker" commands/superflow.md
```
Expected: 1 match in Step 4b.

- [ ] **Step 4: Update Subagent dispatch model row**

In `commands/superflow.md`, find the table row starting "| Step C (per-task implementation) |" (currently around line 117). Replace this text:

```
| Step C (per-task implementation) | implementer subagents via `superpowers:subagent-driven-development` | Sonnet (default) | plan path + current task index + CD-1/2/3/6 brief + relevant spec excerpts | done/blocked + 1–3 lines of evidence + task-start commit SHA |
```

With:

```
| Step C (per-task implementation) | implementer subagents via `superpowers:subagent-driven-development` | Sonnet (default) | plan path + current task index + CD-1/2/3/6 brief + relevant spec excerpts | done/blocked + 1–3 lines of evidence + **`task_start_sha` (required)** + `tests_passed: bool` + `commands_run: [str]` (Step 4a consumes the latter two; see Task 2) |
```

- [ ] **Step 5: Verify dispatch row edit**

Run:
```
grep -nF "**\`task_start_sha\` (required)**" commands/superflow.md
```
Expected: 1 match in the table.

- [ ] **Step 6: Add operational rule for the implementer-return contract**

In `commands/superflow.md`, find the operational rules bullet "**Codex review is asymmetric — never self-review.**" (around line 769). Insert a new bullet immediately AFTER it (before "**Eligibility cache is per-invocation only..."):

```
- **Implementer must return `task_start_sha` (required).** Step C step 2's brief to the implementer subagent (whether dispatched directly or transitively via `superpowers:subagent-driven-development`) must include: "Capture `git rev-parse HEAD` BEFORE any work; return it as `task_start_sha` in your final report. This is required, not optional — the orchestrator's Step 4b (Codex review) and Step 4c (worktree integrity) both depend on it." If the implementer omits it, Step 4b blocks (see Step 4b process step 1).
```

- [ ] **Step 7: Verify operational rule edit**

Run:
```
grep -nF "**Implementer must return \`task_start_sha\` (required).**" commands/superflow.md
```
Expected: 1 match in the operational rules section.

- [ ] **Step 8: Update CHANGELOG.md**

In `CHANGELOG.md`, find the `[Unreleased]` section. Find the `### Fixed` heading (the most recent one — `[Unreleased]` may have multiple). Add this bullet at the top of that Fixed list:

```
- **Step 4b SHA fallback was a no-op.** When the implementer didn't return `task_start_sha`, Step 4b fell back to `git merge-base HEAD <branch-of-status>`. Since Step C step 1 enforces `current branch == status.branch`, that's `git merge-base HEAD HEAD` = HEAD, giving Codex review an empty diff range. `task_start_sha` is now required in the implementer's return digest; Step 4b blocks with a recoverable AskUserQuestion if it's missing. New operational rule documents the implementer-return contract; subagent dispatch model row in the architecture section calls out `task_start_sha` as required.
```

- [ ] **Step 9: Commit**

```bash
git add commands/superflow.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
superflow: fix Step 4b SHA fallback bug; require task_start_sha

Step 4b's `git merge-base HEAD <branch-of-status>` fallback was
effectively `git merge-base HEAD HEAD` = HEAD (Step C step 1 enforces
current branch == status.branch), giving Codex review an empty diff
range. Make task_start_sha required in implementer return; block with
AskUserQuestion when missing instead of silently falling back.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Step 4a × SDD TDD redundancy fix

**Files:**
- Modify: `commands/superflow.md` — Step 4a text (~line 349), Subagent dispatch model row for "Step C (per-task implementation)" (already extended in Task 1, just verify), Operational rules
- Modify: `CHANGELOG.md` — `[Unreleased]` Changed section

**Codex:** ok    # bounded text edit + grep verification

- [ ] **Step 1: Re-read spec section 3**

Read spec section "3. Step 4a × SDD TDD redundancy". Approach: implementer return digest already gains `tests_passed` + `commands_run` from Task 1's dispatch-row edit. Step 4a now consumes those fields to skip redundant test re-runs.

- [ ] **Step 2: Replace Step 4a text**

In `commands/superflow.md`, find the block starting "**4a — CD-3 verification.**" (around line 349). Replace this text (the first paragraph plus the parallelize-independent-verifiers paragraph):

```
   **4a — CD-3 verification.** Run the task's verification commands (per CD-1) and capture output. Don't claim done without evidence. Capture for use by 4b.

   **Parallelize independent verifiers.** Lint, typecheck, and unit-test commands typically don't share mutable state and should be issued as one parallel Bash batch. Run them sequentially when commands write to the same shared artifacts:
```

With:

```
   **4a — CD-3 verification.** Run the task's verification commands (per CD-1) and capture output for 4b. Trust-but-verify the implementer: read `tests_passed` and `commands_run` from the implementer's return digest (required fields per the dispatch model table) and skip what the implementer already ran cleanly.

   **Decision logic:**
   - If `tests_passed == true` AND every verification command in the plan task is already in `commands_run`: skip 4a's command execution entirely. Activity log entry records `(verify: trusted implementer; <N> commands)`. 4b still consumes the implementer's captured output.
   - If `tests_passed == true` AND the plan task lists additional verification commands the implementer didn't run (lint, typecheck, etc.): run only the *complementary* commands. Activity log records `(verify: trusted implementer for tests + ran <complement>)`.
   - If `tests_passed == false` OR `tests_passed` is missing: run the full verification per CD-1. Activity log records `(verify: full re-run)`. If the implementer claimed done but tests fail on re-run, treat as a protocol violation (block per autonomy policy).

   **Why:** SDD's implementer subagent runs project tests as part of TDD discipline. Re-running them in 4a duplicates token cost and CI time without adding signal. The trust contract is verified by the protocol-violation rule above.

   **Parallelize independent verifiers** (when 4a does run commands). Lint, typecheck, and unit-test commands typically don't share mutable state and should be issued as one parallel Bash batch. Run them sequentially when commands write to the same shared artifacts:
```

- [ ] **Step 3: Verify Step 4a edit**

Run:
```
grep -nF "Trust-but-verify the implementer: read \`tests_passed\`" commands/superflow.md
```
Expected: 1 match in Step 4a.

Run:
```
grep -nF "(verify: trusted implementer; <N> commands)" commands/superflow.md
```
Expected: 1 match in Step 4a's decision logic.

- [ ] **Step 4: Verify Task 1's dispatch-row edit covers 4a's needs**

Run:
```
grep -nF "tests_passed: bool\` + \`commands_run: [str]\`" commands/superflow.md
```
Expected: 1 match in the Subagent dispatch model table (set up by Task 1 step 4). If 0 matches, Task 1 step 4 was skipped or reverted — fix before continuing.

- [ ] **Step 5: Add operational rule for the trust contract**

In `commands/superflow.md`, find the operational rule "**Implementer must return `task_start_sha` (required).**" added by Task 1. Insert a new bullet immediately AFTER it:

```
- **Implementer-return trust contract.** When the implementer subagent reports `tests_passed: true` and lists `commands_run`, Step 4a trusts the report and skips redundant verification (see Step 4a decision logic). This makes SDD's TDD discipline first-class rather than duplicated work. The contract is enforced by the protocol-violation rule: if the implementer reports `tests_passed: true` but a Step 4a complementary check or a Step 4b Codex review surfaces a test failure, the activity log records the discrepancy and Step C 4d notes it under `## Notes` for human attention.
```

- [ ] **Step 6: Verify operational rule edit**

Run:
```
grep -nF "**Implementer-return trust contract.**" commands/superflow.md
```
Expected: 1 match.

- [ ] **Step 7: Update CHANGELOG.md**

In `CHANGELOG.md`, in the `[Unreleased]` section's `### Changed` heading, add this bullet at the top:

```
- **Step 4a no longer re-runs implementer's tests.** SDD's implementer subagent runs project tests as part of TDD; previously Step 4a ran them again, duplicating token cost and CI time. Implementer return digest now includes `tests_passed: bool` and `commands_run: [str]` (required fields per the dispatch model table); Step 4a skips commands the implementer already ran cleanly and only runs *complementary* checks (lint, typecheck) the implementer didn't. New operational rule documents the trust contract and the protocol-violation handling for false-positive `tests_passed: true`.
```

- [ ] **Step 8: Commit**

```bash
git add commands/superflow.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
superflow: Step 4a trusts implementer's TDD report

Implementer return digest gains tests_passed + commands_run; Step 4a
skips redundant test re-runs when the implementer already ran them.
New operational rule documents the trust contract and false-positive
handling.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Persist eligibility cache to disk

**Files:**
- Modify: `commands/superflow.md` — Step C step 1 "Build eligibility cache" paragraph (~line 298), operational rule "Eligibility cache is per-invocation only..." (~line 770), Doctor checks table (~line 588 — adds check #14)
- Modify: `CHANGELOG.md` — `[Unreleased]` Added section

**Codex:** ok    # bounded text edit; cache file format defined in spec

- [ ] **Step 1: Re-read spec section 4**

Read spec section "4. Persist eligibility cache". Approach: persist to `<slug>-eligibility-cache.json` sibling to status; load on Step C step 1 entry; invalidate on plan-mtime change. Add doctor check #14 for orphans.

- [ ] **Step 2: Replace Step C step 1 eligibility cache paragraph**

In `commands/superflow.md`, find the paragraph starting "**Build eligibility cache.**" (around line 298). Replace this text:

```
   **Build eligibility cache.** When `codex_routing` is `auto` or `manual`, dispatch one Haiku to compute Codex eligibility for every task in the plan (see Step C 3a's checklist for the criteria). Bounded brief: Goal=apply the checklist to each task and emit `{task_idx → {eligible: bool, reason: str, annotated: "ok"|"no"|null}}`, Inputs=full plan task list + plan annotations, Scope=read-only, Return=JSON only — no narration. Cache this in orchestrator memory as `eligibility_cache`. Invalidate (re-dispatch) on the next Step C entry if the plan file's mtime has changed, or if Step 4d edits the plan inline. Never persist to disk. Skip this step entirely when `codex_routing == off`.
```

With:

```
   **Build eligibility cache.** When `codex_routing` is `auto` or `manual`, the cache lives at `<slug>-eligibility-cache.json` (sibling to status, follows the `<slug>-*` sidecar convention). Decision tree for cache load:

   - **Skip entirely** when `codex_routing == off`.
   - **Cache file missing** → dispatch one Haiku (see brief below); write `<slug>-eligibility-cache.json`; load into orchestrator memory as `eligibility_cache`.
   - **Cache file present, `cache.mtime > plan.mtime`** → load JSON from disk into `eligibility_cache`; skip Haiku dispatch.
   - **Cache file present, `plan.mtime >= cache.mtime`** → dispatch Haiku, overwrite cache file, load result.
   - When Step 4d edits the plan inline, also `touch` the plan file so the mtime invariant holds for the next Step C entry's cache check.

   **Cache file shape** (JSON):
   ```json
   {
     "plan_path": "docs/superpowers/plans/<slug>.md",
     "plan_mtime_at_compute": "2026-05-01T14:32:00Z",
     "generated_at": "2026-05-01T14:32:01Z",
     "tasks": [
       {"idx": 1, "name": "...", "eligible": true,  "reason": "...", "annotated": null},
       {"idx": 2, "name": "...", "eligible": false, "reason": "...", "annotated": "no"}
     ]
   }
   ```

   **Bounded brief for the Haiku** (when dispatched): Goal=apply the Step C 3a checklist to each task and emit `{task_idx → {eligible: bool, reason: str, annotated: "ok"|"no"|null}}`. Inputs=full plan task list + plan annotations (per the `**Codex:**` syntax — see Step C 3a). Scope=read-only. Return=JSON only — no narration.

   **Why persist:** the cache is a pure function of plan-file content. Recomputing on every wakeup (~10 wakeups for a 30-task plan under `loose`) burns Haiku calls for no signal change. Disk persistence with mtime invalidation costs one stat per Step C entry.
```

- [ ] **Step 3: Verify Step C step 1 cache edit**

Run:
```
grep -nF "**Cache file missing**" commands/superflow.md
```
Expected: 1 match in Step C step 1.

Run:
```
grep -nF "Never persist to disk" commands/superflow.md
```
Expected: 0 matches (the old "never persist" claim is gone).

- [ ] **Step 4: Update operational rule "Eligibility cache..."**

In `commands/superflow.md`, find the operational rules bullet starting "**Eligibility cache is per-invocation only; never persisted to disk.**" (around line 770). Replace this entire bullet:

```
- **Eligibility cache is per-invocation only; never persisted to disk.** Step C step 1 builds `eligibility_cache`. Re-dispatch on plan-file mtime change, or after Step 4d edits the plan inline. Keeps per-task routing O(1) lookups instead of LLM-shaped reasoning.
```

With:

```
- **Eligibility cache persists to `<slug>-eligibility-cache.json`.** Step C step 1 loads from disk when `cache.mtime > plan.mtime`; dispatches Haiku otherwise. Step 4d's plan edits `touch` the plan file to invalidate. Per-task routing stays O(1) at lookup; the Haiku dispatch happens once per plan-file change, not per Step C entry. Doctor check #14 flags orphan caches.
```

- [ ] **Step 5: Verify operational rule edit**

Run:
```
grep -nF "Never persisted to disk" commands/superflow.md
```
Expected: 0 matches.

Run:
```
grep -nF "**Eligibility cache persists to" commands/superflow.md
```
Expected: 1 match.

- [ ] **Step 6: Add Doctor check #14 row**

In `commands/superflow.md`, find the doctor checks table. The last row is currently #13 ("Orphan telemetry file..."). Add this new row immediately after the #13 row (before the table-closing blank line):

```
| 14 | **Orphan eligibility cache** — `<slug>-eligibility-cache.json` exists with no sibling `<slug>-status.md`. (The cache is a sidecar of an active plan; it must always have a base status file.) | Warning | Suggest moving to `<config.archive_path>/<date>/`. No auto-fix. |
```

- [ ] **Step 7: Verify Doctor check edit**

Run:
```
grep -nF "**Orphan eligibility cache**" commands/superflow.md
```
Expected: 1 match in the doctor checks table.

- [ ] **Step 8: Update CHANGELOG.md**

In `CHANGELOG.md`, in the `[Unreleased]` section's `### Added` heading, add this bullet near the top (after existing CC-1/CC-2 entries to keep chronological-ish order):

```
- **Eligibility cache persists across wakeups.** Previously rebuilt every Step C entry via Haiku dispatch (~10 redundant calls per long run). Now written to `<slug>-eligibility-cache.json` (sibling to status), loaded on subsequent entries when `cache.mtime > plan.mtime`. Plan edits via Step 4d `touch` the plan to invalidate. New doctor check #14 catches orphan cache files. Operational rule updated; "never persisted to disk" claim retired.
```

- [ ] **Step 9: Commit**

```bash
git add commands/superflow.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
superflow: persist eligibility cache to disk across wakeups

Cache lives at <slug>-eligibility-cache.json sibling to status; loaded
when cache.mtime > plan.mtime, dispatched only on plan-file change.
Eliminates ~10 redundant Haiku dispatches per long run. Doctor check
#14 catches orphan cache files. Operational rule updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Document plan annotation schema (`**Codex:** ok|no`)

**Files:**
- Modify: `commands/superflow.md` — Step C 3a Plan annotations subsection (~line 325), Step C step 1 cache builder brief (extended in Task 3 — verify), Step B2 brief (~line 248)
- Modify: `README.md` — add new "Plan annotations" subsection after the Configuration section
- Modify: `CHANGELOG.md` — `[Unreleased]` Added section

**Codex:** ok    # documentation + minor logic linkage

- [ ] **Step 1: Re-read spec section 5**

Read spec section "5. Plan annotation schema documentation". Approach: define annotation as `**Codex:** ok|no` line in per-task `**Files:**` block; document with example; thread through the cache builder brief and the writing-plans brief in Step B2.

- [ ] **Step 2: Replace Step C 3a "Plan annotations" subsection**

In `commands/superflow.md`, find the block starting "**Plan annotations** (override the heuristic when present, recorded in cache as `annotated: \"ok\"|\"no\"`):" (around line 325). Replace this entire block:

```
    **Plan annotations** (override the heuristic when present, recorded in cache as `annotated: "ok"|"no"`):
    - `codex: ok` in the task metadata → delegate (`eligible: true`, `annotated: "ok"`).
    - `codex: no` → never delegate; run inline (`eligible: false`, `annotated: "no"`).
```

With:

```
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
```

- [ ] **Step 3: Verify Step C 3a annotation edit**

Run:
```
grep -nF "Annotations live as a \`**Codex:**\` line in the per-task" commands/superflow.md
```
Expected: 1 match in Step C 3a.

- [ ] **Step 4: Update Step B2 brief to mention annotations**

In `commands/superflow.md`, find the block starting "### Step B2 — Plan" (around line 246). Replace this text:

```
After brainstorming returns, invoke `superpowers:writing-plans` against the spec. It will produce `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. Brief plan-writing with **CD-1 + CD-6**.
```

With:

```
After brainstorming returns, invoke `superpowers:writing-plans` against the spec. It will produce `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`. Brief plan-writing with **CD-1 + CD-6**, plus this annotation guidance:

> When you judge a task as obviously well-suited for Codex (≤ 3 files, unambiguous, has known verification commands, no design judgment) or obviously unsuited (requires understanding broader system context, design tradeoffs, or files outside the stated scope), add a `**Codex:** ok` or `**Codex:** no` line in the per-task `**Files:**` block. See the Plan annotations subsection in Step C 3a for the exact syntax. The orchestrator's eligibility cache parses these as overrides on the heuristic checklist.

Plans without annotations behave exactly as before (heuristic-only). Annotations are an authoring aid; they're never required.
```

- [ ] **Step 5: Verify Step B2 edit**

Run:
```
grep -nF "When you judge a task as obviously well-suited for Codex" commands/superflow.md
```
Expected: 1 match in Step B2.

- [ ] **Step 6: Verify Task 3's cache-builder brief mentions annotations**

Run:
```
grep -nF "plan annotations (per the \`**Codex:**\` syntax — see Step C 3a)" commands/superflow.md
```
Expected: 1 match in Step C step 1's eligibility-cache paragraph (set up by Task 3 step 2). If 0 matches, Task 3 step 2 was skipped — verify and rewrite.

- [ ] **Step 7: Add "Plan annotations" subsection to README.md**

Read `README.md`. Find the line "## Status file (the source of truth)" (around line 305). Insert a new section IMMEDIATELY BEFORE that line:

```markdown
## Plan annotations

Tasks in `/superflow`-generated plans can carry an optional `**Codex:**` annotation that overrides the eligibility heuristic for Codex routing:

```markdown
### Task 3: Add memory adapter

**Files:**
- Create: `src/memory/adapter.py`
- Test: `tests/memory/test_adapter.py`

**Codex:** ok    # eligible for Codex auto-delegation under codex_routing=auto
```

| Annotation | Effect on eligibility cache |
|---|---|
| `**Codex:** ok` | `eligible: true`, `annotated: "ok"` — delegate even if the heuristic would reject |
| `**Codex:** no` | `eligible: false`, `annotated: "no"` — never delegate |
| (no annotation) | fall through to the heuristic checklist; `annotated: null` |

Plans authored via `/superflow`'s Step B2 get this guidance baked into the `writing-plans` brief: the planner adds `**Codex:** ok` for obviously well-bounded tasks (≤ 3 files, unambiguous, known verification) and `**Codex:** no` for tasks that require broader context. Plans without annotations behave exactly as before — annotations are an aid, never required.

```

- [ ] **Step 8: Verify README edit**

Run:
```
grep -nF "## Plan annotations" README.md
```
Expected: 1 match (the new subsection).

Run:
```
grep -c "## " README.md
```
Expected: a number ≥ 14 (one more than the pre-edit count). Sanity check that the new section landed.

- [ ] **Step 9: Update CHANGELOG.md**

In `CHANGELOG.md`, in the `[Unreleased]` section's `### Added` heading, add this bullet:

```
- **Plan annotation schema documented.** `**Codex:** ok|no` lines in per-task `**Files:**` blocks override the eligibility heuristic for Codex routing. Documented in `commands/superflow.md` Step C 3a (with concrete syntax example), threaded through Step C step 1's cache-builder brief, and surfaced in Step B2's brief to `superpowers:writing-plans` so new plans gain annotations when the planner judges tasks obviously suited or unsuited. New "Plan annotations" subsection in README.md. Pre-existing plans without annotations behave exactly as before (heuristic-only). The eligibility cache's `annotated` branch is no longer dead code.
```

- [ ] **Step 10: Commit**

```bash
git add commands/superflow.md README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
superflow: document **Codex:** ok|no plan annotation schema

Annotations live as a **Codex:** line in the per-task **Files:** block
of the plan. Documented in commands/superflow.md (Step C 3a syntax,
Step C step 1 cache builder brief, Step B2 writing-plans brief) and
README.md (new Plan annotations subsection). Eligibility cache's
annotated branch is no longer dead code.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Gated permissiveness defaults

**Files:**
- Modify: `commands/superflow.md` — Step C step 3 (~line 307), Step 4b decision matrix gated case (~line 392), Configuration schema codex block (~line 715)
- Modify: `README.md` — Configuration section codex block (~line 273), Useful flag combinations table (~line 217)
- Modify: `CHANGELOG.md` — `[Unreleased]` Changed section

**Codex:** ok    # multi-file but bounded; spec defines exact behavior

- [ ] **Step 1: Re-read spec section 2**

Read spec section "2. Gated permissiveness defaults". Approach: under `gated`, honor pre-configured Codex auto-routing silently; auto-accept clean and low-only Codex reviews silently. New config keys `codex.confirm_auto_routing: false` and `codex.review_prompt_at: "medium"` for opting back into the chatty behavior.

- [ ] **Step 2: Replace Step C step 3 `gated` bullet**

In `commands/superflow.md`, find the bullet starting "- **`gated`** — before each task" (around line 307). Replace this text:

```
   - **`gated`** — before each task, call `AskUserQuestion(continue / skip-this-task / stop)`. Honor the answer. If `codex_routing == auto`, expand the question to `(continue inline / continue via Codex / skip / stop)` so the user can override the auto-route. Under `codex_routing == manual`, do NOT expand here — Step 3a's per-task `AskUserQuestion` already handles routing, so combining would double-prompt.
```

With:

```
   - **`gated`** — before each task, call `AskUserQuestion(continue / skip-this-task / stop)`. Honor the answer. **Routing decisions made via the eligibility cache (under `codex_routing == auto`) are honored silently** — the per-task question is NOT expanded with a Codex-override option, since the user pre-configured auto-routing and the activity log records every decision post-hoc. Users who want the legacy expanded prompt set `codex.confirm_auto_routing: true` in `.superflow.yaml`; in that case the question expands to `(continue inline / continue via Codex / skip / stop)`. Under `codex_routing == manual`, do NOT expand here — Step 3a's per-task `AskUserQuestion` already handles routing.
```

- [ ] **Step 3: Verify Step C step 3 edit**

Run:
```
grep -nF "Routing decisions made via the eligibility cache" commands/superflow.md
```
Expected: 1 match in Step C step 3.

Run:
```
grep -nF "expand the question to \`(continue inline / continue via Codex / skip / stop)\` so the user can override the auto-route" commands/superflow.md
```
Expected: 0 matches (the old expand-by-default text is gone).

- [ ] **Step 4: Replace Step 4b decision matrix `gated` bullet**

In `commands/superflow.md`, find the line "- **`gated`** — present findings via `AskUserQuestion`" (around line 392, in the Step 4b decision matrix). Replace this text:

```
      - **`gated`** — present findings via `AskUserQuestion` → `Accept / Fix and re-review (rerun inline with findings as briefing; capped at config.codex.review_max_fix_iterations) / Accept anyway / Stop`.
```

With:

```
      - **`gated`** — auto-accept silently when severity is `clean` or strictly below `config.codex.review_prompt_at` (default `"medium"`). Activity log records the auto-accept; `## Notes` is not polluted (clean and low-only reviews don't need notes per Step 4b step 5). When severity is at or above the threshold, present findings via `AskUserQuestion` → `Accept / Fix and re-review (rerun inline with findings as briefing; capped at config.codex.review_max_fix_iterations) / Accept anyway / Stop`. Users who want every review prompted set `codex.review_prompt_at: "low"` in `.superflow.yaml`.
```

- [ ] **Step 5: Verify Step 4b decision matrix edit**

Run:
```
grep -nF "auto-accept silently when severity is \`clean\` or strictly below" commands/superflow.md
```
Expected: 1 match in Step 4b.

- [ ] **Step 6: Update Configuration schema codex block**

In `commands/superflow.md`, find the `codex:` block in the Configuration schema (around line 715). Replace this text:

```
codex:
  routing: auto              # off | auto | manual — who executes a task
  review: off                # off | on — Codex reviews diffs from inline-completed tasks
  review_diff_under_full: false  # if true, even autonomy=full pauses to show Codex output
  max_files_for_auto: 3      # eligibility heuristic threshold for `auto` routing
  review_max_fix_iterations: 2  # cap on "fix and re-review" retries before bailing
```

With:

```
codex:
  routing: auto              # off | auto | manual — who executes a task
  review: off                # off | on — Codex reviews diffs from inline-completed tasks
  review_diff_under_full: false  # if true, even autonomy=full pauses to show Codex output
  max_files_for_auto: 3      # eligibility heuristic threshold for `auto` routing
  review_max_fix_iterations: 2  # cap on "fix and re-review" retries before bailing
  confirm_auto_routing: false  # under `gated`, prompt per-task to confirm auto-routing decisions
                               # (default false: honor cache silently; activity log records every decision)
                               # set true to restore the legacy expanded per-task prompt
  review_prompt_at: medium   # under `gated`, severity threshold at which Codex review findings prompt
                             # values: low | medium | high | never
                             # default `medium` (auto-accept clean and low-only; prompt at medium+)
                             # set `low` to prompt on every non-clean review; set `never` to auto-accept all
```

- [ ] **Step 7: Verify Configuration schema edit**

Run:
```
grep -nF "confirm_auto_routing: false" commands/superflow.md
```
Expected: 1 match in the YAML schema.

Run:
```
grep -nF "review_prompt_at: medium" commands/superflow.md
```
Expected: 1 match.

- [ ] **Step 8: Update README.md Configuration section codex block**

Read `README.md`. Find the `codex:` block in the Configuration YAML (around line 273). Replace this text:

```yaml
# Codex routing + review
codex:
  routing: auto              # off | auto | manual — who executes a task
  review: off                # off | on — Codex reviews diffs from inline-completed tasks
  review_diff_under_full: false
  max_files_for_auto: 3
  review_max_fix_iterations: 2
```

With:

```yaml
# Codex routing + review
codex:
  routing: auto              # off | auto | manual — who executes a task
  review: off                # off | on — Codex reviews diffs from inline-completed tasks
  review_diff_under_full: false
  max_files_for_auto: 3
  review_max_fix_iterations: 2
  confirm_auto_routing: false  # under `gated`, prompt per-task to confirm auto-routing
                               # default false: honor eligibility cache silently
                               # set true to restore legacy expanded prompt
  review_prompt_at: medium   # under `gated`, severity threshold at which review findings prompt
                             # low | medium | high | never (default medium)
```

- [ ] **Step 9: Verify README.md Configuration edit**

Run:
```
grep -nF "confirm_auto_routing: false" README.md
```
Expected: 1 match.

Run:
```
grep -nF "review_prompt_at: medium" README.md
```
Expected: 1 match.

- [ ] **Step 10: Update README.md "Useful flag combinations" table**

In `README.md`, find the row in the Useful flag combinations table starting "| `/superflow <topic>` | Default:" (around line 219). Replace that row:

```
| `/superflow <topic>` | Default: `--autonomy=gated`, codex routing from config (default `auto`), no review. Each task gates on user input; small well-defined tasks may auto-route to Codex. |
```

With:

```
| `/superflow <topic>` | Default: `--autonomy=gated`, codex routing from config (default `auto`), no review. Per-task `(continue / skip / stop)` gate; auto-routing decisions execute silently (no per-task Codex confirmation prompt — set `codex.confirm_auto_routing: true` for the legacy chatty behavior). |
```

Then find the row starting "| `/loop /superflow <topic> --autonomy=loose --codex-review=on` |" (around line 221). Replace that row:

```
| `/loop /superflow <topic> --autonomy=loose --codex-review=on` | Same long run, but Codex reviews each inline (Claude/Sonnet) task's diff before it counts as done. Medium findings go to `## Notes`; high findings block. |
```

With:

```
| `/loop /superflow <topic> --autonomy=loose --codex-review=on` | Same long run, but Codex reviews each inline (Claude/Sonnet) task's diff before it counts as done. Under `loose`: low/clean → silent accept; medium → `## Notes`; high → block. (Same behavior under `gated` for non-prompting severities — auto-accepted silently below `codex.review_prompt_at`, default `medium`.) |
```

- [ ] **Step 11: Verify README.md flag-combinations edit**

Run:
```
grep -nF "auto-routing decisions execute silently" README.md
```
Expected: 1 match.

Run:
```
grep -nF "Each task gates on user input; small well-defined tasks may auto-route to Codex." README.md
```
Expected: 0 matches (the old phrasing is gone).

- [ ] **Step 12: Update CHANGELOG.md**

In `CHANGELOG.md`, in the `[Unreleased]` section's `### Changed` heading, add this bullet at the top:

```
- **Gated mode no longer prompts on pre-configured Codex automation.** Under `--autonomy=gated`: (a) auto-routing decisions from the eligibility cache execute silently — the per-task question is no longer expanded with a Codex-override option when `codex_routing == auto`. (b) Codex review findings auto-accept silently when severity is below `config.codex.review_prompt_at` (default `"medium"`); only medium+ findings prompt. Activity log still tags every decision so the user sees what happened post-hoc, just doesn't gate on it. **Behavior change** — users who want the legacy chatty behavior set `codex.confirm_auto_routing: true` and `codex.review_prompt_at: "low"`. README config + Useful flag combinations table updated to document the new defaults.
```

- [ ] **Step 13: Commit**

```bash
git add commands/superflow.md README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
superflow: gated mode honors pre-configured Codex automation silently

Under --autonomy=gated: auto-routing decisions execute silently (no
per-task Codex-override prompt); Codex review findings auto-accept
when below codex.review_prompt_at (default medium). Activity log
still tags every decision. New config keys confirm_auto_routing and
review_prompt_at let users restore legacy chatty behavior. README
config + flag-combinations table updated.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Step B0 trunk-branch warning on "Stay"

**Files:**
- Modify: `commands/superflow.md` — Step B0 step 3 (~line 230)
- Modify: `CHANGELOG.md` — `[Unreleased]` Changed section

**Codex:** ok    # tiny targeted edit

- [ ] **Step 1: Re-read spec section 6**

Read spec section "6. Step B0 worktree warning when "Stay" lands on trunk". Approach: when current branch is in `config.trunk_branches`, the "Stay in current worktree" option's description gains the SDD-refuses-trunk warning.

- [ ] **Step 2: Replace Step B0 step 3 options block**

In `commands/superflow.md`, find the block starting "3. **Present the choice via `AskUserQuestion`** with options reflecting the recommendation. Always include:" (around line 229). Replace this text:

```
3. **Present the choice via `AskUserQuestion`** with options reflecting the recommendation. Always include:
   - "Stay in current worktree (`<branch>` at `<path>`)"
   - One option per existing matching worktree, if any: "Use existing worktree (`<branch>` at `<path>`)"
   - "Create new worktree" (this invokes `superpowers:using-git-worktrees` to do it properly)
   - Mark the recommended option first with "(Recommended)" and a one-line reason in the description (e.g. "current branch is main — isolate this work").
```

With:

```
3. **Present the choice via `AskUserQuestion`** with options reflecting the recommendation. Always include:
   - "Stay in current worktree (`<branch>` at `<path>`)"
     - When `<branch>` is in `config.trunk_branches`, the option's description text gains a warning: `"(Note: superpowers:subagent-driven-development will refuse to start on this branch without explicit consent — choose Create new if you'll execute via subagents.)"` This surfaces the SDD constraint at the worktree-decision point rather than as a surprise at Step C. When `<branch>` is non-trunk, no warning.
   - One option per existing matching worktree, if any: "Use existing worktree (`<branch>` at `<path>`)"
   - "Create new worktree" (this invokes `superpowers:using-git-worktrees` to do it properly)
   - Mark the recommended option first with "(Recommended)" and a one-line reason in the description (e.g. "current branch is main — isolate this work").
```

- [ ] **Step 3: Verify Step B0 edit**

Run:
```
grep -nF "subagent-driven-development will refuse to start on this branch" commands/superflow.md
```
Expected: 1 match in Step B0 step 3.

- [ ] **Step 4: Update CHANGELOG.md**

In `CHANGELOG.md`, in the `[Unreleased]` section's `### Changed` heading, add this bullet:

```
- **Step B0 surfaces SDD's trunk-branch refusal at decision time.** When the user is on a branch in `config.trunk_branches` (default `[main, master, trunk, dev, develop]`), the "Stay in current worktree" option's description now warns that `superpowers:subagent-driven-development` will refuse to start there. Previously the user found out at Step C (after the worktree decision was supposedly settled). Non-trunk branches are unchanged — no warning shown.
```

- [ ] **Step 5: Commit**

```bash
git add commands/superflow.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
superflow: Step B0 warns on Stay when current branch is trunk

The "Stay in current worktree" option's description now flags that
subagent-driven-development will refuse to start on trunk branches
(main/master/etc.). Surfaces the SDD constraint at worktree-decision
time rather than as a surprise at Step C.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Cross-cutting verification + final commit

**Files:**
- Read-only: all modified files from Tasks 1–6
- Modify: `CHANGELOG.md` — clean up duplicate `### Added` blocks if any (the original CHANGELOG had two "### Added" sections in `[Unreleased]`; sanity-check)

**Codex:** no    # cross-file reasoning, coherence checks across multiple sections; needs judgment

- [ ] **Step 1: Cross-reference check — every new config key documented in three places**

For each new config key, verify it appears in the YAML schema in `commands/superflow.md`, in the README config block, and is mentioned in at least one CHANGELOG entry.

Run:
```
for key in "confirm_auto_routing" "review_prompt_at"; do
  echo "=== $key ==="
  echo "commands/superflow.md:"; grep -nF "$key" commands/superflow.md
  echo "README.md:";              grep -nF "$key" README.md
  echo "CHANGELOG.md:";           grep -nF "$key" CHANGELOG.md
  echo
done
```

Expected: each `===` block shows ≥ 1 match in each of the three files. If any file shows 0 matches for a key, that key was missed in one of the previous tasks — open the file, find the right place, add it.

- [ ] **Step 2: Cross-reference check — every changed Step in commands/superflow.md has a CHANGELOG entry**

Confirm each of the six changes has a corresponding `[Unreleased]` CHANGELOG entry under the right heading:

Run:
```
echo "=== CHANGELOG [Unreleased] entries for this pass ==="
awk '/^## \[Unreleased\]/{p=1} /^## \[/ && !/Unreleased/{p=0} p' CHANGELOG.md | head -100
```

Visually scan the output. Confirm that you see entries (not exhaustive, just one for each):
1. **Fixed:** "Step 4b SHA fallback was a no-op" (Task 1)
2. **Changed:** "Step 4a no longer re-runs implementer's tests" (Task 2)
3. **Added:** "Eligibility cache persists across wakeups" (Task 3)
4. **Added:** "Plan annotation schema documented" (Task 4)
5. **Changed:** "Gated mode no longer prompts on pre-configured Codex automation" (Task 5)
6. **Changed:** "Step B0 surfaces SDD's trunk-branch refusal" (Task 6)

If any are missing, find the task that should have added it and check whether step "Update CHANGELOG.md" was completed.

- [ ] **Step 3: Mental end-to-end trace under new gated defaults**

Walk through one /superflow invocation under `--autonomy=gated --codex=auto --codex-review=on` mentally and confirm no surprise prompts:

- Step C step 1: eligibility cache loads from disk (or builds + persists if missing) — no user prompt.
- Step C step 3: `gated` asks `(continue / skip / stop)` for the next task — does NOT expand to Codex options (Task 5 step 2). User sees one prompt per task, not two.
- Step C 3a: cache says `eligible: true` → Codex dispatched silently.
- Step C 4a: implementer trusted; tests not re-run if `tests_passed: true` (Task 2 step 2).
- Step C 4b: Codex review returns `clean` or `low` → auto-accepted silently per `review_prompt_at` (Task 5 step 4). Returns `medium+` → user prompted.
- Step C 4d: status updated, activity log entry includes routing + review tags so user sees post-hoc.

Cite: walked through the trace, no surprise prompts for pre-configured automation. If any step still prompts unexpectedly, the corresponding task missed a fix — re-open it.

- [ ] **Step 4: Bash syntax check on hooks**

Run:
```
bash -n hooks/superflow-telemetry.sh && echo "telemetry hook syntax-clean"
```

Expected: `telemetry hook syntax-clean`. (This pass didn't touch the hook, but the check is a safety net for future sessions that might.)

- [ ] **Step 5: Verify CHANGELOG `[Unreleased]` heading structure isn't broken**

The original `CHANGELOG.md` had two `### Added` blocks under `[Unreleased]` (verify by inspection). After Tasks 3 and 4, both Added entries went to "the most recent ### Added heading." This may have produced an unbalanced structure. Inspect:

Run:
```
awk '/^## \[Unreleased\]/{p=1} /^## \[/ && !/Unreleased/{p=0} p' CHANGELOG.md | grep -nE "^### " | head -20
```

Expected pattern: one `### Added`, one `### Changed`, one `### Fixed`, possibly a second `### Added`. If two `### Added` blocks exist and the entries from Tasks 3/4 went to one of them, that's fine — Keep a Changelog allows it. Don't restructure unless the file is genuinely broken (e.g., two consecutive `### Added` headings with no entries between them, or content that won't render).

- [ ] **Step 6: Final commit (verification metadata)**

If Steps 1–5 surfaced any issues that required follow-up edits, commit them now with:

```bash
git add commands/superflow.md README.md CHANGELOG.md
git commit -m "$(cat <<'EOF'
superflow: small-fixes pass — final verification cleanup

Cross-cutting checks after Tasks 1-6: verified config keys documented
in all three locations, CHANGELOG entries land under the right
headings, and the new gated defaults produce no surprise prompts on
mental end-to-end trace.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If Steps 1–5 found nothing to fix, skip the commit; the small-fixes pass is complete with the six per-task commits from Tasks 1–6.

- [ ] **Step 7: Report back**

Summarize:
- How many tasks landed (should be 6 + optional 7).
- Each commit SHA.
- Any verification issues that surfaced and how they were resolved.
- Suggest next steps (e.g. invoke `superpowers:finishing-a-development-branch` to merge or PR).
