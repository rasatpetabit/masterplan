#!/usr/bin/env bash
# masterplan-audit-schedule.sh - Install/remove the local recurring audit cron.
#
# Usage:
#   bin/masterplan-audit-schedule.sh install
#   bin/masterplan-audit-schedule.sh status
#   bin/masterplan-audit-schedule.sh uninstall
#   bin/masterplan-audit-schedule.sh run-now
#
# Environment:
#   MASTERPLAN_AUDIT_CRON      cron expression, default "17 * * * *"
#   MASTERPLAN_AUDIT_STATE_DIR persisted reports directory
#   CRONTAB_FILE               test-only file backend instead of system crontab

set -u

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

mode="${1:-status}"
case "${mode}" in
  install|status|uninstall|run-now) ;;
  -h|--help) usage 0 ;;
  *) echo "unknown mode: ${mode}" >&2; usage 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
audit_script="${repo_root}/bin/masterplan-recurring-audit.sh"
state_dir="${MASTERPLAN_AUDIT_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/superpowers-masterplan/audits}"
cron_expr="${MASTERPLAN_AUDIT_CRON:-17 * * * *}"
begin="# BEGIN MASTERPLAN RECURRING AUDIT"
end="# END MASTERPLAN RECURRING AUDIT"

quote() {
  printf "%q" "$1"
}

read_crontab() {
  if [[ -n "${CRONTAB_FILE:-}" ]]; then
    if [[ -f "${CRONTAB_FILE}" ]]; then
      cat "${CRONTAB_FILE}"
    fi
    return
  fi

  crontab -l 2>/dev/null || true
}

write_crontab() {
  if [[ -n "${CRONTAB_FILE:-}" ]]; then
    mkdir -p "$(dirname "${CRONTAB_FILE}")"
    cat >"${CRONTAB_FILE}"
    return
  fi

  crontab -
}

strip_managed_block() {
  awk -v begin="${begin}" -v end="${end}" '
    $0 == begin { inside = 1; next }
    $0 == end { inside = 0; next }
    !inside { print }
  '
}

managed_block() {
  local quoted_state quoted_script
  quoted_state="$(quote "${state_dir}")"
  quoted_script="$(quote "${audit_script}")"
  cat <<EOF
${begin}
${cron_expr} MASTERPLAN_AUDIT_STATE_DIR=${quoted_state} ${quoted_script} >/dev/null 2>&1
${end}
EOF
}

case "${mode}" in
  run-now)
    exec "${audit_script}"
    ;;
  status)
    current="$(read_crontab)"
    if printf '%s\n' "${current}" | grep -Fqx "${begin}"; then
      printf '%s\n' "${current}" | sed -n "/^${begin}\$/,/^${end}\$/p"
      exit 0
    fi
    echo "No Masterplan recurring audit cron installed."
    exit 1
    ;;
  install)
    current="$(read_crontab)"
    cleaned="$(printf '%s\n' "${current}" | strip_managed_block)"
    block="$(managed_block)"
    {
      if [[ -n "${cleaned}" ]]; then
        printf '%s\n' "${cleaned}"
      fi
      printf '%s\n' "${block}"
    } | write_crontab
    echo "Installed Masterplan recurring audit cron:"
    printf '%s\n' "${block}"
    ;;
  uninstall)
    current="$(read_crontab)"
    cleaned="$(printf '%s\n' "${current}" | strip_managed_block)"
    printf '%s\n' "${cleaned}" | write_crontab
    echo "Removed Masterplan recurring audit cron."
    ;;
esac
