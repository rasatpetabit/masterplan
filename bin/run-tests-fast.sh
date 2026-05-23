#!/usr/bin/env bash
# bin/run-tests-fast.sh — fast test suite alias; delegates to tests/run-tests.sh --fast
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_ROOT/tests/run-tests.sh" --fast "$@"
