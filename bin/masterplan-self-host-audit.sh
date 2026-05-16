#!/usr/bin/env bash
# masterplan-self-host-audit.sh — developer-only audit checks for the superpowers-masterplan repo.
#
# Replaces doctor checks #25 (deployment drift) and #27 (orchestrator free-text user questions)
# that previously lived in commands/masterplan.md. Those checks were embedded in the runtime
# orchestrator but only fired inside this repo — moving them here keeps the user-facing
# orchestrator (which ships to every /masterplan installation) clean of dev-only logic.
#
# Drift coverage: commands/masterplan.md, hooks/masterplan-telemetry.sh,
# bin/masterplan-routing-stats.sh, bin/masterplan-session-audit.sh,
# bin/masterplan-recurring-audit.sh, bin/masterplan-audit-schedule.sh,
# bin/masterplan-state.sh, AND skills/<name>/SKILL.md for every skill the plugin ships.
# A user-level copy at ~/.claude/skills/<name>/ shadows the plugin's registration and shows up
# as a duplicate slash command — caught here.
#
# Usage:
#   bin/masterplan-self-host-audit.sh           # run all checks (default)
#   bin/masterplan-self-host-audit.sh --fix     # also apply --fix actions for drift
#   bin/masterplan-self-host-audit.sh --drift   # only check deployment drift
#   bin/masterplan-self-host-audit.sh --cd9     # only check free-text user questions
#   bin/masterplan-self-host-audit.sh --models  # only check model-passthrough preamble (check #23)
#   bin/masterplan-self-host-audit.sh --codex   # only check Codex plugin packaging
#   bin/masterplan-self-host-audit.sh --brainstorm-anchor  # only check Step B1 brainstorm anchoring
#   bin/masterplan-self-host-audit.sh --session-audit  # only check session-audit regression tests
#   bin/masterplan-self-host-audit.sh --loop-first  # only check loop-first resume/stop contract
#   bin/masterplan-self-host-audit.sh --brief-style  # only check algorithmic brief style at lifecycle dispatch sites
#   bin/masterplan-self-host-audit.sh --taskcreate-gate  # only check TaskCreate/Update/List mentions are inside Codex no-op gate
#
# Exit code: 0 if clean, 1 if any check fires, 2 on usage error.

set -u

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [[ -z "${REPO_ROOT}" ]]; then
  echo "Error: not inside a git repo" >&2
  exit 2
fi

ORIGIN_URL="$(git -C "${REPO_ROOT}" config --get remote.origin.url 2>/dev/null || true)"
if [[ "${ORIGIN_URL}" != *superpowers-masterplan* ]]; then
  echo "Skipping: this audit only runs inside the superpowers-masterplan repo (origin: ${ORIGIN_URL:-unset})"
  exit 0
fi

MODE="${1:-}"
FIX_MODE=0
RUN_DRIFT=1
RUN_CD9=1
RUN_MODELS=1
RUN_CODEX=1
RUN_ANCHOR=1
RUN_SESSION_AUDIT=1
RUN_LOOP_FIRST=1
RUN_BRIEF_STYLE=1
RUN_TASKCREATE_GATE=1

case "${MODE}" in
  --fix)    FIX_MODE=1 ;;
  --drift)  RUN_CD9=0; RUN_MODELS=0; RUN_CODEX=0; RUN_ANCHOR=0; RUN_SESSION_AUDIT=0; RUN_LOOP_FIRST=0; RUN_BRIEF_STYLE=0; RUN_TASKCREATE_GATE=0 ;;
  --cd9)    RUN_DRIFT=0; RUN_MODELS=0; RUN_CODEX=0; RUN_ANCHOR=0; RUN_SESSION_AUDIT=0; RUN_LOOP_FIRST=0; RUN_BRIEF_STYLE=0; RUN_TASKCREATE_GATE=0 ;;
  --models) RUN_DRIFT=0; RUN_CD9=0; RUN_CODEX=0; RUN_ANCHOR=0; RUN_SESSION_AUDIT=0; RUN_LOOP_FIRST=0; RUN_BRIEF_STYLE=0; RUN_TASKCREATE_GATE=0 ;;
  --codex)  RUN_DRIFT=0; RUN_CD9=0; RUN_MODELS=0; RUN_ANCHOR=0; RUN_SESSION_AUDIT=0; RUN_LOOP_FIRST=0; RUN_BRIEF_STYLE=0; RUN_TASKCREATE_GATE=0 ;;
  --brainstorm-anchor) RUN_DRIFT=0; RUN_CD9=0; RUN_MODELS=0; RUN_CODEX=0; RUN_SESSION_AUDIT=0; RUN_LOOP_FIRST=0; RUN_BRIEF_STYLE=0; RUN_TASKCREATE_GATE=0 ;;
  --session-audit) RUN_DRIFT=0; RUN_CD9=0; RUN_MODELS=0; RUN_CODEX=0; RUN_ANCHOR=0; RUN_LOOP_FIRST=0; RUN_BRIEF_STYLE=0; RUN_TASKCREATE_GATE=0 ;;
  --loop-first) RUN_DRIFT=0; RUN_CD9=0; RUN_MODELS=0; RUN_CODEX=0; RUN_ANCHOR=0; RUN_SESSION_AUDIT=0; RUN_BRIEF_STYLE=0; RUN_TASKCREATE_GATE=0 ;;
  --brief-style) RUN_DRIFT=0; RUN_CD9=0; RUN_MODELS=0; RUN_CODEX=0; RUN_ANCHOR=0; RUN_SESSION_AUDIT=0; RUN_LOOP_FIRST=0; RUN_TASKCREATE_GATE=0 ;;
  --taskcreate-gate) RUN_DRIFT=0; RUN_CD9=0; RUN_MODELS=0; RUN_CODEX=0; RUN_ANCHOR=0; RUN_SESSION_AUDIT=0; RUN_LOOP_FIRST=0; RUN_BRIEF_STYLE=0 ;;
  "")       : ;;
  *)        echo "Usage: $0 [--fix|--drift|--cd9|--models|--codex|--brainstorm-anchor|--session-audit|--loop-first|--brief-style|--taskcreate-gate]" >&2; exit 2 ;;
esac

EXIT=0

json_value() {
  local file="$1"
  local expr="$2"

  if command -v jq >/dev/null 2>&1; then
    jq -r "${expr} // empty" "${file}" 2>/dev/null
    return
  fi

  case "${expr}" in
    .name)
      sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${file}" | head -1
      ;;
    .version)
      sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${file}" | head -1
      ;;
    *)
      echo ""
      ;;
  esac
}

# ---------------------------------------------------------------------------------
# Check: self-host deployment drift (was orchestrator doctor check #25, v2.9.0+)
# ---------------------------------------------------------------------------------
check_drift() {
  local user_cmds="${HOME}/.claude/commands/masterplan.md"
  local user_hook="${HOME}/.claude/hooks/masterplan-telemetry.sh"
  local user_bin="${HOME}/.claude/bin/masterplan-routing-stats.sh"
  local user_session_audit_bin="${HOME}/.claude/bin/masterplan-session-audit.sh"
  local user_recurring_audit_bin="${HOME}/.claude/bin/masterplan-recurring-audit.sh"
  local user_audit_schedule_bin="${HOME}/.claude/bin/masterplan-audit-schedule.sh"
  local user_state_bin="${HOME}/.claude/bin/masterplan-state.sh"
  local repo_cmds="${REPO_ROOT}/commands/masterplan.md"
  local repo_hook="${REPO_ROOT}/hooks/masterplan-telemetry.sh"
  local repo_hooks_json="${REPO_ROOT}/hooks/hooks.json"
  local repo_bin="${REPO_ROOT}/bin/masterplan-routing-stats.sh"
  local repo_session_audit_bin="${REPO_ROOT}/bin/masterplan-session-audit.sh"
  local repo_recurring_audit_bin="${REPO_ROOT}/bin/masterplan-recurring-audit.sh"
  local repo_audit_schedule_bin="${REPO_ROOT}/bin/masterplan-audit-schedule.sh"
  local repo_state_bin="${REPO_ROOT}/bin/masterplan-state.sh"

  local plugin_registry="${HOME}/.claude/plugins/installed_plugins.json"
  local plugin_registered=0
  if [[ -f "${plugin_registry}" ]] && grep -q "superpowers-masterplan" "${plugin_registry}" 2>/dev/null; then
    plugin_registered=1
  fi

  # Shim exemption (was the v2.10.0 augment to check #25): user-level commands/masterplan.md may
  # be a thin delegating shim with sentinel `<!-- masterplan-shim: vN -->` (v1, v2, v3, ...).
  # Forward-compatible regex match on any version sentinel — skip its drift check.
  local shim_match=""
  if [[ -f "${user_cmds}" ]]; then
    shim_match="$(grep -oE "<!-- masterplan-shim: v[0-9]+ -->" "${user_cmds}" 2>/dev/null | head -1)"
  fi
  local is_shim=0
  if [[ -n "${shim_match}" ]]; then
    is_shim=1
    local shim_version="${shim_match#<!-- masterplan-shim: }"
    shim_version="${shim_version% -->}"
    echo "✓ user-level commands/masterplan.md is the ${shim_version} plugin shim — drift comparison skipped"
  fi

  local files_to_check=(
    "commands/masterplan.md|${user_cmds}|${repo_cmds}"
    "hooks/masterplan-telemetry.sh|${user_hook}|${repo_hook}"
    "bin/masterplan-routing-stats.sh|${user_bin}|${repo_bin}"
    "bin/masterplan-session-audit.sh|${user_session_audit_bin}|${repo_session_audit_bin}"
    "bin/masterplan-recurring-audit.sh|${user_recurring_audit_bin}|${repo_recurring_audit_bin}"
    "bin/masterplan-audit-schedule.sh|${user_audit_schedule_bin}|${repo_audit_schedule_bin}"
    "bin/masterplan-state.sh|${user_state_bin}|${repo_state_bin}"
  )

  for entry in "${files_to_check[@]}"; do
    local label="${entry%%|*}"
    local rest="${entry#*|}"
    local user_file="${rest%|*}"
    local repo_file="${rest#*|}"

    # Shim exemption applies only to the orchestrator file.
    if [[ "${label}" == "commands/masterplan.md" && "${is_shim}" -eq 1 ]]; then
      continue
    fi

    if [[ ! -f "${user_file}" ]]; then
      if [[ "${plugin_registered}" -eq 0 ]]; then
        echo "⚠️  ${label} — user-level file missing AND plugin not registered in installed_plugins.json"
        EXIT=1
      fi
      # Plugin install replaces user-level files; absence is correct in that case.
      continue
    fi

    local user_md5 repo_md5
    user_md5="$(md5sum "${user_file}" | awk '{print $1}')"
    repo_md5="$(md5sum "${repo_file}" | awk '{print $1}')"

    if [[ "${user_md5}" != "${repo_md5}" ]]; then
      echo "⚠️  ${label} — md5 differs (user: ${user_md5}, repo: ${repo_md5})"
      if [[ "${FIX_MODE}" -eq 1 ]]; then
        local backup
        backup="${user_file}.bak-pre-$(date -u +%Y%m%dT%H%M%SZ)"
        cp "${user_file}" "${backup}"
        cp "${repo_file}" "${user_file}"
        if [[ "${user_file}" == *.sh ]]; then
          chmod +x "${user_file}"
        fi
        echo "    --fix: backed up to ${backup}, copied repo HEAD over user-level"
      else
        echo "    Suggested: cp \"${repo_file}\" \"${user_file}\"  (or re-run with --fix to backup + sync)"
      fi
      EXIT=1
    fi
  done

  if [[ -f "${repo_hooks_json}" ]]; then
    if ! grep -q '<!-- masterplan-shim: v3 -->' "${repo_hooks_json}" 2>/dev/null; then
      echo "⚠️  hooks/hooks.json — SessionStart hook must install the compact masterplan-shim v3"
      EXIT=1
    fi
    if grep -q 'ln -sf .*commands/masterplan.md' "${repo_hooks_json}" 2>/dev/null; then
      echo "⚠️  hooks/hooks.json — SessionStart hook must not symlink the full orchestrator prompt"
      EXIT=1
    fi
  else
    echo "⚠️  hooks/hooks.json — missing SessionStart hook config"
    EXIT=1
  fi
}

# ---------------------------------------------------------------------------------
# Check: skills/ deployment drift — user-level copy shadows plugin registration
# ---------------------------------------------------------------------------------
check_skill_drift() {
  local skills_dir="${REPO_ROOT}/skills"
  if [[ ! -d "${skills_dir}" ]]; then
    return
  fi

  for skill_path in "${skills_dir}"/*/SKILL.md; do
    [[ -f "${skill_path}" ]] || continue
    local skill_name
    skill_name="$(basename "$(dirname "${skill_path}")")"

    local user_skill="${HOME}/.claude/skills/${skill_name}/SKILL.md"
    if [[ ! -f "${user_skill}" ]]; then
      continue  # Plugin handles registration; user-level absence is correct.
    fi

    # Shim exemption (forward-compatible, same pattern as commands/).
    if grep -qE "<!-- masterplan-shim: v[0-9]+ -->" "${user_skill}" 2>/dev/null; then
      echo "✓ user-level skills/${skill_name}/SKILL.md is a shim — drift comparison skipped"
      continue
    fi

    local user_md5 repo_md5
    user_md5="$(md5sum "${user_skill}" | awk '{print $1}')"
    repo_md5="$(md5sum "${skill_path}" | awk '{print $1}')"

    if [[ "${user_md5}" == "${repo_md5}" ]]; then
      echo "⚠️  skills/${skill_name}/SKILL.md — user-level copy is byte-identical to plugin's; duplicates the plugin registration"
      if [[ "${FIX_MODE}" -eq 1 ]]; then
        rm -r "${HOME}/.claude/skills/${skill_name}"
        echo "    --fix: removed ~/.claude/skills/${skill_name}/"
      else
        echo "    Suggested: rm -r \"${HOME}/.claude/skills/${skill_name}\"  (or re-run with --fix)"
      fi
      EXIT=1
    else
      echo "⚠️  skills/${skill_name}/SKILL.md — user-level copy differs from plugin's; possibly an intentional customization (no auto-fix)"
      EXIT=1
    fi
  done
}

# ---------------------------------------------------------------------------------
# Check: Codex plugin packaging
# ---------------------------------------------------------------------------------
check_codex_packaging() {
  local claude_manifest="${REPO_ROOT}/.claude-plugin/plugin.json"
  local codex_manifest="${REPO_ROOT}/.codex-plugin/plugin.json"
  local codex_marketplace="${REPO_ROOT}/.agents/plugins/marketplace.json"
  local command_file="${REPO_ROOT}/commands/masterplan.md"
  local skills_dir="${REPO_ROOT}/skills"
  local codex_entry_skill="${skills_dir}/masterplan/SKILL.md"
  local detect_skill="${skills_dir}/masterplan-detect/SKILL.md"

  local missing=0
  for file in "${claude_manifest}" "${codex_manifest}" "${codex_marketplace}" "${command_file}" "${codex_entry_skill}" "${detect_skill}"; do
    if [[ ! -f "${file}" ]]; then
      echo "⚠️  Codex packaging — missing ${file#${REPO_ROOT}/}"
      EXIT=1
      missing=1
    fi
  done
  if [[ ! -d "${skills_dir}" ]]; then
    echo "⚠️  Codex packaging — missing skills/ directory"
    EXIT=1
    missing=1
  fi
  if [[ ! -L "${REPO_ROOT}/plugins/superpowers-masterplan" ]]; then
    echo "⚠️  Codex packaging — missing plugins/superpowers-masterplan symlink"
    EXIT=1
    missing=1
  fi
  [[ "${missing}" -eq 1 ]] && return

  local claude_version codex_version codex_name marketplace_name marketplace_plugin marketplace_source marketplace_path
  claude_version="$(json_value "${claude_manifest}" '.version')"
  codex_version="$(json_value "${codex_manifest}" '.version')"
  codex_name="$(json_value "${codex_manifest}" '.name')"

  if command -v jq >/dev/null 2>&1; then
    marketplace_name="$(jq -r '.name // empty' "${codex_marketplace}" 2>/dev/null)"
    marketplace_plugin="$(jq -r '.plugins[0].name // empty' "${codex_marketplace}" 2>/dev/null)"
    marketplace_source="$(jq -r '.plugins[0].source.source // empty' "${codex_marketplace}" 2>/dev/null)"
    marketplace_path="$(jq -r '.plugins[0].source.path // empty' "${codex_marketplace}" 2>/dev/null)"
  else
    marketplace_name="$(json_value "${codex_marketplace}" '.name')"
    marketplace_plugin="$(grep -A20 '"plugins"' "${codex_marketplace}" | sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    marketplace_source="$(grep -A20 '"source"' "${codex_marketplace}" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
    marketplace_path="$(sed -n 's/.*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${codex_marketplace}" | head -1)"
  fi

  if [[ "${codex_name}" != "superpowers-masterplan" ]]; then
    echo "⚠️  .codex-plugin/plugin.json — name is '${codex_name}', expected 'superpowers-masterplan'"
    EXIT=1
  fi

  if [[ -z "${claude_version}" || -z "${codex_version}" || "${claude_version}" != "${codex_version}" ]]; then
    echo "⚠️  Codex packaging — version mismatch (claude: ${claude_version:-missing}, codex: ${codex_version:-missing})"
    EXIT=1
  fi

  if [[ "${marketplace_name}" != "rasatpetabit-superpowers-masterplan" ]]; then
    echo "⚠️  .agents/plugins/marketplace.json — marketplace name is '${marketplace_name}', expected 'rasatpetabit-superpowers-masterplan'"
    EXIT=1
  fi

  if [[ "${marketplace_plugin}" != "superpowers-masterplan" ]]; then
    echo "⚠️  .agents/plugins/marketplace.json — plugin name is '${marketplace_plugin}', expected 'superpowers-masterplan'"
    EXIT=1
  fi

  if [[ "${marketplace_source}" != "local" || "${marketplace_path}" != "./plugins/superpowers-masterplan" ]]; then
    echo "⚠️  .agents/plugins/marketplace.json — source must be local path './plugins/superpowers-masterplan' (got source='${marketplace_source}', path='${marketplace_path}')"
    EXIT=1
  fi

  if ! grep -q '/superpowers-masterplan:masterplan' "${REPO_ROOT}/README.md" 2>/dev/null; then
    echo "⚠️  README.md — missing documented Codex compatibility input /superpowers-masterplan:masterplan"
    EXIT=1
  fi

  if ! grep -q '^name: masterplan$' "${codex_entry_skill}" 2>/dev/null; then
    echo "⚠️  skills/masterplan/SKILL.md — missing Codex-visible skill name 'masterplan'"
    EXIT=1
  fi

  if ! grep -q 'commands/masterplan.md' "${codex_entry_skill}" 2>/dev/null; then
    echo "⚠️  skills/masterplan/SKILL.md — must load commands/masterplan.md as the behavior source of truth"
    EXIT=1
  fi

  if ! grep -q 'docs/masterplan' "${codex_entry_skill}" 2>/dev/null; then
    echo "⚠️  skills/masterplan/SKILL.md — must mention existing docs/masterplan run bundles"
    EXIT=1
  fi

  if ! grep -q '~/.masterplan.yaml' "${codex_entry_skill}" 2>/dev/null; then
    echo "⚠️  skills/masterplan/SKILL.md — must explicitly load user-global ~/.masterplan.yaml config"
    EXIT=1
  fi

  if ! grep -qE '`masterplan` skill|masterplan skill' "${REPO_ROOT}/README.md" 2>/dev/null; then
    echo "⚠️  README.md — missing Codex masterplan skill entrypoint documentation"
    EXIT=1
  fi

  if ! grep -q 'skills/masterplan/SKILL.md' "${REPO_ROOT}/docs/internals.md" 2>/dev/null; then
    echo "⚠️  docs/internals.md — missing Codex entrypoint skill documentation"
    EXIT=1
  fi

  if ! grep -q 'codex_host_suppressed' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing codex_host_suppressed runtime guard"
    EXIT=1
  fi

  if ! grep -q 'host-suppressed' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing host-suppressed routing decision source"
    EXIT=1
  fi

  if ! grep -qi 'recursive Codex' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing recursive Codex dispatch suppression text"
    EXIT=1
  fi

  if ! grep -q 'Codex interactive-selection evidence' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing Codex interactive-selection evidence rule"
    EXIT=1
  fi

  if grep -q 'recommended option was not treated as consent' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — still rejects Codex interactive recommended-option selections"
    EXIT=1
  fi

  if grep -q 'recommended-only `request_user_input` answer.*weak evidence' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — still classifies recommended-only Codex answers as weak evidence"
    EXIT=1
  fi

  if ! grep -q 'Codex host performance guard' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing Codex host performance guard"
    EXIT=1
  fi

  if ! grep -q 'codex_host_perf_guard' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing codex_host_perf_guard budget variable"
    EXIT=1
  fi

  if ! grep -q 'codex_host_gate_continuation' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing Codex answered-gate continuation rule"
    EXIT=1
  fi

  if grep -q 'then → CLOSE-TURN instead of continuing into the next phase' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — Codex answered gates must not force-close full-flow runs"
    EXIT=1
  fi

  if grep -q 'Because this is a Codex-hosted Masterplan run, I closed after the structured gate' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — forbidden Codex post-gate close rationale is present"
    EXIT=1
  fi

  if ! grep -q 'Sensitive live-auth stop' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing sensitive live-auth stop rule"
    EXIT=1
  fi

  if ! grep -q 'targeted section reads' "${codex_entry_skill}" 2>/dev/null; then
    echo "⚠️  skills/masterplan/SKILL.md — missing targeted section reads guidance"
    EXIT=1
  fi

  if ! grep -q 'codex_host_gate_continuation' "${codex_entry_skill}" 2>/dev/null; then
    echo "⚠️  skills/masterplan/SKILL.md — missing Codex gate-continuation guidance"
    EXIT=1
  fi

  if ! grep -q 'Use masterplan' "${codex_entry_skill}" 2>/dev/null; then
    echo '⚠️  skills/masterplan/SKILL.md — missing Codex normal-chat invocation mapping'
    EXIT=1
  fi

  if ! grep -q 'codex_user_entrypoint = "Use masterplan"' "${command_file}" 2>/dev/null; then
    echo '⚠️  commands/masterplan.md — missing Codex normal-chat resume-hint contract'
    EXIT=1
  fi

  if ! grep -q 'Use masterplan' "${REPO_ROOT}/README.md" 2>/dev/null; then
    echo '⚠️  README.md — missing Codex normal-chat invocation documentation'
    EXIT=1
  fi

  if grep -Eq 'Codex host budget reached: .*(resume with /masterplan|resume with \$masterplan)' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — Codex budget close text must not suggest shell/slash resume commands"
    EXIT=1
  fi

  if grep -q 'MUST use \$masterplan' "${command_file}" 2>/dev/null; then
    echo '⚠️  commands/masterplan.md — Codex resume hints must not require $masterplan'
    EXIT=1
  fi

  if grep -q 're-invoke /masterplan' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — user-facing resume gate examples must use host-specific placeholders, not hard-coded /masterplan"
    EXIT=1
  fi

  if ! grep -q 'Codex native goal pursuit' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing Codex native goal pursuit contract"
    EXIT=1
  fi

  if ! grep -q 'create_goal' "${command_file}" 2>/dev/null || ! grep -q 'get_goal' "${command_file}" 2>/dev/null || ! grep -q 'update_goal' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — missing Codex goal tool lifecycle calls"
    EXIT=1
  fi

  if ! grep -q 'completed_with_follow_up' "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — clean must skip completed plans with follow-up next_action"
    EXIT=1
  fi

  if ! grep -qi 'recursive Codex' "${REPO_ROOT}/README.md" 2>/dev/null; then
    echo "⚠️  README.md — missing Codex-host recursive dispatch documentation"
    EXIT=1
  fi

  if ! grep -q 'codex_host_suppressed' "${REPO_ROOT}/docs/internals.md" 2>/dev/null; then
    echo "⚠️  docs/internals.md — missing codex_host_suppressed documentation"
    EXIT=1
  fi

  if ! grep -q 'Codex native goal' "${codex_entry_skill}" 2>/dev/null; then
    echo "⚠️  skills/masterplan/SKILL.md — missing Codex native goal guidance"
    EXIT=1
  fi

  if [[ "${EXIT}" -eq 0 ]]; then
    echo "✓ Codex plugin packaging clean"
  fi
}

# ---------------------------------------------------------------------------------
# Check: Step B1 brainstorm intent anchor
# ---------------------------------------------------------------------------------
check_brainstorm_anchor() {
  local command_file="${REPO_ROOT}/commands/masterplan.md"
  local fixture_file="${REPO_ROOT}/docs/masterplan/expanded-brainstorming-selection/regressions.json"

  if [[ ! -f "${command_file}" ]]; then
    echo "Skipping brainstorm-anchor check: ${command_file} not found"
    return
  fi

  local patterns=(
    "brainstorm_anchor:"
    "brainstorm_anchor_resolved"
    "feature-ideas | implementation-design | audit-review | deferred-task | execution-resume | unclear"
    "brainstorm_anchor_audit_mode"
    "brainstorm_anchor_scope_boundary"
    "Intent Anchor"
    "Scope Boundary"
    "verification_ceiling"
    "feature-idea funnels unless"
    "native multi-select UI or arbitrary free-form ID entry"
    "Problem Interview Contract"
    "interview_depth"
    "target_question_count"
    "understanding_level"
  )

  local pattern
  for pattern in "${patterns[@]}"; do
    if ! grep -qF "${pattern}" "${command_file}" 2>/dev/null; then
      echo "⚠️  commands/masterplan.md — missing Step B1 brainstorm anchor contract text: ${pattern}"
      EXIT=1
    fi
  done

  if [[ ! -f "${fixture_file}" ]]; then
    echo "⚠️  brainstorm anchor fixtures — missing ${fixture_file#${REPO_ROOT}/}"
    EXIT=1
    return
  fi

  if command -v jq >/dev/null 2>&1; then
    local count
    count="$(jq 'length' "${fixture_file}" 2>/dev/null || echo 0)"
    if [[ "${count}" -ne 4 ]]; then
      echo "⚠️  brainstorm anchor fixtures — expected 4 cases, found ${count}"
      EXIT=1
    fi

    local cases=(
      "meta-petabit-yocto-config-review|audit-review"
      "meta-petabit-error-qa|deferred-task"
      "meta-petabit-image-package-policy|implementation-design"
      "superpowers-masterplan-feature-ideas|feature-ideas"
    )

    local entry
    for entry in "${cases[@]}"; do
      local id="${entry%%|*}"
      local mode="${entry#*|}"
      if ! jq -e --arg id "${id}" --arg mode "${mode}" '.[] | select(.id == $id and .expected_mode == $mode)' "${fixture_file}" >/dev/null; then
        echo "⚠️  brainstorm anchor fixtures — missing case ${id} with mode ${mode}"
        EXIT=1
      fi
    done
  else
    local ids=(
      "meta-petabit-yocto-config-review"
      "meta-petabit-error-qa"
      "meta-petabit-image-package-policy"
      "superpowers-masterplan-feature-ideas"
    )
    local id
    for id in "${ids[@]}"; do
      if ! grep -qF "\"id\": \"${id}\"" "${fixture_file}" 2>/dev/null; then
        echo "⚠️  brainstorm anchor fixtures — missing case ${id}"
        EXIT=1
      fi
    done
  fi

  if [[ "${EXIT}" -eq 0 ]]; then
    echo "✓ brainstorm anchor contract clean"
  fi
}

# ---------------------------------------------------------------------------------
# Check: model-passthrough preamble enforcement (doctor check #23 audit surface, v2.12.0)
# ---------------------------------------------------------------------------------
check_model_passthrough() {
  local file="${REPO_ROOT}/commands/masterplan.md"
  if [[ ! -f "${file}" ]]; then
    echo "Skipping model-passthrough check: ${file} not found"
    return
  fi

  # 1. Verify the verbatim preamble sentinel is present (canonical definition in §Agent dispatch contract).
  local sentinel="For every inner Task / Agent invocation you make"
  local sentinel_count
  sentinel_count="$(grep -c "${sentinel}" "${file}" || true)"
  if [[ "${sentinel_count}" -eq 0 ]]; then
    echo "⚠️  commands/masterplan.md — verbatim SDD preamble sentinel not found (expected ≥1 occurrence of: '${sentinel}')"
    echo "    Contract drift: §Agent dispatch contract recursive-application preamble is missing."
    EXIT=1
  else
    echo "✓ model-passthrough preamble sentinel found (${sentinel_count} occurrence(s))"
  fi

  # 2. Informational: count lines carrying model: "haiku"|"sonnet"|"opus" — dispatch attribution sites.
  local model_lines
  model_lines="$(grep -cE 'model: "(haiku|sonnet|opus)"' "${file}" || true)"
  echo "  Info: ${model_lines} line(s) with explicit model: \"haiku\"|\"sonnet\"|\"opus\" in orchestrator source"

  # 3. Warn on model: "opus" occurrences outside the blocker-stronger-model context.
  local opus_lines
  opus_lines="$(grep -n 'model: "opus"' "${file}" || true)"
  if [[ -n "${opus_lines}" ]]; then
    local warned=0
    while IFS= read -r line; do
      local lineno="${line%%:*}"
      local context_start=$((lineno - 5))
      local context_end=$((lineno + 5))
      [[ "${context_start}" -lt 1 ]] && context_start=1
      local context
      context="$(sed -n "${context_start},${context_end}p" "${file}")"
      # Suppress if near blocker gate context or config table (expected opus sites).
      if echo "${context}" | grep -qE 'blocker|stronger.model|re-dispatch|ONLY exception|config table|dispatch contract'; then
        continue
      fi
      echo "⚠️  commands/masterplan.md:${lineno} — model: \"opus\" outside blocker-stronger-model context (cost regression site; should be sonnet)"
      warned=$((warned + 1))
      EXIT=1
    done <<< "${opus_lines}"
    if [[ "${warned}" -eq 0 && -n "${opus_lines}" ]]; then
      echo "✓ all model: \"opus\" occurrences are within blocker-stronger-model or config-table context"
    fi
  else
    echo "✓ no bare model: \"opus\" dispatch sites found"
  fi
}

# ---------------------------------------------------------------------------------
# Check: orchestrator free-text user questions (was doctor check #27, v2.10.0)
# ---------------------------------------------------------------------------------
check_cd9() {
  local file="${REPO_ROOT}/commands/masterplan.md"
  if [[ ! -f "${file}" ]]; then
    echo "Skipping CD-9 check: ${file} not found"
    return
  fi

  local pattern_re='ask the user|prompt the user|request that the user|request the user|confirm with the user|wait for the user'\''?s? (response|to)|the user must (confirm|choose|decide|pick)|[Ww]ant me to (continue|proceed|advance|run|execute)|[Ss]hould I (continue|proceed|advance)|[Ss]hall I (continue|proceed)|[Ll]et me know (when|if|how)|(when|after) you'\''?re ready,? (let me|I'\''?ll)|[Cc]ontinue to T[0-9]+\?'

  local matches
  matches="$(grep -nE "${pattern_re}" "${file}" || true)"
  if [[ -z "${matches}" ]]; then
    return
  fi

  local found_violations=0
  while IFS= read -r match; do
    local lineno="${match%%:*}"
    local context_start=$((lineno - 20))
    local context_end=$((lineno + 20))
    [[ "${context_start}" -lt 1 ]] && context_start=1

    local context
    context="$(sed -n "${context_start},${context_end}p" "${file}")"

    # Skip if paired AskUserQuestion is nearby.
    if grep -qF "AskUserQuestion" <<< "${context}"; then
      continue
    fi
    # Skip if inline cd9-exempt marker is nearby.
    if grep -qF "cd9-exempt" <<< "${context}"; then
      continue
    fi
    # Skip if inside CD-9 rule definition or "Don't stop silently" restatement.
    if grep -qF "**CD-9**" <<< "${context}"; then
      continue
    fi
    if grep -qF "Don't stop silently" <<< "${context}"; then
      continue
    fi

    echo "⚠️  ${file}:${lineno} — ${match#*:}"
    found_violations=$((found_violations + 1))
  done <<< "${matches}"

  if [[ "${found_violations}" -gt 0 ]]; then
    echo ""
    echo "Found ${found_violations} potential CD-9 violation(s). Replace with AskUserQuestion or annotate with <!-- cd9-exempt: <reason> -->."
    EXIT=1
  fi
}

# ---------------------------------------------------------------------------------
# Check: session-audit regression suite
# ---------------------------------------------------------------------------------
check_session_audit() {
  local test_file="${REPO_ROOT}/tests/test_masterplan_session_audit.py"
  local schedule_test_file="${REPO_ROOT}/tests/test_masterplan_audit_schedule.py"
  local module_file="${REPO_ROOT}/lib/masterplan_session_audit.py"
  local fixture_dir="${REPO_ROOT}/tests/fixtures/session-audit"

  if [[ ! -f "${module_file}" ]]; then
    echo "⚠️  session audit — missing lib/masterplan_session_audit.py"
    EXIT=1
    return
  fi
  if [[ ! -f "${test_file}" ]]; then
    echo "⚠️  session audit — missing tests/test_masterplan_session_audit.py"
    EXIT=1
    return
  fi
  if [[ ! -f "${schedule_test_file}" ]]; then
    echo "⚠️  session audit — missing tests/test_masterplan_audit_schedule.py"
    EXIT=1
    return
  fi
  if [[ ! -d "${fixture_dir}" ]]; then
    echo "⚠️  session audit — missing tests/fixtures/session-audit/"
    EXIT=1
    return
  fi

  if python3 -m unittest tests/test_masterplan_session_audit.py tests/test_masterplan_audit_schedule.py >/dev/null; then
    echo "✓ session audit regression tests clean"
  else
    echo "⚠️  session audit regression tests failed"
    python3 -m unittest tests/test_masterplan_session_audit.py tests/test_masterplan_audit_schedule.py
    EXIT=1
  fi
}

# ---------------------------------------------------------------------------------
# Check: loop-first resume/stop contract
# ---------------------------------------------------------------------------------
check_loop_first_contract() {
  local command_file="${REPO_ROOT}/commands/masterplan.md"
  local internals_file="${REPO_ROOT}/docs/internals.md"
  local readme_file="${REPO_ROOT}/README.md"
  local audit_module="${REPO_ROOT}/lib/masterplan_session_audit.py"
  local audit_tests="${REPO_ROOT}/tests/test_masterplan_session_audit.py"

  local missing=0
  for file in "${command_file}" "${internals_file}" "${readme_file}" "${audit_module}" "${audit_tests}"; do
    if [[ ! -f "${file}" ]]; then
      echo "⚠️  loop-first contract — missing ${file#${REPO_ROOT}/}"
      EXIT=1
      missing=1
    fi
  done
  [[ "${missing}" -eq 1 ]] && return

  local command_patterns=(
    "Loop-first stop contract"
    "Resume controller"
    "stop_reason: null | question | critical_error | complete | scheduled_yield"
    "critical_error: null"
    "blocked is reserved for critical_error only"
    "Ordinary task blockers, weak/no gate evidence, Codex host budget limits, background polling, loop quotas, and context pressure are resumable conditions"
    "Record critical error and stop"
    "loop_quota_exhausted"
  )

  local pattern
  for pattern in "${command_patterns[@]}"; do
    if ! grep -qF "${pattern}" "${command_file}" 2>/dev/null; then
      echo "⚠️  commands/masterplan.md — missing loop-first contract text: ${pattern}"
      EXIT=1
    fi
  done

  if grep -qF "Set status: blocked and end the turn" "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — legacy manual-block option is still present"
    EXIT=1
  fi

  if grep -qF "loop quota exhausted; resume manually" "${command_file}" 2>/dev/null; then
    echo "⚠️  commands/masterplan.md — loop quota exhaustion must be a persisted question, not manual blocked state"
    EXIT=1
  fi

  if ! grep -qF "Blocked means critical error only" "${internals_file}" 2>/dev/null; then
    echo "⚠️  docs/internals.md — missing blocked-is-critical-only operational rule"
    EXIT=1
  fi

  if ! grep -qF "loop-first" "${readme_file}" 2>/dev/null; then
    echo "⚠️  README.md — missing user-facing loop-first resume documentation"
    EXIT=1
  fi

  local audit_patterns=(
    "stop_kind"
    "active_masterplan_unclassified_stop"
    "STOP_KIND_UNKNOWN"
    "critical_error"
    "scheduled_yield"
  )
  for pattern in "${audit_patterns[@]}"; do
    if ! grep -qF "${pattern}" "${audit_module}" 2>/dev/null; then
      echo "⚠️  lib/masterplan_session_audit.py — missing stop classifier text: ${pattern}"
      EXIT=1
    fi
  done

  local fixture_patterns=(
    "stop-question"
    "stop-critical"
    "stop-complete"
    "stop-scheduled"
    "stop-unknown"
  )
  for pattern in "${fixture_patterns[@]}"; do
    if ! grep -qF "${pattern}" "${audit_tests}" 2>/dev/null; then
      echo "⚠️  tests/test_masterplan_session_audit.py — missing stop fixture coverage: ${pattern}"
      EXIT=1
    fi
  done

  if [[ "${EXIT}" -eq 0 ]]; then
    echo "✓ loop-first resume contract clean"
  fi
}

# ---------------------------------------------------------------------------------
# Check: algorithmic brief style at lifecycle dispatch sites (FM-D, v4.0.0+; v5.8.0+ multi-file)
#
# Scopes ALL patterns to text within 30 lines of a lifecycle DISPATCH-SITE
# value — avoids false positives in user-facing prose.
#
# v5.8.0+ expanded scope:
#   - commands/masterplan.md  — legacy v4 step-name sites (Step B0/R2/D)
#   - parts/step-c.md         — v5 site-label sites (`DISPATCH-SITE: step-c.md:<label>`)
#   - parts/doctor.md         — v5 site-label sites + legacy `Step D doctor [...] checks`
#
# Pattern A: "validate against" not followed within 5 lines by "for each" or "if.*field"
# Pattern B: "make sure that" (outcome language, no algorithmic equivalent)
# Pattern C: "verify the bundle" not followed within 5 lines by "for each" or "check.*field"
# Pattern D: lifecycle dispatch block (identified by DISPATCH-SITE matching a lifecycle value)
#            that lacks "contract_id" in the next 30 lines.
# ---------------------------------------------------------------------------------
check_brief_style() {
  BRIEF_STYLE_VIOLATIONS=0

  # Per-file scan. Args: file lifecycle_re apply_prose_patterns require_sites_found
  #   apply_prose_patterns=1 enables Pattern A/B/C (only meaningful for files
  #     that historically carried orchestration prose; v5 phase files are
  #     algorithmic by construction).
  #   require_sites_found=1 treats zero matches as a violation (only used for
  #     commands/masterplan.md for legacy compatibility — v5 phase files may
  #     legitimately have zero tagged sites if no Agent dispatches originate
  #     there yet).
  # In v5.0+, lifecycle dispatch sites moved out of commands/masterplan.md
  # into parts/*.md (step-b.md, step-c.md, doctor.md). We still scan
  # masterplan.md in case future revisions re-introduce sites there, but no
  # longer require it to have any (require_sites_found=0).
  _brief_style_scan_file "${REPO_ROOT}/commands/masterplan.md" \
    "DISPATCH-SITE: (Step B0 related-plan scan|Step R2 retro source gather|Step D doctor checks)" \
    1 0
  _brief_style_scan_file "${REPO_ROOT}/parts/step-c.md" \
    "DISPATCH-SITE: step-c\\.md:[a-zA-Z0-9_-]+" \
    0 0
  _brief_style_scan_file "${REPO_ROOT}/parts/doctor.md" \
    "DISPATCH-SITE: (doctor\\.md:[a-zA-Z0-9_-]+|Step D doctor [a-zA-Z0-9_-]*checks?)" \
    0 0

  if [[ "${BRIEF_STYLE_VIOLATIONS}" -eq 0 ]]; then
    echo "✓ brief-style: lifecycle dispatch sites use algorithmic briefs with contract_id"
  fi
}

_brief_style_scan_file() {
  local file="$1"
  local lifecycle_re="$2"
  local apply_prose="$3"
  local require_sites="$4"

  if [[ ! -f "${file}" ]]; then
    echo "Skipping brief-style check: ${file} not found"
    return
  fi

  local total_lines
  total_lines="$(wc -l < "${file}")"

  # Collect lifecycle DISPATCH-SITE line numbers and build context ranges
  # (lineno-5 .. lineno+30) for prose-pattern scoping.
  #
  # Skip lines that contain backticks: a real DISPATCH-SITE tag line lives
  # inside a fenced code block (the fence delimiters live on adjacent lines,
  # so the tag line itself is backtick-free). Prose that documents the
  # convention by embedding `DISPATCH-SITE: ...` examples in inline-code
  # spans (e.g., the v5 convention preamble at parts/step-c.md:13) carries
  # backticks on the same line and is not a real tag.
  local dispatch_ranges=()
  while IFS= read -r dispatch_line; do
    local lineno="${dispatch_line%%:*}"
    local content="${dispatch_line#*:}"
    if [[ "${content}" == *'`'* ]]; then
      continue
    fi
    local range_start=$((lineno - 5))
    local range_end=$((lineno + 30))
    [[ "${range_start}" -lt 1 ]] && range_start=1
    [[ "${range_end}" -gt "${total_lines}" ]] && range_end="${total_lines}"
    dispatch_ranges+=("${range_start}:${range_end}")
  done < <(grep -nE "${lifecycle_re}" "${file}" 2>/dev/null)

  if [[ "${#dispatch_ranges[@]}" -eq 0 ]]; then
    if [[ "${require_sites}" -eq 1 ]]; then
      echo "BRIEF-STYLE: ${file}:0: Pattern D — no lifecycle DISPATCH-SITE values found; expected Step B0/R2/D sites"
      BRIEF_STYLE_VIOLATIONS=$((BRIEF_STYLE_VIOLATIONS + 1))
      EXIT=1
    fi
    return
  fi

  _brief_style_in_context() {
    local check_line="$1"
    local pair
    for pair in "${dispatch_ranges[@]}"; do
      local s="${pair%%:*}"
      local e="${pair#*:}"
      if [[ "${check_line}" -ge "${s}" && "${check_line}" -le "${e}" ]]; then
        return 0
      fi
    done
    return 1
  }

  if [[ "${apply_prose}" -eq 1 ]]; then
    # Pattern A: "validate against" not followed within 5 lines by "for each" or "if.*field"
    while IFS= read -r match; do
      local lineno="${match%%:*}"
      local excerpt="${match#*:}"
      _brief_style_in_context "${lineno}" || continue
      local ctx_start=$((lineno + 1))
      local ctx_end=$((lineno + 5))
      [[ "${ctx_end}" -gt "${total_lines}" ]] && ctx_end="${total_lines}"
      local ctx
      ctx="$(sed -n "${ctx_start},${ctx_end}p" "${file}")"
      if echo "${ctx}" | grep -qiE "for each|if.*field"; then
        continue
      fi
      echo "BRIEF-STYLE: ${file}:${lineno}: Pattern A (validate against without for-each/field check) — ${excerpt}"
      BRIEF_STYLE_VIOLATIONS=$((BRIEF_STYLE_VIOLATIONS + 1))
      EXIT=1
    done < <(grep -nF "validate against" "${file}" 2>/dev/null)

    # Pattern B: "make sure that" in dispatch context
    while IFS= read -r match; do
      local lineno="${match%%:*}"
      local excerpt="${match#*:}"
      _brief_style_in_context "${lineno}" || continue
      echo "BRIEF-STYLE: ${file}:${lineno}: Pattern B (outcome language 'make sure that') — ${excerpt}"
      BRIEF_STYLE_VIOLATIONS=$((BRIEF_STYLE_VIOLATIONS + 1))
      EXIT=1
    done < <(grep -niF "make sure that" "${file}" 2>/dev/null)

    # Pattern C: "verify the bundle" not followed within 5 lines by "for each" or "check.*field"
    while IFS= read -r match; do
      local lineno="${match%%:*}"
      local excerpt="${match#*:}"
      _brief_style_in_context "${lineno}" || continue
      local ctx_start=$((lineno + 1))
      local ctx_end=$((lineno + 5))
      [[ "${ctx_end}" -gt "${total_lines}" ]] && ctx_end="${total_lines}"
      local ctx
      ctx="$(sed -n "${ctx_start},${ctx_end}p" "${file}")"
      if echo "${ctx}" | grep -qiE "for each|check.*field"; then
        continue
      fi
      echo "BRIEF-STYLE: ${file}:${lineno}: Pattern C (verify the bundle without for-each/field check) — ${excerpt}"
      BRIEF_STYLE_VIOLATIONS=$((BRIEF_STYLE_VIOLATIONS + 1))
      EXIT=1
    done < <(grep -niF "verify the bundle" "${file}" 2>/dev/null)
  fi

  # Pattern D: each lifecycle dispatch block must have "contract_id" within 30 lines after
  # its DISPATCH-SITE line. Applies to ALL scanned files (v5 phase files included).
  # Backtick-bearing matches are documentation prose, not real tags — skip (same
  # reasoning as dispatch_ranges collection above).
  while IFS= read -r dispatch_line; do
    local lineno="${dispatch_line%%:*}"
    local dispatch_val="${dispatch_line#*:}"
    if [[ "${dispatch_val}" == *'`'* ]]; then
      continue
    fi
    local ctx_start=$((lineno + 1))
    local ctx_end=$((lineno + 30))
    [[ "${ctx_end}" -gt "${total_lines}" ]] && ctx_end="${total_lines}"
    local ctx
    ctx="$(sed -n "${ctx_start},${ctx_end}p" "${file}")"
    if echo "${ctx}" | grep -qF "contract_id"; then
      continue
    fi
    echo "BRIEF-STYLE: ${file}:${lineno}: Pattern D (lifecycle dispatch missing contract_id) — ${dispatch_val}"
    BRIEF_STYLE_VIOLATIONS=$((BRIEF_STYLE_VIOLATIONS + 1))
    EXIT=1
  done < <(grep -nE "${lifecycle_re}" "${file}" 2>/dev/null)
}

# ---------------------------------------------------------------------------------
# Check: TaskCreate/Update/List mentions are inside the Codex no-op gate (v4.1.0+)
#
# Every TaskCreate / TaskUpdate / TaskList mention in commands/masterplan.md must
# sit within 8 lines of a Codex gate marker (codex_host_suppressed == false,
# codex_host_suppressed == true, or "Claude Code only"). The ## TaskCreate
# projection layer section (and any subsection it contains) is excluded because
# the section's own preamble + §5 codex_host_suppressed gate cover the whole block.
# ---------------------------------------------------------------------------------
check_taskcreate_gate() {
  local fail=0
  local target="${REPO_ROOT}/commands/masterplan.md"

  if [[ ! -f "${target}" ]]; then
    echo "Skipping taskcreate-gate check: ${target} not found"
    return
  fi

  # Map the ## TaskCreate projection layer section range (inclusive)
  # so internal definitions count as gated by the section's own preamble.
  local section_start section_end
  section_start=$(grep -n "^## TaskCreate projection layer" "${target}" | head -1 | cut -d: -f1)
  if [[ -n "${section_start}" ]]; then
    section_end=$(awk -v s="${section_start}" 'NR>s && /^## /{print NR-1; exit}' "${target}")
  fi

  while IFS=: read -r ln _; do
    [[ -z "${ln}" ]] && continue
    # Skip lines inside the projection-spec section itself (gated by its preamble + §5).
    if [[ -n "${section_start}" && -n "${section_end}" && "${ln}" -ge "${section_start}" && "${ln}" -le "${section_end}" ]]; then
      continue
    fi
    local start=$(( ln > 8 ? ln - 8 : 1 ))
    local end=$(( ln + 1 ))
    local ctx
    ctx=$(sed -n "${start},${end}p" "${target}")
    if ! echo "${ctx}" | grep -qE "codex_host_suppressed == false|Claude Code only|codex_host_suppressed == true"; then
      echo "GAP ${target#${REPO_ROOT}/}:${ln} — TaskCreate/Update/List without Codex gate"
      fail=1
      EXIT=1
    fi
  done < <(grep -nE "TaskCreate|TaskUpdate|TaskList" "${target}")

  if [[ "${fail}" -eq 0 ]]; then
    echo "✓ taskcreate-gate: all TaskCreate/Update/List mentions are inside Codex no-op gate"
  fi
  return "${fail}"
}

check_cc3_trampoline() {
  local fail=0
  grep -q 'CC-3-trampoline' commands/masterplan.md || { echo "FAIL: CC-3-trampoline missing from router"; fail=1; }
  grep -q 'CC-3-trampoline' parts/step-0.md       || { echo "FAIL: CC-3-trampoline missing from step-0"; fail=1; }
  [ $fail -eq 0 ] && echo "CC-3-trampoline: PASS"
  return $fail
}

check_cd9_coverage() {
  local fail=0
  if ! grep -r -l 'CD-9' parts/ 2>/dev/null | head -1 > /dev/null; then
    echo "WARN: CD-9 not referenced in any parts/* file"
  fi
  # Sample check: parts/step-c.md should reference CD-9 (canonical writer)
  grep -q 'CD-9' parts/step-c.md 2>/dev/null || { echo "WARN: step-c.md does not reference CD-9"; fail=1; }
  [ $fail -eq 0 ] && echo "CD-9 coverage: PASS" || echo "CD-9 coverage: WARN"
  return 0
}

check_dispatch_sites() {
  local fail=0
  if ! grep -q 'DISPATCH-SITE: step-c.md' parts/step-c.md 2>/dev/null; then
    echo "FAIL: DISPATCH-SITE: step-c.md tags missing from step-c.md"; fail=1
  fi
  # Negative: router must NOT carry dispatch-site tags (no dispatch happens in router)
  if grep -q 'DISPATCH-SITE:' commands/masterplan.md 2>/dev/null; then
    echo "FAIL: router has DISPATCH-SITE tag (should be in phase files only)"; fail=1
  fi
  [ $fail -eq 0 ] && echo "DISPATCH-SITE: PASS"
  return $fail
}

check_sentinel_v4_refs() {
  # No file in parts/ should reference v4 monolith line numbers
  if grep -r -E 'commands/masterplan\.md:[0-9]+' parts/ 2>/dev/null; then
    echo "FAIL: parts/* contains v4 monolith line-number reference"
    return 1
  fi
  echo "sentinel (no v4 refs): PASS"
}

check_plan_format() {
  # delegate to doctor check #35 logic
  local fail=0
  for plan in docs/masterplan/*/plan.md; do
    grep -E '^### Task [0-9]+' "$plan" | while read -r task_heading; do
      :  # check #35 already walks tasks; here we just confirm one task per bundle has markers
    done
    if grep -q -F '**Spec:**' "$plan" && grep -q -F '**Verify:**' "$plan"; then
      :
    else
      echo "FAIL: $plan missing v5 plan-format markers"; fail=1
    fi
  done
  [ $fail -eq 0 ] && echo "plan-format: PASS"
  return $fail
}

# ---------------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------------
[[ "${RUN_DRIFT}" -eq 1 ]] && check_drift
[[ "${RUN_DRIFT}" -eq 1 ]] && check_skill_drift
[[ "${RUN_CODEX}" -eq 1 ]] && check_codex_packaging
[[ "${RUN_CD9}" -eq 1 ]] && check_cd9
[[ "${RUN_MODELS}" -eq 1 ]] && check_model_passthrough
[[ "${RUN_ANCHOR}" -eq 1 ]] && check_brainstorm_anchor
[[ "${RUN_SESSION_AUDIT}" -eq 1 ]] && check_session_audit
[[ "${RUN_LOOP_FIRST}" -eq 1 ]] && check_loop_first_contract
[[ "${RUN_BRIEF_STYLE}" -eq 1 ]] && check_brief_style
[[ "${RUN_TASKCREATE_GATE}" -eq 1 ]] && check_taskcreate_gate
check_cc3_trampoline || EXIT=1
check_cd9_coverage
check_dispatch_sites || EXIT=1
check_sentinel_v4_refs || EXIT=1
check_plan_format || EXIT=1

if [[ "${EXIT}" -eq 0 ]]; then
  echo "✓ self-host audit clean"
fi

exit "${EXIT}"
