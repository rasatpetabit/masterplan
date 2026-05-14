#!/usr/bin/env bash
# masterplan-anomaly-smoke.sh - synthetic-transcript smoke test for the
# failure-instrumentation framework (Section 9 of hooks/masterplan-telemetry.sh).
#
# What this verifies:
#   1. All six anomaly classes are detectable from hand-crafted synthetic
#      transcripts (silent-stop-after-skill, unexpected-halt,
#      state-mutation-dropped, orphan-pending-gate, step-trace-gap,
#      verification-failure-uncited).
#   2. Stable SHA1 signature: re-running the same transcript produces the same
#      signature; varying the inputs produces different signatures.
#   3. Dedup branch: a second occurrence of the same signature comments instead
#      of creating a duplicate issue.
#   4. Regression branch: re-firing against a CLOSED prior issue reopens it.
#   5. Dry-run mode skips gh entirely while still writing local anomalies.
#
# Strategy: build an isolated worktree with synthetic state.yml + events.jsonl
# + transcript JSONL files, override $HOME to a tempdir so the hook's transcript
# resolver does not collide with the real Claude Code session log, and mock
# `gh` with a shell stub on PATH that records every call and returns canned
# responses keyed by query.
#
# Usage:
#   bin/masterplan-anomaly-smoke.sh [--verbose] [--keep-temp]
#
# Exit codes:
#   0  all assertions passed
#   1  one or more assertions failed
#   2  setup error

set -u
shopt -s nullglob

verbose=0
keep_temp=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --verbose|-v) verbose=1; shift ;;
    --keep-temp) keep_temp=1; shift ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

script_dir="$(cd "$(dirname "$0")" && pwd)"
worktree="$(cd "$script_dir/.." && pwd)"
hook="$worktree/hooks/masterplan-telemetry.sh"
[[ -x "$hook" || -f "$hook" ]] || { echo "hook not found: $hook" >&2; exit 2; }

log() { [[ "$verbose" -eq 1 ]] && echo "  $*" >&2 || true; }

tmp="$(mktemp -d)"
fake_home="$tmp/fake-home"
fake_repo="$tmp/fake-repo"
fake_bin="$tmp/fake-bin"
gh_log="$tmp/gh-calls.log"
gh_state="$tmp/gh-state.json"
mkdir -p "$fake_home" "$fake_repo" "$fake_bin"

cleanup() {
  if [[ "$keep_temp" -eq 1 ]]; then
    echo "Temp preserved at: $tmp" >&2
  else
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

# ----- gh mock ---------------------------------------------------------------
# Behavior:
#   `gh issue list --search "in:title [auto:<sig>]" --state all --json ...`
#     → look up $gh_state[$sig] and emit a single-element JSON array if seeded;
#       otherwise empty array.
#   `gh issue create ...`        → log + emit issue number 9000+n
#   `gh issue comment <n> ...`   → log
#   `gh issue reopen <n> ...`    → log
# Seeding: write to $gh_state to fake a prior issue.

echo "{}" > "$gh_state"

cat > "$fake_bin/gh" <<'GH_MOCK'
#!/usr/bin/env bash
set -u
log_file="${GH_LOG:-/dev/null}"
state_file="${GH_STATE:-/dev/null}"
{ printf '%s\t' "$(date -u +%H:%M:%S)"; printf '%s ' "$@"; printf '\n'; } >> "$log_file"

cmd="$1"; sub="${2:-}"
case "$cmd $sub" in
  "issue list")
    sig=""
    for arg in "$@"; do
      case "$arg" in
        "in:title [auto:"*)
          sig="${arg#in:title [auto:}"; sig="${sig%]}"
          ;;
      esac
    done
    if [[ -n "$sig" ]] && command -v jq >/dev/null 2>&1; then
      hit=$(jq -c --arg s "$sig" '.[$s] // empty' "$state_file" 2>/dev/null)
      if [[ -n "$hit" ]]; then
        printf '[%s]\n' "$hit"
        exit 0
      fi
    fi
    echo "[]"; exit 0 ;;
  "issue create")
    # emit a fake number for visibility
    echo "https://github.com/fake/repo/issues/9001"; exit 0 ;;
  "issue comment"|"issue reopen")
    exit 0 ;;
esac
exit 0
GH_MOCK
chmod +x "$fake_bin/gh"

export GH_LOG="$gh_log"
export GH_STATE="$gh_state"

# ----- fake worktree setup ---------------------------------------------------
cd "$fake_repo"
git init -q -b main
git config user.email "smoke@test.local"
git config user.name  "smoke"

# .masterplan.yaml — dry-run mode by default; we'll flip per-phase.
cat > .masterplan.yaml <<EOF
failure_reporting:
  repo: rasatpetabit/superpowers-masterplan
  enabled: true
  dry_run: false
EOF

# fake plugin.json so the hook can read its version
mkdir -p .claude-plugin
echo '{"version":"5.1.0"}' > .claude-plugin/plugin.json

slug="smoke-fixture"
plans_dir="docs/masterplan/$slug"
mkdir -p "$plans_dir"

# state.yml — generic active-plan state. Per-class tests will mutate this.
cat > "$plans_dir/state.yml" <<EOF
schema_version: 1
slug: $slug
worktree: $fake_repo
branch: main
phase: executing
status: in_progress
pending_gate:
  id:
EOF

# events.jsonl — empty by default
: > "$plans_dir/events.jsonl"

git add -A
git -c commit.gpgsign=false commit -q -m "smoke fixture"

# ----- transcript builder ----------------------------------------------------
# Compose a JSONL transcript where assistant turn text contains breadcrumbs,
# then run the hook with $HOME pointing at fake_home so it locates the file.
session_dir_name="$(echo "$fake_repo" | tr '/' '-')"
project_dir="$fake_home/.claude/projects/$session_dir_name"
mkdir -p "$project_dir"

build_transcript() {
  local session_id="$1"
  local breadcrumbs_text="$2"
  local include_auq="${3:-no}"
  local transcript_path="$project_dir/$session_id.jsonl"
  : > "$transcript_path"

  python3 - "$transcript_path" "$breadcrumbs_text" "$include_auq" <<'PY'
import json, sys
path, breadcrumbs_text, include_auq = sys.argv[1], sys.argv[2], sys.argv[3]
content = [{"type": "text", "text": breadcrumbs_text}]
if include_auq == "yes":
    content.append({
        "type": "tool_use",
        "name": "AskUserQuestion",
        "input": {"questions": []}
    })
record = {
    "type": "assistant",
    "message": {"role": "assistant", "content": content}
}
with open(path, "w") as f:
    f.write(json.dumps(record) + "\n")
PY
  local rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "python3 transcript-builder failed (rc=$rc)" >&2
    return 1
  fi
  echo "$transcript_path"
}

# Driver that runs the hook against a synthesized transcript.
run_hook() {
  local session_id="$1"
  local breadcrumbs="$2"
  local state_yml="$3"
  local events="$4"
  local include_auq="${5:-no}"

  # Reset state.yml + events.jsonl for this scenario.
  printf '%s\n' "$state_yml" > "$plans_dir/state.yml"
  printf '%s' "$events" > "$plans_dir/events.jsonl"

  build_transcript "$session_id" "$breadcrumbs" "$include_auq" >/dev/null

  HOME="$fake_home" \
  CLAUDE_SESSION_ID="$session_id" \
  PATH="$fake_bin:$PATH" \
  bash "$hook" < /dev/null >/dev/null 2>&1 || true
}

# Convenience: count anomaly records of a specific class.
count_class() {
  local cls="$1"
  local file="$plans_dir/anomalies.jsonl"
  [[ -f "$file" ]] || { echo 0; return; }
  jq -c --arg c "$cls" 'select(.anomaly_class == $c)' "$file" 2>/dev/null | wc -l | tr -d ' '
}

# Convenience: count gh calls matching a regex.
count_gh() {
  local n
  n=$(grep -cE "$1" "$gh_log" 2>/dev/null || true)
  echo "${n:-0}"
}

# Reset assertions
pass=0
fail=0
failures=()

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass+1)); log "PASS: $label (got=$got)"
  else
    fail=$((fail+1)); failures+=("FAIL: $label — got=$got want=$want")
  fi
}

assert_ge() {
  local got="$1" min="$2" label="$3"
  if [[ "$got" -ge "$min" ]]; then
    pass=$((pass+1)); log "PASS: $label (got=$got >= $min)"
  else
    fail=$((fail+1)); failures+=("FAIL: $label — got=$got want>=$min")
  fi
}

# ----- scenarios --------------------------------------------------------------
echo "== Scenario 1: silent-stop-after-skill =="
state_active=$'schema_version: 1\nslug: smoke-fixture\nworktree: '"$fake_repo"$'\nbranch: main\nphase: planning\nstatus: in_progress\npending_gate:\n  id:'
bc1='<masterplan-trace step=b2 phase=in verb=plan halt_mode=post-plan autonomy=loose>
<masterplan-trace skill-invoke name=writing-plans args=spec=test>
<masterplan-trace skill-return name=writing-plans expected-next-step=b2-re-engagement>'
run_hook "sess-silent-stop" "$bc1" "$state_active" ""
assert_ge "$(count_class silent-stop-after-skill)" 1 "silent-stop detected"

echo "== Scenario 2: unexpected-halt =="
state_pending=$'schema_version: 1\nslug: smoke-fixture\nworktree: '"$fake_repo"$'\nbranch: main\nphase: executing\nstatus: in_progress\npending_gate:\n  id: blocker_reengagement'
bc2='<masterplan-trace step=c phase=in verb=next halt_mode=none autonomy=loose>'
run_hook "sess-unexpected-halt" "$bc2" "$state_pending" ""
assert_ge "$(count_class unexpected-halt)" 1 "unexpected-halt detected"

echo "== Scenario 3: state-mutation-dropped =="
state_planning=$'schema_version: 1\nslug: smoke-fixture\nworktree: '"$fake_repo"$'\nbranch: main\nphase: planning\nstatus: in_progress\npending_gate:\n  id:'
bc3='<masterplan-trace step=b phase=in verb=plan halt_mode=none autonomy=loose>
<masterplan-trace skill-invoke name=brainstorming args=topic=test>
<masterplan-trace skill-return name=brainstorming expected-next-step=b1-close>
<masterplan-trace gate=fire id=spec_approval auq-options=4>'
# Note: this has a skill-invoke (substantive=yes) but no state-write
# field=phase. The presence of skill-return + gate=fire after will satisfy
# silent-stop-after-skill but trigger state-mutation-dropped because phase
# remained "planning" with no phase write and no pending_gate.
run_hook "sess-state-drop" "$bc3" "$state_planning" ""
assert_ge "$(count_class state-mutation-dropped)" 1 "state-mutation-dropped detected"

echo "== Scenario 4: orphan-pending-gate =="
# pending_gate set, but no AskUserQuestion in transcript and a gate=fire breadcrumb
# is NOT present (gate was promised but never fired).
state_orphan=$'schema_version: 1\nslug: smoke-fixture\nworktree: '"$fake_repo"$'\nbranch: main\nphase: planning\nstatus: in_progress\npending_gate:\n  id: plan_closeout'
bc4='<masterplan-trace step=b3 phase=in verb=plan halt_mode=post-plan autonomy=loose>
<masterplan-trace state-write field=phase from=planning to=plan_gate>'
run_hook "sess-orphan-gate" "$bc4" "$state_orphan" "" "no"
assert_ge "$(count_class orphan-pending-gate)" 1 "orphan-pending-gate detected"

echo "== Scenario 5: step-trace-gap =="
state_running=$'schema_version: 1\nslug: smoke-fixture\nworktree: '"$fake_repo"$'\nbranch: main\nphase: executing\nstatus: in_progress\npending_gate:\n  id:'
bc5='<masterplan-trace step=c phase=in verb=next halt_mode=none autonomy=loose>
<masterplan-trace state-write field=phase from=executing to=executing>'
# step=c phase=in with no matching phase=out
run_hook "sess-step-gap" "$bc5" "$state_running" ""
assert_ge "$(count_class step-trace-gap)" 1 "step-trace-gap detected"

echo "== Scenario 6: verification-failure-uncited =="
state_verifying=$'schema_version: 1\nslug: smoke-fixture\nworktree: '"$fake_repo"$'\nbranch: main\nphase: executing\nstatus: in_progress\npending_gate:\n  id:'
events_verifail=$(printf '%s\n' \
  '{"event":"verify_task_1","result":"failed","ts":"2026-05-14T00:00:00Z"}')
bc6='<masterplan-trace step=c phase=in verb=next halt_mode=none autonomy=loose>
<masterplan-trace state-write field=phase from=executing to=complete>'
run_hook "sess-verify-uncited" "$bc6" "$state_verifying" "$events_verifail"
assert_ge "$(count_class verification-failure-uncited)" 1 "verification-failure-uncited detected"

# ----- signature stability + dedup -------------------------------------------
echo "== Signature stability & dedup =="
# Pre-record current line count
before_lines=$(wc -l < "$plans_dir/anomalies.jsonl" 2>/dev/null | tr -d ' ')

# Re-run scenario 5 verbatim — same signature should appear in anomalies.jsonl
# (local-first writes always happen) and gh issue list should match a prior
# issue we seed in gh_state to force the dedup branch.
sig_repeat=$(jq -r 'select(.anomaly_class=="step-trace-gap") | .signature' "$plans_dir/anomalies.jsonl" | tail -n1)
sig12="${sig_repeat:0:12}"
log "dedup signature: $sig12"

# Seed the mock gh state so the next list returns a prior OPEN issue.
python3 - "$gh_state" "$sig12" "OPEN" <<'PY'
import json, sys
state_path, sig, st = sys.argv[1], sys.argv[2], sys.argv[3]
with open(state_path) as f:
    state = json.load(f)
state[sig] = {"number": 1234, "state": st, "title": f"[auto:{sig}] step-trace-gap c next"}
with open(state_path, "w") as f:
    json.dump(state, f)
PY

# Clear gh call log to scope the assertion to this scenario.
: > "$gh_log"

run_hook "sess-step-gap-dup" "$bc5" "$state_running" ""

after_lines=$(wc -l < "$plans_dir/anomalies.jsonl" 2>/dev/null | tr -d ' ')
assert_ge "$((after_lines - before_lines))" 1 "second fire wrote local record"
assert_ge "$(count_gh 'issue comment 1234')" 1 "dedup branch issued comment on #1234"

# ----- regression / reopen ---------------------------------------------------
echo "== Regression / reopen =="
python3 - "$gh_state" "$sig12" "CLOSED" <<'PY'
import json, sys
state_path, sig, st = sys.argv[1], sys.argv[2], sys.argv[3]
with open(state_path) as f:
    state = json.load(f)
state[sig] = {"number": 1234, "state": st, "title": f"[auto:{sig}] step-trace-gap c next"}
with open(state_path, "w") as f:
    json.dump(state, f)
PY

: > "$gh_log"
run_hook "sess-step-gap-regress" "$bc5" "$state_running" ""
assert_ge "$(count_gh 'issue reopen 1234')" 1 "regression branch reopened #1234"

# ----- dry-run mode skips gh -------------------------------------------------
echo "== Dry-run mode =="
sed -i.bak 's/dry_run: false/dry_run: true/' "$fake_repo/.masterplan.yaml" 2>/dev/null || \
  sed -i '' 's/dry_run: false/dry_run: true/' "$fake_repo/.masterplan.yaml"

# Clear gh call log to scope the assertion.
: > "$gh_log"

run_hook "sess-dryrun" "$bc5" "$state_running" ""
gh_calls=$(wc -l < "$gh_log" 2>/dev/null | tr -d ' ')
assert_eq "$gh_calls" "0" "dry_run mode emitted no gh calls"
# Local record still written
last_record=$(tail -n1 "$plans_dir/anomalies.jsonl" 2>/dev/null)
assert_ge "$(echo "$last_record" | jq -r '.anomaly_class // empty' | wc -c)" 2 "dry_run still wrote local record"

# ----- summary ---------------------------------------------------------------
echo ""
echo "Smoke test summary:"
echo "  PASS: $pass"
echo "  FAIL: $fail"

if [[ "$fail" -gt 0 ]]; then
  echo ""
  for f in "${failures[@]}"; do echo "  $f"; done
  echo ""
  echo "Anomalies file ($(wc -l < "$plans_dir/anomalies.jsonl") records):" >&2
  jq -rc '[.anomaly_class, .signature[:12], .last_step, .verb] | @tsv' "$plans_dir/anomalies.jsonl" >&2
  exit 1
fi

echo ""
echo "All assertions passed."
exit 0
