# Critical Discipline Rules (CD-1 .. CD-10)

These rules are the canonical source. Phase files reference them by ID; full bodies live here. Loaded on demand by `parts/step-*.md` when first referenced per turn.

### CD-1: Project-local tooling first

Before inventing a command, look for `Makefile`, `package.json` scripts, `Justfile`, `.github/workflows/*`, `bin/*`, `scripts/*`, the repo `README.md`, or runbooks under `docs/`. Use the established path; only fall back to ad-hoc commands when nothing fits.

### CD-2: User-owned worktree

Treat existing uncommitted changes as the user's in-progress work. Do not revert, reformat, or "clean up" files outside the current task's scope. Verification commands must not modify unrelated dirty files; if they would, say so and skip rather than overwrite.

### CD-3: Verification before completion

Never claim a task done without running the most relevant local verification commands and citing their output. A green test run, a clean lint pass, a successful build — concrete evidence, not "should work."

### CD-4: Persistence (work the ladder)

When a tool fails or a result surprises, walk this ladder before escalating to the user: (1) read the error carefully; (2) try an alternate tool/endpoint for the same goal; (3) narrow scope; (4) grep the codebase or recent git history for prior art; (5) consult docs via the `context7` MCP. Hand off only after at least two rungs failed, citing what was tried.

### CD-5: Self-service default

Execute actions yourself. Only hand off to the user when the action is truly user-only: pasting secrets, granting external permissions, approving destructive/production-visible operations, providing 2FA/biometric input.

### CD-6: Tooling preference order

Pick the most specific tool that fits: (1) MCP tool targeting the API directly; (2) installed skill or plugin; (3) project-local convention (repo script, runbook); (4) generic tooling (Bash + curl + custom). Check `/mcp` and the system-reminder skills list before reaching for the generic option.

### CD-7: Durable handoff state

`state.yml` and `events.jsonl` are the persistence surface. Decisions, blockers, scope changes, and surprises that future-you (or another agent) would need go into events or explicit state fields. Don't bury load-bearing context in conversation alone.

### CD-8: Command output reporting

When command output is load-bearing for a decision, relay 1–3 relevant lines or summarize the concrete result. Don't assume the user can see your terminal.

### CD-9: Concrete-options questions

Use `AskUserQuestion` with 2–4 concrete options, recommended option first marked `(Recommended)`. Avoid trailing "let me know how you want to proceed" prose. Use the `preview` field for visual artifacts.

### CD-10: Severity-first review shape

When reviewing code (Codex output, subagent output, plan tasks), lead with findings ordered by severity, grounded in `file_path:line_number`. Keep summaries secondary and short.
