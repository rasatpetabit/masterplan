---
description: "Resumable orchestrator for /masterplan: brainstorm→plan→execute on durable run bundles. Verbs: full, brainstorm, plan, execute, retro, import, doctor, status, validate, stats, clean, next, verbs."
---

# /masterplan — thin resumable shell (v8)

> v8 clean-core. The DECISIONS live in `lib/*.mjs` behind `bin/masterplan.mjs` (deterministic,
> zero-LLM-token, unit-tested) — this shell only **sequences**. Durable state lives in
> `docs/masterplan/<slug>/` (`state.yml` is the source of truth). CD-7: the shell is the SOLE
> state writer, via `bin` — **never** hand-edit, `Write`, or `Edit` `state.yml` or `events.jsonl`;
> every mutation goes through an `mp` subcommand (`seed`, `set-phase`, `set-status`, `mark-task`,
> `load-plan`, `open-gate`, `clear-gate`, `event`, …). A raw `Write`/`Edit` both violates CD-7 **and** floods the screen with the file diff
> (anti-flood) — `mp` writes the file server-side and returns one terse JSON line. Work goes to
> dedicated agents (`agents/*.md`), the L2 Workflow engine (`workflows/execute.workflow.js`), and
> `superpowers` skills — never run substantive work inline in this context (it holds sequencing state only).

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
   `plan.md` via the `masterplan:mp-planner` agent if it's missing), then
   `mp backfill-waves --state=<path> --plan-index=<path>` so every task carries a real wave. **If it
   instead REFUSES** (pre-5.0 floor / unparseable legacy — the deliberate R3 refusal), do **NOT**
   raw-rewrite `state.yml` to schema 6 (a CD-7 violation). Treat the legacy bundle as read-only
   reference and either `mp seed` a FRESH schema-6 bundle (re-deriving its tasks via the §3
   brainstorm→plan→`load-plan` path), finish the run under masterplan v7, or stop and ask the user.
3. **Probe liveness — or catch a completion.** If `state.active_run` has a `task_id`:
   - **A Workflow completion notification re-invoked you** and its `<result>{…}</result>` (run/task
     matching `active_run`) is in front of you → do NOT probe or `decide` yet: first run the
     **completion protocol — §2a for an execute wave, §2b for a planning run** (branch on
     `active_run.kind`: `'plan'` → §2b, else → §2a) to record the in-hand digests (execute: mark each
     `done`, D6 `verify-scope`, commit; plan: merge fragments → validate → review → advance).
     Recording BEFORE `decide` is load-bearing — a finished run whose tasks are still
     `pending` on disk looks like a crash to `decide` (→ `recover_and_redispatch`), so deciding first
     re-runs a wave you already hold results for. After recording, fall through to step 4 (no `--alive`).
   - **Otherwise** probe with `TaskGet(task_id)`: still running → pass `--alive` to step 4 (→ `wait`).
     Finished/absent with no result in hand (compaction dropped the notification) → no `--alive`
     (→ `decide` returns `recover_and_redispatch`; the reset + re-dispatch is idempotent).
   (A phase-1 `launching` marker has no `task_id` — skip the probe; `decide` treats it as crashed-in-launch.)
4. **Decide.** `mp decide --state=<path> [--alive]` → an action JSON. If it exits non-zero citing
   "backfill waves", the bundle wasn't backfilled — return to step 2; if it cites "phase is 'execute'
   but state.tasks is empty", the plan was never loaded into the bundle — run `mp seed-tasks
   --state=<path> --plan-index=<path>` to materialize the tasks (the bundle is already `phase:execute`,
   so seed-tasks alone suffices — the load-plan seam in §3/§3a was bypassed) before resuming.
5. **Execute the action.** After `finalize_run`, loop back to step 4 (re-decide); `dispatch_wave` /
   `recover_and_redispatch` / `recover_plan_run` end by awaiting a launched run; `resume_phase` hands
   to the plan lifecycle (§3a); `wait` / `surface_gate` / `complete` close.

   | action | do |
   |---|---|
   | `surface_gate` | Re-render the gate's `AskUserQuestion` (CD-9). A named option → act, `mp clear-gate`, commit, re-decide. Free-text / no clear answer → keep the gate, respond, close. NEVER auto-proceed regardless of autonomy (the durable marker outranks a native AUQ that can't survive compaction). |
   | `wait` | A live run owns the wave. Report it and close — its Workflow completion notification re-invokes this controller, which records the result via the completion protocol (**§2a**, step 3). |
   | `finalize_run` | The wave's tasks are all `done` on disk. `mp clear-active-run`, commit, then re-decide (→ next wave, or `complete`). |
   | `recover_and_redispatch` | Crash recovery. If `staleTaskId` ≠ null: `TaskList` → `TaskStop` any surviving run for it (a backgrounded Workflow MAY outlive session death — reconcile before touching files). Then RESET scope: `git checkout -- <resetPaths>` and, **only when `resetPaths` is non-empty**, `git clean -fd -- <resetPaths>` — scope the clean to the reset paths; a bare `git clean -fd` (or one with an empty pathspec) would wipe unrelated user-owned untracked files. Then dispatch the wave via **§2a**. Idempotent — agents never commit. |
   | `recover_plan_run` | Crash recovery for a planning fan-out (`active_run.kind:'plan'`). If `staleTaskId` ≠ null: `TaskList` → `TaskStop` any surviving run. **No git scope reset** — the subsystem drafters are read-only, so nothing was written to revert. Re-launch the fan-out via **§2b** (re-dispatch `mp-spec-decomposer` if the subsystem set isn't in hand). Idempotent. |
   | `dispatch_wave` | Launch one wave through the L2 engine — full sequence in **§2a**. In brief: `mp prepare-wave` (resolves routing) → capture the git baseline → `mp set-active-run --wave=N` (phase-1, BEFORE launch) → launch `workflows/execute.workflow.js` in the background with `args={wave,tasks,baseline,repoRoot,review}` → `mp promote-active-run --run-id=… --task-id=…` (phase-2) → close to await its completion notification. |
   | `resume_phase` | The bundle is mid-`{brainstorm\|plan}` with no plan built yet (`tasks:[]`). **Do NOT finalize/archive** — that would destroy a mid-design run. `phase==plan` → hand to the **plan lifecycle (§3a)** with the action's `planning_mode`. `phase==brainstorm` → re-entering an in-progress `superpowers:brainstorming` is still deferred (step 7), so SURFACE via `AskUserQuestion` — continue the phase, restart it, or stop — and close. Never fall through to `complete`. |
   | `complete` | All tasks done → completion: write `retro.md`, archive the bundle (`mp set-status --state=<path> --status=archived` — the sole archival mechanism wherever a bundle is archived; never hand-edit `state.yml`), commit. |

6. **CD-7 commit discipline.** Each durable change = a `mp` write (atomic) FOLLOWED BY a `git commit`
   of the bundle. A crash between write and commit is safe — `state.yml` leads, resume re-commits.
   Wave members (agents / the L2 engine) return digests only; they NEVER write `state.yml` or commit,
   which is exactly what makes re-dispatch idempotent.

## 2a — Wave dispatch + completion protocol (the L1↔L2 seam)

`workflows/execute.workflow.js` (L2) runs **exactly one wave per launch**; this shell drives the
wave loop. A Workflow script has no module/fs/git access, so the shell resolves routing and captures
git *here*, threading data in via `args` and reading digests back out — the workflow itself only
dispatches agents and echoes the baseline.

**Launch** (the tail of `dispatch_wave`, and of `recover_and_redispatch` after its scope reset):

1. **Resolve the wave.** `mp prepare-wave --state=<path> --plan-index=<path> --wave=N
   [--codex-suppressed] [--linked-worktree]` → `{wave, tasks:[…lean, already-routed…], review}`. Pass
   `--codex-suppressed` when §0 host-detect set `suppressRescue`; pass `--linked-worktree` when
   `git rev-parse --git-dir` ≠ `--git-common-dir`. Routing (`routeTask`) is decided HERE, never in the
   workflow. (`prepare-wave` filters out `done` tasks, so a recover re-runs ONLY the incomplete ones.)
2. **Capture the D6 baseline.** `before = ( git -c core.quotePath=false diff --name-only HEAD ) ∪
   ( git ls-files -o --exclude-standard )` — the already-touched path set, as a JSON array.
3. **Phase-1 marker.** `mp set-active-run --state=<path> --wave=N` — written BEFORE launch so a crash
   in the launch gap resumes as `recover_and_redispatch`, not a blind re-dispatch.
4. **Launch in the background.** Start `workflows/execute.workflow.js` via the Workflow tool with
   `args = { wave:N, tasks:<step 1>, baseline:<step 2>, repoRoot:<repo>, review:<step 1's review> }`.
   Background so it outlives the turn; its completion notification re-invokes this controller.
5. **Phase-2 handles.** `mp promote-active-run --state=<path> --run-id=<id> --task-id=<id>` with the
   launched run's handles.
6. **Close** to await completion. Do NOT mark tasks or commit here — the engine has them in flight.

**Completion** (re-invoked holding the engine's `<result>` — reached from §2 step 3):

1. **Record digests — BEFORE any `decide`.** For each `result.tasks[i]`: `digest.status==='done'` →
   `mp mark-task --state=<path> --id=<id> --status=done`; `failed`/`blocked` → leave it `pending` and
   collect it to surface (those statuses are not writable — `recover_and_redispatch` re-runs them).
   Note any `review.verdict==='blocking'` to surface even on a `done` task.
2. **D6 scope verify.** Capture `after` (the same two git commands), then `mp verify-scope
   --state=<path> --wave=N --before='<result.baseline>' --after='<after>'`. On `ok:false` an agent
   wrote outside declared scope: revert the offenders — `git checkout -- <outOfScope>` and (non-empty)
   `git clean -fd -- <outOfScope>` — and surface the breach (`-fd`, matching the recover path, so an
   out-of-scope new directory is removed too). In-scope work stands.
3. **Commit once.** Commit `state.yml` AND the wave's in-scope file edits together. State leads git
   (CD-7): a crash before the commit re-derives from the marked-`done` state on the next resume.
   **Narrate tersely:** after the commit, print at most a 1–2 line wave summary (what completed /
   what's next) — NEVER echo the `state.yml` or `WORKLOG.md` diff to screen (anti-flood; the full
   record lives in the bundle + `git log`).
4. **Re-decide.** Re-enter step 4. With the wave's tasks now `done`, `decide` returns `finalize_run`
   (→ clear `active_run` → next wave, or `complete`); any task left `pending` (failed/blocked, or
   scope-reverted) drives `recover_and_redispatch` for ONLY those, idempotently. Surface failed/blocked
   tasks or a `blocking` verdict via `AskUserQuestion` (§4) — never silently loop.

## 2b — Parallel-plan dispatch + completion (the planning L1↔L2 seam)

`workflows/plan.workflow.js` (L2) fans out **one `mp-subsystem-planner` per subsystem** in a single
parallel barrier and returns **fragments only** — it never writes artifacts or commits. This shell
owns the decomposition (the subsystem list), the deterministic merge, and the gate. It mirrors §2a
**minus the wave loop and minus any scope capture** — the drafters are read-only, so there is no D6
baseline and no `verify-scope`. `active_run.kind:'plan'` carries **no wave**.

**Launch** (reached from §3a's parallel branch, and from `recover_plan_run`):

1. **Subsystems in hand.** Use the decomposition from §3a (`mp-spec-decomposer`'s `{subsystems}`). On
   `recover_plan_run` with none in hand, re-dispatch `mp-spec-decomposer` first — the fan-out is
   idempotent, so re-deriving the seam map is safe.
2. **Phase-1 plan marker.** `mp set-active-run --state=<path> --kind=plan` — a planning marker (no
   wave) written BEFORE launch so a crash in the launch gap resumes as `recover_plan_run`, not a
   blind re-dispatch.
3. **Launch in the background.** Start `workflows/plan.workflow.js` via the Workflow tool with
   `args = { subsystems:<step 1>, specPath:<spec_path>, repoRoot:<repo> }`. Background so it outlives
   the turn; its completion notification re-invokes this controller (→ §2 step 3 → here).
4. **Phase-2 handles.** `mp promote-active-run --state=<path> --run-id=<id> --task-id=<id>`.
5. **Close** to await completion. Do NOT merge or commit here — the fan-out is in flight.

**Completion** (re-invoked holding the engine's `<result>` = `{ subsystems:[…fragments…], specPath,
repoRoot }`, reached from §2 step 3 when `active_run.kind==='plan'`):

1. **Reconcile coverage.** Diff the returned fragment `key`s against the requested subsystem keys;
   **surface any missing subsystem** (a drafter that errored/skipped nulls out — never fake it). A
   missing drafter is a `REVISE`-class gate, not a silent drop.
2. **Stage the fragments.** Write the returned `subsystems` array to `<bundle-dir>/.plan-fragments.json`
   (a plain `Write` — `plan.index.json` / `plan.md` / fragments are **ARTIFACTS, not CD-7 state**, so
   this write is allowed outside the `mp`-only rule).
3. **Merge (deterministic).** `mp merge-plan-fragments --fragments=<bundle-dir>/.plan-fragments.json
   --out=<plan_index_path> --plan-md=<plan_path> --meta='{"title":"<topic>","spec":"<spec_path>"}'` —
   assigns global ids/waves, normalises `codex`, **validates BEFORE writing**, and stamps
   `plan_hash`/`generated_at` onto both artifacts. A merge error (dup key, dangling/cyclic dep, invalid
   index) exits non-zero and writes nothing — surface it and stop.
4. **Explicit gate.** `mp validate-plan-index --plan-index=<plan_index_path>` — the standalone strict
   check, the compensating layer now that fragments crossed a background-Workflow boundary (the
   `FRAGMENT` tool-schema enum guarded the foreground path; this re-guards `codex` shape + same-wave
   file-disjointness on disk).
5. **Review.** Dispatch `agents/mp-plan-reviewer` against `plan.md` / `plan.index.json` / `spec.md`
   → `PASS | REVISE | FAIL`.
   - **PASS** → `mp clear-active-run`; **`mp load-plan --state=<path> --plan-index=<plan_index_path>`**
     (materializes `state.tasks` from the plan **and** advances `phase→execute` in one atomic write — the
     plan→execute seam; a bare `set-phase execute` would leave `tasks:[]`, so the next `decide` would
     `complete`→archive the just-planned bundle) + `mp event --state=<path> --type=phase_transition
     --phase=execute`; commit `plan.index.json` + `plan.md` + `state.yml` together (terse 1–2 line
     narration, never the diff — anti-flood); then re-decide (§2 step 4 → `dispatch_wave`).
   - **REVISE / FAIL** (or a missing subsystem from step 1) → `mp clear-active-run`; surface the
     reviewer's findings via `AskUserQuestion` (§4) — revise-and-replan / accept-as-is (REVISE only) /
     stop — and keep `phase=plan`. Never auto-advance past a non-PASS verdict.

## 3 — Other verbs (sequencing only — content lives elsewhere)

| verb | v8 target |
|---|---|
| `full` / `brainstorm` / `plan` | Locate the bundle, or **seed a new one** — `mp seed --state=<path> --slug=<slug> --topic="<topic>" [--complexity=… --autonomy=… --planning-mode=serial\|parallel\|auto --predecessor-transcript=…]` (writes a valid v8 brainstorm-phase bundle; refuses an existing one unless `--force`). **Brainstorm:** invoke `superpowers:brainstorming` directly; on spec approval, `mp set-phase --state=<path> --phase=plan` + `mp event --state=<path> --type=phase_transition --phase=plan` (never hand-edit `state.yml` — CD-7). **Plan:** hand to the **plan lifecycle (§3a)**, which selects serial vs parallel per `planning.mode`, then materializes `state.tasks` **and** advances `phase→execute` in one atomic `mp load-plan` write (the plan→execute seam; the lower-level `mp seed-tasks` populates tasks *without* touching phase, for recovering an already-`execute` bundle). The seam is guard-enforced: `mp set-phase --phase=execute` refuses a 0-task bundle without `--force`, and `decide` *throws* on a `phase:execute` + `tasks:[]` bundle rather than finalizing an unseeded run — so a bare `set-phase execute` can never silently archive a planned-but-unseeded run. Log other milestones with `mp event …`; gates via `mp open-gate` + an `AskUserQuestion`. (`brainstorm` stops once the plan phase is reached; `plan` runs §3a; `full` continues through execution via §2.) |
| `execute` | The resume controller (§2). |
| `retro` | Generate `retro.md` for the bundle, then close. Archival is `complete`'s terminal step (§2), NOT this verb's — a standalone `retro` must NOT `set-status archived` (that would strand a run with pending tasks: the §2 discover filter hides archived bundles). Safe to (re)generate a retro on an in-progress or finished run. |
| `import` | Legacy intake → a v8 bundle: `mp migrate-bundle` an in-place legacy `state.yml` (backs up the original). **On a pre-5.0 refusal the §2 step-2 rule applies: do NOT raw-rewrite `state.yml` (CD-7) — treat the legacy bundle as read-only and `mp seed` a fresh one, finish under v7, or stop and ask.** |
| `doctor` | `node "${CLAUDE_PLUGIN_ROOT}/bin/doctor.mjs" [--fix]`. **[checks = step 5.]** |
| `status` | Read-only: `mp decide` (no writes) + a one-screen situation report from `state.yml`. |
| `validate` | Parse-check `state.yml` + config; report findings. No writes. |
| `stats` | `jq` roll-up over `events.jsonl` if present (replaces the v7 telemetry scripts). |
| `clean` | Archive (`mp set-status --state=<path> --status=archived`) / prune completed bundles. |
| `next` | `mp decide` → describe the next action without executing it. |
| `verbs` | Print the reserved-verb list above. |

## 3a — Plan lifecycle (serial | parallel — the `planning.mode` gate)

Reached when a bundle is in `phase=plan` with no plan yet: from §3's `full`/`plan` seed path (after
brainstorm's spec is approved and `mp set-phase plan` ran) and from §2's `resume_phase`. Selects
between the serial `superpowers:writing-plans` path and the parallel fan-out (§2b) per `planning.mode`.

1. **Resolve the mode.** `serial | parallel | auto`, from the `resume_phase` action's `planning_mode`
   (default `auto`); set at seed via `mp seed --planning-mode=…`.
2. **Decompose (unless `serial`).** For `parallel`/`auto`, dispatch `agents/mp-spec-decomposer` against
   `spec.md` → `{ subsystems, recommend_parallel, reason }`.
   - `parallel` → parallel branch (step 4) with this decomposition.
   - `auto` → parallel **iff** `recommend_parallel && subsystems.length ≥ 2`; otherwise serial (step 3).
     Carry the decomposer's `reason` into your narration.
   - `serial` → skip the decomposer → step 3.
3. **Serial path.** Invoke `superpowers:writing-plans` directly → it authors `plan.md`. Parse it into
   the index with the `masterplan:mp-planner` agent → `plan.index.json`. Gate it:
   `mp validate-plan-index --plan-index=<plan_index_path>` (on failure, fix and re-parse — never advance
   on an invalid index). Then **`mp load-plan --state=<path> --plan-index=<plan_index_path>`**
   (materializes `state.tasks` from the plan **and** advances `phase→execute` atomically — a bare
   `set-phase execute` would leave `tasks:[]` and the next `decide` would `complete`→archive the bundle)
   + `mp event --state=<path> --type=phase_transition --phase=execute`, commit, and hand to the resume
   controller (§2 → `dispatch_wave`).
4. **Parallel path.** Hand the decomposition to **§2b**'s plan launch (background fan-out → merge →
   validate → `mp-plan-reviewer` → execute). The phase advances to `execute` inside §2b's completion
   gate, not here.

Both paths converge on the same post-condition — a validated `plan.index.json` + `plan.md`, the
plan's tasks materialized into `state.tasks` and `phase=execute` (both via `mp load-plan`), committed
— after which §2 drives the wave loop.

## 4 — Turn-close (CD-9)

End any turn that needs input with `AskUserQuestion` (2–4 concrete options) — never a free-text
question (sessions compact between turns; a free-text prompt becomes a dead end) and never a silent
stop while a decision is pending. Otherwise close cleanly. The v7 CC-3 trampoline — trace markers,
breadcrumbs, per-turn summary-block hook signals — is **gone**; the banner (§0) and this AUQ-close
are the only ceremony that survives.
