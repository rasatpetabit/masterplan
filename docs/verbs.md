# /masterplan Verbs Cheat Sheet

A human reference. The orchestrator does **not** load this file at runtime — every
verb is dispatched by the single `/masterplan <verb>` command, which parses the verb
(`commands/masterplan.md` §1), then sequences the deterministic work through `mp`
subcommands (`node bin/masterplan.mjs …`). There are no `parts/` phase files.

Reserved verbs: `full · brainstorm · plan · execute · finish · retro · import · doctor ·
status · validate · stats · clean · next · verbs`. With no verb, the bare command runs
the resume controller (active bundle → re-decide; none → offer to start one).

## `full`
Begin a new run end-to-end: brainstorm → plan → execute → finish. Seeds a bundle
(`mp seed`), runs `superpowers:brainstorming`, the plan lifecycle (§3a), the wave loop
(§2/§2a), then the finish flow (§2c).

## `brainstorm`
Brainstorm phase only. Invokes `superpowers:brainstorming`; on spec approval advances
`phase→plan` and halts at the close-out gate.

## `plan`
Plan phase only: decompose the approved spec into a validated `plan.index.json` + `plan.md`
via the plan lifecycle (§3a) — serial, or a parallel `mp-subsystem-planner` fan-out merged
deterministically by `lib/plan-merge.mjs`, selected per `planning.mode`. Halts before execution.

## `execute`
Resume or begin execution — the resume controller (§2). No path → the active-bundle picker;
`/masterplan execute docs/masterplan/<slug>/state.yml` resumes a specific bundle. Drives one
wave per `execute.workflow.js` launch until all tasks are `done`, then auto-enters the finish
flow. `--resume=<path>` is an alias for `execute <path>`.

## `finish`
Finalize a completed run (§2c): verify and **cite real output**
(`superpowers:verification-before-completion`) → write `retro.md` if absent → open the durable
`branch_finish` gate (merge / push+PR / keep / discard via
`superpowers:finishing-a-development-branch`) → archive **last**. Auto-fires when the last wave
completes; also invokable manually. On pending tasks it asks "finalize anyway / keep working /
`--retro-only`" — never a silent archive.
Flag: `--retro-only` (re)generates just `retro.md` (no verification, no gate, no archive).

## `retro`
**Deprecated alias** for `finish --retro-only` — prints a one-line rename notice, then runs it.

## `import`
Migrate legacy planning artifacts into a v8 run bundle (`mp migrate-bundle`, backing up the
original). On a pre-5.0 refusal the legacy bundle is treated as read-only (CD-7) and you seed
a fresh one rather than rewriting it.

## `doctor`
Run the health checks — `node bin/doctor.mjs` over the `lib/doctor/*.mjs` modules — against the
repo + active bundles. Report-only by default; `--fix` applies the safe auto-fixes.

## `status`
Read-only situation report: `mp decide` (no writes) plus a one-screen summary from `state.yml`.

## `validate`
Parse-check the active bundle's `state.yml` (and its persisted config) and report findings.
No writes.

## `stats`
Telemetry roll-up — a `jq` summary over the bundle's `events.jsonl` (replaces the v7 telemetry
scripts).

## `clean`
Archive stale bundles (`mp set-status --status=archived`) and prune orphan artifacts.

## `next`
What's-next router: `mp decide` → describe the next action without executing it.

## `verbs`
Print the reserved-verb list.
