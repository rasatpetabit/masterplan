#!/usr/bin/env bash
# masterplan-failure-analyze.sh - over-time analysis of auto-filed anomaly issues.
#
# Queries GitHub for issues labeled `auto-filed` in the configured destination
# repo, joins each to its class label (`class/<class>`), parses the embedded
# signature from the title prefix, walks comments to count recurrences and
# detect reopen events. Emits a markdown report to stdout and (unless
# --no-snapshot) writes a dated copy to docs/failure-analysis/<YYYY-MM-DD>.md.
#
# Usage:
#   bin/masterplan-failure-analyze.sh [--repo OWNER/NAME]
#                                     [--snapshot-dir DIR]
#                                     [--no-snapshot]
#                                     [--limit N]
#                                     [--since YYYY-MM-DD]
#
# Defaults:
#   --repo          rasatpetabit/superpowers-masterplan (override via
#                   .masterplan.yaml failure_reporting.repo)
#   --snapshot-dir  docs/failure-analysis
#   --limit         1000
#
# Requires: gh, jq, awk.

set -euo pipefail

# ----- arg parsing -----
repo=""
snapshot_dir=""
no_snapshot=0
limit=1000
since=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --snapshot-dir) snapshot_dir="$2"; shift 2 ;;
    --no-snapshot) no_snapshot=1; shift ;;
    --limit) limit="$2"; shift 2 ;;
    --since) since="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ----- locate repo root + config -----
script_dir="$(cd "$(dirname "$0")" && pwd)"
worktree="$(cd "$script_dir/.." && pwd)"

if [[ -z "$repo" ]]; then
  mp_config="$worktree/.masterplan.yaml"
  if [[ -f "$mp_config" ]]; then
    cfg_repo=$(awk '/^failure_reporting:/{in_fr=1; next} in_fr && /^[^ ]/{in_fr=0} in_fr && /repo:/{sub(/.*repo:[[:space:]]*/,""); gsub(/["'\'']/,""); print; exit}' "$mp_config" 2>/dev/null || true)
    [[ -n "$cfg_repo" ]] && repo="$cfg_repo"
  fi
fi
repo="${repo:-rasatpetabit/superpowers-masterplan}"
snapshot_dir="${snapshot_dir:-$worktree/docs/failure-analysis}"

# ----- deps -----
for tool in gh jq awk; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing dependency: $tool" >&2; exit 3;
  }
done

# ----- fetch issues -----
# Pull full body + comments + timeline events. The body holds the JSON record;
# the timeline tells us about reopen events.
echo "Fetching auto-filed issues from $repo (limit=$limit)..." >&2

issues_json=$(gh issue list --repo "$repo" \
  --label auto-filed --state all --limit "$limit" \
  --json number,title,state,labels,createdAt,closedAt,updatedAt,comments \
  2>/dev/null) || {
    echo "gh issue list failed for $repo" >&2; exit 4;
  }

issue_count=$(echo "$issues_json" | jq 'length')
[[ "$issue_count" -gt 0 ]] || {
  echo "No auto-filed issues found in $repo." >&2
  cat <<EOF
# Failure Instrumentation Analysis — $(date -u +%Y-%m-%dT%H:%M:%SZ)

**Repo:** $repo
**Issues analyzed:** 0

No auto-filed issues found yet. Either the framework has not detected any
anomalies, or the destination repo is wrong.
EOF
  exit 0
}

# ----- filter by --since if requested -----
if [[ -n "$since" ]]; then
  issues_json=$(echo "$issues_json" | jq --arg since "$since" \
    '[.[] | select(.createdAt >= ($since + "T00:00:00Z"))]')
  issue_count=$(echo "$issues_json" | jq 'length')
fi

# ----- compute metrics -----

# 1. Frequency by class.
freq_table=$(echo "$issues_json" | jq -r '
  [.[] | (.labels[]? | select(.name | startswith("class/")) | .name | sub("class/"; ""))]
  | group_by(.) | map({class: .[0], count: length})
  | sort_by(-.count)
  | .[] | "\(.count)\t\(.class)"
')

# 2. Open-time-to-close median per class.
ttc_per_class=$(echo "$issues_json" | jq -r '
  [.[] |
    select(.closedAt != null) |
    {
      class: ((.labels[]? | select(.name | startswith("class/")) | .name | sub("class/"; "")) // "unknown"),
      ttc_sec: (((.closedAt | fromdate) - (.createdAt | fromdate)))
    }
  ]
  | group_by(.class)
  | map({
      class: .[0].class,
      n: length,
      median_h: ((. | map(.ttc_sec) | sort) as $s
                | if length == 0 then 0
                  else (if (length % 2) == 1
                        then $s[(length/2)|floor]
                        else (($s[(length/2)-1] + $s[length/2]) / 2) end
                       ) / 3600
                  end | . * 10 | round / 10)
    })
  | sort_by(.class)
  | .[] | "\(.class)\t\(.n)\t\(.median_h)h"
')

# 3. Reopen / regression histogram.
#    Reopens are detected by looking at comments — the hook writes a
#    "Regression at <ts>" comment on reopen. Count "Regression at " in comment bodies.
#    For time-to-regression: closedAt → first regression comment timestamp.
reopen_data=$(echo "$issues_json" | jq -rc '
  .[] |
  select(.closedAt != null) |
  (.comments // []) as $cs |
  ($cs | map(select((.body // "") | test("^Regression at "; "")))) as $regrs |
  if ($regrs | length) > 0 then
    {
      number, title, state,
      closedAt,
      reopen_count: ($regrs | length),
      first_regression_at: $regrs[0].createdAt,
      class: ((.labels[]? | select(.name | startswith("class/")) | .name | sub("class/"; "")) // "unknown")
    }
  else empty end
')

reopen_rows=$(echo "$reopen_data" | jq -rc 'select(.) |
  ((.first_regression_at | fromdate) - (.closedAt | fromdate)) as $delta |
  "\(.class)\t#\(.number)\t\(.reopen_count)\t\((($delta) / 86400) | . * 10 | round / 10)d\t\(.title)"
' 2>/dev/null || true)

# 4. Per-verb / per-step breakdown — parse title.
#    Title format: "[auto:<sig12>] <class>: <step> <verb>"
verb_table=$(echo "$issues_json" | jq -r '
  .[] | .title
' | awk '{
  # extract trailing " <step> <verb>"
  match($0, /\] [a-z0-9_-]+: ([a-z0-9-]+) ([a-z]+)$/, m);
  if (m[2] != "") print m[2];
}' | sort | uniq -c | sort -rn | awk '{printf "%s\t%s\n", $1, $2}')

step_table=$(echo "$issues_json" | jq -r '
  .[] | .title
' | awk '{
  match($0, /\] [a-z0-9_-]+: ([a-z0-9-]+) ([a-z]+)$/, m);
  if (m[1] != "") print m[1];
}' | sort | uniq -c | sort -rn | awk '{printf "%s\t%s\n", $1, $2}')

# 5. Co-occurrence matrix: classes that fire together within the same plan_slug.
#    Parse plan_slug from the embedded JSON record in each issue body. We don't
#    fetch bodies in the list query (too heavy); instead, fetch comment+body
#    pairs only for issues that have a reopen or recurrence (a useful subset).
#    Lightweight co-occurrence: pair classes that appear in the same calendar day.
cooc=$(echo "$issues_json" | jq -rc '
  .[] | {
    day: (.createdAt | sub("T.*"; "")),
    class: ((.labels[]? | select(.name | startswith("class/")) | .name | sub("class/"; "")) // "unknown")
  }
' | jq -src '
  group_by(.day) | map({day: .[0].day, classes: (map(.class) | unique)})
  | map(select(.classes | length > 1))
  | map(.classes as $cs | [range(0; $cs|length) as $i | range($i+1; $cs|length) as $j | [$cs[$i], $cs[$j]]])
  | flatten(1) | group_by(.) | map({pair: .[0], n: length})
  | sort_by(-.n)
  | .[] | "\(.n)\t\(.pair[0]) + \(.pair[1])"
' 2>/dev/null || true)

# ----- assemble report -----
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
today=$(date -u +%Y-%m-%d)
total_open=$(echo "$issues_json" | jq '[.[] | select(.state == "OPEN")] | length')
total_closed=$(echo "$issues_json" | jq '[.[] | select(.state == "CLOSED")] | length')
total_reopens=$(echo "$reopen_data" | jq -s 'map(.reopen_count) | add // 0')

render_report() {
  cat <<EOF
# Failure Instrumentation Analysis — $ts

**Repo:** \`$repo\`
**Issues analyzed:** $issue_count (open: $total_open, closed: $total_closed)
**Total regression reopens:** $total_reopens
$( [[ -n "$since" ]] && echo "**Filtered since:** $since" )

---

## Frequency by class

| Count | Class |
|------:|:------|
$(echo "$freq_table" | awk -F'\t' 'NF==2 {printf "| %s | %s |\n", $1, $2}')

EOF

  if [[ -n "$reopen_rows" ]]; then
    cat <<EOF
## Recurrence-after-fix (regression signal)

This is the most important table. A high reopen_count or a short time-to-regression
means the "fix" did not actually fix the underlying behavior — the failure
re-surfaced after the issue was closed.

| Class | Issue | Reopens | Days closed → recurred | Title |
|:------|:------|--------:|----------------------:|:------|
$(echo "$reopen_rows" | awk -F'\t' 'NF==5 {printf "| %s | %s | %s | %s | %s |\n", $1, $2, $3, $4, $5}')

EOF
  else
    cat <<EOF
## Recurrence-after-fix (regression signal)

No regressions detected. (No issue has been closed and then reopened.)

EOF
  fi

  cat <<EOF
## Open-time-to-close (median) by class

| Class | N closed | Median hrs open |
|:------|---------:|---------------:|
$(echo "$ttc_per_class" | awk -F'\t' 'NF==3 {printf "| %s | %s | %s |\n", $1, $2, $3}')

## Per-verb breakdown

Which command invocations are most failure-prone.

| Count | Verb |
|------:|:-----|
$(echo "$verb_table" | awk -F'\t' 'NF==2 {printf "| %s | %s |\n", $1, $2}')

## Per-step breakdown

Which orchestrator steps are most failure-prone.

| Count | Step |
|------:|:-----|
$(echo "$step_table" | awk -F'\t' 'NF==2 {printf "| %s | %s |\n", $1, $2}')

EOF

  if [[ -n "$cooc" ]]; then
    cat <<EOF
## Same-day co-occurrence

Classes that surfaced together on the same calendar day (suggests shared root cause).

| Count | Pair |
|------:|:-----|
$(echo "$cooc" | awk -F'\t' 'NF==2 {printf "| %s | %s |\n", $1, $2}')

EOF
  fi

  cat <<EOF
---

*Generated by \`bin/masterplan-failure-analyze.sh\` at $ts.*
EOF
}

report=$(render_report)
echo "$report"

# ----- snapshot -----
if [[ "$no_snapshot" -eq 0 ]]; then
  mkdir -p "$snapshot_dir"
  snapshot_file="$snapshot_dir/$today.md"
  echo "$report" > "$snapshot_file"
  echo "" >&2
  echo "Snapshot written: $snapshot_file" >&2
fi
