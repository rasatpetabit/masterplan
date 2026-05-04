#!/usr/bin/env bash
# superflow-telemetry.sh — Stop hook for /superflow context-usage telemetry.
#
# Defensive: bails silently in any session that isn't operating on a
# /superflow-managed plan. Safe to wire as a global Stop hook in
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

# 3. Find a status file whose frontmatter `branch:` matches.
plans_dir="$worktree/docs/superpowers/plans"
[[ -d "$plans_dir" ]] || bail

status_file=""
while IFS= read -r -d '' f; do
  # Extract the branch field from the YAML frontmatter (between `---` markers).
  fm_branch=$(awk '/^---$/{c++; next} c==1 && /^branch:/{sub(/^branch:[[:space:]]*/,""); print; exit}' "$f" 2>/dev/null)
  if [[ "$fm_branch" == "$branch" ]]; then
    status_file="$f"
    break
  fi
done < <(find "$plans_dir" -maxdepth 1 -name '*-status.md' -print0 2>/dev/null)

[[ -n "$status_file" ]] || bail

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

jq -nc \
  --arg ts "$ts" \
  --arg plan "$slug" \
  --arg branch "$branch" \
  --arg cwd "$PWD" \
  --argjson transcript_bytes "${transcript_bytes:-0}" \
  --argjson transcript_lines "${transcript_lines:-0}" \
  --argjson status_bytes "${status_bytes:-0}" \
  --argjson activity_log_entries "${activity_log_entries:-0}" \
  --argjson wakeup_count_24h "${wakeup_count_24h:-0}" \
  '{ts:$ts,plan:$plan,turn_kind:"stop",transcript_bytes:$transcript_bytes,transcript_lines:$transcript_lines,status_bytes:$status_bytes,activity_log_entries:$activity_log_entries,wakeup_count_24h:$wakeup_count_24h,branch:$branch,cwd:$cwd}' \
  >> "$out_file" 2>/dev/null

exit 0
