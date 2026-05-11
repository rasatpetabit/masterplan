#!/usr/bin/env bash
# masterplan-session-audit.sh - Read-only last-N-hours audit for Claude, Codex,
# and /masterplan telemetry logs.
#
# Usage:
#   bin/masterplan-session-audit.sh
#   bin/masterplan-session-audit.sh --hours=24
#   bin/masterplan-session-audit.sh --since=2026-05-10T15:51:23Z
#   bin/masterplan-session-audit.sh --format=json
#   bin/masterplan-session-audit.sh --claude-dir=/tmp/claude --codex-dir=/tmp/codex --repo-roots=/tmp/repos
#
# The report is intentionally content-redacted. It prints repo/session counters,
# tool names, command roots such as git/rg/sed/date, and telemetry sizes. It does
# not print user messages, shell commands, tool arguments, tool results, or
# transcript excerpts.

set -u

hours="24"
since=""
format="table"
claude_dir="${CLAUDE_PROJECTS_DIR:-${HOME}/.claude/projects}"
codex_dir="${CODEX_SESSIONS_DIR:-${HOME}/.codex/sessions}"
repo_roots="${MASTERPLAN_REPO_ROOTS:-${HOME}/dev}"

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

for arg in "$@"; do
  case "$arg" in
    --hours=*)      hours="${arg#--hours=}" ;;
    --since=*)      since="${arg#--since=}" ;;
    --format=*)     format="${arg#--format=}" ;;
    --claude-dir=*) claude_dir="${arg#--claude-dir=}" ;;
    --codex-dir=*)  codex_dir="${arg#--codex-dir=}" ;;
    --repo-roots=*) repo_roots="${arg#--repo-roots=}" ;;
    -h|--help)      usage 0 ;;
    *)              echo "unknown arg: $arg" >&2; usage 2 ;;
  esac
done

case "${format}" in
  table|json) ;;
  *) echo "unknown --format: ${format} (expected: table|json)" >&2; exit 2 ;;
esac

python3 - "$since" "$hours" "$format" "$claude_dir" "$codex_dir" "$repo_roots" <<'PY'
import json
import os
import re
import shlex
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

since_arg, hours_arg, fmt, claude_dir, codex_dir, repo_roots = sys.argv[1:]

CODEX_CALL_LIMIT = 100
CODEX_QUESTION_LIMIT = 5
CODEX_LOOP_LIMIT = 10
CLAUDE_AUQ_LIMIT = 10
CLAUDE_AGENT_LIMIT = 20
SESSIONSTART_LIMIT = 64 * 1024
TELEMETRY_BYTES_LIMIT = 2 * 1024 * 1024
TELEMETRY_LINES_LIMIT = 1000
LOOP_ROOTS = {"git", "date", "sed", "rg"}
QUESTION_TOOLS = {"AskUserQuestion", "Question", "request_user_input"}
AGENT_TOOLS = {"Agent", "Task"}


def parse_ts(value):
    if not value:
        return None
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(float(value), tz=timezone.utc)
        except Exception:
            return None
    text = str(value).strip()
    if not text:
        return None
    text = text.replace("Z", "+00:00")
    if re.match(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}", text):
        text = text.replace(" ", "T", 1)
    if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}([+-])", text):
        text = text[:16] + ":00" + text[16:]
    text = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", text)
    try:
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def compute_cutoff():
    if since_arg:
        dt = parse_ts(since_arg)
        if dt is None:
            print(f"error: --since must be an ISO timestamp, got {since_arg!r}", file=sys.stderr)
            sys.exit(2)
        return dt
    try:
        h = float(hours_arg)
    except Exception:
        print(f"error: --hours must be numeric, got {hours_arg!r}", file=sys.stderr)
        sys.exit(2)
    return datetime.now(timezone.utc) - timedelta(hours=h)


cutoff = compute_cutoff()
cutoff_epoch = cutoff.timestamp()


def safe_repo_label(text):
    text = str(text or "unknown")
    text = re.sub(r"(?i)(api[_-]?key|token|secret|password|passwd|refresh[_-]?token|client[_-]?secret)[=:][^/\s]+", r"\1=[REDACTED]", text)
    text = re.sub(r"[^A-Za-z0-9._@+:-]+", "-", text).strip("-")
    return text[:80] or "unknown"


def repo_from_path(pathish, fallback="unknown"):
    if not pathish:
        return safe_repo_label(fallback)
    try:
        parts = Path(str(pathish)).parts
    except Exception:
        return safe_repo_label(fallback)
    if ".worktrees" in parts:
        idx = parts.index(".worktrees")
        if idx > 0:
            return safe_repo_label(parts[idx - 1])
    for marker in ("dev", "src", "work"):
        if marker in parts:
            idx = len(parts) - 1 - list(reversed(parts)).index(marker)
            if idx + 1 < len(parts):
                return safe_repo_label(parts[idx + 1])
    return safe_repo_label(parts[-1] if parts else fallback)


def repo_from_claude_project(path):
    for parent in [path.parent, path.parent.parent]:
        name = parent.name
        if name.startswith("-"):
            bits = [p for p in name.split("-") if p]
            if "dev" in bits:
                idx = bits.index("dev")
                if idx + 1 < len(bits):
                    return safe_repo_label(bits[idx + 1])
            if bits:
                return safe_repo_label(bits[-1])
    return "unknown"


def session_short(path, session_id=""):
    sid = str(session_id or "")
    if sid:
        return safe_repo_label(sid[:12])
    stem = path.stem
    m = re.search(r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", stem)
    if m:
        return m.group(1)[:12]
    return safe_repo_label(stem[:24])


def iter_jsonl_files(root):
    root_path = Path(root).expanduser()
    if not root_path.exists():
        return
    try:
        iterator = root_path.rglob("*.jsonl")
        for path in iterator:
            try:
                if not path.is_file():
                    continue
                if path.stat().st_mtime < cutoff_epoch:
                    continue
            except OSError:
                continue
            yield path
    except OSError:
        return


def json_lines(path):
    try:
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except Exception:
                    continue
    except OSError:
        return


def record_ts(rec):
    return parse_ts(
        rec.get("timestamp")
        or rec.get("ts")
        or rec.get("created_at")
        or (rec.get("payload") or {}).get("timestamp")
        or (rec.get("payload") or {}).get("started_at")
    )


def stringify_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        out = []
        for item in value:
            if isinstance(item, dict):
                out.append(str(item.get("text") or item.get("content") or item.get("input_text") or ""))
            else:
                out.append(str(item))
        return "\n".join(out)
    if isinstance(value, dict):
        return str(value.get("text") or value.get("content") or value.get("message") or "")
    return ""


def command_root(command):
    if not command:
        return ""
    command = command.strip()
    if not command:
        return ""
    try:
        parts = shlex.split(command, posix=True)
    except Exception:
        parts = command.split()
    while parts and re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", parts[0]):
        parts = parts[1:]
    while parts and parts[0] in {"sudo", "env", "command", "time"}:
        parts = parts[1:]
    if not parts:
        return ""
    return Path(parts[0]).name


def extract_command_from_marker(body):
    m = re.search(r"(?m)^\s*command:\s*(.+)$", body or "")
    if m:
        return m.group(1).strip()
    m = re.search(r'"command"\s*:\s*"([^"]+)"', body or "")
    if m:
        return m.group(1)
    return ""


def extract_codex_tool_markers(text):
    markers = []
    for match in re.finditer(r"\[external_agent_tool_call:\s*([^\]]+)\](.*?)\[/external_agent_tool_call\]", text or "", re.S):
        markers.append((match.group(1).strip(), match.group(2)))
    return markers


@dataclass
class SessionStats:
    source: str
    repo: str
    session: str
    path_label: str
    calls: int = 0
    questions: int = 0
    agents: int = 0
    auq: int = 0
    sessionstart_bytes: int = 0
    line_count: int = 0
    latest_ts: str = ""
    masterplan_like: bool = False
    tool_counts: Counter = field(default_factory=Counter)
    command_roots: Counter = field(default_factory=Counter)
    warnings: list = field(default_factory=list)

    def top_loop(self):
        loop_counts = {k: v for k, v in self.command_roots.items() if k in LOOP_ROOTS}
        if not loop_counts:
            return ("", 0)
        return max(loop_counts.items(), key=lambda kv: kv[1])


@dataclass
class TelemetryStats:
    repo: str
    plan: str
    file_label: str
    records: int = 0
    max_bytes: int = 0
    max_lines: int = 0
    latest_ts: str = ""
    warnings: list = field(default_factory=list)


@dataclass
class RepoTotals:
    codex_calls: int = 0
    codex_questions: int = 0
    claude_tools: int = 0
    claude_auq: int = 0
    claude_agents: int = 0
    sessionstart_bytes: int = 0
    telemetry_max_bytes: int = 0
    telemetry_max_lines: int = 0
    warnings: int = 0


def add_latest(stats, ts):
    if ts:
        iso = ts.isoformat().replace("+00:00", "Z")
        if not stats.latest_ts or iso > stats.latest_ts:
            stats.latest_ts = iso


def count_codex_tool(stats, name, body="", arguments=None):
    name = str(name or "unknown").strip() or "unknown"
    stats.calls += 1
    stats.tool_counts[name] += 1
    if name in QUESTION_TOOLS:
        stats.questions += 1
    command = ""
    if isinstance(arguments, dict):
        command = arguments.get("cmd") or arguments.get("command") or ""
    if not command:
        command = extract_command_from_marker(body)
    if name.lower() in {"bash", "shell", "exec_command", "command", "local_shell_call"} or command:
        root = command_root(command)
        if root:
            stats.command_roots[root] += 1


def analyze_codex_file(path):
    stats = SessionStats("codex", repo_from_path("", path.parent.name), "", path.name)
    active = False
    session_id = ""
    cwd = ""
    for rec in json_lines(path):
        stats.line_count += 1
        payload = rec.get("payload") or {}
        if rec.get("type") == "session_meta":
            meta = payload
            session_id = meta.get("id") or session_id
            cwd = meta.get("cwd") or cwd
        cwd = payload.get("cwd") or rec.get("cwd") or cwd
        if cwd:
            stats.repo = repo_from_path(cwd, stats.repo)

        ts = record_ts(rec)
        if ts and ts >= cutoff:
            active = True
            add_latest(stats, ts)
        in_window = ts is not None and ts >= cutoff
        if not in_window:
            continue

        if rec.get("type") == "response_item":
            ptype = payload.get("type")
            if ptype in {"function_call", "tool_call", "local_shell_call", "mcp_call"}:
                count_codex_tool(stats, payload.get("name") or payload.get("tool_name") or ptype, "", payload.get("arguments"))
            if ptype == "message":
                role = payload.get("role")
                text = stringify_content(payload.get("content"))
                if role == "assistant":
                    for name, body in extract_codex_tool_markers(text):
                        count_codex_tool(stats, name, body)
                if "masterplan" in text.lower():
                    stats.masterplan_like = True
        elif rec.get("type") == "event_msg":
            # Event messages duplicate response_item content in imported Codex
            # transcripts. Read only enough to classify masterplan sessions.
            msg = stringify_content(payload.get("message"))
            if "masterplan" in msg.lower():
                stats.masterplan_like = True

    if not active:
        return None
    stats.session = session_short(path, session_id)
    root, root_count = stats.top_loop()
    if stats.calls > CODEX_CALL_LIMIT:
        stats.warnings.append(f"codex calls {stats.calls} > {CODEX_CALL_LIMIT}")
    if stats.questions > CODEX_QUESTION_LIMIT:
        stats.warnings.append(f"codex questions {stats.questions} > {CODEX_QUESTION_LIMIT}")
    if root and root_count >= CODEX_LOOP_LIMIT:
        stats.warnings.append(f"repeated {root} calls {root_count} >= {CODEX_LOOP_LIMIT}")
    return stats


def count_claude_tool(stats, name, item):
    name = str(name or "unknown").strip() or "unknown"
    stats.calls += 1
    stats.tool_counts[name] += 1
    if name in QUESTION_TOOLS:
        stats.auq += 1
        stats.questions += 1
    if name in AGENT_TOOLS:
        stats.agents += 1
    command = ""
    if isinstance(item, dict):
        inp = item.get("input")
        if isinstance(inp, dict):
            command = inp.get("command") or inp.get("cmd") or ""
    if name == "Bash" or command:
        root = command_root(command)
        if root:
            stats.command_roots[root] += 1


def attachment_payload_bytes(att):
    if not isinstance(att, dict):
        return 0
    atype = att.get("type") or ""
    hook_name = att.get("hookName") or ""
    hook_event = att.get("hookEvent") or ""
    if atype == "skill_listing" or hook_name.startswith("SessionStart") or hook_event == "SessionStart":
        total = 0
        for key in ("content", "stdout", "stderr", "command"):
            val = att.get(key)
            if val:
                total += len(str(val).encode("utf-8", errors="replace"))
        return total
    return 0


def analyze_claude_file(path):
    stats = SessionStats("claude", repo_from_claude_project(path), "", path.name)
    active = False
    session_id = ""
    cwd = ""
    for rec in json_lines(path):
        stats.line_count += 1
        session_id = rec.get("sessionId") or session_id
        cwd = rec.get("cwd") or cwd
        if cwd:
            stats.repo = repo_from_path(cwd, stats.repo)

        att = rec.get("attachment")
        stats.sessionstart_bytes += attachment_payload_bytes(att)

        ts = record_ts(rec)
        if ts and ts >= cutoff:
            active = True
            add_latest(stats, ts)
        in_window = ts is not None and ts >= cutoff
        if not in_window:
            continue

        if isinstance(att, dict):
            text = stringify_content(att.get("content"))
            if "masterplan" in text.lower():
                stats.masterplan_like = True

        msg = rec.get("message") or {}
        if isinstance(msg, dict):
            content = msg.get("content")
            role = msg.get("role")
            text = stringify_content(content)
            if "masterplan" in text.lower():
                stats.masterplan_like = True
            if role == "assistant" and isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "tool_use":
                        count_claude_tool(stats, item.get("name"), item)

    if not active:
        return None
    stats.session = session_short(path, session_id or path.parent.name)
    if stats.auq > CLAUDE_AUQ_LIMIT:
        stats.warnings.append(f"AskUserQuestion calls {stats.auq} > {CLAUDE_AUQ_LIMIT}")
    if stats.agents > CLAUDE_AGENT_LIMIT:
        stats.warnings.append(f"Agent/Task calls {stats.agents} > {CLAUDE_AGENT_LIMIT}")
    if stats.sessionstart_bytes > SESSIONSTART_LIMIT:
        kb = stats.sessionstart_bytes // 1024
        stats.warnings.append(f"SessionStart payload {kb}KB > {SESSIONSTART_LIMIT // 1024}KB")
    return stats


def iter_telemetry_files():
    seen = set()
    for root in repo_roots.split(":"):
        root = root.strip()
        if not root:
            continue
        root_path = Path(root).expanduser()
        if not root_path.exists():
            continue
        for path in root_path.glob("**/docs/masterplan/*/telemetry*.jsonl"):
            try:
                if not path.is_file():
                    continue
                if path.stat().st_mtime < cutoff_epoch:
                    continue
            except OSError:
                continue
            resolved = str(path.resolve())
            if resolved in seen:
                continue
            seen.add(resolved)
            yield path


def repo_from_telemetry_path(path):
    parts = path.parts
    if "docs" in parts:
        idx = parts.index("docs")
        if idx > 0:
            repo_path = Path(*parts[:idx])
            return repo_from_path(repo_path, path.parent.parent.name)
    return repo_from_path(path.parent, path.parent.name)


def analyze_telemetry_file(path):
    stats = TelemetryStats(repo_from_telemetry_path(path), path.parent.name, f"{path.parent.name}/{path.name}")
    active = False
    for rec in json_lines(path):
        ts = record_ts(rec)
        if ts is None:
            continue
        if ts < cutoff:
            continue
        active = True
        stats.records += 1
        add_latest(stats, ts)
        try:
            stats.max_bytes = max(stats.max_bytes, int(rec.get("transcript_bytes") or 0))
        except Exception:
            pass
        try:
            stats.max_lines = max(stats.max_lines, int(rec.get("transcript_lines") or 0))
        except Exception:
            pass
    if not active:
        return None
    if stats.max_bytes > TELEMETRY_BYTES_LIMIT:
        mb = stats.max_bytes / (1024 * 1024)
        stats.warnings.append(f"telemetry transcript {mb:.1f}MB > {TELEMETRY_BYTES_LIMIT // (1024 * 1024)}MB")
    if stats.max_lines > TELEMETRY_LINES_LIMIT:
        stats.warnings.append(f"telemetry transcript lines {stats.max_lines} > {TELEMETRY_LINES_LIMIT}")
    return stats


codex_sessions = [s for s in (analyze_codex_file(p) for p in iter_jsonl_files(codex_dir)) if s]
claude_sessions = [s for s in (analyze_claude_file(p) for p in iter_jsonl_files(claude_dir)) if s]
telemetry = [t for t in (analyze_telemetry_file(p) for p in iter_telemetry_files()) if t]

telemetry_repos = {t.repo for t in telemetry}
all_sessions = codex_sessions + claude_sessions
for s in all_sessions:
    if s.masterplan_like and s.repo not in telemetry_repos:
        s.warnings.append("masterplan-like active session has no telemetry in window")

repo_totals = defaultdict(RepoTotals)
for s in codex_sessions:
    rt = repo_totals[s.repo]
    rt.codex_calls += s.calls
    rt.codex_questions += s.questions
    rt.warnings += len(s.warnings)
for s in claude_sessions:
    rt = repo_totals[s.repo]
    rt.claude_tools += s.calls
    rt.claude_auq += s.auq
    rt.claude_agents += s.agents
    rt.sessionstart_bytes += s.sessionstart_bytes
    rt.warnings += len(s.warnings)
for t in telemetry:
    rt = repo_totals[t.repo]
    rt.telemetry_max_bytes = max(rt.telemetry_max_bytes, t.max_bytes)
    rt.telemetry_max_lines = max(rt.telemetry_max_lines, t.max_lines)
    rt.warnings += len(t.warnings)

warnings = []
for s in all_sessions:
    for warning in s.warnings:
        warnings.append({"source": s.source, "repo": s.repo, "session": s.session, "warning": warning})
for t in telemetry:
    for warning in t.warnings:
        warnings.append({"source": "telemetry", "repo": t.repo, "session": t.file_label, "warning": warning})


def as_json():
    def session_dict(s):
        root, root_count = s.top_loop()
        return {
            "source": s.source,
            "repo": s.repo,
            "session": s.session,
            "calls": s.calls,
            "questions": s.questions,
            "auq": s.auq,
            "agents": s.agents,
            "sessionstart_bytes": s.sessionstart_bytes,
            "latest_ts": s.latest_ts,
            "masterplan_like": s.masterplan_like,
            "top_loop_root": root,
            "top_loop_count": root_count,
            "top_tools": s.tool_counts.most_common(8),
            "warnings": s.warnings,
        }

    return {
        "cutoff": cutoff.isoformat().replace("+00:00", "Z"),
        "sources": {
            "claude_dir": safe_repo_label(claude_dir),
            "codex_dir": safe_repo_label(codex_dir),
            "repo_roots": safe_repo_label(repo_roots),
        },
        "repo_totals": {
            repo: {
                "codex_calls": t.codex_calls,
                "codex_questions": t.codex_questions,
                "claude_tools": t.claude_tools,
                "claude_auq": t.claude_auq,
                "claude_agents": t.claude_agents,
                "sessionstart_bytes": t.sessionstart_bytes,
                "telemetry_max_bytes": t.telemetry_max_bytes,
                "telemetry_max_lines": t.telemetry_max_lines,
                "warnings": t.warnings,
            }
            for repo, t in sorted(repo_totals.items())
        },
        "codex_sessions": [session_dict(s) for s in sorted(codex_sessions, key=lambda x: x.calls, reverse=True)],
        "claude_sessions": [session_dict(s) for s in sorted(claude_sessions, key=lambda x: x.calls, reverse=True)],
        "telemetry": [
            {
                "repo": t.repo,
                "plan": t.plan,
                "file": t.file_label,
                "records": t.records,
                "max_bytes": t.max_bytes,
                "max_lines": t.max_lines,
                "latest_ts": t.latest_ts,
                "warnings": t.warnings,
            }
            for t in sorted(telemetry, key=lambda x: x.max_bytes, reverse=True)
        ],
        "warnings": warnings,
    }


def print_table():
    print("Masterplan session audit")
    print(f"cutoff: {cutoff.isoformat().replace('+00:00', 'Z')}")
    print(f"sources: codex_sessions={len(codex_sessions)} claude_sessions={len(claude_sessions)} telemetry_files={len(telemetry)}")
    print("")
    print("Repo totals")
    print("repo                         codex  cq  claude auq agent ss_kb telem_mb telem_ln warn")
    print("---------------------------- ------ --- ------ --- ----- ----- -------- -------- ----")
    rows = sorted(
        repo_totals.items(),
        key=lambda kv: (
            kv[1].warnings,
            kv[1].codex_calls + kv[1].claude_tools,
            kv[1].telemetry_max_bytes,
        ),
        reverse=True,
    )
    for repo, t in rows[:30]:
        print(
            f"{repo[:28]:28} {t.codex_calls:6d} {t.codex_questions:3d} "
            f"{t.claude_tools:6d} {t.claude_auq:3d} {t.claude_agents:5d} "
            f"{t.sessionstart_bytes // 1024:5d} {t.telemetry_max_bytes / (1024*1024):8.1f} "
            f"{t.telemetry_max_lines:8d} {t.warnings:4d}"
        )

    print("")
    print("Top Codex sessions")
    print("repo                         session      calls q loop     warnings")
    print("---------------------------- ------------ ----- - -------- ------------------------------")
    for s in sorted(codex_sessions, key=lambda x: x.calls, reverse=True)[:12]:
        root, root_count = s.top_loop()
        loop = f"{root}:{root_count}" if root else "-"
        warn = "; ".join(s.warnings) if s.warnings else "-"
        print(f"{s.repo[:28]:28} {s.session[:12]:12} {s.calls:5d} {s.questions:1d} {loop[:8]:8} {warn[:80]}")

    print("")
    print("Top Claude sessions")
    print("repo                         session      tools auq agent ss_kb warnings")
    print("---------------------------- ------------ ----- --- ----- ----- ------------------------------")
    for s in sorted(claude_sessions, key=lambda x: (x.calls, x.auq, x.agents), reverse=True)[:12]:
        warn = "; ".join(s.warnings) if s.warnings else "-"
        print(f"{s.repo[:28]:28} {s.session[:12]:12} {s.calls:5d} {s.auq:3d} {s.agents:5d} {s.sessionstart_bytes // 1024:5d} {warn[:80]}")

    print("")
    print("Telemetry warnings")
    shown = False
    for t in sorted(telemetry, key=lambda x: x.max_bytes, reverse=True):
        if not t.warnings:
            continue
        shown = True
        print(f"{t.repo}/{t.plan}: max={t.max_bytes / (1024*1024):.1f}MB lines={t.max_lines} - {'; '.join(t.warnings)}")
    if not shown:
        print("(none)")

    print("")
    print("Warnings")
    if not warnings:
        print("(none)")
    else:
        for w in warnings[:80]:
            print(f"- {w['source']} {w['repo']} {w['session']}: {w['warning']}")
        if len(warnings) > 80:
            print(f"- ... {len(warnings) - 80} more warning(s)")


if fmt == "json":
    print(json.dumps(as_json(), indent=2, sort_keys=True))
else:
    print_table()
PY
