#!/usr/bin/env bash
# masterplan-wipe-telemetry.sh - Wipe pre-v5.1.1 Claude/Codex/per-bundle telemetry.
#
# Default mode is dry-run. Apply mode requires --apply and either --yes or
# an interactive 'wipe-confirmed' prompt. Hard-coded keep-list preserves all
# bundle work product (plan.md / state.yml / spec.md / retro.md / reviews/).
#
# Usage:
#   bin/masterplan-wipe-telemetry.sh                     # dry-run (default)
#   bin/masterplan-wipe-telemetry.sh --apply             # apply (interactive prompt)
#   bin/masterplan-wipe-telemetry.sh --apply --yes       # apply unattended
#   bin/masterplan-wipe-telemetry.sh --no-claude         # skip Claude transcripts
#   bin/masterplan-wipe-telemetry.sh --no-codex          # skip Codex artifacts
#   bin/masterplan-wipe-telemetry.sh --no-bundle-logs    # skip per-bundle telemetry
#   bin/masterplan-wipe-telemetry.sh --no-worktrees      # skip .worktrees/ copies
#   bin/masterplan-wipe-telemetry.sh --repo-roots=A:B    # override discovery roots
#   bin/masterplan-wipe-telemetry.sh --verbose           # show example deletion paths
#
# Manifest written to:
#   ${XDG_STATE_HOME:-~/.local/state}/superpowers-masterplan/wipes/<UTC-timestamp>.txt
#
# Implementation: thin wrapper around lib/masterplan_wipe_telemetry.py.

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

exec python3 "${repo_root}/lib/masterplan_wipe_telemetry.py" "$@"
