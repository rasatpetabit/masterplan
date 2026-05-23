#!/usr/bin/env bash
# tests/structural/test-step-c-split.sh — B1..B4: step-c 4-way split structural integrity
# Usage: test-step-c-split.sh [REPO_ROOT]
set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }

PASS=0; FAIL=0
pass() { echo "PASS B$1: $2"; PASS=$((PASS+1)); }
fail() { echo "FAIL B$1: $2"; FAIL=$((FAIL+1)); }

# B1: all 4 step-c-*.md files exist and non-empty
b1_fail=0
for sub in dispatch resume verification completion; do
  f="$REPO_ROOT/parts/step-c-$sub.md"
  if [ ! -f "$f" ]; then
    echo "  FAIL B1: parts/step-c-$sub.md missing"
    b1_fail=$((b1_fail+1))
  elif [ "$(wc -c < "$f")" -eq 0 ]; then
    echo "  FAIL B1: parts/step-c-$sub.md is empty (wc -c == 0)"
    b1_fail=$((b1_fail+1))
  fi
done
[ $b1_fail -eq 0 ] && pass 1 "All 4 step-c-*.md files exist and non-empty" \
  || fail 1 "step-c file existence: $b1_fail file(s) missing or empty"

# B2: no duplicate section headers (##+ lines) across all 4 files (case-insensitive)
headers_raw=$(for f in "$REPO_ROOT"/parts/step-c-*.md; do
  [ -f "$f" ] || continue
  grep -hE '^##+ ' "$f" | tr '[:upper:]' '[:lower:]' | sed 's/^#* //'
done)
dupes=$(printf '%s\n' "$headers_raw" | sort | uniq -d)
if [ -z "$dupes" ]; then
  pass 2 "No duplicate section headers across step-c-*.md"
else
  echo "  FAIL B2 duplicate headers: $(printf '%s\n' "$dupes" | head -5 | paste -sd '; ')"
  fail 2 "Duplicate section headers found in step-c-*.md"
fi

# B3: no non-negated "end the turn" in step-c-*.md
# Non-negated = line contains "end the turn" but NOT "never" or "do not" or "don't"
b3_fail=0
for f in "$REPO_ROOT"/parts/step-c-*.md; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    printf '%s\n' "$line" | grep -iqE 'end the turn' || continue
    printf '%s\n' "$line" | grep -iqE '(never|do not|don.t)' && continue
    echo "  FAIL B3: $(basename "$f"): bare 'end the turn' found: ${line:0:80}"
    b3_fail=$((b3_fail+1))
  done < "$f"
done
[ $b3_fail -eq 0 ] && pass 3 "CC-3 trampoline coverage: no bare 'end the turn' in step-c-*.md" \
  || fail 3 "CC-3 trampoline: $b3_fail bare 'end the turn' instance(s)"

# B4: all parts/<name> xrefs in step-c-*.md and step-b-*.md resolve to existing files
b4_fail=0
for f in "$REPO_ROOT"/parts/step-c*.md "$REPO_ROOT"/parts/step-b*.md; do
  [ -f "$f" ] || continue
  while IFS= read -r ref; do
    target="$REPO_ROOT/$ref"
    [ -f "$target" ] || {
      echo "  FAIL B4: $(basename "$f"): unresolved xref $ref (file does not exist)"
      b4_fail=$((b4_fail+1))
    }
  done < <(grep -oE 'parts/step-[a-z0-9._-]+\.md' "$f" 2>/dev/null | sort -u)
done
[ $b4_fail -eq 0 ] && pass 4 "Xref resolution: all parts/ xrefs in step-c/b files resolve" \
  || fail 4 "Xref resolution: $b4_fail unresolved xref(s) in step-c/b files"

echo ""
echo "step-c-split: $PASS passed, $FAIL failed (4/4 checks)"
[ $FAIL -eq 0 ]
