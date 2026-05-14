#!/usr/bin/env bash
# masterplan-anomaly-flush.sh - drain anomalies-pending-upload.jsonl via gh.
#
# When the Stop-hook failure detector cannot reach GitHub (rate limit, auth
# lapse, network), it appends the anomaly record to
# <run-dir>/anomalies-pending-upload.jsonl alongside the canonical
# anomalies.jsonl. This script walks every run bundle under
# docs/masterplan/<slug>/ and uploads each pending record exactly as the hook
# would have.
#
# Usage:
#   bin/masterplan-anomaly-flush.sh [--repo OWNER/NAME]
#                                   [--slug SLUG]
#                                   [--dry-run]
#                                   [--plans-root DIR]
#
# Defaults:
#   --repo        rasatpetabit/superpowers-masterplan (override via
#                 .masterplan.yaml failure_reporting.repo)
#   --plans-root  docs/masterplan
#
# Exit codes:
#   0  all pending records uploaded (or nothing pending)
#   1  one or more records failed to upload — pending file left intact
#   2  bad arguments / missing deps
#
# A successfully uploaded record is removed from the pending file. If any
# record fails, the script preserves the remaining ones in place so the next
# run can retry.

set -euo pipefail

repo=""
target_slug=""
dry_run=0
plans_root=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo) repo="$2"; shift 2 ;;
    --slug) target_slug="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    --plans-root) plans_root="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

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
plans_root="${plans_root:-$worktree/docs/masterplan}"

for tool in gh jq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing dependency: $tool" >&2; exit 2;
  }
done

[[ -d "$plans_root" ]] || {
  echo "plans_root not found: $plans_root" >&2; exit 0;
}

# Locate pending files. One per run bundle.
mapfile -t pending_files < <(find "$plans_root" -mindepth 2 -maxdepth 3 -name 'anomalies-pending-upload.jsonl' -type f 2>/dev/null | sort)

if [[ "${#pending_files[@]}" -eq 0 ]]; then
  echo "No pending anomaly uploads." >&2
  exit 0
fi

global_failed=0
total_uploaded=0
total_failed=0

upload_one() {
  local rec="$1"
  local class sig title body
  class=$(echo "$rec" | jq -r '.anomaly_class // empty')
  sig=$(echo "$rec" | jq -r '.signature // empty')
  [[ -n "$class" && -n "$sig" ]] || {
    echo "  skip: malformed record (no class/signature)" >&2
    return 1
  }

  local title_prefix="[auto:${sig:0:12}]"
  local last_step last_verb halt autonomy phase status ts plugin_version
  last_step=$(echo "$rec" | jq -r '.last_step // "unknown"')
  last_verb=$(echo "$rec" | jq -r '.verb // "unknown"')
  halt=$(echo "$rec" | jq -r '.halt_mode // "none"')
  autonomy=$(echo "$rec" | jq -r '.autonomy // "loose"')
  phase=$(echo "$rec" | jq -r '.state_phase // ""')
  status=$(echo "$rec" | jq -r '.state_status // ""')
  ts=$(echo "$rec" | jq -r '.ts // "unknown"')
  plugin_version=$(echo "$rec" | jq -r '.plugin_version // "unknown"')
  title="${title_prefix} ${class}: ${last_step} ${last_verb}"

  body=$(printf '## Auto-filed anomaly (flushed from pending queue)\n\n**Class:** %s\n**Signature:** `%s`\n**Last step:** %s\n**Verb:** %s\n**halt_mode:** %s\n**autonomy:** %s\n**state.phase:** %s\n**state.status:** %s\n**plugin_version:** %s\n**original-ts:** %s\n\n### Record\n\n```json\n%s\n```\n' \
    "$class" "$sig" "$last_step" "$last_verb" "$halt" "$autonomy" "$phase" "$status" "$plugin_version" "$ts" "$rec")

  if [[ "$dry_run" -eq 1 ]]; then
    echo "  [dry-run] would upload: $title" >&2
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
      --label "auto-filed" --label "class/${class}" \
      --body "$body" >/dev/null 2>&1 || return 1
  elif [[ "$existing_state" == "CLOSED" ]]; then
    gh issue reopen "$existing_num" --repo "$repo" \
      --comment "Regression at ${ts} (flushed): same signature reopened.
${body}" >/dev/null 2>&1 || return 1
  else
    gh issue comment "$existing_num" --repo "$repo" \
      --body "Recurrence at ${ts} (flushed).

${body}" >/dev/null 2>&1 || return 1
  fi
  return 0
}

for pf in "${pending_files[@]}"; do
  slug_dir="$(dirname "$pf")"
  slug="$(basename "$slug_dir")"
  if [[ -n "$target_slug" && "$slug" != "$target_slug" ]]; then
    continue
  fi
  [[ -s "$pf" ]] || { rm -f "$pf"; continue; }
  echo "Slug: $slug" >&2

  carry_file="$(mktemp)"
  local_uploaded=0
  local_failed=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if upload_one "$line"; then
      local_uploaded=$((local_uploaded + 1))
    else
      echo "$line" >> "$carry_file"
      local_failed=$((local_failed + 1))
    fi
  done < "$pf"

  if [[ "$local_failed" -gt 0 ]]; then
    mv "$carry_file" "$pf"
    global_failed=1
  else
    rm -f "$carry_file" "$pf"
  fi
  total_uploaded=$((total_uploaded + local_uploaded))
  total_failed=$((total_failed + local_failed))
  echo "  uploaded=$local_uploaded failed=$local_failed" >&2
done

echo "Flush complete: uploaded=$total_uploaded failed=$total_failed" >&2
exit "$global_failed"
