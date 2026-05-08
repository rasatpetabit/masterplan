#!/usr/bin/env bash
# auq-guard.sh — Stop hook that warns when an assistant turn ends on a
# free-text prose question instead of routing through AskUserQuestion.
#
# Reads the JSONL transcript via $CLAUDE_TRANSCRIPT_PATH (or the JSON payload
# on stdin), identifies all assistant messages in the most recent turn,
# checks whether any of them contained an AskUserQuestion tool_use, and if
# not, scans the final text block for prose-question patterns.
#
# Non-blocking: emits a stderr warning when a violation is detected and
# exits 0. Bails silently on any error path so it never disrupts user flow.
#
# Inspired by hooks/masterplan-telemetry.sh in the same plugin.

set -u
bail() { exit 0; }

command -v jq >/dev/null 2>&1 || bail

# Read stdin JSON payload from Claude Code's Stop event.
input_json=$(cat 2>/dev/null || echo '{}')

# Resolve transcript path: env var first (Claude Code convention), then payload.
transcript_path="${CLAUDE_TRANSCRIPT_PATH:-}"
if [[ -z "$transcript_path" ]]; then
  transcript_path=$(echo "$input_json" | jq -r '.transcript_path // empty' 2>/dev/null) || bail
fi
[[ -n "$transcript_path" && -f "$transcript_path" ]] || bail

# Find the index of the last "real" user message — one whose content contains
# at least one text block. Tool results come back as type=="user" too, but
# their content is tool_result blocks; those are part of the prior turn.
last_user_idx=$(jq -s '
  [.[] | (.type == "user" and ((.message.content // []) | any(.type == "text")))]
  | (length - 1) - (reverse | index(true) // ((length - 1) | tostring | tonumber))
' "$transcript_path" 2>/dev/null)
[[ -n "$last_user_idx" && "$last_user_idx" =~ ^-?[0-9]+$ ]] || bail

# Extract every content block emitted by the assistant after that boundary.
turn_blocks=$(jq -s --argjson lui "$last_user_idx" '
  .[$lui+1:]
  | map(select(.type == "assistant"))
  | [.[].message.content[]?]
' "$transcript_path" 2>/dev/null) || bail
[[ -n "$turn_blocks" ]] || bail

# If the turn already used AskUserQuestion, there is nothing to warn about.
has_auq=$(echo "$turn_blocks" | jq 'any(.[]; .type == "tool_use" and .name == "AskUserQuestion")' 2>/dev/null)
[[ "$has_auq" == "true" ]] && bail

# Pull the final text block of the turn (the user-visible final message).
last_text=$(echo "$turn_blocks" | jq -r '[.[] | select(.type == "text") | .text] | last // ""' 2>/dev/null)
[[ -n "$last_text" ]] || bail

# Trim trailing whitespace and inspect the tail.
tail_text=$(printf '%s' "$last_text" | tail -c 600)
tail_trim=$(printf '%s' "$tail_text" | sed -E 's/[[:space:]]+$//')

violation=""

# Pattern A: ends with `?` (possibly with trailing markdown emphasis like ** or *).
if printf '%s' "$tail_trim" | tail -c 4 | grep -Eq '\?[[:space:]]*\*{0,2}[[:space:]]*$'; then
  violation="trailing '?' outside an AskUserQuestion call"
fi

# Pattern B: known prose-question phrases AND implicit-offer phrases in the
# final paragraph. The implicit-offer phrases catch declarative statements
# that offload the next decision to the user without an AUQ tool call —
# e.g. "You'll want to push and tag when ready" implies an unspoken offer.
phrases=(
  # Direct prose questions / closings
  "let me know"
  "want me to"
  "should i\b"
  "does this look right"
  "looks good\?"
  "sound good"
  "want to try"
  "please review"
  "feel free to"
  "shall i\b"
  "say 'looks good'"
  # Implicit offers / decision-offloading declaratives
  "you'?ll want to"
  "you may want to"
  "you might want to"
  "you can now"
  "you should\b"
  "ready to push"
  "ready to merge"
  "ready to deploy"
  "ready to ship"
  "ready to tag"
  "ready to release"
  "ready for review"
  "ready to proceed"
  "is ready to merge"
  "is ready to push"
  "when (you'?re )?ready"
  "next step"
  "next thing"
)
for p in "${phrases[@]}"; do
  if printf '%s' "$tail_text" | grep -Eiq "$p"; then
    if [[ -z "$violation" ]]; then
      violation="contains '$(printf '%s' "$p" | sed 's/\\b//g; s/\\?/?/g')'"
    fi
    break
  fi
done

if [[ -n "$violation" ]]; then
  printf '\n⚠ AUQ violation: turn ended on a prose question (%s) — the question must be inside an AskUserQuestion tool call. See ~/.claude/skills/auq-override/SKILL.md\n' "$violation" >&2
fi

exit 0
