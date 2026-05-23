#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${1:-$(git rev-parse --show-toplevel)}"
FAIL=0

f="$REPO_ROOT/docs/conventions/api-retry-policy.md"
if [ ! -f "$f" ]; then
  echo "FAIL: docs/conventions/api-retry-policy.md does not exist"
  FAIL=1
fi

if [ -f "$f" ]; then
  grep -qiE "retryable|retry" "$f" || { echo "FAIL: missing retryable classification"; FAIL=1; }
  grep -qiE "5s.*15s|15s.*45s|backoff" "$f" || { echo "FAIL: missing backoff schedule"; FAIL=1; }
  grep -qiE "codex|inline.*dispatch|dispatch.*inline" "$f" || { echo "FAIL: missing scope (codex vs inline)"; FAIL=1; }
  grep -qiE "429|rate.?limit|5xx|timeout" "$f" || { echo "FAIL: missing error class examples"; FAIL=1; }
fi

# Cross-ref checks
grep -q "api-retry-policy" "$REPO_ROOT/parts/step-c-dispatch.md" \
  || { echo "FAIL: step-c-dispatch.md missing api-retry-policy cross-ref"; FAIL=1; }
grep -q "api-retry-policy" "$REPO_ROOT/docs/internals/wave-dispatch.md" \
  || { echo "FAIL: wave-dispatch.md missing api-retry-policy cross-ref"; FAIL=1; }

[ $FAIL -eq 0 ] && echo "PASS: api-retry-policy checks" || exit 1
