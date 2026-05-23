#!/usr/bin/env bash
# Deprecated alias — delegates to tests/run-tests.sh --fast
# Kept for backwards compatibility with any scripts calling run-static.sh directly.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec "$REPO_ROOT/tests/run-tests.sh" --fast "$@"
