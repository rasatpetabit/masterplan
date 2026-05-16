#!/usr/bin/env bash
# Top-level runner for the static / structural test battery.
#
# Each test in tests/static/ is a self-contained bash script that exits 0 on
# pass, non-zero on fail. This runner executes them all, prints a per-test
# summary, and exits non-zero if any test failed.
#
# Designed to run pre-commit (cheap, <5s total) and in CI.

set -u
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

tests=(
  tests/static/test-yaml-frontmatter.sh
  tests/static/test-cross-refs.sh
  tests/static/test-bash-blocks.sh
  tests/static/test-manifest-drift.sh
)

pass=0
fail=0
for t in "${tests[@]}"; do
  if [ ! -x "$t" ]; then
    chmod +x "$t" 2>/dev/null || true
  fi
  if bash "$t"; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
  fi
done

echo ""
echo "=== static suite: $pass passed, $fail failed (of ${#tests[@]} total) ==="
[ $fail -eq 0 ]
