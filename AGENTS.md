# AGENTS.md — `masterplan`

<!-- agentic-dispatch:central-pointer v2 -->
## Central agent policy

Cross-repo AskUserQuestion/ask_user_question (AUQ), Serena, Hindsight,
context-mode, and subagent/model-dispatch policy is centralized in the
fleet policy. Routing resolves from the repo-local `policy/workflow-map.json`
(a checked-in copy of the fleet workflow routing map) and the fleet dispatch
policy at `/srv/workflows/policy/dispatch.md`. Do not duplicate or override
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
verification-before-completion, durable handoff state, and dispatch class
selection — is **global fleet policy (`/srv/workflows/policy/`) and is not
restated here** (see the `§routing` section below).

What is masterplan-specific lives in two docs:

- **Cross-cutting CD-rule bodies (CD-1…CD-11)** — code references the IDs:
  [`docs/conventions/cd-rules.md`](./docs/conventions/cd-rules.md).
- **Build/test/lint + contributor discipline** — single-writer state (never
  hand-write `state.yml`/`events.jsonl`; mutate via `mp`), dispatch-don't-work-
  in-shell-context, keeping verb/doctor surfaces in sync, fresh-eyes /
  cross-vendor review of large edits, and finish-flow durability:
  [`docs/development.md`](./docs/development.md).

## §routing — resolved from the checked-in policy

Model/lane routing resolves from `policy/workflow-map.json` (the repo-local
copy of the fleet workflow routing map: lanes `sweep`/`bulk`/`code`/`agentic`/`reason`/`longform`/`frontier`/`broad`/`mid`/`local` with `litellm/*` refs, and classes such as `bounded-edit`/`agentic-loop`/`planned-execution`/`adversary`/`critic`/`deep-investigation`). Waves launch as native spawn plans executed by the harness's parallel subagent API; adversarial review is harness-native (adversary class: breaker role, frontier lane; adversarial panel for cross-vendor coverage), with records supplied via `mp record-result --reviews-file`. Agent frontmatter `model:` fields are routing-policy lane names.

Refresh the repo copy with `node /srv/workflows/config/generate.mjs` on a fleet host. Fleet dispatch policy lives at `/srv/workflows/policy/dispatch.md`.

## Knowledge

Structured project knowledge is cataloged in the `.okf/` directory.
See [`.okf/index.md`](.okf/index.md) for the repo's knowledge index.

