#!/usr/bin/env python3
"""Wipe pre-v5.1.1 Claude/Codex/per-bundle telemetry artifacts.

Default mode is dry-run. Apply mode requires explicit --apply and a confirmation
token. Hard-coded keep-list prevents touching plan.md/state.yml/spec.md/retro.md
and other work product. A manifest of every deleted path lands at
${XDG_STATE_HOME:-~/.local/state}/superpowers-masterplan/wipes/<ts>.txt before
any deletion happens so the operation is always recoverable post-hoc."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# These names are pre-v5.1.1 telemetry surfaces inside a run bundle. They
# rebuild on the next /masterplan invocation. Anything else in the bundle is
# work product and must NOT be touched.
BUNDLE_TELEMETRY_NAMES = {
    "events.jsonl",
    "anomalies.jsonl",
    "anomalies-pending-upload.jsonl",
    "subagents.jsonl",
    "eligibility-cache.json",
}

# Hard keep-list: any file under docs/masterplan/<slug>/ NOT in
# BUNDLE_TELEMETRY_NAMES is preserved by default. We exhaustively name the
# protected surfaces so we can warn loudly if anything outside the keep-list
# matches the telemetry filter accidentally.
BUNDLE_KEEP_SURFACES = {
    "plan.md",
    "state.yml",
    "spec.md",
    "retro.md",
    "worklog.md",
    "next-actions.md",
    "gap-register.md",
}

# These directories under a bundle are user-owned by definition and never touched.
BUNDLE_KEEP_DIRS = {"reviews", "notes", "subagent-reports", "artifacts"}

DEFAULT_MTIME_SKIP_SECONDS = 5 * 60  # 5 minutes


@dataclass
class WipeCategory:
    name: str
    paths: list[Path] = field(default_factory=list)
    skipped_recent: list[Path] = field(default_factory=list)
    total_bytes: int = 0

    def add(self, path: Path, *, mtime_skip_epoch: float) -> None:
        try:
            stat = path.stat()
        except OSError:
            return
        if stat.st_mtime >= mtime_skip_epoch:
            self.skipped_recent.append(path)
            return
        self.paths.append(path)
        self.total_bytes += stat.st_size


@dataclass
class WipePlan:
    claude_transcripts: WipeCategory = field(default_factory=lambda: WipeCategory("claude_transcripts"))
    codex_sessions: WipeCategory = field(default_factory=lambda: WipeCategory("codex_sessions"))
    codex_history: WipeCategory = field(default_factory=lambda: WipeCategory("codex_history"))
    codex_logs: WipeCategory = field(default_factory=lambda: WipeCategory("codex_logs"))
    codex_archived: WipeCategory = field(default_factory=lambda: WipeCategory("codex_archived_sessions"))
    bundle_events: WipeCategory = field(default_factory=lambda: WipeCategory("bundle_events"))
    bundle_anomalies: WipeCategory = field(default_factory=lambda: WipeCategory("bundle_anomalies"))
    bundle_subagents: WipeCategory = field(default_factory=lambda: WipeCategory("bundle_subagents"))
    bundle_eligibility: WipeCategory = field(default_factory=lambda: WipeCategory("bundle_eligibility"))
    state_breadcrumbs: list[Path] = field(default_factory=list)
    refused: list[tuple[Path, str]] = field(default_factory=list)

    def categories(self) -> list[WipeCategory]:
        return [
            self.claude_transcripts,
            self.codex_sessions,
            self.codex_history,
            self.codex_logs,
            self.codex_archived,
            self.bundle_events,
            self.bundle_anomalies,
            self.bundle_subagents,
            self.bundle_eligibility,
        ]

    def total_files(self) -> int:
        return sum(len(c.paths) for c in self.categories())

    def total_bytes(self) -> int:
        return sum(c.total_bytes for c in self.categories())


def discover_repo_roots(override: str | None) -> list[Path]:
    if override:
        raw = override
    else:
        raw = os.environ.get("MASTERPLAN_REPO_ROOTS") or str(Path.home() / "dev")
    roots: list[Path] = []
    for part in raw.split(":"):
        part = part.strip()
        if not part:
            continue
        p = Path(part).expanduser()
        if p.exists() and p.is_dir():
            roots.append(p)
    return roots


def iter_bundle_dirs(repo_roots: list[Path], include_worktrees: bool):
    """Yield (bundle_dir, repo_label) for every docs/masterplan/<slug>/ dir."""
    seen: set[str] = set()
    for root in repo_roots:
        # Direct repos under the root.
        for masterplan in root.glob("*/docs/masterplan"):
            if not masterplan.is_dir():
                continue
            for slug_dir in masterplan.iterdir():
                if not slug_dir.is_dir():
                    continue
                key = str(slug_dir.resolve())
                if key in seen:
                    continue
                seen.add(key)
                yield slug_dir, slug_dir.parents[2].name
        # Worktrees under .worktrees/* inside each repo.
        if include_worktrees:
            for wt_masterplan in root.glob("*/.worktrees/*/docs/masterplan"):
                if not wt_masterplan.is_dir():
                    continue
                for slug_dir in wt_masterplan.iterdir():
                    if not slug_dir.is_dir():
                        continue
                    key = str(slug_dir.resolve())
                    if key in seen:
                        continue
                    seen.add(key)
                    # repo label = repo dir name (4 parents up from slug_dir)
                    yield slug_dir, slug_dir.parents[4].name


def plan_claude(plan: WipePlan, claude_dir: Path, mtime_skip_epoch: float) -> None:
    if not claude_dir.exists():
        return
    for jsonl in claude_dir.glob("*/*.jsonl"):
        if jsonl.is_file():
            plan.claude_transcripts.add(jsonl, mtime_skip_epoch=mtime_skip_epoch)


def plan_codex(plan: WipePlan, codex_root: Path, mtime_skip_epoch: float) -> None:
    sessions = codex_root / "sessions"
    if sessions.exists():
        for f in sessions.rglob("*"):
            if f.is_file():
                plan.codex_sessions.add(f, mtime_skip_epoch=mtime_skip_epoch)
    for name in ("history.jsonl", "session_index.jsonl"):
        p = codex_root / name
        if p.exists() and p.is_file():
            plan.codex_history.add(p, mtime_skip_epoch=mtime_skip_epoch)
    log_dir = codex_root / "log"
    if log_dir.exists():
        for name in ("codex-tui.log", "codex-login.log"):
            p = log_dir / name
            if p.exists() and p.is_file():
                plan.codex_logs.add(p, mtime_skip_epoch=mtime_skip_epoch)
    archived = codex_root / "archived_sessions"
    if archived.exists():
        for f in archived.rglob("*"):
            if f.is_file():
                plan.codex_archived.add(f, mtime_skip_epoch=mtime_skip_epoch)


def plan_bundles(plan: WipePlan, repo_roots: list[Path], include_worktrees: bool, mtime_skip_epoch: float) -> None:
    for slug_dir, _repo in iter_bundle_dirs(repo_roots, include_worktrees):
        for entry in slug_dir.iterdir():
            if not entry.is_file():
                continue
            name = entry.name
            if name not in BUNDLE_TELEMETRY_NAMES:
                if name in BUNDLE_KEEP_SURFACES or entry.parent.name in BUNDLE_KEEP_DIRS:
                    continue
                # Unknown surface — refuse to touch, log it.
                continue
            if name == "events.jsonl":
                plan.bundle_events.add(entry, mtime_skip_epoch=mtime_skip_epoch)
            elif name in {"anomalies.jsonl", "anomalies-pending-upload.jsonl"}:
                plan.bundle_anomalies.add(entry, mtime_skip_epoch=mtime_skip_epoch)
            elif name == "subagents.jsonl":
                plan.bundle_subagents.add(entry, mtime_skip_epoch=mtime_skip_epoch)
            elif name == "eligibility-cache.json":
                plan.bundle_eligibility.add(entry, mtime_skip_epoch=mtime_skip_epoch)
        state_path = slug_dir / "state.yml"
        if state_path.exists() and state_path.is_file():
            plan.state_breadcrumbs.append(state_path)


def build_plan(opts: argparse.Namespace) -> WipePlan:
    plan = WipePlan()
    mtime_skip_epoch = time.time() - opts.mtime_skip
    if not opts.no_claude:
        plan_claude(plan, Path(opts.claude_dir).expanduser(), mtime_skip_epoch)
    if not opts.no_codex:
        plan_codex(plan, Path(opts.codex_dir).expanduser(), mtime_skip_epoch)
    if not opts.no_bundle_logs:
        roots = discover_repo_roots(opts.repo_roots)
        plan_bundles(plan, roots, include_worktrees=not opts.no_worktrees, mtime_skip_epoch=mtime_skip_epoch)
    return plan


def fmt_bytes(n: int) -> str:
    if n < 1024:
        return f"{n}B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f}KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f}MB"
    return f"{n / (1024 * 1024 * 1024):.2f}GB"


def write_manifest(manifest_path: Path, plan: WipePlan, opts: argparse.Namespace) -> None:
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    lines.append(f"# masterplan-wipe-telemetry manifest")
    lines.append(f"# ts: {datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')}")
    lines.append(f"# mode: {'apply' if opts.apply else 'dry-run'}")
    lines.append(f"# args: {json.dumps(vars(opts), default=str, sort_keys=True)}")
    lines.append(f"# total_files: {plan.total_files()}")
    lines.append(f"# total_bytes: {plan.total_bytes()} ({fmt_bytes(plan.total_bytes())})")
    for cat in plan.categories():
        lines.append("")
        lines.append(f"## {cat.name} ({len(cat.paths)} files, {fmt_bytes(cat.total_bytes)})")
        for p in cat.paths:
            try:
                size = p.stat().st_size
            except OSError:
                size = 0
            lines.append(f"{size}\t{p}")
        if cat.skipped_recent:
            lines.append(f"# skipped (mtime < {opts.mtime_skip}s): {len(cat.skipped_recent)}")
            for p in cat.skipped_recent:
                lines.append(f"# skip\t{p}")
    if plan.state_breadcrumbs:
        lines.append("")
        lines.append(f"## state_breadcrumbs ({len(plan.state_breadcrumbs)} files)")
        for p in plan.state_breadcrumbs:
            lines.append(f"breadcrumb\t{p}")
    manifest_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def append_state_breadcrumb(state_path: Path, manifest_path: Path, ts_iso: str) -> None:
    """Append `events_wiped:` block to state.yml. Idempotent — skip if already present."""
    try:
        text = state_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return
    if re.search(r"(?m)^events_wiped:\s*$", text):
        return
    # Trailing-newline normalization
    if not text.endswith("\n"):
        text += "\n"
    block = (
        f"events_wiped:\n"
        f"  ts: '{ts_iso}'\n"
        f"  manifest: '{manifest_path}'\n"
        f"  note: 'pre-v5.1.1 telemetry wiped; bundle work product preserved'\n"
    )
    try:
        state_path.write_text(text + block, encoding="utf-8")
    except OSError:
        pass


def apply_wipe(plan: WipePlan, manifest_path: Path, ts_iso: str) -> int:
    """Delete planned files. Returns count of files actually removed."""
    deleted = 0
    for cat in plan.categories():
        for p in cat.paths:
            try:
                p.unlink()
                deleted += 1
            except FileNotFoundError:
                pass
            except OSError as e:
                print(f"  warn: failed to delete {p}: {e}", file=sys.stderr)
    # Cleanup of empty Codex sessions subtrees + log dir entries.
    for codex_root_name in ("sessions", "archived_sessions"):
        codex_path = Path(os.environ.get("HOME", "")) / ".codex" / codex_root_name
        if codex_path.exists():
            for d in sorted(codex_path.rglob("*"), reverse=True):
                if d.is_dir():
                    try:
                        d.rmdir()
                    except OSError:
                        pass
    for state_path in plan.state_breadcrumbs:
        append_state_breadcrumb(state_path, manifest_path, ts_iso)
    return deleted


def print_dry_run(plan: WipePlan, opts: argparse.Namespace) -> None:
    print("masterplan-wipe-telemetry — dry-run summary")
    print(f"  mtime_skip: {opts.mtime_skip}s")
    print(f"  total: {plan.total_files()} files, {fmt_bytes(plan.total_bytes())}")
    print("")
    for cat in plan.categories():
        if not cat.paths and not cat.skipped_recent:
            continue
        print(f"  {cat.name}: {len(cat.paths)} files, {fmt_bytes(cat.total_bytes)}")
        if cat.skipped_recent:
            print(f"    skipped-recent: {len(cat.skipped_recent)}")
        if opts.verbose:
            for p in cat.paths[:5]:
                print(f"      - {p}")
            if len(cat.paths) > 5:
                print(f"      … {len(cat.paths) - 5} more")
    if plan.state_breadcrumbs:
        print(f"  state_breadcrumbs: {len(plan.state_breadcrumbs)} state.yml files will receive an events_wiped: entry")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Wipe pre-v5.1.1 Claude/Codex/per-bundle telemetry. Default: dry-run.",
    )
    parser.add_argument("--apply", action="store_true", help="actually delete (requires --yes)")
    parser.add_argument("--yes", action="store_true", help="skip the wipe-confirmed prompt under --apply")
    parser.add_argument("--no-claude", action="store_true", help="skip Claude transcripts")
    parser.add_argument("--no-codex", action="store_true", help="skip Codex transcripts + history + logs + archived_sessions")
    parser.add_argument("--no-bundle-logs", action="store_true", help="skip per-bundle telemetry (events/anomalies/subagents/eligibility-cache)")
    parser.add_argument("--no-worktrees", action="store_true", help="skip .worktrees/ copies of bundles")
    parser.add_argument("--repo-roots", default="", help="colon-separated repo roots (default: $MASTERPLAN_REPO_ROOTS or ~/dev)")
    parser.add_argument("--claude-dir", default=str(Path.home() / ".claude" / "projects"))
    parser.add_argument("--codex-dir", default=str(Path.home() / ".codex"))
    parser.add_argument("--mtime-skip", type=int, default=DEFAULT_MTIME_SKIP_SECONDS, help="skip files modified within this many seconds (default: 300)")
    parser.add_argument("--manifest-dir", default="", help="override manifest directory (default: $XDG_STATE_HOME/superpowers-masterplan/wipes)")
    parser.add_argument("--verbose", action="store_true")
    opts = parser.parse_args(argv)

    if opts.apply and not opts.yes:
        try:
            answer = input("Type 'wipe-confirmed' to proceed with deletion: ").strip()
        except EOFError:
            answer = ""
        if answer != "wipe-confirmed":
            print("aborted: confirmation token mismatch (expected 'wipe-confirmed')", file=sys.stderr)
            return 2

    plan = build_plan(opts)

    if plan.total_files() == 0:
        print("masterplan-wipe-telemetry: nothing to wipe.")
        return 0

    state_root = opts.manifest_dir or os.environ.get("XDG_STATE_HOME") or str(Path.home() / ".local" / "state")
    manifest_dir = Path(state_root).expanduser()
    if opts.manifest_dir == "":
        manifest_dir = manifest_dir / "superpowers-masterplan" / "wipes"
    ts_compact = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    ts_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    manifest_path = manifest_dir / f"{ts_compact}{'-dryrun' if not opts.apply else ''}.txt"
    write_manifest(manifest_path, plan, opts)
    print(f"manifest: {manifest_path}")

    print_dry_run(plan, opts)

    if not opts.apply:
        print("")
        print("dry-run only — pass --apply --yes (or --apply and confirm interactively) to delete.")
        return 0

    deleted = apply_wipe(plan, manifest_path, ts_iso)
    print(f"deleted: {deleted} files ({fmt_bytes(plan.total_bytes())})")
    print(f"manifest preserved: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
