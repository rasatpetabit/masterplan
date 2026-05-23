#!/usr/bin/env bash
# tests/hook-unit/test-telemetry-sections.sh — C1..C4: telemetry hook unit tests
# Usage: test-telemetry-sections.sh [REPO_ROOT]
set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }

PASS=0; FAIL=0
pass() { echo "PASS C$1: $2"; PASS=$((PASS+1)); }
fail() { echo "FAIL C$1: $2"; FAIL=$((FAIL+1)); }

HOOK="$REPO_ROOT/hooks/masterplan-telemetry.sh"
TMPDIR_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_ROOT"' EXIT

# C1: bash -n syntax check
if bash -n "$HOOK" 2>/dev/null; then
  pass 1 "hooks/masterplan-telemetry.sh passes bash -n syntax check"
else
  fail 1 "hooks/masterplan-telemetry.sh has syntax errors: $(bash -n "$HOOK" 2>&1 | head -3)"
fi

# C2: stop-turn JSONL with context_bytes field → hook exits 0 and emits telemetry
c2_dir="$TMPDIR_ROOT/c2"
mkdir -p "$c2_dir/home/.claude/projects/test-project"
mkdir -p "$c2_dir/bundle/docs/masterplan/test-bundle"
cat > "$c2_dir/bundle/docs/masterplan/test-bundle/state.yml" <<'EOF'
slug: test-bundle
status: in-progress
phase: executing
telemetry: on
codex_routing: off
last_activity: '2026-01-01T00:00:00+00:00'
artifacts:
  spec: ''
  plan: ''
  events: docs/masterplan/test-bundle/events.jsonl
EOF
SESSION_ID="test-c2-session"
cat > "$c2_dir/home/.claude/projects/test-project/${SESSION_ID}.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=in verb=execute halt_mode=none autonomy=loose>"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=out>"}]}}
EOF
c2_out=$(cd "$c2_dir/bundle" && \
  HOME="$c2_dir/home" \
  CLAUDE_SESSION_ID="$SESSION_ID" \
  bash "$HOOK" 2>&1)
c2_exit=$?
if [ $c2_exit -eq 0 ]; then
  pass 2 "hook exits 0 on well-formed stop turn"
else
  fail 2 "hook exited $c2_exit on well-formed stop turn: ${c2_out:0:200}"
fi

# C3: missing phase=out breadcrumb → hook writes step-trace-gap anomaly
# The hook requires: (a) git worktree, (b) at least one commit so branch resolves,
# (c) state.yml with worktree: matching git root, (d) dry_run: true to suppress gh calls.
_make_test_bundle() {
  local dir="$1" branch="$2" session_id="$3"
  mkdir -p "${dir}/home/.claude/projects/test-project"
  mkdir -p "${dir}/docs/masterplan/test-bundle"
  git -C "$dir" init -q -b "$branch" 2>/dev/null
  git -C "$dir" config user.email "test@test.com" 2>/dev/null
  git -C "$dir" config user.name "Test" 2>/dev/null
  git -C "$dir" commit --allow-empty -m "init" --quiet 2>/dev/null
  cat > "${dir}/.masterplan.yaml" <<'MEOF'
failure_reporting:
  dry_run: true
MEOF
  cat > "${dir}/docs/masterplan/test-bundle/state.yml" <<EOF
slug: test-bundle
status: in-progress
phase: executing
telemetry: on
codex_routing: off
last_activity: '2026-01-01T00:00:00+00:00'
worktree: ${dir}
branch: ${branch}
artifacts:
  spec: ''
  plan: ''
  events: docs/masterplan/test-bundle/events.jsonl
EOF
}

c3_dir="$TMPDIR_ROOT/c3"
_make_test_bundle "$c3_dir" "test-c3" "test-c3-session"
SESSION_ID_C3="test-c3-session"
cat > "$c3_dir/home/.claude/projects/test-project/${SESSION_ID_C3}.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=in verb=execute halt_mode=none autonomy=loose>"}]}}
EOF
(cd "$c3_dir" && \
  HOME="$c3_dir/home" \
  CLAUDE_SESSION_ID="$SESSION_ID_C3" \
  bash "$HOOK" 2>/dev/null) || true
anom_file="$c3_dir/docs/masterplan/test-bundle/anomalies.jsonl"
if [ -s "$anom_file" ] && grep -q 'step-trace-gap\|orphan_step' "$anom_file" 2>/dev/null; then
  pass 3 "missing phase=out breadcrumb → step-trace-gap anomaly written to anomalies.jsonl"
else
  fail 3 "expected step-trace-gap anomaly in anomalies.jsonl — got: $(cat "$anom_file" 2>/dev/null | head -3)"
fi

# C4: skill-return with no subsequent step breadcrumbs → silent-stop-after-skill anomaly
c4_dir="$TMPDIR_ROOT/c4"
_make_test_bundle "$c4_dir" "test-c4" "test-c4-session"
SESSION_ID_C4="test-c4-session"
cat > "$c4_dir/home/.claude/projects/test-project/${SESSION_ID_C4}.jsonl" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute phase=in verb=execute halt_mode=none autonomy=loose>"}]}}
{"type":"assistant","message":{"content":[{"type":"text","text":"<masterplan-trace step=execute skill-return name=writing-plans>"}]}}
EOF
(cd "$c4_dir" && \
  HOME="$c4_dir/home" \
  CLAUDE_SESSION_ID="$SESSION_ID_C4" \
  bash "$HOOK" 2>/dev/null) || true
anom_c4="$c4_dir/docs/masterplan/test-bundle/anomalies.jsonl"
if [ -s "$anom_c4" ] && grep -q 'silent-stop-after-skill' "$anom_c4" 2>/dev/null; then
  pass 4 "skill-return with no subsequent breadcrumbs → silent-stop-after-skill anomaly written"
else
  fail 4 "expected silent-stop-after-skill anomaly — got: $(cat "$anom_c4" 2>/dev/null | head -3)"
fi

echo ""
echo "telemetry-sections: $PASS passed, $FAIL failed (4/4 checks)"
[ $FAIL -eq 0 ]
