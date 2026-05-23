#!/usr/bin/env bash
# tests/structural/test-coordinator-dispatch.sh — A1..A4: coordinator dispatch invariants
# Usage: test-coordinator-dispatch.sh [REPO_ROOT]
set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }

PASS=0; FAIL=0
pass() { echo "PASS A$1: $2"; PASS=$((PASS+1)); }
fail() { echo "FAIL A$1: $2"; FAIL=$((FAIL+1)); }

# Real dispatch block: DISPATCH-SITE: line followed by contract_id: within 2 lines.
# Excludes: preamble labels (ending -->), code-block examples, documentation references.
count_real_dispatch_sites() {
  local file="$1"
  [ -f "$file" ] || { echo 0; return; }
  awk '
    /DISPATCH-SITE:/ {
      if ($0 ~ /-->/) next  # skip preamble labels
      found_dispatch=1; look=2; next
    }
    found_dispatch && look > 0 {
      if ($0 ~ /contract_id:/) { real++; found_dispatch=0; look=0; next }
      look--
      if (look == 0) found_dispatch=0
    }
    END { print (real+0) }
  ' "$file"
}

# A1: each dispatch-phase step-c file has at least one real DISPATCH-SITE block.
# step-c-completion.md is a cleanup/retro handler and does not dispatch; excluded.
a1_fail=0
for sub in dispatch resume verification; do
  f="$REPO_ROOT/parts/step-c-$sub.md"
  if [ ! -f "$f" ]; then
    echo "  FAIL A1: parts/step-c-$sub.md missing (cannot check dispatch sites)"
    a1_fail=$((a1_fail+1))
    continue
  fi
  n=$(count_real_dispatch_sites "$f")
  if [ "$n" -eq 0 ]; then
    echo "  FAIL A1: parts/step-c-$sub.md has no real DISPATCH-SITE blocks (contract_id: absent)"
    a1_fail=$((a1_fail+1))
  fi
done
[ $a1_fail -eq 0 ] && pass 1 "DISPATCH-SITE markers: step-c-{dispatch,resume,verification}.md have dispatch blocks" \
  || fail 1 "DISPATCH-SITE markers: $a1_fail step-c dispatch-phase file(s) missing dispatch blocks"

# A2: every real DISPATCH-SITE block (next 20 lines) contains Return shape: or ≤1000
# Real blocks: not inside ``` code fences, not preamble lines (-->), not in parts/contracts/
a2_fail=0
while IFS= read -r file; do
  [ -f "$file" ] || continue
  case "$file" in *parts/contracts/*) continue ;; esac
  in_code_fence=0
  look_for_contract=0
  dispatch_line=0
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno+1))
    # track code fences (``` at start of line)
    printf '%s\n' "$line" | grep -qE '^```' && in_code_fence=$(( 1 - in_code_fence ))
    [ $in_code_fence -eq 1 ] && { look_for_contract=0; continue; }
    if printf '%s\n' "$line" | grep -qE 'DISPATCH-SITE:'; then
      printf '%s\n' "$line" | grep -q -- '-->' && continue
      dispatch_line=$lineno
      look_for_contract=2
      continue
    fi
    if [ $look_for_contract -gt 0 ]; then
      look_for_contract=$((look_for_contract-1))
      if printf '%s\n' "$line" | grep -qE 'contract_id:'; then
        block=$(sed -n "${dispatch_line},$((dispatch_line+20))p" "$file" 2>/dev/null)
        if ! printf '%s\n' "$block" | grep -qE 'Return shape:|≤1000|<= *1000'; then
          echo "  FAIL A2: $file:$dispatch_line — real DISPATCH-SITE block missing Return shape:/≤1000"
          a2_fail=$((a2_fail+1))
        fi
        look_for_contract=0
      fi
    fi
  done < "$file"
done < <(find "$REPO_ROOT/parts" "$REPO_ROOT/commands" -name "*.md" 2>/dev/null)
[ $a2_fail -eq 0 ] && pass 2 "Return-shape caps: all real DISPATCH-SITE blocks annotated" \
  || fail 2 "Return-shape caps: $a2_fail real DISPATCH-SITE block(s) missing annotation"

# A3: no step-*.md has 3+ consecutive **(Read|Bash|Glob)** lines without boundary
a3_fail=0
for f in "$REPO_ROOT"/parts/step-*.md; do
  [ -f "$f" ] || continue
  consecutive=0
  while IFS= read -r line; do
    if printf '%s\n' "$line" | grep -qE '\*\*(Read|Bash|Glob)\*\*'; then
      consecutive=$((consecutive+1))
      if [ $consecutive -ge 3 ]; then
        echo "  FAIL A3: $f — 3+ consecutive tool-ref lines without DISPATCH-SITE/coordinator/## Step boundary"
        a3_fail=$((a3_fail+1))
        consecutive=0
      fi
    elif printf '%s\n' "$line" | grep -qE 'DISPATCH-SITE:|coordinator|^## Step'; then
      consecutive=0
    else
      consecutive=0
    fi
  done < "$f"
done
[ $a3_fail -eq 0 ] && pass 3 "CC-2 inline-read guard: no 3+ consecutive tool-ref lines without boundary" \
  || fail 3 "CC-2 inline-read guard: $a3_fail violation(s)"

# A4: every real DISPATCH-SITE block (next 40 lines) contains Fallback (case-insensitive)
# Same exclusions as A2: skip code fences, parts/contracts/, preamble --> lines
a4_fail=0
while IFS= read -r file; do
  [ -f "$file" ] || continue
  case "$file" in *parts/contracts/*) continue ;; esac
  in_code_fence=0
  look_for_contract=0
  dispatch_line=0
  lineno=0
  while IFS= read -r line; do
    lineno=$((lineno+1))
    printf '%s\n' "$line" | grep -qE '^```' && in_code_fence=$(( 1 - in_code_fence ))
    [ $in_code_fence -eq 1 ] && { look_for_contract=0; continue; }
    if printf '%s\n' "$line" | grep -qE 'DISPATCH-SITE:'; then
      printf '%s\n' "$line" | grep -q -- '-->' && continue
      dispatch_line=$lineno
      look_for_contract=2
      continue
    fi
    if [ $look_for_contract -gt 0 ]; then
      look_for_contract=$((look_for_contract-1))
      if printf '%s\n' "$line" | grep -qE 'contract_id:'; then
        block=$(sed -n "${dispatch_line},$((dispatch_line+40))p" "$file" 2>/dev/null)
        if ! printf '%s\n' "$block" | grep -qiE 'fallback|partial.fail'; then
          echo "  FAIL A4: $file:$dispatch_line — real DISPATCH-SITE block (next 40 lines) missing Fallback/partial-failure doc"
          a4_fail=$((a4_fail+1))
        fi
        look_for_contract=0
      fi
    fi
  done < "$file"
done < <(find "$REPO_ROOT/parts" "$REPO_ROOT/commands" -name "*.md" 2>/dev/null)
[ $a4_fail -eq 0 ] && pass 4 "Fallback documentation: all real DISPATCH-SITE blocks contain Fallback" \
  || fail 4 "Fallback documentation: $a4_fail real DISPATCH-SITE block(s) missing Fallback"

echo ""
echo "coordinator-dispatch: $PASS passed, $FAIL failed (4/4 checks)"
[ $FAIL -eq 0 ]
