# Spec: Improve Masterplan Regression Detection

**Bundle**: improve-regression-detection  
**Date**: 2026-05-22  
**Status**: spec_gate

---

## Intent Anchor

**Mode**: implementation-design  
**Scope boundary**: `superpowers-masterplan` repo only. Changes confined to `tests/`, `bin/`, `parts/`, `hooks/`, `docs/`. No external test framework dependencies.  
**Verification ceiling**: local-static (grep + bash -n + exit-code checks; no runtime Claude invocations)

---

## Problem

The masterplan orchestrator has grown substantially in v6.0.0 (coordinator dispatch pattern, 4-way step-c split, checks #42–#47) without corresponding test coverage growth. The existing tests:

- `tests/static/` (4 tests) — covers YAML frontmatter, cross-refs, bash blocks, manifest drift
- `tests/doctor-fixtures/` — covers doctor checks #32–#41 only (10 of 47)
- `tests/e2e/` — integration tests, version-sentinel tracking

Missing coverage: coordinator dispatch invariants, step-c split structural integrity, doctor checks #1–#31 and #42–#47, hook section behavior.

**No binding trigger except discipline** — the existing tests run via `tests/run-static.sh` but there's no tiered model, no `--all-worktrees` sweep, and no clear pre-merge gate.

---

## Design

### Architecture

```
tests/
  run-tests.sh              ← NEW: single entry point with --fast/--full/--all-worktrees
  run-static.sh             ← KEPT: deprecated alias, calls run-tests.sh --fast
  static/                   ← EXISTING (unchanged): 4 current tests
    test-yaml-frontmatter.sh
    test-cross-refs.sh
    test-bash-blocks.sh
    test-manifest-drift.sh
  structural/               ← NEW: fast-tier coordinator + step-c structural tests
    test-coordinator-dispatch.sh
    test-step-c-split.sh
  doctor-fixtures/          ← EXTENDED: check-01..check-47 (currently check-32..41)
    check-01/ … check-47/
    run.sh                  ← extended to drive all 47 fixtures
  hook-unit/                ← NEW: telemetry hook + self-host audit unit tests
    test-telemetry-sections.sh
    test-self-host-audit.sh
  e2e/                      ← EXISTING (unchanged)
    run.sh
```

### Tiers

| Tier | Contents | Target time | When |
|---|---|---|---|
| `--fast` | `tests/static/*` + `tests/structural/*` | <30s | pre-commit hook |
| `--full` | `--fast` + doctor-fixtures/run.sh + hook-unit/* | <5min | CI, manual `bin/run-tests.sh --full` |
| `--full --all-worktrees` | `--full` repeated for each git worktree | <15min | pre-merge gate |

### `tests/run-tests.sh` Interface

```bash
tests/run-tests.sh [--fast|--full] [--all-worktrees]

# Defaults: --fast when no tier flag; current repo when no --all-worktrees
```

**Exit codes**: `0` = all pass, `1` = one or more failures.

**Output format** (human-readable, PASS/FAIL per test):
```
[FAST] test-yaml-frontmatter .............. PASS
[FAST] test-cross-refs ................... PASS
[FAST] test-coordinator-dispatch ......... PASS (4/4 checks)
[FAST] test-step-c-split ................. PASS (4/4 checks)
[FULL] doctor-fixtures check-01..check-47  PASS (47/47)
[FULL] hook-unit test-telemetry-sections . PASS (4/4)
[FULL] hook-unit test-self-host-audit .... PASS (3/3)
─────────────────────────────────────────────────
PASS 7/7 tests (58/58 checks)  exit 0
```

---

### Section A: Structural Tests (`tests/structural/`)

#### `test-coordinator-dispatch.sh` — 4 checks

All checks are grep-based against `parts/` and `commands/masterplan.md`.

| # | Name | Logic |
|---|---|---|
| A1 | DISPATCH-SITE markers | Every `Agent(` call has a `DISPATCH-SITE:` comment on the same or previous non-blank line. Count of `Agent(` == count of `DISPATCH-SITE:` occurrences. |
| A2 | Return-shape caps | Every `DISPATCH-SITE:` block (next 20 lines) includes `Return shape:` or `≤1000` annotation. |
| A3 | CC-2 inline-read guard | No `parts/step-*.md` file has 3+ consecutive lines matching `\*\*(Read|Bash|Glob)\*\*` tool-reference patterns without an intervening `DISPATCH-SITE:`, `coordinator`, or `## Step` boundary. |
| A4 | Fallback documentation | Every `DISPATCH-SITE:` block (next 40 lines) contains `Fallback` (case-insensitive). |

**Pass/fail**: each check exits with a count of violations; test passes when all counts == 0.

#### `test-step-c-split.sh` — 4 checks

| # | Name | Logic |
|---|---|---|
| B1 | All 4 files exist | `step-c-dispatch.md`, `step-c-resume.md`, `step-c-verification.md`, `step-c-completion.md` all present and non-empty (`wc -c > 0`). |
| B2 | No duplicate section headers | Extract `^##+ ` headings from all 4 files; assert no duplicates (case-insensitive). |
| B3 | CC-3 trampoline coverage | No non-negated `end the turn` phrase in `parts/step-c-*.md`. Non-negated: preceded by `never` or `do not` is OK; bare `end the turn` is a violation. |
| B4 | Xref resolution | All `parts/step-c*.md` and `parts/step-b*.md` filenames mentioned as `parts/<name>` in `parts/*.md` resolve to existing files. |

---

### Section B: Doctor Fixture Coverage

**Key constraint:** `tests/doctor-fixtures/run.sh` extracts embedded `bash` blocks from `parts/doctor.md` to run each check. Only checks that have embedded bash blocks are supported by this mechanism. Currently: checks #32–#36, #38–#42, #44–#45 have bash blocks. Checks #1–#31, #37, #43 are LLM-interpreted text (no shell block).

**Two fixture categories:**

**Category 1 — bash-block checks** (checks with extractable bash in doctor.md):
Use the existing fixture mechanism: `<verdict>-<description>/` directory + `expected.txt` substring file.

```
tests/doctor-fixtures/check-NN/
  pass-<description>/
    expected.txt          ← substring "Check #NN: PASS" must appear in output
    state.yml             ← synthetic state (or whatever the check reads)
  fail-<description>/
    expected.txt          ← substring "Check #NN: WARN" or "ERROR" must appear
    state.yml
```

**Category 2 — LLM-interpreted checks** (checks without bash blocks: #1–#31, #37, #43):
These checks have no extractable shell implementation in doctor.md. The fix: add a `bash` block to each such check in `doctor.md` that implements the check condition in shell. The bash block approach is already used for all post-#32 checks — extending it backward makes the entire check set testable consistently and is itself a robustness improvement (each check becomes independently auditable).

The `run.sh` already handles "missing bash block" gracefully (increments `missing_blocks` counter). After this bundle ships, `missing_blocks` should be 0 for all 47 checks.

**Check categorization:**

| Range | Category | Bash blocks? | Action |
|---|---|---|---|
| #1–#31 | Schema, status, worktree, misc | No | Add bash block to doctor.md + write fixtures |
| #32–#41 | Existing (kept as-is) | Yes (#32-#36, #38-#41) | Fixtures already exist |
| #37 | Investigate | Unknown | Determine if removed, skipped, or missing; add bash block + fixture or mark skip |
| #42–#45 | New checks | Yes (#42, #44, #45) | Write fixtures |
| #43 | codex_review_coverage | No | Add bash block + write fixtures |
| #46–#47 | CC-2 / return-shape (v6.2.0) | Yes (on worktree branch) | Write fixtures (after merge) |

**`tests/doctor-fixtures/run.sh`** extended:
- Iterates `check-01` through `check-47` in sequence
- For each: extracts bash block from doctor.md, runs against fixture dir, compares output to `expected.txt`
- Checks with no bash block: report as `SKIP (no bash block)` — not a test failure
- After this bundle: target `missing_blocks == 0`
- Aggregates PASS/FAIL; exits 1 if any fixture mismatches (SKIPs don't count as failures)

---

### Section C: Hook Unit Tests (`tests/hook-unit/`)

#### `test-telemetry-sections.sh` — 4 checks

Tests `hooks/masterplan-telemetry.sh` behavior with synthetic JSONL inputs.

| # | Check | Synthetic input | Assert |
|---|---|---|---|
| C1 | bash -n syntax | — | `bash -n hooks/masterplan-telemetry.sh` exits 0 |
| C2 | Stop-turn JSONL emits turn_context_bytes | Minimal stop event JSONL with `context_bytes` field | Hook exits 0; emitted JSONL contains `turn_context_bytes` key |
| C3 | Missing breadcrumb detection | JSONL with `phase=in` trace but no `phase=out` | Hook writes anomaly to `anomalies.jsonl` |
| C4 | CC-3 skip detection | Tool-use JSONL with `subagents_this_turn > 0` but no CC-3 summary string | Hook writes `cc3_skip` anomaly |

**Note**: C3 and C4 require a synthetic `MASTERPLAN_TELEMETRY_SESSION_DIR` to avoid polluting the real anomaly log.

#### `test-self-host-audit.sh` — 3 checks

| # | Check | Logic |
|---|---|---|
| D1 | Clean run exits 0 | `bash bin/masterplan-self-host-audit.sh --brief-style` against main repo exits 0 |
| D2 | Check count matches doctor.md | Audit's reported check count == `grep -c '^## Check #' parts/doctor.md` |
| D3 | Stale reference detection | Inject a synthetic `step-c.md` reference into a temp copy; assert audit exits non-zero or emits WARN |

---

### Section D: `tests/run-tests.sh` Implementation

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
      bash "$t" "$root"  # re-run for verbose output
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

---

### Section E: CI / Pre-Commit Integration

**Pre-commit hook** (`.claude/hooks/` or `hooks/`):
```bash
#!/usr/bin/env bash
exec "$(git rev-parse --show-toplevel)/tests/run-tests.sh" --fast
```

**GitHub Actions (`.github/workflows/regression.yml`)** — optional, not required:
```yaml
- name: Full regression suite
  run: tests/run-tests.sh --full --all-worktrees
```

**Manual invocation** (adds to `bin/` aliases per CLAUDE.md preference):
```bash
bin/run-tests.sh        # alias → tests/run-tests.sh --full
bin/run-tests-fast.sh   # alias → tests/run-tests.sh --fast
```

---

## Out of Scope

- Runtime invocations of the masterplan orchestrator (no Claude API calls in tests)
- Tests for external repos or sibling plugins
- CI infrastructure setup (GitHub Actions workflow file is optional/illustrative)
- Tests for `tests/e2e/run.sh` itself (e2e is its own suite)

---

## Success Criteria

1. `tests/run-tests.sh --fast` exits 0 on a clean main checkout in <30s
2. `tests/run-tests.sh --full` exits 0 on main checkout; covers all 47 doctor checks
3. `tests/run-tests.sh --full --all-worktrees` exits 0 on main + both active worktrees
4. A deliberate regression (removing a DISPATCH-SITE comment, deleting step-c-dispatch.md, corrupting a state.yml fixture) causes the appropriate test to exit non-zero
5. `run-static.sh` (old entry point) still works as before via the alias
