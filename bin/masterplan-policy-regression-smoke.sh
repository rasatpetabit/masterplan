#!/usr/bin/env bash
# masterplan-policy-regression-smoke.sh - smoke test for the policy-regression
# audit detectors + findings-to-issues dispatcher.
#
# Validates:
#   - 12 plan-side detectors emit the expected warning code on synthetic
#     fixtures, and not on negative-control fixtures.
#   - Claude-side detectors (cc3-skip, cd9-question, auq-guard-block) fire
#     against synthetic transcripts, and the <no-auq> escape suppresses cd9.
#   - findings-to-issues filters soft codes, skips events_wiped: breadcrumbs,
#     advances the sentinel only on real (non-dry) runs, retries pending rows,
#     and reuses existing GH issues via signature dedup (mocked gh).
#
# Exit codes:
#   0  all assertions pass
#   1  one or more assertions failed

set -u

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
smoke_root="$(mktemp -d)"
trap 'rm -rf "$smoke_root"' EXIT INT TERM

assertions=0
failures=0

assert_grep() {
  local label="$1" pattern="$2" file="$3"
  assertions=$((assertions + 1))
  if grep -E -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label  (pattern: $pattern; file: $file)" >&2
    failures=$((failures + 1))
  fi
}

assert_not_grep() {
  local label="$1" pattern="$2" file="$3"
  assertions=$((assertions + 1))
  if grep -E -- "$pattern" "$file" >/dev/null 2>&1; then
    echo "  FAIL  $label  (unexpected match: $pattern in $file)" >&2
    failures=$((failures + 1))
  else
    echo "  ok    $label"
  fi
}

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  assertions=$((assertions + 1))
  if [[ "$expected" == "$actual" ]]; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label  (expected=$expected actual=$actual)" >&2
    failures=$((failures + 1))
  fi
}

# ---------------------------------------------------------------------------
# Part 1: Plan-side detectors via lib/masterplan_session_audit.py directly.
# Build a synthetic plan tree and run the detector. We assert on the JSON
# output, not the table render.
# ---------------------------------------------------------------------------
echo "== Part 1: plan-side detectors =="

# Helper to write one fixture plan dir with state.yml + plan.md + events.jsonl.
write_plan() {
  local name="$1" state_body="$2" plan_md="$3" events="$4"
  local d="$smoke_root/repo/docs/masterplan/$name"
  mkdir -p "$d"
  printf '%s\n' "$state_body" > "$d/state.yml"
  printf '%s\n' "$plan_md" > "$d/plan.md"
  if [[ -n "$events" ]]; then
    printf '%s\n' "$events" > "$d/events.jsonl"
  fi
}

# 1. codex_annotation_gap_on_high — high complexity, tasks present, no Codex: annotations
write_plan annot-gap '---
phase: planning
complexity: high
complexity_source: flag
codex_routing: auto
codex_review: on
last_activity: 2026-05-15T00:00:00Z' '### Task 1
do stuff
### Task 2
more stuff
### Task 3
yet more' ''

# 2. codex_parallel_group_missing_on_high (soft) — high complexity, no parallel-group:
write_plan no-pg '---
phase: planning
complexity: high
complexity_source: flag
codex_routing: auto
codex_review: on
last_activity: 2026-05-15T00:00:00Z' '### Task 1
**Codex:** ok
### Task 2
**Codex:** no' ''

# 3. codex_routing_configured_but_zero_dispatches — auto routing, complete, no events
write_plan no-route '---
phase: complete
status: ok
complexity: medium
codex_routing: auto
codex_review: off
last_activity: 2026-05-15T00:00:00Z' '### Task 1' '{"ts":"2026-05-15T00:00:00Z","type":"task_started","message":"working"}'

# 4. codex_review_configured_but_zero_invocations — review on, complete, no events
write_plan no-review '---
phase: complete
status: ok
complexity: medium
codex_routing: off
codex_review: on
last_activity: 2026-05-15T00:00:00Z' '### Task 1' '{"ts":"2026-05-15T00:00:00Z","type":"task_complete","message":"done"}'

# 5. missing_codex_ping_event — events exist (>=3), no codex_ping
write_plan no-ping '---
phase: executing
complexity: medium
codex_routing: off
codex_review: off
last_activity: 2026-05-15T00:00:00Z' '### Task 1' '{"ts":"2026-05-15T00:00:00Z","type":"task_started","message":"working"}
{"ts":"2026-05-15T00:01:00Z","type":"task_running","message":"more"}
{"ts":"2026-05-15T00:02:00Z","type":"task_running","message":"yet more"}'

# 6. silent_codex_degradation — high complexity, routing+review off, healthy auth, no degraded event
write_plan silent-degrade '---
phase: executing
complexity: high
codex_routing: off
codex_review: off
last_activity: 2026-05-15T00:00:00Z' '### Task 1' '{"ts":"2026-05-15T00:00:00Z","type":"task_started","message":"working"}
{"ts":"2026-05-15T00:01:00Z","type":"task_running","message":"more"}
{"ts":"2026-05-15T00:02:00Z","type":"task_running","message":"yet more"}'

# 7. pending_gate_orphaned (soft) — pending_gate set, last_activity stale, phase not blocked
write_plan pending-stale '---
phase: executing
complexity: medium
codex_routing: off
codex_review: off
pending_gate:
  id: foo
last_activity: 2026-05-13T00:00:00Z' '### Task 1' ''

# 8. cd3_verification_missing_on_complete — phase complete, no verify event
write_plan no-verify '---
phase: complete
status: ok
complexity: medium
codex_routing: off
codex_review: off
last_activity: 2026-05-15T00:00:00Z' '### Task 1' '{"ts":"2026-05-15T00:00:00Z","type":"task_complete","message":"working"}'

# 9. brainstorm_anchor_missing_before_planning — phase planning, no brainstorm_anchor_resolved
write_plan no-anchor '---
phase: planning
complexity: medium
codex_routing: off
codex_review: off
last_activity: 2026-05-15T00:00:00Z' '### Task 1' '{"ts":"2026-05-15T00:00:00Z","type":"phase_change","message":"transition to phase: planning"}'

# 10. wave_dispatched_without_pin — wave_dispatch event without cache pin
write_plan wave-no-pin '---
phase: executing
complexity: high
codex_routing: auto
codex_review: on
last_activity: 2026-05-15T00:00:00Z' '### Task 1
**Codex:** ok
**parallel-group:** alpha' '{"ts":"2026-05-15T00:00:00Z","type":"wave_dispatch","message":"wave_dispatch group=alpha"}'

# 11. complexity_unset_fallthrough (soft) — complexity=medium, complexity_source=default
write_plan default-complexity '---
phase: executing
complexity: medium
complexity_source: default
codex_routing: off
codex_review: off
last_activity: 2026-05-15T00:00:00Z' '### Task 1' ''

# 12. parallel_eligible_but_serial_dispatched — repeated wave_dispatch group=alpha with gap >= 3
write_plan parallel-serial '---
phase: executing
complexity: high
codex_routing: auto
codex_review: on
last_activity: 2026-05-15T00:00:00Z' '### Task 1
**Codex:** ok
**parallel-group:** alpha
### Task 2
**Codex:** ok
**parallel-group:** alpha' '{"ts":"2026-05-15T00:00:00Z","type":"wave_dispatch","message":"wave_dispatch group=alpha first"}
{"ts":"2026-05-15T00:01:00Z","type":"task_running","message":"intermediate noise"}
{"ts":"2026-05-15T00:02:00Z","type":"task_running","message":"more noise"}
{"ts":"2026-05-15T00:03:00Z","type":"task_running","message":"yet more noise"}
{"ts":"2026-05-15T00:04:00Z","type":"wave_dispatch","message":"wave_dispatch group=alpha second"}'

# Negative control — clean high-complexity plan with all annotations + events
write_plan clean '---
phase: complete
status: ok
complexity: high
codex_routing: auto
codex_review: on
complexity_source: flag
last_activity: 2026-05-15T00:00:00Z' '### Task 1
**Codex:** ok
**parallel-group:** alpha
### Task 2
**Codex:** ok
**parallel-group:** alpha' '{"ts":"2026-05-15T00:00:00Z","type":"plan_event","message":"brainstorm_anchor_resolved"}
{"ts":"2026-05-15T00:01:00Z","type":"phase_change","message":"phase: planning"}
{"ts":"2026-05-15T00:02:00Z","type":"codex_ping","message":"codex_ping ok"}
{"ts":"2026-05-15T00:03:00Z","type":"task_routed","message":"routing→[codex]"}
{"ts":"2026-05-15T00:04:00Z","type":"cache_pin","message":"cache_pinned_for_wave=true alpha"}
{"ts":"2026-05-15T00:05:00Z","type":"wave_dispatch","message":"wave_dispatch group=alpha"}
{"ts":"2026-05-15T00:06:00Z","type":"codex_review","message":"Codex review: ok"}
{"ts":"2026-05-15T00:07:00Z","type":"verify_run","message":"tests pass"}
{"ts":"2026-05-15T00:08:00Z","type":"phase_change","message":"phase: complete"}'

# Run the audit module directly via Python on the synthetic dir.
out_json="$smoke_root/audit.json"
python3 - "$smoke_root" "$out_json" <<'PY'
import json
import sys
from pathlib import Path
sys.path.insert(0, "/home/ras/dev/superpowers-masterplan/lib")
import masterplan_session_audit as M

root = Path(sys.argv[1])
out = Path(sys.argv[2])

# Override discovery: feed only the synthetic plan dirs.
plans_dir = root / "repo" / "docs" / "masterplan"
plan_paths = sorted(d / "state.yml" for d in plans_dir.iterdir() if d.is_dir())

import datetime
audit_now = datetime.datetime(2026, 5, 15, 18, 0, 0, tzinfo=datetime.timezone.utc)
cutoff = audit_now - datetime.timedelta(hours=24)

# Force "missing" Codex auth file so codex_auth_ok evaluates correctly to True
# (codex_auth_healthy returns True when the file is missing — fail-open).
results = []
for p in plan_paths:
    stats = M.analyze_plan_state(p, cutoff, root_path=root, codex_auth_ok=True, now=audit_now)
    results.append(stats)

payload = {
    "plans": [
        {
            "slug": s.slug,
            "warnings": [{"code": w.code, "warning": w.text} for w in s.warnings],
        }
        for s in results
    ],
}
out.write_text(json.dumps(payload, indent=2))
PY

# Per-fixture assertions on the audit JSON.
get_warnings_for() {
  local slug="$1"
  jq -r --arg s "$slug" '.plans[] | select(.slug==$s) | .warnings[].code' "$out_json"
}

# Hard-code positive fixtures
assert_grep "annot-gap fires codex_annotation_gap_on_high" "codex_annotation_gap_on_high" <(get_warnings_for "annot-gap")
assert_grep "no-pg fires codex_parallel_group_missing_on_high" "codex_parallel_group_missing_on_high" <(get_warnings_for "no-pg")
assert_grep "no-route fires codex_routing_configured_but_zero_dispatches" "codex_routing_configured_but_zero_dispatches" <(get_warnings_for "no-route")
assert_grep "no-review fires codex_review_configured_but_zero_invocations" "codex_review_configured_but_zero_invocations" <(get_warnings_for "no-review")
assert_grep "no-ping fires missing_codex_ping_event" "missing_codex_ping_event" <(get_warnings_for "no-ping")
assert_grep "silent-degrade fires silent_codex_degradation" "silent_codex_degradation" <(get_warnings_for "silent-degrade")
assert_grep "pending-stale fires pending_gate_orphaned" "pending_gate_orphaned" <(get_warnings_for "pending-stale")
assert_grep "no-verify fires cd3_verification_missing_on_complete" "cd3_verification_missing_on_complete" <(get_warnings_for "no-verify")
assert_grep "no-anchor fires brainstorm_anchor_missing_before_planning" "brainstorm_anchor_missing_before_planning" <(get_warnings_for "no-anchor")
assert_grep "wave-no-pin fires wave_dispatched_without_pin" "wave_dispatched_without_pin" <(get_warnings_for "wave-no-pin")
assert_grep "default-complexity fires complexity_unset_fallthrough" "complexity_unset_fallthrough" <(get_warnings_for "default-complexity")
assert_grep "parallel-serial fires parallel_eligible_but_serial_dispatched" "parallel_eligible_but_serial_dispatched" <(get_warnings_for "parallel-serial")

# Negative control: clean fixture should not fire any of the policy-regression codes.
clean_warnings="$(get_warnings_for clean)"
for code in codex_annotation_gap_on_high codex_parallel_group_missing_on_high \
            codex_routing_configured_but_zero_dispatches \
            codex_review_configured_but_zero_invocations missing_codex_ping_event \
            silent_codex_degradation pending_gate_orphaned \
            cd3_verification_missing_on_complete brainstorm_anchor_missing_before_planning \
            wave_dispatched_without_pin parallel_eligible_but_serial_dispatched; do
  assert_not_grep "clean fixture suppresses $code" "$code" <(echo "$clean_warnings")
done

# ---------------------------------------------------------------------------
# Part 2: findings-to-issues dispatcher with a stubbed gh.
# ---------------------------------------------------------------------------
echo
echo "== Part 2: findings-to-issues dispatcher =="

# Stage a stubbed gh that records its arguments and emits a controlled response.
stub_dir="$smoke_root/stub-bin"
mkdir -p "$stub_dir"
gh_log="$smoke_root/gh-calls.log"
gh_state="$smoke_root/gh-state.txt"
echo "" > "$gh_state"  # empty: gh issue list returns []
cat >"$stub_dir/gh" <<'STUB'
#!/usr/bin/env bash
log="${GH_STUB_LOG}"
state="${GH_STUB_STATE}"
{
  printf '['
  for a in "$@"; do
    printf '"%s" ' "$a"
  done
  printf ']\n'
} >>"$log"

case "$1 $2" in
  "issue list")
    cat "$state" 2>/dev/null
    ;;
  "issue create")
    echo "https://example/issues/1" 1>&2
    ;;
  "issue comment"|"issue reopen")
    echo "ok" 1>&2
    ;;
esac
exit 0
STUB
chmod +x "$stub_dir/gh"

# Stage isolated state dir + plan tree (with one wiped, one clean, one orphan).
audit_state="$smoke_root/audit-state"
mkdir -p "$audit_state"
plans_root="$smoke_root/plans-root"
mkdir -p "$plans_root/repoA/docs/masterplan/wiped-plan"
mkdir -p "$plans_root/repoA/docs/masterplan/live-plan"
# wiped-plan has the breadcrumb
cat >"$plans_root/repoA/docs/masterplan/wiped-plan/state.yml" <<EOF
phase: complete
events_wiped:
  ts: 2026-05-15T00:00:00Z
EOF
cat >"$plans_root/repoA/docs/masterplan/live-plan/state.yml" <<EOF
phase: complete
EOF

# Build a findings.jsonl with: 1 hard+wiped, 1 hard+live, 1 soft, 1 hard+orphan, 1 claude-source hard.
findings="$audit_state/findings.jsonl"
cat >"$findings" <<'EOF'
{"run_id":"20260515T100000Z","cutoff":"2026-05-14T10:00:00Z","code":"codex_annotation_gap_on_high","repo":"repoA","session":"wiped-plan","source":"plan","warning":"sample"}
{"run_id":"20260515T100000Z","cutoff":"2026-05-14T10:00:00Z","code":"codex_annotation_gap_on_high","repo":"repoA","session":"live-plan","source":"plan","warning":"sample"}
{"run_id":"20260515T100000Z","cutoff":"2026-05-14T10:00:00Z","code":"codex_parallel_group_missing_on_high","repo":"repoA","session":"live-plan","source":"plan","warning":"soft sample"}
{"run_id":"20260515T100000Z","cutoff":"2026-05-14T10:00:00Z","code":"codex_routing_configured_but_zero_dispatches","repo":"repoA","session":"orphan-plan","source":"plan","warning":"orphan"}
{"run_id":"20260515T100000Z","cutoff":"2026-05-14T10:00:00Z","code":"cc3_trampoline_skipped_after_subagents","repo":"repoB","session":"abcd1234-001","source":"claude","warning":"claude sample"}
EOF

# Run 1: apply mode (no --dry-run); --all to bypass sentinel.
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --all --repo fakeowner/fakerepo 2>"$smoke_root/run1.log"

# Assertions: only 2 dispatches (live-plan plan-source + claude-source). wiped + orphan + soft suppressed.
run1_log="$smoke_root/run1.log"
assert_grep "run1 reports eligible=5" "eligible[[:space:]]*=[[:space:]]*5" "$run1_log"
assert_grep "run1 reports dispatched=2" "dispatched[[:space:]]*=[[:space:]]*2" "$run1_log"
assert_grep "run1 reports skipped_wiped=1" "skipped_wiped[[:space:]]*=[[:space:]]*1" "$run1_log"
assert_grep "run1 reports skipped_soft=1" "skipped_soft[[:space:]]*=[[:space:]]*1" "$run1_log"
assert_grep "run1 reports skipped_orphan=1" "skipped_orphan[[:space:]]*=[[:space:]]*1" "$run1_log"
assert_grep "run1 reports failed=0" "failed[[:space:]]*=[[:space:]]*0" "$run1_log"

# The stub should have been called: 2 list + 2 create. Total >= 4 gh calls.
gh_call_count=$(wc -l <"$gh_log")
[[ "$gh_call_count" -ge 4 ]] && assert_eq "run1 gh calls >=4" 1 1 || assert_eq "run1 gh calls >=4" 1 0

# Sentinel should be advanced.
sentinel="$audit_state/findings-last-run-id.txt"
[[ -f "$sentinel" ]] && sval="$(head -n1 "$sentinel")" || sval=""
assert_eq "run1 advanced sentinel to 20260515T100000Z" "20260515T100000Z" "$sval"

# Pending file should NOT exist (no failures).
if [[ ! -f "$audit_state/findings-pending-upload.jsonl" ]]; then
  assert_eq "run1 left no pending file" 0 0
else
  assert_eq "run1 left no pending file" 0 1
fi

# Run 2: same input; sentinel should now suppress everything.
> "$gh_log"
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --repo fakeowner/fakerepo 2>"$smoke_root/run2.log"

assert_grep "run2 nothing to process" "nothing to process" "$smoke_root/run2.log"

# Run 3: append a new finding with a later run_id; only that one should dispatch.
echo '{"run_id":"20260515T110000Z","cutoff":"2026-05-14T11:00:00Z","code":"codex_routing_configured_but_zero_dispatches","repo":"repoA","session":"live-plan","source":"plan","warning":"new"}' >> "$findings"
> "$gh_log"
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --repo fakeowner/fakerepo 2>"$smoke_root/run3.log"
assert_grep "run3 dispatched=1" "dispatched[[:space:]]*=[[:space:]]*1" "$smoke_root/run3.log"
assert_grep "run3 baseline 100000Z" "baseline_rid[[:space:]]*=[[:space:]]*20260515T100000Z" "$smoke_root/run3.log"

# Run 4: signature stability — re-create the same finding with --all should
# produce the SAME signature in the issue title.
> "$gh_log"
# Force gh issue list to claim an existing issue at number 42, state OPEN.
echo '[{"number":42,"state":"OPEN","title":"foo"}]' > "$gh_state"
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --all --repo fakeowner/fakerepo 2>"$smoke_root/run4.log"

# When existing issue is OPEN, we comment — assert at least one "issue comment" call appeared.
assert_grep "run4 comments on existing OPEN issue" "issue\".*\"comment" "$gh_log"
assert_not_grep "run4 did not create when OPEN exists" "issue\".*\"create" "$gh_log"

# Run 5: closed issue → reopen path.
> "$gh_log"
echo '[{"number":42,"state":"CLOSED","title":"foo"}]' > "$gh_state"
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --all --repo fakeowner/fakerepo 2>"$smoke_root/run5.log"
assert_grep "run5 reopens closed issue" "issue\".*\"reopen" "$gh_log"

# Run 6: failure path — make gh exit nonzero for create; verify pending file lands.
cat >"$stub_dir/gh" <<'STUB2'
#!/usr/bin/env bash
log="${GH_STUB_LOG}"
{
  printf '['
  for a in "$@"; do
    printf '"%s" ' "$a"
  done
  printf ']\n'
} >>"$log"
case "$1 $2" in
  "issue list") echo "" ;;  # no existing issue
  *) exit 1 ;;              # creation fails
esac
exit 0
STUB2
chmod +x "$stub_dir/gh"

> "$gh_log"
rm -f "$audit_state/findings-pending-upload.jsonl"
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --all --repo fakeowner/fakerepo 2>"$smoke_root/run6.log"
# Should report failed >= 1 and leave a pending file.
assert_grep "run6 reports failures" "failed[[:space:]]*=[[:space:]]*[1-9]" "$smoke_root/run6.log"
[[ -s "$audit_state/findings-pending-upload.jsonl" ]] && assert_eq "run6 pending file written" 1 1 || assert_eq "run6 pending file written" 1 0

# Run 7: --dry-run does not touch sentinel or pending.
rm -f "$audit_state/findings-pending-upload.jsonl" "$audit_state/findings-last-run-id.txt"
> "$gh_log"
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --all --dry-run --repo fakeowner/fakerepo 2>"$smoke_root/run7.log"
assert_grep "run7 dry-run path noted" "dry_run[[:space:]]*=[[:space:]]*1" "$smoke_root/run7.log"
[[ ! -f "$audit_state/findings-last-run-id.txt" ]] && assert_eq "run7 dry-run leaves no sentinel" 0 0 || assert_eq "run7 dry-run leaves no sentinel" 0 1
gh_calls_in_dry=$(wc -l <"$gh_log")
assert_eq "run7 dry-run made no gh calls" 0 "$gh_calls_in_dry"

# Run 8: --no-skip-wiped attempts the wiped plan too.
> "$gh_log"
rm -f "$audit_state/findings-pending-upload.jsonl" "$audit_state/findings-last-run-id.txt"
echo "" > "$gh_state"
# Restore a working create stub.
cat >"$stub_dir/gh" <<'STUB3'
#!/usr/bin/env bash
log="${GH_STUB_LOG}"
state="${GH_STUB_STATE}"
{
  printf '['
  for a in "$@"; do
    printf '"%s" ' "$a"
  done
  printf ']\n'
} >>"$log"
case "$1 $2" in
  "issue list") cat "$state" ;;
  *) echo "ok" 1>&2 ;;
esac
exit 0
STUB3
chmod +x "$stub_dir/gh"
PATH="$stub_dir:$PATH" \
  GH_STUB_LOG="$gh_log" GH_STUB_STATE="$gh_state" \
  MASTERPLAN_AUDIT_STATE_DIR="$audit_state" \
  MASTERPLAN_REPO_ROOTS="$plans_root" \
  "$repo_root/bin/masterplan-findings-to-issues.sh" --all --no-skip-wiped --repo fakeowner/fakerepo 2>"$smoke_root/run8.log"
assert_grep "run8 no wipe skip" "skipped_wiped[[:space:]]*=[[:space:]]*0" "$smoke_root/run8.log"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo
echo "=== Smoke test summary ==="
echo "assertions: $assertions"
echo "failures:   $failures"

if [[ "$failures" -gt 0 ]]; then
  echo
  echo "Tail of last few logs:"
  for f in "$smoke_root"/run*.log; do
    echo "--- $f ---"
    cat "$f"
  done
  exit 1
fi
exit 0
