# Multi-repo apply/verify/commit orchestration (qctl implementer backend)

> **SPEC-ONLY — feature flag OFF.** Relocated verbatim from `commands/masterplan.md` §6.5 at the
> v9 prose-quarantine (Thrust 2 increment 1) — a 97-line operating procedure for a backend that is
> gated on `state.implementer.qctl.enabled === true`, which nothing sets yet; the sequence has never
> been executed end-to-end. The deterministic helpers it names ARE implemented and tested
> (`lib/qctl-{enqueue,artifact,status}.mjs`; `mp enqueue-key | artifact-verify | status-map |
> base-drift | record-qctl-job`), and `test/qctl-apply-rollback.test.mjs` reenacts the
> isolated-index apply sequence against real throwaway repos. When binding lands, implement the
> apply loop as code (e.g. `mp qctl-apply`) — do not move this prose back into the prompt.

## Multi-repo apply/verify/commit orchestration (the shell's job, not `bin`'s)

> **Architectural note:** `bin` is fs-only; L2 (`execute.workflow.js`) has no process/fs/git access.
> Only **this shell** (L1) can run `git` and shell commands. Multi-repo apply, verify, and commit are
> therefore **entirely L1's responsibility** — never delegated to `bin` subcommands or the L2 engine.

The program spans three repos: `petabit-skynet` (fabric + bundle home), `/srv/dev/masterplan`
(the binding seam), and `petabit-sysadmin` (the P1 target). D6 scope-verify and commit are
single-repo operations, so the multi-repo sequence is decomposed per repo, applied **serial-per-repo**,
and committed independently. **No cross-repo atomicity is claimed**: each repo's changes commit on
their own; a multi-repo task is decomposed into per-repo subtasks each carrying their own `target_repo`
and `base` SHA. If true cross-repo atomicity is ever required it becomes its own design — flagged, not faked.

### Per-repo apply sequence

For each target repo, the shell executes this sequence in order:

1. **Pull the artifact by reference.** `qctl results --job <id> --patch --out <file> --print-sha` —
   the patch arrives as a file on disk, never as LLM text (a patch transported through an LLM context
   can be corrupted or truncated). The returned `patch_sha256` is the integrity anchor.

2. **sha256 verify before any mutation.** Compute `sha256(<file>)` and compare against the declared
   `patch_sha256` from the job result. On mismatch: reject immediately — do **not** attempt to apply a
   patch whose integrity cannot be confirmed. Surface the breach and requeue.

3. **Isolated-index `--check` before any mutation.** Run `git apply --index --check <file>` against
   an **isolated** index/worktree — either a `GIT_INDEX_FILE=<tmp>` overlay or a detached linked
   worktree — so that a failing check leaves neither the working tree nor the shared index in a
   partially-mutated state. This is a read-only dry run: if it exits non-zero the patch conflicts with
   the current tree or has already drifted from its `base` SHA.

4. **Base-drift check — deterministic requeue, never force-apply.** If the `--check` fails because
   `HEAD` has drifted from the patch's declared `base` (e.g. a sibling task already committed
   in-scope edits to this repo), the task is **requeued** with the updated base SHA — `mp
   record-qctl-job` updates the persisted `base` so the next enqueue uses the correct parent. A
   force-apply against a drifted tree is never attempted: apply failures are deterministic, not
   transient, and a drifted base means the worker's diff context is stale.

5. **Per-task atomic apply.** Only after a clean `--check`: `git apply --index <file>` applies the
   patch into the index (staged, not yet committed). Each task's patch is applied and verified in
   isolation before the next task's patch is touched.

6. **Per-task D6 verify-scope.** After the isolated apply, `mp verify-scope` re-checks
   `git diff --cached ⊆ task.files ∧ verify_commands rc == 0` in the **target repo**. The
   fabric green gate is advisory; masterplan D6 is authoritative — an out-of-scope staged change or a
   failing verify command causes an immediate rollback of this task (step 7) regardless of the
   producer's reported `status`.

7. **Rollback on failure.** If `--check`, sha256 verify, D6 scope, or `verify_commands` fails for a
   task: `git checkout -- <task.files>` (and `git clean -fd -- <task.files>` if new files were
   staged) in the **target repo** to reset only that task's declared paths. The task is marked
   `pending` (→ idempotent re-dispatch via `recover_and_redispatch`). **Sibling tasks whose patches
   already passed and were staged are left intact** — rollback is scoped to the failing task's
   declared files, not to the whole wave or the whole index. This is the §10 'per-task rollback
   leaves siblings intact' guarantee.

8. **Serial-per-repo merge.** Across a wave, all tasks targeting the same repo are applied
   **serially** in wave order (not in parallel). Serial ordering makes base-drift the exception —
   once task N's patch is staged, task N+1's `--check` sees the N-already-applied tree, which is
   exactly the state task N+1's `base` was computed against if N and N+1 were wave-sequential. Waves
   are **homogeneous** in v1: the planner groups qctl-eligible tasks into their own waves, separate
   from agent-backed waves, so there is no mixed-wave reconciliation to manage.

9. **Commit once per repo after all tasks pass.** When all tasks targeting a given repo have passed
   their per-task verify and are staged, commit `state.yml` AND the wave's in-scope file edits
   together in that repo (CD-7: state leads git; a crash before commit re-derives from the
   marked-`done` state on resume). Different repos commit independently — the `petabit-skynet`,
   `/srv/dev/masterplan`, and `petabit-sysadmin` commits are separate git operations with no shared
   transaction.

### Crash recovery

`mp` persists the durable `job_id` and `base` SHA for each in-flight qctl task. On resume:

- Re-attach to the job (`qctl status`/`wait`) instead of re-enqueuing — `enqueue` is key-idempotent
  (upserts on `hash(run_slug, wave, task_id, base, scope)`), so a retry never creates a duplicate GPU run.
- If the artifact was already pulled and sha256-verified (recorded in state), skip the pull and
  re-run from step 3.
- If the apply was attempted but the commit did not land (crash between apply and commit): the staged
  index state may be partially applied — run the rollback (step 7) for each task that lacks a
  `done` marker, then re-apply from step 3. The apply sequence is idempotent for the same `base` +
  patch bytes combination.

### Summary: what the shell does, what `bin` does

| Responsibility | Owner |
|---|---|
| `qctl enqueue / wait / results` | **Shell** (L1 — can shell); `mp enqueue-key` decides reuse-vs-upsert before any enqueue |
| sha256 artifact verification | **Shell** reads the bytes; **`mp artifact-verify`** checks the sha256 / parses the IMPL_DIGEST |
| `git apply --index --check` (dry run, isolated index) | **Shell** |
| `git apply --index` (per-task atomic apply) | **Shell** |
| Per-task rollback (`git checkout -- <files>`) | **Shell** |
| Serial-per-repo ordering | **Shell** |
| producer status → task_status mapping | **`mp status-map`** (§6.2 lossless mapping) |
| base-drift decision (apply vs requeue) | **`mp base-drift`** (shell passes recorded base + current HEAD) |
| `mp verify-scope` (D6 — authoritative gate) | **Shell** calls `bin` |
| `mp mark-task`, `mp record-qctl-job` (state writes) | **`bin`** (fs-only, sole state writer) |
| `git commit` (wave-end, per repo) | **Shell** |
