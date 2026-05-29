---
description: "Resumable orchestrator for /masterplan: brainstorm→plan→execute on durable run bundles. Verbs: full, brainstorm, plan, execute, retro, import, doctor, status, validate, stats, clean, next, verbs."
---

# /masterplan — thin resumable shell (v8)

> v8 clean-core. The DECISIONS live in `lib/*.mjs` behind `bin/masterplan.mjs` (deterministic,
> zero-LLM-token, unit-tested) — this shell only **sequences**. Durable state lives in
> `docs/masterplan/<slug>/` (`state.yml` is the source of truth). CD-7: the shell is the SOLE
> state writer, via `bin`; never hand-edit `state.yml`. Work goes to dedicated agents
> (`agents/*.md`), the L2 Workflow engine (`workflows/execute.workflow.js`), and `superpowers`
> skills — never run substantive work inline in this context (it holds sequencing state only).

Throughout, **`mp`** denotes `node "${CLAUDE_PLUGIN_ROOT}/bin/masterplan.mjs"`. Every decision and
every state write goes through it. It is fs-only — **git (commit, and the recover-path
`git checkout`) is this shell's job, not `bin`'s.** Results print as JSON on stdout; on a non-zero
exit, read stderr and act on it.

## 0 — Boot (every invocation, unconditional)

1. **Version banner — FIRST, before anything else**, even on a compaction-resume / `invoked_skills`
   re-injection (it is the lone CC-2 survivor; build NO enforcement/telemetry apparatus around it):
   run `mp version --args="<verbatim $ARGUMENTS, or empty>" --cwd="<repo root or pwd>"` and print the
   single line it returns.
2. **Host detect.** Run `mp detect-host` with the signals you can observe (`--agent-is-codex` if the
   session identifies the agent as Codex, `--native-tools` if Codex-native tools like `apply_patch`/
   `update_plan` are exposed, `--agents-md` if an `AGENTS.md` is present). If the result's
   `suppressRescue` is true, do NOT dispatch the `codex:codex-rescue` companion anywhere this
   invocation (it would recurse — Codex calling Codex). Persisted `codex.routing`/`codex.review` are
   unaffected.

## 1 — Parse the verb

Reserved verbs: `full, brainstorm, plan, execute, retro, import, doctor, status, validate, stats,
clean, next, verbs`. Precedence:

0. **No args** → the **resume controller** (§2).
1. First token is a reserved verb → that verb; consume it, the rest are its args.
2. First arg starts with `--` → `--resume=<path>` / `--resume <path>` alias `execute <path>`;
   other `--flags` are config overrides.
3. Otherwise → treat the whole arg string as a **brainstorm topic** (catch-all).

A topic literally named after a reserved verb needs a word in front (`/masterplan add plan timer`).

## 2 — Resume controller (bare entry, `execute`, and after every durable transition)

The spine. It NEVER decides in prose — it asks `mp decide` and executes the returned action.

1. **Locate the bundle.** `execute <path>` → that `state.yml`. Else discover
   `docs/masterplan/*/state.yml` whose status is not archived: exactly one → use it; several → an
   `AskUserQuestion` picker; none → there is no active run (route by verb, or offer to start one).
2. **Migrate-on-load if legacy.** Run `mp migrate-bundle --state=<path>`. If it reports
   `migrated:true`, the tasks now carry `wave:null` — ensure a `plan.index.json` exists (re-parse
   `plan.md` via the `masterplan:mp-planner` / `masterplan:mp-explorer` agent if it's missing), then
   `mp backfill-waves --state=<path> --plan-index=<path>` so every task carries a real wave.
3. **Probe liveness.** If `state.active_run` has a `task_id`, check that run with `TaskGet(task_id)`:
   still running → pass `--alive` in the next step. (A phase-1 `launching` marker has no `task_id` —
   skip the probe; `decide` treats it as crashed-in-launch.)
4. **Decide.** `mp decide --state=<path> [--alive]` → an action JSON. If it exits non-zero citing
   "backfill waves", the bundle wasn't backfilled — return to step 2.
5. **Execute the action.** After `finalize_run`, loop back to step 4 (re-decide); `dispatch_wave` /
   `recover_and_redispatch` end by awaiting a launched run; `wait` / `surface_gate` / `complete` close.

   | action | do |
   |---|---|
   | `surface_gate` | Re-render the gate's `AskUserQuestion` (CD-9). A named option → act, `mp clear-gate`, commit, re-decide. Free-text / no clear answer → keep the gate, respond, close. NEVER auto-proceed regardless of autonomy (the durable marker outranks a native AUQ that can't survive compaction). |
   | `wait` | A live run owns the wave. Report it and close — the Workflow completion notification re-invokes this controller. |
   | `finalize_run` | The wave's tasks are all `done` on disk. `mp clear-active-run`, commit, then re-decide (→ next wave, or `complete`). |
   | `recover_and_redispatch` | Crash recovery. If `staleTaskId` ≠ null: `TaskList` → `TaskStop` any surviving run for it (a backgrounded Workflow MAY outlive session death — reconcile before touching files). Then RESET scope: `git checkout -- <resetPaths>` and `git clean -fd` any new paths. Then dispatch the wave (below). Idempotent — agents never commit. |
   | `dispatch_wave` | `mp set-active-run --wave=N` (phase-1 marker, written BEFORE launch) → launch the L2 engine for these tasks → `mp promote-active-run --run-id=… --task-id=…` (phase-2). Close to await completion. **[L2 launch = step 4 (`workflows/execute.workflow.js`). Until wired: dispatch each task inline (`masterplan:mp-implementer`), `mp mark-task --state=<path> --id=… --status=done` per success, commit, re-decide.]** |
   | `complete` | All tasks done → completion: write `retro.md`, archive the bundle, commit. |

6. **CD-7 commit discipline.** Each durable change = a `mp` write (atomic) FOLLOWED BY a `git commit`
   of the bundle. A crash between write and commit is safe — `state.yml` leads, resume re-commits.
   Wave members (agents / the L2 engine) return digests only; they NEVER write `state.yml` or commit,
   which is exactly what makes re-dispatch idempotent.

## 3 — Other verbs (sequencing only — content lives elsewhere)

| verb | v8 target |
|---|---|
| `full` / `brainstorm` / `plan` | Locate or seed the bundle, then invoke the `superpowers` skill directly — `superpowers:brainstorming` (B), then `writing-plans` (plan); plan output → `plan.index.json`. Gates via `mp open-gate` + an `AskUserQuestion`. **[lifecycle wiring = step 7.]** |
| `execute` | The resume controller (§2). |
| `retro` | Generate `retro.md` for the bundle (the completion subroutine), then close. |
| `import` | Legacy intake → a v8 bundle: `mp migrate-bundle` an in-place legacy `state.yml` (backs up the original). |
| `doctor` | `node "${CLAUDE_PLUGIN_ROOT}/bin/doctor.mjs" [--fix]`. **[checks = step 5.]** |
| `status` | Read-only: `mp decide` (no writes) + a one-screen situation report from `state.yml`. |
| `validate` | Parse-check `state.yml` + config; report findings. No writes. |
| `stats` | `jq` roll-up over `events.jsonl` if present (replaces the v7 telemetry scripts). |
| `clean` | Archive / prune completed bundles. |
| `next` | `mp decide` → describe the next action without executing it. |
| `verbs` | Print the reserved-verb list above. |

## 4 — Turn-close (CD-9)

End any turn that needs input with `AskUserQuestion` (2–4 concrete options) — never a free-text
question (sessions compact between turns; a free-text prompt becomes a dead end) and never a silent
stop while a decision is pending. Otherwise close cleanly. The v7 CC-3 trampoline — trace markers,
breadcrumbs, per-turn summary-block hook signals — is **gone**; the banner (§0) and this AUQ-close
are the only ceremony that survives.
