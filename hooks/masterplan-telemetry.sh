#!/usr/bin/env bash
# masterplan-telemetry.sh — Stop hook for /masterplan context-usage telemetry.
#
# Defensive: bails silently in any session that isn't operating on a
# /masterplan-managed plan. Safe to wire as a global Stop hook in
# ~/.claude/settings.json.
#
# Append one JSONL record per turn to <plan>-telemetry.jsonl (sibling to
# the status file). Per-plan opt-out: add `telemetry: off` to status
# frontmatter.
#
# Required: bash, jq, git, awk. Optional: $CLAUDE_SESSION_ID for
# transcript-resolution accuracy.
#
# License: MIT (matches parent plugin).

set -u

# --- Bail-silent helper ---
bail() { exit 0; }

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
      printf '# END MASTERPLAN TELEMETRY IGNORE\n'
    } >> "$exclude_file" 2>/dev/null || return 1
  fi

  for rel in \
    "docs/superpowers/plans/${slug}-telemetry.jsonl" \
    "docs/superpowers/plans/${slug}-subagents.jsonl" \
    "docs/superpowers/plans/${slug}-subagents-cursor"; do
    git ls-files --error-unmatch -- "$rel" >/dev/null 2>&1 && return 1
    git check-ignore -q --no-index -- "$rel" 2>/dev/null || return 1
  done
}

# 0. Required tool guard. If jq is missing, the JSONL append at step 7 would
# silently produce nothing forever — bail explicitly so the user notices via
# the absence rather than via gradually-empty telemetry files.
command -v jq >/dev/null 2>&1 || bail

# 1. Must be inside a git work tree.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || bail
worktree=$(git rev-parse --show-toplevel 2>/dev/null) || bail

# 2. Resolve current branch.
branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || bail
[[ -n "$branch" && "$branch" != "HEAD" ]] || bail

# 3. Find candidate status files. Search the active worktree's plans/ dir AND
#    every sibling linked worktree under .worktrees/*/docs/superpowers/plans/.
#    Necessary because a Claude session can run from the main worktree while
#    the active /masterplan plan lives in .worktrees/<feature>/ (e.g.,
#    optoe-ng's project-review pattern). Without this fan-out the hook bails
#    silently and the user sees zero telemetry for worktree-resident plans.
candidates=()
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
    [[ -d "$plans" ]] && candidates+=("$plans")
  done < <(find "$worktree/.worktrees" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)
fi
[[ ${#candidates[@]} -gt 0 ]] || bail

# 3b. Score every candidate status file. Preference order:
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
    fm_worktree=$(awk '/^---$/{c++; next} c==1 && /^worktree:/{sub(/^worktree:[[:space:]]*/,""); print; exit}' "$f" 2>/dev/null)
    fm_branch=$(awk '/^---$/{c++; next} c==1 && /^branch:/{sub(/^branch:[[:space:]]*/,""); print; exit}' "$f" 2>/dev/null)
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
  done < <(find "$d" -maxdepth 1 -name '*-status.md' -print0 2>/dev/null)
done

[[ -n "$status_file" ]] || bail

# 3c. Re-anchor plans_dir to the chosen status file's directory (sidecar
#     telemetry/subagent JSONLs land alongside it, NOT under the active
#     worktree if that's a different worktree).
plans_dir="$(dirname "$status_file")"

# 4. Per-plan opt-out: `telemetry: off` in frontmatter.
opt_out=$(awk '/^---$/{c++; next} c==1 && /^telemetry:[[:space:]]*off/{print "off"; exit}' "$status_file" 2>/dev/null)
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
slug=$(basename "$status_file" -status.md)
status_bytes=$(wc -c <"$status_file" 2>/dev/null | tr -d ' ')
activity_log_entries=$(awk '/^## Activity log/{in_log=1; next} /^## /{in_log=0} in_log && /^- /{c++} END{print c+0}' "$status_file" 2>/dev/null)
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

if [[ -n "$transcript" && -f "$transcript" ]]; then
  transcript_bytes=$(wc -c <"$transcript" 2>/dev/null | tr -d ' ')
  transcript_lines=$(wc -l <"$transcript" 2>/dev/null | tr -d ' ')
else
  transcript_bytes=0
  transcript_lines=0
fi

# 7. Append JSONL record.
# Lands at <plans_dir>/<slug>-telemetry.jsonl (sibling to the status file).
out_file="${plans_dir}/${slug}-telemetry.jsonl"

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
# tasks_completed_this_turn activity-log entries. Empty for serial-only turns.
# Extracted via awk + grep (portable; gawk's match()-with-array is not available
# under mawk / BSD awk).
if [[ $tasks_completed_this_turn -gt 0 ]]; then
  wave_groups_raw=$(awk '/^## Activity log/{in_log=1; next} /^## /{in_log=0} in_log && /^- /{print}' "$status_file" 2>/dev/null \
    | tail -n "$tasks_completed_this_turn" \
    | grep -oE '\[wave: [^]]+\]' \
    | sed -E 's|\[wave: (.*)\]|\1|' \
    | sort -u)
  if [[ -n "$wave_groups_raw" ]]; then
    wave_groups_json=$(echo "$wave_groups_raw" | jq -R . | jq -sc .)
  else
    wave_groups_json="[]"
  fi
else
  wave_groups_json="[]"
fi

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
  '{ts:$ts,plan:$plan,turn_kind:"stop",transcript_bytes:$transcript_bytes,transcript_lines:$transcript_lines,status_bytes:$status_bytes,activity_log_entries:$activity_log_entries,wakeup_count_24h:$wakeup_count_24h,tasks_completed_this_turn:$tasks_completed_this_turn,wave_groups:$wave_groups,branch:$branch,cwd:$cwd}' \
  >> "$out_file" 2>/dev/null

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
  subagents_file="${plans_dir}/${slug}-subagents.jsonl"

  # Build seen-agent-id set from existing subagents.jsonl (one ID per line).
  # Empty file or missing file -> empty set.
  if [[ -s "$subagents_file" ]]; then
    seen_ids_json=$(jq -sc '[.[].agent_id // empty] | unique' "$subagents_file" 2>/dev/null || echo '[]')
  else
    seen_ids_json='[]'
  fi
  [[ -z "$seen_ids_json" ]] && seen_ids_json='[]'

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
fi

exit 0
