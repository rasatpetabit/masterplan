---
name: masterplan
description: "Generic entrypoint for masterplan on non-CC hosts (Pi primary, Codex-compatible): bare /masterplan, /masterplan:masterplan, $masterplan, or any verb. All verbs (full, brainstorm, plan, execute, finish, retro, import, doctor, status, validate, stats, clean, next, verbs, render, publish, follow) route through this single command — v8 ships NO per-verb /masterplan:<verb> skills (they shadowed Claude Code built-ins like /plan, /status, /doctor and added nothing over bare-command routing)."
---

## Central agent policy

AUQ, Serena, Hindsight, context-mode, and agent policy is centralized in `AGENTS.md` (routing resolves from `policy/workflow-map.json`; fleet policy at `/srv/workflows/policy/dispatch.md`). This skill must not duplicate or override dispatch rules. User-facing choices must use `ask_user_question` / `AskUserQuestion`, never prose questions.


# Generic entrypoint for Superpowers Masterplan (Pi primary, Codex-compatible)

This skill is the entrypoint for Superpowers Masterplan on hosts without the
Claude Code plugin manager. Its job is to load the canonical command prompt
and adapt it to the current host runtime.

## Host model

- **Pi is the primary host.** It has the full fleet tool suite (file reads,
  edits, bash, `ask_user_question`, parallel `subagent` fan-out) and runs
  masterplan end-to-end — seeding, gates, waves, release. Pi skills are
  installed by `bin/install-pi.mjs` (a copied release snapshot under
  `~/.local/share/masterplan/`, symlinked into `~/.pi/agent/skills/` — never
  a symlink into a dev tree).
- **Codex is compatible** with a restricted tool set; its adaptation rules
  are below. The full-lifecycle Codex commitment stands: Codex hosts whole
  runs foreground-sequentially.
- **Claude Code does not use this skill** — it loads masterplan as a plugin
  (`/masterplan`).

## Source of truth (v8 clean-core layout)

As of v8, `commands/masterplan.md` is a **self-contained** thin orchestrator
(~800 lines) that sequences the whole workflow inline — there are **no**
`parts/` phase files to lazy-load. The deterministic decisions live in
`lib/*.mjs` behind `bin/masterplan.mjs` subcommands (invoked as `mp`), and
`doctor` is `bin/doctor.mjs` + the `lib/doctor/*.mjs` modules. Load the command
prompt once and follow its own §0 Boot → §1 Parse verb → §2 Resume sequencing;
do not look for per-phase files.

Resolve `commands/masterplan.md` in this order (its siblings `bin/` and `lib/`
sit beside it at the plugin root):

1. `../../commands/masterplan.md` relative to this `SKILL.md` file (covers the
   Pi install root and any symlinked skill dir).
2. `$PWD/commands/masterplan.md` when running inside the plugin repo.
3. `/path/to/masterplan/commands/masterplan.md`.
4. `$HOME/.local/share/masterplan/current/commands/masterplan.md` (Pi install root).
5. `$HOME/.codex/.tmp/marketplaces/rasatpetabit-masterplan/commands/masterplan.md`.
6. `$HOME/.claude/plugins/marketplaces/rasatpetabit-masterplan/commands/masterplan.md`.
7. `$HOME/.claude/commands/masterplan.md`.

If none exists, say the local masterplan command file is missing and stop before
inventing behavior.

Run the deterministic core with the Node entrypoints that sit beside the command
file. The prompt writes them as `node "${CLAUDE_PLUGIN_ROOT}/bin/masterplan.mjs"`
and `node "${CLAUDE_PLUGIN_ROOT}/bin/doctor.mjs"`; `${CLAUDE_PLUGIN_ROOT}` is a
Claude Code variable that may be unset on other hosts, so resolve `bin/` as the
sibling of the located `commands/masterplan.md`:

- `mp <subcommand>` → `node <plugin-root>/bin/masterplan.mjs <subcommand> …` —
  the state reads/writes (`decide`, `finish-status`, gate verbs, `set-status`).
  This is the **sole** state writer; the shell owns git (commit/checkout), the
  bin is fs-only.
- `doctor` → `node <plugin-root>/bin/doctor.mjs`.

Prefer summary-first inventory (`rg --files docs/masterplan` plus targeted
`state.yml` reads) before opening plan/spec artifacts. Avoid exploratory
full-file dumps of large prompt, plan, transcript, or event-log files.

## Configuration (seed flags + `set-review-config` → state.yml)

v8 has **no `.masterplan.yaml` config hierarchy** — there is no
built-in/user-global/repo-local merge step to perform. Configuration is set on the
run bundle and read back from `docs/masterplan/<slug>/state.yml`:

- **Seed-time flags** (`mp seed`): `--autonomy`, `--complexity`, `--planning-mode`
  (`serial|parallel|auto`), **`--adversary-review=on|off` (default `on`; alias
  `--codex-review`)** — persisted into `state.yml` at run creation. Every fresh bundle
  arms `state.review.adversary: true` automatically; pass `off` for explicit opt-out.
- **Review config** (`mp set-review-config --review=true|false` [`--routing=auto|on|off`];
  alias `mp set-codex-config`): a CD-7 write that arms `state.review.adversary`. The
  finish-step gate gates the optional review stage on `state.review.adversary === true`
  (falling back to the legacy `state.codex.review` for in-flight bundles). New bundles
  inherit `true` from the seed-time default; pass `--review=false` post-seed to opt out.
  `--routing` is the legacy per-task dispatch default (`state.codex.routing`), still read
  by `prepare-wave` for in-flight bundles.

Read the run's config from `state.yml`; do not look for or merge any config file.

Host review-suppression (see the host adaptation sections) only forces the
effective review behavior off for the current invocation to avoid recursive
host-on-host dispatch; it does not rewrite the persisted `state.yml` values
(`state.review.adversary`, or legacy `state.codex.{routing,review}`), which
still apply to future runs on other hosts.

## Invocation mapping

Treat these user inputs as this skill:

- `Use masterplan <args>` as a normal chat message (any host)
- `masterplan <args>` when it appears as natural-language chat, not shell input
- `$masterplan`
- `$masterplan <args>` when it appears as normal chat (Codex caveat below —
  its TUI shell-command mode sends this to Bash)
- `/masterplan`
- `/masterplan <args>`
- `/masterplan:masterplan`
- `/masterplan:masterplan <args>`
- natural-language requests to use, resume, check, import, or continue
  masterplan work.

**No per-verb skills (v8).** masterplan ships exactly two skill dirs — this one
and `masterplan-detect`. There are **no** `/masterplan:<verb>` per-verb skills:
every verb (`brainstorm`, `full`, `execute`, `finish`, `retro`, `import`,
`doctor`, `status`, `validate`, `stats`, `clean`, `next`, `verbs`, `render`, `publish`, `follow`, and `plan`) is dispatched
by the bare `/masterplan <verb>` command through `bin/masterplan.mjs` (verb
routing in `commands/masterplan.md` §1/§3). The per-verb namespace was removed
because it added nothing over bare-command routing and the reserved words
`plan`/`status`/`doctor` actively **shadowed** Claude Code built-ins (`/plan`
plan-mode, `/status`, `/doctor`). The namespace-collision guard (`lib/hygiene.mjs`
→ `findNamespaceCollisions`, driven by `test/publish-hygiene.test.mjs`) keeps it
that way: only `masterplan` + `masterplan-detect` are allowed under `skills/`.

The arguments are the text after the command name. If there are no arguments,
follow the command's bare invocation flow: resume active `state.yml` first,
re-render pending gates, poll background continuations, and treat `status:
blocked` as critical-error recovery rather than an ordinary pause. When a host
renders a manual resume hint or close-out instruction, use an explicit normal
chat instruction suited to that host (see its adaptation section); never surface
a shell-looking form as the primary resume command.

## Recognizing existing runs

Every host must recognize runs created by any other host. Before starting a new
plan, inspect the current repo/worktree for:

- `docs/masterplan/*/state.yml`
- `docs/masterplan/*/{spec.md,plan.md,retro.md,events.jsonl}`
- legacy `docs/superpowers/plans/*-status.md`
- legacy `docs/superpowers/{plans,specs,retros,archived-plans,archived-specs}/*.md`

Do not assume there is no active work because this host did not create the run
bundle. `state.yml` is the durable source of truth.

## Pi adaptation (primary host)

- **Tools:** use the native fleet tools directly — `read`/`bash`/`edit`/`write`
  for file work (no translation layer), `ask_user_question` for every
  user-facing choice (never prose questions), `todo` for task tracking.
- **Planning suppression:** Pi has no Claude Code Workflow handles. Runs with
  `PI_CODING_AGENT=true` are forced onto the serial planning path
  (`planning_mode: serial` in the `resume-phase` op) — this is automatic; the
  parallel plan fan-out is CC-only.
- **Wave execution:** `dispatch_fabric` ops come back on Pi like every host.
  Launch `op.tasks` from `op.cwd` with Pi's parallel subagent API — one
  bounded, self-contained brief per task (its `files` scope, its verifies, its
  digest contract), fan out the independent ones concurrently, honor each
  task's `files` scope as its write boundary, then assemble the standard
  per-task digest array and feed it to `mp record-result` exactly as the §2 op
  table describes. Sequential single-task execution is fine for one-task waves
  or when tasks share mutable state.
- **Resume hints:** tell the user to ask in normal chat, e.g.
  `Use masterplan execute docs/masterplan/<slug>/state.yml` — there is no
  slash-command form on Pi.
- **Agents:** the mp-* agent briefs are registered into `~/.pi/agent/agents/`
  (bare-only) by `bin/register-pi-agents.mjs` during install; subagent
  dispatches reference them by bare name.

## Codex adaptation (compatible host)

### Invocation caveats

`Use masterplan ...` is the primary Codex chat/skill trigger for user-facing
resume hints. `$masterplan ...` can work only when the host records it as normal
chat; Codex TUI shell-command mode sends it to Bash. Never pass
`$masterplan ...`, `masterplan ...`, or `/masterplan ...` to `exec_command`;
Bash will either expand `$masterplan` as an environment variable or look for a
nonexistent executable. Resume hints use an explicit normal chat instruction,
e.g. `send a normal Codex chat message: Use masterplan execute docs/masterplan/<slug>/state.yml`.

### Tool adaptation

When the command prompt names Claude Code tools, use the local Codex equivalents:

- Read/LS/Grep/Glob: shell reads with `sed`, `ls`, `rg`, or `rg --files`.
- Edit/MultiEdit: `apply_patch`.
- Bash: `exec_command`.
- AskUserQuestion/Question: `request_user_input` when available; otherwise ask
  one concise prose question and wait.
- Task/Todo task tracking: `update_plan`.
- Workflow: **no Codex equivalent — and none needed.** Execute waves come back as
  the `dispatch_fabric` op on every host (suppressed or not) — run `op.tasks` one
  at a time in this session from `op.cwd` (track with `update_plan`), honor
  each task's `files` scope, then assemble the standard per-task digest array
  and feed it to `mp record-result` exactly as the §2 op table describes. Host
  suppression does NOT suppress `dispatch_fabric` — it only forces PLANNING
  onto the SERIAL path (`planning_mode: serial` in the `resume-phase` op;
  the parallel plan fan-out is CC-only). Never run
  either workflow inline — the foreground-sequential op IS the Codex
  execution path.
- Skill: open the referenced `SKILL.md` and follow it.
- Agent/Subagent/Parallel: only spawn agents when the user explicitly asked for
  subagents or parallel agent work; otherwise run sequentially in this Codex
  session and use `multi_tool_use.parallel` only for independent tool calls.

### Suppression and gates

Follow the command prompt's Codex-hosted suppression rules: do not recursively
dispatch to Codex from inside a Codex-hosted masterplan run. Codex host
review-suppression is only about recursive dispatch and review. When a Codex
`request_user_input` gate returns an answer label, treat that as explicit
interactive selection evidence even when it is the first/recommended option and
no free-form note is present. Follow the command prompt's
`codex_host_gate_continuation` rule for continuation answers and keep moving for
`full` / `execute` flows until a true halt gate, sensitive live-auth blocker, or
actual Codex host budget stop fires.

### Codex native goal bridge

Codex native goal support is a pursuit wrapper for Masterplan plans, not a
Masterplan verb. After a plan exists, follow the command prompt's Codex native
goal pursuit contract: use `get_goal` to inspect the active thread goal, create
one with `create_goal` when an in-progress `state.yml` has no matching goal, and
call `update_goal(status="complete")` only after Masterplan's own completion
finalizer proves the plan is complete. Do not run `/goal`, `$goal`, or `goal` in
shell-command mode; those are host UI inputs, not executables. `state.yml`
remains authoritative for task position and recovery.
