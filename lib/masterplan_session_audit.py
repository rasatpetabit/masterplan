#!/usr/bin/env python3
"""Read-only incident audit for Claude, Codex, and /masterplan telemetry logs."""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
STOP_KIND_UNKNOWN = "unknown"
SESSION_ROLE_PRIMARY = "primary"
SESSION_ROLE_GUARDIAN = "guardian"
SESSION_ROLE_SUBAGENT = "subagent"
AUXILIARY_SESSION_ROLES = {SESSION_ROLE_GUARDIAN, SESSION_ROLE_SUBAGENT}
STOP_SIGNAL_RE = {
    "question": re.compile(r"(?i)\b(Gate pending:|AskUserQuestion\(|request_user_input|pending_gate\b|question_opened)\b"),
    "critical_error": re.compile(r"(?i)\b(critical_error|critical error|status:\s*blocked|phase:\s*blocked|critical_error_opened)\b"),
    "complete": re.compile(r"(?i)\b(status:\s*complete|phase:\s*complete|status\s+is\s+complete|run complete|marked .*complete|(?:task\s+)?(?:T\d+\s+)?is\s+complete)\b"),
    "scheduled_yield": re.compile(r"(?i)\b(continuation_scheduled|wakeup_scheduled|ScheduleWakeup\(|scheduled wakeup)\b"),
    "resumable_yield": re.compile(
        r"(?i)\b(Codex host budget reached:|state preserved; (?:resume with|send a normal Codex chat message)|Use masterplan (?:next|execute|--resume=)|/masterplan --resume=)\b"
    ),
}

USER_MASTERPLAN_ACTIVITY_RE = re.compile(
    r"(?imx)"
    r"("
    r"^\s*/(?:superpowers-masterplan:)?masterplan\b"
    r"|\buse\s+(?:/)?(?:superpowers-masterplan:)?masterplan\b"
    r"|\b(?:run|invoke|resume|continue|check|doctor|status)\s+(?:the\s+)?masterplan\b"
    r"|\bmasterplan\s+(?:full|brainstorm|plan|execute|import|doctor|status|stats|clean|next|retro|resume)\b"
    r")"
)

ASSISTANT_MASTERPLAN_ACTIVITY_RE = re.compile(
    r"(?imx)"
    r"("
    r"^→\s*/masterplan\b"
    r"|Running\s+inside\s+Codex\s+—\s+skipping\s+`codex:codex-rescue`"
    r"|Codex\s+host\s+budget\s+reached:"
    r"|Gate\s+pending:\s+\S+\s+—\s+(?:no\s+selection\s+received|recommended\s+option\s+was\s+not\s+treated\s+as\s+consent)"
    r")"
)


@dataclass(frozen=True)
class WarningItem:
    code: str
    text: str


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
    stop_kind: str = STOP_KIND_UNKNOWN
    stop_signal_seen: bool = False
    session_role: str = SESSION_ROLE_PRIMARY
    tool_counts: Counter = field(default_factory=Counter)
    command_roots: Counter = field(default_factory=Counter)
    warnings: list[WarningItem] = field(default_factory=list)

    def add_warning(self, code: str, text: str) -> None:
        self.warnings.append(WarningItem(code, text))

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
    warnings: list[WarningItem] = field(default_factory=list)

    def add_warning(self, code: str, text: str) -> None:
        self.warnings.append(WarningItem(code, text))


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


def compute_cutoff(since_arg: str, hours_arg: str, now: datetime | None = None):
    if since_arg:
        dt = parse_ts(since_arg)
        if dt is None:
            raise ValueError(f"--since must be an ISO timestamp, got {since_arg!r}")
        return dt
    try:
        hours = float(hours_arg)
    except Exception as exc:
        raise ValueError(f"--hours must be numeric, got {hours_arg!r}") from exc
    now = now or datetime.now(timezone.utc)
    return now - timedelta(hours=hours)


def safe_repo_label(text):
    text = str(text or "unknown")
    text = re.sub(
        r"(?i)(api[_-]?key|token|secret|password|passwd|refresh[_-]?token|client[_-]?secret)[=:][^/\s]+",
        r"\1=[REDACTED]",
        text,
    )
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
    match = re.search(r"([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})", stem)
    if match:
        return match.group(1)[:12]
    return safe_repo_label(stem[:24])


def iter_jsonl_files(root, cutoff_epoch):
    root_path = Path(root).expanduser()
    if not root_path.exists():
        return
    try:
        for path in root_path.rglob("*.jsonl"):
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
    match = re.search(r"(?m)^\s*command:\s*(.+)$", body or "")
    if match:
        return match.group(1).strip()
    match = re.search(r'"command"\s*:\s*"([^"]+)"', body or "")
    if match:
        return match.group(1)
    return ""


def extract_codex_tool_markers(text):
    markers = []
    for match in re.finditer(r"\[external_agent_tool_call:\s*([^\]]+)\](.*?)\[/external_agent_tool_call\]", text or "", re.S):
        markers.append((match.group(1).strip(), match.group(2)))
    return markers


def has_masterplan_activity(text, role=""):
    """Detect active /masterplan use, not ambient references to this repo/tool."""
    text = str(text or "")
    role = str(role or "")
    if role == "user":
        return USER_MASTERPLAN_ACTIVITY_RE.search(text) is not None
    if role == "assistant":
        return ASSISTANT_MASTERPLAN_ACTIVITY_RE.search(text) is not None
    return (
        USER_MASTERPLAN_ACTIVITY_RE.search(text) is not None
        or ASSISTANT_MASTERPLAN_ACTIVITY_RE.search(text) is not None
    )


def classify_stop_text(text):
    text = str(text or "")
    for kind, pattern in STOP_SIGNAL_RE.items():
        if pattern.search(text):
            return kind
    return ""


def classify_codex_session_role(meta):
    source = meta.get("source")
    thread_source = meta.get("thread_source")
    model = str(meta.get("model") or "")

    if model == "codex-auto-review":
        return SESSION_ROLE_GUARDIAN

    if isinstance(source, dict):
        subagent = source.get("subagent")
        if isinstance(subagent, dict):
            if subagent.get("other") == "guardian":
                return SESSION_ROLE_GUARDIAN
            return SESSION_ROLE_SUBAGENT

    if thread_source == "subagent":
        return SESSION_ROLE_SUBAGENT

    return SESSION_ROLE_PRIMARY


def is_auxiliary_session(stats):
    return stats.session_role in AUXILIARY_SESSION_ROLES


def goal_outcome(stats):
    if is_auxiliary_session(stats):
        return "auxiliary"
    if stats.stop_kind != STOP_KIND_UNKNOWN:
        return stats.stop_kind
    return STOP_KIND_UNKNOWN


def goal_failure_reasons(stats):
    if is_auxiliary_session(stats):
        return []

    warning_codes = {warning.code for warning in stats.warnings}
    reasons = []
    if (
        stats.stop_kind != "complete"
        and ("codex_calls_high" in warning_codes or "repeated_command_root" in warning_codes)
    ):
        reasons.append("tool_loop")
    if stats.stop_kind != "complete" and "codex_questions_high" in warning_codes:
        reasons.append("question_loop")
    if "active_masterplan_missing_telemetry" in warning_codes:
        reasons.append("missing_telemetry")
    if "active_masterplan_unclassified_stop" in warning_codes:
        reasons.append("unclassified_stop")
    return reasons


def record_stop_signal(stats, kind):
    if not kind:
        stats.stop_signal_seen = True
        return
    stats.stop_kind = kind
    stats.stop_signal_seen = True


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
        record_stop_signal(stats, "question")
    command = ""
    if isinstance(arguments, dict):
        command = arguments.get("cmd") or arguments.get("command") or ""
    if not command:
        command = extract_command_from_marker(body)
    if name.lower() in {"bash", "shell", "exec_command", "command", "local_shell_call"} or command:
        root = command_root(command)
        if root:
            stats.command_roots[root] += 1


def analyze_codex_file(path, cutoff):
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
            stats.session_role = classify_codex_session_role(meta)
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
                    record_stop_signal(stats, classify_stop_text(text))
                    for name, body in extract_codex_tool_markers(text):
                        count_codex_tool(stats, name, body)
                if role in {"user", "assistant"} and has_masterplan_activity(text, role):
                    stats.masterplan_like = True
        elif rec.get("type") == "event_msg":
            msg = stringify_content(payload.get("message"))
            event_role = "assistant"
            if payload.get("type") == "user_message":
                event_role = "user"
            if has_masterplan_activity(msg, event_role):
                stats.masterplan_like = True
            if payload.get("type") == "task_complete":
                final_text = stringify_content(payload.get("last_agent_message") or payload.get("message"))
                record_stop_signal(stats, classify_stop_text(final_text))

    if not active:
        return None
    stats.session = session_short(path, session_id)
    root, root_count = stats.top_loop()
    if stats.calls > CODEX_CALL_LIMIT:
        stats.add_warning("codex_calls_high", f"codex calls {stats.calls} > {CODEX_CALL_LIMIT}")
    if stats.questions > CODEX_QUESTION_LIMIT:
        stats.add_warning("codex_questions_high", f"codex questions {stats.questions} > {CODEX_QUESTION_LIMIT}")
    if root and root_count >= CODEX_LOOP_LIMIT:
        stats.add_warning("repeated_command_root", f"repeated {root} calls {root_count} >= {CODEX_LOOP_LIMIT}")
    if (
        not is_auxiliary_session(stats)
        and stats.masterplan_like
        and stats.stop_signal_seen
        and stats.stop_kind == STOP_KIND_UNKNOWN
    ):
        stats.add_warning("active_masterplan_unclassified_stop", "active masterplan session closed without classified stop reason")
    return stats


def count_claude_tool(stats, name, item):
    name = str(name or "unknown").strip() or "unknown"
    stats.calls += 1
    stats.tool_counts[name] += 1
    if name in QUESTION_TOOLS:
        stats.auq += 1
        stats.questions += 1
        record_stop_signal(stats, "question")
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


def analyze_claude_file(path, cutoff):
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

        msg = rec.get("message") or {}
        if isinstance(msg, dict):
            content = msg.get("content")
            role = msg.get("role")
            text = stringify_content(content)
            if role in {"user", "assistant"} and has_masterplan_activity(text, role):
                stats.masterplan_like = True
            if role == "assistant":
                record_stop_signal(stats, classify_stop_text(text))
            if role == "assistant" and isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get("type") == "tool_use":
                        count_claude_tool(stats, item.get("name"), item)

    if not active:
        return None
    stats.session = session_short(path, session_id or path.parent.name)
    if stats.auq > CLAUDE_AUQ_LIMIT:
        stats.add_warning("claude_auq_high", f"AskUserQuestion calls {stats.auq} > {CLAUDE_AUQ_LIMIT}")
    if stats.agents > CLAUDE_AGENT_LIMIT:
        stats.add_warning("claude_agents_high", f"Agent/Task calls {stats.agents} > {CLAUDE_AGENT_LIMIT}")
    if stats.sessionstart_bytes > SESSIONSTART_LIMIT:
        kb = stats.sessionstart_bytes // 1024
        stats.add_warning("sessionstart_payload_high", f"SessionStart payload {kb}KB > {SESSIONSTART_LIMIT // 1024}KB")
    if (
        not is_auxiliary_session(stats)
        and stats.masterplan_like
        and stats.stop_signal_seen
        and stats.stop_kind == STOP_KIND_UNKNOWN
    ):
        stats.add_warning("active_masterplan_unclassified_stop", "active masterplan session closed without classified stop reason")
    return stats


def iter_telemetry_files(repo_roots, cutoff_epoch):
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
            yield path, root_path


def repo_from_telemetry_path(path, root_path=None):
    if root_path is not None:
        try:
            rel = path.relative_to(root_path)
            parts = rel.parts
            if parts and parts[0] == "docs":
                return repo_from_path(root_path, root_path.name)
            if parts:
                return safe_repo_label(parts[0])
        except ValueError:
            pass

    parts = path.parts
    if "docs" in parts:
        idx = parts.index("docs")
        if idx > 0:
            repo_path = Path(*parts[:idx])
            return repo_from_path(repo_path, path.parent.parent.name)
    return repo_from_path(path.parent, path.parent.name)


def analyze_telemetry_file(path, cutoff, root_path=None):
    stats = TelemetryStats(repo_from_telemetry_path(path, root_path), path.parent.name, f"{path.parent.name}/{path.name}")
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
        stats.add_warning("telemetry_transcript_bytes_high", f"telemetry transcript {mb:.1f}MB > {TELEMETRY_BYTES_LIMIT // (1024 * 1024)}MB")
    if stats.max_lines > TELEMETRY_LINES_LIMIT:
        stats.add_warning("telemetry_transcript_lines_high", f"telemetry transcript lines {stats.max_lines} > {TELEMETRY_LINES_LIMIT}")
    return stats


def warning_texts(warnings):
    return [warning.text for warning in warnings]


def run_audit(since_arg, hours_arg, fmt, claude_dir, codex_dir, repo_roots, now=None):
    cutoff = compute_cutoff(since_arg, hours_arg, now)
    cutoff_epoch = cutoff.timestamp()

    codex_sessions = [s for s in (analyze_codex_file(p, cutoff) for p in iter_jsonl_files(codex_dir, cutoff_epoch)) if s]
    claude_sessions = [s for s in (analyze_claude_file(p, cutoff) for p in iter_jsonl_files(claude_dir, cutoff_epoch)) if s]
    telemetry = [
        t
        for t in (
            analyze_telemetry_file(path, cutoff, root_path)
            for path, root_path in iter_telemetry_files(repo_roots, cutoff_epoch)
        )
        if t
    ]

    telemetry_repos = {t.repo for t in telemetry}
    all_sessions = codex_sessions + claude_sessions
    for session in all_sessions:
        if (
            not is_auxiliary_session(session)
            and session.masterplan_like
            and session.repo not in telemetry_repos
        ):
            session.add_warning("active_masterplan_missing_telemetry", "active masterplan session has no telemetry in window")

    repo_totals = defaultdict(RepoTotals)
    for session in codex_sessions:
        total = repo_totals[session.repo]
        total.codex_calls += session.calls
        total.codex_questions += session.questions
    for session in claude_sessions:
        total = repo_totals[session.repo]
        total.claude_tools += session.calls
        total.claude_auq += session.auq
        total.claude_agents += session.agents
        total.sessionstart_bytes += session.sessionstart_bytes
    for item in telemetry:
        total = repo_totals[item.repo]
        total.telemetry_max_bytes = max(total.telemetry_max_bytes, item.max_bytes)
        total.telemetry_max_lines = max(total.telemetry_max_lines, item.max_lines)

    warnings = []
    seen_warnings = set()

    def add_warning(source, repo, session, warning: WarningItem):
        entry = {
            "source": source,
            "repo": repo,
            "session": session,
            "code": warning.code,
            "warning": warning.text,
        }
        key = (entry["source"], entry["repo"], entry["session"], entry["code"])
        if key in seen_warnings:
            return
        seen_warnings.add(key)
        warnings.append(entry)

    for session in all_sessions:
        for warning in session.warnings:
            add_warning(session.source, session.repo, session.session, warning)
    for item in telemetry:
        for warning in item.warnings:
            add_warning("telemetry", item.repo, item.file_label, warning)
    for warning in warnings:
        repo_totals[warning["repo"]].warnings += 1

    def session_dict(session):
        root, root_count = session.top_loop()
        return {
            "source": session.source,
            "repo": session.repo,
            "session": session.session,
            "calls": session.calls,
            "questions": session.questions,
            "auq": session.auq,
            "agents": session.agents,
            "sessionstart_bytes": session.sessionstart_bytes,
            "latest_ts": session.latest_ts,
            "masterplan_like": session.masterplan_like,
            "session_role": session.session_role,
            "stop_kind": session.stop_kind,
            "goal_outcome": goal_outcome(session),
            "goal_failure_reasons": goal_failure_reasons(session),
            "top_loop_root": root,
            "top_loop_count": root_count,
            "top_tools": session.tool_counts.most_common(8),
            "warnings": warning_texts(session.warnings),
            "warning_codes": [warning.code for warning in session.warnings],
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
                "codex_calls": total.codex_calls,
                "codex_questions": total.codex_questions,
                "claude_tools": total.claude_tools,
                "claude_auq": total.claude_auq,
                "claude_agents": total.claude_agents,
                "sessionstart_bytes": total.sessionstart_bytes,
                "telemetry_max_bytes": total.telemetry_max_bytes,
                "telemetry_max_lines": total.telemetry_max_lines,
                "warnings": total.warnings,
            }
            for repo, total in sorted(repo_totals.items())
        },
        "codex_sessions": [session_dict(s) for s in sorted(codex_sessions, key=lambda item: item.calls, reverse=True)],
        "claude_sessions": [session_dict(s) for s in sorted(claude_sessions, key=lambda item: item.calls, reverse=True)],
        "telemetry": [
            {
                "repo": item.repo,
                "plan": item.plan,
                "file": item.file_label,
                "records": item.records,
                "max_bytes": item.max_bytes,
                "max_lines": item.max_lines,
                "latest_ts": item.latest_ts,
                "warnings": warning_texts(item.warnings),
                "warning_codes": [warning.code for warning in item.warnings],
            }
            for item in sorted(telemetry, key=lambda item: item.max_bytes, reverse=True)
        ],
        "warnings": warnings,
    }


def print_table(data):
    codex_sessions = data["codex_sessions"]
    claude_sessions = data["claude_sessions"]
    telemetry = data["telemetry"]
    repo_totals = data["repo_totals"]
    warnings = data["warnings"]

    print("Masterplan session audit")
    print(f"cutoff: {data['cutoff']}")
    print(f"sources: codex_sessions={len(codex_sessions)} claude_sessions={len(claude_sessions)} telemetry_files={len(telemetry)}")
    print("")
    print("Repo totals")
    print("repo                         codex  cq  claude auq agent ss_kb telem_mb telem_ln warn")
    print("---------------------------- ------ --- ------ --- ----- ----- -------- -------- ----")
    rows = sorted(
        repo_totals.items(),
        key=lambda kv: (
            kv[1]["warnings"],
            kv[1]["codex_calls"] + kv[1]["claude_tools"],
            kv[1]["telemetry_max_bytes"],
        ),
        reverse=True,
    )
    for repo, total in rows[:30]:
        print(
            f"{repo[:28]:28} {total['codex_calls']:6d} {total['codex_questions']:3d} "
            f"{total['claude_tools']:6d} {total['claude_auq']:3d} {total['claude_agents']:5d} "
            f"{total['sessionstart_bytes'] // 1024:5d} {total['telemetry_max_bytes'] / (1024*1024):8.1f} "
            f"{total['telemetry_max_lines']:8d} {total['warnings']:4d}"
        )

    print("")
    print("Started goals at risk")
    print("repo                         session      outcome         calls q loop     reasons")
    print("---------------------------- ------------ --------------- ----- - -------- ------------------------------")
    risk_sessions = [
        session
        for session in codex_sessions + claude_sessions
        if session.get("session_role") == SESSION_ROLE_PRIMARY and session.get("goal_failure_reasons")
    ]
    risk_sessions = sorted(
        risk_sessions,
        key=lambda item: (
            len(item["goal_failure_reasons"]),
            item["calls"],
            item["questions"],
            item["latest_ts"],
        ),
        reverse=True,
    )
    if not risk_sessions:
        print("(none)")
    else:
        for session in risk_sessions[:12]:
            loop = f"{session['top_loop_root']}:{session['top_loop_count']}" if session["top_loop_root"] else "-"
            reasons = ",".join(session["goal_failure_reasons"])
            print(
                f"{session['repo'][:28]:28} {session['session'][:12]:12} "
                f"{session['goal_outcome'][:15]:15} {session['calls']:5d} {session['questions']:1d} "
                f"{loop[:8]:8} {reasons[:80]}"
            )

    print("")
    print("Top Codex sessions")
    print("repo                         session      calls q loop     warnings")
    print("---------------------------- ------------ ----- - -------- ------------------------------")
    for session in codex_sessions[:12]:
        loop = f"{session['top_loop_root']}:{session['top_loop_count']}" if session["top_loop_root"] else "-"
        warn = "; ".join(session["warnings"]) if session["warnings"] else "-"
        print(f"{session['repo'][:28]:28} {session['session'][:12]:12} {session['calls']:5d} {session['questions']:1d} {loop[:8]:8} {warn[:80]}")

    print("")
    print("Top Claude sessions")
    print("repo                         session      tools auq agent ss_kb warnings")
    print("---------------------------- ------------ ----- --- ----- ----- ------------------------------")
    for session in sorted(claude_sessions, key=lambda item: (item["calls"], item["auq"], item["agents"]), reverse=True)[:12]:
        warn = "; ".join(session["warnings"]) if session["warnings"] else "-"
        print(f"{session['repo'][:28]:28} {session['session'][:12]:12} {session['calls']:5d} {session['auq']:3d} {session['agents']:5d} {session['sessionstart_bytes'] // 1024:5d} {warn[:80]}")

    print("")
    print("Telemetry warnings")
    shown = False
    for item in telemetry:
        if not item["warnings"]:
            continue
        shown = True
        print(f"{item['repo']}/{item['plan']}: max={item['max_bytes'] / (1024*1024):.1f}MB lines={item['max_lines']} - {'; '.join(item['warnings'])}")
    if not shown:
        print("(none)")

    print("")
    print("Warnings")
    if not warnings:
        print("(none)")
    else:
        for warning in warnings[:80]:
            print(f"- {warning['source']} {warning['repo']} {warning['session']}: {warning['warning']}")
        if len(warnings) > 80:
            print(f"- ... {len(warnings) - 80} more warning(s)")


def parse_args(argv):
    hours = "24"
    since = ""
    fmt = "table"
    claude_dir = os.environ.get("CLAUDE_PROJECTS_DIR", str(Path.home() / ".claude" / "projects"))
    codex_dir = os.environ.get("CODEX_SESSIONS_DIR", str(Path.home() / ".codex" / "sessions"))
    repo_roots = os.environ.get("MASTERPLAN_REPO_ROOTS", str(Path.home() / "dev"))

    for arg in argv:
        if arg.startswith("--hours="):
            hours = arg.split("=", 1)[1]
        elif arg.startswith("--since="):
            since = arg.split("=", 1)[1]
        elif arg.startswith("--format="):
            fmt = arg.split("=", 1)[1]
        elif arg.startswith("--claude-dir="):
            claude_dir = arg.split("=", 1)[1]
        elif arg.startswith("--codex-dir="):
            codex_dir = arg.split("=", 1)[1]
        elif arg.startswith("--repo-roots="):
            repo_roots = arg.split("=", 1)[1]
        elif arg in {"-h", "--help"}:
            return None
        else:
            raise ValueError(f"unknown arg: {arg}")

    if fmt not in {"table", "json"}:
        raise ValueError(f"unknown --format: {fmt} (expected: table|json)")

    return since, hours, fmt, claude_dir, codex_dir, repo_roots


def usage():
    return """masterplan-session-audit.sh - Read-only last-N-hours audit for Claude, Codex,
and /masterplan telemetry logs.

Usage:
  bin/masterplan-session-audit.sh
  bin/masterplan-session-audit.sh --hours=24
  bin/masterplan-session-audit.sh --since=2026-05-10T15:51:23Z
  bin/masterplan-session-audit.sh --format=json
  bin/masterplan-session-audit.sh --claude-dir=/tmp/claude --codex-dir=/tmp/codex --repo-roots=/tmp/repos"""


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        parsed = parse_args(argv)
        if parsed is None:
            print(usage())
            return 0
        data = run_audit(*parsed)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        print(usage(), file=sys.stderr)
        return 2

    if parsed[2] == "json":
        print(json.dumps(data, indent=2, sort_keys=True))
    else:
        print_table(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
