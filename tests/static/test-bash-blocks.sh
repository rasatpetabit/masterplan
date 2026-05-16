#!/usr/bin/env bash
# Run `bash -n` on every fenced bash block in plugin .md files.
#
# This catches the v5.3.1-class regression where a `|| echo 0` inside a doctor
# check produced "0\n0" output that silently failed integer comparisons. A pure
# syntax check would not have caught that specific bug (it was semantic), but
# it does catch unbalanced quotes, missing `fi`/`done`, and similar typo-class
# breakage that prompt-edits are prone to.
#
# Scope: every ```bash ... ``` block in parts/*.md and commands/*.md.

set -u
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail=0
checked=0
for src in parts/*.md commands/*.md; do
  [ -f "$src" ] || continue
  # awk extracts the Nth fenced bash block; we iterate until awk produces empty.
  n=0
  while :; do
    n=$((n + 1))
    block="$(awk -v want="$n" '
      /^```bash[[:space:]]*$/    { inside=1; count++; next }
      /^```[[:space:]]*$/ && inside { inside=0; next }
      inside && count == want   { print }
    ' "$src")"
    [ -z "$block" ] && break
    checked=$((checked + 1))
    blockfile="$tmp/$(basename "$src" .md)-block-$n.sh"
    printf '%s\n' "$block" > "$blockfile"
    if ! err="$(bash -n "$blockfile" 2>&1)"; then
      echo "FAIL $src block #$n: bash syntax error"
      printf '%s\n' "$err" | sed "s|${tmp}/||g" | sed 's/^/  /'
      fail=$((fail + 1))
    fi
  done
done

if [ $fail -eq 0 ]; then
  echo "test-bash-blocks: PASS ($checked bash block(s) syntax-clean)"
  exit 0
fi
echo "test-bash-blocks: FAIL ($fail of $checked block(s) failed)"
exit 1
