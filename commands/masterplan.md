---
description: "Resumable orchestrator for /masterplan: brainstorm→plan→execute on durable run bundles. Verbs: full, brainstorm, plan, execute, finish, retro, import, doctor, status, validate, stats, clean, next, verbs, publish, follow."
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
exit, read stderr and act on it. **Every run executes in a per-run linked worktree (code) with its
bundle in the MAIN checkout (state); every shell `git` is therefore `-C`-qualified by locus — see the
worktree locus model in §2e (bare `git` is forbidden in this shell).**

## 0 — Boot (every invocation, unconditional)

1. **Version banner — FIRST, before anything else**, even on a compaction-resume / `invoked_skills`
   re-injection (it is the lone CC-2 survivor; build NO enforcement/telemetry apparatus around it):
   run `mp version --args="<verbatim $ARGUMENTS, or empty>" --cwd="<repo root or pwd>"` and print the
   single line it returns.
2. **Host detect.** Run `mp detect-host` with the signals you can observe (`--agent-is-codex` if the
   session identifies the agent as Codex, `--native-tools` if Codex-native tools like `apply_patch`/
   `update_plan` are exposed, `--agents-md` if an `AGENTS.md` is present). If the result's
   `suppressRescue` is true, do NOT dispatch the `codex:codex-rescue` companion anywhere this
   invocation (it would recurse — Codex calling Codex). The same true result is the
   **`codex_host_suppressed`** condition the downstream paths check: it gates the Claude-Code-only
   native task tools in §2a recovery (`recover_and_redispatch` / `recover_plan_run`) and supplies
   `mp prepare-wave --codex-suppressed`. Persisted `codex.routing`/`codex.review` are
   unaffected.

## 1 — Parse the verb

Reserved verbs: `full, brainstorm, plan, execute, finish, retro, import, doctor, status, validate,
stats, clean, next, verbs, publish, follow`. Precedence:

0. **No args** → the **resume controller** (§2).
1. First token is a reserved verb → that verb; consume it, the rest are its args.
2. First arg starts with `--` → `--resume=<path>` / `--resume <path>` alias `execute <path>`;
   other `--flags` are config overrides.
3. Otherwise → treat the whole arg string as a **brainstorm topic** (catch-all).

A topic literally named after a reserved verb needs a word in front (`/masterplan add plan timer`).

## 2 — Resume controller (bare entry, `execute`, and after every durable transition)

The spine. It NEVER decides in prose — it asks `mp decide` and executes the returned action.

1. **Derive MAIN, then locate the bundle.** **MAIN must be derived FIRST** (§2e¶1:
   `MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"`) — the discovery glob
   and every bundle path depend on it, and cwd may already be a linked worktree. Then locate the bundle:
   `execute <path>` → that `state.yml`. Else discover `<MAIN>/docs/masterplan/*/state.yml` (absolute-MAIN,
   §2e¶1) whose status is not archived: exactly one → use it; several → an `AskUserQuestion` picker;
   none → there is no active run (route by verb, or offer to start one).
1.5. **Establish WT/branch + session sweep.** With the bundle's slug now known, derive `WT` / `branch`
   per **§2e¶1** (all subsequent git is `-C`-qualified by locus, §2e¶2; the no-active-run branch has no
   slug → no WT/branch, which is fine — there is no run to dispatch). On the **first** §2 entry of this
   session — any bundle, even the no-active-run branch (the sweep is MAIN-only, slug-independent) — run
   the **global orphan sweep** (**§2e¶5**) to reap crash-leaked worktrees from prior/abandoned runs
   before this run proceeds (idempotent, MAIN-derivable). Skip on later §2 entries this session
   (create-or-reuse stays per-entry; only the sweep is session-gated).
1.6. **Acquire the owner lock (Guard D — cross-session mutual exclusion, §2e¶8).** Only when there IS an
   active bundle (skip the no-active-run branch — nothing to own): `mp acquire-owner
   --state=<MAIN>/docs/masterplan/<slug>/state.yml`. The identity is THIS LLM session
   (`CLAUDE_CODE_SESSION_ID`, passed via env), so the call is idempotent across this session's turns —
   it returns `held-by-self` and refreshes the heartbeat on every later §2 entry (that per-turn refresh
   IS the open-turn heartbeat; the 30-min TTL covers the closed-turn background-wave gap). Branch on
   `outcome`:
   - `held-by-self` → we already hold the lock (idempotent re-entry); proceed.
   - `acquire` | `steal` | `force` → we **PROVISIONALLY** won. Acquire is optimistic: a stale-break removes
     the dead lock via a path-based rename that is NOT atomic on NFS, so under a concurrent break storm more
     than one session can transiently believe it won. The heartbeat re-check is the boundary that resolves
     that transient churn into a single proceeding writer, so **immediately confirm** with `mp heartbeat-owner
     --state=<path>` *before* any worktree mutation or wave dispatch: `held-by-self` → confirmed sole owner,
     proceed · `lost-to-other` → another session won the race; do NOT write state or dispatch — treat exactly
     as `blocked` (surface the same take-over / abort / read-only AUQ below). (Guard D guarantees perfect
     mutual exclusion for LIVE contention — a fresh contended lock is an atomic link() create; the only
     residual is the documented benign case of a >TTL-abandoned owner resurrecting at the instant of reclaim.)
   - `blocked` → **another live session owns this bundle.** Do NOT write state or dispatch. Surface an
     `AskUserQuestion` (CD-9) with the incumbent's `host`/`session` from the result: **Take over
     (force)** → `mp acquire-owner --state=<path> --force` then proceed · **Abort** → close without
     touching the bundle (the other session keeps it) · **Read-only** → answer/inspect this session but
     make NO state mutations, commits, or dispatches. NEVER auto-force regardless of autonomy — a live
     second writer is a risky-action gate.
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
   to the plan lifecycle (§3a); `complete` runs the finalization flow (§2c); `wait` / `surface_gate` close.

   | action | do |
   |---|---|
   | `surface_gate` | Re-render the gate's `AskUserQuestion` (CD-9). A named option → act, `mp clear-gate`, `git -C "<MAIN>"` commit the bundle (state, §2e¶2), re-decide. Free-text / no clear answer → keep the gate, respond, close. NEVER auto-proceed regardless of autonomy (the durable marker outranks a native AUQ that can't survive compaction). When re-rendering `branch_finish`, **rehydrate the codex-review digest**: `mp codex-review-status --state=<path> --sha=$(git -C "<WT>" rev-parse HEAD)` (the code tip under review, §2e¶2) — on `{present:true}` fold its `digest`/`count`/`base` back into the re-rendered AUQ (the live step-5 digest doesn't survive compaction; the durable event does). For the finalization gates (`branch_finish`, `verification_failed`), the per-option **act** is specified in **§2c**. |
   | `wait` | A live run owns the wave. Report it and close — its Workflow completion notification re-invokes this controller, which records the result via the completion protocol (**§2a**, step 3). |
   | `finalize_run` | The wave's tasks are all `done` on disk. **First reconcile a crash between `mark-task` and the wave's split-commit (§2e¶6):** if `active_run.wave` is set and `git -C "<WT>" status --porcelain` is non-empty, the wave recorded task status but its verify-scope + code commit didn't run — re-run that tail (the §2a completion steps 2–3) against the **persisted** baseline: capture `after` (the two `git -C "<WT>"` touched-set commands), `mp verify-scope --state=<path> --wave=<active_run.wave> --after='<after>'` (no `--before` → `bin` uses `active_run.baseline`, §2a launch step 3), revert any out-of-scope in WT (§2a completion step 2), then the **code** commit in WT (§2e¶6). Then `mp clear-active-run`, `git -C "<MAIN>"` commit the bundle (state, §2e¶2), then re-decide (→ next wave, or `complete`). On the normal path the wave already committed → WT is clean → the reconciliation no-ops. |
   | `recover_and_redispatch` | Crash recovery. If `staleTaskId` ≠ null: `TaskList` → `TaskStop` (**Claude Code only** — no-op when `codex_host_suppressed == true`, where the native task tools are absent and reconciliation leans on the on-disk `active_run` marker) any surviving run for it (a backgrounded Workflow MAY outlive session death — reconcile before touching files). Then RESET scope **in the code worktree** (§2e¶2): `git -C "<WT>" checkout -- <resetPaths>` and, **only when `resetPaths` is non-empty**, `git -C "<WT>" clean -fd -- <resetPaths>` — scope the clean to the reset paths; a bare `git clean -fd` (or one with an empty pathspec) would wipe unrelated user-owned untracked files. Then dispatch the wave via **§2a**. Idempotent — agents never commit. |
   | `recover_plan_run` | Crash recovery for a planning fan-out (`active_run.kind:'plan'`). If `staleTaskId` ≠ null: `TaskList` → `TaskStop` (**Claude Code only** — no-op when `codex_host_suppressed == true`) any surviving run. **No git scope reset** — the subsystem drafters are read-only, so nothing was written to revert. Re-launch the fan-out via **§2b** (re-dispatch `mp-spec-decomposer` if the subsystem set isn't in hand). Idempotent. |
   | `dispatch_wave` | Launch one wave through the L2 engine — full sequence in **§2a**. In brief: ensure the run's worktree (create-or-reuse, §2e¶4) → `mp prepare-wave` (resolves routing + `scope`) → capture the WT git baseline → `mp set-active-run --wave=N --scope='<prepare-wave.scope JSON>'` (phase-1 + frozen F-SCOPE snapshot, BEFORE launch) → `cd "<WT>"` (the write-only cwd signal, §2e¶3) → launch `workflows/execute.workflow.js` in the background with `args={wave,tasks,baseline,repoRoot:<WT>,review}` → `mp promote-active-run --run-id=… --task-id=…` (phase-2) → close to await its completion notification. |
   | `resume_phase` | The bundle is mid-`{brainstorm\|plan}` with no plan built yet (`tasks:[]`). **Do NOT finalize/archive** — that would destroy a mid-design run. `phase==plan` → hand to the **plan lifecycle (§3a)** with the action's `planning_mode`. `phase==brainstorm` → re-entering an in-progress `superpowers:brainstorming` is still deferred (step 7), so SURFACE via `AskUserQuestion` — continue the phase, restart it, or stop — and close. Never fall through to `complete`. |
   | `complete` | All execute tasks done → the **finalization flow (§2c)**: verify-before-completion (cite output) → write `retro.md` → the durable `branch_finish` gate → archive **LAST**. NEVER a silent archive — the v8 regression §2c restores. |

6. **CD-7 commit discipline.** Each durable change = a `mp` write (atomic) FOLLOWED BY a `git commit`.
   The **bundle** commit is `git -C "<MAIN>"` (state lives in MAIN); **code** commits are
   `git -C "<WT>"` (the split commit, §2e¶6) — never one mixed `commit -am`. A crash between write and
   commit is safe — `state.yml` leads, resume re-commits (the crash-between-the-two-commits trace is
   §2e¶6). Wave members (agents / the L2 engine) return digests only; they NEVER write `state.yml` or
   commit, which is exactly what makes re-dispatch idempotent.

## 2a — Wave dispatch + completion protocol (the L1↔L2 seam)

`workflows/execute.workflow.js` (L2) runs **exactly one wave per launch**; this shell drives the
wave loop. A Workflow script has no module/fs/git access, so the shell resolves routing and captures
git *here*, threading data in via `args` and reading digests back out — the workflow itself only
dispatches agents and echoes the baseline.

**Launch** (the tail of `dispatch_wave`, and of `recover_and_redispatch` after its scope reset):

0. **Ensure the worktree (create-or-reuse, §2e¶4 — the canonical recipe).** Before the FIRST wave
   dispatch of this run (and idempotently on resume): probe `branchExists` **and** `worktreeRegistered`
   (the canonical `<WT>` already in `git -C "<MAIN>" worktree list` — the crash-between-add-and-record
   guard, §2e¶4), `mp worktree plan … [--branch-exists] [--worktree-registered]` → run the emitted
   `gitArgs` via `git -C "<MAIN>" …` on `create` → `mp worktree record
   --state=<MAIN>/docs/masterplan/<slug>/state.yml --worktree="<WT>"`. Later waves (and a reuse-planned
   resume) — no-op.
1. **Resolve the wave.** `mp prepare-wave --state=<MAIN>/docs/masterplan/<slug>/state.yml
   --plan-index=<MAIN>/docs/masterplan/<slug>/plan.index.json --wave=N [--codex-suppressed]
   --linked-worktree` → `{wave, tasks:[…lean, already-routed…], scope, review}`. Pass `--codex-suppressed`
   when §0 host-detect set `suppressRescue`. Pass **`--linked-worktree` ALWAYS** — every v8 run executes
   in a per-run linked WT (§2e), and the flag only flips the cosmetic logged `target`, **never** review
   (config-gated) or `scope` (the file union). Routing (`routeTask`) is decided HERE, never in the
   workflow. `scope` is the resolved file union across this wave's tasks — the F-SCOPE allow-set.
   (`prepare-wave` filters out `done` tasks, so a recover re-runs ONLY the incomplete ones.)
2. **Capture the D6 baseline** in the code worktree (§2e¶2). `before = ( git -C "<WT>"
   -c core.quotePath=false diff --name-only HEAD ) ∪ ( git -C "<WT>" ls-files -o --exclude-standard )` —
   the already-touched path set, as a JSON array.
3. **Phase-1 marker — with the immutable scope snapshot AND the D6 baseline.** `mp set-active-run
   --state=<path> --wave=N --scope='<step 1's scope>' --baseline='<step 2's before>'` — written BEFORE
   launch so a crash in the launch gap resumes as `recover_and_redispatch`, not a blind re-dispatch.
   Freezing `scope` HERE (before any agent runs) is what lets the post-barrier `verify-scope` police the
   EXACT set dispatched, immune to a mid-wave edit of plan.index/state. Persisting `baseline` (the
   step-2 `before`) is what lets a **post-completion crash** resume re-run verify-scope from
   `finalize_run` (the workflow result carrying `before` is gone by then; the marker still has it) —
   without it that one wave's scope check would be silently skipped (Codex P1).
4. **`cd "<WT>"`, then launch in the background.** Immediately before launch, `cd "<WT>"` — the
   write-only cwd signal the implementer agents inherit (§2e¶3), so their relative-path edits land on
   `masterplan/<slug>`. Start `workflows/execute.workflow.js` via the Workflow tool with
   `args = { wave:N, tasks:<step 1>, baseline:<step 2>, repoRoot:"<WT>", review:<step 1's review> }`
   (`repoRoot` is WT, matching the cwd the agents see). Background so it outlives the turn; its
   completion notification re-invokes this controller.
5. **Phase-2 handles.** `mp promote-active-run --state=<path> --run-id=<id> --task-id=<id>` with the
   launched run's handles.
6. **Close** to await completion. Do NOT mark tasks or commit here — the engine has them in flight.

**Completion** (re-invoked holding the engine's `<result>` — reached from §2 step 3):

0. **Heartbeat re-check before any state write (Guard D, §2e¶8).** `mp heartbeat-owner
   --state=<path>`. `held-by-self` → proceed (the heartbeat is refreshed). `lost-to-other` → a second
   session took this bundle over while our wave ran in the background; **STOP** — do NOT mark tasks,
   verify-scope, or commit (that would corrupt another owner's run). Surface the takeover via
   `AskUserQuestion` (reclaim via `mp acquire-owner --force`, or abandon this session's recording). This
   is the load-bearing pre-write guard the held-by-self/lost-to-other split exists for.
1. **Record digests — BEFORE any `decide`.** For each `result.tasks[i]`: `digest.status==='done'` →
   `mp mark-task --state=<path> --id=<id> --status=done`; `failed`/`blocked` → leave it `pending` and
   collect it to surface (those statuses are not writable — `recover_and_redispatch` re-runs them).
   Note any `review.verdict==='blocking'` to surface even on a `done` task.
2. **D6 scope verify.** Capture `after` (the same two `git -C "<WT>"` commands as Launch step 2), then
   `mp verify-scope --state=<path> --wave=N --before='<result.baseline>' --after='<after>'`. The allow-set is the
   IMMUTABLE `active_run.scope` snapshot frozen at launch (Launch step 3) — `verify-scope` reads it
   itself, so there is NO `--plan-index` to pass and NO re-resolution from the now-mutable
   plan.index/state. That is the point: a rogue agent that edits `plan.index.json` mid-wave to widen its
   own scope can't move the allow-set, so its out-of-scope edit is still caught. On `ok:false` an agent
   wrote outside declared scope: revert the offenders **in the code worktree** (§2e¶2) —
   `git -C "<WT>" checkout -- <outOfScope>` and (non-empty) `git -C "<WT>" clean -fd -- <outOfScope>` —
   and surface the breach (`-fd`, matching the recover path, so an out-of-scope new directory is removed
   too). In-scope work stands.
3. **Split commit (§2e¶6).** The code edits and the state live on different branches/loci, so commit
   each scoped: **code** → `git -C "<WT>" add <the wave's in-scope code files ONLY>` + `git -C "<WT>"
   commit` (never `add -A` / `commit -am`); **state** → `git -C "<MAIN>" add docs/masterplan/<slug>` +
   `git -C "<MAIN>" commit`. The leading durable action is the `mp mark-task` WRITE (step 1), not either
   commit — state leads git (CD-7): a crash anywhere in `mark-task → code commit → state commit`
   re-derives on the next resume — the marked-`done` state drives `decide` to `finalize_run`, whose
   reconciliation (§2 finalize_run row) re-runs verify-scope (off the persisted `active_run.baseline`)
   and the code commit for the uncommitted tip, so neither the scope check nor the code is lost (full
   trace §2e¶6).
   **Narrate tersely:** after the commits, print at most a 1–2 line wave summary (what completed /
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
2. **Stage the fragments.** Write the returned `subsystems` array to
   `<MAIN>/docs/masterplan/<slug>/.plan-fragments.json` (absolute-MAIN, §2e¶1 — the bundle lives in
   MAIN even when cwd is a worktree; a plain `Write` — `plan.index.json` / `plan.md` / fragments are
   **ARTIFACTS, not CD-7 state**, so this write is allowed outside the `mp`-only rule).
3. **Merge (deterministic).** `mp merge-plan-fragments --fragments=<MAIN>/docs/masterplan/<slug>/.plan-fragments.json
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
     --phase=execute`; `git -C "<MAIN>"` commit `plan.index.json` + `plan.md` + `state.yml` together
     (all bundle artifacts, MAIN-resident, §2e¶2; terse 1–2 line narration, never the diff — anti-flood);
     then re-decide (§2 step 4 → `dispatch_wave`, which create-or-reuses the worktree, §2e¶4).
   - **REVISE / FAIL** (or a missing subsystem from step 1) → `mp clear-active-run`; surface the
     reviewer's findings via `AskUserQuestion` (§4) — revise-and-replan / accept-as-is (REVISE only) /
     stop — and keep `phase=plan`. Never auto-advance past a non-PASS verdict.

## 2c — Finalization flow (the `complete` action + the `finish` verb)

`complete` is no longer a silent archive — it is the umbrella **finish** flow: verify the work (and
cite it), write the retro, then surface a **durable** `branch_finish` gate before archiving. It
composes two `superpowers` skills — `verification-before-completion` (the authoritative claim-done
gate, step 3) and `finishing-a-development-branch` (executes the chosen disposition on resolve) —
driven by `mp finish-status` (the SHELL runs git and passes its output as flags; `bin` stays fs-only,
the §2a verify-scope pattern). **Every step is re-entrant** (disposition shortcut · verified-at-SHA
skip · write-if-absent), so a compaction at any point resumes cleanly. **Archive is LAST**: archiving
earlier strands the run — the §2-step-1 discover filter hides archived bundles, so the gate could
never re-surface (the one thing v7's flow got wrong; do not copy it).

**Re-entry shortcut precedes the snapshot** (the WT may already be gone). Read `worktree_disposition`
from `state.yml` **MAIN-side, with NO WT git** (a plain `mp`/state read — the §2e¶7 teardown removes
`<WT>` BEFORE re-entering `complete`, so a WT snapshot here would die on a missing worktree, the Codex P1):
if it is already a retirement value (`removed_after_merge` | `kept_by_user`), the `branch_finish` gate
was resolved AND executed in a prior turn (a compaction landed between resolve and archive) → jump
straight to **step 6 (archive)** and do **not** snapshot WT. Else (disposition still `active`/unset → WT
still present) continue to the snapshot.

**Snapshot** (only on the not-yet-retired path; the SHELL runs git, `bin` stays fs-only). The branch
being finished lives in the code worktree, so HEAD/porcelain are read from **WT** (§2e¶2) — which also
isolates the snapshot from any MAIN-side dirt (a wiped index, an unrelated dirty `WORKLOG.md`),
satisfying protect-user-work for free:
`mp finish-status --state=<path>
--head="$(git -C "<WT>" rev-parse HEAD)" --porcelain="$(git -C "<WT>" -c core.quotePath=false status --porcelain)"
--branches="$(git -C "<WT>" branch --format='%(refname:short)')"` → `{task_scope_dirty, task_scope_paths,
unrelated_dirty, base, retro_present, verified, verify_commands, worktree_disposition, codex_review,
dispositions}` (`codex_review` mirrors the dispatch predicate `state.codex.review === true|'on'|'true'`
— it arms the step-5 whole-branch review).

1. **Branch already resolved? (re-entry shortcut — belt-and-suspenders).** The pre-snapshot check above
   already caught the retired case; `finish-status.worktree_disposition` re-confirms it from the same
   read. If `worktree_disposition` is a retirement value (`removed_after_merge` | `kept_by_user`) → jump
   to step 6 (archive). Else continue.
2. **Dirty check (thin net).** §2a commits at every wave boundary, so dirt is rare here. If
   `task_scope_dirty`, commit `task_scope_paths` **in WT** (`git -C "<WT>"` — these are code paths on the
   run branch, §2e¶2). **Leave `unrelated_dirty` untouched** (protect-user-work; MAIN dirt is already
   isolated by reading the snapshot from WT). **Committing here moves the WT HEAD** — re-run the
   `mp finish-status` snapshot (fresh `git -C "<WT>" rev-parse HEAD`) before step 3, so `verified`
   reflects the new commit; a stale `verified=true` carried from the pre-commit snapshot would otherwise
   skip verification on an as-yet-untested commit.
3. **Verification gate — `superpowers:verification-before-completion`.** If `verified` (a recorded SHA
   == HEAD) → skip (already proven at this commit). Else IDENTIFY → RUN fresh → **cite real output +
   exit code** (CD-3; "should pass" is not evidence). Command source: `verify_commands` (the union of
   the plan tasks'); if empty, the skill's own IDENTIFY; if STILL none under `--autonomy=full`,
   `mp open-gate --id=no_verification_command` + AUQ (specify one / proceed without) — never silently skip.
   - **PASS** → `mp record-verification --state=<path> --sha="$(git -C "<WT>" rev-parse HEAD)"` (durable; a
     re-entry at unchanged HEAD then skips the re-run).
   - **FAIL** → `mp open-gate --id=verification_failed` + AUQ (*Fix first & re-run* / *Proceed anyway
     (reviewed)* / *Abort finish*), close. Resolution = the surface_gate act, below.
4. **Retro (write-if-absent).** If `!retro_present`, generate `retro.md` (idempotent — a re-entry skips
   it). This subsumes the old `retro` verb.
5. **Branch-finish gate (durable — the v8 regression this restores).**
   - **Whole-branch codex review first (runs once, before the gate opens).** When *all four* hold —
     `finish_status.codex_review` is true (the dispatch predicate: `state.codex.review` armed — same
     field, same meaning as prepare-wave) ∧ `base` is non-null ∧ §0 host-detect did **not** set
     `codex_host_suppressed` (Codex hosting the command must not review-via-Codex — that recurses) ∧
     `mp codex-companion-path` resolves to an existing script (`{resolved:true, exists:true, path}`) —
     first the **durable re-entry guard**: `mp codex-review-status --state=<path> --sha=$(git -C "<WT>"
     rev-parse HEAD)` (the WT code tip, §2e¶2); on `{present:true}` the review already ran at this exact
     HEAD (a death between the review and `open-gate` is replaying), so **skip the re-run**, rehydrate its
     `digest`/`count`/`base` into the gate AUQ below, write **no** event, and fall straight through to the
     PR probe. Otherwise run the native whole-branch reviewer **foreground/blocking from WT** (cwd = the
     branch's worktree, so `--scope branch` diffs `masterplan/<slug>` against `base` correctly), bounded
     by an OUTER `timeout` ceiling above the companion's internal 240 s status-wait so a network hang can
     never wedge finish: `( cd "<WT>" && timeout 600 node "<path from mp codex-companion-path>" review --scope branch --base <base> )`
     (`review` mode is the one place review's whole-branch unit is correct; its `--wait`/`--background`
     flags are no-ops — `review` always runs foreground — so no `--wait` is needed). **Fail-soft,
     never wedge finish:** ANY non-success — non-zero exit, `timeout`'s `124`, unresolved/missing path,
     `codex_host_suppressed`, or `codex_review` off — is **not** a blocker; emit `mp event
     --state=<path> --type=codex_review_skipped --summary="whole-branch codex-companion review skipped
     (degraded) — <tight reason>"` and PROCEED to the PR probe (the hyphenated "codex-companion …
     skipped" deliberately does **not** match the audit's `\bcodex\s+review\b`, so a degraded finish
     where nothing reviewed still trips `codex_review_configured_but_zero_invocations` — correct). On
     **exit 0**, fold the rendered findings into the gate AUQ below (a brief digest + count, not the
     raw dump) and emit the **durable** record. The digest is review-derived free text — a stray
     quote/backtick/`$()`/newline interpolated into a `--note="…"` shell word would break the command
     (dropping the event → re-introducing the durability bug) or inject a later flag, so transport it
     **shell-safely**: `Write` the brief digest to `<MAIN>/docs/masterplan/<slug>/codex-review-digest.txt`
     (absolute-MAIN, §2e¶1 — never a relative path, since cwd may be a worktree; the Write tool
     is not shell-evaluated, so arbitrary bytes are safe), then `mp event --state=<path>
     --type=codex_review --summary="codex review complete (whole-branch, base <base>) — <n> findings"
     --data '{"sha":"<HEAD sha>","base":"<base>","count":<n>}'
     --note-file=<MAIN>/docs/masterplan/<slug>/codex-review-digest.txt`. Three channels, three jobs: `--summary` is the
     audit signal (the literal "codex review" **does** match `\bcodex\s+review\b` → satisfies the
     configured-but-zero-invocations check, the one invocation this finish owes); `--data` carries the
     quote-safe machine scalars the re-entry guard keys on (`sha`/`base`/`count` only — git-derived,
     never the free-text digest, whose stray quote/backtick/newline would break the subcommand's
     `JSON.parse(--data)` and silently drop the record); `--note-file` carries the digest bytes
     verbatim (`bin` reads the file, never shell-evaluates it) for the gate to rehydrate. This write
     lands **before** `mp open-gate` below — so if the session dies in that window, resume re-runs §2c,
     the guard above finds `{present:true}` at the unchanged HEAD, and the review is **not** re-run (it
     rehydrates instead). **Residual window:** a death *between* the reviewer exiting 0 and this event
     landing leaves no durable record at HEAD, so resume re-runs the review — harmless and idempotent
     at an unchanged tree (the only cost is one more network review; `open-gate` itself is idempotent,
     so the gate never double-opens). Once the gate IS open a resume is `surface_gate`, which
     re-renders the AUQ and re-reads `codex-review-status` to restore the digest (§2 surface_gate row)
     — the live in-context digest does not survive compaction, the durable event does.

   First **probe for an open PR**
   on the branch (the §3 PR probe: `gh pr list --head "<branch>" … | mp pr-summary`). `mp open-gate
   --id=branch_finish`, then AUQ labelled with `base`: `Merge to <base> locally (Recommended)` · `Push
   and open a PR` · `Keep branch + worktree as-is` · `Discard everything` (the skill then requires a
   typed "discard"). **If the probe found a PR (`hasPr`), relabel the second option** → `View / merge
   open PR #<n> (mergeable: <yes|no|unknown>)` — the branch is already pushed with a PR open, so "open a
   PR" would be a duplicate. That option keeps the `pr` choice (→ `kept_by_user`): its resolution is a
   no-op push (the branch is already up) that just surfaces the existing PR URL, never opening a second
   one. This AUQ is the turn-close. On any resume while open, `decide` → `surface_gate`
   re-renders it (CD-9); a **free-text / "not ready" answer holds the gate and chats** (§2 surface_gate
   rule) — the "not done yet" escape, nothing archives.
6. **Archive LAST.** Reached only via step 1 (gate already resolved): `mp set-status --state=<path>
   --status=archived` (the sole archival mechanism — never hand-edit `state.yml`), then `git -C "<MAIN>"`
   commit the bundle (state lives in MAIN, §2e¶2). **Then release the owner lock (Guard D, §2e¶8):**
   `mp release-owner --state=<path>` (drops `.owner.lock` + our heartbeat — the bundle is done, no
   successor should be blocked). Close. The §2 discover filter now hides the bundle → the run goes quiet.
   Done. (The worktree was already removed + its disposition recorded by the `branch_finish` teardown,
   §2e¶7.)

**Gate resolution** (the `surface_gate` **act** — the turn AFTER the user picks a named option):

- **`verification_failed`** — *Fix first*: `mp clear-gate`, close (fix code + commit, then re-invoke
  `finish`/resume → verification re-runs fresh and re-opens the gate if still red). *Proceed anyway*:
  `mp record-verification --state=<path> --sha="$(git -C "<WT>" rev-parse HEAD)"` (a reviewed override, so a
  re-entry doesn't re-loop the same failure) → `mp clear-gate` → re-decide (→ `complete` → §2c:
  verification now skipped → retro → `branch_finish`). *Abort finish*: `mp clear-gate`, close (the run
  stays resumable; nothing archived).
- **`no_verification_command`** — opened by §2c step 3 when no command is found under `--autonomy=full`.
  *Specify a command*: RUN it fresh, **cite output** (CD-3) → PASS: `mp record-verification
  --state=<path> --sha="$(git -C "<WT>" rev-parse HEAD)"` + `mp clear-gate` + re-decide (→ retro → `branch_finish`);
  FAIL: hand to `verification_failed` (`mp open-gate --id=verification_failed` overwrites the single
  `pending_gate` slot — no separate `clear-gate` needed; its acts are above). *Proceed
  without*: `mp record-verification --state=<path> --sha="$(git -C "<WT>" rev-parse HEAD)"` — the reviewed "no
  verification available" override (mirrors `verification_failed`'s *Proceed anyway* so a re-entry
  doesn't re-open this gate) — `mp clear-gate`, re-decide. Never silently skip verification or archive.
- **`branch_finish`** — **re-entry guard first:** re-read `mp finish-status`; if `worktree_disposition`
  is already a retirement value (`removed_after_merge` | `kept_by_user`), the action ran AND its
  disposition was recorded in a prior turn (a compaction landed before `clear-gate`) → do **not** re-run
  the action; just `mp clear-gate` + re-decide (→ `complete` → §2c step-1 shortcut → **archive**).
  Otherwise: delegate to `superpowers:finishing-a-development-branch` with the option **pre-decided** +
  **"tests verified at SHA `<X>`, base = `<base>`"** so it skips its own option prompt (a re-asserted
  hard-gate re-running a green suite at unchanged HEAD is redundant-but-harmless; if it double-prompts
  or fights the durable gate, run the git steps directly using the skill as reference). It executes the
  branch disposition — merge / push+PR / discard / keep — with its git run **in MAIN**
  (`git -C "<MAIN>" merge masterplan/<slug>`, the push). (If the `pr` choice was taken on a branch that
  step 5's probe found **already has an open PR**, the push is a fast-forward no-op and no second PR is
  opened — surface the existing PR's URL.) **Then layer the worktree teardown on top (§2e¶7), NOT a
  replacement** — the skill finished the *branch*; the shell now retires the *worktree* and records the
  disposition from the ACTUAL removal outcome:
  - merge / discard → `git -C "<MAIN>" worktree remove "<WT>"` (add `--force` only if intended-dirty);
    `removalConfirmed` = (that command exited 0). keep / pr → no removal.
  - record via `mp worktree record --state=<path> --choice=<merge|discard|keep|pr> [--removal-confirmed]`
    — `bin` computes the crash-safe disposition with `dispositionAfterTeardown(choice, confirmed)`
    (merge/discard + confirmed → `removed_after_merge`; keep/pr → `kept_by_user`; merge/discard + NOT
    confirmed → `active`, so an unconfirmed teardown is retried on the next §2e¶5 sweep — never the
    phantom `missing`). This SUPERSEDES the old `set-worktree-disposition --disposition=<dispositions[choice]>`
    static-map write: the disposition now turns on whether the removal actually happened, not on `choice`
    alone. The recorded retirement value is what arms the re-entry guard above.
  Then `mp event --state=<path> --type=branch_finish --note=<choice>`, `mp clear-gate`,
  `git -C "<MAIN>"` commit the bundle, re-decide → `complete` → §2c → step-1 shortcut → **archive**.

**Manual entry — `/masterplan finish`.** Bare `finish` locates the bundle and `mp decide`s: `complete`
→ run this flow; tasks still pending (or a run live) → AUQ "N task(s) pending — finalize anyway?
(→ §2c) / keep working (→ §2) / just re-write the retro (→ `--retro-only`)" — never silent-archive an
incomplete run. `finish --retro-only` runs **only** step 4 (the old `retro` behavior).

## 2d — Autonomy contract (loose / full — when a turn may auto-progress)

`state.autonomy` governs exactly ONE thing: whether a turn that finished useful work but hit **no
gate** may close **silently** (auto-progress) or must end with an `AskUserQuestion`. It does **not**
widen, narrow, or skip any gate — the gate set is identical at every autonomy level (`decide` doesn't
read `autonomy`; it only ever returns real actions). Under `autonomy ∈ {loose, full}` the orchestrator
**auto-progresses** and does NOT manufacture an end-of-turn question.

**The COMPLETE stop-set** — the *only* things that may end a turn with an AUQ under loose/full; if the
turn hit none of these, it MUST auto-progress, not ask:

- `surface_gate` for any durable gate: `branch_finish`, `verification_failed`, `no_verification_command`.
- A spec/plan **review FAIL** or a missing-subsystem REVISE (§2b step 5 / §3a).
- A wave that surfaced a **failure** — a `failed`/`blocked` task or a `blocking` review verdict (§2a
  step 4) — or **blocker re-engagement** after the CD-4 ladder fails its rungs.
- Re-entering an **in-progress brainstorm** (`resume_phase`, `phase==brainstorm`): continue / restart / stop.
- The §2-step-1 **multi-bundle discover picker**, and the bare-`finish` **pending-tasks** prompt
  (finalize anyway / keep working / `--retro-only`, §2c manual entry) — both genuine "which path?" forks.
- An explicit **risky-action** confirmation: push / merge / discard / force / external message / secrets.

**Explicitly forbidden** orchestrator-added asks (these ARE the over-asking the contract kills — never
emit them under loose/full):

<!-- cd9-exempt: this list QUOTES forbidden asks as anti-pattern examples to ban them; it does not emit them. -->

- "Run codex or not?" — routing is decided by `mp prepare-wave` (`routeTask`), never by asking.
- "What should I do next?" / "dispatch the next wave?" — between successful steps you **auto-proceed**:
  record digests → commit → dispatch the next wave **in the same turn** (§2a completion → re-decide).
- Per-small-task "looks good?" / "shall I continue?" confirmations.
- "Ready for Wave N" / "awaiting completion" / "status this turn:" ceremonial closers.

**Carve-out marker.** On an **auto-progress turn** — work done, re-decide returned a non-gate action
(`dispatch_wave` / `recover_and_redispatch` / `recover_plan_run` / `finalize_run` / `wait` / a committed
wave) and you are closing **without** an AUQ — end the turn's text with the literal token
**`<mp-autoprogress>`**. The global Stop guard
(`~/.claude/hooks/auq-guard.sh`) stands down when it sees this marker, so it won't force a ceremonial
AUQ onto an authorized autonomous turn. **Never** emit it on a turn that surfaces a stop-set gate (the
gate's own AUQ is the turn-close) or when `autonomy` is neither loose nor full. It is a stand-down
signal for *this plugin's* authorized auto-progress, mirroring the user-side `<no-auq>` hatch.

**Turn-close routing (CC-3-trampoline).** Every turn-close in this shell — a stop-set gate's AUQ, an
auto-progress `<mp-autoprogress>` close, or a plain stop — runs the same canonical **CC-3-trampoline**
sequence, defined **here**: emit the turn's summary block + exit breadcrumb **exactly once**, at
turn-close (never per-tool-call — the v7 hook-driven per-turn ceremony is gone, §5), then close with
the right terminator — an `AskUserQuestion` at a stop-set gate (CD-9), or the `<mp-autoprogress>`
marker on an authorized auto-progress (above). The §0 version banner is an *invocation*-time
obligation (first, before anything), **not** part of this turn-close sequence. This router is the
single in-file enforcement point — no phase-file indirection.

## 2e — Worktree locus model (bundle-in-MAIN, code-in-WT — create / sweep / commit / teardown)

Every v8 run executes in a **per-run linked worktree holding code only**; its run bundle stays in the
MAIN checkout. This section DEFINES the two loci, the create-or-reuse path, the global orphan sweep,
the split commit, and the teardown — referenced by §2 (loci + sweep), §2a (launch + commit), §2c
(teardown), and §3a/§2b (the single creation home is here). The compute core is `lib/worktree.mjs`
behind `mp worktree plan|record|reconcile`; all git stays in this shell (CD-7).

1. **Two loci, one object store.**
   - **MAIN** = the primary worktree (repo root). Re-derive every turn, cwd-independent:
     `MAIN="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"` (resolves to the
     MAIN repo root from ANY cwd inside it, incl. a linked worktree). The **run bundle**
     `docs/masterplan/<slug>/` ALWAYS lives here, on `base` — never on the run branch. So **every
     bundle path is absolute-MAIN, always, in every section** (edited or not): `--state`,
     `--plan-index`, `--plan-md`, `.plan-fragments.json`, `codex-review-digest.txt`, `retro.md`,
     `--note-file`, and every `mp event/mark-task/open-gate/load-plan/...` target is
     `<MAIN>/docs/masterplan/<slug>/…`.
   - **WT** = `<MAIN>/.worktrees/<slug>`, the per-run **code** worktree on branch `masterplan/<slug>`.
     Holds CODE ONLY — the branch never commits the bundle dir, so `merge masterplan/<slug> → base` at
     finish is conflict-free (base's already-advanced bundle wins; no re-point).
   - Derivations (deterministic, mirror `lib/worktree.mjs`): `WT=<MAIN>/.worktrees/<slug>`;
     `branch=masterplan/<slug>`; `branchExists` ⇔ `git -C "<MAIN>" rev-parse --verify --quiet
     refs/heads/masterplan/<slug>` exits 0.

2. **Every shell git is `-C`-qualified by locus — bare `git` is forbidden in this shell.** Because cwd
   is deliberately moved to WT before each wave (¶3), an un-`-C`'d `git` would hit the wrong locus.
   - **MAIN locus** (`git -C "<MAIN>" …`): bundle discovery, the global sweep, every **state** commit,
     the §2c teardown's merge + `worktree remove`, the `branchExists` predicate.
   - **WT locus** (`git -C "<WT>" …`): code edits, the D6 `before`/`after` capture, `verify-scope`
     reverts, the **code** commit, and the §2c finish snapshot's `rev-parse HEAD` / `status --porcelain`
     of the branch under review. **Every `git rev-parse HEAD` in §2a/§2c is the CODE tip → `git -C
     "<WT>" rev-parse HEAD`.** The orchestrator's own git NEVER relies on ambient cwd — re-derive
     MAIN→WT→branch from the slug each turn (compaction-safe).
   - **Sole sanctioned bare git:** the ¶1 bootstrap `git rev-parse --path-format=absolute
     --git-common-dir` that *derives* MAIN. It is cwd-independent by construction (it resolves the same
     common git dir from MAIN or any linked worktree), so it cannot be `-C`-qualified — it is the very
     thing that computes the `-C` target. Once MAIN is known, every other git is `-C`-qualified by locus.

3. **cwd is a WRITE-ONLY signal to the about-to-launch agents — never read it back.** Subagents (both
   Agent-tool and Workflow-spawned) inherit the orchestrator's POST-`cd` cwd. So immediately before
   each L2 wave launch, `cd "<WT>"` — the implementers then inherit cwd=WT and their relative-path
   edits land on `masterplan/<slug>`. The shell NEVER reads cwd back to decide a locus (every shell git
   is explicit-`-C`, ¶2). `execute.workflow.js`'s "your launch cwd IS the target repo (${repoRoot})"
   holds iff we cd'd to WT and pass `repoRoot:<WT>` in the launch args.

4. **Create-or-reuse — the ONLY creation path (per §2 entry, idempotent).** Before the first wave
   dispatch of a run, and idempotently on every resume:
   - probe **two** signals (¶1): `branchExists` ⇔ `git -C "<MAIN>" rev-parse --verify --quiet
     refs/heads/masterplan/<slug>`; `worktreeRegistered` ⇔ the canonical `<WT>` line is present in
     `git -C "<MAIN>" worktree list --porcelain` (i.e. `… worktree list --porcelain | grep -Fxq
     "worktree <WT>"`). `worktreeRegistered` is the **crash-idempotency** signal: a death between
     `git worktree add` and the `mp worktree record` below leaves a live, registered WT with **no**
     `state.worktree` — without this probe the next `plan` would emit a second `create` and the
     `git worktree add` would fail on the already-present dir.
   - `mp worktree plan --repo-root="<MAIN>" --state=<MAIN>/docs/masterplan/<slug>/state.yml
     --branch=masterplan/<slug> [--branch-exists] [--worktree-registered]` → `{action, path, branch,
     gitArgs?}` (`reuse` when the path is recorded **or** already registered).
   - `action:'create'` → the SHELL runs `git -C "<MAIN>" <gitArgs>` (=
     `worktree add <WT> [-b] masterplan/<slug>`); `action:'reuse'` → nothing. `mp` NEVER runs git
     (CD-7) — it emits `gitArgs`, the shell runs them.
   - then `mp worktree record --state=<MAIN>/docs/masterplan/<slug>/state.yml --worktree="<WT>"` to
     persist the owned path (idempotent — re-recording the same path is a no-op write).

5. **Global orphan sweep — once per SESSION, at first §2 entry (a dead run can't reap itself).**
   Teardown for an abandoned/crashed run is done by the NEXT live runner. On the **first** §2 entry
   this session — for ANY bundle, even the no-active-run branch (the sweep is MAIN-derivable):
   - `git -C "<MAIN>" worktree list --porcelain` → `mp worktree reconcile --repo-root="<MAIN>"
     --repo-git-dir="$(git -C "<MAIN>" rev-parse --path-format=absolute --git-common-dir)"
     --worktree-list='<porcelain>'` → `{actions, findings}`.
   - per action — Q2 contract: **auto repair/prune/remove; gate only `manual`; trust the classifier's
     proof-gate for deletion**:
     - `repair` → `git -C "<MAIN>" worktree repair <path>`
     - `prune` → `git -C "<MAIN>" worktree prune`
     - `remove` → `registered:true` (a crash-leak of OUR retired bundle) → `git -C "<MAIN>" worktree
       remove --force <path>`; `registered:false` (a PROVABLY-foreign leftover) → `rm -rf <path>` +
       `git -C "<MAIN>" worktree prune`
     - `normalize` → `mp worktree record --state=<that bundle's MAIN state> --disposition=removed_after_merge`
       (a pure state write — no git)
     - `manual` → surface as a WARN, take NO automated git/rm action (the proof-gate deliberately
       withholds the unprovable cases — `foreign-unverified`, `active-unregistered`,
       `duplicate-ownership`; the live `.worktrees/cc3-visibility` orphan classifies `foreign-unverified`
       → manual → stays human-gated)
     - `none` → no-op.
   - This is the only crash-leak reaper. Per-§2-entry create-or-reuse (¶4) stays per-entry; only the
     sweep is session-gated (re-running it every wave is wasteful + noisy).

6. **Split commit — state and code commit SEPARATELY, to two loci/branches.** Wherever §2a/§2c say
   "commit `state.yml` AND the wave's in-scope file edits together", that is now two scoped commits:
   - **Code** → `git -C "<WT>" add <in-scope code files ONLY>` then `git -C "<WT>" commit` — NEVER
     `add -A` / `commit -am` (WT's frozen bundle-dir checkout, if present, must not be swept into the
     branch; path-scope to the wave's in-scope code paths).
   - **State** → `git -C "<MAIN>" add docs/masterplan/<slug>` then `git -C "<MAIN>" commit`.
   - **Crash between the two commits (CD-7 trace):** the LEADING durable action is NEITHER commit — it
     is the `mp` state WRITE (`mark-task`). Order: `mp mark-task` (durable, atomic) → code commit (WT)
     → state commit (MAIN). Any prefix resumes cleanly:
     - crash after `mark-task` but before EITHER commit → `decide` sees the tasks `done` → `finalize_run`,
       whose reconciliation (§2 finalize_run row) finds the dirty WT and re-runs **verify-scope** (off
       the persisted `active_run.baseline` — that is why §2a launch step 3 freezes it) **and** the code
       commit before clearing the marker + committing state. Neither the scope check nor the code is
       lost — the earlier, weaker "finalize just commits state" behavior is exactly the Codex P1 this
       reconciliation closes.
     - crash after the code commit but before the state commit → the WT is clean, so the reconciliation
       no-ops; `finalize_run` re-commits state. State leads git; git re-derives.

7. **Teardown — layered onto `finishing-a-development-branch` (§2c), NOT a replacement.** The skill
   executes the chosen disposition (merge / push+PR / discard / keep) — its merge + push run in MAIN
   (`git -C "<MAIN>" merge masterplan/<slug>`, the push). AFTER it returns, the shell does WT removal in
   MAIN and records the disposition from the ACTUAL removal outcome:
   - merge / discard → `git -C "<MAIN>" worktree remove "<WT>"` (add `--force` only if intended-dirty);
     `removalConfirmed` = (that command exited 0).
   - keep / pr → no removal.
   - record via `mp worktree record --state=<MAIN>/docs/masterplan/<slug>/state.yml
     --choice=<merge|discard|keep|pr> [--removal-confirmed]` — `bin` calls
     `dispositionAfterTeardown(choice, confirmed)`: merge/discard + confirmed → `removed_after_merge`;
     keep/pr → `kept_by_user`; merge/discard + NOT confirmed → `active` (teardown retried on the next
     sweep — never the phantom `missing`). This REPLACES §2c's old `set-worktree-disposition
     --disposition=<dispositions[choice]>` static-map write: the disposition now depends on whether
     removal actually happened, not on `choice` alone.

8. **Owner sentinel — Guard D, cross-session mutual exclusion (NFS-safe).** Two sessions (possibly on
   different NFS clients — epyc1/epyc2) must not operate the SAME bundle concurrently. `writeState` is an
   atomic WRITE, not a test-and-set, so a `state.yml` owner *field* can't lock; Guard D is a SEPARATE
   sentinel (`<MAIN>/docs/masterplan/<slug>/.owner.lock` + per-owner `.owner.hb.<host>.<session>`),
   created by an atomic `link()` and confirmed via `stat().nlink` — all FILESYSTEM ops in `mp` (no git,
   no CD-7 conflict; the lock is NOT state.yml). The identity is the **LLM session** (`CLAUDE_CODE_SESSION_ID`),
   not the ephemeral `mp` process — stable across this session's turns, so the gate is idempotent.
   - **Acquire** at kickoff — §2 step **1.6** (every §2 entry with an active bundle; `blocked` → the
     force/abort/read-only AUQ; the per-turn re-acquire doubles as the open-turn heartbeat).
   - **Heartbeat** before the state-mutating completion — §2a Completion step **0** (`lost-to-other` →
     STOP writing, a second session took over).
   - **Release** at finish — §2c step **6**, after archive (frees the bundle so no successor is blocked).
   - **Liveness is heartbeat-age TTL only** (default 30m, must exceed the max single background wave — an
     LLM session is not a probeable process, so there is no same-host PID check). A crashed session's
     lock ages out after the TTL and the next acquirer `steal`s it; the `owner-sentinel` doctor check
     WARNs on a stale/corrupt lock (or an orphan heartbeat) and recommends `mp release-owner --force`.
   - `--force` (on acquire or release) is the human takeover — never auto-invoked under any autonomy.
   - **Guarantee (and its honest limit).** Guard D gives PERFECT mutual exclusion for **live** contention —
     a fresh contended lock is an atomic `link()` create, so two live sessions never both proceed. The unit
     of protection is the **turn** (re-heartbeat at step 1.6 / §2a step 0), not the individual write. The one
     residual, accepted by design (perfect single-writer is impossible on NFS without a lock manager): a
     `>TTL`-abandoned owner that resurrects at the exact instant a reclaimer breaks its lock. Narrow, benign,
     documented — NOT a gap to close with another mechanism.

## 3 — Other verbs (sequencing only — content lives elsewhere)

| verb | v8 target |
|---|---|
| `full` / `brainstorm` / `plan` | Locate the bundle, or **seed a new one** — `mp seed --state=<path> --slug=<slug> --topic="<topic>" [--complexity=… --autonomy=… --planning-mode=serial\|parallel\|auto --predecessor-transcript=…]` (writes a valid v8 brainstorm-phase bundle; refuses an existing one unless `--force`). **Brainstorm:** invoke `superpowers:brainstorming` directly; on spec approval, `mp set-phase --state=<path> --phase=plan` + `mp event --state=<path> --type=phase_transition --phase=plan` (never hand-edit `state.yml` — CD-7). **Plan:** hand to the **plan lifecycle (§3a)**, which selects serial vs parallel per `planning.mode`, then materializes `state.tasks` **and** advances `phase→execute` in one atomic `mp load-plan` write (the plan→execute seam; the lower-level `mp seed-tasks` populates tasks *without* touching phase, for recovering an already-`execute` bundle). The seam is guard-enforced: `mp set-phase --phase=execute` refuses a 0-task bundle without `--force`, and `decide` *throws* on a `phase:execute` + `tasks:[]` bundle rather than finalizing an unseeded run — so a bare `set-phase execute` can never silently archive a planned-but-unseeded run. Log other milestones with `mp event …`; gates via `mp open-gate` + an `AskUserQuestion`. (`brainstorm` stops once the plan phase is reached; `plan` runs §3a; `full` continues through execution via §2.) |
| `execute` | The resume controller (§2). |
| `finish` | The finalization verb → the flow in **§2c** (verify → retro → durable `branch_finish` gate → archive **LAST**). Bare `finish` = run §2c (on pending tasks, AUQ "finalize anyway / keep working / `--retro-only`" — never silent-archive an incomplete run). `finish --retro-only` = (re)generate `retro.md` only — no verification, no gate, no archive (the old `retro` behavior); safe on an in-progress or finished run, and it must NOT `set-status archived` (that would strand a run: the §2 discover filter hides archived bundles). |
| `retro` | Deprecated alias for `finish --retro-only`. Print a one-line "`retro` was renamed to `finish` (running `finish --retro-only`)" notice, then run it. Kept for muscle-memory/back-compat. |
| `import` | Legacy intake → a v8 bundle: `mp migrate-bundle` an in-place legacy `state.yml` (backs up the original). **On a pre-5.0 refusal the §2 step-2 rule applies: do NOT raw-rewrite `state.yml` (CD-7) — treat the legacy bundle as read-only and `mp seed` a fresh one, finish under v7, or stop and ask.** |
| `doctor` | `node "${CLAUDE_PLUGIN_ROOT}/bin/doctor.mjs" [--fix]`. **[checks = step 5.]** |
| `status` | Read-only: `mp decide` (no writes) + a one-screen situation report from `state.yml`. **PR-aware** (PR probe ↓): if the branch has an open PR, append the `↪ Open PR #<n> …` line. |
| `validate` | Parse-check `state.yml` + config; report findings. No writes. |
| `stats` | `jq` roll-up over `events.jsonl` if present (replaces the v7 telemetry scripts). |
| `clean` | Archive (`mp set-status --state=<path> --status=archived`) / prune completed bundles. **PR-aware:** before archiving a bundle whose branch has an open PR, AUQ-**warn** (`bundle <slug>: branch has open PR #<n> — archive anyway?`) — warn, don't hard-block (archiving doesn't touch the PR; the user may still want the bundle gone). |
| `next` | `mp decide` → describe the next action without executing it. **PR-aware:** if the branch has an open PR, append the **advisory** `↪ Open PR #<n> ready — merge on GitHub or via /masterplan finish` (advisory only — never a `decide` action, never a blocking AUQ; this is how "a PR to merge" enters the what-do-I-do-next routine without becoming a per-resume nag). |
| `verbs` | Print the reserved-verb list above. |
| `publish` | **Lead → GitHub coordination** (spec §7 — **IMPLEMENTED-UNVERIFIED**, never dogfooded end-to-end). Full procedure: [`docs/coordination-playbook.md`](../docs/coordination-playbook.md) §publish — bootstrap defaults (`mp set-coord --bootstrap`) → preflight (`mp coord-status --fail-if-unpublishable`) → provision the `mp-coord/<slug>/<plan_hash>` contract ref + `mp-int/<slug>` integration branch → one `gh issue create` per unpublished wave task (`mp gh-issue-body`, `mp update-issue-map`) → `mp set-coord --mark-published` + commit. **Follow the playbook exactly — do not improvise the steps from memory.** |
| `follow` | **Follower session → claim + deliver one task** (spec §7 — same playbook, same caveat). Full procedure: [`docs/coordination-playbook.md`](../docs/coordination-playbook.md) §follow — preflight → claim (`mp select-claimable`, assign, `mp validate-claim` won/lost) → build on branch `mp/<slug>/t<id>` from the pinned contract ref (ephemeral bundle outside `docs/masterplan/`) → D6 `verify-scope` + `verify_commands` → PR to `mp-int/<slug>` on pass, release the claim on fail. |

**PR probe (`status` · `next` · `clean` — report-only, never auto-merge).** These three verbs check
for an open PR on the run's branch. Run **shell-side** (the established split — the shell owns git/`gh`,
`bin` is fs-only): resolve `branch` = `state.branch` or, as a fallback, `git -C "<WT>" rev-parse
--abbrev-ref HEAD` (the run branch is checked out in **WT**, §2e¶2 — `-C`-qualified, not bare), then
`gh pr list --head "<branch>" --state open --json number,title,mergeable,url 2>/dev/null` piped to
`mp pr-summary --gh-json='<output>'` → `{hasPr, number, title, url, mergeable}` (`mergeable ∈
yes|no|unknown` — GitHub computes it lazily, so a fresh PR reports `unknown`). `gh` is **best-effort**:
missing / unauthed / no remote / non-GitHub origin → empty → `{hasPr:false}` → no PR line, no error
(it must never break a read-only report). It is **report-only** — masterplan never auto-merges; a merge
happens only via the §2c `branch_finish` gate's Merge path or the user on GitHub. By design this lives
**only** in these human-invoked verbs (+ the §2c gate), **never** in the per-turn `decide` loop — a
"merge your PR" on every resume tick would be the exact over-asking nag the §2d contract kills.

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
3. **Serial path.** Dispatch the `masterplan:mp-planner` agent against the approved `spec.md` → it writes
   both `plan.md` and `plan.index.json` directly (sole producer). Gate it:
   `mp validate-plan-index --plan-index=<plan_index_path>` (on failure, fix and re-parse — never advance
   on an invalid index). Then **`mp load-plan --state=<path> --plan-index=<plan_index_path>`**
   (materializes `state.tasks` from the plan **and** advances `phase→execute` atomically — a bare
   `set-phase execute` would leave `tasks:[]` and the next `decide` would `complete`→archive the bundle)
   + `mp event --state=<path> --type=phase_transition --phase=execute`, `git -C "<MAIN>"` commit the
   bundle (MAIN-resident, §2e¶2), and hand to the resume controller (§2 → `dispatch_wave`, which
   create-or-reuses the worktree per §2e¶4 — the single creation home is §2a/§2e, never here).
4. **Parallel path.** Hand the decomposition to **§2b**'s plan launch (background fan-out → merge →
   validate → `mp-plan-reviewer` → execute). The phase advances to `execute` inside §2b's completion
   gate, not here.

Both paths converge on the same post-condition — a validated `plan.index.json` + `plan.md`, the
plan's tasks materialized into `state.tasks` and `phase=execute` (both via `mp load-plan`), committed
— after which §2 drives the wave loop.

## 4 — Turn-close (CD-9)

End any turn that needs input with `AskUserQuestion` (2–4 concrete options) — never a free-text
question (sessions compact between turns; a free-text prompt becomes a dead end) and never a silent
stop while a decision is pending. Completion is no longer a silent archive either — the §2c
finalization flow always surfaces the `branch_finish` gate (a risky-action AUQ) before archiving.

**Under `autonomy ∈ {loose, full}`, "needs input" means one of the §2d stop-set gates — nothing else.**
A turn that finished useful work but hit no gate **auto-progresses**: do the obvious next safe step in
the same turn (record → commit → dispatch the next wave) and close **without** an AUQ, ending the
text with the `<mp-autoprogress>` marker (§2d) so the global guard stands down. Do **not** manufacture a
"what next?" / "run codex?" / "Ready for Wave N" question — that over-asking is exactly what §2d forbids.
Reserve the AUQ for the genuine stop-set.

Otherwise close cleanly. What's gone from v7 is the *hook-driven per-turn* ceremony — trace
markers, breadcrumbs, and summary-block signals fired on every turn by Stop-hook machinery. v8
consolidates these into a single prompt-driven close: the **CC-3-trampoline** sequence defined in-file
at §2d "Turn-close routing", which emits the summary block + exit breadcrumb **once, at turn-close**,
then closes with this AUQ at a stop-set gate. (The §0 version banner is an *invocation*-time
obligation — first, before anything — not part of turn-close.) That sequence is the only ceremony
that survives.

## 6.5 — Multi-repo apply (qctl backend) — flag-off spec, relocated

The qctl GPU-worker implementer backend's multi-repo apply/verify/commit procedure is a **spec for a
feature that is OFF** (`state.implementer.qctl.enabled` — nothing sets it yet). The full sequence
lives in `docs/design/qctl-multi-repo-apply.md`; do not execute any of it unless that flag is true.
