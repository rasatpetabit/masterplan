# Improve Subagents Parallelism — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Audit the masterplan orchestrator prompt and fix CC-2 violations, missing parallel-group annotations, and uncapped return shapes that drive cumulative context growth across sessions.

**Architecture:** Three-wave execution. Wave 1: three parallel Haiku Explore audit agents (Dimensions A/B/C) produce JSON hit lists. Wave 2: single Sonnet implementer applies all Track 1 fixes from the merged hit list (one commit per dimension). Wave 3: single Sonnet implementer adds doctor checks #46 (CC-2 self-enforcement) and #47 (return-shape caps). Inline: internals docs CC-2 wording + self-host audit script step-c.md reference fix.

**Tech Stack:** Markdown prompt files, bash (doctor check bodies, self-host audit script). Verification: grep discriminators, bash -n syntax check.

---

### Task 0: Rebase worktree onto main

**Files:**
- None (git operation — fetches v6.0.0 step-c sub-files and v6.1.0 adversarial-review blocks)

**Codex:** false
**Parallel-group:** none

- [ ] **Step 1: Confirm worktree location and pre-rebase state**

```bash
pwd
# Expected: /srv/dev/superpowers-masterplan/.worktrees/improve-subagents-parallelism
git log --oneline -3
ls parts/step-c*.md
# Expected: only parts/step-c.md present (monolith — sub-files do not exist yet)
```

- [ ] **Step 2: Rebase onto main**

```bash
git rebase main
# Expected: "Successfully rebased" — no conflicts expected (no src edits on this branch)
```

- [ ] **Step 3: Verify v6.0.0 and v6.1.0 files are present**

```bash
ls parts/step-c-resume.md parts/step-c-dispatch.md parts/step-c-verification.md parts/step-c-completion.md
# Expected: all four files present

grep -c "adversarial-review" parts/step-b.md
# Expected: ≥1

grep -c "Check #4[45]" parts/doctor.md
# Expected: 2 (confirms v6.1.0 adversarial-review-integration is present)
```

- [ ] **Step 4: Commit (state update only — no source changes this task)**

No commit needed for this task. Proceed to Wave 1.

---

### Task 1: Audit — Dimension A (inline reads / CC-2 gate misses)

**Files:**
- Reads: `parts/step-0.md`, `parts/step-b.md`, `parts/step-c-resume.md`, `parts/step-c-dispatch.md`, `parts/step-c-verification.md`, `parts/step-c-completion.md`, `parts/doctor.md`

**Codex:** false
**Parallel-group:** audit-wave

Dispatch a Haiku Explore agent with this exact brief:

```
Goal: Find every inline-read site in the masterplan orchestrator parts files that violates CC-2.

CC-2 rule: Dispatch Haiku before reading files >300 lines, or before Bash commands expected to
print >100 lines. A violation is a Read directive or inline file-load used in the orchestrator's
reasoning context WITHOUT a "dispatch Haiku" gate or coordinator DISPATCH-SITE block above it
in the same phase block.

Inputs: Read these files in full:
  parts/step-0.md
  parts/step-b.md  (pay extra attention to the adversarial-review B2/B3 blocks)
  parts/step-c-resume.md
  parts/step-c-dispatch.md
  parts/step-c-verification.md
  parts/step-c-completion.md
  parts/doctor.md

Scope: Read-only. Do not modify any files.

Return: JSON array of {file, line, excerpt (≤80 chars), violation_type}. ≤30 items total.
No prose. No markdown wrapper. Return only the raw JSON array.
If no violations found, return: []
```

- [ ] **Step 1: Dispatch Haiku Explore agent per brief above**
- [ ] **Step 2: Receive findings JSON array**
- [ ] **Step 3: Store findings as Dimension A hit list for Task 4**

Verify: result is a valid JSON array (or `[]`). Record item count.

---

### Task 2: Audit — Dimension B (sequential dispatch eligible for parallel-group)

**Files:**
- Reads: `parts/step-0.md`, `parts/step-b.md`, `parts/step-c-resume.md`, `parts/step-c-dispatch.md`, `parts/step-c-verification.md`, `parts/step-c-completion.md`, `parts/doctor.md`

**Codex:** false
**Parallel-group:** audit-wave

Dispatch a Haiku Explore agent with this exact brief:

```
Goal: Find pairs of consecutive subagent dispatch blocks in the masterplan orchestrator parts
files that are eligible for parallel-group annotation.

Eligibility: both blocks are read-only, neither block's output is an input to the other,
and no parallel-group: annotation is currently present.

Inputs: Read these files in full:
  parts/step-0.md
  parts/step-b.md  (pay extra attention to the adversarial-review B2/B3 blocks)
  parts/step-c-resume.md
  parts/step-c-dispatch.md
  parts/step-c-verification.md
  parts/step-c-completion.md
  parts/doctor.md

Look for: Two or more dispatch/Agent/coordinator-DISPATCH-SITE blocks in sequence where:
  1. Neither block's output feeds the other as input.
  2. No parallel-group: annotation tags either block.
  3. Both are read-only or write only to gitignored paths.

Scope: Read-only. Do not modify any files.

Return: JSON array of {file, lines: [start, end], agent_a, agent_b, dependency_check}. ≤20 items.
No prose. No markdown wrapper. Return only the raw JSON array.
If no eligible pairs found, return: []
```

- [ ] **Step 1: Dispatch Haiku Explore agent per brief above**
- [ ] **Step 2: Receive findings JSON array**
- [ ] **Step 3: Store findings as Dimension B hit list for Task 4**

Verify: result is a valid JSON array (or `[]`). Record item count.

---

### Task 3: Audit — Dimension C (unbounded returns + missing CC-2 gates)

**Files:**
- Reads: `parts/step-0.md`, `parts/step-b.md`, `parts/step-c-resume.md`, `parts/step-c-dispatch.md`, `parts/step-c-verification.md`, `parts/step-c-completion.md`, `parts/doctor.md`

**Codex:** false
**Parallel-group:** audit-wave

Dispatch a Haiku Explore agent with this exact brief:

```
Goal: Find three types of return-shape and dispatch-gate violations in the masterplan orchestrator.

C1 — Uncapped return shapes: Any Brief: block or coordinator DISPATCH-SITE block whose
  Return shape: / return: section lacks max, limit, ≤, or an item-count constraint.
  Extend scan to coordinator dispatch blocks (identified by DISPATCH-SITE: prefix).
  Specifically check coordinator-plan-parser in step-c-dispatch.md: does its tasks[] array
  have an item-count cap?

C2 — Missing CC-2 dispatch gates: 3 or more consecutive Bash-type calls (Read directives,
  Bash blocks, curl, grep, node invocations, external process runs) in sequence feeding one
  decision, with no upstream "dispatch Haiku" or coordinator DISPATCH-SITE gate.

C3 — Unbounded external-process outputs: External process output parsed inline without a
  token/char bound. Look specifically at step-b.md's adversarial-review B2 block for any
  line capturing stdout+stderr without a size limit.

Inputs: Read these files in full:
  parts/step-0.md
  parts/step-b.md
  parts/step-c-resume.md
  parts/step-c-dispatch.md
  parts/step-c-verification.md
  parts/step-c-completion.md
  parts/doctor.md

Scope: Read-only. Do not modify any files.

Return: JSON array of {file, line, sub_type: "C1"|"C2"|"C3", excerpt (≤80 chars)}. ≤40 items.
No prose. No markdown wrapper. Return only the raw JSON array.
If no violations found, return: []
```

- [ ] **Step 1: Dispatch Haiku Explore agent per brief above**
- [ ] **Step 2: Receive findings JSON array**
- [ ] **Step 3: Store findings as Dimension C hit list for Task 4**

Verify: result is a valid JSON array (or `[]`). Record item count.
Confirm a C3 hit exists for step-b.md "Capture full stdout+stderr" (expected per spec).
Confirm a C1 hit exists for coordinator-plan-parser tasks[] (expected per spec).

---

### Task 4: Apply Track 1 fixes from audit findings

**Files:**
- Modify: `parts/step-b.md`
- Modify: `parts/step-c-dispatch.md`
- Modify: `parts/step-c-verification.md` (if Dimension B audit finds annotation opportunities)
- Modify: `parts/step-c-resume.md` (if Dimension A or C audit finds hits)
- Modify: `parts/step-0.md` (if Dimension C audit finds uncapped briefs)

**Codex:** false
**Parallel-group:** none

Three commits: one per dimension.

Two fixes are confirmed from spec analysis and do not require the audit results. Apply them in Step 2 and Step 4 regardless of audit hit list contents.

---

**CONFIRMED FIX — C3: step-b.md adversarial-review companion output cap**

In `parts/step-b.md`, find the line (in the adversarial-review B2 foreground block):

```
      Capture full stdout+stderr as `review_output`.
```

Replace with:

```
      Capture first 8192 chars of stdout+stderr as `review_output` (truncate if longer).
```

---

**CONFIRMED FIX — C1: step-c-dispatch.md coordinator-plan-parser tasks[] item-count cap**

In `parts/step-c-dispatch.md`, find the coordinator-plan-parser return shape line (currently near line 28):

```
   Return shape: {total_tasks, schema_version, tasks: [{idx, name, files, codex_eligible, parallel_group, verify_commands, status}], eligibility_cache_hash, coordinator_version}
```

Replace with:

```
   Return shape: {total_tasks, schema_version, tasks: [{idx, name, files, codex_eligible, parallel_group, verify_commands, status}] (≤ 100 items), eligibility_cache_hash, coordinator_version}
```

---

- [ ] **Step 1: Locate confirmed fix sites**

```bash
grep -n "Capture full stdout+stderr" parts/step-b.md
# Expected: exactly 1 match in the adversarial-review B2 block (~line 210)

grep -n "tasks:.*codex_eligible.*parallel_group" parts/step-c-dispatch.md
# Expected: exactly 1 match in coordinator-plan-parser return shape (~line 28)
```

- [ ] **Step 2: Apply confirmed C3 fix to step-b.md**

Edit `parts/step-b.md`: replace `Capture full stdout+stderr as \`review_output\`.` with `Capture first 8192 chars of stdout+stderr as \`review_output\` (truncate if longer).`

- [ ] **Step 3: Apply confirmed C1 fix to step-c-dispatch.md**

Edit `parts/step-c-dispatch.md`: add `(≤ 100 items)` after the tasks array description in the coordinator-plan-parser return shape.

- [ ] **Step 4: Apply Dimension A hits — CC-2 gate additions**

For each item in the Dimension A JSON hit list:
- Verify the file + line against current file content
- Add a `dispatch Haiku` gate directive immediately before the identified inline read
- Skip items that are already inside a coordinator block (already CC-2-protected)

Format for gate directive: `dispatch Haiku: [read <filename> and summarize relevant sections — return ≤ N key facts as JSON]` on the line before the inline read.

- [ ] **Step 5: Apply Dimension B hits — parallel-group annotations**

For each item in the Dimension B JSON hit list:
- Verify the file + line
- Add `parallel-group: <descriptive-name>` annotation to both blocks in the eligible pair
- Name the group after the phase: e.g., `parallel-group: pre-exec-checks`, `parallel-group: spec-gate-reads`
- Both blocks in the pair get the same group name

- [ ] **Step 6: Apply Dimension C hits — return-shape caps and gate additions**

For each C1 item in the Dimension C JSON hit list (excluding the confirmed coordinator-plan-parser fix already applied):
- Verify the file + line
- Add a size cap using `(≤ 30 items)` for array fields or `(≤ 4096 chars)` for text fields
- Use tighter bounds where the context makes a smaller number appropriate

For C2 items (excluding any already handled by Dimension A): add a `dispatch Haiku` gate upstream.

For C3 items (excluding the confirmed step-b.md fix): add a char/token bound to the external-process capture.

- [ ] **Step 7: Commit Dimension A fixes**

```bash
# Stage only files changed by Dimension A fixes
git add parts/step-c-resume.md parts/step-0.md  # adjust for actual changed files
git commit -m "fix(CC-2): add Haiku dispatch gates for inline reads (Dimension A)"
# If no Dimension A fixes were needed (audit returned []), skip this commit
```

- [ ] **Step 8: Commit Dimension B fixes**

```bash
git add parts/step-c-verification.md  # adjust for actual changed files
git commit -m "fix(parallel): add parallel-group annotations for independent dispatch (Dimension B)"
# If no Dimension B fixes were needed (audit returned []), skip this commit
```

- [ ] **Step 9: Commit Dimension C fixes**

```bash
git add parts/step-b.md parts/step-c-dispatch.md  # and any other files with C fixes
git commit -m "fix(return-shape): cap unbounded returns and external process outputs (Dimension C)"
```

- [ ] **Step 10: Run Track 1 verification**

```bash
# C3 fix applied
grep -n "8192\|first.*chars\|truncate" parts/step-b.md
# Expected: ≥1 hit in the adversarial-review B2 block

# C1 coordinator-plan-parser fix applied
grep -n "tasks.*≤\|≤.*items\|100 items" parts/step-c-dispatch.md
# Expected: ≥1 hit

# Parallel-group annotations present (if Dimension B found hits)
grep -rn "parallel-group" parts/step-c-*.md
# Expected: ≥1 hit

# CC-2 gates present (if Dimension A found hits)
grep -rn "dispatch Haiku\|DISPATCH-SITE" parts/step-c-*.md | wc -l
# Expected: ≥ count of existing DISPATCH-SITE occurrences before this task

# Syntax check
bash -n hooks/masterplan-telemetry.sh
# Expected: exit 0
```

---

### Task 5: Doctor checks #46 and #47

**Files:**
- Modify: `parts/doctor.md`

**Codex:** false
**Parallel-group:** none

Append two new checks after Check #45 and update the complexity-aware check set lines.

---

**Check #46 full text** (append after the `---` separator at end of Check #45):

````markdown
## Check #46 — CC-2 self-enforcement

**Severity:** Warning
**Action:** Report-only.
**Scope:** Prompt-scoped (scans `parts/step-*.md`). Fires regardless of plan complexity.
**Added:** v6.2.0 (improve-subagents-parallelism).

Scan `parts/step-*.md` for 3+ consecutive Bash-type directives feeding one decision without
an upstream `dispatch Haiku` or `DISPATCH-SITE:` gate. The CC-2 rule (dispatch Haiku before
reading files >300 lines or before commands expected to print >100 lines) degrades silently as
the prompt evolves; this check enforces it at lint time.

```bash
violations=0
for f in parts/step-0.md parts/step-b.md parts/step-c-resume.md parts/step-c-dispatch.md \
          parts/step-c-verification.md parts/step-c-completion.md parts/doctor.md; do
  [ -r "$f" ] || continue
  consecutive=0
  gate_seen=0
  while IFS= read -r line; do
    case "$line" in
      *"dispatch Haiku"*|*"DISPATCH-SITE:"*) gate_seen=1; consecutive=0 ;;
      *"Read \`"*|*"\`\`\`bash"*|*"node "*|*"bash -"*|*"curl "*|*"grep "*)
        consecutive=$((consecutive + 1))
        if [ "$consecutive" -ge 3 ] && [ "$gate_seen" -eq 0 ]; then
          echo "WARN $f: 3+ consecutive Bash-type directives without upstream Haiku gate (near: $line)"
          violations=$((violations + 1))
          consecutive=0
        fi
        ;;
      "") consecutive=0; gate_seen=0 ;;
    esac
  done < "$f"
done
[ "$violations" -eq 0 ] && echo "Check #46: PASS" || echo "Check #46: WARN ($violations sequence(s) found)"
```

Report-only.

---
````

---

**Check #47 full text** (append after Check #46):

````markdown
## Check #47 — Return-shape caps

**Severity:** Warning
**Action:** Report-only.
**Scope:** Prompt-scoped (scans `parts/step-*.md`). Fires regardless of plan complexity.
**Added:** v6.2.0 (improve-subagents-parallelism).

Scan `parts/step-*.md` for `Return shape:` blocks (in `Brief:` sections and coordinator
`DISPATCH-SITE:` blocks) that lack any of `max`, `≤`, `limit`, or an item-count constraint.
Uncapped return shapes allow subagents to return unbounded content directly into the
orchestrator's context.

```bash
violations=0
for f in parts/step-0.md parts/step-b.md parts/step-c-resume.md parts/step-c-dispatch.md \
          parts/step-c-verification.md parts/step-c-completion.md parts/doctor.md; do
  [ -r "$f" ] || continue
  grep -n "Return shape:\|return shape:" "$f" 2>/dev/null | while IFS=: read -r lineno rest; do
    context="$(awk -v s="$lineno" -v e="$((lineno+3))" 'NR>=s && NR<=e' "$f" 2>/dev/null)"
    if ! echo "$context" | grep -qiE "≤|max|limit|[0-9]+ items?|[0-9]+ chars?"; then
      echo "WARN $f:$lineno: Return shape block lacks item/char cap"
      violations=$((violations + 1))
    fi
  done
done
[ "$violations" -eq 0 ] && echo "Check #47: PASS" || echo "Check #47: WARN ($violations uncapped block(s))"
```

Report-only.
````

---

- [ ] **Step 1: Verify current last check number**

```bash
grep "^## Check #" parts/doctor.md | tail -3
# Expected: last entry is "## Check #45"
```

- [ ] **Step 2: Verify current complexity-aware check set lines**

```bash
grep -n "currently #" parts/doctor.md
# Expected: lines ~59-60 listing medium/high check sets ending around #43/#44/#45
```

- [ ] **Step 3: Append Check #46 to parts/doctor.md**

Append the full Check #46 text (including the bash block) after the closing `---` of Check #45 at the end of the file.

- [ ] **Step 4: Append Check #47 to parts/doctor.md**

Append the full Check #47 text (including the bash block) immediately after Check #46.

- [ ] **Step 5: Update complexity-aware check sets**

Checks #46 and #47 are prompt-scoped — they scan the orchestrator files themselves, not per-plan artifacts. Add them to the `low`, `medium`, and `high` plan check sets:

Find lines like:
```
- `medium` plans: run all plan-scoped checks (currently #1-24, #26, #28, #29, #32, #34, #35, #41, #42, #43) except #22 and #40 (both high-only).
- `high` plans: run all plan-scoped checks (currently #1-24, #26, #28, #29, #32, #34, #35, #40, #41, #42, #43) INCLUDING #22 (high-complexity rigor evidence) and #40 ...
```

For each: append `, #46, #47` before the closing `)` of the check list.
Also add `, #46, #47` to the `low` plan check list (since prompt-scoped checks apply globally).

- [ ] **Step 6: Verify check additions**

```bash
grep -c "^## Check #4[67]" parts/doctor.md
# Expected: 2

grep -c "Check #4[67]" parts/doctor.md
# Expected: ≥6 (2 headings + references in check sets for low/medium/high + body text)

# Verify the bash blocks don't break syntax extraction
bash -n <(grep -A100 "^## Check #46" parts/doctor.md | sed -n '/```bash/,/```/p' | sed '1d;$d')
# Expected: exit 0 (bash syntax clean)

bash -n <(grep -A100 "^## Check #47" parts/doctor.md | sed -n '/```bash/,/```/p' | sed '1d;$d')
# Expected: exit 0 (bash syntax clean)

bash -n hooks/masterplan-telemetry.sh
# Expected: exit 0
```

- [ ] **Step 7: Commit doctor checks**

```bash
git add parts/doctor.md
git commit -m "feat(doctor): add Check #46 (CC-2 self-enforcement) and Check #47 (return-shape caps)"
```

---

### Task 6: Internals docs CC-2 wording + self-host audit step-c.md fix

**Files:**
- Modify: `docs/internals/coordinator-pattern.md`
- Modify: `docs/internals/wave-dispatch.md`
- Modify: `bin/masterplan-self-host-audit.sh`

**Codex:** false
**Parallel-group:** none

Three targeted edits. The self-host audit fix is a correctness bug: `parts/step-c.md` no longer exists after the v6.0.0 split; the `--brief-style` scan silently no-ops on that file, leaving the 4 sub-files unscanned.

---

**Edit 1 — coordinator-pattern.md: add CC-2 trigger to "When to Add a Coordinator"**

Current "When to Add a Coordinator" section ends at item 3. Add item 4:

```markdown
4. The orchestrator would otherwise run 3+ consecutive Bash-type directives (inline reads, shell
   commands, external process invocations) feeding one decision without a Haiku gate — CC-2
   mandates a gate, and a coordinator is the preferred gate form when the read target is a
   structured artifact.
```

---

**Edit 2 — wave-dispatch.md: add CC-2 note under "### Rules"**

Current Rules section has 3 bullets. Add a 4th:

```markdown
- Orchestrator must not accumulate 3+ consecutive inline reads or Bash-type calls without a
  coordinator or `dispatch Haiku` gate (CC-2 rule). Add a coordinator when the call target is
  a structured artifact ≥20KB; use a Haiku gate for smaller reads or shell commands.
```

---

**Edit 3 — masterplan-self-host-audit.sh: replace stale step-c.md scan with 4 sub-file scans**

In `bin/masterplan-self-host-audit.sh`, `check_brief_style()` function (~line 878):

Find and replace:

```bash
  _brief_style_scan_file "${REPO_ROOT}/parts/step-c.md" \
    "DISPATCH-SITE: step-c\\.md:[a-zA-Z0-9_-]+" \
    0 0
```

With:

```bash
  _brief_style_scan_file "${REPO_ROOT}/parts/step-c-resume.md" \
    "DISPATCH-SITE: step-c-resume\\.md:[a-zA-Z0-9_-]+" \
    0 0
  _brief_style_scan_file "${REPO_ROOT}/parts/step-c-dispatch.md" \
    "DISPATCH-SITE: (step-c-dispatch\\.md:[a-zA-Z0-9_-]+|coordinator-[a-zA-Z0-9_-]+)" \
    0 0
  _brief_style_scan_file "${REPO_ROOT}/parts/step-c-verification.md" \
    "DISPATCH-SITE: (step-c-verification\\.md:[a-zA-Z0-9_-]+|coordinator-[a-zA-Z0-9_-]+)" \
    0 0
  _brief_style_scan_file "${REPO_ROOT}/parts/step-c-completion.md" \
    "DISPATCH-SITE: step-c-completion\\.md:[a-zA-Z0-9_-]+" \
    0 0
```

---

- [ ] **Step 1: Apply Edit 1 to coordinator-pattern.md**

Edit `docs/internals/coordinator-pattern.md`: append item 4 to the "When to Add a Coordinator" numbered list.

- [ ] **Step 2: Apply Edit 2 to wave-dispatch.md**

Edit `docs/internals/wave-dispatch.md`: add the CC-2 bullet to the "### Rules" section.

- [ ] **Step 3: Locate stale reference in audit script**

```bash
grep -n "step-c\.md" bin/masterplan-self-host-audit.sh
# Expected: ≥1 match (the _brief_style_scan_file call to replace)
```

- [ ] **Step 4: Apply Edit 3 to masterplan-self-host-audit.sh**

Replace the stale 3-line `_brief_style_scan_file` call with the 4 sub-file calls per the edit above.

- [ ] **Step 5: Run verification**

```bash
# CC-2 wording present in internals docs
grep -c "CC-2" docs/internals/coordinator-pattern.md
# Expected: ≥1

grep -c "CC-2" docs/internals/wave-dispatch.md
# Expected: ≥1

# Stale reference removed
grep "step-c\.md" bin/masterplan-self-host-audit.sh
# Expected: zero matches (or only in comments)

# New sub-file references present
grep -c "step-c-dispatch\|step-c-verification\|step-c-resume\|step-c-completion" bin/masterplan-self-host-audit.sh
# Expected: ≥4

# Script syntax clean
bash -n bin/masterplan-self-host-audit.sh
# Expected: exit 0

# Self-test: --brief-style completes without "not found" warnings
bin/masterplan-self-host-audit.sh --brief-style 2>&1
# Expected: "✓ brief-style: ..." line; no "Skipping brief-style check: ... not found" lines
```

- [ ] **Step 6: Commit inline docs + audit script fix**

```bash
git add docs/internals/coordinator-pattern.md docs/internals/wave-dispatch.md bin/masterplan-self-host-audit.sh
git commit -m "docs: add CC-2 wording to internals; fix stale step-c.md scan in self-host audit"
```

---

## Post-completion verification

Run all spec verification checks against the final state:

```bash
# Return-shape caps added
grep -rn "≤\|max\|limit" parts/step-c-*.md | grep -i "return\|shape"

# Adversarial-review companion cap in step-b.md
grep -n "8192\|first.*chars\|truncate" parts/step-b.md

# coordinator-plan-parser tasks cap in step-c-dispatch.md
grep -n "tasks.*≤\|≤.*items\|100 items" parts/step-c-dispatch.md

# Parallel-group annotations present
grep -rn "parallel-group" parts/step-c-*.md

# Doctor checks #46 + #47 exist
grep -c "Check #4[67]" parts/doctor.md
# Expected: ≥6

# Hook syntax clean
bash -n hooks/masterplan-telemetry.sh

# Self-host audit syntax clean + no stale reference
bash -n bin/masterplan-self-host-audit.sh
grep -c "step-c-dispatch\|step-c-verification" bin/masterplan-self-host-audit.sh
# Expected: ≥4
```
