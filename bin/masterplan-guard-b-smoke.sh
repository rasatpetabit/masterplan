#!/usr/bin/env bash
# Guard B smoke test — verifies cross-worktree slug collision detection.
# Creates a synthetic two-worktree git fixture in $TMPDIR, drives
# bin/masterplan-state.sh check-slug-collision, asserts correct detection,
# then appends a guard_b_smoke_pass event to the run bundle's events.jsonl.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_SH="${REPO_ROOT}/bin/masterplan-state.sh"
FAIL=0

fail() { echo "FAIL: $*" >&2; FAIL=1; }

tmp="$(mktemp -d -t guard-b-smoke-XXXXXX)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

# ── fixture setup ──────────────────────────────────────────────────────────
git init -q "$tmp/wt-primary"
git -C "$tmp/wt-primary" commit --allow-empty -q -m init
git -C "$tmp/wt-primary" worktree add -q "$tmp/wt-secondary" -b secondary-test

# In wt-primary: create an in-progress bundle for slug "deploy-x"
mkdir -p "$tmp/wt-primary/docs/masterplan/deploy-x"
printf 'status: in-progress\nslug: deploy-x\nbranch: main\nlast_activity: 2026-05-16T08:00:00Z\n' \
  > "$tmp/wt-primary/docs/masterplan/deploy-x/state.yml"

# ── test pass 1: collision from wt-secondary ──────────────────────────────
echo "==> Pass 1: collision detection"
result="$(cd "$tmp/wt-secondary" && bash "$STATE_SH" check-slug-collision deploy-x)"
echo "    result: $result"

collision_count="$(printf '%s' "$result" | jq '.collisions | length')"
if [ "$collision_count" -lt 1 ]; then
  fail "expected >=1 collision, got $collision_count"
else
  echo "    OK: detected $collision_count collision(s)"
fi

wt_field="$(printf '%s' "$result" | jq -r '.collisions[0].worktree')"
if [[ "$wt_field" != *"wt-primary"* ]]; then
  fail "collision worktree should contain 'wt-primary', got: $wt_field"
else
  echo "    OK: collision points to wt-primary"
fi

suggested="$(printf '%s' "$result" | jq -r '.suggested_suffix')"
if [ "$suggested" != "deploy-x-2" ]; then
  fail "suggested_suffix should be 'deploy-x-2', got: $suggested"
else
  echo "    OK: suggested_suffix = $suggested"
fi

stale_val="$(printf '%s' "$result" | jq -r '.collisions[0].stale')"
if [ "$stale_val" != "false" ]; then
  fail "collision[0].stale should be false (wt-primary exists), got: $stale_val"
else
  echo "    OK: stale=false (worktree exists)"
fi

# Confirm wt-secondary does NOT silently have a deploy-x bundle
if [ -d "$tmp/wt-secondary/docs/masterplan/deploy-x" ]; then
  fail "wt-secondary should NOT have docs/masterplan/deploy-x — Guard B should have caught this"
else
  echo "    OK: no silent shared bundle in wt-secondary"
fi

# ── test pass 2: stale peer (D2) ──────────────────────────────────────────
echo "==> Pass 2: stale-peer detection"
git -C "$tmp/wt-primary" worktree remove --force "$tmp/wt-secondary"
rm -rf "$tmp/wt-secondary"

result2="$(cd "$tmp/wt-primary" && bash "$STATE_SH" check-slug-collision deploy-x)"
echo "    result: $result2"

# When called from wt-primary itself, the bundle is in the CURRENT worktree
# (check-slug-collision skips the current worktree). So collisions should be 0
# UNLESS the secondary is still registered (which it is — worktree remove
# deregisters it, but the fixture's secondary was on a temp path).
# Let's also add a dangling worktree reference manually to test stale detection.
# Re-add a worktree to a nonexistent path in git's config:
git -C "$tmp/wt-primary" worktree add -q "$tmp/wt-ghost" -b ghost-test 2>/dev/null || true
mkdir -p "$tmp/wt-ghost/docs/masterplan/deploy-x"
printf 'status: in-progress\nslug: deploy-x\nbranch: ghost-test\nlast_activity: 2026-05-01T00:00:00Z\n' \
  > "$tmp/wt-ghost/docs/masterplan/deploy-x/state.yml"
# Now delete the ghost worktree dir to make it stale
rm -rf "$tmp/wt-ghost"

result3="$(cd "$tmp/wt-primary" && bash "$STATE_SH" check-slug-collision deploy-x)"
echo "    result (with ghost): $result3"

stale_count="$(printf '%s' "$result3" | jq '[.collisions[] | select(.stale == true)] | length')"
if [ "$stale_count" -lt 1 ]; then
  fail "expected at least 1 stale collision for deleted ghost worktree, got $stale_count"
else
  echo "    OK: stale collision detected (count=$stale_count)"
fi

# ── summary ───────────────────────────────────────────────────────────────
if [ "$FAIL" -eq 0 ]; then
  echo "==> guard-b-smoke: PASS"
  # Emit structured output for the orchestrator to append to events.jsonl (CD-7)
  printf 'SMOKE_RESULT detected_collisions=%s suggested_suffix=%s stale_detected=%s\n' \
    "$collision_count" "$suggested" "$stale_count"
else
  echo "==> guard-b-smoke: FAIL (see errors above)" >&2
  exit 1
fi
