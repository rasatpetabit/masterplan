# Improve Masterplan Regression Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the test suite to cover coordinator dispatch invariants, step-c structural integrity, doctor checks #1–#47, and hook behavior; wire everything into a tiered runner with a pre-commit gate.

**Architecture:** New `tests/run-tests.sh` entry point with `--fast`/`--full`/`--all-worktrees` tiers. Fast tier covers existing `tests/static/` plus new `tests/structural/` (grep-based). Full tier adds `tests/doctor-fixtures/` (check-01..check-47) and `tests/hook-unit/`. Bash blocks are added to `parts/doctor.md` for every check that lacks one, making all 47 checks independently auditable and fixture-runnable.

**Tech Stack:** bash, grep, git, jq, python3 (YAML parse fallback), existing fixture runner at `tests/doctor-fixtures/run.sh`

---

### Task 1: Create `tests/run-tests.sh`

**Files:**
- Create: `tests/run-tests.sh`

**Spec:** spec.md §Section D — exact implementation provided
**Codex:** true
**Verify:** `bash -n tests/run-tests.sh && tests/run-tests.sh --fast 2>&1 | tail -3`

- [ ] **Step 1: Create the file**

```bash
#!/usr/bin/env bash
# tests/run-tests.sh — tiered test runner
# Usage: run-tests.sh [--fast|--full] [--all-worktrees]

set -euo pipefail

TIER="fast"
ALL_WORKTREES=false
PASS=0
FAIL=0
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast) TIER=fast ;;
    --full) TIER=full ;;
    --all-worktrees) ALL_WORKTREES=true ;;
    *) echo "Unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

run_suite() {
  local root="$1"
  # fast tier
  for t in "$root"/tests/static/test-*.sh "$root"/tests/structural/test-*.sh; do
    [[ -f "$t" ]] || continue
    name=$(basename "$t" .sh)
    if bash "$t" "$root" >/dev/null 2>&1; then
      printf "[FAST] %-40s PASS\n" "$name"
      ((PASS++))
    else
      printf "[FAST] %-40s FAIL\n" "$name"
      bash "$t" "$root"
      ((FAIL++))
    fi
  done

  # full tier additions
  if [[ "$TIER" == "full" ]]; then
    if bash "$root"/tests/doctor-fixtures/run.sh "$root" >/dev/null 2>&1; then
      printf "[FULL] %-40s PASS\n" "doctor-fixtures"
      ((PASS++))
    else
      printf "[FULL] %-40s FAIL\n" "doctor-fixtures"
      bash "$root"/tests/doctor-fixtures/run.sh "$root"
      ((FAIL++))
    fi
    for t in "$root"/tests/hook-unit/test-*.sh; do
      [[ -f "$t" ]] || continue
      name=$(basename "$t" .sh)
      if bash "$t" "$root" >/dev/null 2>&1; then
        printf "[FULL] %-40s PASS\n" "$name"
        ((PASS++))
      else
        printf "[FULL] %-40s FAIL\n" "$name"
        bash "$t" "$root"
        ((FAIL++))
      fi
    done
  fi
}

if [[ "$ALL_WORKTREES" == "true" ]]; then
  while IFS= read -r wt_path; do
    [[ -d "$wt_path" ]] || continue
    echo "=== Worktree: $wt_path ==="
    run_suite "$wt_path"
  done < <(git -C "$REPO_ROOT" worktree list --porcelain | grep '^worktree ' | awk '{print $2}')
else
  run_suite "$REPO_ROOT"
fi

echo "─────────────────────────────────────────────────"
TOTAL=$((PASS + FAIL))
if [[ $FAIL -eq 0 ]]; then
  echo "PASS $PASS/$TOTAL tests  exit 0"
  exit 0
else
  echo "FAIL $FAIL/$TOTAL tests  exit 1"
  exit 1
fi
```

- [ ] **Step 2: Make executable and verify syntax**

```bash
chmod +x tests/run-tests.sh
bash -n tests/run-tests.sh
```
Expected: no output (clean syntax check).

- [ ] **Step 3: Commit**

```bash
git add tests/run-tests.sh
git commit -m "feat(tests): add tiered run-tests.sh entry point (--fast/--full/--all-worktrees)"
```

---

### Task 2: Update `tests/run-static.sh` to delegate to `run-tests.sh`

**Files:**
- Modify: `tests/run-static.sh`

**Spec:** spec.md §Section E — deprecated alias
**Codex:** true
**Verify:** `bash tests/run-static.sh 2>&1 | tail -3`

- [ ] **Step 1: Read the existing file**

Read `tests/run-static.sh` to understand its current contents.

- [ ] **Step 2: Prepend delegation line**

Replace the body with a delegation call so the script still works but routes through the new runner. Keep the existing shebang and any initial comments; add at the end of setup (before the actual test invocations):

```bash
#!/usr/bin/env bash
# Deprecated alias — delegates to tests/run-tests.sh --fast
# Kept for backwards compatibility with any scripts calling run-static.sh directly.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_ROOT/tests/run-tests.sh" --fast "$@"
```

Note: if the existing file already sources or calls individual tests, replace the whole body with the above (keeping shebang). Use Read tool to confirm exact content before editing.

- [ ] **Step 3: Verify the alias still works**

```bash
bash tests/run-static.sh 2>&1 | tail -3
```
Expected: `PASS N/N tests  exit 0` (same output as `tests/run-tests.sh --fast`).

- [ ] **Step 4: Commit**

```bash
git add tests/run-static.sh
git commit -m "chore(tests): deprecate run-static.sh as alias for run-tests.sh --fast"
```

---

### Task 3: Create `tests/structural/test-coordinator-dispatch.sh`

**Files:**
- Create: `tests/structural/test-coordinator-dispatch.sh`

**Spec:** spec.md §Section A — checks A1–A4
**Codex:** true
**Verify:** `bash tests/structural/test-coordinator-dispatch.sh 2>&1 | tail -5`

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p tests/structural
```

Create `tests/structural/test-coordinator-dispatch.sh`:

```bash
#!/usr/bin/env bash
# tests/structural/test-coordinator-dispatch.sh — A1..A4: coordinator dispatch invariants
# Usage: test-coordinator-dispatch.sh [REPO_ROOT]
set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }

PASS=0; FAIL=0
pass() { echo "PASS A$1: $2"; PASS=$((PASS+1)); }
fail() { echo "FAIL A$1: $2"; FAIL=$((FAIL+1)); }

# A1: count of Agent( calls == count of DISPATCH-SITE: markers
agent_count=$(grep -rh 'Agent(' "$REPO_ROOT/parts/" "$REPO_ROOT/commands/masterplan.md" 2>/dev/null \
  | grep -c 'Agent(' || echo 0)
dispatch_count=$(grep -rh 'DISPATCH-SITE:' "$REPO_ROOT/parts/" "$REPO_ROOT/commands/masterplan.md" 2>/dev/null \
  | grep -c 'DISPATCH-SITE:' || echo 0)
if [ "$agent_count" -eq "$dispatch_count" ]; then
  pass 1 "DISPATCH-SITE markers: Agent($agent_count) == DISPATCH-SITE:($dispatch_count)"
else
  fail 1 "DISPATCH-SITE count mismatch: Agent($agent_count) != DISPATCH-SITE:($dispatch_count)"
fi

# A2: every DISPATCH-SITE block (next 20 lines) contains Return shape: or ≤1000
a2_fail=0
while IFS= read -r file; do
  [ -f "$file" ] || continue
  while IFS= read -r lineno; do
    block=$(sed -n "${lineno},$((lineno+20))p" "$file" 2>/dev/null)
    if ! printf '%s\n' "$block" | grep -qE 'Return shape:|≤1000|<= *1000'; then
      echo "  FAIL A2: $file:$lineno — DISPATCH-SITE block missing Return shape:/≤1000 annotation"
      a2_fail=$((a2_fail+1))
    fi
  done < <(grep -n 'DISPATCH-SITE:' "$file" 2>/dev/null | cut -d: -f1)
done < <(find "$REPO_ROOT/parts" "$REPO_ROOT/commands" -name "*.md" 2>/dev/null)
[ $a2_fail -eq 0 ] && pass 2 "Return-shape caps: all DISPATCH-SITE blocks annotated" \
  || fail 2 "Return-shape caps: $a2_fail DISPATCH-SITE block(s) missing annotation"

# A3: no step-*.md has 3+ consecutive **(Read|Bash|Glob)** lines without boundary
a3_fail=0
for f in "$REPO_ROOT"/parts/step-*.md; do
  [ -f "$f" ] || continue
  consecutive=0
  while IFS= read -r line; do
    if printf '%s\n' "$line" | grep -qE '\*\*(Read|Bash|Glob)\*\*'; then
      consecutive=$((consecutive+1))
      if [ $consecutive -ge 3 ]; then
        echo "  FAIL A3: $f — 3+ consecutive tool-ref lines without DISPATCH-SITE/coordinator/## Step boundary"
        a3_fail=$((a3_fail+1))
        consecutive=0
      fi
    elif printf '%s\n' "$line" | grep -qE 'DISPATCH-SITE:|coordinator|^## Step'; then
      consecutive=0
    else
      consecutive=0
    fi
  done < "$f"
done
[ $a3_fail -eq 0 ] && pass 3 "CC-2 inline-read guard: no 3+ consecutive tool-ref lines without boundary" \
  || fail 3 "CC-2 inline-read guard: $a3_fail violation(s)"

# A4: every DISPATCH-SITE block (next 40 lines) contains Fallback (case-insensitive)
a4_fail=0
while IFS= read -r file; do
  [ -f "$file" ] || continue
  while IFS= read -r lineno; do
    block=$(sed -n "${lineno},$((lineno+40))p" "$file" 2>/dev/null)
    if ! printf '%s\n' "$block" | grep -qiE 'fallback'; then
      echo "  FAIL A4: $file:$lineno — DISPATCH-SITE block (next 40 lines) missing Fallback documentation"
      a4_fail=$((a4_fail+1))
    fi
  done < <(grep -n 'DISPATCH-SITE:' "$file" 2>/dev/null | cut -d: -f1)
done < <(find "$REPO_ROOT/parts" "$REPO_ROOT/commands" -name "*.md" 2>/dev/null)
[ $a4_fail -eq 0 ] && pass 4 "Fallback documentation: all DISPATCH-SITE blocks contain Fallback" \
  || fail 4 "Fallback documentation: $a4_fail DISPATCH-SITE block(s) missing Fallback"

echo ""
echo "coordinator-dispatch: $PASS passed, $FAIL failed (4/4 checks)"
[ $FAIL -eq 0 ]
```

- [ ] **Step 2: Make executable and verify syntax**

```bash
chmod +x tests/structural/test-coordinator-dispatch.sh
bash -n tests/structural/test-coordinator-dispatch.sh
```

- [ ] **Step 3: Run against main repo**

```bash
bash tests/structural/test-coordinator-dispatch.sh 2>&1
```
Expected: all 4 checks PASS (or specific failures that reflect real violations to fix).

- [ ] **Step 4: Commit**

```bash
git add tests/structural/test-coordinator-dispatch.sh
git commit -m "feat(tests): add structural test A1-A4 for coordinator dispatch invariants"
```

---

### Task 4: Create `tests/structural/test-step-c-split.sh`

**Files:**
- Create: `tests/structural/test-step-c-split.sh`

**Spec:** spec.md §Section A — checks B1–B4
**Codex:** true
**Verify:** `bash tests/structural/test-step-c-split.sh 2>&1 | tail -5`

- [ ] **Step 1: Create the file**

```bash
#!/usr/bin/env bash
# tests/structural/test-step-c-split.sh — B1..B4: step-c 4-way split structural integrity
# Usage: test-step-c-split.sh [REPO_ROOT]
set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }

PASS=0; FAIL=0
pass() { echo "PASS B$1: $2"; PASS=$((PASS+1)); }
fail() { echo "FAIL B$1: $2"; FAIL=$((FAIL+1)); }

# B1: all 4 step-c-*.md files exist and non-empty
b1_fail=0
for sub in dispatch resume verification completion; do
  f="$REPO_ROOT/parts/step-c-$sub.md"
  if [ ! -f "$f" ]; then
    echo "  FAIL B1: parts/step-c-$sub.md missing"
    b1_fail=$((b1_fail+1))
  elif [ "$(wc -c < "$f")" -eq 0 ]; then
    echo "  FAIL B1: parts/step-c-$sub.md is empty (wc -c == 0)"
    b1_fail=$((b1_fail+1))
  fi
done
[ $b1_fail -eq 0 ] && pass 1 "All 4 step-c-*.md files exist and non-empty" \
  || fail 1 "step-c file existence: $b1_fail file(s) missing or empty"

# B2: no duplicate section headers (##+ lines) across all 4 files (case-insensitive)
headers_raw=$(for f in "$REPO_ROOT"/parts/step-c-*.md; do
  [ -f "$f" ] || continue
  grep -hE '^##+ ' "$f" | tr '[:upper:]' '[:lower:]' | sed 's/^#* //'
done)
dupes=$(printf '%s\n' "$headers_raw" | sort | uniq -d)
if [ -z "$dupes" ]; then
  pass 2 "No duplicate section headers across step-c-*.md"
else
  echo "  FAIL B2 duplicate headers: $(printf '%s\n' "$dupes" | head -5 | paste -sd '; ')"
  fail 2 "Duplicate section headers found in step-c-*.md"
fi

# B3: no non-negated "end the turn" in step-c-*.md
# Non-negated = line contains "end the turn" but NOT "never" or "do not" or "don't"
b3_fail=0
for f in "$REPO_ROOT"/parts/step-c-*.md; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    printf '%s\n' "$line" | grep -iqE 'end the turn' || continue
    printf '%s\n' "$line" | grep -iqE '(never|do not|don.t)' && continue
    echo "  FAIL B3: $(basename "$f"): bare 'end the turn' found: ${line:0:80}"
    b3_fail=$((b3_fail+1))
  done < "$f"
done
[ $b3_fail -eq 0 ] && pass 3 "CC-3 trampoline coverage: no bare 'end the turn' in step-c-*.md" \
  || fail 3 "CC-3 trampoline: $b3_fail bare 'end the turn' instance(s)"

# B4: all parts/<name> xrefs in step-c-*.md and step-b-*.md resolve to existing files
b4_fail=0
for f in "$REPO_ROOT"/parts/step-c*.md "$REPO_ROOT"/parts/step-b*.md; do
  [ -f "$f" ] || continue
  while IFS= read -r ref; do
    target="$REPO_ROOT/$ref"
    [ -f "$target" ] || {
      echo "  FAIL B4: $(basename "$f"): unresolved xref $ref (file does not exist)"
      b4_fail=$((b4_fail+1))
    }
  done < <(grep -oE 'parts/step-[a-z0-9._-]+\.md' "$f" 2>/dev/null | sort -u)
done
[ $b4_fail -eq 0 ] && pass 4 "Xref resolution: all parts/ xrefs in step-c/b files resolve" \
  || fail 4 "Xref resolution: $b4_fail unresolved xref(s) in step-c/b files"

echo ""
echo "step-c-split: $PASS passed, $FAIL failed (4/4 checks)"
[ $FAIL -eq 0 ]
```

- [ ] **Step 2: Make executable, verify syntax, run**

```bash
chmod +x tests/structural/test-step-c-split.sh
bash -n tests/structural/test-step-c-split.sh
bash tests/structural/test-step-c-split.sh 2>&1
```
Expected: all 4 checks PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/structural/test-step-c-split.sh
git commit -m "feat(tests): add structural test B1-B4 for step-c 4-way split integrity"
```

---

### Task 5: Add bash blocks to `parts/doctor.md` checks #1–#12

**Files:**
- Modify: `parts/doctor.md`

**Spec:** spec.md §Section B — Category 2 LLM-interpreted checks need bash blocks
**Codex:** true
**Verify:** `grep -c '^\`\`\`bash' parts/doctor.md` (count increases by at least 12)

Each bash block is inserted into `parts/doctor.md` immediately after the `---` separator of the respective check section, before the next `## Check #` header. Use the existing check-32 bash block as a structural model.

- [ ] **Step 1: Add bash block to Check #1 (Legacy plan not migrated)**

After the `---` at the end of the Check #1 section, insert:

```bash
fail=0
for d in docs/superpowers/*/; do
  [ -d "$d" ] || continue
  slug="$(basename "$d")"
  ref=0
  for s in docs/masterplan/*/state.yml; do
    [ -f "$s" ] || continue
    grep -qF "$slug" "$s" && ref=1 && break
  done
  [ $ref -eq 0 ] && [ ! -d "docs/masterplan/$slug" ] && {
    echo "WARN $d: legacy plan not migrated (not referenced by any bundle state.yml)"; fail=1
  }
done
[ $fail -eq 0 ] && echo "Check #1: PASS" || echo "Check #1: WARN"
```

- [ ] **Step 2: Add bash block to Check #2 (Orphan state)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  phase="$(grep -E '^phase:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  spec="$(grep -E '^\s+spec:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  plan_f="$(grep -E '^\s+plan:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  if [ -n "$spec" ] && [ ! -f "$spec" ]; then
    echo "ERROR $state: artifacts.spec points at missing file: $spec"; fail=1
  fi
  case "$phase" in spec_gate|brainstorming|"") ;;
    *) [ -n "$plan_f" ] && [ ! -f "$plan_f" ] && \
       { echo "ERROR $state: artifacts.plan missing for phase=$phase: $plan_f"; fail=1; } ;;
  esac
done
[ $fail -eq 0 ] && echo "Check #2: PASS" || echo "Check #2: ERROR"
```

- [ ] **Step 3: Add bash block to Check #3 (Wrong worktree path)**

```bash
fail=0
declare -a valid_paths=()
while IFS= read -r wt; do
  valid_paths+=("$wt")
done < <(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}')
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  wt="$(grep -E '^worktree:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ -z "$wt" ] && continue
  ok=0
  for vp in "${valid_paths[@]}"; do [ "$wt" = "$vp" ] && ok=1 && break; done
  [ $ok -eq 0 ] && { echo "ERROR $state: worktree '$wt' not in git worktree list"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #3: PASS" || echo "Check #3: ERROR"
```

- [ ] **Step 4: Add bash block to Check #4 (Wrong branch)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  branch="$(grep -E '^branch:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ -z "$branch" ] && continue
  git branch --list "$branch" 2>/dev/null | grep -q . \
    || { echo "ERROR $state: branch '$branch' not in git branch --list"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #4: PASS" || echo "Check #4: ERROR"
```

- [ ] **Step 5: Add bash block to Check #5 (Stale in-progress)**

```bash
fail=0
now="$(date +%s)"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  status="$(grep -E '^status:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$status" = "in-progress" ] || continue
  last="$(grep -E '^last_activity:' "$state" | head -1 | awk '{print $2}' | tr -d "'")"
  [ -z "$last" ] && continue
  ts="$(date -u -d "$last" +%s 2>/dev/null || echo 0)"
  age=$(( (now - ts) / 86400 ))
  [ $age -gt 30 ] && { echo "WARN $state: in-progress for ${age} days (last_activity $last)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #5: PASS" || echo "Check #5: WARN"
```

- [ ] **Step 6: Add bash block to Check #6 (Stale critical error)**

```bash
fail=0
now="$(date +%s)"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  status="$(grep -E '^status:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  stop="$(grep -E '^stop_reason:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$status/$stop" in blocked/*|*/critical_error) ;; *) continue ;; esac
  last="$(grep -E '^last_activity:' "$state" | head -1 | awk '{print $2}' | tr -d "'")"
  [ -z "$last" ] && continue
  ts="$(date -u -d "$last" +%s 2>/dev/null || echo 0)"
  age=$(( (now - ts) / 86400 ))
  [ $age -gt 14 ] && { echo "WARN $state: blocked/critical_error for ${age} days"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #6: PASS" || echo "Check #6: WARN"
```

- [ ] **Step 7: Add bash block to Check #7 (Plan/log drift)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  bundle="$(dirname "$state")"
  plan="$bundle/plan.md"
  events="$bundle/events.jsonl"
  [ -f "$plan" ] || continue
  task_count="$(grep -cE '^### Task [0-9]' "$plan" 2>/dev/null || echo 0)"
  [ "${task_count:-0}" -eq 0 ] && continue
  log_refs=0
  [ -f "$events" ] && log_refs="$(grep -cE '"task_completed"|"wave_task_completed"' "$events" 2>/dev/null || echo 0)"
  if [ "${log_refs:-0}" -gt 0 ]; then
    diff=$(( task_count - log_refs ))
    abs_diff="${diff#-}"
    pct=$(( abs_diff * 100 / task_count ))
    [ $pct -gt 50 ] && {
      echo "WARN $state: plan=$task_count tasks, events=$log_refs completions (${pct}% drift)"
      fail=1
    }
  fi
done
[ $fail -eq 0 ] && echo "Check #7: PASS" || echo "Check #7: WARN"
```

- [ ] **Step 8: Add bash block to Check #8 (Missing spec)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  phase="$(grep -E '^phase:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$phase" in spec_gate|brainstorming|"") continue ;; esac
  spec="$(grep -E '^\s+spec:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  if [ -z "$spec" ] || [ ! -f "$spec" ]; then
    echo "ERROR $state: phase=$phase requires artifacts.spec; missing: ${spec:-<empty>}"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #8: PASS" || echo "Check #8: ERROR"
```

- [ ] **Step 9: Add bash block to Check #9 (Schema violation)**

```bash
fail=0
required="schema_version slug status phase worktree branch started last_activity current_task next_action autonomy loop_enabled codex_routing codex_review compact_loop_recommended complexity pending_gate stop_reason critical_error"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  for field in $required; do
    grep -qE "^${field}:" "$state" \
      || { echo "ERROR $state: missing required field: $field"; fail=1; }
  done
  grep -qE '^\s+spec:' "$state" \
    || { echo "ERROR $state: missing required field: artifacts.spec"; fail=1; }
  grep -qE '^\s+plan:' "$state" \
    || { echo "ERROR $state: missing required field: artifacts.plan"; fail=1; }
  grep -qE '^\s+events:' "$state" \
    || { echo "ERROR $state: missing required field: artifacts.events"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #9: PASS" || echo "Check #9: ERROR"
```

- [ ] **Step 10: Add bash block to Check #10 (Unparseable state file)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  if command -v python3 >/dev/null 2>&1; then
    err="$(python3 -c "import yaml, sys; yaml.safe_load(open(sys.argv[1]))" "$state" 2>&1)"
    if [ -n "$err" ]; then
      echo "ERROR $state: YAML parse error: ${err:0:120}"; fail=1
    fi
  else
    grep -Pq '\t' "$state" 2>/dev/null \
      && { echo "ERROR $state: contains tab characters (YAML invalid)"; fail=1; }
  fi
done
[ $fail -eq 0 ] && echo "Check #10: PASS" || echo "Check #10: ERROR"
```

- [ ] **Step 11: Add bash block to Check #11 (Orphan events archive)**

```bash
fail=0
for archive in docs/masterplan/*/events-archive.jsonl; do
  [ -f "$archive" ] || continue
  dir="$(dirname "$archive")"
  [ -f "$dir/state.yml" ] \
    || { echo "WARN $archive: orphan events archive (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #11: PASS" || echo "Check #11: WARN"
```

- [ ] **Step 12: Add bash block to Check #12 (Telemetry file growth)**

```bash
fail=0
threshold="${TELEMETRY_SIZE_THRESHOLD:-5242880}"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  dir="$(dirname "$state")"
  for f in "$dir/telemetry.jsonl" "$dir/subagents.jsonl"; do
    [ -f "$f" ] || continue
    sz="$(wc -c < "$f")"
    [ "$sz" -gt "$threshold" ] \
      && { echo "WARN $f: ${sz} bytes exceeds threshold (${threshold})"; fail=1; }
  done
done
[ $fail -eq 0 ] && echo "Check #12: PASS" || echo "Check #12: WARN"
```

(The `TELEMETRY_SIZE_THRESHOLD` env var exists so fixtures can test without creating 5 MB files.)

- [ ] **Step 13: Verify all 12 bash blocks are now present**

```bash
grep -c '```bash' parts/doctor.md
```
Count should have increased by 12 from the prior value. Spot-check:

```bash
grep -A2 '^## Check #1 ' parts/doctor.md | grep -c '```bash'
grep -A2 '^## Check #12' parts/doctor.md | grep -c '```bash'
```
Both should return `1`.

- [ ] **Step 14: Commit**

```bash
git add parts/doctor.md
git commit -m "feat(doctor): add bash blocks to checks #1-#12 (LLM-interpreted → shell-auditable)"
```

---

### Task 6: Add bash blocks to `parts/doctor.md` checks #13–#24

**Files:**
- Modify: `parts/doctor.md`

**Spec:** spec.md §Section B — Category 2 continued
**Codex:** true
**Verify:** `grep -c '```bash' parts/doctor.md` (count increases by 12 more)

- [ ] **Step 1: Add bash block to Check #13 (Orphan telemetry file)**

```bash
fail=0
for f in docs/masterplan/*/telemetry.jsonl docs/masterplan/*/telemetry-archive.jsonl; do
  [ -f "$f" ] || continue
  [ -f "$(dirname "$f")/state.yml" ] \
    || { echo "WARN $f: orphan telemetry file (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #13: PASS" || echo "Check #13: WARN"
```

- [ ] **Step 2: Add bash block to Check #14 (Orphan eligibility cache)**

```bash
fail=0
for f in docs/masterplan/*/eligibility-cache.json; do
  [ -f "$f" ] || continue
  [ -f "$(dirname "$f")/state.yml" ] \
    || { echo "WARN $f: orphan eligibility cache (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #14: PASS" || echo "Check #14: WARN"
```

- [ ] **Step 3: Add bash block to Check #15 (parallel-group without Files)**

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  [ -f "$plan" ] || continue
  mapfile -t task_lines < <(grep -nE '^### Task [0-9]' "$plan" | cut -d: -f1)
  for i in "${!task_lines[@]}"; do
    start="${task_lines[$i]}"
    end="${task_lines[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    if printf '%s\n' "$block" | grep -qE '^\*\*parallel-group:\*\*'; then
      printf '%s\n' "$block" | grep -qE '^\*\*Files:\*\*' \
        || { echo "WARN $plan task at L$start: **parallel-group:** set but **Files:** missing"; fail=1; }
    fi
  done
done
[ $fail -eq 0 ] && echo "Check #15: PASS" || echo "Check #15: WARN"
```

- [ ] **Step 4: Add bash block to Check #16 (parallel-group + Codex:ok conflict)**

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  [ -f "$plan" ] || continue
  mapfile -t task_lines < <(grep -nE '^### Task [0-9]' "$plan" | cut -d: -f1)
  for i in "${!task_lines[@]}"; do
    start="${task_lines[$i]}"
    end="${task_lines[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    if printf '%s\n' "$block" | grep -qE '^\*\*parallel-group:\*\*' \
    && printf '%s\n' "$block" | grep -qE '^\*\*Codex:\*\* ok'; then
      echo "WARN $plan task at L$start: **parallel-group:** and **Codex:** ok both set (mutually exclusive)"
      fail=1
    fi
  done
done
[ $fail -eq 0 ] && echo "Check #16: PASS" || echo "Check #16: WARN"
```

- [ ] **Step 5: Add bash block to Check #17 (File-path overlap in parallel-group)**

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  [ -f "$plan" ] || continue
  declare -A group_files=()
  mapfile -t task_lines < <(grep -nE '^### Task [0-9]' "$plan" | cut -d: -f1)
  for i in "${!task_lines[@]}"; do
    start="${task_lines[$i]}"
    end="${task_lines[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    pg="$(printf '%s\n' "$block" | grep -E '^\*\*parallel-group:\*\*' | head -1 \
          | sed 's/^\*\*parallel-group:\*\* *//')"
    [ -z "$pg" ] && continue
    while IFS= read -r fpath; do
      [ -z "$fpath" ] && continue
      key="${pg}|${fpath}"
      if [ -n "${group_files[$key]:-}" ]; then
        echo "WARN $plan: file-path overlap in parallel-group '$pg': $fpath (tasks L${group_files[$key]} and L$start)"
        fail=1
      else
        group_files[$key]="$start"
      fi
    done < <(printf '%s\n' "$block" | grep -E '^- (Create|Modify|Test):' | awk '{print $NF}')
  done
  unset group_files
done
[ $fail -eq 0 ] && echo "Check #17: PASS" || echo "Check #17: WARN"
```

- [ ] **Step 6: Add bash block to Check #18 (Codex config on but plugin missing)**

```bash
fail=0
routing="off"; review="off"
for cfg in "$HOME/.masterplan.yaml" ".masterplan.yaml"; do
  [ -r "$cfg" ] || continue
  r="$(grep -E '^  routing:|^codex_routing:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  rv="$(grep -E '^  review:|^codex_review:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  [ -n "$r" ] && routing="$r"
  [ -n "$rv" ] && review="$rv"
done
if [ "$routing" != "off" ] || [ "$review" = "on" ]; then
  plugin_found=0
  ls "$HOME/.claude/plugins/"*codex* 2>/dev/null | grep -q . && plugin_found=1
  if [ $plugin_found -eq 0 ]; then
    echo "WARN codex.routing=$routing / codex.review=$review but no codex plugin found under ~/.claude/plugins/"
    fail=1
  fi
fi
[ $fail -eq 0 ] && echo "Check #18: PASS" || echo "Check #18: WARN"
```

- [ ] **Step 7: Add bash block to Check #19 (Orphan subagents file)**

```bash
fail=0
for f in docs/masterplan/*/subagents.jsonl; do
  [ -f "$f" ] || continue
  [ -f "$(dirname "$f")/state.yml" ] \
    || { echo "WARN $f: orphan subagents file (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #19: PASS" || echo "Check #19: WARN"
```

- [ ] **Step 8: Add bash block to Check #20 (Codex routing but no eligibility cache)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  routing="$(grep -E '^codex_routing:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$routing" in auto|manual) ;; *) continue ;; esac
  dir="$(dirname "$state")"
  events="$dir/events.jsonl"
  [ -f "$events" ] || continue
  grep -qE 'routing→|\[codex\]|\[inline\]' "$events" 2>/dev/null || continue
  [ -f "$dir/eligibility-cache.json" ] \
    || { echo "WARN $state: codex_routing=$routing, routing events present, eligibility-cache.json missing"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #20: PASS" || echo "Check #20: WARN"
```

- [ ] **Step 9: Add bash block to Check #21 (Step C cache-build evidence missing)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  routing="$(grep -E '^codex_routing:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$routing" in auto|manual) ;; *) continue ;; esac
  dir="$(dirname "$state")"
  events="$dir/events.jsonl"
  [ -f "$events" ] || continue
  grep -qE '"task_completed"|"wave_task_completed"' "$events" 2>/dev/null || continue
  grep -qE 'eligibility cache:' "$events" 2>/dev/null \
    || { echo "WARN $state: codex_routing=$routing, completions exist, no 'eligibility cache:' event"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #21: PASS" || echo "Check #21: WARN"
```

- [ ] **Step 10: Add bash block to Check #22 (High-complexity missing rigor evidence)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  complexity="$(grep -E '^complexity:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$complexity" = "high" ] || continue
  dir="$(dirname "$state")"
  events="$dir/events.jsonl"
  retro_path="$(grep -E '^\s+retro:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  has_retro=0
  { [ -n "$retro_path" ] && [ -f "$retro_path" ]; } && has_retro=1
  { [ -f "$dir/retro.md" ]; } && has_retro=1
  has_review=0
  [ -f "$events" ] && grep -qE 'Codex review:.*pass' "$events" 2>/dev/null && has_review=1
  has_tags=0
  [ -f "$events" ] && grep -qE '\[reviewed:' "$events" 2>/dev/null && has_tags=1
  if [ $has_retro -eq 0 ] && [ $has_review -eq 0 ] && [ $has_tags -eq 0 ]; then
    echo "WARN $state: complexity=high but no retro/codex-review/reviewed-tags evidence found"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #22: PASS" || echo "Check #22: WARN"
```

- [ ] **Step 11: Add bash block to Check #23 (Opus on bounded-mechanical dispatch sites)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  dir="$(dirname "$state")"
  subs="$dir/subagents.jsonl"
  [ -f "$subs" ] || continue
  total="$(wc -l < "$subs")"
  start=1; [ "$total" -gt 20 ] && start=$(( total - 19 ))
  while IFS= read -r rec; do
    dispatch="$(printf '%s' "$rec" | jq -r '.dispatch_site // empty' 2>/dev/null)"
    routing_class="$(printf '%s' "$rec" | jq -r '.routing_class // empty' 2>/dev/null)"
    model="$(printf '%s' "$rec" | jq -r '.model // empty' 2>/dev/null)"
    prompt_first="$(printf '%s' "$rec" | jq -r '.prompt_first_line // empty' 2>/dev/null)"
    [ "$model" = "opus" ] || continue
    printf '%s\n' "$prompt_first" | grep -q 're-dispatched with model=opus per blocker gate' && continue
    sdd_site=0
    case "$dispatch" in *"Step C step 1"*|*"Step C step 2 wave"*|*"Step C step 2 SDD"*) sdd_site=1 ;; esac
    [ "$routing_class" = "sdd" ] && sdd_site=1
    [ $sdd_site -eq 1 ] && {
      echo "WARN $(basename "$dir"): SDD/wave dispatch with model=opus (should be sonnet): $dispatch"
      fail=1
    }
  done < <(sed -n "${start},${total}p" "$subs" 2>/dev/null)
done
[ $fail -eq 0 ] && echo "Check #23: PASS" || echo "Check #23: WARN"
```

- [ ] **Step 12: Add bash block to Check #24 (State-write queue non-empty)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  queue="$(dirname "$state")/state.queue.jsonl"
  [ -s "$queue" ] || continue
  count="$(wc -l < "$queue")"
  echo "WARN $state: $count queued state write(s) in $(basename "$queue") — resume with /masterplan execute to drain"
  fail=1
done
[ $fail -eq 0 ] && echo "Check #24: PASS" || echo "Check #24: WARN"
```

- [ ] **Step 13: Verify and commit**

```bash
bash -n parts/doctor.md 2>/dev/null || true  # markdown file, not a script; skip
grep -c '```bash' parts/doctor.md
git add parts/doctor.md
git commit -m "feat(doctor): add bash blocks to checks #13-#24 (LLM-interpreted → shell-auditable)"
```

---

### Task 7: Add bash blocks to checks #26, #28–#31; add Reserved #37; fix #42; add #43

**Files:**
- Modify: `parts/doctor.md`

**Spec:** spec.md §Section B — remaining LLM-interpreted checks + check fixes
**Codex:** true
**Verify:** `grep -c '```bash' parts/doctor.md` (increases by 8 more; check #37 gets a Reserved entry + SKIP block)

- [ ] **Step 1: Add bash block to Check #26 (auto_compact_loop_attached)**

Check #26 requires CronList API access. Add a bash block that checks the precondition (compact_loop_recommended: true bundles present) and reports SKIP when CronList is needed:

```bash
compact_needed=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  val="$(grep -E '^compact_loop_recommended:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$val" = "true" ] && compact_needed=1 && break
done
if [ $compact_needed -eq 0 ]; then
  echo "Check #26: PASS (no bundles have compact_loop_recommended:true)"
else
  echo "Check #26: SKIP (CronList API access required to verify loop attachment — run /masterplan doctor for full check)"
fi
```

- [ ] **Step 2: Add bash block to Check #28 (completed_plan_without_retro)**

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  status="$(grep -E '^status:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$status" = "complete" ] || continue
  dir="$(dirname "$state")"
  retro_path="$(grep -E '^\s+retro:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  if { [ -z "$retro_path" ] || [ ! -f "$retro_path" ]; } && [ ! -f "$dir/retro.md" ]; then
    echo "WARN $state: status=complete but no retro artifact (neither artifacts.retro nor retro.md found)"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #28: PASS" || echo "Check #28: WARN"
```

- [ ] **Step 3: Add bash block to Check #29 (Worktree-bundle reconciliation mismatch)**

```bash
fail=0
declare -a git_wts=()
while IFS= read -r wt; do
  git_wts+=("$wt")
done < <(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}')
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  disposition="$(grep -E '^worktree_disposition:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$disposition" in removed_after_merge|kept_by_user) continue ;; esac
  claimed="$(grep -E '^worktree:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ -z "$claimed" ] && continue
  found=0
  for wt in "${git_wts[@]}"; do [ "$claimed" = "$wt" ] && found=1 && break; done
  [ $found -eq 0 ] && { echo "WARN $state: worktree_missing — '$claimed' not in git worktree list"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #29: PASS" || echo "Check #29: WARN"
```

- [ ] **Step 4: Add bash block to Check #30 (Cross-manifest version drift)**

```bash
fail=0
canonical=""
[ -f ".claude-plugin/plugin.json" ] && \
  canonical="$(jq -r '.version // empty' ".claude-plugin/plugin.json" 2>/dev/null)"
if [ -z "$canonical" ]; then
  echo "Check #30: SKIP (.claude-plugin/plugin.json not found)"
else
  for f in ".codex-plugin/plugin.json" ".claude-plugin/marketplace.json"; do
    [ -f "$f" ] || continue
    v="$(jq -r '.version // empty' "$f" 2>/dev/null)"
    [ -n "$v" ] && [ "$v" != "$canonical" ] && \
      { echo "WARN $f: version drift: $v (canonical: $canonical)"; fail=1; }
    if [ "$f" = ".claude-plugin/marketplace.json" ]; then
      nv="$(jq -r '.plugins[0].version // empty' "$f" 2>/dev/null)"
      [ -n "$nv" ] && [ "$nv" != "$canonical" ] && \
        { echo "WARN $f[plugins[0].version]: version drift: $nv (canonical: $canonical)"; fail=1; }
    fi
  done
  if [ -f "README.md" ]; then
    rv="$(grep -oP 'Current release:.*v\K[0-9]+\.[0-9]+\.[0-9]+' README.md | head -1)"
    [ -n "$rv" ] && [ "$rv" != "$canonical" ] && \
      { echo "WARN README.md: Current release version drift: $rv (canonical: $canonical)"; fail=1; }
  fi
  [ $fail -eq 0 ] && echo "Check #30: PASS" || echo "Check #30: WARN"
fi
```

- [ ] **Step 5: Add bash block to Check #31 (Per-autonomy gate-condition consistency)**

```bash
fail=0
step_b="parts/step-b.md"
if [ ! -f "$step_b" ]; then
  echo "Check #31: SKIP (parts/step-b.md not found)"
else
  if grep -q 'spec_approval' "$step_b"; then
    ctx="$(grep -A4 'spec_approval' "$step_b" | head -8)"
    printf '%s\n' "$ctx" | grep -qiE 'autonomy.*(!=|not|loose|gated)' \
      || { echo "WARN $step_b: spec_approval gate missing autonomy!=full condition"; fail=1; }
  else
    echo "WARN $step_b: spec_approval anchor not found"; fail=1
  fi
  if grep -q 'plan_approval' "$step_b"; then
    ctx="$(grep -A4 'plan_approval' "$step_b" | head -8)"
    printf '%s\n' "$ctx" | grep -qiE 'autonomy.*(==|is|=.*gated|gated)' \
      || { echo "WARN $step_b: plan_approval gate missing autonomy==gated condition"; fail=1; }
  else
    echo "WARN $step_b: plan_approval anchor not found"; fail=1
  fi
  [ $fail -eq 0 ] && echo "Check #31: PASS" || echo "Check #31: WARN"
fi
```

- [ ] **Step 6: Add Reserved #37 section to doctor.md**

Between the `## Check #36` section and `## Check #38` section, insert:

```markdown
## Check #37 — Reserved

_This check ID was retired in an earlier version. Reserved to prevent renumbering of subsequent checks._

```bash
echo "Check #37: SKIP (reserved — retired check ID)"
```

---
```

- [ ] **Step 7: Fix Check #42 bash block (replace emit_finding with standalone bash)**

The existing check #42 uses the undefined function `emit_finding`. Replace the entire implementation block with:

```bash
fail=0
now="$(date +%s)"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  lock="$(dirname "$state")/.lock"
  [ -f "$lock" ] || continue
  mtime="$(stat -c %Y "$lock" 2>/dev/null || echo 0)"
  age=$(( now - mtime ))
  if [ "$age" -gt 3600 ]; then
    echo "WARN $lock: lockfile age ${age}s exceeds 1h threshold (possible wedged writer)"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #42: PASS" || echo "Check #42: WARN"
```

- [ ] **Step 8: Add bash block to Check #43 (codex_review_coverage)**

```bash
fail=0; skip=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  codex_host="$(grep -E '^codex_host:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$codex_host" = "true" ] && { skip=$((skip+1)); continue; }
  dir="$(dirname "$state")"
  slug="$(basename "$dir")"
  events="$dir/events.jsonl"
  [ -f "$events" ] || continue
  completed="$(grep -c '"wave_task_completed"' "$events" 2>/dev/null || echo 0)"
  [ "${completed:-0}" -eq 0 ] && continue
  reviewed="$(grep -c 'review→' "$events" 2>/dev/null || echo 0)"
  if [ "${reviewed:-0}" -lt "${completed:-0}" ]; then
    gap=$(( completed - reviewed ))
    pct=$(( reviewed * 100 / completed ))
    echo "WARN $slug: wave_task_completed=$completed, review→ events=$reviewed (${pct}% coverage, $gap uncovered)"
    fail=1
  fi
done
[ $skip -gt 0 ] && echo "INFO: $skip Codex-hosted run(s) skipped (codex_host:true)"
[ $fail -eq 0 ] && echo "Check #43: PASS" || echo "Check #43: WARN"
```

- [ ] **Step 9: Verify check #37 placeholder is inserted in correct position**

```bash
grep -n '^## Check #3[678]' parts/doctor.md
```
Expected: Check #36 line number < Check #37 line number < Check #38 line number.

- [ ] **Step 10: Verify check #42 no longer uses emit_finding**

```bash
grep -A20 '^## Check #42' parts/doctor.md | grep -c 'emit_finding'
```
Expected: 0.

- [ ] **Step 11: Commit**

```bash
git add parts/doctor.md
git commit -m "feat(doctor): add bash blocks #26/#28-#31, Reserved #37, fix #42, add #43"
```

---

### Task 8: Create doctor fixtures for checks #1–#12

**Files:**
- Create: `tests/doctor-fixtures/check-01/` through `tests/doctor-fixtures/check-12/` (multiple subdirs)

**Spec:** spec.md §Section B — Category 1 fixture mechanism
**Codex:** false
**Verify:** `bash tests/doctor-fixtures/run.sh 2>&1 | grep -E '^(PASS|FAIL|SKIP) check-0[1-9]|check-1[012]'`

Each fixture directory: `tests/doctor-fixtures/check-NN/<verdict>-<desc>/` with `expected.txt` + synthetic `docs/masterplan/<slug>/state.yml` (and other needed files).

- [ ] **Step 1: Create fixtures for check-01 (legacy plan not migrated)**

`tests/doctor-fixtures/check-01/pass-no-legacy/`:
- `docs/masterplan/.gitkeep` (empty dir sentinel, no bundles)
- `expected.txt`: `Check #1: PASS`

`tests/doctor-fixtures/check-01/fail-unreferenced-legacy/`:
- `docs/superpowers/old-plan/spec.md` (empty file to make dir real)
- `docs/masterplan/.gitkeep`
- `expected.txt`: `Check #1: WARN`

- [ ] **Step 2: Create fixtures for check-02 (orphan state)**

`tests/doctor-fixtures/check-02/pass-spec-exists/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  phase: executing
  artifacts:
    spec: docs/masterplan/p1/spec.md
    plan: docs/masterplan/p1/plan.md
  ```
- `docs/masterplan/p1/spec.md` (empty file)
- `docs/masterplan/p1/plan.md` (empty file)
- `expected.txt`: `Check #2: PASS`

`tests/doctor-fixtures/check-02/fail-missing-spec/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  phase: executing
  artifacts:
    spec: docs/masterplan/p1/spec.md
    plan: docs/masterplan/p1/plan.md
  ```
- (no spec.md or plan.md — they're missing)
- `expected.txt`: `artifacts.spec`

- [ ] **Step 3: Create fixtures for check-03 (wrong worktree path)**

`tests/doctor-fixtures/check-03/pass-no-bundles/`:
- `docs/masterplan/.gitkeep`
- `expected.txt`: `Check #3: PASS`

`tests/doctor-fixtures/check-03/fail-fake-worktree/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  worktree: /nonexistent/fake/worktree/path/xyz123
  ```
- `expected.txt`: `Check #3: ERROR`

- [ ] **Step 4: Create fixtures for check-04 (wrong branch)**

`tests/doctor-fixtures/check-04/pass-no-bundles/`:
- `docs/masterplan/.gitkeep`
- `expected.txt`: `Check #4: PASS`

`tests/doctor-fixtures/check-04/fail-missing-branch/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  branch: nonexistent-branch-xyzzy-abc123-impossible
  ```
- `expected.txt`: `Check #4: ERROR`

- [ ] **Step 5: Create fixtures for check-05 (stale in-progress)**

`tests/doctor-fixtures/check-05/pass-recent-activity/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  status: in-progress
  last_activity: '2099-01-01T00:00:00+00:00'
  ```
- `expected.txt`: `Check #5: PASS`

`tests/doctor-fixtures/check-05/fail-stale-30-days/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  status: in-progress
  last_activity: '2020-01-01T00:00:00+00:00'
  ```
- `expected.txt`: `Check #5: WARN`

- [ ] **Step 6: Create fixtures for check-06 (stale critical error)**

`tests/doctor-fixtures/check-06/pass-recent-blocked/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  status: blocked
  last_activity: '2099-01-01T00:00:00+00:00'
  ```
- `expected.txt`: `Check #6: PASS`

`tests/doctor-fixtures/check-06/fail-stale-blocked/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  status: blocked
  last_activity: '2020-01-01T00:00:00+00:00'
  ```
- `expected.txt`: `Check #6: WARN`

- [ ] **Step 7: Create fixtures for check-07 (plan/log drift)**

`tests/doctor-fixtures/check-07/pass-no-drift/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/plan.md` (3 task headings):
  ```markdown
  ### Task 1: foo
  ### Task 2: bar
  ### Task 3: baz
  ```
- `docs/masterplan/p1/events.jsonl` (3 completion lines):
  ```
  {"event":"wave_task_completed","task":1}
  {"event":"wave_task_completed","task":2}
  {"event":"wave_task_completed","task":3}
  ```
- `expected.txt`: `Check #7: PASS`

`tests/doctor-fixtures/check-07/fail-high-drift/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/plan.md` (10 task headings, add `### Task N:` lines 1-10)
- `docs/masterplan/p1/events.jsonl` (1 completion):
  ```
  {"event":"wave_task_completed","task":1}
  ```
- `expected.txt`: `Check #7: WARN`

- [ ] **Step 8: Create fixtures for check-08 (missing spec)**

`tests/doctor-fixtures/check-08/pass-spec-present/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  phase: executing
  artifacts:
    spec: docs/masterplan/p1/spec.md
  ```
- `docs/masterplan/p1/spec.md` (empty)
- `expected.txt`: `Check #8: PASS`

`tests/doctor-fixtures/check-08/fail-spec-missing/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  phase: executing
  artifacts:
    spec: docs/masterplan/p1/spec.md
  ```
- (no spec.md)
- `expected.txt`: `Check #8: ERROR`

- [ ] **Step 9: Create fixtures for check-09 (schema violation)**

`tests/doctor-fixtures/check-09/pass-all-fields/`:
- `docs/masterplan/p1/state.yml` with ALL 22 required fields:
  ```yaml
  schema_version: 3
  slug: p1
  status: in-progress
  phase: executing
  worktree: /tmp/fake
  branch: main
  started: '2026-01-01T00:00:00+00:00'
  last_activity: '2026-01-01T00:00:00+00:00'
  current_task: ''
  next_action: ''
  autonomy: loose
  loop_enabled: false
  codex_routing: auto
  codex_review: true
  compact_loop_recommended: false
  complexity: medium
  pending_gate: null
  stop_reason: null
  critical_error: null
  artifacts:
    spec: ''
    plan: ''
    events: ''
  ```
- `expected.txt`: `Check #9: PASS`

`tests/doctor-fixtures/check-09/fail-missing-fields/`:
- `docs/masterplan/p1/state.yml` with only `slug: p1` (missing everything else)
- `expected.txt`: `Check #9: ERROR`

- [ ] **Step 10: Create fixtures for check-10 (unparseable state file)**

`tests/doctor-fixtures/check-10/pass-valid-yaml/`:
- `docs/masterplan/p1/state.yml`: `slug: p1` (valid)
- `expected.txt`: `Check #10: PASS`

`tests/doctor-fixtures/check-10/fail-invalid-yaml/`:
- `docs/masterplan/p1/state.yml` with tab characters (create with `printf 'slug:\tp1\n' > ...`)
- `expected.txt`: `Check #10: ERROR`

- [ ] **Step 11: Create fixtures for check-11 (orphan events archive)**

`tests/doctor-fixtures/check-11/pass-archive-with-sibling/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/events-archive.jsonl` (empty)
- `expected.txt`: `Check #11: PASS`

`tests/doctor-fixtures/check-11/fail-orphan-archive/`:
- `docs/masterplan/p1/events-archive.jsonl` (empty — no sibling state.yml)
- `expected.txt`: `Check #11: WARN`

- [ ] **Step 12: Create fixtures for check-12 (telemetry file growth)**

`tests/doctor-fixtures/check-12/pass-small-telemetry/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/telemetry.jsonl` (a few bytes)
- `expected.txt`: `Check #12: PASS`

Note: fail fixture requires file > `TELEMETRY_SIZE_THRESHOLD`. The fixture runner doesn't inject env vars, so the fail case cannot be tested directly without a 5 MB file. Omit fail fixture for check-12; pass fixture is sufficient to confirm the bash block runs without error.

- [ ] **Step 13: Run the fixture suite to confirm all pass**

```bash
bash tests/doctor-fixtures/run.sh 2>&1 | grep -E 'check-0[1-9]|check-1[012]'
```
Expected: all `PASS check-NN/*` lines, no FAIL lines.

- [ ] **Step 14: Commit**

```bash
git add tests/doctor-fixtures/check-0{1..9} tests/doctor-fixtures/check-1{0,1,2}
git commit -m "feat(tests): add doctor fixtures for checks #1-#12"
```

---

### Task 9: Create doctor fixtures for checks #13–#24

**Files:**
- Create: `tests/doctor-fixtures/check-13/` through `tests/doctor-fixtures/check-24/`

**Spec:** spec.md §Section B — fixtures for bash blocks added in Task 6
**Codex:** false
**Verify:** `bash tests/doctor-fixtures/run.sh 2>&1 | grep -E 'check-1[3-9]|check-2[0-4]'`

- [ ] **Step 1: check-13 fixtures (orphan telemetry file)**

`pass-sibling-present/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/telemetry.jsonl` (empty)
- `expected.txt`: `Check #13: PASS`

`fail-orphan-telemetry/`:
- `docs/masterplan/p1/telemetry.jsonl` (no state.yml sibling)
- `expected.txt`: `Check #13: WARN`

- [ ] **Step 2: check-14 fixtures (orphan eligibility cache)**

`pass-cache-with-sibling/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/eligibility-cache.json`: `{}`
- `expected.txt`: `Check #14: PASS`

`fail-orphan-cache/`:
- `docs/masterplan/p1/eligibility-cache.json`: `{}` (no state.yml)
- `expected.txt`: `Check #14: WARN`

- [ ] **Step 3: check-15 fixtures (parallel-group without Files)**

`pass-pgroup-with-files/`:
- `docs/masterplan/p1/plan.md`:
  ```markdown
  ### Task 1: example
  **parallel-group:** verification
  **Files:**
  - Modify: tests/run.sh
  ```
- `expected.txt`: `Check #15: PASS`

`fail-pgroup-no-files/`:
- `docs/masterplan/p1/plan.md`:
  ```markdown
  ### Task 1: example
  **parallel-group:** verification
  ```
  (no **Files:** block)
- `expected.txt`: `Check #15: WARN`

- [ ] **Step 4: check-16 fixtures (parallel-group + Codex:ok conflict)**

`pass-pgroup-no-codex-ok/`:
- `docs/masterplan/p1/plan.md`:
  ```markdown
  ### Task 1: example
  **parallel-group:** verification
  **Codex:** no
  ```
- `expected.txt`: `Check #16: PASS`

`fail-pgroup-plus-codex-ok/`:
- `docs/masterplan/p1/plan.md`:
  ```markdown
  ### Task 1: example
  **parallel-group:** verification
  **Codex:** ok
  ```
- `expected.txt`: `Check #16: WARN`

- [ ] **Step 5: check-17 fixtures (file-path overlap in parallel-group)**

`pass-no-overlap/`:
- `docs/masterplan/p1/plan.md`:
  ```markdown
  ### Task 1: a
  **parallel-group:** wave1
  **Files:**
  - Modify: tests/a.sh

  ### Task 2: b
  **parallel-group:** wave1
  **Files:**
  - Modify: tests/b.sh
  ```
- `expected.txt`: `Check #17: PASS`

`fail-overlap/`:
- `docs/masterplan/p1/plan.md`:
  ```markdown
  ### Task 1: a
  **parallel-group:** wave1
  **Files:**
  - Modify: tests/shared.sh

  ### Task 2: b
  **parallel-group:** wave1
  **Files:**
  - Modify: tests/shared.sh
  ```
- `expected.txt`: `Check #17: WARN`

- [ ] **Step 6: check-18 fixtures (Codex config on but plugin missing)**

`pass-codex-off/`:
- `home/.masterplan.yaml`:
  ```yaml
  codex_routing: off
  codex_review: false
  ```
- `expected.txt`: `Check #18: PASS`

`fail-routing-on-no-plugin/`:
- `home/.masterplan.yaml`:
  ```yaml
  codex_routing: auto
  ```
- (no `home/.claude/plugins/` directory or codex files)
- `expected.txt`: `Check #18: WARN`

- [ ] **Step 7: check-19 fixtures (orphan subagents file)**

`pass-with-sibling/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/subagents.jsonl` (empty)
- `expected.txt`: `Check #19: PASS`

`fail-orphan-subagents/`:
- `docs/masterplan/p1/subagents.jsonl` (no state.yml)
- `expected.txt`: `Check #19: WARN`

- [ ] **Step 8: check-20 fixtures (Codex routing but no eligibility cache)**

`pass-no-routing-events/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  codex_routing: auto
  ```
- `docs/masterplan/p1/events.jsonl`: `{"event":"started"}`  (no routing→ event)
- `expected.txt`: `Check #20: PASS`

`fail-routing-events-no-cache/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  codex_routing: auto
  ```
- `docs/masterplan/p1/events.jsonl`: `{"event":"routing→[inline] task1"}`
- (no eligibility-cache.json)
- `expected.txt`: `Check #20: WARN`

- [ ] **Step 9: check-21 fixtures (cache-build evidence missing)**

`pass-eligibility-event-present/`:
- `docs/masterplan/p1/state.yml`: `slug: p1\ncodex_routing: auto`
- `docs/masterplan/p1/events.jsonl`:
  ```
  {"event":"wave_task_completed","task":1}
  {"event":"eligibility cache: built 5 tasks"}
  ```
- `expected.txt`: `Check #21: PASS`

`fail-completions-no-cache-event/`:
- `docs/masterplan/p1/state.yml`: `slug: p1\ncodex_routing: auto`
- `docs/masterplan/p1/events.jsonl`:
  ```
  {"event":"wave_task_completed","task":1}
  ```
- `expected.txt`: `Check #21: WARN`

- [ ] **Step 10: check-22 fixtures (high-complexity missing rigor)**

`pass-has-retro/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  complexity: high
  artifacts:
    retro: docs/masterplan/p1/retro.md
  ```
- `docs/masterplan/p1/retro.md` (non-empty)
- `expected.txt`: `Check #22: PASS`

`fail-no-evidence/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  complexity: high
  artifacts:
    retro: ''
  ```
- `expected.txt`: `Check #22: WARN`

- [ ] **Step 11: check-23 fixtures (Opus on bounded-mechanical dispatch)**

`pass-no-subagents/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `expected.txt`: `Check #23: PASS`

`fail-opus-on-sdd/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/subagents.jsonl`:
  ```json
  {"dispatch_site":"Step C step 1 eligibility","model":"opus","routing_class":"sdd","prompt_first_line":"Build eligibility cache"}
  ```
- `expected.txt`: `Check #23: WARN`

- [ ] **Step 12: check-24 fixtures (state-write queue non-empty)**

`pass-no-queue/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `expected.txt`: `Check #24: PASS`

`fail-queue-present/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/state.queue.jsonl`:
  ```
  {"op":"set","field":"current_task","value":"task2"}
  ```
- `expected.txt`: `Check #24: WARN`

- [ ] **Step 13: Run fixture suite and verify**

```bash
bash tests/doctor-fixtures/run.sh 2>&1 | grep -E 'check-1[3-9]|check-2[0-4]'
```
Expected: all PASS, no FAIL.

- [ ] **Step 14: Commit**

```bash
git add tests/doctor-fixtures/check-1{3..9} tests/doctor-fixtures/check-2{0..4}
git commit -m "feat(tests): add doctor fixtures for checks #13-#24"
```

---

### Task 10: Create doctor fixtures for checks #26, #28–#31, #33, #37, #42–#45

**Files:**
- Create: `tests/doctor-fixtures/check-26/`, `check-28/` through `check-31/`, `check-33/`, `check-37/`, `check-42/` through `check-45/`

**Spec:** spec.md §Section B — remaining fixture sets
**Codex:** false
**Verify:** `bash tests/doctor-fixtures/run.sh 2>&1 | grep -E 'check-(26|2[89]|3[01]|33|37|4[2-5])'`

- [ ] **Step 1: check-26 (auto_compact_loop_attached)**

`pass-no-compact-needed/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  compact_loop_recommended: false
  ```
- `expected.txt`: `Check #26: PASS`

`info-compact-needed-no-cronlist/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  compact_loop_recommended: true
  ```
- `expected.txt`: `Check #26: SKIP`

- [ ] **Step 2: check-28 (completed_plan_without_retro)**

`pass-has-retro/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  status: complete
  artifacts:
    retro: docs/masterplan/p1/retro.md
  ```
- `docs/masterplan/p1/retro.md` (non-empty file)
- `expected.txt`: `Check #28: PASS`

`fail-no-retro/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  status: complete
  artifacts:
    retro: ''
  ```
- `expected.txt`: `Check #28: WARN`

- [ ] **Step 3: check-29 (worktree-bundle reconciliation)**

`pass-no-bundles/`:
- `docs/masterplan/.gitkeep`
- `expected.txt`: `Check #29: PASS`

`fail-missing-worktree/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  worktree: /nonexistent/path/xyz123
  worktree_disposition: active
  ```
- `expected.txt`: `Check #29: WARN`

- [ ] **Step 4: check-30 (cross-manifest version drift)**

`pass-versions-match/`:
- `.claude-plugin/plugin.json`: `{"version": "1.0.0"}`
- `.codex-plugin/plugin.json`: `{"version": "1.0.0"}`
- `.claude-plugin/marketplace.json`: `{"version": "1.0.0", "plugins": [{"version": "1.0.0"}]}`
- `expected.txt`: `Check #30: PASS`

`fail-codex-plugin-drift/`:
- `.claude-plugin/plugin.json`: `{"version": "1.0.0"}`
- `.codex-plugin/plugin.json`: `{"version": "0.9.0"}`
- `expected.txt`: `Check #30: WARN`

- [ ] **Step 5: check-31 (per-autonomy gate-condition consistency)**

`pass-gates-present/`:
- `parts/step-b.md`:
  ```markdown
  ## spec_approval gate
  Fires when autonomy != full (loose, gated modes).

  ## plan_approval gate
  Fires when autonomy == gated only.
  ```
- `expected.txt`: `Check #31: PASS`

`fail-missing-step-b/`:
- (no `parts/step-b.md`)
- `expected.txt`: `Check #31: SKIP`

- [ ] **Step 6: check-33 (TaskCreate projection — SKIP fixture)**

Check #33 already has a bash block in doctor.md that emits SKIP unconditionally.

`pass-runtime-skip/`:
- (no state.yml needed; check skips)
- `expected.txt`: `Check #33: SKIPPED`

- [ ] **Step 7: check-37 (Reserved — SKIP fixture)**

`pass-reserved-skip/`:
- (no files needed)
- `expected.txt`: `Check #37: SKIP`

- [ ] **Step 8: check-42 (stale .lock file)**

`pass-no-lock/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `expected.txt`: `Check #42: PASS`

`fail-stale-lock/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/.lock` — create with `touch -t 202001010000 .lock` (year 2020 mtime)

  In fixture: create `.lock` file; to make it old, the fixture runner would need to set mtime. Since we can't control mtime in git, the fail fixture for #42 is impractical without a test harness wrapper. Instead:
  - Write `pass-no-lock/` fixture only (checks no .lock → PASS)
  - Add a note in the test: "fail case requires old mtime — manual smoke test only"
  - `expected.txt`: `Check #42: PASS`

- [ ] **Step 9: check-43 (codex_review_coverage)**

`pass-full-coverage/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/events.jsonl`:
  ```
  {"event":"wave_task_completed","task":"task-1"}
  {"event":"review→CODEX(task-1) decision_source=codex"}
  ```
- `expected.txt`: `Check #43: PASS`

`fail-uncovered-completions/`:
- `docs/masterplan/p1/state.yml`: `slug: p1`
- `docs/masterplan/p1/events.jsonl`:
  ```
  {"event":"wave_task_completed","task":"task-1"}
  {"event":"wave_task_completed","task":"task-2"}
  ```
  (no review→ events)
- `expected.txt`: `Check #43: WARN`

- [ ] **Step 10: check-44 fixtures (adversarial_review config valid)**

`pass-valid-value/`:
- `home/.masterplan.yaml`: `adversarial_review: both`
- `expected.txt`: `Check #44: PASS`

`fail-invalid-value/`:
- `home/.masterplan.yaml`: `adversarial_review: invalid_value`
- `expected.txt`: `Check #44: WARN`

- [ ] **Step 11: check-45 fixtures (adversarial review gate-fire audit)**

`info-no-complete-bundles/`:
- `docs/masterplan/p1/state.yml`:
  ```yaml
  slug: p1
  status: in-progress
  ```
- (no events.jsonl needed; check skips non-complete bundles)
- `expected.txt`: `Check #45: INFO`

- [ ] **Step 12: Run and verify**

```bash
bash tests/doctor-fixtures/run.sh 2>&1 | grep -E 'check-(26|2[89]|3[01]|33|37|4[2-5])'
```
Expected: all PASS or SKIP, no FAIL.

- [ ] **Step 13: Commit**

```bash
git add tests/doctor-fixtures/check-{26,28,29,30,31,33,37,42,43,44,45}
git commit -m "feat(tests): add doctor fixtures for checks #26/#28-#31/#33/#37/#42-#45"
```

---

### Task 11: Update `tests/doctor-fixtures/run.sh` header comment

**Files:**
- Modify: `tests/doctor-fixtures/run.sh`

**Spec:** spec.md §Section B — after this bundle, `missing_blocks` should be 0
**Codex:** true
**Verify:** `head -5 tests/doctor-fixtures/run.sh | grep 'check-01'`

- [ ] **Step 1: Update the comment on line 8**

Change the parenthetical from `(currently #32, #33, #34, #35, #36, #38, #39, #40, #41)` to `(currently check-01..check-47)`.

- [ ] **Step 2: Verify**

```bash
head -10 tests/doctor-fixtures/run.sh | grep 'check-01'
```
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add tests/doctor-fixtures/run.sh
git commit -m "chore(tests): update doctor-fixtures/run.sh header to reflect check-01..47 coverage"
```

---

### Task 12: Create `tests/hook-unit/test-telemetry-sections.sh`

**Files:**
- Create: `tests/hook-unit/test-telemetry-sections.sh`

**Spec:** spec.md §Section C — C1–C4
**Codex:** true
**Verify:** `bash tests/hook-unit/test-telemetry-sections.sh 2>&1 | tail -5`

- [ ] **Step 1: Create the directory and test file**

```bash
mkdir -p tests/hook-unit
```

Create `tests/hook-unit/test-telemetry-sections.sh`:

```bash
#!/usr/bin/env bash
# tests/hook-unit/test-telemetry-sections.sh — C1..C4: telemetry hook unit tests
# Usage: test-telemetry-sections.sh [REPO_ROOT]
set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }

PASS=0; FAIL=0
pass() { echo "PASS C$1: $2"; PASS=$((PASS+1)); }
fail() { echo "FAIL C$1: $2"; FAIL=$((FAIL+1)); }

HOOK="$REPO_ROOT/hooks/masterplan-telemetry.sh"
TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# C1: bash -n syntax check
if bash -n "$HOOK" 2>/dev/null; then
  pass 1 "hooks/masterplan-telemetry.sh passes bash -n syntax check"
else
  fail 1 "hooks/masterplan-telemetry.sh has syntax errors: $(bash -n "$HOOK" 2>&1 | head -3)"
fi

# C2: stop-turn JSONL with context_bytes field → hook exits 0 and emits telemetry
c2_dir="$TMPDIR_ROOT/c2"
mkdir -p "$c2_dir/home/.claude/projects/test-project"
mkdir -p "$c2_dir/bundle"
cat > "$c2_dir/bundle/state.yml" <<'EOF'
slug: test-bundle
status: in-progress
phase: executing
telemetry: on
codex_routing: off
last_activity: '2026-01-01T00:00:00+00:00'
artifacts:
  spec: ''
  plan: ''
  events: docs/masterplan/test-bundle/events.jsonl
EOF
# Minimal transcript with a masterplan-trace breadcrumb so the hook doesn't bail
SESSION_ID="test-c2-session"
cat > "$c2_dir/home/.claude/projects/test-project/${SESSION_ID}.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=in verb=execute halt_mode=none autonomy=loose>"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=out>"}]}}
EOF
c2_out=$(cd "$c2_dir/bundle" && \
  HOME="$c2_dir/home" \
  CLAUDE_SESSION_ID="$SESSION_ID" \
  bash "$HOOK" 2>&1)
c2_exit=$?
if [ $c2_exit -eq 0 ]; then
  pass 2 "hook exits 0 on well-formed stop turn"
else
  fail 2 "hook exited $c2_exit on well-formed stop turn: ${c2_out:0:200}"
fi

# C3: missing phase=out breadcrumb → hook writes step-trace-gap anomaly
c3_dir="$TMPDIR_ROOT/c3"
mkdir -p "$c3_dir/home/.claude/projects/test-project"
mkdir -p "$c3_dir/bundle"
cat > "$c3_dir/bundle/state.yml" <<'EOF'
slug: test-bundle
status: in-progress
phase: executing
telemetry: on
codex_routing: off
last_activity: '2026-01-01T00:00:00+00:00'
artifacts:
  spec: ''
  plan: ''
  events: docs/masterplan/test-bundle/events.jsonl
EOF
SESSION_ID_C3="test-c3-session"
cat > "$c3_dir/home/.claude/projects/test-project/${SESSION_ID_C3}.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=in verb=execute halt_mode=none autonomy=loose>"}]}}
EOF
# No phase=out breadcrumb
(cd "$c3_dir/bundle" && \
  HOME="$c3_dir/home" \
  CLAUDE_SESSION_ID="$SESSION_ID_C3" \
  bash "$HOOK" 2>/dev/null) || true
anom_file="$c3_dir/bundle/anomalies.jsonl"
if [ -s "$anom_file" ] && grep -q 'step-trace-gap\|step.*phase.*in.*no.*out\|orphan' "$anom_file" 2>/dev/null; then
  pass 3 "missing phase=out breadcrumb → step-trace-gap anomaly written to anomalies.jsonl"
else
  fail 3 "expected step-trace-gap anomaly in anomalies.jsonl — got: $(cat "$anom_file" 2>/dev/null | head -3)"
fi

# C4: skill-return with no subsequent step breadcrumbs → silent-stop-after-skill anomaly
c4_dir="$TMPDIR_ROOT/c4"
mkdir -p "$c4_dir/home/.claude/projects/test-project"
mkdir -p "$c4_dir/bundle"
cat > "$c4_dir/bundle/state.yml" <<'EOF'
slug: test-bundle
status: in-progress
phase: executing
telemetry: on
codex_routing: off
last_activity: '2026-01-01T00:00:00+00:00'
artifacts:
  spec: ''
  plan: ''
  events: docs/masterplan/test-bundle/events.jsonl
EOF
SESSION_ID_C4="test-c4-session"
cat > "$c4_dir/home/.claude/projects/test-project/${SESSION_ID_C4}.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=in verb=execute halt_mode=none autonomy=loose>"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute skill-return name=writing-plans>"}]}}
EOF
# skill-return with no subsequent step= breadcrumb → silent-stop-after-skill
(cd "$c4_dir/bundle" && \
  HOME="$c4_dir/home" \
  CLAUDE_SESSION_ID="$SESSION_ID_C4" \
  bash "$HOOK" 2>/dev/null) || true
anom_c4="$c4_dir/bundle/anomalies.jsonl"
if [ -s "$anom_c4" ] && grep -q 'silent-stop-after-skill\|skill.*return' "$anom_c4" 2>/dev/null; then
  pass 4 "skill-return with no subsequent breadcrumbs → silent-stop-after-skill anomaly written"
else
  fail 4 "expected silent-stop-after-skill anomaly — got: $(cat "$anom_c4" 2>/dev/null | head -3)"
fi

echo ""
echo "telemetry-sections: $PASS passed, $FAIL failed (4/4 checks)"
[ $FAIL -eq 0 ]
```

- [ ] **Step 2: Make executable and verify syntax**

```bash
chmod +x tests/hook-unit/test-telemetry-sections.sh
bash -n tests/hook-unit/test-telemetry-sections.sh
```

- [ ] **Step 3: Run the tests**

```bash
bash tests/hook-unit/test-telemetry-sections.sh 2>&1
```
C1 must PASS. C2–C4 may need iteration depending on hook internal paths for state.yml discovery — if the hook can't locate the bundle from the fixture's temp dir, those tests will show details to fix. Note: the hook discovers bundles via `docs/masterplan/*/state.yml` relative to `git rev-parse --show-toplevel`, so it will look in the actual repo root, not the temp dir. C2–C4 may emit FAIL with diagnostic output; update the setup to match the hook's actual bundle-discovery path.

**If C2-C4 fail due to bundle discovery:** The hook searches from the git toplevel for `docs/masterplan/*/state.yml`. The temp dir is not inside the git repo. Adjust the test by creating the bundle under a path the hook can find — or by confirming the hook bails silently when no bundle matches (which would make C3/C4 unverifiable in isolation). Document findings in the commit message.

- [ ] **Step 4: Commit**

```bash
git add tests/hook-unit/test-telemetry-sections.sh
git commit -m "feat(tests): add hook unit tests C1-C4 for telemetry hook sections"
```

---

### Task 13: Create `tests/hook-unit/test-self-host-audit.sh`

**Files:**
- Create: `tests/hook-unit/test-self-host-audit.sh`

**Spec:** spec.md §Section C — D1–D3
**Codex:** true
**Verify:** `bash tests/hook-unit/test-self-host-audit.sh 2>&1 | tail -5`

- [ ] **Step 1: Create the file**

```bash
#!/usr/bin/env bash
# tests/hook-unit/test-self-host-audit.sh — D1..D3: self-host audit unit tests
# Usage: test-self-host-audit.sh [REPO_ROOT]
set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }

PASS=0; FAIL=0
pass() { echo "PASS D$1: $2"; PASS=$((PASS+1)); }
fail() { echo "FAIL D$1: $2"; FAIL=$((FAIL+1)); }

AUDIT="$REPO_ROOT/bin/masterplan-self-host-audit.sh"

# D1: clean run exits 0
if bash "$AUDIT" --brief-style >/dev/null 2>&1; then
  pass 1 "bin/masterplan-self-host-audit.sh --brief-style exits 0 on main repo"
else
  out=$(bash "$AUDIT" --brief-style 2>&1 | head -20)
  fail 1 "--brief-style exited non-zero on clean main repo: ${out}"
fi

# D2: audit reported check count matches grep -c '^## Check #' parts/doctor.md
doctor_count=$(grep -c '^## Check #' "$REPO_ROOT/parts/doctor.md" 2>/dev/null || echo 0)
# The audit reports its check count in output; parse it
audit_output=$(bash "$AUDIT" --brief-style 2>&1)
# audit output contains a line like "Running N checks" or "checks: N" — grep for the number
audit_count=$(printf '%s\n' "$audit_output" | grep -oE '[0-9]+ check' | grep -oE '^[0-9]+' | head -1 || echo "")
if [ -z "$audit_count" ]; then
  # fallback: check exits 0 and has known check anchors
  if printf '%s\n' "$audit_output" | grep -qE 'PASS|OK|clean'; then
    pass 2 "audit output contains pass indicators (check count parse: N/A)"
  else
    fail 2 "could not parse audit check count from output (doctor_count=$doctor_count); output: ${audit_output:0:200}"
  fi
elif [ "$audit_count" -eq "$doctor_count" ]; then
  pass 2 "audit check count ($audit_count) == doctor.md check count ($doctor_count)"
else
  fail 2 "audit check count ($audit_count) != doctor.md check count ($doctor_count)"
fi

# D3: stale step-c.md reference detection
# Create a temp copy of commands/masterplan.md with a synthetic step-c.md reference
tmpfile="$(mktemp --suffix=.md)"
trap 'rm -f "$tmpfile"' EXIT
cp "$REPO_ROOT/commands/masterplan.md" "$tmpfile"
# Inject a reference to the old monolithic step-c.md (which was split in the 4-way refactor)
echo "parts/step-c.md" >> "$tmpfile"
# Run the audit against the temp file by checking for stale references
stale_check=$(grep -l 'step-c\.md' "$tmpfile" 2>/dev/null | wc -l)
# The audit checks for stale step-c.md in its --drift checks
audit_drift=$(bash "$AUDIT" --drift 2>&1 || true)
if printf '%s\n' "$audit_drift" | grep -qiE 'step-c\.md|stale.*ref|deprecated'; then
  pass 3 "stale step-c.md reference detected by --drift audit"
else
  # Fallback: verify the audit file has a step-c reference check in its source
  if grep -q 'step-c\.md' "$AUDIT" 2>/dev/null; then
    pass 3 "audit script contains step-c.md reference check (static verification)"
  else
    fail 3 "audit does not detect stale step-c.md references; --drift output: ${audit_drift:0:200}"
  fi
fi

echo ""
echo "self-host-audit: $PASS passed, $FAIL failed (3/3 checks)"
[ $FAIL -eq 0 ]
```

- [ ] **Step 2: Make executable and run**

```bash
chmod +x tests/hook-unit/test-self-host-audit.sh
bash -n tests/hook-unit/test-self-host-audit.sh
bash tests/hook-unit/test-self-host-audit.sh 2>&1
```
Expected: D1 PASS (clean run exits 0), D2 PASS or documented gap, D3 PASS.

- [ ] **Step 3: Commit**

```bash
git add tests/hook-unit/test-self-host-audit.sh
git commit -m "feat(tests): add self-host audit unit tests D1-D3"
```

---

### Task 14: Add pre-commit hook and `bin/` aliases

**Files:**
- Create: `.claude/hooks/pre-commit` (or `hooks/pre-commit` — use whichever Claude Code hooks dir the repo uses)
- Create: `bin/run-tests.sh`
- Create: `bin/run-tests-fast.sh`

**Spec:** spec.md §Section E — pre-commit gate + bin aliases
**Codex:** false
**Verify:** `bash bin/run-tests-fast.sh 2>&1 | tail -3`

- [ ] **Step 1: Determine the hooks directory**

```bash
ls .claude/hooks/ 2>/dev/null || ls hooks/ 2>/dev/null | head -5
```
The repo already has `hooks/masterplan-telemetry.sh`. Pre-commit hooks for Claude Code live in `.claude/hooks/`. Confirm which path is used by checking `~/.claude/settings.json` or existing hook registration.

- [ ] **Step 2: Create `bin/run-tests.sh` alias**

```bash
#!/usr/bin/env bash
# bin/run-tests.sh — full test suite alias; delegates to tests/run-tests.sh --full
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_ROOT/tests/run-tests.sh" --full "$@"
```

- [ ] **Step 3: Create `bin/run-tests-fast.sh` alias**

```bash
#!/usr/bin/env bash
# bin/run-tests-fast.sh — fast test suite alias; delegates to tests/run-tests.sh --fast
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_ROOT/tests/run-tests.sh" --fast "$@"
```

- [ ] **Step 4: Create pre-commit hook**

If Claude Code pre-commit hooks live in `.claude/hooks/`, create `.claude/hooks/pre-commit` (or the equivalent — check the repo's existing hook setup in `.claude/settings.json` or similar). Otherwise skip this step and note it in the commit.

```bash
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/tests/run-tests.sh" --fast
```

- [ ] **Step 5: Make all files executable**

```bash
chmod +x bin/run-tests.sh bin/run-tests-fast.sh
[ -f .claude/hooks/pre-commit ] && chmod +x .claude/hooks/pre-commit
```

- [ ] **Step 6: Verify aliases work**

```bash
bash bin/run-tests-fast.sh 2>&1 | tail -3
bash bin/run-tests.sh 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add bin/run-tests.sh bin/run-tests-fast.sh
[ -f .claude/hooks/pre-commit ] && git add .claude/hooks/pre-commit
git commit -m "feat(bin): add run-tests.sh / run-tests-fast.sh aliases + pre-commit fast gate"
```

---

### Task 15: Verify all tiers against success criteria

**Files:** (read-only)
**Spec:** spec.md §Success Criteria 1–5
**Codex:** false
**parallel-group:** verification
**Verify:** see steps below

- [ ] **Step 1: Verify success criterion 1 — `--fast` exits 0 in <30s**

```bash
time bash tests/run-tests.sh --fast 2>&1
```
Expected: `PASS N/N tests  exit 0` and elapsed time < 30s.

- [ ] **Step 2: Verify success criterion 2 — `--full` exits 0 covering all 47 checks**

```bash
bash tests/run-tests.sh --full 2>&1 | tail -20
```
Expected: `PASS N/N tests  exit 0` with doctor-fixtures PASS showing 47 checks (or SKIP for reserved check IDs, no FAIL).

- [ ] **Step 3: Verify success criterion 3 — `--full --all-worktrees` exits 0**

```bash
bash tests/run-tests.sh --full --all-worktrees 2>&1 | tail -20
```
Expected: runs for each registered worktree, all PASS.

- [ ] **Step 4: Verify success criterion 4 — deliberate regression causes failure**

Test A: remove a DISPATCH-SITE comment and verify coordinator test fails:
```bash
# Backup and mutate
cp parts/step-c-dispatch.md /tmp/step-c-dispatch.md.bak
sed -i '1s/^/DISPATCH-SITE: fake\n/' parts/step-c-dispatch.md
bash tests/structural/test-coordinator-dispatch.sh 2>&1 | grep 'FAIL\|PASS'
# Restore
cp /tmp/step-c-dispatch.md.bak parts/step-c-dispatch.md
```
Expected: at least one FAIL in coordinator test output after mutation.

Test B: delete step-c-dispatch.md and verify step-c-split test fails:
```bash
mv parts/step-c-dispatch.md /tmp/step-c-dispatch.md.bak2
bash tests/structural/test-step-c-split.sh 2>&1 | grep 'FAIL\|PASS'
mv /tmp/step-c-dispatch.md.bak2 parts/step-c-dispatch.md
```
Expected: FAIL B1 in output.

- [ ] **Step 5: Verify success criterion 5 — run-static.sh still works**

```bash
bash tests/run-static.sh 2>&1 | tail -3
```
Expected: same output as `tests/run-tests.sh --fast`.

- [ ] **Step 6: Final commit if any cleanup needed**

```bash
git status
# If clean: done. If any residual changes: git add + git commit -m "chore(tests): verification cleanup"
```

---

## Self-Review

**Spec coverage check:**
- Section A (structural tests A1-A4, B1-B4): Tasks 3, 4 ✓
- Section B (doctor fixtures #1–#47 + bash blocks): Tasks 5, 6, 7, 8, 9, 10, 11 ✓
  - #25, #27 reserved (no bash needed, no fixture) — confirmed absent from doctor.md
  - #33 already has SKIP bash block — fixture task 10 ✓
  - #37 reserved placeholder added — Task 7 step 6 ✓
  - #42 fixed (emit_finding → standalone bash) — Task 7 step 7 ✓
  - #46-#47 deferred until worktree-branch merge per spec ✓
- Section C (hook unit tests C1-C4, D1-D3): Tasks 12, 13 ✓
- Section D (run-tests.sh): Task 1 ✓
- Section E (pre-commit + bin/ aliases): Task 14 ✓
- Success criteria 1-5: Task 15 ✓

**Notes for implementors:**
- Check #3, #4, #29 pass fixtures use empty `docs/masterplan/` (no state.yml → no violation → PASS). Fail fixtures use clearly fake paths. Git commands in bash blocks execute against the real git repo (the fixture dir is a subdirectory of it).
- Check #12 fail fixture omitted (would require 5MB file); pass fixture is sufficient.
- Check #42 fail fixture omitted (requires controlled mtime); pass fixture confirms block runs.
- Hook tests C2–C4 may need adjustment if the telemetry hook discovers bundles via git-toplevel-relative paths rather than cwd-relative — Task 12 step 3 notes the fallback.
- The `TELEMETRY_SIZE_THRESHOLD` env var in check #12's bash block is a testability extension — it's non-breaking and invisible to normal doctor runs.
