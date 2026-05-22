# Improve masterplan token use efficiency — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce orchestrator-context tokens per execute turn by ≥30% via baseline telemetry, prose pruning, step-c.md 4-way split, and coordinator-subagent pattern at 5 dispatch sites.

**Architecture:** Four phases applied sequentially: (P0) measure first via turn_context_bytes telemetry, (P1) prose-prune phase files using 1-sentence rationale rule, (P2) split 110KB step-c.md into 4 load-on-demand sub-files reducing a typical execute turn from 110KB to ~50KB, (P3) introduce 5 coordinator subagents that pay context cost internally and return ≤1000-token JSON. Inline fallbacks at every coordinator site. docs/internals.md restructured into per-coordinator focused docs.

**Tech Stack:** Markdown (orchestrator phase files), Bash (telemetry hook, bin/ scripts), YAML (state.yml), JSONL (events). Verification is local-static only: `bash -n`, `wc -c`, `grep` discriminators. No build host or runtime required.

---

### Task 1: Add turn_context_bytes event to telemetry hook

**Files:** hooks/masterplan-telemetry.sh
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L66-L100](spec.md#L66-L100)
**Verify:**
```bash
bash -n hooks/masterplan-telemetry.sh
grep -c "turn_context_bytes" hooks/masterplan-telemetry.sh
grep -c "file-load" hooks/masterplan-telemetry.sh
```

- [ ] **Step 1: Find the hook's turn-end section**

```bash
grep -n "CLAUDE_USAGE_INPUT_TOKENS\|turn_end\|emit_turn\|^# Section\|^##" hooks/masterplan-telemetry.sh | head -30
```

Expected: lines showing the hook's section structure and where per-turn JSONL events are emitted.

- [ ] **Step 2: Add parse_file_load_markers function**

Add this bash function in the utility-functions section (before the main dispatch block):

```bash
# Parse <masterplan-trace file-load path=P bytes=N> markers from a text block.
parse_file_load_markers() {
  local text="$1"
  echo "$text" \
    | grep -oP '<masterplan-trace file-load path=\S+ bytes=\d+>' \
    | sed 's/.*path=\([^ ]*\) bytes=\([0-9]*\)>/{"path":"\1","bytes":\2}/' \
    | jq -s '.' 2>/dev/null || echo '[]'
}
```

- [ ] **Step 3: Add emit_turn_context_bytes function**

Add in the same utility section:

```bash
# Emit turn_context_bytes event to the active bundle's events.jsonl.
# Usage: emit_turn_context_bytes "$events_file" "$turn_num" "$verb" "$transcript"
emit_turn_context_bytes() {
  local events_file="$1"
  local turn_num="${2:-0}"
  local verb="${3:-unknown}"
  local transcript="$4"

  [ -f "$events_file" ] || return 0

  local loaded_files
  loaded_files=$(parse_file_load_markers "$transcript")

  local input_tokens_field=""
  if [ -n "${CLAUDE_USAGE_INPUT_TOKENS:-}" ]; then
    input_tokens_field="\"input_tokens\":${CLAUDE_USAGE_INPUT_TOKENS},"
  fi

  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  printf '{"event":"turn_context_bytes","turn":%s,"verb":"%s","loaded_files":%s,%s"ts":"%s"}\n' \
    "$turn_num" "$verb" "$loaded_files" "$input_tokens_field" "$ts" \
    >> "$events_file"
}
```

- [ ] **Step 4: Wire into the turn-end path**

Locate where the hook processes the turn-end event and has access to `$BUNDLE_PATH` / `$EVENTS_FILE` (or equivalent). Add one call:

```bash
emit_turn_context_bytes "${EVENTS_FILE:-${BUNDLE_PATH}/events.jsonl}" \
  "${TURN_NUM:-0}" "${RESOLVED_VERB:-unknown}" "${TURN_TRANSCRIPT:-}"
```

To find the right insertion point:

```bash
grep -n "BUNDLE_PATH\|EVENTS_FILE\|TURN_NUM\|RESOLVED_VERB" hooks/masterplan-telemetry.sh | tail -20
```

Place the call after the existing per-turn anomaly/failure checks, before the hook exits 0.

- [ ] **Step 5: Add file-load to recognized marker types**

Search for the section that parses `masterplan-trace` marker types (likely a `case` or `grep -E` block):

```bash
grep -n "skill-invoke\|state-write\|gate=fire\|phase=in\|phase=out" hooks/masterplan-telemetry.sh | head -10
```

Add `file-load` to the recognized-marker list in that block so the hook does not emit "unknown marker" warnings for the new breadcrumb type.

- [ ] **Step 6: Verify**

```bash
bash -n hooks/masterplan-telemetry.sh && echo "PASS: syntax OK"
grep -c "turn_context_bytes" hooks/masterplan-telemetry.sh   # ≥2
grep -c "file-load" hooks/masterplan-telemetry.sh           # ≥1
```

- [ ] **Step 7: Commit**

```bash
git add hooks/masterplan-telemetry.sh
git commit -m "feat(telemetry): add turn_context_bytes event + file-load marker parsing"
```

---

### Task 2: Add baseline subcommand to bin/masterplan-codex-usage.sh

**Files:** bin/masterplan-codex-usage.sh
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L89-L100](spec.md#L89-L100)
**Verify:**
```bash
bash -n bin/masterplan-codex-usage.sh
grep -c "baseline\|cmd_baseline" bin/masterplan-codex-usage.sh
bash bin/masterplan-codex-usage.sh baseline 2>&1 | head -5
```

- [ ] **Step 1: Inspect existing dispatch structure**

```bash
grep -n "^[a-z_]*)" bin/masterplan-codex-usage.sh | head -20
wc -l bin/masterplan-codex-usage.sh
```

Expected: existing `case "$1" in` block with subcommands.

- [ ] **Step 2: Add cmd_baseline function**

Add before the main dispatch block:

```bash
cmd_baseline() {
  local runs_dir="${MASTERPLAN_RUNS_DIR:-docs/masterplan}"
  local tmpfile
  tmpfile=$(mktemp /tmp/masterplan-baseline-XXXXXX)
  trap 'rm -f "$tmpfile"' EXIT

  # Collect all turn_context_bytes events from non-archived bundles
  find "$runs_dir" -name "events.jsonl" -not -path "*/archived/*" 2>/dev/null \
    | xargs grep -h '"event":"turn_context_bytes"' 2>/dev/null \
    > "$tmpfile"

  if [ ! -s "$tmpfile" ]; then
    echo "No turn_context_bytes events found. Run /masterplan turns first (requires Task 1)."
    return 0
  fi

  # Print header
  printf "%-14s %-20s %-17s %s\n" "verb" "median_input_tokens" "p90_input_tokens" "sample_n"
  printf "%-14s %-20s %-17s %s\n" "----" "-------------------" "----------------" "--------"

  # Compute per-verb stats using jq + awk
  jq -r '.verb' "$tmpfile" | sort -u | while IFS= read -r verb; do
    local tokens
    tokens=$(grep "\"verb\":\"${verb}\"" "$tmpfile" \
             | jq -r '.input_tokens // empty' | grep -E '^[0-9]+$' | sort -n)
    local n
    n=$(echo "$tokens" | grep -c .)
    [ "$n" -eq 0 ] && continue
    local median p90
    median=$(echo "$tokens" | awk -v n="$n" 'NR==int(n/2)+1{print}')
    p90=$(echo "$tokens" | awk -v n="$n" 'NR==int(n*0.9)+1{print}')
    printf "%-14s %-20s %-17s %s\n" "$verb" "${median:-N/A}" "${p90:-N/A}" "$n"
  done
}
```

- [ ] **Step 3: Wire into dispatch**

In the `case "$1" in` block, add:

```bash
baseline)
  cmd_baseline
  ;;
```

Also add `baseline` to the usage/help output if one exists:

```bash
grep -n "usage\|help\|Usage\|USAGE" bin/masterplan-codex-usage.sh | head -5
```

- [ ] **Step 4: Verify**

```bash
bash -n bin/masterplan-codex-usage.sh && echo "PASS: syntax OK"
grep -c "cmd_baseline\|baseline" bin/masterplan-codex-usage.sh  # ≥3
bash bin/masterplan-codex-usage.sh baseline
# Expected: header + "No turn_context_bytes events found." OR data rows
```

- [ ] **Step 5: Commit**

```bash
git add bin/masterplan-codex-usage.sh
git commit -m "feat(bin): add baseline subcommand to masterplan-codex-usage.sh"
```

> **Note:** After committing T1 and T2, run 2–3 representative `/masterplan` invocations (brainstorm, execute, doctor) and then run `bin/masterplan-codex-usage.sh baseline` to record the pre-v6 token baseline before proceeding to Phase 1 prose pruning.

---

### Task 3: Prose-prune parts/step-0.md (47KB → ≤30KB)

**Files:** parts/step-0.md
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L118-L143](spec.md#L118-L143)
**Verify:**
```bash
wc -c parts/step-0.md       # target: ≤30720
grep -c "Why:" parts/step-0.md   # must drop ≥50% from baseline
```

- [ ] **Step 1: Record baseline**

```bash
wc -c parts/step-0.md
grep -c "Why:" parts/step-0.md
```

Record both numbers; post-edit both must meet their targets.

- [ ] **Step 2: Apply 1-sentence rationale rule to every Why:/Rationale: block**

```bash
grep -n "Why:\|Rationale:" parts/step-0.md
```

For each multi-sentence block, compress to ≤1 sentence. If the rationale genuinely needs more context, add `> See docs/internals/<relevant-doc>.md §<section>.` and preserve the full text in that doc (create the doc in Phase 3 tasks if not yet created).

Primary multi-sentence targets:
- §Invocation sentinel **Why:** block (~5 sentences about the empty-output observability problem)
- §Codex availability detection — the `scan-then-ping` mode rationale paragraph
- `degrade-loudly` self-doubt cross-check **Why:** paragraph (~5 sentences)
- `--resume=<path>` worktree-aware resolution **Why:** block (~4 sentences)
- §Breadcrumb emission contract **Why:** block (~3 sentences)

- [ ] **Step 3: Trim compaction-notice to 2-signal detection**

Find §Compaction-recent notice. Remove signal #3 (the JSONL session-file read):

```bash
grep -n "jsonl\|session-id\|type.*summary\|30 minutes\|PID\|mtime" parts/step-0.md
```

Delete the third signal block (lines referencing `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` and `"type": "summary"`). Keep only:
1. System-reminder substring match for `"session was compacted"`
2. Preceding-message `/compact` token match

- [ ] **Step 4: Move --resume multi-match edge-case prose to contracts/**

The 3-case branching logic in §`--resume=<path>` worktree-aware path resolution (exactly-one-match / zero-matches / multiple-matches sub-AUQ variants) is ~40 lines. Move to `parts/contracts/run-bundle.md §--resume path resolution` and replace the removed block with:

```markdown
> See `parts/contracts/run-bundle.md §--resume path resolution` for full multi-match branching.
```

- [ ] **Step 5: Move codex-degradation self-doubt narrative**

The `degradation_self_doubt` paragraph inside `degrade-loudly` step 0 is ~8 historical-context lines. Compress to 1 sentence in step-0.md and append the full context to `parts/contracts/run-bundle.md §Codex degradation evidence`.

- [ ] **Step 6: Verify size**

```bash
wc -c parts/step-0.md        # target: ≤30720
grep -c "Why:" parts/step-0.md   # ≥50% fewer than baseline
```

- [ ] **Step 7: Commit**

```bash
git add parts/step-0.md parts/contracts/run-bundle.md
git commit -m "perf(step-0): prose-prune 47KB → ≤30KB"
```

---

### Task 4: Prose-prune parts/step-b.md (48KB → ≤28KB)

**Files:** parts/step-b.md
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L118-L143](spec.md#L118-L143)
**Verify:**
```bash
wc -c parts/step-b.md    # target: ≤28672
grep -c "Why:" parts/step-b.md
```

- [ ] **Step 1: Record baseline**

```bash
wc -c parts/step-b.md
grep -c "Why:" parts/step-b.md
```

- [ ] **Step 2: Apply 1-sentence rationale rule**

```bash
grep -n "Why:\|Rationale:" parts/step-b.md
```

Primary multi-sentence targets:
- §Step B1 **Why this gate exists:** (~4 sentences about the re-engagement gate rationale)
- §Step B2 re-engagement gate **Why:** (~3 sentences)
- §Step B0 §Scope-overlap fingerprint check — the SCOPE_OVERLAP_THRESHOLD rationale
- The "Why partition this way" block in B1 step 2 (~4 sentences about Haiku A/B/C split rationale)

- [ ] **Step 3: Move Haiku A/B/C full brief bodies to docs/internals/brainstorm-anchor.md**

The three Haiku brief blocks in B1 step 2 (Haiku A, B, C with full `Goal / Read source / Constraints / Return shape` sections) total ~60 lines. Replace each with a compact dispatch reference:

```markdown
**Haiku A — project-docs.** Reads AGENTS.md/CLAUDE.md/WORKLOG.md (limit 500/500/200). Returns `{source_class: "project-docs", facts, extracted: {repo_role_hint, in_scope_paths_hint, out_of_scope_repos_hint, verification_ceiling_hint, mode_hint}, notes}`. Full brief: `docs/internals/brainstorm-anchor.md §Haiku A`.

**Haiku B — run-state.** Reads most-recent bundle state.yml/events.jsonl/spec.md (limit 300 each). `mode_hint` is highest-signal field. Full brief: `docs/internals/brainstorm-anchor.md §Haiku B`.

**Haiku C — repo-sketch.** Runs `rg --files <repo-root> | head -200`. Full brief: `docs/internals/brainstorm-anchor.md §Haiku C`.
```

The full briefs will be written to `docs/internals/brainstorm-anchor.md` in Task 13.

- [ ] **Step 4: Move scope-overlap algorithm to contracts/**

B0 steps 1b–1d (Jaccard similarity computation, ~40 lines) → move to `parts/contracts/run-bundle.md §Scope-overlap fingerprint`. Replace with:

```markdown
> Full scope-overlap algorithm: `parts/contracts/run-bundle.md §Scope-overlap fingerprint`.
```

- [ ] **Step 5: Compress merge-rules narrative**

B1 step 3 merge rules: remove parenthetical `(Project docs are most specific; sketch ground-truths; run-state has it only when spec.md happened to record it.)` style annotations. Keep the rule table; remove the "why" column prose.

- [ ] **Step 6: Verify size**

```bash
wc -c parts/step-b.md    # target: ≤28672
```

- [ ] **Step 7: Commit**

```bash
git add parts/step-b.md parts/contracts/run-bundle.md
git commit -m "perf(step-b): prose-prune 48KB → ≤28KB"
```

---

### Task 5: Prose-prune commands/masterplan.md (11KB → ≤9KB)

**Files:** commands/masterplan.md
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L118-L143](spec.md#L118-L143)
**Verify:**
```bash
wc -c commands/masterplan.md    # target: ≤9216
```

- [ ] **Step 1: Record baseline**

```bash
wc -c commands/masterplan.md
```

- [ ] **Step 2: Compress CC-2 boot banner narrative**

The `**Strict prohibitions on the version slot**` block (6 bullets) is verbose. Replace with:

```markdown
**Version slot:** parsed semver from plugin.json, or literal `vUNKNOWN` on all-fail. No placeholder tokens (`v?`, `vTBD`, etc.).
```

The `**Fallback**` explanation (3 sentences) compresses to:

```markdown
**Fallback (all three Read attempts fail):** emit `vUNKNOWN`.
```

- [ ] **Step 3: Trim CC-3 trampoline narrative**

In §CC-3-trampoline, the "Scope note" and "Authoring rule" paragraphs are duplicated in step-0.md's CC-3-trampoline anchor. Remove both from commands/masterplan.md, keeping only the Sequence numbered list.

- [ ] **Step 4: Trim halt_mode flag-interaction prose**

```bash
grep -n "halt_mode\|foot.gun\|/loop.*masterplan" commands/masterplan.md
```

Each warning has 2–3 sentences. Compress to 1 sentence each.

- [ ] **Step 5: Verify size**

```bash
wc -c commands/masterplan.md    # target: ≤9216
```

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md
git commit -m "perf(router): prose-prune 11KB → ≤9KB"
```

---

### Task 6: Prose-prune parts/doctor.md per-check rationale blocks

**Files:** parts/doctor.md
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L118-L143](spec.md#L118-L143)
**Verify:**
```bash
grep -c "Why this check\|Why:" parts/doctor.md
# must drop compared to baseline (each Why: block ≤1 sentence post-edit)
```

- [ ] **Step 1: Record baseline**

```bash
wc -c parts/doctor.md
grep -c "Why this check\|Why:" parts/doctor.md
```

- [ ] **Step 2: Apply 1-sentence rationale rule to every check's Why: block**

```bash
grep -n "Why this check\|Why:" parts/doctor.md | head -60
```

For each multi-sentence block, compress to 1 sentence. Pattern to apply: keep the sentence that names the constraint or failure mode; drop historical-context sentences.

If a check's rationale needs more than 1 sentence for correctness, add `> Full rationale: docs/internals/doctor.md §Check #N.` — that doc is created in Task 15.

- [ ] **Step 3: Verify**

```bash
wc -c parts/doctor.md
grep -c "Why this check\|Why:" parts/doctor.md    # each Why: should be 1 sentence now
```

- [ ] **Step 4: Commit**

```bash
git add parts/doctor.md
git commit -m "perf(doctor): compress per-check rationale to 1 sentence each"
```

---

### Task 7: Create parts/step-c-resume.md (Step C1 content)

**Files:** parts/step-c-resume.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L148-L165](spec.md#L148-L165)
**Verify:**
```bash
test -f parts/step-c-resume.md
wc -c parts/step-c-resume.md    # target: ≤25600
grep "Loaded by: execute" parts/step-c-resume.md
```

- [ ] **Step 1: Identify Step C1 section boundaries**

```bash
grep -n "^### Step C1\|^### Step C2\|^## Step C\b" parts/step-c.md | head -10
```

Record the start line of C1 and the start line of C2 (C1 content ends just before C2).

- [ ] **Step 2: Create parts/step-c-resume.md**

```bash
cat > parts/step-c-resume.md << 'HEADER'
<!-- Loaded by: execute path, condition: every execute turn / bare /masterplan resume
     Loads after: step-0.md bootstrap completes
     Parts loaded next: step-c-dispatch.md (before first task dispatch) -->

HEADER
```

Then append Step C1 content extracted from step-c.md (lines from the C1 heading through just before the C2 heading). Apply Phase 1's 1-sentence rationale rule to any multi-sentence Why: blocks while doing so.

```bash
# Identify the line range first:
grep -n "^### Step C1\|^### Step C2" parts/step-c.md
# Then extract (substitute actual line numbers):
sed -n '<C1_start>,<C2_start-1>p' parts/step-c.md >> parts/step-c-resume.md
```

- [ ] **Step 3: Verify size and load comment**

```bash
wc -c parts/step-c-resume.md    # target: ≤25600
grep "Loaded by: execute" parts/step-c-resume.md
```

If the extracted content exceeds 25600 bytes, apply additional 1-sentence rationale pruning to Why: blocks within it.

- [ ] **Step 4: Commit**

```bash
git add parts/step-c-resume.md
git commit -m "feat(step-c): create step-c-resume.md (C1 resume controller, ≤25KB)"
```

---

### Task 8: Create parts/step-c-dispatch.md (Step C2 content)

**Files:** parts/step-c-dispatch.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L148-L165](spec.md#L148-L165)
**Verify:**
```bash
test -f parts/step-c-dispatch.md
wc -c parts/step-c-dispatch.md    # target: ≤25600
grep "Loaded by: execute" parts/step-c-dispatch.md
```

- [ ] **Step 1: Identify Step C2 section boundaries**

```bash
grep -n "^### Step C2\|^### Step C3\|^## Step C\b" parts/step-c.md | head -10
```

- [ ] **Step 2: Create parts/step-c-dispatch.md**

```bash
cat > parts/step-c-dispatch.md << 'HEADER'
<!-- Loaded by: execute path, condition: before first task dispatch in wave assembly
     Loads after: step-c-resume.md completes C1 state validation
     Parts loaded next: step-c-verification.md (after each task completes) -->

HEADER
# Then append Step C2 content (wave dispatch, eligibility cache build, Codex routing):
grep -n "^### Step C2\|^### Step C3" parts/step-c.md
sed -n '<C2_start>,<C3_start-1>p' parts/step-c.md >> parts/step-c-dispatch.md
```

Apply 1-sentence rationale rule to any multi-sentence Why: blocks in the extracted content.

- [ ] **Step 3: Verify size**

```bash
wc -c parts/step-c-dispatch.md    # target: ≤25600
```

- [ ] **Step 4: Commit**

```bash
git add parts/step-c-dispatch.md
git commit -m "feat(step-c): create step-c-dispatch.md (C2 wave dispatch, ≤25KB)"
```

---

### Task 9: Create parts/step-c-verification.md (Step C3 content)

**Files:** parts/step-c-verification.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L148-L165](spec.md#L148-L165)
**Verify:**
```bash
test -f parts/step-c-verification.md
wc -c parts/step-c-verification.md    # target: ≤20480
grep "Loaded by: execute" parts/step-c-verification.md
```

- [ ] **Step 1: Identify Step C3 section boundaries**

```bash
grep -n "^### Step C3\|^### Step C4\|^## Step C\b" parts/step-c.md | head -10
```

- [ ] **Step 2: Create parts/step-c-verification.md**

```bash
cat > parts/step-c-verification.md << 'HEADER'
<!-- Loaded by: execute path, condition: after each task implementer returns
     Loads after: task dispatch completes
     Parts loaded next: step-c-completion.md (on plan completion or failure) -->

HEADER
grep -n "^### Step C3\|^### Step C4" parts/step-c.md
sed -n '<C3_start>,<C4_start-1>p' parts/step-c.md >> parts/step-c-verification.md
```

Content: PASS patterns, trust-skip logic, G.1 mitigation, verify-pattern override. Apply 1-sentence rationale rule.

- [ ] **Step 3: Verify size**

```bash
wc -c parts/step-c-verification.md    # target: ≤20480
```

- [ ] **Step 4: Commit**

```bash
git add parts/step-c-verification.md
git commit -m "feat(step-c): create step-c-verification.md (C3 verification, ≤20KB)"
```

---

### Task 10: Create parts/step-c-completion.md (Steps C4-C6 content)

**Files:** parts/step-c-completion.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L148-L165](spec.md#L148-L165)
**Verify:**
```bash
test -f parts/step-c-completion.md
wc -c parts/step-c-completion.md    # target: ≤20480
grep "Loaded by: execute" parts/step-c-completion.md
```

- [ ] **Step 1: Identify Step C4 start and end-of-step-c**

```bash
grep -n "^### Step C4\|^### Step C5\|^### Step C6\|^---$\|^# Step" parts/step-c.md | tail -20
```

- [ ] **Step 2: Create parts/step-c-completion.md**

```bash
cat > parts/step-c-completion.md << 'HEADER'
<!-- Loaded by: execute path, condition: all tasks complete OR critical_error set
     Loads after: final task verification pass
     Parts loaded next: none (completion is the terminal phase for this run) -->

HEADER
# Append Steps C4-C6 (retro trigger, loop scheduling, cleanup, failure recovery):
grep -n "^### Step C4" parts/step-c.md
# Extract from C4_start to end of file (or next top-level section):
sed -n '<C4_start>,$p' parts/step-c.md >> parts/step-c-completion.md
```

Apply 1-sentence rationale rule to multi-sentence Why: blocks in the extracted content.

- [ ] **Step 3: Verify size**

```bash
wc -c parts/step-c-completion.md    # target: ≤20480
```

If still over 20480 bytes, prune further: move any "Why:" narrative paragraphs from C6's failure-recovery section to `docs/internals/bundle-resume.md §Failure recovery`.

- [ ] **Step 4: Commit**

```bash
git add parts/step-c-completion.md
git commit -m "feat(step-c): create step-c-completion.md (C4-C6 completion/failure, ≤20KB)"
```

---

### Task 11: Update router lazy-load directives and remove parts/step-c.md

**Files:** commands/masterplan.md, parts/step-c.md (remove), parts/step-0.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L156-L165](spec.md#L156-L165)
**Verify:**
```bash
test ! -f parts/step-c.md && echo "PASS" || echo "FAIL: step-c.md still present"
grep -c "step-c-resume\|step-c-dispatch\|step-c-verification\|step-c-completion" commands/masterplan.md
# expected: ≥4
```

- [ ] **Step 1: Update §Phase-prompt loader in commands/masterplan.md**

Find the §Phase-prompt loader section. Replace the execute-verb routing note with:

```markdown
For `execute` (and bare `/masterplan` resume), load step-c sub-files on demand:
- **Every execute turn:** `parts/step-c-resume.md` (C1 resume controller, state read).
- **Before first task dispatch:** `parts/step-c-dispatch.md` (C2 wave dispatch, eligibility cache).
- **After each task completes:** `parts/step-c-verification.md` (C3 verification).
- **On plan completion or failure:** `parts/step-c-completion.md` (C4-C6 completion).

For all other verbs (`full`, `brainstorm`, `plan`, `retro`, `--resume=<path>`), load `parts/step-{state.yml.current_phase}.md`.
```

- [ ] **Step 2: Update §Loads on demand in parts/step-0.md**

Add the four sub-files to the existing `> **Loads on demand:**` directive at the top of step-0.md:

```markdown
parts/step-c-resume.md, parts/step-c-dispatch.md, parts/step-c-verification.md, parts/step-c-completion.md (replace parts/step-c.md — loaded per phase of execute turn)
```

- [ ] **Step 3: Update doctor check #36 if needed**

```bash
grep -n "#36\|check.*36\|router.*size\|20480" parts/doctor.md | head -5
wc -c commands/masterplan.md
```

If check #36 still passes (commands/masterplan.md ≤ 20480), no change needed. If the new directives push it over, update the threshold to the next reasonable ceiling (e.g., 12288).

- [ ] **Step 4: Remove parts/step-c.md**

```bash
git rm parts/step-c.md
```

- [ ] **Step 5: Verify**

```bash
test ! -f parts/step-c.md && echo "PASS: step-c.md removed"
grep -c "step-c-resume\|step-c-dispatch\|step-c-verification\|step-c-completion" commands/masterplan.md
# Expected: ≥4
wc -c commands/masterplan.md    # should still be ≤9216 from T5
```

- [ ] **Step 6: Commit**

```bash
git add commands/masterplan.md parts/step-0.md parts/doctor.md
git commit -m "feat(router): lazy-load step-c sub-files; remove monolithic step-c.md (110KB)"
```

---

### Task 12: Create parts/contracts/coordinator.md

**Files:** parts/contracts/coordinator.md
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L169-L183](spec.md#L169-L183)
**Verify:**
```bash
test -f parts/contracts/coordinator.md
grep -c "CD-7\|coordinator_version\|DISPATCH-SITE\|inline fallback" parts/contracts/coordinator.md
# expected: ≥4
```

- [ ] **Step 1: Create parts/contracts/coordinator.md**

```markdown
# Coordinator Subagent Contract

<!-- Loaded on demand by any phase file using coordinator dispatch.
     All coordinator call sites reference: parts/contracts/coordinator.md -->

## Core Contract

A **coordinator subagent** pays context cost internally and returns a compact JSON result (≤1000 tokens) to the orchestrator.

**Invariants:**
1. Loads large source files internally — orchestrator never sees them directly.
2. May dispatch further Haiku subagents via `Agent` tool (nested dispatch for parallelizable sub-tasks).
3. Returns **compact JSON ≤1000 tokens** to the orchestrator.
4. **Never writes `state.yml`, `events.jsonl`, or any run artifact.** CD-7: orchestrator is the canonical writer.
5. First line of every coordinator brief: `DISPATCH-SITE: coordinator-<name>`.

## Tier Selection

| Tier | When |
|---|---|
| Haiku | Mechanical structured read + summarize; no judgment needed |
| Sonnet | Classification, merge logic, or contextual fix application |

## Failure Contract

When a coordinator returns malformed JSON or errors, the orchestrator falls through to the existing inline path. Log: `{"event":"coordinator_fallback","site":"coordinator-<name>","reason":"<error>"}` in `events.jsonl`. Every coordinator dispatch site MUST have an inline fallback.

## Coordinator Catalog

| Name | Tier | Replaces | Doc |
|---|---|---|---|
| `coordinator-brainstorm-anchor` | Sonnet | 3 direct Haiku dispatches (Step B1) | `docs/internals/brainstorm-anchor.md` |
| `coordinator-doctor` | Sonnet | Loading `parts/doctor.md` (73KB) into orchestrator context | `docs/internals/doctor.md` |
| `coordinator-task-verify` | Haiku | Inline verify execution (Step C3) | `docs/internals/task-verification.md` |
| `coordinator-bundle-resume` | Haiku | Direct state.yml/events.jsonl/plan.md reads on resume | `docs/internals/bundle-resume.md` |
| `coordinator-plan-parser` | Haiku | Direct plan.md reads for eligibility cache build (Step C2) | `docs/internals/plan-parser.md` |

## Return Shape Protocol

Every coordinator return JSON MUST include `coordinator_version: "1"`. Schema per coordinator: see the corresponding `docs/internals/<name>.md §Return shape`.

## Versioning

Bump `coordinator_version` when adding required fields to a return shape (enables cache invalidation).
```

- [ ] **Step 2: Verify**

```bash
test -f parts/contracts/coordinator.md
grep -c "CD-7\|coordinator_version\|DISPATCH-SITE\|inline fallback" parts/contracts/coordinator.md
```

- [ ] **Step 3: Commit**

```bash
git add parts/contracts/coordinator.md
git commit -m "feat(contracts): add coordinator subagent contract"
```

---

### Task 13: Create docs/internals/brainstorm-anchor.md

**Files:** docs/internals/brainstorm-anchor.md
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L183-L211](spec.md#L183-L211)
**Verify:**
```bash
test -f docs/internals/brainstorm-anchor.md
grep -c "Haiku A\|Haiku B\|Haiku C" docs/internals/brainstorm-anchor.md
# expected: ≥3
```

- [ ] **Step 1: Create docs/internals/ directory if absent**

```bash
mkdir -p docs/internals
```

- [ ] **Step 2: Create docs/internals/brainstorm-anchor.md**

```markdown
# Brainstorm Anchor — Internals

> **Audience:** Maintainers changing Step B1 anchor logic.
> **Phase file:** `parts/step-b.md` §Step B1.
> **Coordinator:** `coordinator-brainstorm-anchor` (Sonnet tier).

## Coordinator Dispatch

The orchestrator dispatches 1 Sonnet coordinator with topic + repo-root. The coordinator calls Haiku A, B, C in parallel internally, merges returns, classifies the anchor, and returns compact JSON.

**Return shape:**
```json
{
  "mode": "implementation-design",
  "repo_role": "...",
  "verification_ceiling": "local-static",
  "in_scope_paths": ["commands/", "parts/"],
  "out_of_scope_repos": [],
  "evidence": ["CLAUDE.md: ...", "WORKLOG.md: ..."],
  "interview_depth": {"complexity": "high", "target_question_count": "8-12"},
  "coordinator_version": "1"
}
```

## Haiku A — project-docs (full brief)

**Goal:** Extract project-doc facts and hints. Return JSON only.

**Read source** (each Read call MUST pass `limit`):
- `<repo-root>/AGENTS.md` — limit 500
- `<repo-root>/CLAUDE.md` — limit 500
- `<repo-root>/WORKLOG.md` — limit 200

**Constraints:** Read-only. Do not paste file content. Note overflows in `notes`.

**Return shape:**
```json
{
  "source_class": "project-docs",
  "facts": ["AGENTS.md: ...", "CLAUDE.md: ...", "WORKLOG.md: ..."],
  "extracted": {
    "repo_role_hint": "<string or null>",
    "in_scope_paths_hint": ["..."],
    "out_of_scope_repos_hint": ["..."],
    "verification_ceiling_hint": "<ceiling or null>",
    "mode_hint": "<mode or null>"
  },
  "notes": "<optional>"
}
```

## Haiku B — run-state (full brief)

**Goal:** Extract run-state facts from the most recent bundle. Return JSON only.

**Read source** (each Read call MUST pass `limit`):
- `<config.runs_path>/<slug>/state.yml` — limit 300
- `<config.runs_path>/<slug>/events.jsonl` — limit 300
- `<config.runs_path>/<slug>/spec.md` — limit 300

**Constraints:** Read-only. If no recent bundle, return empty `facts` and all hints null with `notes: "no recent bundle"`.

**Return shape:** Same structure as Haiku A with `source_class: "run-state"`. `mode_hint` is highest-signal: `execution-resume` if bundle in-progress; `deferred-task` if deferred events match topic; otherwise null.

## Haiku C — repo-sketch (full brief)

**Goal:** Extract repo-structure facts from `rg --files`. Return JSON only.

**Read source:** `rg --files <repo-root> | head -200` (exclude node_modules/, vendor/, .git/, legacy/.archive/, config.runs_path, config.specs_path, config.plans_path).

**Return shape:** Same structure as Haiku A with `source_class: "repo-sketch"`. Only `repo_role_hint` and `verification_ceiling_hint` expected non-null.

## Merge Rules

Field-by-field, first-non-null wins per precedence:
- `repo_role` ← A || C || B
- `in_scope_paths` ← union(A, B), A-ordering preserved
- `out_of_scope_repos` ← union(A, B), A-ordering preserved
- `verification_ceiling` ← most restrictive of the three hints
- `mode` ← B || A || topic-derived (see topic-derived fallback in `parts/step-b.md §Step B1`)
- `evidence` ← concat(A.facts, B.facts, C.facts), max 8 entries

## Classification Gate

When merged `mode == "unclear"` OR any required field (`repo_role`, `evidence`, `verification_ceiling`) is null → fall through to AUQ gate with `pending_gate.id: brainstorm_anchor_audit_mode`. Do not silently default.
```

- [ ] **Step 3: Verify**

```bash
test -f docs/internals/brainstorm-anchor.md
grep -c "Haiku A\|Haiku B\|Haiku C" docs/internals/brainstorm-anchor.md    # ≥3
grep "coordinator_version" docs/internals/brainstorm-anchor.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/internals/brainstorm-anchor.md
git commit -m "docs(internals): add brainstorm-anchor coordinator doc"
```

---

### Task 14: Update parts/step-b.md to dispatch coordinator-brainstorm-anchor

**Files:** parts/step-b.md
**Parallel-group:** none
**Codex:** ok
**Spec:** [spec.md#L183-L211](spec.md#L183-L211)
**Verify:**
```bash
grep -c "coordinator-brainstorm-anchor" parts/step-b.md    # ≥1
grep -n "Haiku A\|Haiku B\|Haiku C" parts/step-b.md | wc -l
# expected: 3 (compact references only, not full briefs)
wc -c parts/step-b.md    # should still be ≤28672 from T4
```

- [ ] **Step 1: Replace 3-Haiku dispatch with coordinator dispatch in B1 step 2**

In parts/step-b.md §Step B1 step 2, the section titled "Dispatch the intent-anchor read pass to three Haiku subagents" (currently ~80 lines), replace the full Haiku brief blocks with:

```markdown
2. **Dispatch coordinator-brainstorm-anchor (v6.0.0+).** The orchestrator dispatches 1 Sonnet coordinator; the coordinator runs Haiku A (project-docs), Haiku B (run-state), and Haiku C (repo-sketch) in parallel internally.

   ```
   DISPATCH-SITE: coordinator-brainstorm-anchor

   contract_id: "coordinator-brainstorm-anchor-v1"
   Tier: sonnet
   Goal: Run 3-Haiku anchor fan-out; return merged anchor JSON.
   Inputs: topic=<topic>, repo_root=<repo_root>, runs_path=<config.runs_path>
   Scope: read-only. Brief bodies for Haiku A/B/C: docs/internals/brainstorm-anchor.md §Haiku A/B/C.
   Constraints: CD-7 (read-only; do not write state).
   Return shape: {mode, repo_role, verification_ceiling, in_scope_paths, out_of_scope_repos, evidence, interview_depth, coordinator_version}
   ```

   **Haiku A — project-docs.** Reads AGENTS.md/CLAUDE.md/WORKLOG.md (limit 500/500/200). See `docs/internals/brainstorm-anchor.md §Haiku A` for full brief.

   **Haiku B — run-state.** Reads most-recent bundle state.yml/events.jsonl/spec.md (limit 300 each). See `docs/internals/brainstorm-anchor.md §Haiku B`.

   **Haiku C — repo-sketch.** Runs `rg --files <repo-root> | head -200`. See `docs/internals/brainstorm-anchor.md §Haiku C`.

   **Fallback** (coordinator returns malformed JSON or errors): log `{"event":"coordinator_fallback","site":"coordinator-brainstorm-anchor","reason":"<error>"}` and dispatch the 3 Haiku agents inline per `docs/internals/brainstorm-anchor.md §Haiku A/B/C` full briefs.
```

- [ ] **Step 2: Verify**

```bash
grep -c "coordinator-brainstorm-anchor" parts/step-b.md    # ≥1
grep -n "^   \*\*Haiku A\|^   \*\*Haiku B\|^   \*\*Haiku C" parts/step-b.md | wc -l
# Expected: 3 compact references
wc -c parts/step-b.md    # should still be ≤28672
```

- [ ] **Step 3: Commit**

```bash
git add parts/step-b.md
git commit -m "feat(step-b): dispatch coordinator-brainstorm-anchor; compact Haiku brief references"
```

---

### Task 15: Create docs/internals/doctor.md and update doctor dispatch routing

**Files:** docs/internals/doctor.md, parts/step-0.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L212-L237](spec.md#L212-L237)
**Verify:**
```bash
test -f docs/internals/doctor.md
grep -c "coordinator-doctor" parts/step-0.md    # ≥1
```

- [ ] **Step 1: Create docs/internals/doctor.md**

```markdown
# Doctor Checks — Internals

> **Audience:** Maintainers adding or fixing doctor checks.
> **Phase file:** `parts/doctor.md` (loaded internally by coordinator-doctor; not loaded into orchestrator context directly in v6.0+).
> **Coordinator:** `coordinator-doctor` (Sonnet tier).

## Coordinator Dispatch

The orchestrator dispatches 1 Sonnet coordinator for `/masterplan doctor [--fix]`. The coordinator loads parts/doctor.md internally, runs all checks, and returns compact findings JSON.

**Return shape:**
```json
{
  "pass": 30,
  "warn": 4,
  "error": 2,
  "findings": [
    {"id": "#18", "severity": "error", "summary": "...", "fix_available": true},
    {"id": "#35", "severity": "warn", "summary": "...", "fix_available": false}
  ],
  "fix_applied": ["#18"],
  "coordinator_version": "1"
}
```

## Adding a New Check

1. Add to `parts/doctor.md` following the existing format (1-sentence Why:).
2. Update the total check count in the parallelization brief.
3. Verify `pass + warn + error` still sums correctly in the return shape.

## Per-Check Extended Rationale

When a check's Why: was too complex for 1 sentence, the full rationale appears here as §Check #N:

*(Append entries here as needed during Phase 1 prose pruning.)*
```

- [ ] **Step 2: Update doctor dispatch in parts/step-0.md**

Find the `## Doctor entry point` section in parts/step-0.md. Replace:

```markdown
For doctor verb: after step-0.md bootstrap, load `parts/doctor.md` and run all checks. Check #36 verifies this router stays ≤20480 bytes.
```

With:

```markdown
For doctor verb: after step-0.md bootstrap, dispatch coordinator-doctor:

```
DISPATCH-SITE: coordinator-doctor

contract_id: "coordinator-doctor-v1"
Tier: sonnet
Goal: Load parts/doctor.md internally; run all checks; apply safe fixes when fix_flag=true.
Inputs: fix_flag=<true|false>, bundle_path=<active-bundle-path or null>
Scope: read parts/doctor.md + all referenced state files; write only when fix_flag=true (safe fixes only).
Constraints: CD-7 (orchestrator writes state.yml from coordinator results only).
Return shape: {pass, warn, error, findings: [{id, severity, summary, fix_available}], fix_applied, coordinator_version}
```

**Fallback** (coordinator errors): log `coordinator_fallback` and load `parts/doctor.md` inline (pre-v6 behavior).

Check #36 verifies this router (commands/masterplan.md) stays ≤20480 bytes.
```

- [ ] **Step 3: Verify**

```bash
test -f docs/internals/doctor.md
grep -c "coordinator-doctor" parts/step-0.md    # ≥1
bash -n hooks/masterplan-telemetry.sh    # should still pass
```

- [ ] **Step 4: Commit**

```bash
git add docs/internals/doctor.md parts/step-0.md
git commit -m "feat(doctor): route via coordinator-doctor; add docs/internals/doctor.md"
```

---

### Task 16: Update step-c-verification.md for coordinator-task-verify

**Files:** parts/step-c-verification.md, docs/internals/task-verification.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L238-L260](spec.md#L238-L260)
**Verify:**
```bash
grep -c "coordinator-task-verify" parts/step-c-verification.md    # ≥1
test -f docs/internals/task-verification.md
wc -c parts/step-c-verification.md    # still ≤20480
```

- [ ] **Step 1: Create docs/internals/task-verification.md**

```markdown
# Task Verification — Internals

> **Audience:** Maintainers changing Step C3 verification logic.
> **Phase file:** `parts/step-c-verification.md`.
> **Coordinator:** `coordinator-task-verify` (Haiku tier).

## Coordinator Dispatch

Orchestrator dispatches 1 Haiku coordinator with task verify commands + expected PASS pattern. Coordinator runs commands, evaluates output, returns pass/fail + excerpt.

**Return shape:**
```json
{
  "status": "pass",
  "exit_code": 0,
  "excerpt": "✓ syntax OK\n✓ 0 errors found\n",
  "commands_run": ["bash -n hooks/masterplan-telemetry.sh"],
  "pattern_matched": "PASSED?|OK|0 errors",
  "coordinator_version": "1"
}
```

## PASS Patterns

Default: `PASSED?|OK|0 errors|0 failures|exit 0|✓`

Override with `**verify-pattern:** <regex>` in the task's `**Verify:**` block.

## Trust-skip Logic

When `codex_review: on` AND the Codex implementer returned `commands_run_excerpts` showing exit 0, the orchestrator may trust-skip coordinator dispatch (G.1 mitigation). Trust-skip is opt-in; default always dispatches coordinator-task-verify.

## G.1 Mitigation

Trust-skip avoids double-verification when Codex already ran the verify commands. See `parts/contracts/agent-dispatch.md §G.1` for full trust-skip predicate.
```

- [ ] **Step 2: Update step-c-verification.md Step C3 verify dispatch**

Find the section in step-c-verification.md where verify commands are run against the task output. Replace the inline execution block with:

```markdown
**Dispatch coordinator-task-verify:**

```
DISPATCH-SITE: coordinator-task-verify

contract_id: "coordinator-task-verify-v1"
Tier: haiku
Goal: Run verify commands for task <N>; evaluate against PASS pattern; return status + excerpt.
Inputs: commands=<verify_commands_list>, pattern=<verify_pattern or default>, task_name=<name>, timeout_s=60
Scope: run commands (read filesystem as needed); no state writes.
Constraints: timeout 60s per command; return exit_code even on timeout.
Return shape: {status, exit_code, excerpt, commands_run, pattern_matched, coordinator_version}
```

**Fallback** (coordinator errors or timeout): run commands inline; evaluate against default PASS pattern. Log `coordinator_fallback`.
```

- [ ] **Step 3: Verify**

```bash
grep -c "coordinator-task-verify" parts/step-c-verification.md
test -f docs/internals/task-verification.md
wc -c parts/step-c-verification.md    # ≤20480
```

- [ ] **Step 4: Commit**

```bash
git add parts/step-c-verification.md docs/internals/task-verification.md
git commit -m "feat(step-c-verification): dispatch coordinator-task-verify; add internals doc"
```

---

### Task 17: Update step-c-resume.md for coordinator-bundle-resume

**Files:** parts/step-c-resume.md, docs/internals/bundle-resume.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L261-L292](spec.md#L261-L292)
**Verify:**
```bash
grep -c "coordinator-bundle-resume" parts/step-c-resume.md    # ≥1
test -f docs/internals/bundle-resume.md
wc -c parts/step-c-resume.md    # still ≤25600
```

- [ ] **Step 1: Create docs/internals/bundle-resume.md**

```markdown
# Bundle Resume — Internals

> **Audience:** Maintainers changing resume controller logic.
> **Phase file:** `parts/step-c-resume.md`.
> **Coordinator:** `coordinator-bundle-resume` (Haiku tier).

## Coordinator Dispatch

On every execute-turn entry, the orchestrator dispatches 1 Haiku coordinator with the bundle path. The coordinator reads state.yml + events.jsonl + plan.md and returns a compact situation report.

**Return shape:**
```json
{
  "phase": "executing",
  "current_task": "Task 5: Update step-c-dispatch.md",
  "next_action": "dispatch Codex for T5",
  "pending_gate": null,
  "autonomy": "loose",
  "last_5_events": ["wave_2_complete", "T4_committed", "T5_started"],
  "task_summary": [
    {"idx": 1, "status": "complete"},
    {"idx": 5, "status": "in-progress"}
  ],
  "coordinator_version": "1"
}
```

## state.yml Field Semantics

See `parts/contracts/run-bundle.md §state.yml schema` for full field definitions.

## Legacy Migration Path

For legacy status paths (no matching state.yml): coordinator is not dispatched until migration completes. See `parts/step-0.md §Legacy migration` for the migration AUQ flow.

## Failure Recovery

When `critical_error` is non-null or `status: blocked`, the coordinator still returns the situation report — the orchestrator surfaces the recovery gate from `pending_gate` data.
```

- [ ] **Step 2: Update step-c-resume.md C1 state-read section**

Find the section in step-c-resume.md where state.yml / events.jsonl are read on every execute-turn entry. Replace the direct Read tool calls with coordinator dispatch:

```markdown
**Resume state via coordinator-bundle-resume.** On every execute-turn entry:

```
DISPATCH-SITE: coordinator-bundle-resume

contract_id: "coordinator-bundle-resume-v1"
Tier: haiku
Goal: Read bundle state; return compact situation report.
Inputs: bundle_path=<docs/masterplan/<slug>/>
Scope: read state.yml (full), events.jsonl (limit 200 lines), plan.md (limit 100 lines).
Constraints: read-only; CD-7.
Return shape: {phase, current_task, next_action, pending_gate, autonomy, last_5_events, task_summary, coordinator_version}
```

**Fallback** (coordinator errors): read state.yml inline with the Read tool (pre-v6 behavior). Log `coordinator_fallback`.
```

- [ ] **Step 3: Verify**

```bash
grep -c "coordinator-bundle-resume" parts/step-c-resume.md
test -f docs/internals/bundle-resume.md
wc -c parts/step-c-resume.md    # ≤25600
```

- [ ] **Step 4: Commit**

```bash
git add parts/step-c-resume.md docs/internals/bundle-resume.md
git commit -m "feat(step-c-resume): dispatch coordinator-bundle-resume; add internals doc"
```

---

### Task 18: Update step-c-dispatch.md for coordinator-plan-parser

**Files:** parts/step-c-dispatch.md, docs/internals/plan-parser.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L293-L322](spec.md#L293-L322)
**Verify:**
```bash
grep -c "coordinator-plan-parser" parts/step-c-dispatch.md    # ≥1
test -f docs/internals/plan-parser.md
wc -c parts/step-c-dispatch.md    # still ≤25600
```

- [ ] **Step 1: Create docs/internals/plan-parser.md**

```markdown
# Plan Parser — Internals

> **Audience:** Maintainers changing plan format or eligibility cache build.
> **Phase file:** `parts/step-c-dispatch.md`.
> **Coordinator:** `coordinator-plan-parser` (Haiku tier).

## Coordinator Dispatch

Orchestrator dispatches 1 Haiku coordinator with the plan.md path. Coordinator reads plan.md, parses task annotations, returns structured task list. Orchestrator builds the eligibility cache from this JSON and never reads raw plan.md directly.

**Return shape:**
```json
{
  "total_tasks": 15,
  "schema_version": "5.0",
  "tasks": [
    {
      "idx": 1,
      "name": "Add turn_context_bytes event",
      "files": ["hooks/masterplan-telemetry.sh"],
      "codex_eligible": true,
      "parallel_group": "none",
      "verify_commands": ["bash -n hooks/masterplan-telemetry.sh"],
      "status": "pending"
    }
  ],
  "eligibility_cache_hash": "sha256:abc123",
  "coordinator_version": "1"
}
```

## Annotation Syntax

Per-task annotations parsed by the coordinator:
```
**Files:** path1, path2
**Parallel-group:** wave-X or none
**Codex:** true|false
**Verify:**
```bash
<commands>
```
```

A missing `**Codex:**` annotation defaults to heuristic: single-file = `true`.

## Eligibility Cache Hash

SHA256 of the structured task list JSON (before the hash field). Stored in state.yml. Invalidated when plan.md mtime changes.
```

- [ ] **Step 2: Update step-c-dispatch.md eligibility cache build section**

Find the eligibility cache build in step-c-dispatch.md (Step C2 step where plan.md is read). Replace direct plan.md reads with coordinator dispatch:

```markdown
**Parse plan via coordinator-plan-parser.** Dispatch to build the eligibility cache:

```
DISPATCH-SITE: coordinator-plan-parser

contract_id: "coordinator-plan-parser-v1"
Tier: haiku
Goal: Parse plan.md; return structured task list with eligibility annotations.
Inputs: plan_path=<docs/masterplan/<slug>/plan.md>
Scope: read plan.md only.
Constraints: read-only; CD-7.
Return shape: {total_tasks, schema_version, tasks: [{idx, name, files, codex_eligible, parallel_group, verify_commands, status}], eligibility_cache_hash, coordinator_version}
```

**Fallback** (coordinator errors): read plan.md inline and build eligibility cache from heuristic checklist. Log `coordinator_fallback`.
```

- [ ] **Step 3: Verify**

```bash
grep -c "coordinator-plan-parser" parts/step-c-dispatch.md
test -f docs/internals/plan-parser.md
wc -c parts/step-c-dispatch.md    # ≤25600
```

- [ ] **Step 4: Commit**

```bash
git add parts/step-c-dispatch.md docs/internals/plan-parser.md
git commit -m "feat(step-c-dispatch): dispatch coordinator-plan-parser for eligibility cache; add internals doc"
```

---

### Task 19: Create docs/internals/wave-dispatch.md and coordinator-pattern.md

**Files:** docs/internals/wave-dispatch.md, docs/internals/coordinator-pattern.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L325-L345](spec.md#L325-L345)
**Verify:**
```bash
test -f docs/internals/wave-dispatch.md
test -f docs/internals/coordinator-pattern.md
ls docs/internals/ | wc -l    # expected: 7
```

- [ ] **Step 1: Create docs/internals/wave-dispatch.md**

```markdown
# Wave Dispatch — Internals

> **Audience:** Maintainers changing Step C2 wave batch assembly or Codex routing.
> **Phase file:** `parts/step-c-dispatch.md`.

## Wave Assembly

Tasks in the plan are grouped into waves by `**Parallel-group:**` annotations. All tasks with the same group name are dispatched concurrently; tasks with `**Parallel-group:** none` are dispatched serially.

### Rules

- Parallel-grouped tasks must have exhaustive `**Files:**` blocks (required at `complexity == high`).
- Codex-eligible tasks (`**Codex:** true`) are dispatched to `codex:codex-rescue`.
- Parallel-grouped tasks must be read-only or write only to gitignored paths.

### Codex Routing Decision Tree

1. Task `**Codex:** true` AND `codex_routing != off` → route to Codex.
2. Task `**Codex:** false` OR `codex_routing == off` → route inline (Sonnet/Haiku subagent).
3. Codex unavailable (step-0 degraded) → route inline; suffix `(codex degraded — plugin missing)` per task banner.

### Wave Completion

A wave is complete when all members return. Orchestrator verifies each result before dispatching the next wave. Failed tasks trigger the CD-4 blocker-re-engagement ladder.
```

- [ ] **Step 2: Create docs/internals/coordinator-pattern.md**

```markdown
# Coordinator Pattern — Internals

> **Audience:** Maintainers adding new coordinators.
> **Contract:** `parts/contracts/coordinator.md`.

## When to Add a Coordinator

Add a coordinator when:
1. The orchestrator would load a file ≥20KB for a task.
2. The task is structurally read-only (builds a cache, classifies, runs verification).
3. A ≤1000-token JSON return captures everything the orchestrator needs to act.

## Adding a New Coordinator

1. Choose a name: `coordinator-<descriptive-noun>`.
2. Choose tier: Haiku for mechanical tasks; Sonnet for judgment tasks.
3. Define return shape in `docs/internals/<name>.md §Return shape`.
4. Add to the Coordinator Catalog in `parts/contracts/coordinator.md`.
5. Add `DISPATCH-SITE: coordinator-<name>` as the first line of the brief at the call site.
6. Implement inline fallback at the call site.
7. Log fallback events as `{"event":"coordinator_fallback","site":"coordinator-<name>","reason":"<error>"}`.

## CD-7 Compliance

Coordinators MUST NOT write any run artifact. Return data only; the orchestrator performs all state mutations.

## Versioning

Bump `coordinator_version` in the return shape when adding required fields. The orchestrator uses this for cache invalidation.
```

- [ ] **Step 3: Verify**

```bash
test -f docs/internals/wave-dispatch.md && test -f docs/internals/coordinator-pattern.md
ls docs/internals/
# Expected: brainstorm-anchor.md, bundle-resume.md, coordinator-pattern.md,
#           doctor.md, plan-parser.md, task-verification.md, wave-dispatch.md
```

- [ ] **Step 4: Commit**

```bash
git add docs/internals/wave-dispatch.md docs/internals/coordinator-pattern.md
git commit -m "docs(internals): add wave-dispatch and coordinator-pattern focused docs"
```

---

### Task 20: Migrate docs/internals.md to lightweight index

**Files:** docs/internals.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L325-L345](spec.md#L325-L345)
**Verify:**
```bash
wc -l docs/internals.md    # target: ≤60
grep -r "docs/internals\.md" parts/ | wc -l    # target: 0
```

- [ ] **Step 1: Record baseline and find cross-references**

```bash
wc -l docs/internals.md
grep -rn "docs/internals\.md" parts/ commands/
```

Record the line count and cross-references to update.

- [ ] **Step 2: Replace docs/internals.md with index**

Overwrite with:

```markdown
# Orchestrator Internals — Index

> Detailed documentation has moved to focused docs below. This file is a navigation index.

## Coordinator Docs (v6.0.0+)

| Doc | Content | Phase file |
|---|---|---|
| [brainstorm-anchor.md](internals/brainstorm-anchor.md) | Anchor classification, Haiku A/B/C briefs, merge rules | `parts/step-b.md` |
| [doctor.md](internals/doctor.md) | All checks, fix procedures, extended rationale | `parts/doctor.md` |
| [task-verification.md](internals/task-verification.md) | PASS patterns, trust-skip, G.1 mitigation | `parts/step-c-verification.md` |
| [bundle-resume.md](internals/bundle-resume.md) | Resume controller, state.yml field semantics | `parts/step-c-resume.md` |
| [plan-parser.md](internals/plan-parser.md) | Plan annotation format, eligibility cache build | `parts/step-c-dispatch.md` |
| [wave-dispatch.md](internals/wave-dispatch.md) | Wave batch assembly, Codex routing decision tree | `parts/step-c-dispatch.md` |
| [coordinator-pattern.md](internals/coordinator-pattern.md) | Adding coordinators, CD-7 compliance, versioning | `parts/contracts/coordinator.md` |

## Architecture Overview

- **Router + verbs:** `commands/masterplan.md`
- **Bootstrap + Codex detection:** `parts/step-0.md`
- **CD rules, run-bundle schema, agent-dispatch, coordinator contract:** `parts/contracts/`

## Migration Note

Previous links `docs/internals.md §<section>` → update to the specific coordinator doc containing that section (sections use the same names).
```

- [ ] **Step 3: Update cross-references in parts/ files**

For each result from Step 1's `grep`, replace `docs/internals.md §<section>` with the corresponding `docs/internals/<coordinator>.md §<section>`.

- [ ] **Step 4: Verify**

```bash
wc -l docs/internals.md    # target: ≤60
grep -r "docs/internals\.md" parts/ | wc -l    # target: 0
ls docs/internals/ | wc -l    # expected: 7
```

- [ ] **Step 5: Commit**

```bash
git add docs/internals.md parts/
git commit -m "docs(internals): convert to index; all content in docs/internals/*.md"
```

---

### Task 21: Final verification suite and version bump

**Files:** .claude-plugin/plugin.json, CHANGELOG.md
**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L52-L58](spec.md#L52-L58)
**Verify:**
```bash
bash -n hooks/masterplan-telemetry.sh && echo "SC1 PASS"
test ! -f parts/step-c.md && echo "SC4a PASS"
wc -c parts/step-c-resume.md parts/step-c-dispatch.md parts/step-c-verification.md parts/step-c-completion.md
wc -c parts/step-0.md && echo "(target: ≤30720)"
wc -c parts/step-b.md && echo "(target: ≤28672)"
wc -c commands/masterplan.md && echo "(target: ≤9216)"
grep '"version"' .claude-plugin/plugin.json    # expected: "6.0.0"
```

- [ ] **Step 1: Run full verification suite**

```bash
# Success Criterion 3
bash -n hooks/masterplan-telemetry.sh && echo "SC3 PASS: hook syntax OK"

# Success Criterion 4
test ! -f parts/step-c.md && echo "SC4a PASS: step-c.md removed" || echo "SC4a FAIL"
wc -c parts/step-c-resume.md && echo "(SC4 target: ≤25600)"
wc -c parts/step-c-dispatch.md && echo "(SC4 target: ≤25600)"
wc -c parts/step-c-verification.md && echo "(SC4 target: ≤20480)"
wc -c parts/step-c-completion.md && echo "(SC4 target: ≤20480)"

# Success Criterion 5
wc -c parts/step-0.md && echo "(SC5 target: ≤30720)"

# Bonus checks
wc -c parts/step-b.md && echo "(target: ≤28672)"
wc -c commands/masterplan.md && echo "(target: ≤9216)"
wc -l docs/internals.md && echo "(target: ≤60 lines)"
grep -r "docs/internals\.md" parts/ | wc -l && echo "(target: 0)"
ls docs/internals/ | sort

# Success Criterion 1
bash bin/masterplan-codex-usage.sh baseline 2>&1 | head -10

# All 5 coordinator fallbacks present
for site in coordinator-brainstorm-anchor coordinator-doctor coordinator-task-verify coordinator-bundle-resume coordinator-plan-parser; do
  grep -rl "Fallback.*coordinator_fallback.*$site\|coordinator_fallback.*$site" parts/ | head -1 \
    && echo "PASS: $site fallback present" || echo "FAIL: $site fallback missing"
done
```

- [ ] **Step 2: Fix any out-of-spec files**

For any file exceeding its target byte count, apply additional 1-sentence rationale pruning. Do not pad or truncate meaningfully — only remove redundant prose.

- [ ] **Step 3: Coordinator fallback smoke verification (Success Criterion 6)**

```bash
# Verify fallback code paths are present in each dispatch site
grep -c "coordinator_fallback\|Fallback.*coordinator" parts/step-b.md    # ≥1
grep -c "coordinator_fallback\|Fallback.*coordinator" parts/step-0.md    # ≥1
grep -c "coordinator_fallback\|Fallback.*coordinator" parts/step-c-verification.md    # ≥1
grep -c "coordinator_fallback\|Fallback.*coordinator" parts/step-c-resume.md    # ≥1
grep -c "coordinator_fallback\|Fallback.*coordinator" parts/step-c-dispatch.md    # ≥1
```

All 5 expected ≥1.

- [ ] **Step 4: Bump version to 6.0.0**

In `.claude-plugin/plugin.json`, update:

```json
"version": "6.0.0"
```

- [ ] **Step 5: Add CHANGELOG entry**

Add at the top of CHANGELOG.md:

```markdown
## [6.0.0] — 2026-05-22

### Performance

- **P0 Baseline instrumentation:** `turn_context_bytes` event in telemetry hook; `bin/masterplan-codex-usage.sh baseline` subcommand for pre/post token measurement.
- **P1 Prose pruning:** `parts/step-0.md` 47KB→≤30KB; `parts/step-b.md` 48KB→≤28KB; `commands/masterplan.md` 11KB→≤9KB; `parts/doctor.md` per-check rationale blocks compressed to 1 sentence each.
- **P2 Sub-file split:** `parts/step-c.md` (110KB monolith) replaced by 4 load-on-demand sub-files: step-c-resume (≤25KB), step-c-dispatch (≤25KB), step-c-verification (≤20KB), step-c-completion (≤20KB). A typical mid-plan execute turn loads ~50KB instead of 110KB.
- **P3 Coordinator pattern:** 5 coordinator subagents introduced — brainstorm-anchor, doctor, task-verify, bundle-resume, plan-parser. Each coordinator pays context cost internally; orchestrator receives ≤1000-token JSON. Inline fallbacks at all 5 sites preserve pre-v6 behavior on error.

### Architecture

- **`parts/contracts/coordinator.md`:** Core coordinator subagent contract (CD-7 compliance, tier selection, failure contract, coordinator catalog).
- **`docs/internals/`:** 7 focused docs replace the monolithic `docs/internals.md`. All cross-references in `parts/` updated to specific coordinator docs.
```

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/plugin.json CHANGELOG.md
git commit -m "chore(release): bump to v6.0.0 — token efficiency (P0-P3 + docs split)"
```

---

## Self-Review

**Spec coverage:**
- Phase 0 (T1, T2) ✓ — telemetry event + baseline subcommand
- Phase 1 (T3-T6) ✓ — 1-sentence rationale rule + compaction-notice trim + contract extraction (in T3/T4 steps)
- Phase 2 (T7-T11) ✓ — 4-way split + router lazy-load + step-c.md removal + doctor stub
- Phase 3 (T12-T18) ✓ — coordinator contract + all 5 coordinator dispatch sites
- Docs split (T13, T15-T19, T20) ✓ — 7 focused docs + internals.md index
- Version bump + CHANGELOG (T21) ✓

**Placeholder check:** All bash commands are shown with expected output. Content for new docs/internals/*.md files is provided inline in the tasks.

**Coordinator consistency:** All 5 coordinators use `coordinator_version: "1"`, `DISPATCH-SITE:` prefix, and have `Fallback` documentation. Return shapes in task steps match the shapes in the corresponding docs/internals/ docs.
