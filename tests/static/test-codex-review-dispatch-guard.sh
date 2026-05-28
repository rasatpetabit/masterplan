#!/usr/bin/env bash
# Regression guard: every Codex REVIEW dispatch site must carry the
# anti-rationalization sentinel that stops the orchestrator from refusing a
# `codex:codex-rescue` dispatch by conflating it with the
# `/codex:adversarial-review` disable-model-invocation slash-command skill.
#
# Backstory: a B2 spec-review dispatch was refused at runtime with "that skill
# is disable-model-invocation, type the slash command" — a bogus punt that cost
# two user corrections. The fix embeds a stable sentinel at each dispatch site
# (contract + B2 + B3 + C4b serial + C4b wave). This test fails the static
# battery if any guard is stripped, so the regression cannot silently return.
#
# Scope: parts/contracts/codex-review.md, parts/step-b.md, parts/step-c-verification.md.

set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

SENTINEL='NOT the /codex:adversarial-review slash command'

# file : minimum required occurrences (one per dispatch site in that file)
check() {
  local file="$1" min="$2" got
  if [ ! -f "$file" ]; then
    echo "FAIL: missing $file"
    return 1
  fi
  got="$(grep -Fc "$SENTINEL" "$file")"
  if [ "$got" -lt "$min" ]; then
    echo "FAIL $file: dispatch-guard sentinel found ${got}x, need >=${min}x"
    echo "      sentinel: \"$SENTINEL\""
    return 1
  fi
  return 0
}

fail=0
check "parts/contracts/codex-review.md"   1 || fail=1   # §Dispatch mechanism
check "parts/step-b.md"                   2 || fail=1   # B2 spec + B3 plan
check "parts/step-c-verification.md"      2 || fail=1   # C4b serial + C4b wave-batched

if [ "$fail" -eq 0 ]; then
  echo "test-codex-review-dispatch-guard: PASS (all REVIEW dispatch sites guarded)"
  exit 0
fi
echo "test-codex-review-dispatch-guard: FAIL (a REVIEW dispatch site lost its anti-rationalization guard)"
exit 1
