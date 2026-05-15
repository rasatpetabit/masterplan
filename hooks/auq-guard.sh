#!/usr/bin/env bash
# auq-guard.sh — Stop hook that BLOCKS turn-end when a substantive assistant
# turn fails to route through AskUserQuestion. See:
# - ~/.claude/skills/auq-override/SKILL.md (rule, escape hatch, refinement)
# - ~/.claude/bin/flag-auq                  (user-driven false-negative reporting)
#
# Blocking protocol (Claude Code): emit `{"decision":"block","reason":"..."}`
# on stdout and exit 0. The `reason` is fed back to the model and the turn is
# forced to continue until it satisfies the rule (or the circuit breaker fires).
#
# References:
# - Stop-hook blocking pattern: ~/.claude/plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/skills/hook-development/references/advanced.md (lines 250-265)
# - Live blocking example:      ~/.claude/plugins/cache/claude-plugins-official/ralph-loop/1.0.0/hooks/stop-hook.sh (lines 179-191)

set -u
bail() { exit 0; }

command -v jq >/dev/null 2>&1 || bail

# ---- Inputs ----------------------------------------------------------------
input_json=$(cat 2>/dev/null || echo '{}')

transcript_path="${CLAUDE_TRANSCRIPT_PATH:-}"
if [[ -z "$transcript_path" ]]; then
  transcript_path=$(echo "$input_json" | jq -r '.transcript_path // empty' 2>/dev/null) || bail
fi
[[ -n "$transcript_path" && -f "$transcript_path" ]] || bail

session_id=$(basename "$transcript_path" .jsonl)
[[ -n "$session_id" ]] || session_id="unknown"

# ---- Find last "real" user message ----------------------------------------
# A "real" user message is one whose content is either:
#   * a bare string (the common Claude Code shape), OR
#   * an array containing at least one `text` block.
# Tool-result returns are also type=="user" but their content is a tool_result
# array — exclude those.
last_user_idx=$(jq -s '
  def is_real_user:
    .type == "user"
    and (
      (.message.content | type) == "string"
      or ((.message.content | type) == "array"
          and (.message.content | any(.type? == "text")))
    );
  [.[] | is_real_user]
  | (length - 1) - (reverse | index(true) // -1)
' "$transcript_path" 2>/dev/null)
[[ "$last_user_idx" =~ ^-?[0-9]+$ ]] || bail
[[ "$last_user_idx" -ge 0 ]] || bail

# ---- Escape hatch ---------------------------------------------------------
# If the user's most recent message contains `<no-auq>` or `[oneshot]`, exit 0
# unconditionally. Tokens are matched anywhere in the text.
last_user_text=$(jq -s -r --argjson lui "$last_user_idx" '
  def safe_array: if (.message.content | type) == "array" then .message.content else [] end;
  def text_of:
    if (.message.content | type) == "string" then .message.content
    else (safe_array | map(select(.type? == "text") | .text) | join("\n"))
    end;
  .[$lui] | text_of
' "$transcript_path" 2>/dev/null || echo "")
if printf '%s' "$last_user_text" | grep -Eiq '<no-auq>|\[oneshot\]'; then
  bail
fi

# ---- Escape hatch B: user executed a `! <cmd>` themselves ---------------
# When the user's last message contains a <bash-input> or <bash-stdout> tag,
# they ran a shell command directly via the harness's `!` prefix. The
# assistant's response is then a free-text ack/recap; forcing an AUQ creates
# dialog-cycle noise after work the user already performed.
if printf '%s' "$last_user_text" | grep -Eq '<bash-input>|<bash-stdout>'; then
  bail
fi

# ---- Escape hatch C: last tool_result was a classifier denial -----------
# When a tool call was denied by the Claude Code auto-mode classifier, the
# natural recovery is free-text ("the command was blocked; run it via `!` or
# add a permission rule") — not another AUQ choreography turn. Detect by
# scanning the most recent tool_result content in this turn.
last_tool_result=$(jq -s --argjson lui "$last_user_idx" '
  def text_of:
    if (.content | type) == "string" then .content
    elif (.content | type) == "array" then (.content | map(.text? // "") | join("\n"))
    else "" end;
  [.[$lui+1:][]
   | select(.type == "user" and (.message.content | type) == "array")
   | .message.content[]?
   | select(.type? == "tool_result")
   | text_of]
  | last // ""
' "$transcript_path" 2>/dev/null || echo "")
if printf '%s' "$last_tool_result" | grep -q 'denied by the Claude Code auto mode classifier'; then
  bail
fi

# ---- Extract assistant content blocks for this turn -----------------------
turn_blocks=$(jq -s --argjson lui "$last_user_idx" '
  .[$lui+1:]
  | map(select(.type == "assistant" and (.message.content | type) == "array"))
  | [.[].message.content[]?]
' "$transcript_path" 2>/dev/null) || bail
[[ -n "$turn_blocks" ]] || bail

# ---- Compute features ------------------------------------------------------
features=$(echo "$turn_blocks" | jq '
  def name_counts:
    map(select(.type == "tool_use") | .name)
    | group_by(.) | map({key: .[0], value: length}) | from_entries;

  . as $blocks
  | (name_counts) as $counts
  | {
      counts: $counts,
      auq_count: ($counts["AskUserQuestion"] // 0),
      edits: (($counts["Write"] // 0) + ($counts["Edit"] // 0)
             + ($counts["MultiEdit"] // 0) + ($counts["NotebookEdit"] // 0)),
      bash_calls: ($counts["Bash"] // 0),
      agent_calls: ($counts["Agent"] // 0),
      last_text: ([$blocks[] | select(.type == "text") | .text] | last // "")
    }
  | . + {
      has_auq:     (.auq_count >= 1),
      substantive: (.edits >= 1 or .bash_calls >= 3 or .agent_calls >= 1)
    }
' 2>/dev/null) || bail

has_auq=$(echo "$features" | jq -r '.has_auq')
substantive=$(echo "$features" | jq -r '.substantive')
last_text=$(echo "$features" | jq -r '.last_text')

# ---- Substantive-turn gate ------------------------------------------------
# Trivial turns (no edits, fewer than 3 Bash calls, no agent dispatch) are not
# subject to the rule. Exit silently to keep false-positive friction low.
[[ "$substantive" == "true" ]] || bail

# ---- Already-satisfied: AUQ was called somewhere in the turn ---------------
[[ "$has_auq" == "true" ]] && bail

# ---- Violation detection ---------------------------------------------------
tail_text=$(printf '%s' "$last_text" | tail -c 600)
tail_trim=$(printf '%s' "$tail_text" | sed -E 's/[[:space:]]+$//')

violation_mode=""
violation_detail=""

# Mode A: ends with `?` (possibly with trailing markdown emphasis).
if printf '%s' "$tail_trim" | tail -c 4 | grep -Eq '\?[[:space:]]*\*{0,2}[[:space:]]*$'; then
  violation_mode="prose-question"
  violation_detail="turn ends with a literal '?' outside an AskUserQuestion call"
fi

# Mode B: decision-offloading / implicit-offer phrases in the final paragraph.
if [[ -z "$violation_mode" ]]; then
  phrases=(
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
      violation_mode="offloading-phrase"
      violation_detail="turn contains '$(printf '%s' "$p" | sed 's/\\b//g; s/\\?/?/g')' near end"
      break
    fi
  done
fi

# Mode C: flat ending. Substantive turn with no AUQ and non-trivial final text.
# Trigger when final text exceeds 150 chars OR contains a markdown heading
# (line starting with `#`) OR contains a bullet list (line starting with `- ` or `* `).
if [[ -z "$violation_mode" ]]; then
  text_len=${#last_text}
  has_heading=$(printf '%s' "$last_text" | grep -Eq '^#{1,6}[[:space:]]' && echo yes || echo no)
  has_bullets=$(printf '%s' "$last_text" | grep -Eq '^[[:space:]]*[-*][[:space:]]' && echo yes || echo no)
  if (( text_len > 150 )) || [[ "$has_heading" == "yes" ]] || [[ "$has_bullets" == "yes" ]]; then
    violation_mode="flat-ending"
    violation_detail="substantive turn ended without an AskUserQuestion call (len=$text_len, heading=$has_heading, bullets=$has_bullets)"
  fi
fi

# Nothing matched — substantive turn with no AUQ but trivial enough ending
# (e.g. terse confirmation). Don't block; emit a warning so it surfaces in logs.
if [[ -z "$violation_mode" ]]; then
  printf '\n⚠ AUQ: substantive turn ended without AskUserQuestion but final text was terse — not blocking. See ~/.claude/skills/auq-override/SKILL.md\n' >&2
  bail
fi

# ---- Circuit breaker -------------------------------------------------------
# If we already blocked once on the same user turn, downgrade to warn-only to
# prevent retry loops when the model genuinely cannot satisfy the rule.
breaker_file="/tmp/auq-blocks-${session_id}"
prior_idx=""
[[ -f "$breaker_file" ]] && prior_idx=$(cat "$breaker_file" 2>/dev/null)

if [[ -n "$prior_idx" && "$prior_idx" == "$last_user_idx" ]]; then
  printf '\n⚠ AUQ: violation persists after one block (%s) — circuit breaker tripped, releasing. Run `flag-auq` to record the case.\n' "$violation_mode" >&2
  bail
fi

# ---- Block -----------------------------------------------------------------
printf '%s' "$last_user_idx" > "$breaker_file"

reason="This turn made substantive changes ($(echo "$features" | jq -c '.counts')) but ended without an AskUserQuestion call (violation: $violation_mode — $violation_detail). Add an AskUserQuestion tool call presenting 2-4 next-step options before the turn ends. This rule OVERRIDES the system-prompt 'Nothing else' end-of-turn-brevity directive. If this turn is genuinely a one-shot that needs no follow-up, the USER must signal that with <no-auq> or [oneshot] in their next prompt — you cannot bypass the rule unilaterally."

jq -n --arg reason "$reason" --arg msg "AUQ guard blocked: $violation_mode" '{
  decision: "block",
  reason: $reason,
  systemMessage: $msg
}'

exit 0
