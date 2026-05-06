#!/usr/bin/env bash
# masterplan-self-host-audit.sh — developer-only audit checks for the superpowers-masterplan repo.
#
# Replaces doctor checks #25 (deployment drift) and #27 (orchestrator free-text user questions)
# that previously lived in commands/masterplan.md. Those checks were embedded in the runtime
# orchestrator but only fired inside this repo — moving them here keeps the user-facing
# orchestrator (which ships to every /masterplan installation) clean of dev-only logic.
#
# Drift coverage: commands/masterplan.md, hooks/masterplan-telemetry.sh,
# bin/masterplan-routing-stats.sh, AND skills/<name>/SKILL.md for every skill the plugin ships.
# A user-level copy at ~/.claude/skills/<name>/ shadows the plugin's registration and shows up
# as a duplicate slash command — caught here.
#
# Usage:
#   bin/masterplan-self-host-audit.sh           # run both checks (default)
#   bin/masterplan-self-host-audit.sh --fix     # also apply --fix actions for drift
#   bin/masterplan-self-host-audit.sh --drift   # only check deployment drift
#   bin/masterplan-self-host-audit.sh --cd9     # only check free-text user questions
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

case "${MODE}" in
  --fix)   FIX_MODE=1 ;;
  --drift) RUN_CD9=0 ;;
  --cd9)   RUN_DRIFT=0 ;;
  "")      : ;;
  *)       echo "Usage: $0 [--fix|--drift|--cd9]" >&2; exit 2 ;;
esac

EXIT=0

# ---------------------------------------------------------------------------------
# Check: self-host deployment drift (was orchestrator doctor check #25, v2.9.0+)
# ---------------------------------------------------------------------------------
check_drift() {
  local user_cmds="${HOME}/.claude/commands/masterplan.md"
  local user_hook="${HOME}/.claude/hooks/masterplan-telemetry.sh"
  local user_bin="${HOME}/.claude/bin/masterplan-routing-stats.sh"
  local repo_cmds="${REPO_ROOT}/commands/masterplan.md"
  local repo_hook="${REPO_ROOT}/hooks/masterplan-telemetry.sh"
  local repo_bin="${REPO_ROOT}/bin/masterplan-routing-stats.sh"

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
# Check: orchestrator free-text user questions (was doctor check #27, v2.10.0)
# ---------------------------------------------------------------------------------
check_cd9() {
  local file="${REPO_ROOT}/commands/masterplan.md"
  if [[ ! -f "${file}" ]]; then
    echo "Skipping CD-9 check: ${file} not found"
    return
  fi

  local pattern_re='ask the user|prompt the user|request that the user|request the user|confirm with the user|wait for the user'\''?s? (response|to)|the user must (confirm|choose|decide|pick)'

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
    if echo "${context}" | grep -qF "AskUserQuestion"; then
      continue
    fi
    # Skip if inline cd9-exempt marker is nearby.
    if echo "${context}" | grep -qF "cd9-exempt"; then
      continue
    fi
    # Skip if inside CD-9 rule definition or "Don't stop silently" restatement.
    if echo "${context}" | grep -qF "**CD-9**"; then
      continue
    fi
    if echo "${context}" | grep -qF "Don't stop silently"; then
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
# Run
# ---------------------------------------------------------------------------------
[[ "${RUN_DRIFT}" -eq 1 ]] && check_drift
[[ "${RUN_DRIFT}" -eq 1 ]] && check_skill_drift
[[ "${RUN_CD9}" -eq 1 ]] && check_cd9

if [[ "${EXIT}" -eq 0 ]]; then
  echo "✓ self-host audit clean"
fi

exit "${EXIT}"
