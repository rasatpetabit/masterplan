#!/usr/bin/env bash
# Verify cross-references in the orchestrator prompt resolve to real artifacts.
#
# Three classes of reference are checked:
#  1. File paths — any repo-relative `parts/X.md`, `commands/X.md`, `bin/X.sh`,
#     `hooks/X.sh`, `docs/X.md`, `skills/X/SKILL.md`, `.claude-plugin/X.json`,
#     `.codex-plugin/X.json` mentioned in any .md must exist on disk.
#  2. Contract IDs — every `contract_id: "X"` referenced in a parts/*.md or
#     commands/masterplan.md dispatch brief must have a matching
#     `## Contract: X` heading in commands/masterplan-contracts.md.
#  3. Doctor check IDs — every `Check #NN` cross-reference in commands/* and
#     parts/* must correspond to a real `## Check #NN` heading in
#     parts/doctor.md (or be one of the documented Reserved IDs).
#
# Exit 0 on PASS, 1 on FAIL.

set -u
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

fail=0

# ------------------------------------------------------------------
# Class 1 — file paths
# ------------------------------------------------------------------
# Extract repo-relative paths from all .md files under commands/, parts/, docs/
# Match: <prefix>/<one-or-more-segments>.<ext>
# Prefixes: parts, commands, skills, bin, hooks, docs, .claude-plugin, .codex-plugin, lib
# Exts: md, sh, json, yml, yaml, py
missing=0
seen_paths=0
while IFS= read -r refline; do
  [ -z "$refline" ] && continue
  src="${refline%%:*}"
  path="${refline#*:}"
  # Strip anchor fragments (e.g., docs/internals.md§Wave-dispatch → docs/internals.md)
  path="${path%%#*}"
  path="${path%%§*}"
  seen_paths=$((seen_paths + 1))
  if [ ! -e "$path" ]; then
    # Tolerate paths under docs/masterplan/<slug>/ — those are dynamic runtime
    # bundles, not static repo artifacts.
    case "$path" in
      docs/masterplan/*) continue ;;
      legacy/*)          continue ;;
    esac
    echo "FAIL $src: references non-existent path: $path"
    missing=$((missing + 1))
  fi
done < <(grep -rEho '(^|[^a-zA-Z0-9._/~-])(parts|commands|skills|bin|hooks|docs|lib|\.claude-plugin|\.codex-plugin)/[a-zA-Z0-9_./-]+\.(md|sh|json|yml|yaml|py)' commands/*.md parts/*.md docs/*.md 2>/dev/null \
  | sed -E 's/^[^a-zA-Z._]+//' \
  | sort -u \
  | while IFS= read -r p; do
      # Re-grep to find at least one source file mentioning p, so the failure
      # message can point at it. Exclude matches where the path is preceded by
      # '~/' or '/' (those are absolute user-home or filesystem paths, not
      # repo-relative references).
      src="$(grep -lE "(^|[^a-zA-Z0-9./_~-])${p//./\\.}([^a-zA-Z0-9./_-]|$)" commands/*.md parts/*.md docs/*.md 2>/dev/null | head -1)"
      echo "${src:-(unknown)}:$p"
    done)
if [ $missing -gt 0 ]; then
  fail=$((fail + 1))
  echo "  -> $missing missing path(s); $seen_paths total references checked"
fi

# ------------------------------------------------------------------
# Class 2 — contract IDs
# ------------------------------------------------------------------
# Build the set of defined contract_ids from commands/masterplan-contracts.md:
defined_contracts="$(grep -oE '^## Contract: [a-zA-Z0-9_.]+' commands/masterplan-contracts.md | awk '{print $3}' | sort -u)"

# Find every contract_id reference in parts/*.md and commands/masterplan.md:
missing_contracts=0
while IFS= read -r ref; do
  src="${ref%%:*}"
  cid="$(echo "$ref" | sed -E 's/.*contract_id:[[:space:]]*"([^"]+)".*/\1/')"
  [ -z "$cid" ] && continue
  # commands/masterplan-contracts.md is the registry — skip self-references.
  case "$src" in
    commands/masterplan-contracts.md) continue ;;
  esac
  if ! echo "$defined_contracts" | grep -qFx "$cid"; then
    echo "FAIL $src: references undefined contract_id: $cid"
    missing_contracts=$((missing_contracts + 1))
  fi
done < <(grep -rnE 'contract_id:[[:space:]]*"[^"]+"' parts/*.md commands/*.md 2>/dev/null)
if [ $missing_contracts -gt 0 ]; then
  fail=$((fail + 1))
  echo "  -> $missing_contracts undefined contract_id reference(s)"
fi

# ------------------------------------------------------------------
# Class 3 — doctor check IDs
# ------------------------------------------------------------------
# Set of defined check IDs in parts/doctor.md (## Check #NN ...):
defined_checks="$(grep -oE '^## Check #[0-9]+' parts/doctor.md | grep -oE '[0-9]+' | sort -un)"

missing_checks=0
seen_checks=0
# Match patterns like "Check #41", "check #18", "#39 ", "#40)" — only inside
# the prose of commands/* and parts/*. Be conservative: only flag explicit
# `Check #NN` form to avoid grabbing arbitrary numeric hashes.
while IFS= read -r ref; do
  src="${ref%%:*}"
  rest="${ref#*:}"
  ids="$(echo "$rest" | grep -oE '[Cc]heck #[0-9]+' | grep -oE '[0-9]+')"
  for n in $ids; do
    seen_checks=$((seen_checks + 1))
    if ! echo "$defined_checks" | grep -qFx "$n"; then
      echo "FAIL $src: references undefined doctor check ID: #$n"
      missing_checks=$((missing_checks + 1))
    fi
  done
done < <(grep -rnE '[Cc]heck #[0-9]+' commands/*.md parts/*.md 2>/dev/null | grep -v '^parts/doctor.md.*^## Check')
if [ $missing_checks -gt 0 ]; then
  fail=$((fail + 1))
  echo "  -> $missing_checks undefined check-ID reference(s); $seen_checks total"
fi

# ------------------------------------------------------------------
if [ $fail -eq 0 ]; then
  echo "test-cross-refs: PASS (files=$seen_paths, contracts=$(echo "$defined_contracts" | wc -l), checks=$seen_checks)"
  exit 0
fi
echo "test-cross-refs: FAIL ($fail class(es) had violations)"
exit 1
