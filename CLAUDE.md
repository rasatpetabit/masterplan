# superpowers-masterplan — project context for Claude Code

You are working in `superpowers-masterplan`, a Claude Code plugin that provides the `/masterplan` slash command. The plugin orchestrates a brainstorm → plan → execute development workflow on top of [`obra/superpowers`](https://github.com/obra/superpowers) skills.

## What this codebase IS

A single 1100-line markdown orchestrator prompt at **`commands/masterplan.md`** plus three sidecar files:

- `skills/masterplan-detect/SKILL.md` — auto-suggests `/masterplan import` when legacy planning artifacts are found
- `hooks/masterplan-telemetry.sh` — opt-in Stop hook (~100 lines bash) that emits per-turn JSONL telemetry
- `.claude-plugin/plugin.json` — plugin manifest (name, version, description, URL)

There is **no code** in the conventional sense. The "program" is the markdown prompt. "Tests" are hand-crafted plans + grep verification + `bash -n` syntax checks + manual smoke runs.

## Where to read first

| If you need... | Read |
|---|---|
| Deep-dive on the orchestrator's design + dispatch model + failure modes | [`docs/internals.md`](./docs/internals.md) |
| The orchestrator prompt itself (the "source code") | [`commands/masterplan.md`](./commands/masterplan.md) |
| Public-facing project overview + install + usage | [`README.md`](./README.md) |
| Release history + decision rationale per version | [`CHANGELOG.md`](./CHANGELOG.md) |
| Recent decision notes + handoff for next session | [`WORKLOG.md`](./WORKLOG.md) — append-only |
| Active plans (current work) | `docs/superpowers/plans/*-status.md` (status files are the source of truth per CD-7) |

**Canonical reading order for a new session:** this file → `docs/internals.md` (skim the table of contents; deep-read sections relevant to the current task) → `commands/masterplan.md` (the source) → any active status file in `docs/superpowers/plans/`.

## Top anti-patterns (don't do these)

1. **Don't run substantive work in the orchestrator's own context.** Dispatch to subagents (Haiku for mechanical, Sonnet for general, Codex for bounded-well-defined). Orchestrator's context is reserved for sequencing decisions, not for raw file contents or verification dumps. See `docs/internals.md§Subagent and context-control architecture`.
2. **Don't end a turn with a free-text question.** Use `AskUserQuestion` with 2–4 concrete options. Sessions can compact between turns and lose upstream-skill bodies; a free-text question becomes a dead end. See CD-9.
3. **Don't auto-commit or auto-write to the status file from inside a wave member.** Wave dispatch (Slice α, v2.0.0+) requires wave members to return digests only — orchestrator is the canonical writer per CD-7. See `docs/internals.md§Wave dispatch`.
4. **Don't introduce a new verb or doctor check without updating all three sync'd locations.** Verb routing table at Step 0 line ~46, reserved-verbs warning at line ~70, frontmatter `description:` at line 2. Doctor checks: the parallelization brief's count must match the table size. Drift here breaks autocomplete or silently skips checks.
5. **Don't trust your own confirmation bias on large markdown edits.** After a multi-edit pass, dispatch a fresh-eyes Explore subagent to read the file end-to-end for contradictions or dangling references. The v1.0.0 audit pass and the v2.0.0 work both caught second-order issues this way.

## Operating principles (always-applicable)

- **Status file is the only source of truth.** Two reads (status + plan) should be enough to resume any work. See `docs/internals.md§Status file format`.
- **Subagents do the work.** Bounded brief: Goal/Inputs/Scope/Constraints/Return shape. They don't inherit session history.
- **Verification before completion (CD-3).** Cite real command output. "Should work" is not evidence.
- **Don't stop silently.** Always close with `AskUserQuestion` if input might be needed.

## Build / test / lint commands

There aren't any. Verification uses:
- `grep` for negative/positive discriminators per edit
- `bash -n hooks/masterplan-telemetry.sh` for syntax check on the hook
- Hand-crafted test plans for runtime smoke (see `docs/internals.md§Common dev recipes`)

When you complete a task, append the activity log entry to the status file per the wave-aware update rules. Never silently mark a task done.
