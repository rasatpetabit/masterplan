#!/usr/bin/env bash
# masterplan-release-gate.sh - pre-tag verification gate.
#
# Runs every verification surface that a release candidate must pass before
# `git tag` is allowed. Designed for both local pre-tag use and CI
# enforcement.
#
# Background: v5.8.1 shipped with a smoke-detectable regression because the
# verification baseline was captured before the bug-introducing commit, and
# the smoke was not re-run between WORKLOG capture and tag. This script
# closes that gap by making "all gates pass at HEAD" a single command.
#
# Exit codes:
#   0 - all gates pass; tagging is safe
#   1 - one or more gates failed
#   2 - script error (missing dependency, not in a git repo, etc.)

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo" >&2; exit 2; }
cd "$REPO_ROOT" || exit 2

FAILED=0
RAN=0

run_gate() {
  local name="$1"; shift
  RAN=$((RAN + 1))
  printf '\n=== %s ===\n' "$name"
  if "$@"; then
    printf '  -> OK\n'
  else
    printf '  -> FAIL\n'
    FAILED=$((FAILED + 1))
  fi
}

# --- 1. Shell syntax (hooks + bin) ---
shell_syntax() {
  local f rc=0
  for f in hooks/*.sh bin/*.sh; do
    [ -f "$f" ] || continue
    bash -n "$f" || { echo "  syntax error in $f"; rc=1; }
  done
  return $rc
}
run_gate "shell-syntax (bash -n on hooks/ + bin/)" shell_syntax

# --- 2. Python compile ---
python_compile() {
  python3 -m py_compile lib/*.py
}
run_gate "python-compile (lib/*.py)" python_compile

# --- 3. Python unit tests ---
python_unit_tests() {
  python3 -m unittest discover -s tests -p 'test_*.py' -v 2>&1
}
run_gate "python-unit-tests (tests/test_*.py)" python_unit_tests

# --- 4. Static structural tests ---
if [ -x tests/run-static.sh ]; then
  run_gate "static-tests (tests/run-static.sh)" bash tests/run-static.sh
fi

# --- 5. Policy regression smoke ---
run_gate "policy-regression-smoke" bash bin/masterplan-policy-regression-smoke.sh

# --- 6. Anomaly smoke (instrumentation framework) ---
if [ -x bin/masterplan-anomaly-smoke.sh ]; then
  run_gate "anomaly-smoke (instrumentation framework)" bash bin/masterplan-anomaly-smoke.sh
fi

# --- 7. Guard B smoke (cross-worktree slug collision) ---
if [ -x bin/masterplan-guard-b-smoke.sh ]; then
  run_gate "guard-b-smoke (slug collision)" bash bin/masterplan-guard-b-smoke.sh
fi

# --- 8. Guard C smoke (flock serialization) ---
if [ -x bin/masterplan-guard-c-smoke.sh ]; then
  run_gate "guard-c-smoke (flock serialization)" bash bin/masterplan-guard-c-smoke.sh
fi

# --- 9. Self-host audit ---
run_gate "self-host-audit" bash bin/masterplan-self-host-audit.sh

# --- Summary ---
printf '\n=== Release gate summary ===\n'
printf '  gates run:    %d\n' "$RAN"
printf '  gates failed: %d\n' "$FAILED"
printf '  HEAD:         %s\n' "$(git rev-parse --short HEAD)"

if [ "$FAILED" -gt 0 ]; then
  printf '\nRELEASE GATE: FAIL — do not tag.\n'
  exit 1
fi

printf '\nRELEASE GATE: PASS — tagging at this HEAD is safe.\n'
exit 0
