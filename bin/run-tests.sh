#!/usr/bin/env bash
# bin/run-tests.sh — full test suite alias; delegates to tests/run-tests.sh --full
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_ROOT/tests/run-tests.sh" --full "$@"
