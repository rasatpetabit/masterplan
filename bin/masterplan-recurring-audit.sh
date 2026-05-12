#!/usr/bin/env bash
# masterplan-recurring-audit.sh - Persist a redacted recurring Masterplan audit.

set -u

usage() {
  sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

case "${1:-}" in
  -h|--help) usage 0 ;;
  "") ;;
  *) echo "unknown arg: $1" >&2; usage 2 ;;
esac

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
state_dir="${MASTERPLAN_AUDIT_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/superpowers-masterplan/audits}"
hours="${MASTERPLAN_AUDIT_HOURS:-24}"
retention_days="${MASTERPLAN_AUDIT_RETENTION_DAYS:-14}"
fail_on_warnings="${MASTERPLAN_AUDIT_FAIL_ON_WARNINGS:-0}"

mkdir -p "${state_dir}" || exit 2

lock_dir="${state_dir}/.lock"
if ! mkdir "${lock_dir}" 2>/dev/null; then
  echo "masterplan recurring audit already running: ${lock_dir}" >&2
  exit 0
fi
trap 'rm -rf "${lock_dir}"' EXIT INT TERM

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
json_file="${state_dir}/audit-${stamp}.json"
table_file="${state_dir}/audit-${stamp}.txt"
tmp_json="${json_file}.tmp.$$"
tmp_table="${table_file}.tmp.$$"

if ! "${repo_root}/bin/masterplan-session-audit.sh" --hours="${hours}" --format=json >"${tmp_json}"; then
  status=$?
  rm -f "${tmp_json}" "${tmp_table}"
  echo "masterplan recurring audit failed during JSON scan" >&2
  exit "${status}"
fi

if ! "${repo_root}/bin/masterplan-session-audit.sh" --hours="${hours}" >"${tmp_table}"; then
  status=$?
  rm -f "${tmp_json}" "${tmp_table}"
  echo "masterplan recurring audit failed during table render" >&2
  exit "${status}"
fi

mv "${tmp_json}" "${json_file}"
mv "${tmp_table}" "${table_file}"
cp "${json_file}" "${state_dir}/latest.json"
cp "${table_file}" "${state_dir}/latest.txt"

summary="$(
  python3 - "${json_file}" "${state_dir}/history.jsonl" "${state_dir}/findings.jsonl" "${stamp}" <<'PY'
import json
import sys
from pathlib import Path

json_path = Path(sys.argv[1])
history_path = Path(sys.argv[2])
findings_path = Path(sys.argv[3])
run_id = sys.argv[4]

data = json.loads(json_path.read_text())
warnings = data.get("warnings", [])
repos = data.get("repo_totals", {})

history = {
    "run_id": run_id,
    "cutoff": data.get("cutoff", ""),
    "repo_count": len(repos),
    "warning_count": len(warnings),
    "sources": data.get("sources", {}),
}
with history_path.open("a") as handle:
    handle.write(json.dumps(history, sort_keys=True) + "\n")

if warnings:
    with findings_path.open("a") as handle:
        for warning in warnings:
            row = {"run_id": run_id, "cutoff": data.get("cutoff", "")}
            row.update(warning)
            handle.write(json.dumps(row, sort_keys=True) + "\n")

print(f"run_id={run_id} repos={len(repos)} warnings={len(warnings)}")
PY
)"

if [[ "${retention_days}" =~ ^[0-9]+$ ]] && [[ "${retention_days}" -gt 0 ]]; then
  find "${state_dir}" -maxdepth 1 -type f \( -name 'audit-*.json' -o -name 'audit-*.txt' \) -mtime +"${retention_days}" -delete
fi

echo "masterplan recurring audit complete: ${summary}"
echo "latest_json=${state_dir}/latest.json"
echo "latest_table=${state_dir}/latest.txt"

warning_count="${summary##*warnings=}"
warning_count="${warning_count%% *}"
if [[ "${fail_on_warnings}" == "1" && "${warning_count}" != "0" ]]; then
  exit 1
fi
