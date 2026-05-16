#!/usr/bin/env bash
# Verify the four manifest version fields and README "Current release" line
# all agree. Mirror of Doctor Check #30, run pre-commit so drift is caught
# before publish rather than after.
#
# Fields:
#   .claude-plugin/plugin.json              .version
#   .claude-plugin/marketplace.json         .version
#   .claude-plugin/marketplace.json         .plugins[0].version
#   .codex-plugin/plugin.json               .version
#   README.md                               "Current release: **vX.Y.Z**"

set -u
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

if ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: jq not available (needed for JSON version extraction)"
  exit 0
fi

v_claude_plugin="$(jq -r '.version // empty' .claude-plugin/plugin.json)"
v_market_root="$(jq -r '.version // empty' .claude-plugin/marketplace.json)"
v_market_nested="$(jq -r '.plugins[0].version // empty' .claude-plugin/marketplace.json)"
v_codex="$(jq -r '.version // empty' .codex-plugin/plugin.json)"
v_readme="$(grep -oE 'Current release:[[:space:]]*\*\*v[0-9]+\.[0-9]+\.[0-9]+\*\*' README.md \
  | head -1 \
  | sed -E 's/.*\*\*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/\1/')"

declare -A versions=(
  [".claude-plugin/plugin.json:.version"]="$v_claude_plugin"
  [".claude-plugin/marketplace.json:.version"]="$v_market_root"
  [".claude-plugin/marketplace.json:.plugins[0].version"]="$v_market_nested"
  [".codex-plugin/plugin.json:.version"]="$v_codex"
  ["README.md:Current release"]="$v_readme"
)

# Find the modal version; report any that disagree.
canonical="$v_claude_plugin"
fail=0
for field in "${!versions[@]}"; do
  v="${versions[$field]}"
  if [ -z "$v" ]; then
    echo "FAIL $field: missing/unparseable"
    fail=$((fail + 1))
  elif [ "$v" != "$canonical" ]; then
    echo "FAIL $field: $v (expected $canonical from .claude-plugin/plugin.json)"
    fail=$((fail + 1))
  fi
done

if [ $fail -eq 0 ]; then
  echo "test-manifest-drift: PASS (all 5 fields at v$canonical)"
  exit 0
fi
echo "test-manifest-drift: FAIL ($fail field(s) drifted)"
exit 1
