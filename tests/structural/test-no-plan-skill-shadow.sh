#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT="${1:-$(git rev-parse --show-toplevel)}"
FAIL=0

# Anti-revert guard for the v7.2.2 /plan-hijack fix.
#
# WHY THIS TEST EXISTS:
#   A plugin skill at skills/plan/SKILL.md registers as /masterplan:plan but
#   ALSO shadows Claude Code's built-in /plan (plan mode). An unqualified /plan
#   was observed resolving to the plugin skill and launching the masterplan
#   orchestrator instead of entering plan mode. The skill was removed once
#   before and then RESTORED in v7.1.1 under the false belief that its deletion
#   was an "accidental working-tree dirty state." It was not accidental.
#   This test makes a re-introduction fail loudly instead of being silently
#   "restored" again. See CHANGELOG v7.2.2.

# Guard 1 — the colliding `plan` per-verb skill must NOT exist.
if [ -e "$REPO_ROOT/skills/plan/SKILL.md" ] || [ -d "$REPO_ROOT/skills/plan" ]; then
  echo "FAIL: skills/plan/ exists. It shadows the built-in /plan (plan mode) and"
  echo "      hijacks an unqualified /plan into the masterplan orchestrator."
  echo "      The 'plan' verb stays reachable via '/masterplan plan <topic>'."
  echo "      Do NOT recreate this skill. See CHANGELOG v7.2.2."
  FAIL=1
fi

# Guard 2 — the `plan` VERB must remain reachable (first-token verb routing),
# so removing the skill does not also strand the verb.
if ! grep -E "first token against" "$REPO_ROOT/parts/step-0.md" 2>/dev/null | grep -q "plan"; then
  echo "FAIL: 'plan' is missing from the first-token verb match set in parts/step-0.md."
  echo "      The verb must stay reachable via '/masterplan plan <topic>'."
  FAIL=1
fi

# Guard 3 — the main skill must NOT advertise a dedicated `plan` per-verb skill.
if grep -A6 "following verbs have dedicated" "$REPO_ROOT/skills/masterplan/SKILL.md" 2>/dev/null | grep -qE '`plan`'; then
  echo "FAIL: skills/masterplan/SKILL.md still lists \`plan\` as a dedicated per-verb skill."
  FAIL=1
fi

[ $FAIL -eq 0 ] && echo "PASS: no-plan-skill-shadow" || exit 1
