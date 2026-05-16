#!/usr/bin/env bash
# masterplan-codex-usage.sh — Survey codex invocations across all visible sources.
#
# Three sources are joined:
#   1. ~/.codex/sessions/**/rollout-*.jsonl       (codex's own session log; authoritative for direct `codex exec`)
#   2. ~/.claude/projects/*/**.jsonl              (Claude transcripts: codex:* Agent dispatches + `codex` CLI in Bash tool_use)
#   3. <repo>/docs/masterplan/*/state.yml         (per-plan codex_routing / codex_review config, if invoked from a masterplan repo)
#
# Usage:
#   bin/masterplan-codex-usage.sh                # report on last 14 days, all sources
#   bin/masterplan-codex-usage.sh --days=N       # adjust window
#   bin/masterplan-codex-usage.sh --since=YYYY-MM-DD
#   bin/masterplan-codex-usage.sh --json         # machine-readable output
#
# Output sections:
#   §1 Codex own session rollouts
#   §2 Codex Agent dispatches from Claude (codex:* subagent_type)
#   §3 Codex CLI invocations in Claude (Bash tool_use with `codex <verb>`)
#   §4 Masterplan routing config per live plan bundle (current repo)
#
# License: MIT (matches parent plugin).

set -u

DAYS=14
SINCE=""
FORMAT="text"

for arg in "$@"; do
    case "$arg" in
        --days=*)   DAYS="${arg#--days=}" ;;
        --since=*)  SINCE="${arg#--since=}" ;;
        --json)     FORMAT="json" ;;
        -h|--help)
            sed -n '2,18p' "$0" | sed 's/^# \?//'
            exit 0 ;;
        *)
            echo "Unknown arg: $arg" >&2
            exit 2 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DAYS SINCE FORMAT REPO_ROOT

python3 <<'PY'
import json, os, re, sys, time
from pathlib import Path
from collections import Counter, defaultdict

days = int(os.environ["DAYS"])
since_iso = os.environ.get("SINCE", "")
fmt = os.environ["FORMAT"]
repo_root = Path(os.environ["REPO_ROOT"])

if since_iso:
    cutoff_epoch = time.mktime(time.strptime(since_iso, "%Y-%m-%d"))
else:
    cutoff_epoch = time.time() - days * 86400

result = {
    "window_days": days,
    "since": time.strftime("%Y-%m-%d", time.localtime(cutoff_epoch)),
    "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "codex_sessions": [],
    "agent_dispatches": [],
    "cli_invocations": [],
    "masterplan_routing": [],
    "totals": {},
}

# === §1 Codex own session rollouts ===
codex_root = Path.home() / ".codex" / "sessions"
if codex_root.exists():
    for sf in sorted(codex_root.rglob("rollout-*.jsonl")):
        if sf.stat().st_mtime < cutoff_epoch:
            continue
        cwd = None
        model = None
        n_records = 0
        types = Counter()
        first_user_text = None
        try:
            with sf.open() as fh:
                for line in fh:
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    n_records += 1
                    t = d.get("record_type") or d.get("type") or "unknown"
                    types[t] += 1
                    if not cwd:
                        cwd = d.get("cwd") or (d.get("payload", {}) or {}).get("cwd")
                    if not model:
                        model = d.get("model") or (d.get("payload", {}) or {}).get("model")
                    if not first_user_text:
                        p = d.get("payload", {}) or {}
                        for cand in (p.get("text"), p.get("content"), p.get("input"), p.get("prompt")):
                            if isinstance(cand, str) and cand.strip():
                                first_user_text = cand[:160]
                                break
        except Exception:
            continue
        result["codex_sessions"].append({
            "ts": time.strftime("%Y-%m-%dT%H:%M", time.localtime(sf.stat().st_mtime)),
            "file": sf.name,
            "cwd": cwd,
            "model": model,
            "records": n_records,
            "size_kb": sf.stat().st_size // 1024,
            "first_text": first_user_text,
        })

# === §2 + §3: scan Claude transcripts ===
claude_root = Path.home() / ".claude" / "projects"
if claude_root.exists():
    for proj in sorted(claude_root.iterdir()):
        if not proj.is_dir():
            continue
        sessions = sorted(proj.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
        recent = [s for s in sessions if s.stat().st_mtime >= cutoff_epoch]
        for sf in recent:
            try:
                with sf.open() as fh:
                    for line in fh:
                        try:
                            d = json.loads(line)
                        except Exception:
                            continue
                        ts = d.get("timestamp", "")[:19]
                        msg = d.get("message", {})
                        content = msg.get("content") if isinstance(msg, dict) else None
                        if not isinstance(content, list):
                            continue
                        for blk in content:
                            if not isinstance(blk, dict) or blk.get("type") != "tool_use":
                                continue
                            name = blk.get("name", "")
                            inp = blk.get("input", {}) if isinstance(blk.get("input", {}), dict) else {}
                            if name == "Agent":
                                st = inp.get("subagent_type", "")
                                if "codex" in st.lower():
                                    result["agent_dispatches"].append({
                                        "ts": ts,
                                        "project": proj.name,
                                        "session": sf.stem[:8],
                                        "subagent_type": st,
                                        "model": inp.get("model", "-"),
                                        "description": (inp.get("description", "") or "")[:100],
                                    })
                            elif name == "Bash":
                                cmd = inp.get("command", "")
                                pattern = re.compile(
                                    r"(?:^|[;&|\n(]\s*|^timeout\s+\d+\s+)"
                                    r"(codex\s+(exec|login|apply|config|plugin|debug|skill|--help)[^\n;&|]{0,150})"
                                )
                                for mo in pattern.finditer(cmd):
                                    idx = mo.start(1)
                                    pre = cmd[:idx]
                                    # Skip if inside an unclosed double-quoted string (e.g. grep pattern)
                                    if pre.count('"') % 2 == 1:
                                        continue
                                    # Skip explicit grep/regex contexts
                                    if "--include" in cmd[max(0, idx - 30):idx] or \
                                       "grep" in cmd[max(0, idx - 30):idx][-15:]:
                                        continue
                                    result["cli_invocations"].append({
                                        "ts": ts,
                                        "project": proj.name,
                                        "session": sf.stem[:8],
                                        "verb": mo.group(2),
                                        "snippet": mo.group(1)[:100].strip(),
                                    })
            except Exception:
                continue

# === §4 Masterplan routing config in current repo ===
mp = repo_root / "docs" / "masterplan"
if mp.exists():
    for state in mp.rglob("state.yml"):
        try:
            txt = state.read_text()
        except Exception:
            continue
        def grab(field):
            m = re.search(rf"^{field}:\s*(\S+)", txt, re.M)
            return m.group(1) if m else None
        result["masterplan_routing"].append({
            "plan": state.parent.name,
            "status": grab("status"),
            "codex_routing": grab("codex_routing"),
            "codex_review": grab("codex_review"),
        })

# Totals
result["totals"] = {
    "codex_sessions": len(result["codex_sessions"]),
    "agent_dispatches": len(result["agent_dispatches"]),
    "cli_invocations": len(result["cli_invocations"]),
    "masterplan_plans": len(result["masterplan_routing"]),
}

if fmt == "json":
    print(json.dumps(result, indent=2, default=str))
    sys.exit(0)

# Text output
print(f"=== Codex usage analysis ===")
print(f"window: {result['since']} → now ({days} days)  generated: {result['generated_at']}")
print()
t = result["totals"]
print(f"Totals: codex_sessions={t['codex_sessions']}  "
      f"agent_dispatches={t['agent_dispatches']}  "
      f"cli_invocations={t['cli_invocations']}  "
      f"masterplan_plans={t['masterplan_plans']}")
print()

print(f"§1 Codex own session rollouts ({t['codex_sessions']})")
if not result["codex_sessions"]:
    print("  (none)")
else:
    print(f"  {'time':16s}  {'records':>7s}  {'size':>6s}  {'model':12s}  cwd")
    for s in result["codex_sessions"]:
        print(f"  {s['ts']:16s}  {s['records']:>7d}  {s['size_kb']:>4d}KB  "
              f"{(s['model'] or '-'):12s}  {s['cwd'] or '-'}")
print()

print(f"§2 Codex Agent dispatches from Claude ({t['agent_dispatches']})")
if not result["agent_dispatches"]:
    print("  (none)")
else:
    for r in result["agent_dispatches"]:
        print(f"  {r['ts']:19s}  {r['project']}  sid={r['session']}  "
              f"type={r['subagent_type']}  model={r['model']}")
        if r["description"]:
            print(f"      desc: {r['description']}")
print()

print(f"§3 Codex CLI invocations in Claude ({t['cli_invocations']})")
if not result["cli_invocations"]:
    print("  (none)")
else:
    verbs = Counter(r["verb"] for r in result["cli_invocations"])
    print(f"  verb distribution: {dict(verbs)}")
    by_proj = defaultdict(list)
    for r in result["cli_invocations"]:
        by_proj[r["project"]].append(r)
    for proj, items in sorted(by_proj.items()):
        print(f"  --- {proj} ({len(items)}) ---")
        for r in items[:10]:
            print(f"    {r['ts']:19s}  sid={r['session']}  {r['snippet']}")
        if len(items) > 10:
            print(f"    … +{len(items)-10} more")
print()

print(f"§4 Masterplan routing config (current repo: {repo_root.name})")
if not result["masterplan_routing"]:
    print("  (no plan bundles found)")
else:
    print(f"  {'plan':40s}  {'status':12s}  {'codex_routing':14s}  {'codex_review':12s}")
    for r in result["masterplan_routing"]:
        print(f"  {r['plan']:40s}  {(r['status'] or '-'):12s}  "
              f"{(r['codex_routing'] or '-'):14s}  {(r['codex_review'] or '-'):12s}")
print()
PY
