# AGENTS.md — `masterplan`

<!-- agentic-dispatch:central-pointer v2 -->
## Central agent policy

Cross-repo AskUserQuestion/ask_user_question (AUQ), RTK, Serena, Hindsight,
context-mode, and subagent/model-dispatch policy is centralized in the
agent-dispatch repo. Read it via `agent-dispatch where` (repo root) or
`agent-dispatch digest` (live routing policy). Do not duplicate or override
that policy here.

## What this repo is

`masterplan` is a Claude Code (and Codex) plugin providing the `/masterplan`
command. It orchestrates a **brainstorm → plan → execute → finish** development
workflow on top of [`obra/superpowers`](https://github.com/obra/superpowers)
skills. This file is the canonical project doc (AGENTS.md-primary as of
2026-06-10; the former CLAUDE.md-primary exception is retired — `CLAUDE.md` is
now the standard thin Claude shim).

As of **v8**, masterplan is a real Node codebase, not a markdown monolith. The
deterministic decisions live in **`lib/*.mjs`** behind **`bin/masterplan.mjs`**
(invoked throughout as `mp`) — zero-LLM-token, unit-tested. The markdown prompt
is a thin **sequencer (~800 lines)** that only orders `mp` calls, agent
dispatches, and gates. Durable state lives in `docs/masterplan/<slug>/state.yml`.

It is built in **five layers**:

- **L0 — Run bundle.** `docs/masterplan/<slug>/` (`state.yml` is the CD-7
  source of truth; bundle also holds `spec.md`, `plan.md`, `plan.index.json`,
  `retro.md`, `events.jsonl`, `handoff.md`). Flat YAML, atomic `tmp`+rename.
- **L1 — Thin shell.** `commands/masterplan.md` (the sequencer prompt) +
  `bin/masterplan.mjs` (`mp`, fs-only subcommands) + `lib/*.mjs` (~20
  pure-logic modules — core: `resume.mjs`, `bundle.mjs`, `plan-merge.mjs`,
  `wave.mjs`, `routing.mjs`, `finish.mjs`; periphery: `worktree{,-fs}.mjs`,
  `owner{,-fs}.mjs` (Guard D), `github-coord.mjs`, `qctl-*.mjs`,
  `codex-host.mjs`, `review-companion.mjs`, `hygiene.mjs`, `migrate.mjs`,
  `paths.mjs`). **L1 is the SOLE durable state writer (CD-7); the shell owns
  git, `bin` is fs-only.**
- **L2 — Workflow engine.** `workflows/execute.workflow.js` (one wave per
  launch) + `workflows/plan.workflow.js` (parallel planning fan-out). Returns
  digests/fragments only — **never writes state or commits.**
- **L3 — Agents.** `agents/*.md` (`mp-spec-decomposer`, `mp-planner`,
  `mp-subsystem-planner`, `mp-implementer`, `mp-plan-reviewer`,
  `mp-adversarial-reviewer`, `mp-explorer`). Bounded briefs; no session history.
- **L4 — Doctor.** `bin/doctor.mjs` + `lib/doctor/*.mjs` modules. Each finding
  is `{id, severity ∈ PASS|WARN|ERROR|SKIP, summary, fix}`; non-zero exit iff
  any `ERROR`.

The rest of the package:

- `skills/masterplan/SKILL.md` — the Codex-visible entrypoint (loads
  `commands/masterplan.md` and adapts tool names)
- `skills/masterplan-detect/SKILL.md` — auto-suggests `/masterplan import`
  when legacy planning artifacts are found
- `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json` — plugin
  manifest + marketplace catalog (`rasatpetabit/masterplan`)
- `.codex-plugin/plugin.json` — Codex plugin manifest for the same command surface

Codex can host the command through `/masterplan:masterplan`. When it does, `§0`
host-detect reports a Codex host (`isCodex`), which lacks Claude Code's Workflow
tool, so the orchestrator runs waves on the foreground-sequential path
(`mp continue --codex-suppressed`); persisted `codex.routing` / `codex.review`
are unaffected and still apply to Claude Code runs.

## Where to read first

| If you need... | Read |
|---|---|
| The orchestrator prompt itself (L1 — the sequencer) | [`commands/masterplan.md`](./commands/masterplan.md) |
| Deterministic logic (the real "source code") | `lib/*.mjs` behind `bin/masterplan.mjs` |
| Layer-by-layer internals + failure modes | [`docs/internals.md`](./docs/internals.md) index → `docs/internals/{bundle-resume,wave-dispatch,plan-parser,task-verification,doctor}.md` |
| Public-facing overview + install + usage | [`README.md`](./README.md) · [`docs/install.md`](./docs/install.md) · [`docs/verbs.md`](./docs/verbs.md) |
| Release history + decision rationale per version | [`CHANGELOG.md`](./CHANGELOG.md) |
| Cross-cutting rules (CD-1…CD-10) + plan-field contract | `docs/conventions/cd-rules.md` · `docs/conventions/plan-annotations.md` |
| Active plans (current work) | `docs/masterplan/*/state.yml` (source of truth per CD-7) |

**Canonical reading order for a new session:** this file →
`commands/masterplan.md` (the sequencer) → the relevant `lib/*.mjs` for the
decision you're touching → `docs/internals.md` for design context → any active
run state in `docs/masterplan/*/state.yml`.

## Top anti-patterns (don't do these)

1. **Don't run substantive work in the shell's own context.** Dispatch to
   agents (`agents/*.md` via the L2 engine), `mp` subcommands, or
   `superpowers` skills. The orchestrator context holds sequencing state only —
   never raw file contents or verification dumps. Model selection for
   dispatches follows the central routing policy (`agent-dispatch resolve`);
   never hardcode model tiers here.
2. **Don't end a turn with a free-text question.** Use
   `AskUserQuestion`/`ask_user_question` with 2–4 concrete options (CD-9).
   Sessions compact between turns and lose upstream-skill bodies; a free-text
   question becomes a dead end.
3. **Don't write `state.yml`/`events.jsonl` by hand, and don't let a wave
   member write state or commit.** Every durable mutation goes through an `mp`
   subcommand (CD-7) — a raw write both violates the single-writer rule and
   floods the screen with the diff (anti-flood). Wave members (agents / the L2
   engine) return digests only; the shell is the canonical writer + committer,
   which is exactly what makes re-dispatch idempotent.
4. **Don't add a verb or doctor check without updating all sync'd locations.**
   A **verb** lives in: `commands/masterplan.md` frontmatter `description:`
   (line 2), the §1 reserved-verbs list + arg-precedence, the §3 routing
   table, `README.md`'s verb table, `docs/verbs.md`, and
   `skills/masterplan/SKILL.md`'s verb lists — `lib/hygiene.mjs`
   `parseReservedVerbs()` parses the frontmatter list and
   `test/publish-hygiene.test.mjs` asserts the surfaces agree. A **doctor
   check** is a new `lib/doctor/<check>.mjs` module (auto-discovered by
   `bin/doctor.mjs`) plus a test, documented in `docs/internals/doctor.md`'s
   module table. Drift breaks autocomplete, the hygiene test, or silently
   skips checks.
5. **Don't trust your own confirmation bias on large markdown/code edits.**
   After a multi-edit pass, dispatch a fresh-eyes reader subagent over the
   changed files end-to-end for contradictions or dangling references, and for
   a reviewable diff prefer a cross-vendor pass — `agent-dispatch review --class
   adversary` (resolves to gpt-5.5 via the skynet gateway, cross-vendor to
   Claude) — over a same-vendor self-check (central policy: diff-review routes
   cross-vendor). Scope that pass correctly: hand it a path-filtered
   `git diff -- <paths>` rather than a whole-tree scan; in a dirty bundle
   (active `state.yml`, `WORKLOG.md`, sibling-wave edits) commit first and use
   `--base <ref>`, or pass a scoped diff. masterplan's own
   `mp-adversarial-reviewer` already does this — it reviews a pre-built
   path-filtered diff, never a whole-tree scan.

## Operating principles (always-applicable)

- **Run bundle is the only source of truth (CD-7).** `state.yml` plus bundled
  artifacts should be enough to resume any work. The shell is the sole writer
  (via `mp`); git is committed *after* the `mp` write so a crash in between
  re-derives on resume.
- **Completion is durable, never silent.** The finish flow
  (`commands/masterplan.md` §2c) verifies and cites output → writes `retro.md`
  if absent → opens the durable `branch_finish` gate → archives **last**.
  Archiving earlier strands the run (the discover filter hides archived
  bundles).
- **Subagents do the work.** Bounded brief: Goal / Inputs / Scope /
  Constraints / Return shape. They don't inherit session history and return
  compact digests.
- **Verification before completion (CD-3).** Cite real command output and
  exit code. "Should work" is not evidence.
- **Don't stop silently.** Close with a structured user question whenever
  input might be needed.

## Build / test / lint commands

- **Unit suite:** `node --test test/*.test.mjs` — the real, fast test surface
  for `lib/*.mjs`. Run it after any change to deterministic logic. (Report the
  *actual* pass count from the run; don't hardcode one.)
- **Doctor:** `node bin/doctor.mjs` — repo + bundle health checks; non-zero
  exit iff any `ERROR`.
- **Publish hygiene:** `test/publish-hygiene.test.mjs` (part of the suite)
  guards verb/skill-namespace consistency and path discipline.

When you complete a task in a run bundle, append the activity via `mp event …`
(never hand-edit `events.jsonl`) and mark tasks with `mp mark-task …`. Never
silently mark a task done.

<!-- agent-dispatch:begin routing hash=6d8307801e22f016588774ae010198516e8402aa6a7cd0724a433885e67b981b -->
## §routing — managed by agent-dispatch (do not hand-edit)

Binding rules (enforced by PreToolUse guard — violations are hard-blocked):
- haiku: FORBIDDEN — no dispatch path exists, no override possible.
- sonnet: OVERRIDE-ONLY — requires a live, unexpired grant (`agent-dispatch override grant sonnet …`).
- model param MUST be explicit — missing model is denied (exception: harness built-ins Explore/Plan inherit the frontier session model).

For the full routing policy, fallback chains, and backend health:
  agent-dispatch digest          # live, from the canonical policy file
  agent-dispatch resolve <class> # deterministic tier for a task class

Source of truth: policy/dispatch-policy.jsonc in the agent-dispatch repo (run `agent-dispatch where` for its root).
<!-- agent-dispatch:end -->
