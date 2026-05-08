#!/usr/bin/env bash
# masterplan-state.sh - inventory and migrate /masterplan run state.
#
# New runtime layout:
#   docs/masterplan/<slug>/state.yml
#   docs/masterplan/<slug>/spec.md
#   docs/masterplan/<slug>/plan.md
#   docs/masterplan/<slug>/retro.md
#   docs/masterplan/<slug>/events.jsonl
#
# Legacy layouts migrated by this helper:
#   docs/superpowers/plans/*-status.md
#   docs/superpowers/plans/*.md
#   docs/superpowers/specs/*-design.md
#   docs/superpowers/retros/*-retro.md
#   docs/superpowers/archived-plans/*.md
#   docs/superpowers/archived-specs/*.md
#
# Usage:
#   bin/masterplan-state.sh inventory [--format=table|json]
#   bin/masterplan-state.sh migrate [--dry-run|--write] [--slug=<slug>]
#
# Migration is copy-only. It never deletes legacy artifacts; /masterplan clean
# owns archive/delete decisions after the new bundle has been verified.

set -u

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

mode="${1:-inventory}"
shift || true

format="table"
write_mode=0
slug_filter=""

for arg in "$@"; do
  case "$arg" in
    --format=*) format="${arg#--format=}" ;;
    --dry-run)  write_mode=0 ;;
    --write)    write_mode=1 ;;
    --slug=*)   slug_filter="${arg#--slug=}" ;;
    -h|--help)  usage 0 ;;
    *)          echo "unknown arg: $arg" >&2; usage 2 ;;
  esac
done

case "$mode" in
  inventory|migrate) ;;
  *) echo "unknown mode: $mode" >&2; usage 2 ;;
esac

case "$format" in
  table|json) ;;
  *) echo "unknown --format: $format" >&2; exit 2 ;;
esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "error: not in a git repo" >&2
  exit 2
}

python3 - "$repo_root" "$mode" "$format" "$write_mode" "$slug_filter" <<'PY'
import json
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

repo = Path(sys.argv[1]).resolve()
mode = sys.argv[2]
fmt = sys.argv[3]
write_mode = sys.argv[4] == "1"
slug_filter = sys.argv[5]

NEW_ROOT = Path("docs/masterplan")
LEGACY_PLANS = Path("docs/superpowers/plans")
LEGACY_SPECS = Path("docs/superpowers/specs")
LEGACY_RETROS = Path("docs/superpowers/retros")
ARCHIVED_PLANS = Path("docs/superpowers/archived-plans")
ARCHIVED_SPECS = Path("docs/superpowers/archived-specs")


def rel(path):
    path = Path(path)
    try:
        return path.resolve().relative_to(repo).as_posix()
    except Exception:
        return path.as_posix()


def read_text(path):
    try:
        return Path(path).read_text()
    except Exception:
        return ""


def parse_frontmatter(text):
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    fm = {}
    for line in text[4:end].splitlines():
        if ":" not in line or line.lstrip().startswith("#"):
            continue
        key, value = line.split(":", 1)
        value = value.strip().strip('"').strip("'")
        if "  #" in value:
            value = value.split("  #", 1)[0].strip()
        fm[key.strip()] = value
    return fm


def section(text, heading):
    m = re.search(rf"^##\s+{re.escape(heading)}\s*\n(.*?)(?=\n##\s+|\Z)", text, re.M | re.S)
    return m.group(1).strip() if m else ""


def canonical_slug(name):
    base = Path(name).name
    base = re.sub(r"\.md$", "", base)
    base = re.sub(r"-status(?:-archive)?$", "", base)
    base = re.sub(r"-design$", "", base)
    base = re.sub(r"-retro$", "", base)
    base = re.sub(r"^\d{4}-\d{2}-\d{2}-", "", base)
    return base


def yaml_scalar(value):
    if value is None or value == "":
        return '""'
    if str(value).lower() in {"true", "false", "null"}:
        return str(value).lower()
    text = str(value)
    if re.match(r"^[A-Za-z0-9_./:@+-]+$", text):
        return text
    return json.dumps(text)


def existing_new_runs():
    runs = {}
    root = repo / NEW_ROOT
    if not root.is_dir():
        return runs
    for state in sorted(root.glob("*/state.yml")):
        slug = state.parent.name
        runs[slug] = {"slug": slug, "state": rel(state), "kind": "new"}
    return runs


def find_by_canonical(directory, slug, suffix="*.md"):
    root = repo / directory
    if not root.is_dir():
        return None
    for path in sorted(root.glob(suffix)):
        if path.name.upper() == "README.MD":
            continue
        if canonical_slug(path.name) == slug:
            return path
    return None


def resolve_legacy_path(value, fallback=None):
    if value:
        candidate = Path(value)
        if not candidate.is_absolute():
            candidate = repo / candidate
        if candidate.is_file():
            return candidate
    if fallback and Path(fallback).is_file():
        return Path(fallback)
    return None


def collect_sidecars(status_path, legacy_base):
    sidecars = {}
    parent = status_path.parent if status_path else repo / LEGACY_PLANS
    patterns = {
        "status_archive": f"{legacy_base}-status-archive.md",
        "eligibility_cache": f"{legacy_base}-eligibility-cache.json",
        "telemetry": f"{legacy_base}-telemetry.jsonl",
        "telemetry_archive": f"{legacy_base}-telemetry-archive.jsonl",
        "subagents": f"{legacy_base}-subagents.jsonl",
        "subagents_archive": f"{legacy_base}-subagents-archive.jsonl",
        "subagents_cursor": f"{legacy_base}-subagents-cursor",
        "status_queue": f"{legacy_base}-status.queue.jsonl",
    }
    for key, pattern in patterns.items():
        path = parent / pattern
        if path.exists():
            sidecars[key] = path
    return sidecars


def legacy_status_records():
    records = []
    root = repo / LEGACY_PLANS
    if not root.is_dir():
        return records
    for status_path in sorted(root.glob("*-status.md")):
        text = read_text(status_path)
        fm = parse_frontmatter(text)
        legacy_base = status_path.name[:-len("-status.md")]
        slug = fm.get("slug") or canonical_slug(legacy_base)
        if slug_filter and slug != slug_filter:
            continue
        plan = resolve_legacy_path(fm.get("plan"), root / f"{legacy_base}.md")
        if plan is None:
            plan = find_by_canonical(ARCHIVED_PLANS, slug)
        spec = resolve_legacy_path(fm.get("spec"))
        if spec is None:
            spec = find_by_canonical(ARCHIVED_SPECS, slug)
        retro = find_by_canonical(LEGACY_RETROS, slug)
        records.append({
            "slug": slug,
            "legacy_base": legacy_base,
            "source": "legacy-status",
            "status_path": status_path,
            "frontmatter": fm,
            "activity": section(text, "Activity log"),
            "blockers": section(text, "Blockers"),
            "notes": section(text, "Notes"),
            "plan": plan,
            "spec": spec,
            "retro": retro,
            "sidecars": collect_sidecars(status_path, legacy_base),
        })
    return records


def archived_only_records(existing_slugs):
    records = []
    root = repo / ARCHIVED_PLANS
    if not root.is_dir():
        return records
    for plan in sorted(root.glob("*.md")):
        if plan.name.upper() == "README.MD":
            continue
        slug = canonical_slug(plan.name)
        if slug in existing_slugs:
            continue
        if slug_filter and slug != slug_filter:
            continue
        records.append({
            "slug": slug,
            "legacy_base": plan.stem,
            "source": "archived-plan",
            "status_path": None,
            "frontmatter": {
                "slug": slug,
                "status": "archived",
                "started": "",
                "last_activity": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "current_task": "",
                "next_action": "archived legacy plan migrated",
                "autonomy": "gated",
                "loop_enabled": "false",
                "codex_routing": "off",
                "codex_review": "off",
                "compact_loop_recommended": "false",
                "complexity": "medium",
            },
            "activity": "",
            "blockers": "",
            "notes": "",
            "plan": plan,
            "spec": find_by_canonical(ARCHIVED_SPECS, slug),
            "retro": find_by_canonical(LEGACY_RETROS, slug),
            "sidecars": {},
        })
    return records


def artifact_record(slug, source, spec=None, retro=None):
    label = {
        "legacy-spec": "legacy spec",
        "archived-spec": "legacy spec",
        "legacy-retro": "legacy retro",
    }.get(source, source.replace("-", " "))
    return {
        "slug": slug,
        "legacy_base": Path(spec or retro).stem,
        "source": source,
        "status_path": None,
        "frontmatter": {
            "slug": slug,
            "status": "archived",
            "started": "",
            "last_activity": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "current_task": "",
            "next_action": f"archived {label} migrated",
            "autonomy": "gated",
            "loop_enabled": "false",
            "codex_routing": "off",
            "codex_review": "off",
            "compact_loop_recommended": "false",
            "complexity": "medium",
        },
        "activity": "",
        "blockers": "",
        "notes": "",
        "plan": None,
        "spec": spec,
        "retro": retro,
        "sidecars": {},
    }


def standalone_artifact_records(existing_slugs):
    records = []
    claimed = set(existing_slugs)

    for directory, source in (
        (LEGACY_SPECS, "legacy-spec"),
        (ARCHIVED_SPECS, "archived-spec"),
    ):
        root = repo / directory
        if not root.is_dir():
            continue
        for spec in sorted(root.glob("*.md")):
            if spec.name.upper() == "README.MD":
                continue
            slug = canonical_slug(spec.name)
            if slug in claimed:
                continue
            if slug_filter and slug != slug_filter:
                continue
            retro = find_by_canonical(LEGACY_RETROS, slug)
            records.append(artifact_record(slug, source, spec=spec, retro=retro))
            claimed.add(slug)

    root = repo / LEGACY_RETROS
    if root.is_dir():
        for retro in sorted(root.glob("*.md")):
            if retro.name.upper() == "README.MD":
                continue
            slug = canonical_slug(retro.name)
            if slug in claimed:
                continue
            if slug_filter and slug != slug_filter:
                continue
            records.append(artifact_record(slug, "legacy-retro", retro=retro))
            claimed.add(slug)

    return records


def inventory():
    new_runs = existing_new_runs()
    legacy = legacy_status_records()
    legacy_slugs = {r["slug"] for r in legacy}
    archived = archived_only_records(legacy_slugs)
    standalone = standalone_artifact_records(legacy_slugs | {r["slug"] for r in archived})
    return {
        "new_runs": list(new_runs.values()),
        "legacy_records": [
            {
                "slug": r["slug"],
                "source": r["source"],
                "status": rel(r["status_path"]) if r["status_path"] else None,
                "plan": rel(r["plan"]) if r["plan"] else None,
                "spec": rel(r["spec"]) if r["spec"] else None,
                "retro": rel(r["retro"]) if r["retro"] else None,
                "sidecars": {k: rel(v) for k, v in r["sidecars"].items()},
            }
            for r in legacy + archived + standalone
        ],
    }


def legacy_line_event(line, source, record, event_type="legacy_activity"):
    line = line.strip()
    if not line:
        return None
    body = line[2:] if line.startswith("- ") else line
    m = re.match(r"(\d{4}-\d{2}-\d{2}[T ][^ ]+)\s*(.*)", body)
    payload = {
        "schema_version": 1,
        "type": event_type,
        "source": source,
        "legacy_status": rel(record["status_path"]) if record["status_path"] else "",
        "message": body,
    }
    if m:
        payload["ts"] = m.group(1)
        payload["message"] = m.group(2).strip() or body
    else:
        payload["ts"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    return payload


def write_events(target, record):
    events = target / "events.jsonl"
    with events.open("w") as out:
        if record["activity"]:
            for line in record["activity"].splitlines():
                payload = legacy_line_event(line, "legacy-activity-log", record)
                if payload:
                    out.write(json.dumps(payload, sort_keys=True) + "\n")
        else:
            out.write(json.dumps({
                "schema_version": 1,
                "type": "migration",
                "source": record["source"],
                "message": "legacy artifact migrated into run bundle",
                "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }, sort_keys=True) + "\n")
        for event_type, source, body in (
            ("legacy_blocker", "legacy-blockers", record.get("blockers", "")),
            ("legacy_note", "legacy-notes", record.get("notes", "")),
        ):
            for line in body.splitlines():
                payload = legacy_line_event(line, source, record, event_type=event_type)
                if payload:
                    out.write(json.dumps(payload, sort_keys=True) + "\n")

    archive_src = record["sidecars"].get("status_archive")
    if archive_src and archive_src.is_file():
        archive_dst = target / "events-archive.jsonl"
        with archive_dst.open("w") as out:
            for line in read_text(archive_src).splitlines():
                if not line.strip() or line.lstrip().startswith("#"):
                    continue
                payload = legacy_line_event(line, "legacy-status-archive", record)
                if payload:
                    out.write(json.dumps(payload, sort_keys=True) + "\n")
    return events


def copy_if_present(src, dst):
    if not src:
        return None
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    return dst


def write_state(target, record, copied):
    fm = record["frontmatter"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    lines = [
        "schema_version: 2",
        f"slug: {yaml_scalar(record['slug'])}",
        f"status: {yaml_scalar(fm.get('status', 'in-progress'))}",
        f"phase: {yaml_scalar('archived' if fm.get('status') == 'archived' else 'ready')}",
        f"worktree: {yaml_scalar(fm.get('worktree', str(repo)))}",
        f"branch: {yaml_scalar(fm.get('branch', ''))}",
        f"started: {yaml_scalar(fm.get('started', ''))}",
        f"last_activity: {yaml_scalar(fm.get('last_activity', now))}",
        f"current_task: {yaml_scalar(fm.get('current_task', ''))}",
        f"next_action: {yaml_scalar(fm.get('next_action', ''))}",
        f"autonomy: {yaml_scalar(fm.get('autonomy', 'gated'))}",
        f"loop_enabled: {yaml_scalar(fm.get('loop_enabled', 'false'))}",
        f"codex_routing: {yaml_scalar(fm.get('codex_routing', 'off'))}",
        f"codex_review: {yaml_scalar(fm.get('codex_review', 'off'))}",
        f"compact_loop_recommended: {yaml_scalar(fm.get('compact_loop_recommended', 'false'))}",
        f"complexity: {yaml_scalar(fm.get('complexity', 'medium'))}",
        "pending_gate: null",
        "artifacts:",
        f"  spec: {yaml_scalar(rel(copied.get('spec')) if copied.get('spec') else '')}",
        f"  plan: {yaml_scalar(rel(copied.get('plan')) if copied.get('plan') else '')}",
        f"  retro: {yaml_scalar(rel(copied.get('retro')) if copied.get('retro') else '')}",
        f"  events: {yaml_scalar(rel(copied.get('events')) if copied.get('events') else '')}",
        f"  events_archive: {yaml_scalar(rel(copied.get('events_archive')) if copied.get('events_archive') else '')}",
        f"  eligibility_cache: {yaml_scalar(rel(copied.get('eligibility_cache')) if copied.get('eligibility_cache') else '')}",
        f"  telemetry: {yaml_scalar(rel(copied.get('telemetry')) if copied.get('telemetry') else '')}",
        f"  telemetry_archive: {yaml_scalar(rel(copied.get('telemetry_archive')) if copied.get('telemetry_archive') else '')}",
        f"  subagents: {yaml_scalar(rel(copied.get('subagents')) if copied.get('subagents') else '')}",
        f"  subagents_archive: {yaml_scalar(rel(copied.get('subagents_archive')) if copied.get('subagents_archive') else '')}",
        f"  state_queue: {yaml_scalar(rel(copied.get('state_queue')) if copied.get('state_queue') else '')}",
        "legacy:",
        f"  migrated_at: {yaml_scalar(now)}",
        f"  source: {yaml_scalar(record['source'])}",
        f"  status: {yaml_scalar(rel(record['status_path']) if record['status_path'] else '')}",
        f"  plan: {yaml_scalar(rel(record['plan']) if record['plan'] else '')}",
        f"  spec: {yaml_scalar(rel(record['spec']) if record['spec'] else '')}",
        f"  retro: {yaml_scalar(rel(record['retro']) if record['retro'] else '')}",
    ]
    sidecars = record["sidecars"]
    lines.append("  sidecars:")
    if sidecars:
        for key, path in sorted(sidecars.items()):
            lines.append(f"    {key}: {yaml_scalar(rel(path))}")
    else:
        lines[-1] = "  sidecars: {}"
    state = target / "state.yml"
    state.write_text("\n".join(lines) + "\n")
    return state


def migrate():
    new_runs = existing_new_runs()
    records = legacy_status_records()
    records += archived_only_records({r["slug"] for r in records})
    records += standalone_artifact_records({r["slug"] for r in records})
    actions = []
    for record in records:
        slug = record["slug"]
        if slug in new_runs:
            actions.append({"slug": slug, "action": "skip", "reason": "state.yml already exists", "target": new_runs[slug]["state"]})
            continue
        target = repo / NEW_ROOT / slug
        if not write_mode:
            actions.append({"slug": slug, "action": "would-migrate", "target": rel(target), "source": record["source"]})
            continue
        target.mkdir(parents=True, exist_ok=True)
        copied = {}
        copied["spec"] = copy_if_present(record["spec"], target / "spec.md")
        copied["plan"] = copy_if_present(record["plan"], target / "plan.md")
        copied["retro"] = copy_if_present(record["retro"], target / "retro.md")
        copied["events"] = write_events(target, record)
        if (target / "events-archive.jsonl").is_file():
            copied["events_archive"] = target / "events-archive.jsonl"
        sidecars = record["sidecars"]
        sidecar_map = {
            "eligibility_cache": "eligibility-cache.json",
            "telemetry": "telemetry.jsonl",
            "telemetry_archive": "telemetry-archive.jsonl",
            "subagents": "subagents.jsonl",
            "subagents_archive": "subagents-archive.jsonl",
            "status_queue": "state.queue.jsonl",
        }
        for key, dst_name in sidecar_map.items():
            copied["state_queue" if key == "status_queue" else key] = copy_if_present(sidecars.get(key), target / dst_name)
        copied["state"] = write_state(target, record, copied)
        actions.append({
            "slug": slug,
            "action": "migrated",
            "target": rel(target),
            "source": record["source"],
            "state": rel(copied["state"]),
        })
    return actions


if mode == "inventory":
    data = inventory()
    if fmt == "json":
        print(json.dumps(data, indent=2, sort_keys=True))
    else:
        print(f"new runs: {len(data['new_runs'])}")
        for item in data["new_runs"]:
            print(f"  {item['slug']}: {item['state']}")
        print(f"legacy records: {len(data['legacy_records'])}")
        for item in data["legacy_records"]:
            src = item["status"] or item["plan"] or "(unknown)"
            print(f"  {item['slug']}: {item['source']} from {src}")
elif mode == "migrate":
    actions = migrate()
    if fmt == "json":
        print(json.dumps({"write": write_mode, "actions": actions}, indent=2, sort_keys=True))
    else:
        verb = "write" if write_mode else "dry-run"
        print(f"migration {verb}: {len(actions)} record(s)")
        for action in actions:
            print(f"  {action['slug']}: {action['action']} -> {action.get('target', '')}")
PY
