#!/usr/bin/env bash
# tests/run-tests.sh — tiered test runner
# Usage: run-tests.sh [--fast|--full] [--all-worktrees]

set -uo pipefail

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
      PASS=$((PASS+1))
    else
      printf "[FAST] %-40s FAIL\n" "$name"
      bash "$t" "$root" || true
      FAIL=$((FAIL+1))
    fi
  done

  # full tier additions
  if [[ "$TIER" == "full" ]]; then
    if bash "$root"/tests/doctor-fixtures/run.sh "$root" >/dev/null 2>&1; then
      printf "[FULL] %-40s PASS\n" "doctor-fixtures"
      PASS=$((PASS+1))
    else
      printf "[FULL] %-40s FAIL\n" "doctor-fixtures"
      bash "$root"/tests/doctor-fixtures/run.sh "$root" || true
      FAIL=$((FAIL+1))
    fi
    for t in "$root"/tests/hook-unit/test-*.sh; do
      [[ -f "$t" ]] || continue
      name=$(basename "$t" .sh)
      if bash "$t" "$root" >/dev/null 2>&1; then
        printf "[FULL] %-40s PASS\n" "$name"
        PASS=$((PASS+1))
      else
        printf "[FULL] %-40s FAIL\n" "$name"
        bash "$t" "$root" || true
        FAIL=$((FAIL+1))
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
