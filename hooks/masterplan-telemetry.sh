#!/usr/bin/env bash
# masterplan-telemetry.sh — Stop hook for /masterplan context-usage telemetry.
#
# Defensive: bails silently in any session that isn't operating on a
# /masterplan-managed plan. Safe to wire as a global Stop hook in
# ~/.claude/settings.json.
#
# Append one JSONL record per turn to the active plan's telemetry file. v3+
# bundles write docs/masterplan/<slug>/telemetry.jsonl; legacy pre-v3 status
# files still write <slug>-telemetry.jsonl beside the status file. Per-plan
# opt-out: add `telemetry: off` to state/status.
#
# Required: bash, jq, git, awk. Optional: $CLAUDE_SESSION_ID for
# transcript-resolution accuracy.
#
# License: MIT (matches parent plugin).

set -u

# --- Bail-silent helper ---
bail() { exit 0; }

# Guard C — serialize bundle writes. Wrap a write command in flock -w 5.
# The lockfile lives inside the bundle dir (CD-2 compliant). On macOS /
# non-Linux installs without util-linux flock(1), degrade to unguarded write
# with a one-time WARN per process (MASTERPLAN_FLOCK_WARNED env var).
# See docs/masterplan/concurrency-guards/spec.md L60-L87 / D4.
with_bundle_lock() {
  local bundle="$1"; shift
  local lockfile="${bundle}/.lock"
  mkdir -p "$bundle" 2>/dev/null || true
  if command -v flock >/dev/null 2>&1; then
    # fd-based form: runs "$@" as a shell command (functions + builtins work).
    (
      flock -w 5 9 || {
        echo "ERROR: flock -w 5 on ${lockfile} failed; writer wedged?" >&2
        exit 1
      }
      "$@"
    ) 9>"$lockfile"
    return $?
  else
    if [[ -z "${MASTERPLAN_FLOCK_WARNED:-}" ]]; then
      echo "WARN: flock(1) not found; concurrent writes to ${bundle} are unguarded" >&2
      export MASTERPLAN_FLOCK_WARNED=1
    fi
    "$@"
  fi
}

ensure_telemetry_excluded() {
  local exclude_file rel
  exclude_file=$(git rev-parse --git-path info/exclude 2>/dev/null) || return 1
  [[ -n "$exclude_file" ]] || return 1
  mkdir -p "$(dirname "$exclude_file")" 2>/dev/null || return 1
  touch "$exclude_file" 2>/dev/null || return 1

  if ! grep -q '^# BEGIN MASTERPLAN TELEMETRY IGNORE$' "$exclude_file" 2>/dev/null; then
    {
      printf '\n# BEGIN MASTERPLAN TELEMETRY IGNORE\n'
      printf '# Local-only /masterplan runtime telemetry. Do not commit.\n'
      printf '**/*-telemetry.jsonl\n'
      printf '**/*-telemetry-archive.jsonl\n'
      printf '**/*-subagents.jsonl\n'
      printf '**/*-subagents-archive.jsonl\n'
      printf '**/*-subagents-cursor\n'
      printf '**/docs/masterplan/*/telemetry.jsonl\n'
      printf '**/docs/masterplan/*/subagents.jsonl\n'
      printf '# END MASTERPLAN TELEMETRY IGNORE\n'
    } >> "$exclude_file" 2>/dev/null || return 1
  fi

  for rel in \
    "docs/superpowers/plans/${slug}-telemetry.jsonl" \
    "docs/superpowers/plans/${slug}-subagents.jsonl" \
    "docs/superpowers/plans/${slug}-subagents-cursor" \
    "docs/masterplan/${slug}/telemetry.jsonl" \
    "docs/masterplan/${slug}/subagents.jsonl"; do
    git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 && return 1
    git check-ignore -q --no-index -- "$rel" 2>/dev/null || return 1
  done
}

# 0. Required tool guard. If jq is missing, the JSONL append at step 7 would
# silently produce nothing forever — bail explicitly so the user notices via
# the absence rather than via gradually-empty telemetry files.
command -v jq >/dev/null 2>&1 || bail

# 0b. Claude Code Stop hook input capture.
# Claude Code passes a JSON blob on stdin per https://code.claude.com/docs/en/hooks
# including .stop_hook_active (true when the Stop event fired inside a
# /goal-driven or other autonomous-continuation loop). Codex hosts do not
# provide this surface; absent/malformed input defaults to false so the field
# stays meaningful on every record.
hook_input=""
if [[ ! -t 0 ]]; then
  hook_input=$(cat 2>/dev/null || true)
fi
claude_stop_hook_active=false
if [[ -n "$hook_input" ]]; then
  parsed=$(printf '%s' "$hook_input" | jq -r '.stop_hook_active // false' 2>/dev/null || printf 'false')
  case "$parsed" in
    true|false) claude_stop_hook_active="$parsed" ;;
    *) claude_stop_hook_active=false ;;
  esac
fi

# 1. Must be inside a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || bail
worktree=$(git rev-parse --show-toplevel 2>/dev/null) || bail

# 2. Resolve current branch.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || bail
[[ -n "$branch" && "$branch" != "HEAD" ]] || bail

# 3. Find candidate state/status files. Search the active worktree's
#    docs/masterplan/ and legacy plans/ dir, plus sibling linked worktrees.
#    Necessary because a Claude session can run from the main worktree while
#    the active /masterplan plan lives in .worktrees/<feature>/ (e.g.,
#    optoe-ng's project-review pattern). Without this fan-out the hook bails
#    silently and the user sees zero telemetry for worktree-resident plans.
candidates=()
[[ -d "$worktree/docs/masterplan" ]] && candidates+=("$worktree/docs/masterplan")
[[ -d "$worktree/docs/superpowers/plans" ]] && candidates+=("$worktree/docs/superpowers/plans")
if [[ -d "$worktree/.worktrees" ]]; then
  # Only fan out into directories that look like real git worktrees (have a
  # `.git` file or directory). Stray directories under .worktrees/ — backups,
  # unpacked archives, scratch dirs — would otherwise add bogus candidate
  # plans/ paths and could (in pathological cases where a stray dir contains
  # a *-status.md file by name coincidence) end up selected.
  while IFS= read -r wt; do
    [[ -e "$wt/.git" ]] || continue
    plans="$wt/docs/superpowers/plans"
    runs="$wt/docs/masterplan"
    [[ -d "$runs" ]] && candidates+=("$runs")
    [[ -d "$plans" ]] && candidates+=("$plans")
  done < <(find "$worktree/.worktrees" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
fi
[[ ${#candidates[@]} -gt 0 ]] || bail

# 3b. Score every candidate state/status file. Preference order:
#     (a) worktree: field matches `git rev-parse --show-toplevel` exactly OR
#         current $PWD has the worktree: field as a path prefix
#         (handles subdirectory invocations).
#     (b) branch: field matches current branch.
#     Among matches, pick the most-recently-modified file (deterministic when
#     multiple plans share a branch — common in single-trunk workflows where
#     every status file carries `branch: main`).
status_file=""
best_mtime=0
pwd_path="${PWD%/}"
for d in "${candidates[@]}"; do
  while IFS= read -r -d '' f; do
    if [[ "$(basename "$f")" == "state.yml" ]]; then
      fm_worktree=$(awk '/^worktree:/{sub(/^worktree:[[:space:]]*/,""); print; exit}' "$f" 2>/dev/null)
      fm_branch=$(awk '/^branch:/{sub(/^branch:[[:space:]]*/,""); print; exit}' "$f" 2>/dev/null)
    else
      fm_worktree=$(awk '/^---$/{c++; next} c==1 && /^worktree:/{sub(/^worktree:[[:space:]]*/,""); print; exit}' "$f" 2>/dev/null)
      fm_branch=$(awk '/^---$/{c++; next} c==1 && /^branch:/{sub(/^branch:[[:space:]]*/,""); print; exit}' "$f" 2>/dev/null)
    fi
    fm_worktree="${fm_worktree%/}"
    matches=0
    if [[ -n "$fm_worktree" ]]; then
      [[ "$fm_worktree" == "$worktree" ]] && matches=1
      [[ "$pwd_path" == "$fm_worktree"* ]] && matches=1
    fi
    [[ "$fm_branch" == "$branch" ]] && matches=1
    [[ "$matches" -eq 1 ]] || continue
    f_mtime=$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null || echo 0)
    if (( f_mtime > best_mtime )); then
      best_mtime=$f_mtime
      status_file="$f"
    fi
  done < <(find "$d" \( -path '*/state.yml' -o -name '*-status.md' \) -print0 2>/dev/null)
done

[[ -n "$status_file" ]] || bail

# 3c. Re-anchor plans_dir to the chosen state/status file's directory (sidecar
#     telemetry/subagent JSONLs land alongside it, NOT under the active
#     worktree if that's a different worktree).
plans_dir="$(dirname "$status_file")"
is_bundle=0
if [[ "$(basename "$status_file")" == "state.yml" ]]; then
  is_bundle=1
fi

# 4. Per-plan opt-out: `telemetry: off`.
if [[ "$is_bundle" -eq 1 ]]; then
  opt_out=$(awk '/^telemetry:[[:space:]]*off/{print "off"; exit}' "$status_file" 2>/dev/null)
else
  opt_out=$(awk '/^---$/{c++; next} c==1 && /^telemetry:[[:space:]]*off/{print "off"; exit}' "$status_file" 2>/dev/null)
fi
[[ "$opt_out" == "off" ]] && bail

# 5. Resolve transcript path. Prefer $CLAUDE_SESSION_ID; fall back to most-recent jsonl.
transcript=""
if [[ -n "${CLAUDE_SESSION_ID:-}" ]]; then
  # Search across project session dirs for a file matching the session id.
  # Use `head -n1` instead of GNU find's `-print -quit` (BSD find on macOS does not support -quit).
  transcript=$(find "$HOME/.claude/projects" -maxdepth 3 -name "${CLAUDE_SESSION_ID}*.jsonl" 2>/dev/null | head -n1)
fi
if [[ -z "$transcript" ]]; then
  # Best-effort fallback: most-recently-modified session jsonl across all projects.
  # GNU find's `-printf '%T@ %p\n'` is not available on macOS BSD find; iterate with stat and try
  # GNU `stat -c '%Y'` first, falling back to BSD `stat -f '%m'`.
  transcript=$(find "$HOME/.claude/projects" -maxdepth 3 -type f -name '*.jsonl' 2>/dev/null | \
    while IFS= read -r f; do
      mtime=$(stat -c '%Y' "$f" 2>/dev/null || stat -f '%m' "$f" 2>/dev/null)
      [[ -n "$mtime" ]] && printf '%s %s\n' "$mtime" "$f"
    done | sort -nr | head -n1 | cut -d' ' -f2-)
fi

# 6. Compute signal fields. Tolerate missing transcript (degraded record still useful).
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [[ "$is_bundle" -eq 1 ]]; then
  slug=$(basename "$plans_dir")
else
  slug=$(basename "$status_file" -status.md)
fi
status_bytes=$(wc -c <"$status_file" 2>/dev/null | tr -d ' ')
if [[ "$is_bundle" -eq 1 ]]; then
  activity_log_entries=$(wc -l <"${plans_dir}/events.jsonl" 2>/dev/null | tr -d ' ')
else
  activity_log_entries=$(awk '/^## Activity log/{in_log=1; next} /^## /{in_log=0} in_log && /^- /{c++} END{print c+0}' "$status_file" 2>/dev/null)
fi
ensure_telemetry_excluded || bail
# GNU `date -d` first, then BSD `date -v` fallback. If both fail (e.g., a stripped
# musl-libc container without either form), use a sentinel that produces zero
# matches — over-counting every wakeup ever recorded would silently misrepresent
# loop activity.
cutoff=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-24H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
[[ -n "$cutoff" ]] || cutoff="9999-12-31T23:59:59Z"
wakeup_count_24h=$(awk -v cutoff="$cutoff" '
  /^## Wakeup ledger/{in_w=1; next} /^## /{in_w=0}
  in_w && /^- / { ts=$2; if (ts > cutoff) c++ }
  END{print c+0}' "$status_file" 2>/dev/null)
if [[ "$is_bundle" -eq 1 ]]; then
  wakeup_count_24h=0
fi

if [[ -n "$transcript" && -f "$transcript" ]]; then
  transcript_bytes=$(wc -c <"$transcript" 2>/dev/null | tr -d ' ')
  transcript_lines=$(wc -l <"$transcript" 2>/dev/null | tr -d ' ')
else
  transcript_bytes=0
  transcript_lines=0
fi

# 7. Append JSONL record.
# Lands inside the v3 bundle or beside the legacy status file.
if [[ "$is_bundle" -eq 1 ]]; then
  out_file="${plans_dir}/telemetry.jsonl"
else
  out_file="${plans_dir}/${slug}-telemetry.jsonl"
fi

# tasks_completed_this_turn (v2.0.0+) — delta of activity_log_entries between
# this and the previous Stop record. First-turn caveat: when no previous record
# exists, reports 0 (no baseline to subtract; first-record telemetry can't
# distinguish "this turn's work" from "all entries accumulated pre-telemetry").
# Activity log rotation can decrement; clamp negatives to 0.
if [[ -f "$out_file" ]]; then
  prev_entries=$(tail -n1 "$out_file" 2>/dev/null | jq -r '.activity_log_entries // 0' 2>/dev/null || echo 0)
  tasks_completed_this_turn=$(( activity_log_entries - prev_entries ))
  [[ $tasks_completed_this_turn -lt 0 ]] && tasks_completed_this_turn=0
else
  tasks_completed_this_turn=0
fi

# wave_groups (v2.0.0+) — array of distinct [wave: <group>] tags from the last
# tasks_completed_this_turn activity/event entries. Empty for serial-only turns.
# Extracted via awk + grep (portable; gawk's match()-with-array is not available
# under mawk / BSD awk).
if [[ $tasks_completed_this_turn -gt 0 ]]; then
  if [[ "$is_bundle" -eq 1 ]]; then
    wave_groups_raw=$(tail -n "$tasks_completed_this_turn" "${plans_dir}/events.jsonl" 2>/dev/null \
      | grep -oE '\[wave: [^]]+\]' \
      | sed -E 's|\[wave: (.*)\]|\1|' \
      | sort -u)
  else
    wave_groups_raw=$(awk '/^## Activity log/{in_log=1; next} /^## /{in_log=0} in_log && /^- /{print}' "$status_file" 2>/dev/null \
      | tail -n "$tasks_completed_this_turn" \
      | grep -oE '\[wave: [^]]+\]' \
      | sed -E 's|\[wave: (.*)\]|\1|' \
      | sort -u)
  fi
  if [[ -n "$wave_groups_raw" ]]; then
    wave_groups_json=$(echo "$wave_groups_raw" | jq -R . | jq -sc .)
  else
    wave_groups_json="[]"
  fi
else
  wave_groups_json="[]"
fi

_do_append_telemetry() {
  jq -nc \
    --arg ts "$ts" \
    --arg plan "$slug" \
    --arg branch "$branch" \
    --arg cwd "$PWD" \
    --argjson transcript_bytes "${transcript_bytes:-0}" \
    --argjson transcript_lines "${transcript_lines:-0}" \
    --argjson status_bytes "${status_bytes:-0}" \
    --argjson activity_log_entries "${activity_log_entries:-0}" \
    --argjson tasks_completed_this_turn "${tasks_completed_this_turn:-0}" \
    --argjson wave_groups "${wave_groups_json}" \
    --argjson wakeup_count_24h "${wakeup_count_24h:-0}" \
    --argjson claude_stop_hook_active "${claude_stop_hook_active:-false}" \
    '{ts:$ts,plan:$plan,turn_kind:"stop",transcript_bytes:$transcript_bytes,transcript_lines:$transcript_lines,status_bytes:$status_bytes,activity_log_entries:$activity_log_entries,wakeup_count_24h:$wakeup_count_24h,tasks_completed_this_turn:$tasks_completed_this_turn,wave_groups:$wave_groups,claude_stop_hook_active:$claude_stop_hook_active,branch:$branch,cwd:$cwd}' \
    >> "$out_file" 2>/dev/null
}
if [[ "$is_bundle" -eq 1 ]]; then
  with_bundle_lock "$plans_dir" _do_append_telemetry || true
else
  _do_append_telemetry
fi

emit_parent_turns() {
  [[ -n "$transcript" && -r "$transcript" ]] || return 0
  [[ -n "${subagents_file:-}" ]] || return 0

  jq -c \
    --arg plan "$slug" \
    --arg branch "$branch" \
    --arg cwd "$PWD" \
    --arg sid "${CLAUDE_SESSION_ID:-}" \
    '
    select(.type == "assistant" and ((.message.usage // null) != null))
    | {
        ts: (.timestamp // null),
        type: "parent_turn",
        plan: $plan,
        session_id: (.sessionId // $sid),
        model: (.message.model // null),
        usage: .message.usage,
        branch: $branch,
        cwd: $cwd
      }
    ' "$transcript" >> "$subagents_file" 2>/dev/null
}

# 8. Subagent dispatch capture (v2.3.0+; v2.4.0 reworked to agent_id dedup).
#
# Parse the parent session transcript for Agent tool_use + toolUseResult pairs.
# Emit one record per subagent dispatch to <plan>-subagents.jsonl, deduped by
# agentId (every Agent dispatch carries a unique 16-byte hex ID in the result
# message's toolUseResult.agentId field — collisions would require a hash
# collision across the random ID space).
#
# Why dedup by agent_id (replaces the v2.3.0 line-cursor approach):
# - Cursor was plan-keyed, not transcript-keyed: when /masterplan ran across
#   multiple Claude sessions for the same plan, the cursor advanced past line
#   N of session-1's transcript, and session-2's transcript would start being
#   processed from line N — silently skipping its first N lines including
#   typically the first few dispatches.
# - Cursor at end-of-transcript meant zero new processing every turn even in
#   the same session unless new content landed *between* the dispatch and the
#   stop hook firing; this routinely produced 0-line subagents.jsonl files
#   for plans that obviously dispatched many subagents.
# - agent_id dedup is O(N) in transcript length per turn but correct across
#   sessions, transcript rotation, hook reinstalls, and resume after compaction.
#   Typical transcript is 1K-50K lines; the cost is negligible vs the hook's
#   3-second timeout.
#
# Adds routing_class field (Fix 5 telemetry-side observability):
#   "codex"   -> subagent_type starts with "codex:"
#   "sdd"     -> subagent_type contains "subagent-driven-development"
#   "explore" -> subagent_type == "Explore"
#   "general" -> everything else
# Lets downstream queries do `grep '"routing_class":"codex"'` for codex-routing
# distribution without re-parsing prompts.
#
# Bail conditions (subagent capture only — does NOT bail the per-turn record above):
# - no transcript path resolved
# - transcript file unreadable
if [[ -n "$transcript" && -r "$transcript" ]]; then
  if [[ "$is_bundle" -eq 1 ]]; then
    subagents_file="${plans_dir}/subagents.jsonl"
  else
    subagents_file="${plans_dir}/${slug}-subagents.jsonl"
  fi

  if [[ "$is_bundle" -eq 1 ]]; then
    with_bundle_lock "$plans_dir" emit_parent_turns || true
  else
    emit_parent_turns
  fi

  # Build seen-agent-id set from existing subagents.jsonl (one ID per line).
  # Empty file or missing file -> empty set.
  if [[ -s "$subagents_file" ]]; then
    seen_ids_json=$(jq -sc '[.[].agent_id // empty] | unique' "$subagents_file" 2>/dev/null || echo '[]')
  else
    seen_ids_json='[]'
  fi
  [[ -z "$seen_ids_json" ]] && seen_ids_json='[]'

  _do_append_subagents() {
  jq -c -s \
    --argjson seen "$seen_ids_json" \
    --arg plan "$slug" \
    --arg branch "$branch" \
    --arg cwd "$PWD" \
    --arg sid "${CLAUDE_SESSION_ID:-}" \
    '
    . as $all
    | ($seen | map({(.):true}) | add // {}) as $seen_set
    | (
        [ $all[]
          | select(.type == "assistant")
          | .timestamp as $ts
          | (.message.content // [])[]?
          | select(.type == "tool_use" and (.name == "Agent" or .name == "Task"))
          | { (.id): {
                model: (.input.model // null),
                subagent_type: (.input.subagent_type // null),
                description: (.input.description // ""),
                dispatched_at: $ts
              }}
        ]
        | add // {}
      ) as $idx
    | $all[]
    | select(.type == "user" and ((.toolUseResult.agentId // null) != null))
    | select(($seen_set[.toolUseResult.agentId] // false) | not)
    | (
        [ (.message.content // [])[]?
          | select(.type == "tool_result")
          | .tool_use_id ]
        | first // null
      ) as $tuid
    | ($idx[$tuid] // {}) as $tu
    | .toolUseResult as $r
    | (($tu.subagent_type // $r.agentType // "") | tostring) as $stype
    | (
        if   ($stype | startswith("codex:"))                   then "codex"
        elif ($stype | contains("subagent-driven-development")) then "sdd"
        elif ($stype == "Explore")                              then "explore"
        else "general" end
      ) as $routing_class
    | {
        ts: (.timestamp // null),
        type: "subagent_turn",
        plan: $plan,
        session_id: (.sessionId // $sid),
        tool_use_id: $tuid,
        agent_id: ($r.agentId // null),
        subagent_type: ($tu.subagent_type // $r.agentType // null),
        routing_class: $routing_class,
        model: ($tu.model // null),
        description: ($tu.description // ""),
        dispatch_site: (
          try (
            ($r.prompt // "")
            | match("DISPATCH-SITE:[ \\t]*([^\\n]+)")
            | .captures[0].string
          ) // null
        ),
        status: ($r.status // null),
        prompt_chars: (($r.prompt // "") | length),
        prompt_first_line: (($r.prompt // "") | split("\n")[0] | .[0:200]),
        duration_ms: ($r.totalDurationMs // 0),
        total_tokens: ($r.totalTokens // 0),
        input_tokens: ($r.usage.input_tokens // 0),
        output_tokens: ($r.usage.output_tokens // 0),
        cache_creation_tokens: ($r.usage.cache_creation_input_tokens // 0),
        cache_read_tokens: ($r.usage.cache_read_input_tokens // 0),
        tool_uses_in_subagent: ($r.totalToolUseCount // 0),
        tool_stats: {
          bash: ($r.toolStats.bashCount // 0),
          edit: ($r.toolStats.editFileCount // 0),
          read: ($r.toolStats.readCount // 0),
          search: ($r.toolStats.searchCount // 0),
          other: ($r.toolStats.otherToolCount // 0),
          lines_added: ($r.toolStats.linesAdded // 0),
          lines_removed: ($r.toolStats.linesRemoved // 0)
        },
        result_chars: (
          ($r.content // null)
          | if type == "string" then length
            elif type == "array" then map(.text // "") | join("") | length
            else 0 end
        ),
        branch: $branch,
        cwd: $cwd
      }
    ' "$transcript" >> "$subagents_file" 2>/dev/null
}
  if [[ "$is_bundle" -eq 1 ]]; then
    with_bundle_lock "$plans_dir" _do_append_subagents || true
  else
    _do_append_subagents
  fi
fi

# ============================================================================
# 9. Failure-instrumentation framework (v5.1.0+; spec: parts/failure-classes.md).
# ============================================================================
#
# Six anomaly classes, each with a detector. Each anomaly record is written to
# <run-dir>/anomalies.jsonl (canonical) FIRST. Then a stable signature is
# computed and `gh` is invoked to file/comment/reopen a GitHub issue against
# `rasatpetabit/superpowers-masterplan`. On `gh` failure (no auth, rate limit,
# network), the record is duplicated to
# <run-dir>/anomalies-pending-upload.jsonl for later drain via
# bin/masterplan-anomaly-flush.sh.
#
# Detector framework defenses:
#   - Each detector runs in `set +e` with a trap; any non-zero from a detector
#     is logged to ~/.claude/projects/.../hook-errors.log (NOT stderr — bail
#     silently per the global hook contract).
#   - Local-first persistence: anomalies.jsonl is the source of truth; GitHub
#     is a mirror.
#   - The smoke test (bin/masterplan-anomaly-smoke.sh) exercises every class
#     against synthetic transcripts.
#
# Bail conditions (the framework as a whole):
#   - No transcript readable → cannot inspect breadcrumbs → bail silently.
#   - failure_reporting disabled in .masterplan.yaml (dry_run mode still
#     writes locally; only the gh step is skipped).
#   - The current turn has no <masterplan-trace step=…> breadcrumbs at all
#     (likely the orchestrator is not actively running /masterplan this turn).

[[ -n "$transcript" && -r "$transcript" ]] || exit 0

# Resolve framework config from .masterplan.yaml if present.
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

[[ "$fr_enabled" == "true" ]] || exit 0

# Hook-internal error log.
hook_err_log="$HOME/.claude/projects/-home-ras-dev-superpowers-masterplan/hook-errors.log"
mkdir -p "$(dirname "$hook_err_log")" 2>/dev/null

log_detector_error() {
  local detector="$1" msg="$2"
  printf '%s\t%s\t%s\t%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$slug" "$detector" "$msg" \
    >> "$hook_err_log" 2>/dev/null
}

# Anomaly sidecar paths (always alongside the resolved state file's dir).
anomalies_file="${plans_dir}/anomalies.jsonl"
pending_file="${plans_dir}/anomalies-pending-upload.jsonl"

# Extract this turn's breadcrumb stream from the transcript.
# Markers live in assistant message text content. We grep all
# <masterplan-trace ...> markers from the LAST assistant turn boundary
# onwards (loosely: the transcript tail since the previous Stop hook).
# Bound the tail to the last 200 transcript records to keep this cheap.
turn_breadcrumbs=$(
  tail -n 200 "$transcript" 2>/dev/null \
    | jq -r 'select(.type=="assistant") | (.message.content // [])[]? | select(.type=="text") | .text' 2>/dev/null \
    | grep -oE '<masterplan-trace [^>]+>' 2>/dev/null
)

# If no breadcrumbs found at all, the orchestrator did not run /masterplan
# this turn. Nothing to detect.
[[ -n "$turn_breadcrumbs" ]] || exit 0

# Extract context fields used by all detectors.
last_step=$(echo "$turn_breadcrumbs" | grep -oE 'step=[a-z0-9-]+' | tail -n1 | cut -d= -f2)
[[ -z "$last_step" ]] && last_step="unknown"

last_verb=$(echo "$turn_breadcrumbs" | grep -oE 'verb=[a-z]+' | tail -n1 | cut -d= -f2)
[[ -z "$last_verb" ]] && last_verb="unknown"

last_halt=$(echo "$turn_breadcrumbs" | grep -oE 'halt_mode=[a-z-]+' | tail -n1 | cut -d= -f2)
[[ -z "$last_halt" ]] && last_halt="none"

last_autonomy=$(echo "$turn_breadcrumbs" | grep -oE 'autonomy=[a-z]+' | tail -n1 | cut -d= -f2)
[[ -z "$last_autonomy" ]] && last_autonomy="loose"

# State-file reads (bundle only — legacy status not yet covered).
state_phase=""
state_pending_gate=""
state_status=""
if [[ "$is_bundle" -eq 1 ]]; then
  state_phase=$(awk '/^phase:/{sub(/^phase:[[:space:]]*/,""); print; exit}' "$status_file" 2>/dev/null)
  state_pending_gate=$(awk '/^pending_gate:/{in_pg=1; next} in_pg && /^  id:/{sub(/^  id:[[:space:]]*/,""); print; exit} /^[^ ]/{in_pg=0}' "$status_file" 2>/dev/null)
  state_status=$(awk '/^status:/{sub(/^status:[[:space:]]*/,""); print; exit}' "$status_file" 2>/dev/null)
fi

events_tail_json="[]"
if [[ "$is_bundle" -eq 1 && -f "${plans_dir}/events.jsonl" ]]; then
  events_tail_json=$(tail -n 5 "${plans_dir}/events.jsonl" 2>/dev/null | jq -sc '.' 2>/dev/null || echo '[]')
fi
[[ -z "$events_tail_json" ]] && events_tail_json="[]"

# Plugin version (for the issue body).
plugin_version=""
if [[ -f "$worktree/.claude-plugin/plugin.json" ]]; then
  plugin_version=$(jq -r '.version // "unknown"' "$worktree/.claude-plugin/plugin.json" 2>/dev/null)
fi

# Compute SHA1 signature: class|step|verb|halt_mode|autonomy|skill_or_gate
compute_signature() {
  local class="$1" extra="$2"
  printf '%s|%s|%s|%s|%s|%s' \
    "$class" "$last_step" "$last_verb" "$last_halt" "$last_autonomy" "${extra:-none}" \
    | sha1sum 2>/dev/null | awk '{print $1}'
}

# Append one anomaly record to anomalies.jsonl (local-first).
write_anomaly_record() {
  local class="$1" sig="$2" expected="$3" observed="$4" extra_field="$5" extra_value="$6"
  local rec
  rec=$(jq -nc \
    --arg ts "$ts" \
    --arg slug "$slug" \
    --arg sid "${CLAUDE_SESSION_ID:-}" \
    --arg host "claude-code" \
    --arg class "$class" \
    --arg sig "$sig" \
    --arg last_step "$last_step" \
    --arg verb "$last_verb" \
    --arg halt_mode "$last_halt" \
    --arg autonomy "$last_autonomy" \
    --arg phase "${state_phase:-}" \
    --arg status "${state_status:-}" \
    --arg expected "$expected" \
    --arg observed "$observed" \
    --argjson events_tail "$events_tail_json" \
    --arg breadcrumbs "$turn_breadcrumbs" \
    --arg plugin_version "${plugin_version:-unknown}" \
    --arg extra_field "$extra_field" \
    --arg extra_value "$extra_value" \
    '{
      ts:$ts, plan_slug:$slug, session_id:$sid, host:$host,
      anomaly_class:$class, signature:$sig,
      last_step:$last_step, verb:$verb, halt_mode:$halt_mode, autonomy:$autonomy,
      state_phase:$phase, state_status:$status,
      expected_behavior:$expected, observed_behavior:$observed,
      events_tail:$events_tail,
      step_trace_in_turn:($breadcrumbs|split("\n")|map(select(length>0))),
      plugin_version:$plugin_version
    } + (if $extra_field != "" then {($extra_field):$extra_value} else {} end)' 2>/dev/null)
  if [[ -n "$rec" ]]; then
    if [[ "$is_bundle" -eq 1 ]]; then
      _do_append_anomaly() { echo "$rec" >> "$anomalies_file" 2>/dev/null; }
      with_bundle_lock "$plans_dir" _do_append_anomaly || true
    else
      echo "$rec" >> "$anomalies_file" 2>/dev/null
    fi
    echo "$rec"
  fi
}

# Try gh: list issues for [auto:<sig>], then create/comment/reopen.
# On any gh failure, append the record to pending-upload.
file_or_update_issue() {
  local class="$1" sig="$2" rec="$3"
  local title_prefix="[auto:${sig:0:12}]"
  local issue_title="${title_prefix} ${class}: ${last_step} ${last_verb}"

  # Helper: queue rec to pending_file, serialized when in a bundle dir.
  _queue_pending() {
    if [[ "$is_bundle" -eq 1 ]]; then
      _do_write_pending() { echo "$rec" >> "$pending_file" 2>/dev/null; }
      with_bundle_lock "$plans_dir" _do_write_pending || true
    else
      echo "$rec" >> "$pending_file" 2>/dev/null
    fi
  }

  if [[ "$fr_dry_run" == "true" ]]; then
    return 0
  fi

  command -v gh >/dev/null 2>&1 || {
    _queue_pending
    log_detector_error "gh-missing" "gh not installed — record queued"
    return 0
  }

  local existing
  existing=$(gh issue list --repo "$fr_repo" \
    --search "in:title ${title_prefix}" \
    --state all --json number,state,title --limit 5 2>/dev/null) || {
    _queue_pending
    log_detector_error "gh-list-failed" "queued for retry"
    return 0
  }

  local existing_num existing_state
  existing_num=$(echo "$existing" | jq -r '.[0].number // empty' 2>/dev/null)
  existing_state=$(echo "$existing" | jq -r '.[0].state // empty' 2>/dev/null)

  local body
  body=$(printf '## Auto-filed anomaly\n\n**Class:** %s\n**Signature:** `%s`\n**Last step:** %s\n**Verb:** %s\n**halt_mode:** %s\n**autonomy:** %s\n**state.phase:** %s\n**state.status:** %s\n**plugin_version:** %s\n\n### Record\n\n```json\n%s\n```\n' \
    "$class" "$sig" "$last_step" "$last_verb" "$last_halt" "$last_autonomy" \
    "${state_phase:-}" "${state_status:-}" "${plugin_version:-unknown}" "$rec")

  if [[ -z "$existing_num" ]]; then
    gh issue create --repo "$fr_repo" \
      --title "$issue_title" \
      --label "auto-filed" --label "class/${class}" \
      --body "$body" >/dev/null 2>&1 || {
        _queue_pending
        log_detector_error "gh-create-failed" "queued"
      }
  elif [[ "$existing_state" == "CLOSED" ]]; then
    gh issue reopen "$existing_num" --repo "$fr_repo" \
      --comment "Regression at ${ts}: same signature reopened. New record:
${body}" >/dev/null 2>&1 || {
        _queue_pending
        log_detector_error "gh-reopen-failed" "queued"
      }
  else
    gh issue comment "$existing_num" --repo "$fr_repo" \
      --body "Recurrence at ${ts}.

${body}" >/dev/null 2>&1 || {
        _queue_pending
        log_detector_error "gh-comment-failed" "queued"
      }
  fi
}

fire_anomaly() {
  local class="$1" expected="$2" observed="$3" extra_field="$4" extra_value="$5"
  local sig rec
  sig=$(compute_signature "$class" "$extra_value")
  [[ -n "$sig" ]] || { log_detector_error "$class" "signature-compute-failed"; return; }
  rec=$(write_anomaly_record "$class" "$sig" "$expected" "$observed" "$extra_field" "$extra_value")
  [[ -n "$rec" ]] || { log_detector_error "$class" "record-write-failed"; return; }
  file_or_update_issue "$class" "$sig" "$rec"
}

# --- Detector 1: silent-stop-after-skill ---
detect_silent_stop_after_skill() {
  local last_return post_count
  last_return=$(echo "$turn_breadcrumbs" | grep 'skill-return' | tail -n1)
  [[ -n "$last_return" ]] || return 0
  post_count=$(echo "$turn_breadcrumbs" | awk -v anchor="$last_return" 'found{print} index($0,anchor){found=1}' \
    | grep -cE 'step=|state-write|gate=fire')
  if [[ "$post_count" -eq 0 ]]; then
    local skill_name
    skill_name=$(echo "$last_return" | grep -oE 'name=[a-z-]+' | cut -d= -f2)
    fire_anomaly "silent-stop-after-skill" \
      "After ${skill_name} returns: continue orchestrator work, write state, or fire gate" \
      "Turn ended after ${skill_name} skill-return marker with no subsequent breadcrumbs" \
      "skill_name" "${skill_name:-unknown}"
  fi
}

# --- Detector 2: unexpected-halt ---
detect_unexpected_halt() {
  [[ -n "$state_pending_gate" ]] || return 0
  local fired
  fired=$(echo "$turn_breadcrumbs" | grep -cE "gate=fire id=$state_pending_gate")
  [[ "$fired" -gt 0 ]] && return 0
  # Auto-proceed was expected if autonomy=loose+halt_mode=none, or autonomy=full.
  local auto_expected="no"
  if [[ "$last_autonomy" == "full" ]]; then auto_expected="yes"; fi
  if [[ "$last_autonomy" == "loose" && "$last_halt" == "none" ]]; then auto_expected="yes"; fi
  if [[ "$auto_expected" == "yes" ]]; then
    fire_anomaly "unexpected-halt" \
      "Under autonomy=${last_autonomy} halt_mode=${last_halt}: auto-proceed without raising a gate" \
      "pending_gate=${state_pending_gate} but no gate=fire breadcrumb this turn" \
      "pending_gate_id" "$state_pending_gate"
  fi
}

# --- Detector 3: state-mutation-dropped ---
detect_state_mutation_dropped() {
  case "$state_phase" in
    planning|executing|importing|brainstorming) ;;
    *) return 0 ;;
  esac
  local state_writes
  state_writes=$(echo "$turn_breadcrumbs" | grep -cE 'state-write field=phase')
  [[ "$state_writes" -gt 0 ]] && return 0
  [[ -n "$state_pending_gate" ]] && return 0
  # Need ≥1 substantive activity. Use tasks_completed_this_turn proxy + transcript line delta.
  local substantive="no"
  [[ "$tasks_completed_this_turn" -gt 0 ]] && substantive="yes"
  echo "$turn_breadcrumbs" | grep -q 'skill-invoke' && substantive="yes"
  [[ "$substantive" == "yes" ]] || return 0
  fire_anomaly "state-mutation-dropped" \
    "phase=${state_phase}: any substantive turn must end with a state-write or pending_gate" \
    "Turn had skill-invoke or completed tasks but no state-write breadcrumb and no pending_gate" \
    "phase_at_turn_start" "$state_phase"
}

# --- Detector 4: orphan-pending-gate ---
detect_orphan_pending_gate() {
  [[ -n "$state_pending_gate" ]] || return 0
  # Look for any AskUserQuestion tool_use in this turn's transcript tail.
  local auq_count
  auq_count=$(tail -n 200 "$transcript" 2>/dev/null \
    | jq -r 'select(.type=="assistant") | (.message.content // [])[]? | select(.type=="tool_use" and .name=="AskUserQuestion")' 2>/dev/null \
    | wc -l)
  [[ "$auq_count" -gt 0 ]] && return 0
  fire_anomaly "orphan-pending-gate" \
    "pending_gate set ⇒ AskUserQuestion must render this turn" \
    "pending_gate=${state_pending_gate} but no AskUserQuestion tool_use in transcript tail" \
    "pending_gate_id" "$state_pending_gate"
}

# --- Detector 5: step-trace-gap ---
detect_step_trace_gap() {
  local ins outs orphan
  ins=$(echo "$turn_breadcrumbs" | grep -oE 'step=[a-z0-9-]+[[:space:]]+phase=in' | awk '{print $1}' | sort -u)
  outs=$(echo "$turn_breadcrumbs" | grep -oE 'step=[a-z0-9-]+[[:space:]]+phase=out' | awk '{print $1}' | sort -u)
  for s in $ins; do
    if ! echo "$outs" | grep -q "^$s$"; then
      orphan="${s#step=}"
      fire_anomaly "step-trace-gap" \
        "Every step=${orphan} phase=in must have a matching phase=out before turn end" \
        "step=${orphan} phase=in emitted but no matching phase=out before turn end" \
        "orphan_step" "$orphan"
    fi
  done
}

# --- Detector 6: verification-failure-uncited ---
# This is a two-turn class — we record a candidate now; the next turn's run
# confirms or clears via the same code path.
detect_verification_failure_uncited() {
  [[ "$is_bundle" -eq 1 && -f "${plans_dir}/events.jsonl" ]] || return 0
  local fail_count
  fail_count=$(tail -n 10 "${plans_dir}/events.jsonl" 2>/dev/null \
    | jq -rc 'select((.event // "") | test("verify_")) | select((.result // "") == "failed")' 2>/dev/null \
    | wc -l)
  [[ "$fail_count" -gt 0 ]] || return 0
  # Did this turn also write a phase-forward? If so, the failure was uncited.
  local advanced
  advanced=$(echo "$turn_breadcrumbs" | grep -cE 'state-write field=phase from=(executing|verifying) to=(complete|verifying|archived)')
  [[ "$advanced" -gt 0 ]] || return 0
  fire_anomaly "verification-failure-uncited" \
    "Verification failure must be acknowledged via remediation event before phase advance" \
    "events.jsonl tail has verify_* result=failed but phase advanced this turn without remediation" \
    "advance_count" "$advanced"
}

# Run every detector under set +e + log on error. Each is independent.
detector_dispatch() {
  for fn in detect_silent_stop_after_skill detect_unexpected_halt \
            detect_state_mutation_dropped detect_orphan_pending_gate \
            detect_step_trace_gap detect_verification_failure_uncited; do
    set +e
    ( $fn ) || log_detector_error "$fn" "non-zero-exit"
    set -e
  done
  set +e
}

detector_dispatch

exit 0
