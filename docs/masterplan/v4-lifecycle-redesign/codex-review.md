# Codex review — v4.0 lifecycle redesign

## FM-A — Hollow completion
### Findings (cite line numbers, quote orchestrator text)

- Step C writes terminal completion before retro proof exists: line 1756 says to set `status: complete`, `phase: complete`, `next_action: none`, and `stop_reason: complete`, then append `plan_completed`.
- The retro path is best-effort after the terminal write: line 1760 says `Step R writes docs/masterplan/<slug>/retro.md`, but also says `If retro generation fails, append a completion_retro_failed event, leave status: complete`.
- Step R's archive step has the right invariant but only after retro succeeds: line 2068 says to confirm `artifacts.plan`, `artifacts.spec`, and `artifacts.retro` point inside the same run directory before archive state is written.
- Step CL archives completed bundles without retro validation: line 2210 says completed detection scans `status: complete`, terminal `next_action`, then collects the whole run directory as the artifact set. It does not require `retro.md` on disk or non-empty `artifacts.retro`.
- Doctor catches the leak too late: line 2140 defines `completed_plan_without_retro` as a warning for completed bundles with no `retro.md`.

### Structural change (write-time enforcement)

Move terminal completion behind a parent-owned completion barrier:

1. In Step C 6a, keep `status: in-progress`, `phase: finish_gate`, and `next_action: generate completion retro` until the retro barrier passes.
2. Run Step R in internal mode before writing `status: complete`.
3. After Step R returns, the parent orchestrator must synchronously verify all of these before the completion write: `<run-dir>/retro.md` exists, file size > 0, `artifacts.retro` points to that file, `events.jsonl` contains the retro event for this completion, and the retro/state/events commit either exists or is staged into the same completion commit.
4. If any check fails, write `status: in-progress`, `phase: retro_gate`, `pending_gate.id: completion_retro_failed`, and `stop_reason: question`; do not write `plan_completed`, do not set terminal `next_action`, and do not enter Step CL.
5. For explicit `--no-retro` or `completion.auto_retro=false`, require an explicit waiver field such as `retro_policy: waived` plus `retro_waived_reason` and `retro_waived_at`. Step CL can archive a missing retro only when this waiver exists. Absence of both a retro artifact and waiver is invalid at write time.
6. In Step CL `completed` detection, refuse to collect a completed bundle unless the same invariant holds. This is a guardrail, not the primary detector.

This makes hollow completion impossible because the only writer of `status: complete` must first prove either retro existence or an explicit waiver.

### v3 compat impact

No read compatibility break. Existing `schema_version: 2` bundles remain readable. A v2 bundle with `status: complete` and no retro/waiver should route to a `retro_gate` remediation before archive or clean, not fail parsing. New v4 writes can add waiver fields as optional extensions while keeping `schema_version: 2` readable until a schema bump is chosen.

## FM-B — Restart-thrash
### Findings (cite line numbers, quote orchestrator text)

- Step B0 only performs a weak related-plan scan: line 908 asks agents to identify plans whose `slug or branch name overlaps with the topic's salient words`.
- The recommendation is advisory, not a write-time uniqueness constraint: line 911 says to use an existing worktree if a non-current worktree has branch or slug overlap, but the user can still create a new run.
- The only hard duplicate gate is exact directory collision: line 929 says to derive `<slug>` from the topic and only asks when `docs/masterplan/<slug>/` already exists. Same scope under a different topic string or slug can still create a fresh bundle.

### Structural change (write-time enforcement)

Add a scope identity barrier before Step B0 creates `state.yml`:

1. Compute a deterministic `scope_fingerprint` in the parent orchestrator before slug creation. Inputs should include normalized topic tokens, requested verb, repository root, selected worktree branch, known scope paths from the intent anchor when available, and any matching existing plan/spec titles. Do not base identity on slug alone.
2. Scan all active bundle states across `git_state.worktrees` plus legacy status adapters before writing the new bundle. For each candidate, compute or lazily derive its fingerprint from `scope_fingerprint` if present, otherwise from slug/title/spec H1/plan H1/current branch.
3. If an in-progress or blocked candidate has the same fingerprint, do not create a new bundle. Open a gate with only structural choices: resume existing, supersede existing, or abort. `supersede` must write `superseded_by` on the old bundle and `supersedes` on the new bundle in one locked transaction.
4. If a completed/archived candidate has the same fingerprint, allow restart only after writing `restart_of: <old-state-path>` and a `restart_reason`.
5. Make Step B0's existing related-plan scan informational only; the write barrier above is the invariant.

This makes restart-thrash impossible because a new bundle cannot be written for an already-active scope unless the old bundle is explicitly linked and retired.

### v3 compat impact

No read compatibility break. Existing v2 bundles without `scope_fingerprint` can be lazily indexed from their current fields. New fields (`scope_fingerprint`, `supersedes`, `superseded_by`, `restart_of`) are optional for old bundles and required only for new writes that collide.

## FM-C — Import hydration gap
### Findings (cite line numbers, quote orchestrator text)

- Step I delegates canonical artifact creation to a conversion subagent: line 1850 says to dispatch one Sonnet conversion subagent per candidate.
- The conversion brief asks that subagent to write both artifacts and state: line 1852 says to rewrite the source into `<spec-path>` and `<plan-path>`, then write `state.yml` with `artifacts.spec`, `artifacts.plan`, `artifacts.events`, and `legacy:` pointers.
- The declared bounded scope is still subagent-owned writes: line 1854 says the agent writes only inside its own run directory and does not touch the legacy source.
- The commit step stages whatever bundle was produced: line 1868 says to `git add` the new run bundle (`spec.md`, `plan.md`, `state.yml`, `events.jsonl`).
- Doctor schema repair is field-presence only: line 2123 defines check #9 as missing required fields and its fix as adding missing fields with sentinel or derived values. It does not cross-check `legacy.*` paths against hydrated bundle-local artifacts.

### Structural change (write-time enforcement)

Make import hydration a parent-owned transaction instead of a subagent trust contract:

1. Before conversion, parent copies every legacy source file into `<run-dir>/source/` with stable names and records `legacy_copies[]` in memory. This is copy-only and never deletes or moves legacy files.
2. Conversion subagents may propose `spec.md` and `plan.md`, but the parent must write or rewrite `state.yml` itself after validating the filesystem.
3. Before commit, run a synchronous hydration barrier: `spec.md` exists and is non-empty, `plan.md` exists and is non-empty, `events.jsonl` exists, `artifacts.spec` and `artifacts.plan` point inside the same run directory, every non-empty `legacy.*` pointer either has a matching `legacy_copies[]` entry or the original source still exists, and `state.yml` contains no `legacy.*` pointer without a corresponding bundle-local artifact.
4. If conversion omitted `spec.md` or `plan.md`, parent writes deterministic fallback artifacts from the copied source: `spec.md` becomes an import-context wrapper citing the copied source; `plan.md` becomes an import-verification plan that preserves source task text and marks unresolved tasks as verify-before-continuing. Mark `import_hydration: fallback` in state/events.
5. Only after the hydration barrier passes may I3.5 commit the bundle.

This makes hollow-from-import impossible because a state file with legacy pointers cannot be committed unless bundle-local spec and plan artifacts exist and are referenced.

### v3 compat impact

No read compatibility break. Existing v2 imported bundles remain loadable. On resume or doctor, bundles with non-empty `legacy.*` and empty/missing `artifacts.spec` or `artifacts.plan` should be treated as needing hydration, not as unreadable. New `source/` copies and `import_hydration` metadata are additive.

## FM-D — Subagent brief contract weakness
### Findings (cite line numbers, quote orchestrator text)

- The architecture relies on bounded subagent outcomes: line 436 says to dispatch work to fresh subagents and consume only digests.
- Mechanical validator work is delegated by phase, not specified as executable algorithms: line 455 says Step D doctor checks receive a worktree path and checks list, returning findings.
- The doctor dispatch description is broad: line 2096 says each Haiku runs all plan-scoped checks for its worktree and returns findings JSON.
- Check #9 itself is declarative: line 2123 says schema violation means `state.yml` missing required fields and lists the required set, but does not prescribe the per-file algorithm, coverage accounting, or parent-side reconciliation required to prove the check ran.
- The prompt already recognizes that structural validation can avoid subagent trust in one site: line 1188 requires an orchestrator inline scan for every task's `Files` and `Codex` annotations, and line 1189 only uses the inline path after the scan returns complete.

### Structural change (write-time enforcement)

Promote lifecycle-critical subagent contracts into executable contracts with parent-side acceptance:

1. Define a machine-readable `contract_id` for each lifecycle subagent site (`doctor.schema_v2`, `import.convert_v1`, `related_scope_scan_v1`, `retro.source_gather_v1`).
2. For each contract, include explicit algorithms, not outcome labels. Example for schema: for each `state.yml` path, YAML parse; for each required field in the schema list, read by dotted path; violation if absent, null where non-nullable, or empty string for artifact paths; emit `{path, field, actual_state, violation}`.
3. Require every subagent return to include `contract_id`, `inputs_hash`, `processed_paths[]`, `violations[]`, and `coverage: {expected_count, processed_count}`.
4. Parent accepts the result only if coverage matches the input list and `contract_id` matches the site. Otherwise parent discards the subagent result and runs the deterministic inline fallback.
5. For write-time lifecycle transitions, parent repeats the invariant locally before writing state: completion barrier, import hydration barrier, scope identity barrier, and worktree barrier. Subagent output can inform the gate, but cannot be the proof.

This makes the Haiku-missed-schema class impossible because a subagent cannot silently omit check #9; missing coverage fails the contract before its findings are trusted.

### v3 compat impact

No bundle compatibility break. This changes orchestrator/subagent protocol, not the on-disk v2 state schema. If contract metadata is logged to `subagents.jsonl` or `events.jsonl`, it is additive.

## FM-G — Orphaned worktrees
### Findings (cite line numbers, quote orchestrator text)

- `state.yml` records a worktree pointer as a minimum field: line 178 defines `worktree: /absolute/path/to/worktree`.
- Step B0 records the chosen worktree path and branch before creating the bundle: line 927 says they go into `state.yml` before Step B1.
- Step C resume verifies only current directory/path existence, not git registration: line 1175 says to compare the `worktree` field to `pwd`, `cd` into it, and gate only if the recorded path no longer exists.
- Step C completion does not reconcile the recorded worktree with `git worktree list`: line 1736 runs `git status --porcelain` in the recorded worktree, then line 1756 writes terminal complete state.
- Step CL's worktree cleanup checks the opposite direction only: line 2215 compares `git worktree list` paths to filesystem reality and removes registered worktrees whose paths are missing. It does not compare bundle `worktree:` pointers to registered worktrees, nor require a disposition before archiving.

### Structural change (write-time enforcement)

Add a worktree ownership/disposition barrier around every lifecycle transition:

1. Expand state writes with `worktree_ref: {path, branch, gitdir, registered_at_creation, created_by_masterplan}` and `worktree_disposition: active | kept_by_user | removed_after_merge | missing_needs_repair`.
2. At Step B0 creation, parent records the `git worktree list --porcelain` entry for the selected path, including gitdir/branch where available. If the selected path is not registered, block creation or require an explicit `external_worktree` disposition.
3. On every Step C entry and before Step C 6a completion, refresh `git worktree list --porcelain`; require that `state.yml.worktree` is registered, exists on disk, and matches the recorded branch/gitdir. If not, keep status nonterminal and open a repair gate.
4. Before any branch-finish option removes a worktree, move or commit the run bundle to the durable base location, set `worktree_disposition: removed_after_merge`, append the removal event, and only then call the worktree removal operation.
5. If the user chooses to keep the worktree, write `worktree_disposition: kept_by_user` during completion. Step CL may archive a completed bundle only when `worktree_disposition` is non-active.
6. Extend clean/doctor reconciliation bidirectionally: registered worktrees missing on disk, bundle pointers to unregistered/missing paths, and registered worktrees with no active bundle or explicit keep disposition.

This makes orphaned worktrees impossible at completion/archive time because the state cannot become terminal while the worktree relationship is unresolved.

### v3 compat impact

No read compatibility break if the new fields are optional for old states. Existing v2 bundles lacking `worktree_ref` or `worktree_disposition` should be treated as `active_unknown` on resume and routed through the repair/disposition gate before archive. Do not require old archived bundles to become editable merely to add disposition metadata.

## Cross-cutting concerns

The shared pattern is that the prompt currently relies on doctor-time detection or subagent-shaped outcomes for invariants that should be parent-owned write barriers. The v4 remediation surface should be small and centralized:

- Add a `transition_guard(state, target_phase)` concept to Step B0, Step I3.5, Step C 6a, Step R3.5, and Step CL. It owns scope identity, artifact hydration, retro proof, and worktree disposition.
- Keep doctor checks as observability and repair UX, not the first enforcement point.
- Keep subagents for search, summarization, and candidate enumeration. Do not let subagents be the sole writer or sole verifier for lifecycle invariants.
- Preserve `schema_version: 2` readability by making new fields additive and by deriving missing metadata lazily for old bundles. A future schema v3 can require `scope_fingerprint`, `retro_policy`, `import_hydration`, and `worktree_disposition` for new writes, but the v4 orchestrator should still resume v2 states and route them to repair gates.
- Make archive/clean destructive paths consume the same transition guards. A completed bundle should not be archivable unless it is retro-complete or retro-waived, import-hydrated, and worktree-dispositioned.
