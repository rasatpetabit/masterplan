#!/usr/bin/env bash
# Validate YAML frontmatter in every plugin .md file that opens with `---`.
# Fails on parse errors so a stray colon or unquoted special char surfaces
# before publish.
#
# Scope: commands/*.md, parts/*.md, parts/**/*.md, skills/**/SKILL.md.
# Pass: every file's frontmatter parses as YAML, or the file has no frontmatter.

set -u
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

if ! command -v python3 >/dev/null 2>&1; then
  echo "SKIP: python3 not available (needed for YAML validation)"
  exit 0
fi

fail=0
checked=0
while IFS= read -r f; do
  [ -z "$f" ] && continue
  head -1 "$f" | grep -qE '^---\s*$' || continue
  checked=$((checked + 1))
  frontmatter="$(awk '
    NR == 1 && /^---[[:space:]]*$/ { inside=1; next }
    inside && /^---[[:space:]]*$/   { exit }
    inside                          { print }
  ' "$f")"
  if [ -z "$frontmatter" ]; then
    echo "FAIL $f: opens with --- but no closing --- found"
    fail=$((fail + 1))
    continue
  fi
  if ! err="$(printf '%s\n' "$frontmatter" | python3 -c 'import sys, yaml; yaml.safe_load(sys.stdin.read())' 2>&1)"; then
    echo "FAIL $f: YAML parse error"
    printf '%s\n' "$err" | sed 's/^/      /'
    fail=$((fail + 1))
  fi
done < <(find commands parts skills -type f \( -name '*.md' -o -name 'SKILL.md' \) 2>/dev/null)

if [ $fail -eq 0 ]; then
  echo "test-yaml-frontmatter: PASS ($checked files with frontmatter validated)"
  exit 0
fi
echo "test-yaml-frontmatter: FAIL ($fail of $checked file(s) failed)"
exit 1
