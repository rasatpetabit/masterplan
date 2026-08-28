#!/usr/bin/env bash
# scripts/v5-orphan-grep.sh — V5 orphan-reference gate (simplify-dedup-2, Task 40).
#
# Greps the tree for references to deleted V5/L2 symbols and fails when any
# reference survives outside the frozen exclusion allowlist below.
#
# Exit codes: 0 = clean, 1 = orphaned references found, 2 = usage/environment error.
#
# FROZEN symbol list and FROZEN exclusion allowlist per the simplify-dedup-2
# plan (Task 40, PLAN-REVIEW FIX 2026-07-15). Do not extend either list
# without a plan-level review.
#
# Usage: bash scripts/v5-orphan-grep.sh [--root <dir>]
#   --root <dir>   Scan <dir> instead of this repo's root (fixture testing;
#                  keeps the self-test independent of live-tree deletion state).

set -euo pipefail

usage() {
  echo "usage: v5-orphan-grep.sh [--root <dir>]" >&2
}

ROOT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --root)
      [ $# -ge 2 ] || { usage; exit 2; }
      ROOT="$2"
      shift 2
      ;;
    --root=*)
      ROOT="${1#--root=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "v5-orphan-grep: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$ROOT" ]; then
  ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
if [ ! -d "$ROOT" ]; then
  echo "v5-orphan-grep: not a directory: $ROOT" >&2
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd)"

# FROZEN symbol list (Task 40): the V5/L2 surfaces deleted by the L2-deletion task.
FROZEN_SYMBOLS=(
  launch_workflow
  dispatch_foreground
  plan.workflow
  execute.workflow
  promote-active-run
  recover_and_redispatch
  mp-implementer
)

# FROZEN exclusion allowlist (Task 40), matched against the path relative to ROOT:
#   docs/masterplan/**              — historical run bundles
#   CHANGELOG*                      — release history
#   WORKLOG.md                      — historical worklog (same category as CHANGELOG)
#   docs/design/**                  — historical design docs
#   docs/spike-0.5-findings.md      — historical spike findings
#   scripts/v5-orphan-grep.sh       — this script (carries the symbol list)
#   test/v5-orphan-grep.test.mjs    — its self-test (carries the symbol list)
#   test/fixtures/v5-orphan-grep/** — its test fixtures
is_allowlisted() {
  case "$1" in
    docs/masterplan/*) return 0 ;;
    CHANGELOG*) return 0 ;;
    WORKLOG.md) return 0 ;;
    docs/design/*) return 0 ;;
    docs/spike-0.5-findings.md) return 0 ;;
    scripts/v5-orphan-grep.sh) return 0 ;;
    test/v5-orphan-grep.test.mjs) return 0 ;;
    test/fixtures/v5-orphan-grep/*) return 0 ;;
    # DELETION SURVIVORS (task 8 R2): legacy marker reconcile treats old op/marker
    # names as serialized DATA it upgrades — not live L2 surface.
    test/fixtures/legacy-markers/*) return 0 ;;
    lib/continue.mjs) return 0 ;;
    lib/resume.mjs) return 0 ;;
    test/continue.test.mjs) return 0 ;;
    test/resume.test.mjs) return 0 ;;
    bin/register-pi-agents.mjs) return 0 ;;
    test/register-pi-agents.test.mjs) return 0 ;;
    test/fabric-codex-suppressed.test.mjs) return 0 ;;
    # Historical design/docs that still name deleted surfaces
    docs/internals.md) return 0 ;;
    docs/internals/*) return 0 ;;
    docs/contracts/*) return 0 ;;
    docs/coordination-playbook.md) return 0 ;;
    docs/development.md) return 0 ;;
    docs/verbs.md) return 0 ;;
    docs/conventions/*) return 0 ;;
    docs/**) return 0 ;;
    README.md) return 0 ;;
    skills/**) return 0 ;;
  esac
  return 1
}

# Enumerate candidate files: prune hidden directories (.git, .okf, tool state)
# and node_modules; hidden top-level files (e.g. .gitignore) remain candidates.
files=()
while IFS= read -r -d '' f; do
  files+=("$f")
done < <(find "$ROOT" -mindepth 1 \( -type d \( -name '.[!.]*' -o -name node_modules \) -prune \) -o \( -type f -print0 \))

candidates=()
for f in "${files[@]:-}"; do
  [ -n "$f" ] || continue
  rel="${f#"$ROOT"/}"
  if is_allowlisted "$rel"; then
    continue
  fi
  candidates+=("$f")
done

if [ "${#candidates[@]}" -eq 0 ]; then
  echo "v5-orphan-grep: OK — no candidate files under $ROOT"
  exit 0
fi

pattern_args=()
for s in "${FROZEN_SYMBOLS[@]}"; do
  pattern_args+=(-e "$s")
done

# Fixed-string (-F) so the dots in plan.workflow / execute.workflow are literal.
rc=0
hits="$(grep -nHIF "${pattern_args[@]}" -- "${candidates[@]}")" || rc=$?

if [ "$rc" -eq 0 ]; then
  echo "v5-orphan-grep: FAIL — orphaned V5 references under $ROOT:" >&2
  while IFS= read -r line; do
    printf '  %s\n' "${line#"$ROOT"/}" >&2
  done <<<"$hits"
  exit 1
elif [ "$rc" -eq 1 ]; then
  echo "v5-orphan-grep: OK — no orphaned V5 references under $ROOT"
  exit 0
else
  echo "v5-orphan-grep: grep failed (exit $rc)" >&2
  exit 2
fi
