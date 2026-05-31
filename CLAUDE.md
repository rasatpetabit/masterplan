# masterplan — project context for Claude Code

You are working in `masterplan`, a Claude Code (and Codex) plugin that provides the `/masterplan` slash command. It orchestrates a **brainstorm → plan → execute → finish** development workflow on top of [`obra/superpowers`](https://github.com/obra/superpowers) skills.

## What this codebase IS

As of **v8**, masterplan is a real Node codebase, not a markdown monolith. The deterministic decisions live in **`lib/*.mjs`** behind **`bin/masterplan.mjs`** (invoked throughout as `mp`) — zero-LLM-token, unit-tested. The markdown prompt is now a thin **~251-line sequencer** that only orders `mp` calls, agent dispatches, and gates. Durable state lives in `docs/masterplan/<slug>/state.yml`.

It is built in **five layers**:

- **L0 — Run bundle.** `docs/masterplan/<slug>/` (`state.yml` is the CD-7 source of truth; bundle also holds `spec.md`, `plan.md`, `plan.index.json`, `retro.md`, `events.jsonl`, `handoff.md`). Flat YAML, atomic `tmp`+rename.
- **L1 — Thin shell.** `commands/masterplan.md` (the sequencer prompt) + `bin/masterplan.mjs` (`mp`, fs-only subcommands) + `lib/*.mjs` (pure logic: `resume.mjs`, `bundle.mjs`, `plan-merge.mjs`, `wave.mjs`, `routing.mjs`, `finish.mjs`, `codex-host.mjs`, `hygiene.mjs`, …). **L1 is the SOLE durable state writer (CD-7); the shell owns git, `bin` is fs-only.**
- **L2 — Workflow engine.** `workflows/execute.workflow.js` (one wave per launch) + `workflows/plan.workflow.js` (parallel planning fan-out). Returns digests/fragments only — **never writes state or commits.**
- **L3 — Agents.** `agents/*.md` (`mp-spec-decomposer`, `mp-planner`, `mp-subsystem-planner`, `mp-implementer`, `mp-plan-reviewer`, `mp-codex-reviewer`, `mp-explorer`). Bounded briefs; no session history.
- **L4 — Doctor.** `bin/doctor.mjs` + `lib/doctor/*.mjs` modules. Each finding is `{id, severity ∈ PASS|WARN|ERROR|SKIP, summary, fix}`; non-zero exit iff any `ERROR`.

The rest of the package:

- `skills/masterplan/SKILL.md` — the Codex-visible entrypoint (loads `commands/masterplan.md` and adapts tool names)
- `skills/masterplan-detect/SKILL.md` — auto-suggests `/masterplan import` when legacy planning artifacts are found
- `hooks/masterplan-telemetry.sh` — opt-in Stop hook emitting per-turn / per-subagent JSONL telemetry
- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` — plugin manifest + marketplace catalog (`rasatpetabit/masterplan`)
- `.codex-plugin/plugin.json` — Codex plugin manifest for the same command surface

Codex can host the command through `/masterplan:masterplan`. When it does, `§0` host-detect sets `suppressRescue` so the orchestrator does NOT dispatch the `codex:codex-rescue` companion for that invocation (Codex calling Codex would recurse); persisted `codex.routing` / `codex.review` are unaffected and still apply to Claude Code runs.

## Where to read first

| If you need... | Read |
|---|---|
| The orchestrator prompt itself (L1 — the sequencer) | [`commands/masterplan.md`](./commands/masterplan.md) |
| Deterministic logic (the real "source code") | `lib/*.mjs` behind `bin/masterplan.mjs` |
| Layer-by-layer internals + failure modes | [`docs/internals.md`](./docs/internals.md) index → `docs/internals/{bundle-resume,wave-dispatch,plan-parser,task-verification,doctor}.md` |
| Public-facing overview + install + usage | [`README.md`](./README.md) · [`docs/install.md`](./docs/install.md) · [`docs/verbs.md`](./docs/verbs.md) |
| Release history + decision rationale per version | [`CHANGELOG.md`](./CHANGELOG.md) |
| Cross-cutting rules (CD-1…CD-9) + plan-field contract | `docs/conventions/cd-rules.md` · `docs/conventions/plan-annotations.md` |
| Active plans (current work) | `docs/masterplan/*/state.yml` (source of truth per CD-7) |

**Canonical reading order for a new session:** this file → `commands/masterplan.md` (the sequencer) → the relevant `lib/*.mjs` for the decision you're touching → `docs/internals.md` for design context → any active run state in `docs/masterplan/*/state.yml`.

## Top anti-patterns (don't do these)

1. **Don't run substantive work in the shell's own context.** Dispatch to agents (`agents/*.md` via the L2 engine), `mp` subcommands, or `superpowers` skills. The orchestrator context holds sequencing state only — never raw file contents or verification dumps. Use Haiku for mechanical, Sonnet for general implementation/review, Opus for design judgment.
2. **Don't end a turn with a free-text question.** Use `AskUserQuestion` with 2–4 concrete options (CD-9). Sessions compact between turns and lose upstream-skill bodies; a free-text question becomes a dead end.
3. **Don't write `state.yml`/`events.jsonl` by hand, and don't let a wave member write state or commit.** Every durable mutation goes through an `mp` subcommand (CD-7) — a raw `Write`/`Edit` both violates the single-writer rule and floods the screen with the diff (anti-flood). Wave members (agents / the L2 engine) return digests only; the shell is the canonical writer + committer, which is exactly what makes re-dispatch idempotent.
4. **Don't add a verb or doctor check without updating all sync'd locations.** A **verb** lives in: `commands/masterplan.md` frontmatter `description:` (line 2), the §1 reserved-verbs list + arg-precedence, the §3 routing table, `README.md`'s verb table, `docs/verbs.md`, the `docs/internals.md` routing table, **and** `RESERVED_VERBS` in `lib/hygiene.mjs` (asserted by `test/publish-hygiene.test.mjs`). A **doctor check** is a new `lib/doctor/<check>.mjs` module wired into `bin/doctor.mjs` plus a test. Drift breaks autocomplete, the hygiene test, or silently skips checks.
5. **Don't trust your own confirmation bias on large markdown/code edits.** After a multi-edit pass, dispatch a fresh-eyes Explore subagent to read the changed files end-to-end for contradictions or dangling references, and for a reviewable diff prefer a cross-vendor **Codex** pass (`codex:review`) over a same-vendor self-check.

## Operating principles (always-applicable)

- **Run bundle is the only source of truth (CD-7).** `state.yml` plus bundled artifacts should be enough to resume any work. The shell is the sole writer (via `mp`); git is committed *after* the `mp` write so a crash in between re-derives on resume.
- **Completion is durable, never silent.** The finish flow (`commands/masterplan.md` §2c) verifies and cites output → writes `retro.md` if absent → opens the durable `branch_finish` gate → archives **last**. Archiving earlier strands the run (the discover filter hides archived bundles).
- **Subagents do the work.** Bounded brief: Goal / Inputs / Scope / Constraints / Return shape. They don't inherit session history and return compact digests.
- **Verification before completion (CD-3).** Cite real command output and exit code. "Should work" is not evidence.
- **Don't stop silently.** Close with `AskUserQuestion` whenever input might be needed.

## Build / test / lint commands

- **Unit suite:** `node --test test/*.test.mjs` — the real, fast test surface for `lib/*.mjs`. Run it after any change to deterministic logic. (Report the *actual* pass count from the run; don't hardcode one.)
- **Doctor:** `node bin/doctor.mjs` — repo + bundle health checks; non-zero exit iff any `ERROR`.
- **Publish hygiene:** `test/publish-hygiene.test.mjs` (part of the suite) guards verb/skill-namespace consistency and path discipline.
- **Hook syntax:** `bash -n hooks/masterplan-telemetry.sh`.

When you complete a task in a run bundle, append the activity via `mp event …` (never hand-edit `events.jsonl`) and mark tasks with `mp mark-task …`. Never silently mark a task done.
