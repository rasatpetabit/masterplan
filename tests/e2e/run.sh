#!/usr/bin/env bash
# E2E test runner for /masterplan.
#
# Invokes `claude --print` against each fixture under tests/e2e/<name>/ and
# asserts that every line in `golden.grep` appears as a substring in stdout.
#
# Per-fixture layout:
#   tests/e2e/<name>/
#     prompt.txt   — input passed to `claude --print` (the slash command + args)
#     golden.grep  — newline-separated substrings that MUST appear in output
#     cwd/         — (optional) working directory for the invocation; if
#                    present, claude is launched with --add-dir <cwd> and cd'd
#                    into it. Provides a clean isolated repo state so the
#                    orchestrator's auto-resume controller doesn't pick up
#                    unrelated artifacts.
#     setup.sh     — (optional) executed in cwd/ before the run
#
# Opt-in: set CLAUDE_E2E=1 to run. Default behavior is to skip (these tests
# cost real money and take ~30-120s each).
#
# Configurable via env:
#   CLAUDE_E2E_MODEL    — model name (default: sonnet)
#   CLAUDE_E2E_BUDGET   — per-test max USD (default: 3.00)
#   CLAUDE_E2E_TIMEOUT  — per-test timeout seconds (default: 480)
#
# Why sonnet (not haiku): the /masterplan orchestrator loads a ~2150-line
# router and dispatches subagents. Haiku 4.5 trips autocompact thrash on the
# initial load. Sonnet handles it cleanly at ~$0.30 per simple-verb run.

set -uo pipefail

if [ "${CLAUDE_E2E:-0}" != "1" ]; then
  echo "=== e2e: SKIPPED (set CLAUDE_E2E=1 to run; costs real API spend) ==="
  exit 0
fi

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
e2e_dir="$repo_root/tests/e2e"

model="${CLAUDE_E2E_MODEL:-sonnet}"
budget="${CLAUDE_E2E_BUDGET:-3.00}"
to="${CLAUDE_E2E_TIMEOUT:-480}"

pass=0
fail=0
fails=()

for fixture_dir in "$e2e_dir"/*/; do
  [ -d "$fixture_dir" ] || continue
  name="$(basename "$fixture_dir")"
  prompt_file="$fixture_dir/prompt.txt"
  golden_file="$fixture_dir/golden.grep"

  if [ ! -f "$prompt_file" ] || [ ! -f "$golden_file" ]; then
    continue
  fi

  prompt="$(cat "$prompt_file")"
  run_cwd="$fixture_dir"
  if [ -d "$fixture_dir/cwd" ]; then
    run_cwd="$fixture_dir/cwd"
  fi

  if [ -f "$fixture_dir/setup.sh" ]; then
    (cd "$run_cwd" && bash "$fixture_dir/setup.sh") >/dev/null 2>&1 || {
      fail=$((fail+1))
      fails+=("$name (setup.sh failed)")
      echo "FAIL $name — setup.sh failed"
      continue
    }
  fi

  actual="$(cd "$run_cwd" && timeout "$to" claude --print \
    --max-budget-usd "$budget" \
    --model "$model" \
    --dangerously-skip-permissions \
    "$prompt" 2>&1)"
  rc=$?

  missing=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac   # allow # comments in golden
    if ! printf '%s\n' "$actual" | grep -qF -- "$line"; then
      missing+=("$line")
    fi
  done < "$golden_file"

  if [ ${#missing[@]} -eq 0 ] && [ $rc -eq 0 ]; then
    pass=$((pass+1))
    echo "PASS $name"
  else
    fail=$((fail+1))
    fails+=("$name")
    echo "FAIL $name (rc=$rc, missing ${#missing[@]} substring(s))"
    for m in "${missing[@]}"; do
      echo "    missing: $m"
    done
    echo "    --- actual (first 40 lines) ---"
    printf '%s\n' "$actual" | head -40 | sed 's/^/    /'
    echo "    --- end actual ---"
  fi
done

echo ""
echo "=== e2e: $pass passed, $fail failed ==="
[ $fail -eq 0 ]
