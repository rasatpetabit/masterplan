# /masterplan Verbs Cheat Sheet

A human reference. The orchestrator does **not** load this file at runtime — every
verb is dispatched by the single `/masterplan <verb>` command, which parses the verb
(`commands/masterplan.md` §1), then sequences the deterministic work through `mp`
subcommands (`node bin/masterplan.mjs …`). There are no `parts/` phase files.

Reserved verbs: `full · brainstorm · plan · execute · finish · retro · import · doctor ·
status · validate · stats · clean · next · verbs · render · publish · follow`. With no verb, the bare command runs
the resume controller (active bundle → re-decide; none → offer to start one).

## `full`
Begin a new run end-to-end: brainstorm → plan → execute → finish. Seeds a bundle
(`mp seed`), runs `superpowers:brainstorming`, the plan lifecycle (§3a), the wave loop
(§2/§2a), then the finish flow (§2c). New bundles are seeded with `--codex-review=on`
by default (finish-time Codex review armed); pass `--codex-review=off` to opt out. On a
`goals_enabled` bundle the spec→plan boundary captures + freezes `goals.md` (user-approved)
before planning, and the plan gate additionally fails on any uncovered goal.

## `brainstorm`
Brainstorm phase only. Invokes `superpowers:brainstorming`; on spec approval advances
`phase→plan` and halts at the close-out gate. On a `goals_enabled` bundle, at the
spec→plan boundary `goals.md` is captured + frozen (user-approved) before advancing.

## `plan`
Plan phase only: decompose the approved spec into a validated `plan.index.json` + `plan.md`
via the plan lifecycle (§3a) — serial, or a parallel `mp-subsystem-planner` fan-out merged
deterministically by `lib/plan-merge.mjs`, selected per `planning.mode`. Halts before execution.
On a `goals_enabled` bundle the plan gate additionally fails on any uncovered goal (every
frozen goal must be covered by >=1 task).

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
`--retro-only`" — never a silent archive. On a `goals_enabled` bundle, finish adds a per-goal
check via the `mp-goal-assessor` agent, and a new `goals_unmet` gate (fix-&-continue / waiver /
abort) fires before archive.
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

## `render`
Re-render the bundle's `plan.html` — a deterministic, self-contained (inline CSS + a
wave-banded SVG, no JS, no remote resources) projection of `plan.index.json` — with **live**
per-task status badges read from `state.tasks`: `mp render-plan --state=<path>`. **Read-only**
w.r.t. state: it never writes `state.yml`. A static `plan.html` (every task `pending`) is also
**auto-emitted** at the plan→execute seam (`mp load-plan`), so `plan.html` exists from
plan-finalize onward; this verb refreshes it with execution status. No network, no secrets.
On a headless host, `preview <path>` turns it into a PNG.

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

## Goal subcommands
- `goals-load` — parse `goals.md`, freeze the goal set into `state.goals` + a `goals_frozen`
  event (hash-pinned; the split-brain guard checks this hash on `set-phase`/`load-plan`).
- `goals-amend` — amend the frozen goal set (add/edit/remove; tombstones, never deletes);
  appends `goal_amended`, re-pins the hash, and re-arms the spec gate.
- `goals-status` — report per-goal coverage / check status (read-only).
- `record-goal-check` — persist a goal-completeness assessment (mirrors `record-gate-review`,
  anti-fabrication). Default mode validates a `--receipt` binding goals-hash + `--head-sha` +
  `--base` + `--diff-hash` + the recomputed `--verify-output-hash` + clean status + a verdict
  for every active goal, then appends `goal_check`; provenance is exactly one of assessor
  (dispatch id/model/tokens) or user-attested (`attested_by: user` + approval receipt — a
  manual receipt can never masquerade as assessor provenance). `--waive` mode validates a
  `--waiver` (per-goal reasons + user-approval receipt over the same tuple) and appends
  `goal_waived`. Refuses (exit 3) on a dirty worktree; re-entry at an unchanged tuple is
  idempotent, and any goals amendment or later commit re-arms.
Pre-feature bundles without goals gracefully skip (no-op) all goal steps. During finish,
`finish-step` runs `run_goal_check` after verify and before the retro; any partial/missed
goal opens the durable `goals_unmet` gate (fix / waive / abort — fail-closed on assessor
dispatch failure), and the `branch_finish` payload carries a one-line goals summary.

## Plan-graph & cross-run subcommands

New `mp` subcommands from the planf3 import (F1/F2/F4/F5). Like the goal
subcommands above they are dispatched through `mp` (`node bin/masterplan.mjs …`),
not through the `/masterplan` reserved-verb list.

- `refs add|remove|list` (F1) — bidirectional cross-run plan-graph refs stored in
  `state.refs.{back,forward}` as `{slug, label?, repo?}`. `mp refs add
  --state=<path> --direction=back|forward --target=<slug> [--repo=<path>]
  [--label=…]` writes the entry AND its reciprocal (back↔forward) into both
  bundles in one invocation; `mp refs remove …` drops both sides (source-only
  + WARN when the target bundle/repo has moved, so a dangling ref stays
  cleanable); `mp refs list --state=<path>` is read-only JSON. Ref identity is
  `(repo, slug)`, never slug alone; `--target` must be a bare slug
  (`[a-z0-9][a-z0-9-]*`) — traversal-validated before any path is built, and
  stored slugs are re-validated on read. Acquires the Guard-D owner lock on
  BOTH bundles in canonical-sorted order (deadlock-free, TOCTOU-free) and
  re-renders each existing `plan.html` inline after the commit. Seed sugar:
  `mp seed --predecessor=<slug>` seeds a back ref plus its reciprocal forward
  ref. Surfaced in `mp status` and, by-presence, in the `plan.html` header.

- `amend-plan` (F2) — `mp amend-plan --state=<path> --summary="…" [--detail="…"]`
  appends a `### <ISO date> — <summary>` entry under an append-only
  `## Amendments` section in `plan.md` (created at EOF on first use), plus a
  `plan_amended` event. Refuses an empty/multiline/leading-`#` summary, an
  absent `plan.md`, or an archived bundle; detail lines beginning with `#` are
  escaped so the section parse stays unambiguous. Holds the Guard-D owner lock
  across the mutation and re-renders an existing `plan.html` inline afterward (a
  render failure WARNs naming the stale bundle and exits non-zero, but the plan
  mutation stands durable). A later re-run of a plan-gated transition re-arms
  the plan gate at the amended hash, so an amended plan earns a fresh
  cross-vendor pass.

- `set-render-config` (F4) — `mp set-render-config --state=<path> --images=on|off`
  toggles `state.render.images` (mirrors `set-review-config`; merge-updated so
  other render facets survive, and reversible via the same verb — no CD-7
  hand-edit). The flag gates the OPTIONAL, SHELL-side image *generation* only;
  embedding is by-presence — the render embeds any
  `assets/{hero,wave-<n>}.png` it finds and never consults the flag. Also
  settable at seed time via `mp seed --render-images=on`.

- `runs list` (F5) — `mp runs list --repo-root=<path> [--roots=a,b]` — read-only
  cross-repo run inventory. Scans MAIN plus every nested and enclosing git repo
  (depth-capped walk, skipping `.worktrees/`, `node_modules/`, `.git/`) plus any
  persistent `.discovery.yml` roots for `docs/masterplan/*/state.yml`, emitting
  exactly one record per `(realpath repo root, slug)`:
  `{repo, slug, status, phase, tasks_done/total, last_activity, owner, refs}`.
  `last_activity` is DERIVED event-dominant (max of last event ts / owner
  heartbeat mtime, falling back to `state.yml` mtime), never stored. Per-bundle
  and per-root failures WARN + skip and never abort the scan; a corrupt
  `events.jsonl` still lists the bundle with fallback-derived activity (skipping
  it would hide the very dangling run this surfaces). Never writes state.

- `set-discovery` (F5) — `mp set-discovery --repo-root=<path>
  --add-root=<p> | --remove-root=<p>` — the WRITE side of the persistent
  `<MAIN>/docs/masterplan/.discovery.yml` roots config (an ARTIFACT-class file,
  not run state: no lock, no event, no CD-7 concern). Adds or removes exactly
  one extra discovery root, canonicalized via realpath when it resolves on disk
  (kept as raw text when it does not, so a moved/deleted root stays removable).

The read-only `runs list` / dangling-run visibility also flows into `mp status`
(an `other runs` block of non-archived discovered bundles), the `dangling-run`
doctor check, and the session `mp sweep` report — every consumer isolates a
broken foreign bundle to a WARN so it never takes down the current session.

## Task-status subcommands

`mp` subcommands for the blocked/waived task lifecycle (D1–D5). Like the
goal/refs subcommands above they are dispatched through `mp`
(`node bin/masterplan.mjs …`), not the `/masterplan` reserved-verb list.

**Task-status enum** (`VALID_TASK_STATUS`, `bin/masterplan.mjs`):
`pending | in_progress | done | blocked | waived`. The dispatch axis is
mechanical — every "still needs to run" filter excludes `done`, `blocked`, AND
`waived`. `blocked` is non-terminal (gates its wave, blocks finalize); `waived`
is terminal for dispatch + finalize but operator-reversible.

- `mark-task` — `mp mark-task --state=<path> --id=N --status=<status>
  [--reason="…"] [--force]`. `--reason` is REQUIRED for `blocked` (attaches
  `block_reason`); it clears on any non-blocked transition (re-activation), and
  `waive_reason` clears when leaving `waived`. REFUSES `--status=waived` (with a
  `waive-task` pointer) — `waived` is reachable only via `waive-task`, closing
  the waived-bypass surface. `--status=blocked` under a live `active_run` needs
  `--force` (blocking an in-flight task implies the run is already reaped); on
  `--force` it emits a `task_blocked_under_active_run` audit event.
  `--status=pending` un-gating is always allowed.

- `waive-task` — `mp waive-task --state=<path> --id=N | --all --reason="…"
  [--force]`. The ONLY writer of `status:'waived'`. Operates exclusively on
  `blocked` tasks; `--reason` required (explicit operator consent). Sets
  `waive_reason`, deletes `block_reason`, emits a `task_waived` event per task.
  `--all` waives every currently-blocked task. `active_run` needs `--force`.
  Reversible via `mark-task --status=pending` (clears `waive_reason`). When no
  dispatchable task remains but blockers are present, the resume controller
  returns the `awaiting_waiver` op (naming the blockers) — this verb is how the
  operator closes that gate.

- `amend-tasks` — `mp amend-tasks --state=<path> --plan-index=<path> [--prune]
  [--prune-non-pending]`. Status-preserving upsert for in-flight bundles:
  appends NEW ids as `pending`, refreshes `{wave,files}` for EXISTING ids while
  preserving `status`/`block_reason`/`waive_reason`, and (`--prune`) drops ids
  absent from the index. `--prune` drops only BARE `pending` (no accumulated
  state); dropping worked/blocked/waived tasks needs the additional
  `--prune-non-pending` consent (the `seed-tasks --force` hazard, gated).
  Rejects a duplicate index id; re-renders an existing `plan.html` inline after
  the commit.


## seed flags (fabric)

New seeds default `--fabric=on` (`state.dispatch.fabric: true`). Pass `--fabric=off` to omit fabric and keep the legacy wave path.
