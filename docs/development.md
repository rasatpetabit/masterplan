# Development & contributor discipline

Repo-specific working rules for `masterplan`. Generic agent policy (AUQ,
verification-before-completion, durable handoff, model routing) lives in the
global / agent-dispatch settings and is **not** restated here — run
`agent-dispatch digest` / `agent-dispatch where`. The canonical CD-rule bodies
(CD-1…CD-10, referenced by live code via their IDs) live in
[`docs/conventions/cd-rules.md`](./conventions/cd-rules.md). This file collects
the masterplan-specific discipline that used to crowd `AGENTS.md`.

## Build / test / lint commands

- **Unit suite:** `node --test test/*.test.mjs` — the real, fast test surface
  for `lib/*.mjs`. Run it after any change to deterministic logic. (Report the
  *actual* pass count from the run; don't hardcode one.)
- **Doctor:** `node bin/doctor.mjs` — repo + bundle health checks; non-zero
  exit iff any `ERROR`.
- **Publish hygiene:** `test/publish-hygiene.test.mjs` (part of the suite)
  guards verb/skill-namespace consistency and path discipline.

## Durable-state discipline (single-writer)

- **Never hand-write `state.yml`/`events.jsonl`, and never let a wave member
  write state or commit.** Every durable mutation goes through an `mp`
  subcommand (CD-7) — a raw write both violates the single-writer rule and
  floods the screen with the diff (anti-flood). Wave members (agents / the L2
  engine) return digests only; the shell is the canonical writer + committer,
  which is exactly what makes re-dispatch idempotent.
- When you complete a task in a run bundle, append the activity via
  `mp event …` (never hand-edit `events.jsonl`) and mark tasks with
  `mp mark-task …`. Never silently mark a task done.
- **Run bundle is the only source of truth (CD-7).** `state.yml` plus bundled
  artifacts should be enough to resume any work. The shell is the sole writer
  (via `mp`); git is committed *after* the `mp` write so a crash in between
  re-derives on resume.

## Don't work in the shell's own context

Dispatch substantive work to agents (`agents/*.md` via the L2 engine), `mp`
subcommands, or `superpowers` skills. The orchestrator context holds sequencing
state only — never raw file contents or verification dumps. Subagents take a
bounded brief (Goal / Inputs / Scope / Constraints / Return shape), don't
inherit session history, and return compact digests. Model selection for
dispatches follows the central routing policy (`agent-dispatch resolve`); never
hardcode model tiers.

## Keep sync'd surfaces in lockstep

**Don't add a verb or doctor check without updating every sync'd location.**

- A **verb** lives in: `commands/masterplan.md` frontmatter `description:`
  (line 2), the §1 reserved-verbs list + arg-precedence, the §3 routing table,
  `README.md`'s verb table, `docs/verbs.md`, and `skills/masterplan/SKILL.md`'s
  verb lists. `lib/hygiene.mjs` `parseReservedVerbs()` parses the frontmatter
  list and `test/publish-hygiene.test.mjs` asserts the surfaces agree.
- A **doctor check** is a new `lib/doctor/<check>.mjs` module (auto-discovered
  by `bin/doctor.mjs`) plus a test, documented in `docs/internals/doctor.md`'s
  module table.

Drift breaks autocomplete, the hygiene test, or silently skips checks.

## Fresh-eyes / cross-vendor review of large edits

Don't trust your own confirmation bias on large markdown/code edits. After a
multi-edit pass, dispatch a fresh-eyes reader subagent over the changed files
end-to-end for contradictions or dangling references. For a reviewable diff,
prefer a cross-vendor pass — `agent-dispatch review --class adversary` (resolves
to a cross-vendor reviewer relative to Claude — see `agent-dispatch digest`) — over a same-vendor
self-check (central policy: diff-review routes cross-vendor). Scope it
correctly: hand it a path-filtered `git diff -- <paths>` rather than a
whole-tree scan; in a dirty bundle (active `state.yml`, `WORKLOG.md`,
sibling-wave edits) commit first and use `--base <ref>`, or pass a scoped diff.
masterplan's own `mp-adversarial-reviewer` already does this — it reviews a
pre-built path-filtered diff, never a whole-tree scan.

## Completion is durable, never silent

The finish flow ([`commands/masterplan.md`](../commands/masterplan.md) §2c)
verifies and cites output → writes `retro.md` if absent → opens the durable
`branch_finish` gate → archives **last**. Archiving earlier strands the run
(the discover filter hides archived bundles). Verification before completion
(CD-3): cite real command output and exit code — "should work" is not evidence.

## Never silently inline a delegated role (CD-11)

When a named agent (`mp-spec-decomposer`, `mp-planner`, etc.) fails to
resolve — or a dispatch path looks unavailable — the orchestrator MUST NOT
silently run that role inline and "record the decision" as cover. "Recording"
a bypass is not a fix; only a code/config/behavior change is (see the global
Hindsight rule). The escape ladder is strict:

1. **Retry once** — a transient resolve error is not a verdict on availability.
2. **Probe the real state** — `subagent({ action: 'list' })` for agent
   resolution, `dispatch_health_status` / `agent-dispatch digest` for the
   dispatch gateway. Never assert "degraded" without one of these; an
   unverified excuse is the anti-pattern.
3. **Escalate** — open an AUQ (`ask_user_question`) with concrete options, or
   surface via `contact_supervisor`. Do not proceed on an unverified
   assumption.

If the root cause is a registration gap (e.g. mp-* not discovered on a host),
**fix the registration** rather than working around it. Registration is
host-specific:

- **Claude Code** discovers `agents/mp-*.md` directly via its plugin loader as
  the `masterplan:mp-*` colon namespace. Those files are the single source of
  truth for role contracts; CC is unchanged by pi registration.
- **pi hosts** discover a different set of paths (`~/.pi/agent/agents/`,
  `.pi/agents/`, `.agents/`) and resolve CC bare `model:` aliases (live: `fable`
  only) to `amazon-bedrock` (no key on most hosts), not to the configured
  `litellm/fable-5`. So a pi host needs adapted copies. Run
  [`bin/register-pi-agents.mjs`](../bin/register-pi-agents.mjs) to generate them
  at `~/.pi/agent/agents/` — **bare-only** (`mp-spec-decomposer.md` etc.). The
  live-alias map swaps `model: fable` → `litellm/fable-5`. Colon alias copies
  (`masterplan:mp-*`) are **retired**: write mode removes managed leftovers
  derived from `agents/mp-*.md` (+ SKIP_FOR_PI); `--check` flags those as drift.
  Unmanaged `masterplan:mp-*.md` outside that set are left alone. Idempotent.
  `mp-implementer` is deliberately **skipped** (skynet-MCP edit contract is
  CC-only; no pi caller); pi uses `dispatch_task` for edits instead. CC still
  loads `agents/` as the `masterplan:mp-*` plugin namespace independently.

Either name now resolves on pi: `subagent({ agent: 'mp-spec-decomposer' })` or
`subagent({ agent: 'masterplan:mp-spec-decomposer' })` — both execute
(verified end-to-end against `src/runs/foreground/subagent-executor.ts`, which
hard-errors on unknown names with no silent fallback). One diagnostic caveat:
colon-named agents do **not** appear in `subagent({ action: 'list' })` output
(a display gap, not a functional one) — the bare `mp-*` copies are what show up
there. A host where `subagent({ action: 'list' })` shows no `mp-*` is a
registration gap to fix (re-run the script), not a license to inline.

This complements CD-3: CD-3 ensures you *verify* completion; CD-11 ensures
the *delegation* actually happened rather than being narrated into existence.
