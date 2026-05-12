#!/usr/bin/env bash
# masterplan-session-audit.sh - Read-only last-N-hours audit for Claude, Codex,
# and /masterplan telemetry logs.

set -u

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "${repo_root}" || exit 2

exec python3 -m lib.masterplan_session_audit "$@"
