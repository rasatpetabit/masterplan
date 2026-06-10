# /masterplan Verbs Cheat Sheet

A human reference. The orchestrator does **not** load this file at runtime — every
verb is dispatched by the single `/masterplan <verb>` command, which parses the verb
(`commands/masterplan.md` §1), then sequences the deterministic work through `mp`
subcommands (`node bin/masterplan.mjs …`). There are no `parts/` phase files.

Reserved verbs: `full · brainstorm · plan · execute · finish · retro · import · doctor ·
status · validate · stats · clean · next · verbs · publish · follow`. With no verb, the bare command runs
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
Action router: execute the resume controller (`mp continue`) for non-gate work. Report-only
inspection belongs to `status` or `next --dry-run`. On hosts without Claude Code Workflow handles
(including Pi), the no-Workflow foreground path is used so launch-gap recovery cannot strand the
user at `recover_and_redispatch`.

## `verbs`
Print the reserved-verb list.

## `publish`
Lead → GitHub coordination. Projects the **current wave only** of a planned run onto GitHub:
provisions the immutable contract ref `mp-coord/<slug>/<plan_hash>` (tier-1: `spec.md` /
`plan.md` / `plan.index.json` only) and the integration branch `mp-int/<slug>` on first use
(idempotent); then creates one GitHub issue per task in the wave, labeled
`mp:run-<slug>` / `mp:wave-<N>` / `mp:open` (dedup by `{run_slug, task_id}`).
Coordination state — `contract_ref`, `integration_branch`, `issue_map`,
`published_waves` — is pinned into `state.coordination` (the CD-7 single writer is
`mp set-coord`). Spec §7.1. Gated: only when a valid `plan.index.json` exists; the
coordination config is **auto-provisioned on first publish** (no manual `mp set-coord`
prerequisite). Publishes wave N+1 only after wave N is fully merged.

## `follow`
Follower session: claim one unassigned task from a coordinated run, build it using the standard
`mp-implementer` path against an ephemeral local bundle, and open a PR against `mp-int/<slug>`.
Steps: preflight → optimistic claim (settle guard) → build (fetch contract ref, dispatch
`mp-implementer` + D6 `verify-scope` + `verify_commands`) → deliver PR (on pass) or release
claim with a failure comment (on fail). Spec §7.1.
