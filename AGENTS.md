# AGENTS.md — `masterplan`

<!-- agentic-dispatch:central-pointer v2 -->
## Central agent policy

Cross-repo AskUserQuestion/ask_user_question (AUQ), Serena, Hindsight,
context-mode, and subagent/model-dispatch policy is centralized in the
agent-dispatch repo. Read it via `agent-dispatch where` (repo root) or
`agent-dispatch digest` (live routing policy). Do not duplicate or override
that policy here.

## What this repo is

`masterplan` is a Claude Code (and Codex) plugin providing the `/masterplan`
command — a resumable **brainstorm → plan → execute → finish** workflow on top
of [`obra/superpowers`](https://github.com/obra/superpowers) skills. As of
**v8** it is a real Node codebase, not a markdown monolith: deterministic
decisions live in **`lib/*.mjs`** behind **`bin/masterplan.mjs`** (`mp`,
unit-tested), the markdown prompt is a thin sequencer that only orders `mp`
calls / agent dispatches / gates, and durable state lives in
`docs/masterplan/<slug>/state.yml`. It is built in five thin layers (L0 run
bundle → L4 doctor).

This file is a **thin index**. The full five-layer architecture and failure
modes are in [`docs/internals.md`](./docs/internals.md); the public overview is
[`README.md`](./README.md).

## Where to read first

| If you need... | Read |
|---|---|
| The orchestrator prompt itself (L1 — the sequencer) | [`commands/masterplan.md`](./commands/masterplan.md) |
| Deterministic logic (the real "source code") | `lib/*.mjs` behind `bin/masterplan.mjs` |
| Layer-by-layer internals + failure modes | [`docs/internals.md`](./docs/internals.md) index → `docs/internals/{bundle-resume,wave-dispatch,plan-parser,task-verification,doctor}.md` |
| Public-facing overview + install + usage | [`README.md`](./README.md) · [`docs/install.md`](./docs/install.md) · [`docs/verbs.md`](./docs/verbs.md) |
| Release history + decision rationale per version | [`CHANGELOG.md`](./CHANGELOG.md) |
| Cross-cutting rules (CD-1…CD-10) + plan-field contract | `docs/conventions/cd-rules.md` · `docs/conventions/plan-annotations.md` |
| Build/test/lint + contributor discipline | [`docs/development.md`](./docs/development.md) |
| Agent registration (CC + pi) | CC: `agents/` → `masterplan:mp-*` (plugin loader). pi: `bin/register-pi-agents.mjs` writes `~/.pi/agent/agents/` — **bare** `mp-*.md` only (`model:` via live-alias map `fable → litellm/fable-5`; managed colon leftovers removed; `--check` for drift). See [`docs/development.md`](./docs/development.md) §"Never silently inline a delegated role" |
| Active plans (current work) | `docs/masterplan/*/state.yml` (source of truth per CD-7) |

**Canonical reading order for a new session:** this file →
`commands/masterplan.md` (the sequencer) → the relevant `lib/*.mjs` for the
decision you're touching → `docs/internals.md` for design context → any active
run state in `docs/masterplan/*/state.yml`.

## Discipline & development

Generic agent policy — AUQ (structured questions, never a prose question),
verification-before-completion, durable handoff state, and model routing — is
**global / agent-dispatch policy and is not restated here** (see the §routing
block below and `agent-dispatch digest`).

What is masterplan-specific lives in two docs:

- **Cross-cutting CD-rule bodies (CD-1…CD-10)** — code references the IDs:
  [`docs/conventions/cd-rules.md`](./docs/conventions/cd-rules.md).
- **Build/test/lint + contributor discipline** — single-writer state (never
  hand-write `state.yml`/`events.jsonl`; mutate via `mp`), dispatch-don't-work-
  in-shell-context, keeping verb/doctor surfaces in sync, fresh-eyes /
  cross-vendor review of large edits, and finish-flow durability:
  [`docs/development.md`](./docs/development.md).

<!-- agent-dispatch:begin routing hash=6ef5ed81dc25d94aa1dd68e836eea24846cfd1ef1756242a35d11baa47541f7d -->
## §routing — managed by agent-dispatch (do not hand-edit)

Binding rules (enforced by PreToolUse guard):
- haiku: forbidden (no override path).
- sonnet: override-only (live override grant required).
- model param MUST be explicit — missing model is denied (exception: harness built-ins Explore/Plan inherit the frontier session model).

For the full routing policy, fallback chains, and backend health:
  agent-dispatch digest          # live, from the canonical policy file
  agent-dispatch resolve <class> # deterministic tier for a task class

Source of truth: policy/dispatch-policy.jsonc in the agent-dispatch repo (run `agent-dispatch where` for its root).
<!-- agent-dispatch:end -->
