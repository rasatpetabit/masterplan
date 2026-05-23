#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${1:-$(git rev-parse --show-toplevel)}"
FAIL=0

f="$REPO_ROOT/docs/conventions/codex-failure-policy.md"
if [ ! -f "$f" ]; then
  echo "FAIL: docs/conventions/codex-failure-policy.md does not exist"
  FAIL=1
fi

if [ -f "$f" ]; then
  grep -qiE "silent.?exit" "$f" || { echo "FAIL: missing silent exit classification"; FAIL=1; }
  grep -qiE "daemon.?broken" "$f" || { echo "FAIL: missing daemon-broken classification"; FAIL=1; }
  grep -qiE "auth.?degrad" "$f" || { echo "FAIL: missing auth-degraded classification"; FAIL=1; }
  grep -qiE "codex_failure_streak|consecutive.?fail|failure.?streak" "$f" || { echo "FAIL: missing consecutive-failure threshold"; FAIL=1; }
  grep -qiE "api-retry-policy" "$f" || { echo "FAIL: missing api-retry-policy cross-ref"; FAIL=1; }
  grep -qiE "inline.?fallback|fallback.*inline" "$f" || { echo "FAIL: missing inline fallback procedure"; FAIL=1; }
  grep -qiE "app-server control socket|ECONNREFUSED|socket already in use" "$f" \
    || { echo "FAIL: missing daemon error pattern examples"; FAIL=1; }
fi

# Cross-ref: step-c-dispatch.md must reference codex-failure-policy
grep -q "codex-failure-policy" "$REPO_ROOT/parts/step-c-dispatch.md" \
  || { echo "FAIL: step-c-dispatch.md missing codex-failure-policy cross-ref"; FAIL=1; }

# Detection logic: silent-exit detection must be in step-c-dispatch.md
grep -qiE "silent.?exit|silent exit" "$REPO_ROOT/parts/step-c-dispatch.md" \
  || { echo "FAIL: step-c-dispatch.md missing silent-exit detection"; FAIL=1; }

# Streak counter: codex_failure_streak must appear in step-c-dispatch.md
grep -q "codex_failure_streak" "$REPO_ROOT/parts/step-c-dispatch.md" \
  || { echo "FAIL: step-c-dispatch.md missing codex_failure_streak session var"; FAIL=1; }

[ $FAIL -eq 0 ] && echo "PASS: codex-failure-policy checks" || exit 1
