# /superflow Explicit Phase Subcommands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `new`, `brainstorm`, `plan`, `execute` as explicit phase verbs in `/superflow` so every entry point is named and the pipeline can halt cleanly after brainstorm or after plan. Additive — bare-topic, empty-args, and `--resume=<path>` keep working.

**Architecture:** All changes land in `commands/superflow.md` (the orchestrator prompt) plus three docs (README, CHANGELOG, WORKLOG). A new internal variable `halt_mode ∈ {none, post-brainstorm, post-plan}` is set in Step 0 from the verb match, then read by Steps B1, B2, B3, and C to choose between the existing gate behavior and a new halt-aware gate. A new short Step P handles the `plan` no-args picker.

**Tech Stack:** Markdown only (no code, no traditional tests). "Verification" for each task is a grep check confirming the new tokens / structure landed, plus an end-to-end self-read of the modified prompt.

**Spec:** `docs/superpowers/specs/2026-05-02-superflow-subcommands-design.md`

---

## File structure

| File | Change |
|---|---|
| `commands/superflow.md` | Step 0 routing table + halt_mode plumbing (Task 1); B1/B2/B3/C halt-aware variants (Tasks 2–5); Step P insertion (Task 6); plan --from-spec worktree handling (Task 7); frontmatter description (Task 8) |
| `README.md` | New verb table at top of `## Subcommand reference`; verb-token-as-topic note (Task 9) |
| `CHANGELOG.md` | v0.3.0 entry (Task 10) |
| `WORKLOG.md` | Dated handoff entry (Task 11) |

No new files. No code. No automated tests — all verification is grep-based.

---

## Conventions for every task

- **Read first.** Each Edit tool call requires reading the file at least once in the current session. The first step of each task reads or greps the target region.
- **Surgical Edits only.** Use `Edit` with `old_string`/`new_string` carrying enough surrounding context to make the match unique. Never `Write` over `commands/superflow.md`.
- **One commit per task.** Commit subject prefix: `superflow:` for prompt changes, `docs:` for README / CHANGELOG / WORKLOG. Short imperative subject + Co-Authored-By footer per repo convention.
- **Verify with grep.** Each task ends with a grep that proves the change landed.

---

### Task 1: Step 0 — routing table + halt_mode + flag-interaction rules

**Files:**
- Modify: `commands/superflow.md` (Step 0 "Subcommand routing" table + a new "halt_mode and flag interactions" subsection inserted directly below it)

**Codex:** no    # multi-section threading; must hold existing Step 0 structure in mind

- [x] **Step 1: Read the current routing table region**

Run: `grep -n "Subcommand routing\|^| First token\|^| _(empty)_\|anything else" commands/superflow.md`
Expected: lines 46–55 region matched, confirming the existing 5-row table.

- [x] **Step 2: Replace the existing routing table with the 14-row verb table**

Use `Edit` with `old_string` covering the entire current table block (the heading line `### Subcommand routing (first token of \`$ARGUMENTS\`)` through the `| anything else | treat as a topic, **Step B** — kickoff |` row). New table:

```markdown
### Subcommand routing (first token of `$ARGUMENTS`)

| First token | Branch | `halt_mode` |
|---|---|---|
| _(empty)_ | **Step A** — list+pick across worktrees | `none` |
| `new <topic>` | **Step B** — full kickoff (B0→B1→B2→B3→C) | `none` |
| `brainstorm` (no topic) | Prompt for topic, then Step B0+B1; halt at B1 close-out gate | `post-brainstorm` |
| `brainstorm <topic>` | Step B0+B1; halt at B1 close-out gate | `post-brainstorm` |
| `plan` (no args) | **Step P** — pick spec-without-plan; treat pick as `plan --from-spec=<picked>` | `post-plan` |
| `plan <topic>` | Step B0+B1+B2+B3; halt at B3 close-out gate | `post-plan` |
| `plan --from-spec=<path>` | cd into spec's worktree, run B2+B3 only; halt at B3 close-out gate | `post-plan` |
| `execute` (no path) | **Step A** — same as bare empty | `none` |
| `execute <status-path>` | **Step C** — resume that plan | `none` |
| `import` (alone or with args) | **Step I** — legacy import | `none` |
| `doctor` (alone or with `--fix`) | **Step D** — lint state | `none` |
| `status` (alone or with `--plan=<slug>`) | **Step S** — situation report (read-only) | `none` |
| `--resume=<path>` or `--resume <path>` | **Step C** — alias for `execute <path>` | `none` |
| anything else | treat as a topic, **Step B** — kickoff (back-compat catch-all) | `none` |
```

- [x] **Step 3: Insert the halt_mode + flag-interactions subsection directly below the table**

Use `Edit` with `old_string` matching the closing fence of Section 2 (the `### Recognized flags` heading) and `new_string` that prepends a new subsection BEFORE the `### Recognized flags` line. Content:

```markdown
### `halt_mode` and flag interactions

`halt_mode` is an internal orchestrator variable set in Step 0 from the verb match. Steps B1, B2, B3, and C consult it to choose between the existing gate behavior and a halt-aware variant.

**Verb tokens are reserved.** Any topic literally named `new`, `brainstorm`, `plan`, or `execute` requires another word in front via the catch-all (e.g., `/superflow add brainstorm session timer`).

**Argument-parse precedence (in Step 0, after config + git_state cache):**
1. Match the first token against `{new, brainstorm, plan, execute, import, doctor, status}`. On match: set `halt_mode` per the table; consume the verb; pass remaining args to the matched step.
2. If unmatched and the first arg starts with `--`: route to **Step A** (flag-only invocation).
3. If unmatched and the first arg is a non-flag word: catch-all → **Step B** with the full arg string as the topic (existing behavior).

**Flag-interaction rules** (warnings emitted at Step 0, not later):
- `halt_mode == post-brainstorm` → `--autonomy=`, `--codex=`, `--codex-review=`, `--no-loop` are **ignored**. Emit one-line warning: `flags <list> ignored: brainstorm halts before execution`.
- `halt_mode == post-plan` → those same flags are **persisted** to the status file (Step B3 records them in frontmatter) but do not fire this run. No warning.
- `halt_mode == none` → flags fire as today.

**`/loop /superflow <verb> ...` foot-gun.** When `halt_mode != none` AND `ScheduleWakeup` is available (i.e. invoked via `/loop`), emit one-line warning: `note: <verb> halts before execution; --no-loop recommended for this verb`. Do NOT auto-disable the loop; the user may have a reason.

```

- [x] **Step 4: Verify routing table landed**

Run: `grep -nc "^| .new <topic>\| .brainstorm <topic>\| .plan --from-spec\| .execute <status-path>" commands/superflow.md`
Expected: `4` (one row each for the four new verbs in the table).

Run: `grep -n "halt_mode\|post-brainstorm\|post-plan" commands/superflow.md | wc -l`
Expected: ≥ 10 (table column references + new subsection contents).

Run: `grep -n "Verb tokens are reserved" commands/superflow.md`
Expected: matches the new subsection.

- [x] **Step 5: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step 0 routing — add new/brainstorm/plan/execute verbs

Adds halt_mode internal var (none|post-brainstorm|post-plan), flag-interaction
rules, /loop foot-gun warning. Existing entry points unchanged.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Step B1 — close-out gate variant for halt_mode=post-brainstorm

**Files:**
- Modify: `commands/superflow.md` Step B1 section (existing re-engagement gate at "After brainstorming returns control to /superflow…")

**Codex:** no    # must understand existing 3-branch gate to add the variant cleanly

- [x] **Step 1: Read the current B1 re-engagement gate**

Run: `grep -n "Re-engagement gate (CRITICAL\|If spec exists\|If spec missing" commands/superflow.md | head -10`
Expected: lines around 247–253 (the existing gate block).

Read the exact block to capture for `old_string`:

Run: `sed -n '247,255p' commands/superflow.md` (read-only sed, output only)

- [x] **Step 2: Replace the existing "If spec exists" branch with halt_mode-aware variant**

Use `Edit` with `old_string` covering the existing line `3. **If spec exists** (the normal case): under \`--autonomy != full\`, surface \`AskUserQuestion("Spec written at <path>. Ready for writing-plans?", options=[Approve and run writing-plans (Recommended) / Open spec to review first then ping me / Request changes — describe what to change / Abort kickoff])\`. Under \`--autonomy=full\`: auto-approve and proceed to Step B2 silently.`

Replace with:

```markdown
3. **If spec exists** (the normal case): consult `halt_mode`.
   - **`halt_mode == none`** (existing kickoff path, unchanged): under `--autonomy != full`, surface `AskUserQuestion("Spec written at <path>. Ready for writing-plans?", options=[Approve and run writing-plans (Recommended) / Open spec to review first then ping me / Request changes — describe what to change / Abort kickoff])`. Under `--autonomy=full`: auto-approve and proceed to Step B2 silently.
   - **`halt_mode == post-brainstorm`** (new, fires when invoked via `/superflow brainstorm <topic>`): surface `AskUserQuestion("Spec written at <path>. What next?", options=["Done — close out this run (Recommended)", "Continue to plan now — run B2+B3 as if /superflow plan --from-spec=<path>", "Open spec to review before deciding — then ping me", "Re-run brainstorming to refine"])`.
     - "Done" → end the turn cleanly. No status file written, no plan written.
     - "Continue to plan now" → flip in-session `halt_mode` to `post-plan` and proceed to Step B2. The spec is reused.
     - "Open spec" → end the turn; user re-invokes whatever they want next.
     - "Re-run brainstorming to refine" → re-invoke `superpowers:brainstorming` against the same topic; the previous spec is overwritten.
```

- [x] **Step 3: Verify the variant landed**

Run: `grep -n "halt_mode == post-brainstorm" commands/superflow.md`
Expected: matches inside Step B1.

Run: `grep -n "Continue to plan now\|Re-run brainstorming to refine" commands/superflow.md`
Expected: both new option labels found (in the B1 block).

- [x] **Step 4: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step B1 — halt-aware close-out for /superflow brainstorm

Adds post-brainstorm variant of the re-engagement gate. Halt_mode==none
keeps existing kickoff behavior. Continue option flips to post-plan
in-session for users who decide they want to keep going.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Step B2 — dispatch guard

**Files:**
- Modify: `commands/superflow.md` Step B2 section (top of "After Step B1's gate confirms approval, invoke `superpowers:writing-plans`…")

**Codex:** ok    # single-paragraph addition at known anchor

- [x] **Step 1: Locate the Step B2 dispatch line**

Run: `grep -n "After Step B1's gate confirms approval, invoke" commands/superflow.md`
Expected: one match in Step B2.

- [x] **Step 2: Insert the dispatch guard above the existing first paragraph**

Use `Edit` with `old_string` matching the existing first paragraph of Step B2 (`After Step B1's gate confirms approval, invoke \`superpowers:writing-plans\` against the spec.` plus enough trailing context to make the match unique) and `new_string` prepending the guard:

```markdown
**Dispatch guard.** If `halt_mode == post-brainstorm`, skip Step B2 and Step B3 entirely — the B1 close-out gate already ended the turn (or, if the user picked "Continue to plan now" there, flipped `halt_mode` to `post-plan` and we proceed normally below).

After Step B1's gate confirms approval, invoke `superpowers:writing-plans` against the spec.
```

- [x] **Step 3: Verify**

Run: `grep -n "Dispatch guard" commands/superflow.md`
Expected: at least one match in Step B2 (this task) — Tasks 5 will add another in Step C; that's fine.

Run: `grep -n "halt_mode == post-brainstorm" commands/superflow.md | wc -l`
Expected: ≥ 2 (one in B1 from Task 2, one in B2 from this task).

- [x] **Step 4: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step B2 — dispatch guard skips plan under post-brainstorm

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Step B3 — close-out gate variant for halt_mode=post-plan

**Files:**
- Modify: `commands/superflow.md` Step B3 section (existing approval prompt at end: "If `--autonomy != full`: present a one-paragraph plan summary…")

**Codex:** no    # gate variant must align with existing autonomy/approval logic

- [x] **Step 1: Locate the existing B3 approval block**

Run: `grep -n "If .--autonomy != full.: present a one-paragraph plan summary\|Proceed to .Step C." commands/superflow.md`
Expected: two consecutive matches near the end of Step B3.

- [x] **Step 2: Replace the existing approval block with halt_mode-aware variant**

Use `Edit` with `old_string` covering the line `If \`--autonomy != full\`: present a one-paragraph plan summary and the path to the plan file via \`AskUserQuestion\` with options "Start execution / Open plan to review / Cancel". Wait for approval. If \`--autonomy=full\`: skip approval.` AND the following line `Proceed to **Step C** with the new status path.`

Replace with:

```markdown
**Close-out gate.** Consult `halt_mode`:

- **`halt_mode == none`** (existing kickoff path, unchanged): if `--autonomy != full`, present a one-paragraph plan summary and the path to the plan file via `AskUserQuestion` with options "Start execution / Open plan to review / Cancel". Wait for approval. If `--autonomy=full`: skip approval. Proceed to **Step C** with the new status path.

- **`halt_mode == post-plan`** (new, fires when invoked via `/superflow plan <topic>` or `/superflow plan --from-spec=<path>` or via Step P's pick): surface `AskUserQuestion("Plan written at <path>. Status file at <status-path>. What next?", options=["Done — resume later with /superflow execute <status-path> (Recommended)", "Start execution now — flip halt_mode to none and proceed to Step C", "Open plan to review before deciding", "Discard plan + status file (status file removed; spec kept)"])`.
  - "Done" → end the turn. Status file persists with `status: in-progress` and `current_task` set to the first task. The user resumes later via `/superflow execute <status-path>`.
  - "Start execution now" → flip in-session `halt_mode` to `none` and proceed to **Step C**.
  - "Open plan" → end the turn. User re-invokes `/superflow execute <status-path>` later.
  - "Discard" → `git rm` the plan file and the status file; commit (`superflow: discard plan <slug>` subject); end the turn. Spec is kept.

The status file's `autonomy`, `codex_routing`, `codex_review`, `loop_enabled` fields are populated from this run's flags per the post-plan flag-persistence rule in Step 0; they take effect on the eventual `execute` invocation.
```

- [x] **Step 3: Verify**

Run: `grep -n "halt_mode == post-plan" commands/superflow.md`
Expected: at least one match (in Step B3).

Run: `grep -n "Discard plan + status file\|Resume later with /superflow execute" commands/superflow.md`
Expected: both new option labels present.

- [x] **Step 4: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step B3 — halt-aware close-out for /superflow plan

Adds post-plan close-out variant. Status file is created either way;
under post-plan the user resumes via /superflow execute <path> later.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Step C — dispatch guard

**Files:**
- Modify: `commands/superflow.md` Step C section (insert at the top of the step, immediately after the `## Step C — Execute` heading, before step 1)

**Codex:** ok    # one-paragraph insertion at section heading

- [x] **Step 1: Locate Step C heading**

Run: `grep -n "^## Step C — Execute" commands/superflow.md`
Expected: one match.

- [x] **Step 2: Insert the dispatch guard immediately after the heading**

Use `Edit` with `old_string` covering `## Step C — Execute\n\n1. **Batched re-read.**` and `new_string` inserting the guard between the heading and step 1:

```markdown
## Step C — Execute

**Dispatch guard.** If `halt_mode != none`, skip Step C entirely — the B1 or B3 close-out gate already ended the turn. The only paths into Step C are: (a) `halt_mode == none` from kickoff or `execute`/`--resume=`; (b) the user explicitly flipped `halt_mode` to `none` via the B1 "Continue to plan now → Start execution now" or B3 "Start execution now" gate options.

1. **Batched re-read.**
```

- [x] **Step 3: Verify**

Run: `grep -n "Dispatch guard" commands/superflow.md | wc -l`
Expected: `2` (B2 from Task 3 + Step C from this task).

Run: `grep -n "halt_mode != none" commands/superflow.md`
Expected: at least one match (in Step C).

- [x] **Step 4: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step C — dispatch guard skips execute under halt_mode

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Step P — plan-only no-args picker

**Files:**
- Modify: `commands/superflow.md` (insert new `## Step P — Plan-only no-args picker` section between the end of Step B and the start of Step C)

**Codex:** no    # whole new section; placement and prose must match the file's voice

- [ ] **Step 1: Locate the boundary between Step B and Step C**

Run: `grep -n "^## Step B —\|^## Step C —" commands/superflow.md`
Expected: two matches; the new section goes between them.

Run: `grep -n "Proceed to \*\*Step C\*\* with the new status path\|^---$" commands/superflow.md | head -10` to find the `---` separator that ends Step B.

- [ ] **Step 2: Insert Step P before the `---` separator that precedes `## Step C — Execute`**

Use `Edit` with `old_string` covering the `---\n\n## Step C — Execute` boundary and `new_string` inserting Step P between them:

```markdown
---

## Step P — Plan-only no-args picker

Triggered by `/superflow plan` with no topic and no `--from-spec=`. Picks an existing spec without a plan and treats the pick as `plan --from-spec=<picked>`.

1. Glob `<config.specs_path>/*-design.md` across all worktrees as one parallel Bash batch (read worktrees from `git_state.worktrees`).
2. For each candidate spec, check whether a sibling plan exists at `<config.plans_path>/<same-slug>.md` (slug = filename minus `-design.md` suffix). Filter to specs **without** a plan.
3. Sort the filtered list by mtime descending.
4. **If ≥ 1 candidate:** present top 3 via `AskUserQuestion`. The 4th option is "Other — paste a path" (free-text). User picks → treat as `plan --from-spec=<picked>` and proceed to **plan --from-spec worktree handling** (below in Step B), then Step B2 + B3.
5. **If zero candidates:** surface `AskUserQuestion("No specs without plans found across <N> worktrees. What next?", options=["Start a new feature — /superflow new <topic>", "Brainstorm-only — /superflow brainstorm <topic>", "Cancel"])`. The first two redirect into the corresponding verb's flow with a topic prompted next; "Cancel" ends the turn.

`halt_mode` for this step's outputs is `post-plan` (already set in Step 0 when `plan` was matched). Step B3's close-out gate fires after the plan is written.

---

## Step C — Execute
```

- [ ] **Step 3: Verify**

Run: `grep -n "^## Step P —" commands/superflow.md`
Expected: one match.

Run: `grep -n "specs without plans found across" commands/superflow.md`
Expected: matches the zero-candidates branch.

Run: `grep -c "^## Step " commands/superflow.md`
Expected: count increased by 1 (Step P added).

- [ ] **Step 4: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step P — plan-only no-args picker

Surfaces specs-without-plans for the `/superflow plan` no-args form.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Step B0 — `plan --from-spec=<path>` worktree handling subsection

**Files:**
- Modify: `commands/superflow.md` Step B0 section (insert a new subsection at the end of B0)

**Codex:** ok    # well-bounded subsection addition, no rewriting of B0's existing flow

- [ ] **Step 1: Locate the end of Step B0**

Run: `grep -n "^### Step B0 —\|^### Step B1 —" commands/superflow.md`
Expected: two matches; the new subsection goes between them.

Run: `grep -n "5. Record the chosen worktree path and branch" commands/superflow.md` — the existing last numbered point of B0.

- [ ] **Step 2: Insert the new subsection between B0 step 5 and the `### Step B1 — Brainstorm` heading**

Use `Edit` with `old_string` matching the line `5. Record the chosen worktree path and branch — they go into the status file in Step B3.\n\n### Step B1 — Brainstorm` and `new_string` inserting the subsection:

```markdown
5. Record the chosen worktree path and branch — they go into the status file in Step B3.

#### Step B0a — `plan --from-spec=<path>` worktree handling

When the verb is `plan --from-spec=<path>` (directly, or via Step P's pick), Step B0's worktree-decision flow is **skipped** — the spec's location is authoritative. Run this short flow instead:

1. Resolve `<path>` to its containing git worktree via `git rev-parse --show-toplevel` from the spec's parent directory.
2. `cd` into that worktree before invoking `superpowers:writing-plans` (Step B2).
3. Verify the worktree appears in `git_state.worktrees` (Step 0 cache). If it doesn't, surface `AskUserQuestion("Worktree at <resolved-path> not in git_state cache. What now?", options=["Refresh git_state and retry (Recommended)", "Abort"])`.
4. If the spec is outside any git worktree (resolution fails), error with: `Spec at <path> is not inside a git worktree. Move it under a worktree, or run /superflow brainstorm <topic> to recreate.`
5. If the resolved worktree's current branch is in `config.trunk_branches`, surface `AskUserQuestion("Spec lives on \`<branch>\` (a trunk branch). superpowers:subagent-driven-development will refuse to start on this branch at execute time. What now?", options=["Create a new worktree for the plan and copy the spec into it (Recommended)", "Continue on \`<branch>\` anyway — I'll handle SDD's refusal manually later", "Abort"])`.
   - "Create a new worktree" → run the same flow as B0 step 4's "Create new" branch (with the directory pre-decided per the existing AskUserQuestion + `superpowers:using-git-worktrees` pattern), then `git mv` the spec into the new worktree's `<config.specs_path>/`, commit (`superflow: relocate spec for <slug> to feature worktree`), then proceed to Step B2 in the new worktree.
   - "Continue" → proceed to Step B2 on the trunk branch; flag this in the status file's `## Notes` so the future `execute` invocation surfaces the SDD refusal up front.
   - "Abort" → end the turn.

Then proceed to **Step B2** (writing-plans). Step B1 is skipped because the spec already exists.

```

(Note: the existing `### Step B1 — Brainstorm` heading remains the next section after B0a — `new_string` should not delete it.)

- [ ] **Step 3: Verify**

Run: `grep -n "^#### Step B0a —" commands/superflow.md`
Expected: one match.

Run: `grep -n "spec's location is authoritative" commands/superflow.md`
Expected: matches B0a.

Run: `grep -n "trunk_branches\|relocate spec" commands/superflow.md`
Expected: trunk_branches reference appears in B0a (alongside any other existing references).

- [ ] **Step 4: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: Step B0a — plan --from-spec worktree handling

Inherits spec's worktree; warns + offers relocate when spec is on a trunk
branch (which would later make SDD refuse).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Update `commands/superflow.md` frontmatter description

**Files:**
- Modify: `commands/superflow.md` line 2 (frontmatter `description:` field)

**Codex:** ok    # one-line edit

- [ ] **Step 1: Read line 2**

Run: `sed -n '1,4p' commands/superflow.md`

- [ ] **Step 2: Replace the description line**

Use `Edit` to swap:
- `old_string`: `description: Brainstorm → plan → execute development workflow that delegates work to bounded subagents, preserves orchestrator context for routing/state, and self-paces long runs across sessions`
- `new_string`: `description: Brainstorm → plan → execute workflow. Verbs: new, brainstorm, plan, execute, import, doctor, status. Bare-topic shortcut still works.`

- [ ] **Step 3: Verify**

Run: `head -3 commands/superflow.md`
Expected: line 2 contains the new description.

Run: `grep -c "Verbs: new, brainstorm, plan, execute" commands/superflow.md`
Expected: `1`.

- [ ] **Step 4: Commit**

```bash
git add commands/superflow.md
git commit -m "$(cat <<'EOF'
superflow: update slash-command description with verb list

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: README — add `## Subcommand reference` verb table

**Files:**
- Modify: `README.md` (insert a new verb table at the top of the existing `## Subcommand reference` section, before the existing `| Invocation | Effect |` table)

**Codex:** ok    # bounded markdown insertion

- [ ] **Step 1: Read the current Subcommand reference region**

Run: `sed -n '180,200p' README.md`

- [ ] **Step 2: Insert the verb table at the top of the section**

Use `Edit` with `old_string` matching `## Subcommand reference\n\n| Invocation | Effect |` and `new_string` prepending the verb table block:

```markdown
## Subcommand reference

### Verbs

| Verb | Phases | Halts at |
|---|---|---|
| `new <topic>` | brainstorm + plan + execute | (runs through) |
| `brainstorm <topic>` | brainstorm only | spec written |
| `plan <topic>` | brainstorm + plan | plan written |
| `plan --from-spec=<path>` | plan only (against existing spec) | plan written |
| `execute [<status-path>]` | execute (list+pick or resume) | (runs through) |
| `import [...]` | (unchanged) | n/a |
| `doctor [--fix]` | (unchanged) | n/a |
| `status [--plan=<slug>]` | (unchanged) | n/a |

> Topics literally named after a verb (`new`, `brainstorm`, `plan`, `execute`) need to be prefixed with another word — e.g. `/superflow add brainstorm session timer` works because `add` isn't a verb.

### Invocation forms (back-compat detail)

| Invocation | Effect |
```

(The existing rows of the original table follow; the only structural change is the new heading + table + note above, plus renaming the original table's heading from `## Subcommand reference` (now used by the parent section) to `### Invocation forms (back-compat detail)`.)

- [ ] **Step 3: Verify**

Run: `grep -n "^### Verbs\|^### Invocation forms" README.md`
Expected: both new headings present.

Run: `grep -nc "^| .new <topic>\|brainstorm <topic>\| plan --from-spec\| execute \[<status-path>\]" README.md`
Expected: ≥ 4 (one row per new verb in the verb table).

Run: `grep -n "Topics literally named after a verb" README.md`
Expected: one match.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs(readme): add explicit verb table to Subcommand reference

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: CHANGELOG — add v0.3.0 entry

**Files:**
- Modify: `CHANGELOG.md` (insert new `## [0.3.0]` block immediately after `## [Unreleased]` and before `## [0.2.2]`)

**Codex:** ok    # standard changelog append

- [ ] **Step 1: Read the changelog top**

Run: `sed -n '1,20p' CHANGELOG.md`

- [ ] **Step 2: Insert the v0.3.0 block**

Use `Edit` with `old_string` matching `## [Unreleased]\n\n## [0.2.2]` and `new_string`:

```markdown
## [Unreleased]

## [0.3.0] — 2026-05-02

### Added
- Explicit phase verbs: `/superflow new <topic>`, `/superflow brainstorm <topic>`, `/superflow plan <topic>`, `/superflow plan --from-spec=<path>`, `/superflow execute [<status-path>]`. The verbs make the pipeline phases addressable at the call site instead of the previous all-or-nothing kickoff.
- `halt_mode` orchestrator state (`none | post-brainstorm | post-plan`). Drives B1 and B3 close-out gates so `brainstorm` halts cleanly after the spec is written and `plan` halts cleanly after the plan + status file are written.
- Step P — plan-only no-args picker. `/superflow plan` with no topic and no `--from-spec=` lists existing specs that don't yet have a plan and lets the user pick one.
- `### Verbs` subsection at the top of `## Subcommand reference` in the README.

### Unchanged
- Bare-topic shortcut (`/superflow refactor auth middleware`) keeps working — same behavior as `/superflow new refactor auth middleware`. No deprecation notice.
- `--resume=<status-path>` keeps working as an alias for `/superflow execute <status-path>`.
- Existing verbs `import`, `doctor`, `status` and their flags are unchanged.

## [0.2.2]
```

- [ ] **Step 3: Verify**

Run: `grep -n "^## \[0.3.0\]" CHANGELOG.md`
Expected: one match.

Run: `grep -nc "^## \[" CHANGELOG.md`
Expected: count incremented by 1 vs. before this task.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
release: v0.3.0 — explicit /superflow phase verbs

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: WORKLOG — append dated handoff entry

**Files:**
- Modify: `WORKLOG.md` (append new dated entry below the last `---` separator)

**Codex:** ok    # standard worklog append

- [ ] **Step 1: Read the WORKLOG end**

Run: `tail -20 WORKLOG.md`

- [ ] **Step 2: Append the new entry**

Use `Edit` with `old_string` matching the file's final line + a newline, OR append via `Edit`-with-trailing-context. Content to append (after the existing last entry, separated by `---`):

```markdown

---

## 2026-05-02 — `/superflow` v0.3.0 explicit phase verbs

**Scope:** Added `new`, `brainstorm`, `plan`, `execute` as explicit first-token verbs in `/superflow`. Spec: `docs/superpowers/specs/2026-05-02-superflow-subcommands-design.md`. Plan: `docs/superpowers/plans/2026-05-02-superflow-subcommands.md`.

**Key decisions (the why):**

- **Discoverability over phase-control framing.** User picked "Discoverability — make verbs visible at a glance" as the motivation. The phase-control verbs (`brainstorm`, `plan`) fall out for free once the verbs are addressable, but they aren't the headline.
- **Additive, no deprecation.** Bare-topic catch-all and `--resume=<path>` keep working forever. Existing `/loop /superflow <topic> ...` invocations and any cron / docs that use the bare-topic form continue unchanged. Cost: routing logic remains "verb match OR catch-all."
- **`halt_mode` as a tiny internal state machine instead of a per-step flag.** Set once in Step 0 from the verb match, read by B1/B2/B3/C. Cleaner than threading four boolean flags through every dispatch site, and the in-session "Continue to plan now / Start execution now" overrides become a simple `halt_mode` flip.
- **`plan --from-spec=<path>` skips Step B0 — spec's location is authoritative.** B0a covers the trunk-branch foot-gun (relocate spec to a feature worktree if it lives on main/master/trunk). Caught during spec self-review; without it, we'd silently inherit the trunk branch and only discover SDD's refusal at execute time.
- **`/superflow plan` (no args) does a Step P picker, not an error.** User flagged "list recent specs without a plan, let user pick" as the desired behavior. One filesystem scan beats forcing the user to remember/type the path; consistent with how `/superflow` (empty) lists in-progress plans.
- **Verb tokens reserved.** Topics literally named `new`, `brainstorm`, `plan`, `execute` need a leading word. Documented in the README. Concrete cost is small; alternatives (escape character, `--topic=` flag) would have introduced more grammar than they saved.

**Operational notes:**

- All edits are markdown-only. No code, no automated test suite for the prompt. Verification is grep-based per-task plus a final smoke-read of the modified `commands/superflow.md`.
- The README's existing `## Subcommand reference` got a new `### Verbs` subsection at its top; the original table is now `### Invocation forms (back-compat detail)`. README structure preserved otherwise.
- v0.3.0 is a minor version bump because the externally-visible grammar grew (new verbs) without breaking anything that already worked.

**Open questions / followups:**

- The `/loop /superflow brainstorm <topic>` foot-gun is mitigated by a one-line warning at Step 0; a stricter "auto-disable loop under halt_mode" could be considered later if telemetry shows users still hit it.
- `/superflow execute` with zero in-progress plans currently routes to Step A which offers "Start fresh" → kickoff. That's slightly indirect under explicit-verb framing; a future polish could reword the option to "No in-progress plans. Run /superflow new <topic>?" so the verb model stays coherent.
```

- [ ] **Step 3: Verify**

Run: `grep -n "2026-05-02 — \`/superflow\` v0.3.0 explicit phase verbs" WORKLOG.md`
Expected: one match.

Run: `tail -5 WORKLOG.md`
Expected: shows the tail of the new entry.

- [ ] **Step 4: Commit**

```bash
git add WORKLOG.md
git commit -m "$(cat <<'EOF'
docs(worklog): record v0.3.0 explicit-verbs pass

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Smoke verification — full prompt read + grep matrix

**Files:**
- Read-only: `commands/superflow.md`, `README.md`, `CHANGELOG.md`, `WORKLOG.md`

**Codex:** ok    # mechanical grep matrix; no judgment

- [ ] **Step 1: Routing-table sanity**

Run: `grep -n "^| _(empty)_\|^| .new <topic>\|^| .brainstorm\|^| .plan \|^| .plan --from-spec\|^| .execute \|^| .import\|^| .doctor\|^| .status\|^| .--resume=\|^| anything else" commands/superflow.md | head -20`
Expected: at least 11 matched rows in the routing table (one per branch).

- [ ] **Step 2: halt_mode references threaded through**

Run: `grep -n "halt_mode" commands/superflow.md`
Expected: matches in Step 0 (table + subsection), Step B1 (variant gate), Step B2 (dispatch guard), Step B3 (variant gate), Step C (dispatch guard), Step P (closing note). At least 8 distinct line matches.

- [ ] **Step 3: Verb-reserved-token warning visible in both places**

Run: `grep -n "Verb tokens are reserved\|Topics literally named after a verb" commands/superflow.md README.md`
Expected: one match in `commands/superflow.md`, one in `README.md`.

- [ ] **Step 4: Step P inserted and Step C still present**

Run: `grep -n "^## Step " commands/superflow.md`
Expected: includes `## Step P — Plan-only no-args picker` AND `## Step C — Execute` (Step P precedes Step C in the file).

- [ ] **Step 5: Frontmatter description updated**

Run: `head -3 commands/superflow.md | grep "Verbs: new, brainstorm"`
Expected: one match.

- [ ] **Step 6: CHANGELOG and WORKLOG land**

Run: `grep -n "^## \[0.3.0\]" CHANGELOG.md && grep -n "v0.3.0 explicit phase verbs" WORKLOG.md`
Expected: both match.

- [ ] **Step 7: Smoke-read the modified prompt for coherence**

Read `commands/superflow.md` end-to-end. Confirm:
- Step 0's routing table flows naturally into the new "halt_mode and flag interactions" subsection.
- Step B1's halt-aware variant reads cleanly alongside the existing `halt_mode == none` branch (no orphaned references to the old single-branch behavior).
- Step B2's dispatch guard precedes the existing first paragraph without disrupting it.
- Step B3's halt-aware close-out replaces the old "Proceed to Step C" sentence cleanly — no dangling reference to a now-gone line.
- Step C's dispatch guard sits between the heading and step 1 without breaking the numbered list.
- Step P is fully self-contained and references Step B0a (Task 7) for the worktree-handling flow.
- Step B0a is well-positioned at the end of B0 and references Step B2 as the next stop.

If any item above fails, open a new task to fix the issue. If all pass, no commit needed (this task is read-only).

- [ ] **Step 8: Final summary**

Print a short summary of: total commits added by this plan (should be 11 — one per Task 1–11), files touched, lines added/removed (from `git diff main..HEAD --stat` if branched, else `git log <task-1-sha>^..HEAD --stat`).

No commit for this task.

---

## Self-review notes (writing-plans skill, not execution)

**Spec coverage:** Each section of the spec maps to a task:

| Spec section | Task |
|---|---|
| Routing table | Task 1 |
| Step 0 — argument parsing additions + flag-interaction rules | Task 1 |
| Step B1 — close-out gate variant | Task 2 |
| Step B2 — dispatch guard | Task 3 |
| Step B3 — close-out gate variant | Task 4 |
| Step C — dispatch guard | Task 5 |
| Step P — plan-only no-args picker | Task 6 |
| `plan --from-spec=<path>` worktree handling | Task 7 |
| Doctor and status interactions (no changes) | (n/a — confirmed in Task 12 implicitly) |
| Documentation: command description | Task 8 |
| Documentation: README verb table | Task 9 |
| Documentation: CHANGELOG | Task 10 |
| Documentation: WORKLOG | Task 11 |
| Edge cases (`/superflow plan --from-spec=` with existing plan, etc.) | Mentioned inline in Task 4 commit message + Task 7's flow; the existing import-overwrite policy applies and doesn't need a new check |

**Placeholder scan:** No "TBD" / "implement later" / "similar to Task N" placeholders. Each task includes the full `new_string` content.

**Type / token consistency:** `halt_mode` value enum is `{none, post-brainstorm, post-plan}` everywhere. New verb names are `new, brainstorm, plan, execute` everywhere. Section name `Step P — Plan-only no-args picker` consistent across Tasks 1, 6, 12. Subsection `Step B0a` consistent across Tasks 1, 6, 7.
