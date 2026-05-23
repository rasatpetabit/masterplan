#!/usr/bin/env bash
# Verify doctor check tier assignments are consistent.
#
# Checks with an explicit "**Scope:**" field are validated:
#   Plan-scoped             → must appear in the parallelization brief
#   Repo-scoped / Global /
#   Prompt-scoped           → must appear in the checks_processed array
#
# This catches future drift when a new check is added with the wrong tier,
# or when the brief / checks_processed list is updated without moving the check.
#
# Exit 0 on PASS, 1 on FAIL.

set -u
REPO_ROOT="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -n "$REPO_ROOT" ] || { echo "FAIL: not in a git repo"; exit 2; }
cd "$REPO_ROOT" || exit 2

DOCTOR="parts/doctor.md"
[ -f "$DOCTOR" ] || { echo "SKIP: $DOCTOR not found"; exit 0; }

fail=0
plan_ids=""
repo_ids=""

# --- Extract check ID → tier pairs via awk ---
# Pairs each "## Check #N" header with its following "**Scope:**" line.
# Tab-separated: "## Check #N: title\t**Scope:** <tier> ..."
while IFS=$'\t' read -r check_header scope_line; do
  id="$(echo "$check_header" | grep -oE '[0-9]+' | head -1)"
  [ -z "$id" ] && continue
  if echo "$scope_line" | grep -q 'Plan-scoped'; then
    plan_ids="$plan_ids $id"
  elif echo "$scope_line" | grep -qE 'Repo-scoped|Global|Prompt-scoped'; then
    repo_ids="$repo_ids $id"
  fi
done < <(awk '/^## Check #[0-9]+/{id=$0} /\*\*Scope:\*\*/{if(id) print id "\t" $0; id=""}' "$DOCTOR")

# --- Parse parallelization brief check list ---
# Looks for: "plan-scoped checks (currently #1-24, #28, ...)" on the Parallelization line.
brief_raw="$(grep 'plan-scoped checks (currently' "$DOCTOR" | head -1 \
  | sed 's/.*currently \([^)]*\).*/\1/' || true)"
if [ -z "$brief_raw" ]; then
  echo "FAIL: could not parse parallelization brief from $DOCTOR"
  fail=$((fail+1))
fi

# Expand ranges (#1-24) and individual IDs (#28) into a space-separated list.
brief_ids=""
for token in $(echo "$brief_raw" | tr ',' '\n' | tr -d ' '); do
  token="${token##\#}"
  if echo "$token" | grep -qE '^[0-9]+-[0-9]+$'; then
    lo="${token%%-*}"; hi="${token##*-}"
    for i in $(seq "$lo" "$hi"); do brief_ids="$brief_ids $i"; done
  else
    [ -n "$token" ] && brief_ids="$brief_ids $token"
  fi
done

# --- Parse checks_processed: [26, 30, 31, ...] ---
cp_raw="$(grep 'checks_processed:' "$DOCTOR" | head -1 \
  | sed 's/.*checks_processed: \[\([^]]*\)\].*/\1/' || true)"
processed_ids=" $(echo "$cp_raw" | tr ',' '\n' | tr -d ' ' | tr '\n' ' ') "

# --- Membership helper ---
in_list() {
  local list=" $1 " id="$2"
  case "$list" in *" $id "*) return 0 ;; esac
  return 1
}

# --- Validate Plan-scoped checks are in parallelization brief ---
for id in $plan_ids; do
  if ! in_list "$brief_ids" "$id"; then
    echo "FAIL: check #$id has Scope:Plan-scoped but is missing from parallelization brief"
    fail=$((fail+1))
  fi
done

# --- Validate Repo/Global/Prompt-scoped checks are in checks_processed ---
for id in $repo_ids; do
  if ! in_list "$processed_ids" "$id"; then
    echo "FAIL: check #$id has Scope:Repo/Global/Prompt-scoped but is missing from checks_processed"
    fail=$((fail+1))
  fi
done

if [ $fail -eq 0 ]; then
  n_plan="$(echo $plan_ids | wc -w | tr -d ' ')"
  n_repo="$(echo $repo_ids | wc -w | tr -d ' ')"
  echo "test-doctor-tier-drift: PASS ($n_plan plan-scoped [$(echo $plan_ids | tr ' ' ',')], $n_repo repo-scoped [$(echo $repo_ids | tr ' ' ',')])"
  exit 0
fi
echo "test-doctor-tier-drift: FAIL ($fail issue(s))"
exit 1
