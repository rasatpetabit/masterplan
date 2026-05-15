#!/usr/bin/env bash
# masterplan-findings-to-issues.sh - File GH issues for hard-threshold
# policy-regression findings emitted by masterplan-recurring-audit.sh.
#
# Mirrors the v5.1.0 failure-instrumentation dispatcher pattern
# (signature-based dedup, comment on recurrence, reopen on close,
# local-first persistence on gh failure).
#
# Usage:
#   bin/masterplan-findings-to-issues.sh                       # process new findings
#   bin/masterplan-findings-to-issues.sh --dry-run             # report; do not file
#   bin/masterplan-findings-to-issues.sh --since-run-id RUN_ID # backfill from RUN_ID
#   bin/masterplan-findings-to-issues.sh --all                 # ignore sentinel
#   bin/masterplan-findings-to-issues.sh --limit N             # cap dispatches
#   bin/masterplan-findings-to-issues.sh --no-skip-wiped       # ignore events_wiped:
#   bin/masterplan-findings-to-issues.sh --repo OWNER/NAME     # override repo
#   bin/masterplan-findings-to-issues.sh --state-dir DIR       # override state
#   bin/masterplan-findings-to-issues.sh --plans-roots A:B     # override roots
#
# Inputs:
#   ${MASTERPLAN_AUDIT_STATE_DIR:-XDG/.../audits}/findings.jsonl
#   ${state-dir}/findings-pending-upload.jsonl  (retry queue)
#   ${state-dir}/findings-last-run-id.txt        (sentinel)
#
# Hard-threshold codes (must match POLICY_REGRESSION_HARD_CODES in
# lib/masterplan_session_audit.py — drift here will silently skip).
#
# Exit codes:
#   0  clean
#   1  one or more uploads failed (entries left in pending file)
#   2  bad args / missing deps

set -u

repo=""
state_dir=""
plans_roots=""
since_run_id=""
process_all=0
limit=0
dry_run=0
skip_wiped=1

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --state-dir) state_dir="$2"; shift 2 ;;
    --plans-roots) plans_roots="$2"; shift 2 ;;
    --since-run-id) since_run_id="$2"; shift 2 ;;
    --all) process_all=1; shift ;;
    --limit) limit="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --no-skip-wiped) skip_wiped=0; shift ;;
    -h|--help) usage 0 ;;
    *) echo "unknown arg: $1" >&2; usage 2 ;;
  esac
done

script_dir="$(cd "$(dirname "$0")" && pwd)"
worktree="$(cd "$script_dir/.." && pwd)"

# Resolve failure_reporting from .masterplan.yaml (matches hooks/masterplan-telemetry.sh pattern).
fr_enabled="true"
fr_dry_run="false"
fr_repo="rasatpetabit/superpowers-masterplan"
mp_config="$worktree/.masterplan.yaml"
if [[ -f "$mp_config" ]]; then
  awk_repo=$(awk '/^failure_reporting:/{in_fr=1; next} in_fr && /^[^ ]/{in_fr=0} in_fr && /repo:/{sub(/.*repo:[[:space:]]*/,""); gsub(/["'\'']/,""); print; exit}' "$mp_config" 2>/dev/null)
  awk_enabled=$(awk '/^failure_reporting:/{in_fr=1; next} in_fr && /^[^ ]/{in_fr=0} in_fr && /enabled:/{sub(/.*enabled:[[:space:]]*/,""); print; exit}' "$mp_config" 2>/dev/null)
  awk_dry=$(awk '/^failure_reporting:/{in_fr=1; next} in_fr && /^[^ ]/{in_fr=0} in_fr && /dry_run:/{sub(/.*dry_run:[[:space:]]*/,""); print; exit}' "$mp_config" 2>/dev/null)
  [[ -n "$awk_repo" ]] && fr_repo="$awk_repo"
  [[ "$awk_enabled" == "false" ]] && fr_enabled="false"
  [[ "$awk_dry" == "true" ]] && fr_dry_run="true"
fi

if [[ "$fr_enabled" != "true" ]]; then
  echo "findings-to-issues: failure_reporting disabled in .masterplan.yaml; exiting 0" >&2
  exit 0
fi
[[ "$fr_dry_run" == "true" ]] && dry_run=1
[[ -z "$repo" ]] && repo="$fr_repo"

state_dir="${state_dir:-${MASTERPLAN_AUDIT_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/superpowers-masterplan/audits}}"
plans_roots="${plans_roots:-${MASTERPLAN_REPO_ROOTS:-$HOME/dev}}"

findings_file="${state_dir}/findings.jsonl"
pending_file="${state_dir}/findings-pending-upload.jsonl"
sentinel_file="${state_dir}/findings-last-run-id.txt"

[[ -d "$state_dir" ]] || {
  echo "state_dir not found: $state_dir" >&2
  exit 0
}

# Hard-code allowlist (mirror lib/masterplan_session_audit.py POLICY_REGRESSION_HARD_CODES).
hard_codes_csv="codex_annotation_gap_on_high,codex_routing_configured_but_zero_dispatches,codex_review_configured_but_zero_invocations,missing_codex_ping_event,silent_codex_degradation,cc3_trampoline_skipped_after_subagents,cd3_verification_missing_on_complete,brainstorm_anchor_missing_before_planning,wave_dispatched_without_pin,parallel_eligible_but_serial_dispatched"

is_hard() {
  local code="$1"
  case ",${hard_codes_csv}," in
    *",${code},"*) return 0 ;;
    *) return 1 ;;
  esac
}

for tool in gh jq sha1sum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    if [[ "$dry_run" -eq 1 && "$tool" == "gh" ]]; then
      :  # gh not required under dry-run
    else
      echo "missing dependency: $tool" >&2
      exit 2
    fi
  fi
done

# Compute signature for (code, repo, session).
sig_of() {
  local code="$1" sess_repo="$2" sess="$3"
  printf '%s|%s|%s' "$code" "$sess_repo" "$sess" \
    | sha1sum | awk '{print substr($1,1,12)}'
}

# Locate plan dir for (repo basename, session-slug); return "" if not found.
# Honors MASTERPLAN_REPO_ROOTS (colon-separated).
locate_plan_dir() {
  local sess_repo="$1" slug="$2"
  local IFS=':' root
  for root in $plans_roots; do
    [[ -z "$root" ]] && continue
    local candidate="${root}/${sess_repo}/docs/masterplan/${slug}"
    if [[ -d "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done
  echo ""
  return 1
}

# Check whether the plan's state.yml carries an events_wiped breadcrumb.
plan_was_wiped() {
  local plan_dir="$1"
  [[ -z "$plan_dir" ]] && return 1
  local state_yml="${plan_dir}/state.yml"
  [[ -f "$state_yml" ]] || return 1
  grep -q '^events_wiped:' "$state_yml" 2>/dev/null
}

# Resolve baseline run_id (highest already-processed).
baseline_run_id=""
if [[ -n "$since_run_id" ]]; then
  baseline_run_id="$since_run_id"
elif [[ "$process_all" -eq 1 ]]; then
  baseline_run_id=""
elif [[ -f "$sentinel_file" ]]; then
  baseline_run_id="$(head -n1 "$sentinel_file" 2>/dev/null | tr -d '[:space:]')"
fi

# Drain pending findings first, then walk new findings.
# We collect all eligible rows into a temp file, then process in order.
work_file="$(mktemp)"
trap 'rm -f "$work_file"' EXIT INT TERM

# Pending queue (always replayed).
if [[ -s "$pending_file" ]]; then
  cat "$pending_file" >> "$work_file"
fi

# New findings since baseline_run_id (lexicographic compare on YYYYMMDDTHHMMSSZ).
new_max_run_id=""
if [[ -s "$findings_file" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    rid=$(echo "$line" | jq -r '.run_id // empty' 2>/dev/null)
    [[ -z "$rid" ]] && continue
    if [[ -n "$baseline_run_id" && ! "$rid" > "$baseline_run_id" ]]; then
      continue
    fi
    echo "$line" >> "$work_file"
    if [[ -z "$new_max_run_id" || "$rid" > "$new_max_run_id" ]]; then
      new_max_run_id="$rid"
    fi
  done < "$findings_file"
fi

if [[ ! -s "$work_file" ]]; then
  echo "findings-to-issues: nothing to process (baseline=${baseline_run_id:-none})" >&2
  # Still advance sentinel if findings file exists with later rows than baseline (none eligible — keep sentinel as is).
  exit 0
fi

# Dispatch loop.
total_eligible=0
total_dispatched=0
total_skipped_softcode=0
total_skipped_wiped=0
total_skipped_no_plan_dir=0
total_failed=0
carry_pending="$(mktemp)"
trap 'rm -f "$work_file" "$carry_pending"' EXIT INT TERM

dispatch_one() {
  local rec="$1"
  local code repo_basename slug source warning rid cutoff
  code=$(echo "$rec" | jq -r '.code // empty')
  repo_basename=$(echo "$rec" | jq -r '.repo // empty')
  slug=$(echo "$rec" | jq -r '.session // empty')
  source=$(echo "$rec" | jq -r '.source // empty')
  warning=$(echo "$rec" | jq -r '.warning // empty')
  rid=$(echo "$rec" | jq -r '.run_id // empty')
  cutoff=$(echo "$rec" | jq -r '.cutoff // empty')

  [[ -n "$code" && -n "$repo_basename" && -n "$slug" ]] || {
    echo "  skip: malformed finding (code/repo/session missing)" >&2
    return 1
  }

  if ! is_hard "$code"; then
    total_skipped_softcode=$((total_skipped_softcode + 1))
    return 0
  fi

  # Plan-source-only wipe-breadcrumb gate.
  if [[ "$skip_wiped" -eq 1 && "$source" == "plan" ]]; then
    local plan_dir
    plan_dir="$(locate_plan_dir "$repo_basename" "$slug")"
    if [[ -n "$plan_dir" ]]; then
      if plan_was_wiped "$plan_dir"; then
        total_skipped_wiped=$((total_skipped_wiped + 1))
        return 0
      fi
    else
      total_skipped_no_plan_dir=$((total_skipped_no_plan_dir + 1))
      # Cannot prove wipe-status without state.yml; default-skip is conservative
      # (avoids filing for orphan slugs that no longer have a bundle on disk).
      return 0
    fi
  fi

  local sig title title_prefix body
  sig=$(sig_of "$code" "$repo_basename" "$slug")
  title_prefix="[auto:${sig}]"
  title="${title_prefix} policy-regression ${code}: ${repo_basename}/${slug}"

  body=$(printf '## Auto-filed policy-regression\n\n**Code:** `%s`\n**Source:** %s\n**Repo:** %s\n**Session/Slug:** %s\n**Signature:** `%s`\n**run_id:** %s\n**cutoff:** %s\n\n### Warning\n\n%s\n\n### Record\n\n```json\n%s\n```\n' \
    "$code" "$source" "$repo_basename" "$slug" "$sig" "$rid" "$cutoff" "$warning" "$rec")

  if [[ "$dry_run" -eq 1 ]]; then
    echo "  [dry-run] would file: $title" >&2
    total_dispatched=$((total_dispatched + 1))
    return 0
  fi

  local existing existing_num existing_state
  existing=$(gh issue list --repo "$repo" \
    --search "in:title ${title_prefix}" \
    --state all --json number,state,title --limit 5 2>/dev/null) || return 1
  existing_num=$(echo "$existing" | jq -r '.[0].number // empty')
  existing_state=$(echo "$existing" | jq -r '.[0].state // empty')

  if [[ -z "$existing_num" ]]; then
    gh issue create --repo "$repo" --title "$title" \
      --label "auto-filed" --label "class/policy-regression" --label "class/${code}" \
      --body "$body" >/dev/null 2>&1 || return 1
  elif [[ "$existing_state" == "CLOSED" ]]; then
    gh issue reopen "$existing_num" --repo "$repo" \
      --comment "Regression at ${rid} (run_id): same signature reopened.
${body}" >/dev/null 2>&1 || return 1
  else
    gh issue comment "$existing_num" --repo "$repo" \
      --body "Recurrence at ${rid} (run_id).

${body}" >/dev/null 2>&1 || return 1
  fi

  total_dispatched=$((total_dispatched + 1))
  return 0
}

while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  total_eligible=$((total_eligible + 1))
  if [[ "$limit" -gt 0 && "$total_dispatched" -ge "$limit" ]]; then
    echo "  limit reached ($limit) — carrying remaining $((total_eligible - 1)) row(s)" >&2
    echo "$line" >> "$carry_pending"
    continue
  fi
  if dispatch_one "$line"; then
    :  # ok
  else
    echo "$line" >> "$carry_pending"
    total_failed=$((total_failed + 1))
  fi
done < "$work_file"

# Persist carry-over to pending file (atomically replace).
if [[ -s "$carry_pending" ]]; then
  mv "$carry_pending" "$pending_file"
else
  rm -f "$carry_pending" "$pending_file"
fi

# Advance sentinel only when no failures (otherwise next run retries pending).
if [[ "$total_failed" -eq 0 && -n "$new_max_run_id" && "$dry_run" -eq 0 ]]; then
  echo "$new_max_run_id" > "$sentinel_file"
fi

cat >&2 <<EOF
findings-to-issues complete:
  eligible      = $total_eligible
  dispatched    = $total_dispatched
  skipped_soft  = $total_skipped_softcode
  skipped_wiped = $total_skipped_wiped
  skipped_orphan= $total_skipped_no_plan_dir
  failed        = $total_failed
  repo          = $repo
  baseline_rid  = ${baseline_run_id:-<none>}
  new_max_rid   = ${new_max_run_id:-<none>}
  dry_run       = $dry_run
EOF

if [[ "$total_failed" -gt 0 ]]; then
  exit 1
fi
exit 0
