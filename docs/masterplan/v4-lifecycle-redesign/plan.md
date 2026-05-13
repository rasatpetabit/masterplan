---
title: Masterplan v4.0 — Phase 4 implementation plan
slug: v4-lifecycle-redesign
phase: planning-complete
status: ready-for-execution
inputs:
  - docs/masterplan/v4-lifecycle-redesign/spec.md
  - docs/masterplan/v4-lifecycle-redesign/codex-review.md
created: 2026-05-13
---

# Masterplan v4.0 — Phase 4 implementation plan

## Overview

This plan translates the approved lifecycle-hardening spec into 7 sequential/parallel implementation waves against `commands/masterplan.md` (~2652 lines), `bin/masterplan-state.sh`, `docs/internals.md`, and two new files (`commands/masterplan-contracts.md`, `bin/masterplan-self-host-audit.sh`). Every wave produces a commit-ready delta; Wave 7 produces the v4.0.0 tag.

Wave 1 (Foundation) is the prerequisite for all other waves: it adds the `transition_guard` helper in `bin/masterplan-state.sh`, wires schema_v3 field defaults into Step B0, inserts the lazy v2→v3 migration shim into the Resume controller, and adds a temp-dir sweep at the end of Step 0. Waves 2 (FM-A: hollow completion) and 3 (FM-C: import hydration) are independent of each other and run in parallel after Wave 1. Waves 4 (FM-B: kickoff scope-overlap), 5 (FM-D: contract pattern), and 6 (FM-G: worktree disposition) each depend only on Wave 1 and may run in parallel after Waves 2 and 3 land. Wave 7 (migration smoke + tag) is the final gate.

Each wave is verified by concrete grep patterns, `bash -n` syntax checks, and smoke recipes before the next wave begins. Under `--autonomy=loose`, the orchestrator auto-progresses between successful waves; gates fire only at verification failures or spec-ambiguity blockers.

```
Wave 1 (Foundation)
  ├── Wave 2 (FM-A)  ─┐
  ├── Wave 3 (FM-C)  ─┤ (parallel pair)
  ├── Wave 4 (FM-B)  ─┤
  ├── Wave 5 (FM-D)  ─┤ (any order after W1; 4+5+6 can run after W2+W3 land)
  └── Wave 6 (FM-G)  ─┘
        └── Wave 7 (Migration + tag)
```

---

## Wave 1 — Foundation: transition_guard + schema_v3 plumbing + temp-dir hygiene

### Files touched

- `/home/grojas/dev/superpowers-masterplan/bin/masterplan-state.sh` — new `transition-guard` subcommand (edit)
- `/home/grojas/dev/superpowers-masterplan/commands/masterplan.md` — four targeted edits (edit)
- `/home/grojas/dev/superpowers-masterplan/docs/internals.md` — schema_v3 reference section (edit)

### Edit specs

**bin/masterplan-state.sh — new `transition-guard` subcommand**

Location: extend the `case "$mode" in` block at approximately L51-54 (currently only handles `inventory|migrate`). Add:

1. Add `transition-guard)` to the valid-mode guard at L52 alongside `inventory|migrate`.
2. Add argument parsing for the `transition-guard` subcommand:
   - Positional arg 1: `<bundle>` — absolute path to the run bundle directory (contains `state.yml`).
   - Positional arg 2: `<target-phase>` — one of `bundle_created | import_complete | complete | archived`.
3. Implement the guard logic in Bash (invoke via embedded Python at the same `python3 - ...` pattern at L66). The Python function `run_transition_guard(bundle_path, target_phase)` must:
   - YAML-parse `state.yml` in the bundle directory. On parse failure, print `{"disposition":"abort","reason":"state_parse_failed"}` and exit 1.
   - For `target_phase == bundle_created`: compute `scope_fingerprint` tokens from slug + current_task (no Jaccard check at this layer — the orchestrator performs that; the helper just returns the fingerprint tokens). Output `{"disposition":"ok","scope_fingerprint":[...tokens...]}`.
   - For `target_phase == import_complete`: check whether `artifacts.spec` and `artifacts.plan` are both non-empty strings AND whether those files exist on disk (os.path.exists). If either is missing, output `{"disposition":"abort","reason":"import_hydration_missing","missing":[...]}`. If both exist, output `{"disposition":"ok","import_hydration":"full"}`.
   - For `target_phase == complete`: check `artifacts.retro` non-empty AND file exists AND file size > 0 bytes. Also check `retro_policy.waived == true` as an override. If retro missing and not waived, output `{"disposition":"gate","reason":"retro_missing"}`. If worktree non-empty AND `worktree_disposition` not in `{kept_by_user, removed_after_merge, missing}`, read `worktree_disposition`; if empty string or `active` with the path not in `git worktree list --porcelain` output, note `worktree_unresolved`. Output combined disposition.
   - For `target_phase == archived`: same as `complete` plus require `status == complete` or `status == pending_retro` (the latter only when `retro_policy.waived == true`). If `status` is anything else, output `{"disposition":"abort","reason":"not_complete"}`.
4. Exit codes: 0 for `ok` or `gate`, 1 for `abort` or parse failure.
5. Update the `usage()` function header comment at L19-25 to document the new subcommand shape:
   ```
   bin/masterplan-state.sh transition-guard <bundle-path> <target-phase>
   ```
6. Extend the mode guard at L52 to also accept `transition-guard` so `bash -n` and the runtime accept the new verb.

**commands/masterplan.md — Edit 1: schema_v3 field defaults in Step B0 step 6**

Location: Step B0 step 6 at L929. The current text enumerates the initial state fields. After `legacy: {}` append the following block (these are the schema_v3 defaults for new bundles; omit computed fields like `scope_fingerprint` which are set by transition_guard):

```
schema_version: 3
pending_retro_attempts: 0
retro_policy:
  waived: false
  reason: ""
scope_fingerprint: []
supersedes: ""
superseded_by: ""
variant_of: ""
import_hydration: ""
import_contract:
  contract_id: ""
  inputs_hash: ""
  processed_at: ""
worktree_disposition: ""
worktree_last_reconciled: ""
```

Also update `schema_version: 2` at L174 in the run bundle state format section to reflect that v4.0 new bundles write `schema_version: 3`.

**commands/masterplan.md — Edit 2: lazy v2→v3 migration shim in the Resume controller**

Location: Resume controller at L259. The Resume controller has 6 numbered branches. Insert a new preliminary step BEFORE branch 1 (pending_gate check): a lazy migration step that runs whenever a bundle is loaded:

```
0. **Lazy v2→v3 migration.** If the loaded `state.yml` has `schema_version: 2` (or missing `schema_version`):
   a. In-memory: hydrate any absent v3 fields with their defaults (same list as Step B0 step 6 above).
   b. Flag `lazy_migration_pending = true` on the in-memory state.
   c. On any subsequent state write this turn (any path that writes `state.yml`), persist all v3 fields with their in-memory values and bump `schema_version: 3`. Append event `{"event":"schema_v2_to_v3_lazy_migrated","ts":"...","from":2,"to":3}` to `events.jsonl` at that same write. Do NOT write the migration as a standalone write — piggyback it on the first real state mutation.
   d. v2 bundles that are read but never written this turn remain at `schema_version: 2` on disk indefinitely.
```

**commands/masterplan.md — Edit 3: temp-dir sweep at end of Step 0, before verb routing**

Location: Insert a new subsection after the Complexity resolution section (ending approximately at L319) and before the Verb routing table (L321).

New subsection:

```
### Temp-dir sweep (startup, once per invocation)

After complexity resolution, before verb routing, run a one-pass prune of stale masterplan import staging directories:

1. **Enumerate candidates.** List all directories matching `/tmp/masterplan-import-*` using Bash glob. If none exist, skip silently.
2. **Liveness filter.** For each directory whose name contains a PID component (format: `masterplan-import-<slug>-<pid>`), extract the PID. Run `ps -p <pid> -o pid=` (or `kill -0 <pid> 2>/dev/null` as fallback). If the process is alive, leave the directory untouched.
3. **Age filter.** For each remaining directory (no live owner), check mtime via `stat -c %Y <dir>` (Linux) or `stat -f %m <dir>` (macOS). If mtime is within the last 24 hours, leave it untouched (may belong to a recently-killed run that the user may wish to inspect).
4. **Prune.** For each directory that passes both filters (no live owner AND mtime > 24h ago), run `rm -rf <dir>`. Append one `{"event":"tempdir_swept","path":"<dir>","ts":"..."}` event to the active bundle's `events.jsonl` if a bundle is already loaded; otherwise buffer the event for the first state write that creates or loads a bundle.
5. **Never block.** If the glob, stat, or rm fails for any reason (permission denied, concurrent deletion), emit a one-line warning to stdout but continue. The sweep is best-effort.
```

**commands/masterplan.md — Edit 4: status enum update**

Location: The `status:` field definition at L176 (run bundle state model). Append `| pending_retro` to the existing enum:
```
status: in-progress | blocked | complete | pending_retro | archived
```

Also add `pending_retro` to the `phase:` enum at L177:
```
phase: ... | pending_retro | ...
```

**docs/internals.md — Edit 1: schema_v3 reference**

Location: Section 4 "Run bundle format (the only source of truth)". After the current `state.yml` field listing, add a new subsection:

```
### Schema v3 additions (v4.0.0+)

All fields are additive. v2 bundles remain readable with in-memory defaults applied at load time.

- `schema_version: 3` — bumped from 2 for new bundles; lazy-migrated on first write for v2 bundles.
- `pending_retro_attempts: 0` — count of retro generation failures; only meaningful when `status: pending_retro`.
- `retro_policy: {waived: false, reason: ""}` — explicit opt-in skip; `waived: true` requires non-empty `reason`.
- `scope_fingerprint: []` — normalized token array for Jaccard overlap detection; computed lazily.
- `supersedes: ""`, `superseded_by: ""`, `variant_of: ""` — bundle lineage pointers.
- `import_hydration: "" | "full" | "fallback"` — set during Step I3.5 (new).
- `import_contract: {contract_id, inputs_hash, processed_at}` — import transaction receipt.
- `worktree_disposition: "" | "active" | "kept_by_user" | "removed_after_merge" | "missing"` — worktree lifecycle state.
- `worktree_last_reconciled: ""` — ISO timestamp of last `git worktree list` check.
```

### Subagent dispatches

**Wave 1 implementation dispatch (contract_id: wave1_foundation_v1)**

```yaml
contract_id: "wave1_foundation_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave1-foundation)
Goal: Implement Wave 1 edits across bin/masterplan-state.sh, commands/masterplan.md, and docs/internals.md per the Wave 1 edit specs in the Phase 4 plan.
Inputs:
  - /home/grojas/dev/superpowers-masterplan/bin/masterplan-state.sh (full)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 44-329 (Step 0 + run bundle state model)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 895-930 (Step B0 step 6)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 155-209 (state model fields)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 259-276 (Resume controller)
  - /home/grojas/dev/superpowers-masterplan/docs/internals.md section 4
  - This plan's Wave 1 edit specs (above)
Scope:
  - Edit bin/masterplan-state.sh: add transition-guard subcommand
  - Edit commands/masterplan.md: 4 targeted edits per Wave 1 edit specs
  - Edit docs/internals.md: schema_v3 reference subsection
  - Do NOT touch any other sections of masterplan.md
  - Do NOT create new files
Constraints:
  - Wave members MUST NOT modify state.yml, events.jsonl, or eligibility-cache.json (in-wave scope rule)
  - All edits must pass bash -n syntax check on bin/masterplan-state.sh
  - schema_version in the run bundle state model section must be updated to 3
  - The transition-guard Python logic must be self-contained (no external dependencies beyond stdlib)
Return shape:
  contract_id: "wave1_foundation_v1"
  inputs_hash: "<sha256 of input files read>"
  processed_paths: ["bin/masterplan-state.sh", "commands/masterplan.md", "docs/internals.md"]
  violations: []
  coverage: {expected: 3, processed: 3}
  summary: "One-paragraph description of changes made with line ranges"
```

### Acceptance commands

```bash
# 1. Bash syntax check on the helper
bash -n /home/grojas/dev/superpowers-masterplan/bin/masterplan-state.sh

# 2. Transition-guard subcommand is recognized (no "unknown mode" error)
cd /tmp && bash /home/grojas/dev/superpowers-masterplan/bin/masterplan-state.sh transition-guard --help 2>&1 | grep -v "unknown mode"

# 3. schema_version 3 written in Step B0 step 6
grep -n "schema_version: 3" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 4. pending_retro in status enum
grep -n "pending_retro" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md | grep -v "^#"

# 5. Lazy migration shim present in Resume controller region (L259+)
grep -n "schema_v2_to_v3_lazy_migrated" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 6. Temp-dir sweep section present before verb routing
grep -n "Temp-dir sweep" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 7. schema_v3 reference in docs/internals.md
grep -n "Schema v3 additions" /home/grojas/dev/superpowers-masterplan/docs/internals.md

# 8. Smoke: create a scratch bundle directory with a v2 state.yml stub and run transition-guard against it
mkdir -p /tmp/smoke-v4-w1/docs/masterplan/test-slug
cat > /tmp/smoke-v4-w1/docs/masterplan/test-slug/state.yml <<'EOF'
schema_version: 2
slug: test-slug
status: in-progress
artifacts:
  spec: ""
  plan: ""
  retro: ""
EOF
cd /tmp/smoke-v4-w1 && bash /home/grojas/dev/superpowers-masterplan/bin/masterplan-state.sh transition-guard /tmp/smoke-v4-w1/docs/masterplan/test-slug complete 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); assert d['disposition']=='gate', d"
echo "Smoke: transition-guard gate fires correctly for missing retro"
```

### Wave-level checklist

- [ ] `bin/masterplan-state.sh` extended with `transition-guard` subcommand; `bash -n` passes.
- [ ] `commands/masterplan.md` Step B0 step 6: schema_v3 fields written to initial state.
- [ ] `commands/masterplan.md` Run bundle state model: `schema_version: 3`, `pending_retro`, `status` enum updated.
- [ ] `commands/masterplan.md` Resume controller: lazy v2→v3 migration shim (step 0) inserted.
- [ ] `commands/masterplan.md` Step 0: temp-dir sweep subsection added before verb routing.
- [ ] `docs/internals.md`: schema_v3 reference subsection added under Section 4.
- [ ] Commit: `feat: v4.0 wave1 — transition_guard + schema_v3 defaults + temp-dir sweep`

---

## Wave 2 — FM-A: hollow completion

Depends on: Wave 1

### Files touched

- `/home/grojas/dev/superpowers-masterplan/commands/masterplan.md` — four targeted edits

### Edit specs

**Edit 1 — Step C 6a: completion guard**

Location: Step C step 6a at L1736. The current text runs the pre-completion dirty check and then marks complete. INSERT a completion guard check BEFORE the `status: complete` write (after the dirty-check resolves clean):

```
**6a-guard — Retro presence check.** Before writing `status: complete`, invoke `bin/masterplan-state.sh transition-guard <run-dir> complete` inline (not as a subagent dispatch — this is the orchestrator's main-turn synchronous check). Parse the JSON result:

- `disposition: ok` → proceed to the `status: complete` write below.
- `disposition: gate` with `reason: retro_missing` → do NOT write `status: complete`. Instead write `status: pending_retro`, `phase: pending_retro`, `pending_retro_attempts: 0`, `next_action: generate completion retro (pending)`, preserve all other completion fields, append `{"event":"completion_retro_gate_opened","ts":"...","run_dir":"<run-dir>"}` to `events.jsonl`. Then continue Step C step 6b (retro generation) — do NOT surface an AskUserQuestion at this point; let step 6b attempt generation first.
- `disposition: abort` (unexpected state) → set `status: in-progress`, `phase: finish_gate`, append `{"event":"completion_guard_abort","reason":"<reason>"}`, surface `AskUserQuestion("Completion guard aborted for <slug>: <reason>. How to proceed?", options=["Inspect state.yml and retry (Recommended)", "Force complete with --no-retro flag", "Abort completion"])`.
```

**Edit 2 — Step C 6b: pending_retro path on retro failure**

Location: Step C step 6b at L1760. The current text says "If retro generation fails, append a `completion_retro_failed` event, leave `status: complete`, and continue." Replace the failure path with:

```
If retro generation fails AND the current status is `pending_retro` (set by 6a-guard):
  - Increment `pending_retro_attempts` (write to state.yml).
  - Append `{"event":"retro_generation_failed","ts":"...","attempt":<N>}` to events.jsonl.
  - If `pending_retro_attempts == 1`: set `status: pending_retro`, leave bundle in this state. Do NOT write `status: complete`. Continue to step 6c (completion cleanup) and step 6d (branch finish gate) — the bundle is partially complete; those steps are still safe to run.
  - If `pending_retro_attempts >= 2`: surface `AskUserQuestion("Retro generation failed twice for <slug>. Disposition?", options=["Regenerate now (will re-dispatch retro subagent)", "Mark complete_no_retro with waiver — will prompt for reason", "Leave pending (re-check on next /masterplan)"])`.
    - "Regenerate now" → re-dispatch retro subagent; on success set `status: complete` and proceed; on failure leave `pending_retro`.
    - "Mark complete_no_retro with waiver" → `AskUserQuestion("Waiver reason for skipping retro on <slug>?", options=["<free-text Other field>"])`. Write `retro_policy.waived: true`, `retro_policy.reason: <user input>`, set `status: complete`, append `{"event":"retro_waived","reason":"..."}`.
    - "Leave pending" → persist state as-is, → CLOSE-TURN.

If retro generation fails AND the current status is already `complete` (legacy path, pre-Wave2 bundles): append `completion_retro_failed` event, leave `status: complete` (backward-compatible; the v2→v3 migration at Step Resume-Guard will catch it on next access).
```

**Edit 3 — Step Resume-Guard (new section in Resume controller): pending_retro recovery**

Location: After the lazy v2→v3 migration shim inserted in Wave 1 (Resume controller step 0), insert a new numbered step:

```
0b. **Pending-retro recovery.** If `status: pending_retro`:
  a. Emit a visible notice: `↻ Bundle <slug> has status: pending_retro — attempting retro generation.`
  b. Invoke Step R internally with `completion_auto=true` and the loaded slug.
  c. On success: write `status: complete`, clear `pending_retro_attempts`, append `{"event":"pending_retro_recovered","ts":"..."}`. Continue with resume routing (step 1 below).
  d. On failure: increment `pending_retro_attempts`. If `pending_retro_attempts >= 2`, surface the same AskUserQuestion as Step C 6b's "failed twice" path above. Otherwise set `stop_reason: null`, leave `status: pending_retro`, append the failure event, and continue with resume routing so the user can do other work.

This step is the "Step R3.5 resume guard" referenced in the spec. The existing "Step R3.5 — Archive run bundle" label at L2060 (inside Step R) is unaffected — that label refers to the retro archival path, not the resume guard. The new step here is named "Step Resume-Guard step 0b" to avoid label collision.
```

Also insert: For v2 bundles with `status: complete` + missing retro.md (detected by the lazy migration in step 0), the resume controller step 0b fires its recovery logic. Emit a visible event `v2_legacy_pending_retro_detected` before the recovery attempt.

**Edit 4 — Step CL1 (completed category): refuse hollow archive**

Location: Step CL1 detection category 1 at L2210. The current text collects completed bundles for archive. INSERT before the artifact collection:

```
Before collecting a completed bundle for archive, invoke `bin/masterplan-state.sh transition-guard <run-dir> archived` inline. If disposition is `gate` (retro missing, no waiver), do NOT include this bundle in the archive set. Instead emit a one-line notice: `⚠ <slug>: skipped archive — retro missing and not waived. Run /masterplan retro <slug> first.` and continue to the next bundle. If disposition is `ok`, proceed with archive collection. This makes the Step CL archive gate consistent with Step C's completion gate.
```

Also: check #28 (`completed_plan_without_retro`) at L2140 remains as an observability check but its severity can now be downgraded from `Warning` to `Info` for newly-written bundles (since the completion guard prevents hollow completion going forward). The check remains necessary for v2 bundles migrated lazily.

### Subagent dispatches

**Wave 2 implementation dispatch (contract_id: wave2_fma_v1)**

```yaml
contract_id: "wave2_fma_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave2-fma)
Goal: Implement Wave 2 FM-A edits in commands/masterplan.md per the Wave 2 edit specs.
Inputs:
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 1733-1790 (Step C 6a and 6b)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 259-276 (Resume controller, Wave 1 already modified)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 2195-2215 (Step CL1 detection)
  - This plan's Wave 2 edit specs (above)
Scope:
  - Edit commands/masterplan.md: 4 targeted edits per Wave 2 edit specs
  - Do NOT touch bin/masterplan-state.sh, docs/internals.md, or any Wave 1 edit sites unless the edit is a direct continuation of a Wave 1 insertion point
Constraints:
  - The Step C 6a guard MUST invoke transition_guard synchronously (not as a subagent)
  - pending_retro must be in the status enum (Wave 1 already adds it; verify it's present)
  - The Step Resume-Guard step 0b MUST be labeled to avoid collision with existing "Step R3.5" label
  - AskUserQuestion calls must have 3 concrete options with the first marked Recommended
Return shape:
  contract_id: "wave2_fma_v1"
  inputs_hash: "<sha256>"
  processed_paths: ["commands/masterplan.md"]
  violations: []
  coverage: {expected: 1, processed: 1}
  summary: "One-paragraph description of 4 edits made"
```

### Acceptance commands

```bash
# 1. Completion guard present in Step C 6a region
grep -n "6a-guard\|completion_retro_gate_opened\|pending_retro" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md | head -20

# 2. Step 6b failure path updated (no longer leaves status: complete on failure)
grep -n "completion_retro_failed\|pending_retro_attempts" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 3. Step Resume-Guard step 0b present in Resume controller region
grep -n "0b.*Pending-retro recovery\|pending_retro_recovered\|v2_legacy_pending_retro_detected" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 4. Step CL1 archive gate present
grep -n "transition-guard.*archived\|retro missing and not waived" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 5. retro_policy in schema (Wave 1 adds fields; verify waiver path references it)
grep -n "retro_policy.waived\|retro_waived" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 6. Behavioral smoke: grep confirms NO "leave status: complete" on retro failure in 6b
grep -n "leave.*status.*complete\|status.*complete.*continue" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md | grep -v "legacy path\|v2\|backward"
# (expect zero hits for the old pattern outside backward-compat comments)
```

### Wave-level checklist

- [ ] Step C 6a: completion guard inserted, invokes `transition_guard` synchronously before `status: complete` write.
- [ ] Step C 6b: failure path updated — first failure writes `status: pending_retro`; second failure surfaces AskUserQuestion with 3 options.
- [ ] Resume controller: step 0b (pending-retro recovery) inserted; fires retro subagent before routing.
- [ ] Step CL1: archive gate added for completed bundles; refusal when retro missing and not waived.
- [ ] `bash -n hooks/masterplan-telemetry.sh` still passes (no changes to that file in Wave 2).
- [ ] Commit: `feat: v4.0 wave2 — FM-A hollow completion prevention`

---

## Wave 3 — FM-C: import hydration atomic

Depends on: Wave 1 (parallel with Wave 2)

### Files touched

- `/home/grojas/dev/superpowers-masterplan/commands/masterplan.md` — three targeted edits

### Edit specs

**Edit 1 — Rename existing I3.5 to I3.6**

Location: Step I3.5 at L1856. The current heading `#### I3.5 — Sequential cruft handling + commit (per candidate)` must be renamed to `#### I3.6 — Sequential cruft handling + commit (per candidate)`. This is a pure rename; no content change. All internal references to "I3.5" in the cruft-handling context update to "I3.6". (References to I3.5 in other steps that meant the cruft-handling step — grep for "I3.5" to confirm there are none outside this section.)

**Edit 2 — Insert new Step I3.5: parent-owned import hydration guard**

Location: Insert the new section immediately before the renamed I3.6 (between the end of I3.4 at approximately L1854 and the new I3.6 heading). New section:

```markdown
#### I3.5 — Import hydration guard (parent-owned transaction)

After I3.4's conversion wave completes, for each candidate, the parent orchestrator runs this transaction BEFORE I3.6 (cruft handling):

1. **Parent stages copies to temp dir.** For each `legacy.<artifact>` path in the candidate's state that resolves to an extant file, copy it to `/tmp/masterplan-import-<slug>-<pid>/` (the PID-tagged directory that the temp-dir sweep in Step 0 will eventually prune). Validate read access before any bundle writes. If a `legacy.*` path does not resolve, record the missing path; it will inform the fallback path below.

2. **Validate subagent return shape.** The I3.4 conversion subagent must return a result conforming to contract `import.convert_v1`:

   ```yaml
   contract_id: "import.convert_v1"
   inputs_hash: "<sha256 of staged inputs>"
   processed_paths: ["spec.md", "plan.md"]
   violations: []
   coverage: {expected: 2, processed: 2}
   artifacts:
     spec: { content: "...", source: "<legacy.spec>" }
     plan: { content: "...", source: "<legacy.plan>" }
   ```

   If `violations` is non-empty OR `coverage.processed != coverage.expected` OR `contract_id != "import.convert_v1"`, the parent treats import as failed (go to fallback path below). Record a `{"event":"import_contract_violation","contract_id":"import.convert_v1","violations":[...]}` event.

3. **Parent validates and writes atomically.** On all-clear from step 2:
   a. Parent writes `<run-dir>/spec.md` from `artifacts.spec.content`.
   b. Parent writes `<run-dir>/plan.md` from `artifacts.plan.content`.
   c. Parent rewrites `artifacts.spec` and `artifacts.plan` in `state.yml` to point to the bundle-local paths.
   d. Parent preserves `legacy.*` pointers for forensics.
   e. Parent writes `import_hydration: "full"`, `import_contract.contract_id: "import.convert_v1"`, `import_contract.inputs_hash: "<hash>"`, `import_contract.processed_at: "<now>"` into `state.yml`.
   f. All of c/d/e are written in a single `state.yml` update (not incremental).
   g. On any failure (file write error): `rm -rf /tmp/masterplan-import-<slug>-<pid>/`, abort import for this candidate, leave bundle in pre-import state (refuse to create the bundle if it hasn't been created yet), append `{"event":"import_hydration_aborted","reason":"..."}`.

4. **Fallback path.** If step 2 reports violations, OR if the subagent could not produce coherent spec/plan (e.g., legacy artifact is a brief or chat dump), parent writes:
   - `<run-dir>/spec.md`: a minimal "Import context" wrapper containing: the legacy file path, a one-paragraph summary the subagent produced (from the I3.4 return), and a pointer to verify.
   - `<run-dir>/plan.md`: a minimal "Import verification plan" with one task: "Read legacy file at `<path>`; confirm scope; produce a real plan if work is to continue."
   - `state.yml`: `import_hydration: "fallback"` and the same `import_contract.*` fields as above.
   Append `{"event":"import_hydration_fallback","reason":"..."}`.

5. **v2 bundle rehydration (lazy).** v2 imported bundles with empty `artifacts.spec`/`artifacts.plan` and non-empty `legacy.*` — detectable in the Resume controller's step 0 (Wave 1 lazy migration) by checking `import_hydration` is absent AND `legacy.*` is non-empty AND `artifacts.spec` is empty. On that condition: run Step I3.5 hydration retroactively, exactly as if importing fresh. Event log records `{"event":"v2_legacy_import_rehydrated"}`. If `legacy.*` paths no longer resolve: surface `AskUserQuestion("Legacy import paths for <slug> no longer exist. What now?", options=["Keep bundle as read-only history (Recommended)", "Attempt manual hydration — I'll paste the content", "Delete this bundle"])`.
```

**Edit 3 — Update I3.4 conversion brief to return content, not write files**

Location: I3.4 conversion subagent brief at L1852. The current brief instructs the subagent to "write `state.yml` at `<state-path>` populating every required run-state field". Replace with a brief that instructs the subagent to RETURN content rather than write files:

Change the I3.4 brief from "Then write `state.yml` at `<state-path>` ..." to:

```
Return the proposed spec and plan as content strings in the return shape (do NOT write files to the bundle directory). Return the required schema per contract `import.convert_v1`: `{contract_id: "import.convert_v1", inputs_hash: "<sha256>", processed_paths: ["spec.md", "plan.md"], violations: [], coverage: {expected: 2, processed: 2}, artifacts: {spec: {content: "...", source: "<legacy.spec>"}, plan: {content: "...", source: "<legacy.plan>"}}}`. The parent orchestrator will perform all file writes. If you cannot produce a coherent spec or plan, include the failure reason in `violations` and set `coverage.processed` to the count you could handle.
```

Also update the dispatch-site table in the §Agent dispatch contract section to add:
```
| Step I3.5 import hydration guard (per candidate) | `Step I3.5 hydration guard (<slug>)` |
```

And update I3.4's dispatch-site tag to clarify it's now a return-only dispatch:
```
| Step I3.4 conversion wave (per candidate) | `Step I3.4 conversion (<slug>)` |  (unchanged)
```

**Edit 4 — Doctor check #9: update to cross-check legacy.* vs artifacts.***

Location: Doctor check #9 at L2123. The current text defines the required field set and fix action as "Add missing fields with sentinel/derived values." Extend the fix action:

After the existing field-presence check, add:
```
Cross-check: for each `legacy.*` pointer that is non-empty, verify that the corresponding `artifacts.*` pointer is also non-empty AND the file exists on disk. If `legacy.spec` is non-empty but `artifacts.spec` is empty or the file is missing: flag as Error (not just schema violation — this is an unhydrated import). `--fix`: invoke the Step I3.5 rehydration logic inline (parent-side, not as a subagent). Do NOT add null sentinel values when a recoverable `legacy.*` path exists — that was the pre-v4.0 bug this check now prevents.
```

### Subagent dispatches

**Wave 3 implementation dispatch (contract_id: wave3_fmc_v1)**

```yaml
contract_id: "wave3_fmc_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave3-fmc)
Goal: Implement Wave 3 FM-C edits in commands/masterplan.md per the Wave 3 edit specs.
Inputs:
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 1846-1872 (I3.4 + current I3.5 + hand-off)
  - This plan's Wave 3 edit specs (above)
Scope:
  - Edit commands/masterplan.md: rename I3.5→I3.6; insert new I3.5; update I3.4 brief; update check #9
  - Do NOT touch Wave 1 or Wave 2 edit sites
  - Do NOT modify bin/masterplan-state.sh
Constraints:
  - The new I3.5 must include the temp-dir path format `/tmp/masterplan-import-<slug>-<pid>/` to match the Wave 1 temp-dir sweep's glob pattern
  - The I3.4 brief update must instruct the subagent to return content, not write files
  - Doctor check #9 fix action must NOT add null sentinels when legacy.* paths are recoverable
  - The dispatch-site table must be updated with the new I3.5 entry
Return shape:
  contract_id: "wave3_fmc_v1"
  inputs_hash: "<sha256>"
  processed_paths: ["commands/masterplan.md"]
  violations: []
  coverage: {expected: 1, processed: 1}
  summary: "..."
```

### Acceptance commands

```bash
# 1. I3.5 rename: old I3.5 heading now says I3.6
grep -n "I3\.5\|I3\.6" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 2. New I3.5 section present with parent-owned transaction language
grep -n "import_hydration\|import.convert_v1\|import_hydration_fallback" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md | head -15

# 3. I3.4 brief no longer says "write state.yml"
grep -n "write.*state\.yml.*state-path" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect zero matches (the old "write state.yml" instruction is gone from I3.4)

# 4. Doctor check #9 cross-check language present
grep -n "legacy\.\*.*artifacts\.\*\|unhydrated import\|null sentinel" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 5. Dispatch-site table updated with I3.5
grep -n "I3\.5 hydration guard\|I3\.5 import" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 6. Temp dir path format matches Wave 1 sweep pattern
grep -n "masterplan-import.*pid\|/tmp/masterplan-import" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Should find both the new I3.5 section (Wave 3) and the Wave 1 temp-dir sweep section (same pattern)
```

### Wave-level checklist

- [ ] `#### I3.5 — Sequential cruft handling` renamed to `#### I3.6`.
- [ ] New `#### I3.5 — Import hydration guard` section inserted before I3.6 with parent-owned transaction, fallback path, and v2 rehydration.
- [ ] I3.4 conversion brief updated to return content (not write files); `import.convert_v1` return shape specified.
- [ ] Doctor check #9 updated with cross-check and fix that does NOT add null sentinels when legacy paths are recoverable.
- [ ] Dispatch-site table in §Agent dispatch contract updated with I3.5 entry.
- [ ] Commit: `feat: v4.0 wave3 — FM-C import hydration atomic`

---

## Wave 4 — FM-B: kickoff scope-overlap detection

Depends on: Wave 1

### Files touched

- `/home/grojas/dev/superpowers-masterplan/commands/masterplan.md` — two targeted edits

### Edit specs

**Edit 1 — Step B0 step 1: add scope-overlap fingerprint scan**

Location: Step B0 step 1 at approximately L903-908 (the parallel Bash batch + related-plan scan). After the existing related-plan scan completes (after step 1 returns from parallel Haiku dispatches), insert a new step:

```
1b. **Scope-overlap fingerprint check.** Before the worktree-choice AskUserQuestion (step 3), compute overlap with existing bundles:

a. **Compute new topic fingerprint.** Tokenize `topic + proposed_slug` with: lowercase → strip punctuation `[.,;:!?'"()\[\]{}\\/]` → split on whitespace → remove stopwords (`{the,and,or,of,for,to,in,on,a,an,is,are,was,were,be,been,has,have,had,it,its,this,that,these,those}`) → apply stem function (trim common suffixes: `-ing`, `-ed`, `-s`, `-es`, `-er`, `-tion` via awk, inline Bash — no external dependencies). Result is `new_fingerprint: [token1, token2, ...]`.

b. **Load existing bundle fingerprints.** For each bundle in `docs/masterplan/*/state.yml` where `status != archived`:
   - Read `scope_fingerprint` field. If non-empty array, use it.
   - If empty/missing (v2 bundle), compute fingerprint inline from slug + spec.md H1 title (if file exists, read first H1) + `current_task` field. Persist the computed fingerprint on the bundle's next state write (piggyback via the lazy migration flag set in Wave 1).

c. **Compute Jaccard similarity.** For each existing bundle: `|A ∩ B| / |A ∪ B|` where A=new_fingerprint, B=existing fingerprint. Store as `(slug, similarity)` pairs. Sort descending.

d. **Threshold gate.** If max similarity ≥ 0.6, trigger the scope-overlap gate (step 1c below). Otherwise, record `scope_fingerprint: <new_fingerprint>` in the initial state.yml written in step 6 and proceed to step 2.
```

**Edit 1c — Scope-overlap gate (new step 1c)**

```
1c. **Scope-overlap gate (fires when max Jaccard ≥ 0.6).**

Step 1 — Show top-3 matches (or fewer if < 3 exist above threshold):
```yaml
AskUserQuestion(
  question="Topic '<new topic>' overlaps with existing bundles. Top-3 matches:",
  options=[
    "<slug-A> (sim=0.NN): <current_task or topic of A>",
    "<slug-B> (sim=0.NN): <current_task or topic of B>",
    "<slug-C> (sim=0.NN): <current_task or topic of C>",
    "None of these — proceed with new slug (acknowledge overlap)"
  ]
)
```
If user picks "None of these": append `{"event":"scope_overlap_acknowledged","ts":"...","top_sim":<max_sim>,"new_slug":"<proposed>"}` to events.jsonl of the NEW bundle (written after step 6), set `scope_fingerprint` in initial state, proceed.

If user picks one of the matching slugs: proceed to Step 2.

Step 2 — Relation choice for the picked slug:
```yaml
AskUserQuestion(
  question="How to relate '<new topic>' to '<picked-slug>'?",
  options=[
    "Resume <picked-slug> (Recommended) — load that bundle, route to Step C",
    "Create variant of <picked-slug> — new bundle with variant_of: <picked-slug> set",
    "Force new (acknowledge overlap) — new bundle with scope_overlap_acknowledged event"
  ]
)
```
- "Resume": load the picked bundle's state.yml, route to Step C. Do NOT create a new bundle.
- "Create variant": proceed to new bundle creation (step 6), set `variant_of: <picked-slug>` in initial state.yml. Append `{"event":"scope_overlap_variant_created","variant_of":"<picked-slug>"}`.
- "Force new": proceed to new bundle creation (step 6), set `scope_fingerprint` in initial state.yml. Append `{"event":"scope_overlap_force_new","acknowledged_sim":<max_sim>}`.

First bundle in repo (no existing bundles): guard returns trivially — proceed to step 2 (worktree recommendation).
```

**Edit 2 — Step B0 step 6: persist scope_fingerprint in initial state**

Location: Step B0 step 6 at L929. The Wave 1 edit already adds `scope_fingerprint: []` to the initial state field list. Update to specify: after scope-overlap fingerprint check in step 1b, set `scope_fingerprint: <new_fingerprint>` (not empty array) in the initial state. If the overlap gate was acknowledged, `supersedes`, `superseded_by`, `variant_of` default to `""` unless the user chose a relation that sets them.

### Subagent dispatches

**Wave 4 implementation dispatch (contract_id: wave4_fmb_v1)**

```yaml
contract_id: "wave4_fmb_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave4-fmb)
Goal: Implement Wave 4 FM-B scope-overlap edits in commands/masterplan.md per the Wave 4 edit specs.
Inputs:
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 899-930 (Step B0)
  - This plan's Wave 4 edit specs (above)
Scope:
  - Edit commands/masterplan.md: insert steps 1b and 1c into Step B0; update step 6 scope_fingerprint persistence
  - Do NOT touch Wave 1, 2, or 3 edit sites
Constraints:
  - The awk-based Jaccard computation must be inline Bash — no Python subprocess (avoids startup latency at kickoff)
  - Stopword list must be hardcoded (spec open item #1 resolved to hardcoded; v4.1 can add config knob)
  - The 0.6 threshold must be a named constant (not a magic number) near the top of the B0 section, e.g. `SCOPE_OVERLAP_THRESHOLD=0.6`
  - AskUserQuestion calls must have the "None of these / proceed" option last (not first — the user should read the matches first)
  - The "Resume <picked-slug>" option must route to Step C without creating a new bundle
Return shape:
  contract_id: "wave4_fmb_v1"
  inputs_hash: "<sha256>"
  processed_paths: ["commands/masterplan.md"]
  violations: []
  coverage: {expected: 1, processed: 1}
  summary: "..."
```

### Acceptance commands

```bash
# 1. Scope-overlap fingerprint logic present in Step B0
grep -n "scope_fingerprint\|Jaccard\|SCOPE_OVERLAP_THRESHOLD\|scope_overlap_acknowledged" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md | head -20

# 2. Two-step AskUserQuestion gate present
grep -n "scope_overlap.*gate\|Top-3 matches\|variant_of.*picked\|Resume.*picked-slug" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 3. Threshold is a named constant, not a magic 0.6 bare literal
grep -n "0\.6" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect to find SCOPE_OVERLAP_THRESHOLD=0.6 declaration; not bare 0.6 in logic code

# 4. scope_fingerprint in initial state.yml (Wave 1 adds the field; Wave 4 populates it with computed value)
grep -n "scope_fingerprint.*new_fingerprint\|scope_fingerprint.*computed" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
```

### Wave-level checklist

- [ ] Step B0 step 1b: fingerprint computation logic (tokenize → stopwords → stem → Jaccard) added inline.
- [ ] `SCOPE_OVERLAP_THRESHOLD=0.6` declared as named constant.
- [ ] Step B0 step 1c: two-step AskUserQuestion gate (show top-3 → relation choice) added.
- [ ] Step B0 step 6: `scope_fingerprint` populated with computed value (not empty array) on new bundle creation.
- [ ] "Resume" option routes to Step C without creating a new bundle.
- [ ] Commit: `feat: v4.0 wave4 — FM-B scope-overlap detection at kickoff`

---

## Wave 5 — FM-D: contract pattern + briefs

Depends on: Wave 1

### Files touched

- `/home/grojas/dev/superpowers-masterplan/commands/masterplan-contracts.md` — new file (create)
- `/home/grojas/dev/superpowers-masterplan/commands/masterplan.md` — three targeted edits
- `/home/grojas/dev/superpowers-masterplan/docs/internals.md` — new section
- `/home/grojas/dev/superpowers-masterplan/bin/masterplan-self-host-audit.sh` — new file (create)

### Edit specs

**New file: commands/masterplan-contracts.md**

Create `/home/grojas/dev/superpowers-masterplan/commands/masterplan-contracts.md` with the following structure:

```markdown
# Masterplan subagent contract registry

Each lifecycle subagent dispatch declares a `contract_id`. The orchestrator validates the return before acting on it. If validation fails, the orchestrator re-runs the invariant check locally and emits a `contract_violation` event.

## Contract: `import.convert_v1`
[Per Wave 3 definition above — copy the full YAML definition here]

## Contract: `doctor.schema_v2`
purpose: Per-bundle schema_v2 compliance check
algorithm: |
  For each bundle path in scope:
    1. Read state.yml; YAML-parse. If parse fails, emit violation {bundle, field: "state.yml", kind: "parse_failed"}.
    2. For each required field in SCHEMA_V2_REQUIRED (see spec Section "Schema v3"):
       Read field by dotted path (e.g. "artifacts.spec").
       If field is absent OR str(value).strip() == "" (for artifact paths) OR value is null (for non-nullable fields):
         append violation { bundle, field, kind: "missing_or_empty" }
    3. Cross-check: for each non-empty legacy.* pointer, verify corresponding artifacts.* pointer is non-empty AND file exists. If not: append violation {bundle, field: "artifacts vs legacy", kind: "hydration_gap"}.
return_shape: |
  contract_id: "doctor.schema_v2"
  inputs_hash: "<sha256 of bundle state.yml paths processed>"
  processed_paths: [list of state.yml paths]
  violations: [{bundle, field, kind, detail}]
  coverage: {expected: int, processed: int}

## Contract: `retro.source_gather_v1`
purpose: Collect retro source material for a completed bundle
algorithm: |
  1. Read state.yml (fields: slug, branch, started, last_activity, artifacts.*).
  2. Read events.jsonl (last 200 lines; if events-archive.jsonl exists, also read last 50 lines).
  3. Read plan.md (full if ≤ 200 lines; first 200 lines otherwise).
  4. Read spec.md (first 100 lines).
  5. Run: git -C <worktree> log --reverse --format='%h %ci %s' <trunk>..<branch> (capture up to 50 lines).
  6. If gh available: gh pr list --search "head:<branch>" --state=all --json=number,title,url,mergedAt,additions,deletions.
  Return the structured digest {state, events, blockers, notes, task_list, spec_excerpt, commits, pr?}.
  Do NOT return raw file content — return excerpts and structured fields only.
return_shape: |
  contract_id: "retro.source_gather_v1"
  inputs_hash: "<sha256>"
  processed_paths: [state.yml, events.jsonl, plan.md, spec.md]
  violations: []
  coverage: {expected: 4, processed: 4}
  digest: {state, events_summary, blockers, task_list, spec_excerpt, commits, pr}

## Contract: `related_scope_scan_v1`
purpose: Identify plans whose slug/branch overlaps with a new topic's salient words
algorithm: |
  For each state.yml in <worktree>/<runs_path>/:
    1. Read slug, current_task fields.
    2. Check substring overlap between (slug + current_task) and topic words (case-insensitive).
    3. If overlap: include in matching_slugs.
  For git_state.branches: check case-insensitive substring of branch name vs topic words.
return_shape: |
  contract_id: "related_scope_scan_v1"
  inputs_hash: "<sha256>"
  processed_paths: [list of state.yml paths]
  violations: []
  coverage: {expected: N, processed: N}
  result: {worktree, branch, matching_slugs: [], matching_branch: bool}
```

**commands/masterplan.md — Edit 1: update Step B0 related-plan scan brief to algorithmic form**

Location: Step B0 step 1 at approximately L908. The current related-plan scan brief is outcome-described: "Goal=identify any in-progress plans whose slug or branch name overlaps with the topic's salient words." Replace with contract-aligned algorithmic brief:

```
Each agent's bounded brief MUST include contract_id: "related_scope_scan_v1" and follow the algorithm in commands/masterplan-contracts.md. Return shape must include contract_id, inputs_hash, processed_paths, violations, coverage, and result. DISPATCH-SITE line must be first line of prompt.
```

**commands/masterplan.md — Edit 2: update Step R2 retro source gather brief**

Location: Step R2 at approximately L1997 (the Haiku dispatch brief). Update to reference `retro.source_gather_v1` contract. Add `contract_id: "retro.source_gather_v1"` to the brief header. Specify the algorithm per the contract registry. Add parent re-verification: after the Haiku returns, the orchestrator verifies `coverage.expected == coverage.processed`; if not, re-runs the gather inline (file reads directly) and emits `{"event":"contract_violation","contract_id":"retro.source_gather_v1","delta":<delta>}`.

**commands/masterplan.md — Edit 3: update Step D doctor dispatch brief + parent re-verification**

Location: Step D at approximately L2096-2097 (the Haiku dispatch brief). Update to reference `doctor.schema_v2` contract:

1. Add to each Haiku's bounded brief: "Use contract_id: 'doctor.schema_v2'. Follow the algorithm in commands/masterplan-contracts.md. Include inputs_hash, processed_paths, violations, and coverage in return. First line must be DISPATCH-SITE tag."
2. After the parallel Haiku wave returns and before emitting findings: parent re-verification pass:
   ```
   For each bundle path in the doctor scope: grep state.yml for `^retro: ""` and for missing `import_hydration` when legacy.* is non-empty. Cross-reference against the Haiku's violations list. If discrepancy (parent finds violations Haiku missed): append {"event":"parent_reverify_mismatch","contract_id":"doctor.schema_v2","missed_count":<N>} and prefer parent's findings. Emit a one-line notice: `⚠ doctor parent re-verify found <N> additional violation(s) not in Haiku return — using parent findings.`
   ```
   Note: for the 47-bundle scale, parent re-verify is sampling-based per spec open item #3: 3 random bundles + any with violations in the Haiku return. Full scan is only done when Haiku reports 0 violations on a corpus with known history of violations.

**New file: bin/masterplan-self-host-audit.sh — --brief-style flag**

Create `/home/grojas/dev/superpowers-masterplan/bin/masterplan-self-host-audit.sh` (or extend if it already partially exists). Add a `--brief-style` mode that:

1. Greps `commands/masterplan.md` and any inline brief templates for outcome-only language patterns:
   - Pattern A: `"validate against"` NOT followed within 5 lines by `"for each"` or `"if.*field"` → flag as outcome-only.
   - Pattern B: `"make sure that"` → flag.
   - Pattern C: `"verify the bundle"` NOT followed by `"for each"` or `"check.*field"` → flag.
   - Pattern D: Agent dispatch block that lacks `"contract_id"` in the brief → flag as missing contract.
2. Output each finding as `BRIEF-STYLE: <file>:<line>: <pattern> — <excerpt>`.
3. Exit 0 if no findings; exit 1 if any findings found.
4. Does NOT auto-fix; is a lint gate only.

The script must pass `bash -n bin/masterplan-self-host-audit.sh`.

**docs/internals.md — Edit 1: algorithmic subagent briefs section**

Location: Section 3 "Subagent + context-control architecture". Add a new subsection "Algorithmic subagent briefs" at the end of Section 3:

The section must include:
- Definition: outcome-described vs algorithmic brief
- 3 concrete before/after examples (outcome vs algorithmic for doctor.schema_v2, retro.source_gather_v1, related_scope_scan_v1)
- Standard return-shape vocabulary: `contract_id`, `inputs_hash`, `processed_paths`, `violations`, `coverage`
- Rule: every lifecycle subagent dispatch in a new orchestrator edit must declare a `contract_id` and reference an entry in `commands/masterplan-contracts.md`

### Subagent dispatches

Wave 5 has two parallel dispatches (implementation brief + contracts file authoring):

**Wave 5a — contracts file authoring (contract_id: wave5a_contracts_v1)**

```yaml
contract_id: "wave5a_contracts_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave5-contracts)
Goal: Create commands/masterplan-contracts.md with the full contract registry for all 4 contracts.
Inputs:
  - This plan's Wave 5 edit specs for commands/masterplan-contracts.md (above)
  - /home/grojas/dev/superpowers-masterplan/docs/masterplan/v4-lifecycle-redesign/spec.md (FM-D section)
Scope: Create one new file only. Do NOT modify any existing files.
Return shape: contract_id, inputs_hash, processed_paths: ["commands/masterplan-contracts.md"], violations, coverage, summary
```

**Wave 5b — orchestrator brief rewrites + audit script (contract_id: wave5b_briefs_v1)**

```yaml
contract_id: "wave5b_briefs_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave5-briefs)
Goal: Implement Wave 5 orchestrator edits and create bin/masterplan-self-host-audit.sh.
Inputs:
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 903-912 (B0 scan brief)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 1995-2012 (Step R2)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 2088-2100 (Step D dispatch)
  - commands/masterplan-contracts.md (written by wave5a; must be available before this dispatch runs)
  - This plan's Wave 5 edit specs (above)
Scope:
  - Edit commands/masterplan.md: 3 targeted brief-rewrite edits
  - Edit docs/internals.md: new "Algorithmic subagent briefs" subsection
  - Create bin/masterplan-self-host-audit.sh with --brief-style mode
Constraints:
  - Wave 5a must complete before Wave 5b dispatches (contracts file needed as input)
  - The audit script must pass bash -n
  - Parent re-verification logic in Step D must be sampling-based per spec open item #3 (3 random + violations)
  - The audit script's exit code must be 1 when findings exist, 0 when clean
Return shape: contract_id, inputs_hash, processed_paths, violations, coverage, summary
```

### Acceptance commands

```bash
# 1. Contract registry file exists with all 4 contracts
ls -la /home/grojas/dev/superpowers-masterplan/commands/masterplan-contracts.md
grep -c "^## Contract:" /home/grojas/dev/superpowers-masterplan/commands/masterplan-contracts.md
# Expect: 4

# 2. Audit script exists and passes bash -n
bash -n /home/grojas/dev/superpowers-masterplan/bin/masterplan-self-host-audit.sh

# 3. Audit script --brief-style finds zero issues in current orchestrator (after briefs rewrite)
bash /home/grojas/dev/superpowers-masterplan/bin/masterplan-self-host-audit.sh --brief-style
# Expect: exit 0, no BRIEF-STYLE findings

# 4. Parent re-verify logic present in Step D
grep -n "parent_reverify_mismatch\|parent.*re-verify\|sampling-based" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 5. contract_id present in Step B0 brief, Step R2 brief, Step D brief
grep -n "contract_id.*related_scope_scan_v1\|contract_id.*retro.source_gather_v1\|contract_id.*doctor.schema_v2" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 6. Algorithmic briefs section in internals.md
grep -n "Algorithmic subagent briefs" /home/grojas/dev/superpowers-masterplan/docs/internals.md
```

### Wave-level checklist

- [ ] `commands/masterplan-contracts.md` created with 4 contracts: `import.convert_v1`, `doctor.schema_v2`, `retro.source_gather_v1`, `related_scope_scan_v1`.
- [ ] `bin/masterplan-self-host-audit.sh --brief-style` created; `bash -n` passes; exits 0 on current orchestrator after briefs rewrite.
- [ ] Step B0 related-plan scan brief updated to algorithmic form with `contract_id: "related_scope_scan_v1"`.
- [ ] Step R2 retro source gather brief updated with `contract_id: "retro.source_gather_v1"` + parent re-verification.
- [ ] Step D doctor dispatch brief updated with `contract_id: "doctor.schema_v2"` + sampling-based parent re-verify.
- [ ] `docs/internals.md`: "Algorithmic subagent briefs" subsection added to Section 3.
- [ ] Commit: `feat: v4.0 wave5 — FM-D contract pattern + algorithmic briefs`

---

## Wave 6 — FM-G: worktree disposition + auto-resolve

Depends on: Wave 1 (and Waves 2+3 must already be landed before this wave executes, per dependency graph)

### Files touched

- `/home/grojas/dev/superpowers-masterplan/commands/masterplan.md` — five targeted edits

### Edit specs

**Edit 1 — .masterplan.yaml config schema: `worktree.default_disposition`**

Location: The "Configuration: .masterplan.yaml" section (referenced at approximately L86; actual config schema section is further down — grep for `worktree.*directive\|default_disposition\|keep-worktree`). In the config schema, add:

```yaml
worktree:
  default_disposition: active  # active | kept_by_user; default active
  # Repos that always keep worktrees past completion set this to kept_by_user
```

Also add `--keep-worktree` to the verb routing table's flag section (approximately L373-409). The flag is valid for `brainstorm`, `plan`, and `full` verbs:
```
| `--keep-worktree` | B (brainstorm/plan/full) | Sets `worktree_disposition: kept_by_user` in initial state.yml at Step B0 step 6, overriding `worktree.default_disposition`. |
```

**Edit 2 — Step B0 step 6: set initial worktree_disposition**

Location: Step B0 step 6 at L929. After recording the worktree path, set `worktree_disposition` in the initial state:
- If `--keep-worktree` flag is set: `worktree_disposition: kept_by_user`.
- Else if `config.worktree.default_disposition == "kept_by_user"`: `worktree_disposition: kept_by_user`.
- Else: `worktree_disposition: active`.
Also set `worktree_last_reconciled: <now ISO>`.

**Edit 3 — Step C 6a: worktree refresh at completion entry**

Location: Step C step 6a at L1736. BEFORE the dirty check, insert a worktree refresh:

```
**6a-worktree-refresh.** First action of Step C step 6a (before the git status --porcelain dirty check): refresh `worktree_disposition` from live `git worktree list --porcelain`:
  
  1. Run `git worktree list --porcelain` and parse the entries.
  2. Compare `state.yml.worktree` against the listed paths.
  3. If recorded worktree path is NOT in `git worktree list`:
     - Set `worktree_disposition: missing`, clear `worktree:` field (set to ""), set `worktree_last_reconciled: <now>`.
     - Append `{"event":"worktree_orphan_cleaned","path":"<old-path>","ts":"..."}`.
     - Proceed (do not block completion).
  4. If recorded worktree path IS in `git worktree list` AND disposition was empty (v2 bundle):
     - Set `worktree_disposition: active`, set `worktree_last_reconciled: <now>`.
  5. Emit notice for untracked worktrees (worktrees in git list with no bundle pointer): if this completion run detects a worktree path in `git worktree list` that no bundle's `state.yml.worktree` points to, append `{"event":"worktree_untracked_detected","path":"<path>","ts":"..."}` to events.jsonl but do NOT block completion.
```

**Edit 4 — Step C 6a-6b: auto-remove worktree at completion (non-interactive)**

Location: After the retro generation in Step C 6b (after retro succeeds and `completion_check` returned `ok`), but BEFORE the branch-finish gate in 6d, insert:

```
**6a-worktree-completion.** After retro generation succeeds (or `retro_policy.waived: true`), evaluate `worktree_disposition`:

- `active`: Run `git worktree remove <state.yml.worktree>`.
  - On success: set `worktree_disposition: removed_after_merge`, clear `worktree:` field, set `worktree_last_reconciled: <now>`. Append `{"event":"worktree_removed_at_completion","path":"<path>","ts":"..."}`.
  - On failure (uncommitted changes, locked worktree, path doesn't resolve): emit `{"event":"worktree_removal_failed","path":"<path>","error":"<git error text>","ts":"..."}`, set `worktree_disposition: missing`, clear `worktree:` field. Do NOT block completion — continue to 6d.
- `kept_by_user`: No removal attempt. Append `{"event":"worktree_kept_per_user_flag","path":"<path>","ts":"..."}`. Continue.
- `removed_after_merge`: Already removed. No action. Continue.
- `missing`: Already cleared. No action. Continue.

No AskUserQuestion at this step — this honors the loose-autonomy contract. The user pre-flags intent via `--keep-worktree` or `worktree_disposition: kept_by_user` in state.yml.
```

**Edit 5 — Step CL1 worktrees category and doctor check update**

Location: Step CL1 category 6 at approximately L2215. Replace the current worktrees category with:

```
6. **`worktrees`** — Run the same refresh logic as Step C 6a-worktree-refresh: compare `git worktree list --porcelain` against ALL bundle `state.yml.worktree` pointers across the current worktree scope. Surface:
   a. Bundles whose recorded `worktree:` path is NOT in `git worktree list` → `worktree_missing`. Non-interactively: set `worktree_disposition: missing`, clear `worktree:` field, emit `worktree_orphan_cleaned` event, continue archive.
   b. Paths in `git worktree list` with NO bundle `state.yml.worktree` pointer → `worktree_orphan_untracked`. Report only (no auto-action without user confirmation, since this could be an intentionally standalone worktree). Surface `AskUserQuestion` per orphaned path at CL2.
   c. Bundles with `worktree_disposition: active` AND `status: complete` or `status: archived` → likely lingered past completion; same removal attempt as Step C's 6a-worktree-completion.
```

**Edit 6 — New doctor check for worktree-bundle reconciliation**

Location: Doctor checks table at approximately L2113-2140. Insert a new check after #28:

```
| 29 | **Worktree-bundle reconciliation mismatch** (v4.0.0+). Cross-repo: enumerate `git worktree list --porcelain` for the current repo; for each worktree path, find any bundle's `state.yml.worktree:` pointing at it. Surface: (a) bundles claiming a worktree path not registered in `git worktree list` (`worktree_missing`); (b) worktree paths registered in git with no bundle pointer (`worktree_orphan_untracked`). Skip worktrees with `worktree_disposition: removed_after_merge` or `kept_by_user` — those are intentionally settled. | Warning | `--fix`: for (a), set `worktree_disposition: missing`, clear `worktree:` field, write state, commit. For (b): report only (user must decide). |
```

Also update the complexity-aware check sets at L2102-2105:
- `low` plans: add check #29 to the low-plan check set (it's a repo-scoped check like #26; it applies to all complexity levels).
- `medium` and `high` plans: already run all plan-scoped checks; #29 applies.

Update the parallelization brief at L2096 from "all 25 plan-scoped checks" to "all plan-scoped checks (currently #1-24, #26, #28, #29)" — the number 25 was already stale before v4.0; this edit fixes the drift for Wave 6.

### Subagent dispatches

**Wave 6 implementation dispatch (contract_id: wave6_fmg_v1)**

```yaml
contract_id: "wave6_fmg_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave6-fmg)
Goal: Implement Wave 6 FM-G worktree disposition edits in commands/masterplan.md per the Wave 6 edit specs.
Inputs:
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 373-409 (flag table)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 899-930 (Step B0)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 1733-1790 (Step C 6a-6d, after Wave 2 edits)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 2088-2143 (Step D dispatch + checks table, after Wave 5 edits)
  - /home/grojas/dev/superpowers-masterplan/commands/masterplan.md lines 2195-2216 (Step CL1, after Wave 3 edits)
  - This plan's Wave 6 edit specs (above)
Scope:
  - Edit commands/masterplan.md: 6 targeted edits per Wave 6 edit specs
  - Do NOT touch Wave 1-5 edit sites unless the edit is a direct continuation of a Wave-specific insertion point
Constraints:
  - No AskUserQuestion at the worktree auto-remove step (6a-worktree-completion) — this is explicitly non-interactive
  - git worktree remove failure must NOT block completion — emit event and continue
  - Doctor check #29 must be added to the low-plan check set (it's a lightweight structural check)
  - Parallelization brief doctor count at L2096 must be updated (remove stale "25" number)
  - The --keep-worktree flag must be added to the flag table AND the config schema
Return shape:
  contract_id: "wave6_fmg_v1"
  inputs_hash: "<sha256>"
  processed_paths: ["commands/masterplan.md"]
  violations: []
  coverage: {expected: 1, processed: 1}
  summary: "..."
```

### Acceptance commands

```bash
# 1. --keep-worktree flag in flag table
grep -n "keep-worktree\|worktree_disposition.*kept_by_user" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md | head -10

# 2. Step C 6a-worktree-refresh present
grep -n "6a-worktree-refresh\|worktree_orphan_cleaned\|worktree_last_reconciled" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 3. Step C auto-remove logic present (non-interactive)
grep -n "6a-worktree-completion\|worktree_removed_at_completion\|worktree_removal_failed" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 4. Doctor check #29 present
grep -n "| 29 |" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md

# 5. Parallelization brief no longer says "all 25 plan-scoped checks" (stale count removed)
grep -n "all 25 plan-scoped\|25 plan-scoped" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect zero matches (stale "25" removed)

# 6. No AskUserQuestion in the worktree auto-remove path
grep -n "AskUserQuestion.*worktree_remove\|AskUserQuestion.*worktree remove" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect zero matches (no interactive gate at the auto-remove step)
```

### Wave-level checklist

- [ ] `--keep-worktree` flag added to verb routing flag table.
- [ ] `worktree.default_disposition` config knob added to .masterplan.yaml schema section.
- [ ] Step B0 step 6: initial `worktree_disposition` set based on flag/config.
- [ ] Step C 6a-worktree-refresh: live `git worktree list` check before dirty check; auto-set `missing` on mismatch.
- [ ] Step C 6a-worktree-completion: non-interactive auto-remove for `active` disposition; no AskUserQuestion.
- [ ] Step CL1 worktrees category updated with bundle-reconciliation logic.
- [ ] Doctor check #29 added; low-plan check set updated; parallelization brief count corrected.
- [ ] `bash -n bin/masterplan-self-host-audit.sh --brief-style` exits 0 (no regressions from Wave 6 edits).
- [ ] Commit: `feat: v4.0 wave6 — FM-G worktree disposition + auto-resolve`

---

## Wave 7 — Migration + cross-repo smoke + tag v4.0.0

Depends on: All Waves 1-6 complete

### Files touched

- `/home/grojas/dev/superpowers-masterplan/.claude-plugin/plugin.json` — version bump to 4.0.0
- `/home/grojas/dev/superpowers-masterplan/.codex-plugin/plugin.json` — version bump to 4.0.0
- `/home/grojas/dev/superpowers-masterplan/CHANGELOG.md` — v4.0.0 entry
- `/home/grojas/dev/superpowers-masterplan/README.md` — update doctor check count, add worktree disposition + `--keep-worktree` to usage section
- `/home/grojas/dev/superpowers-masterplan/docs/internals.md` — update doctor check table reference, section 10

### Edit specs

**Plugin version bumps**

In `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`, update `"version"` from `"3.2.9"` (current) to `"4.0.0"`.

**CHANGELOG.md entry**

Insert a new entry at the top of `CHANGELOG.md` for v4.0.0 with:
- Summary: "Lifecycle hardening — transition_guard, schema_v3, FM-A/B/C/D/G fixes"
- Per-wave summary (1 bullet per wave)
- Breaking changes note: "schema_version bumped to 3 for new bundles; v2 bundles lazy-migrated on first write"
- Link to `docs/masterplan/v4-lifecycle-redesign/` bundle

**README.md updates**

- Doctor check table: update from "28 checks" to "29 checks" (or remove the hardcoded count and say "see `docs/internals.md` for the full check table").
- Add `--keep-worktree` flag to the "Flags" section.
- Add `worktree_disposition` to the state.yml schema description.

**docs/internals.md updates**

- Section 10 (Doctor checks full table): update check count and add check #29 row.
- Section 12 (Design decisions): add a v4.0 entry noting the transition_guard pattern, schema_v3 additions, and the FM-A through FM-G resolution decisions.

### Subagent dispatches

**Wave 7 smoke + version bump dispatch (contract_id: wave7_release_v1)**

```yaml
contract_id: "wave7_release_v1"
DISPATCH-SITE: Step C step 2 wave dispatch (group: wave7-release)
Goal: Run cross-file verification, update version numbers, write CHANGELOG entry, and confirm all acceptance commands pass for all 6 prior waves.
Inputs:
  - /home/grojas/dev/superpowers-masterplan/.claude-plugin/plugin.json
  - /home/grojas/dev/superpowers-masterplan/.codex-plugin/plugin.json
  - /home/grojas/dev/superpowers-masterplan/CHANGELOG.md (first 50 lines)
  - /home/grojas/dev/superpowers-masterplan/README.md (relevant sections)
  - All acceptance commands from Waves 1-6 (run each and report pass/fail)
Scope: Edit 4 support files; run acceptance commands; do NOT edit commands/masterplan.md
Return shape: contract_id, inputs_hash, processed_paths, violations (any acceptance command failures), coverage, summary
```

### Acceptance commands

These are the Phase 4 headline tests from `spec.md § Verification criteria → Phase 4 success`:

```bash
# Baseline checks (all prior waves)
bash -n /home/grojas/dev/superpowers-masterplan/bin/masterplan-state.sh
bash -n /home/grojas/dev/superpowers-masterplan/hooks/masterplan-telemetry.sh
bash /home/grojas/dev/superpowers-masterplan/bin/masterplan-self-host-audit.sh --brief-style
# Expect: all exit 0

# FM-A: pending_retro path present and complete not set on retro failure
grep -n "pending_retro\|completion_retro_gate_opened\|pending_retro_recovered" \
  /home/grojas/dev/superpowers-masterplan/commands/masterplan.md | wc -l
# Expect: ≥ 8 distinct hits

# FM-C: I3.4 does not write files; I3.5 is the hydration guard; I3.6 is cruft
grep -n "#### I3\.5\|#### I3\.6\|#### I3\.4" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect: I3.4 = Conversion wave, I3.5 = Import hydration guard, I3.6 = Sequential cruft

# FM-B: scope overlap gate present
grep -n "SCOPE_OVERLAP_THRESHOLD\|scope_overlap_gate\|scope_overlap_acknowledged" \
  /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect: ≥ 3 distinct hits

# FM-D: contract IDs present in briefs
grep -c "contract_id.*v1" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect: ≥ 5 hits (at least import, doctor, retro, related-scope, plus wave dispatch briefs)
grep -c "contract_id.*v1" /home/grojas/dev/superpowers-masterplan/commands/masterplan-contracts.md
# Expect: 4 (one per contract definition)

# FM-G: worktree auto-remove non-interactive; no AskUserQuestion in removal path
grep -n "worktree_removed_at_completion\|worktree_removal_failed\|worktree_orphan_cleaned" \
  /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect: ≥ 3 distinct event names
grep -c "AskUserQuestion.*worktree.*remov" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect: 0 (no interactive gate on worktree removal)

# Version bump
grep '"version"' /home/grojas/dev/superpowers-masterplan/.claude-plugin/plugin.json
# Expect: "version": "4.0.0"
grep '"version"' /home/grojas/dev/superpowers-masterplan/.codex-plugin/plugin.json
# Expect: "version": "4.0.0"

# Schema v3 in new bundle creation
grep -n "schema_version: 3" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect: ≥ 2 hits (step B0 step 6 + run bundle state model section)

# Doctor count corrected (no stale "25" in parallelization brief)
grep -n "all 25 plan-scoped\|25 plan-scoped checks" /home/grojas/dev/superpowers-masterplan/commands/masterplan.md
# Expect: 0

# Sync check: README and internals match
grep -n "29.*check\|check.*29\|worktree-bundle reconciliation" /home/grojas/dev/superpowers-masterplan/docs/internals.md
grep -n "29.*check\|--keep-worktree" /home/grojas/dev/superpowers-masterplan/README.md
```

### Wave-level checklist

- [ ] All Waves 1-6 acceptance commands pass (grep patterns return expected counts; `bash -n` passes).
- [ ] `--brief-style` audit exits 0 (no outcome-only language in `commands/masterplan.md` after all waves).
- [ ] `.claude-plugin/plugin.json` version bumped to 4.0.0.
- [ ] `.codex-plugin/plugin.json` version bumped to 4.0.0.
- [ ] `CHANGELOG.md` v4.0.0 entry written with per-wave summaries.
- [ ] `README.md` updated: check count, `--keep-worktree` flag, `worktree_disposition`.
- [ ] `docs/internals.md` Section 10 + Section 12 updated.
- [ ] Commit: `release: v4.0.0 lifecycle hardening (FM-A/B/C/D/G)`
- [ ] Tag: `git tag v4.0.0`

---

## Sync points (anti-pattern #4)

Every dual-source surface that must update in lockstep across the Phase 4 waves:

| Surface | Changed by wave | What must stay in sync |
|---|---|---|
| Doctor parallelization brief at L2096 ("all 25 plan-scoped checks") | Wave 6 | Must remove "25" and substitute current count or avoid hardcoding. Also update the medium/high plan check sets at L2103-2104. |
| Doctor check table at L2113-2140 | Wave 6 (#29 added) | Table in `commands/masterplan.md` AND Section 10 of `docs/internals.md` AND `README.md` check count must all agree. |
| Complexity-aware check sets at L2102-2107 | Wave 6 | Low/medium/high plan check set lists must include new #29. |
| Auto-fixable check enumeration at L2159 ("checks #1a, #2, #3, #9, #12, #20, #21, #24") | Wave 6 | If #29's `--fix` action is auto-fixable (it is, for case a), add #29 to this list. |
| Doctor check #9 required-fields list at L2123 | Wave 1 (schema_v3 fields added) | The list must include the new v3 fields that are *required for new writes*. Read-only v2 bundles should NOT trigger schema violations for absent v3 fields — the fix text must distinguish "required for new writes" vs "required with lazy migration for existing bundles." |
| Schema reference in `docs/internals.md` Section 4 | Wave 1 | schema_v3 field additions documented in sync with `commands/masterplan.md` Step B0 step 6. |
| `commands/masterplan-contracts.md` contract registry | Wave 5 | Contract definitions in `masterplan-contracts.md` must match the `contract_id` values cited in orchestrator brief text and in dispatched return-shape specs. Any future contract change needs both updated. |
| Dispatch-site table in §Agent dispatch contract | Wave 3, Wave 5 | New dispatch sites (I3.5 hydration guard, any Wave 5 additions) must appear in the table with their `DISPATCH-SITE` tag values. |
| Run bundle state format section at L2335+ | Wave 1 | `schema_version: 2` in the example must be updated to `3`. `status:` enum must include `pending_retro`. |
| Plugin version in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` | Wave 7 | Both files must agree on `"4.0.0"`. |
| `CHANGELOG.md` | Wave 7 | Entry must reflect all FM fixes and schema_v3. |
| `README.md` command table / flag table | Wave 4 (`--keep-worktree` not a new verb), Wave 6 (`--keep-worktree` flag), Wave 7 | No new verbs in this plan. Flag table must include `--keep-worktree`. Check count reference must be updated. |
| Verb routing table at L321 and Step 0 frontmatter `description:` | None needed | No new verbs introduced in this plan. Confirm by grepping for new verb additions as a final check. |
| `bin/masterplan-self-host-audit.sh` --cd9 check | Wave 7 verification | Must continue to exit 0 after all edits (no free-text question regressions introduced). |

---

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Wave 5 circular dependency**: `--brief-style` lint must pass after brief rewrites, but the lint is authored in Wave 5 and the briefs are also rewritten in Wave 5. If the lint flags an incomplete rewrite, Wave 5 cannot close. | Medium | High (Wave 5 cannot commit) | Wave 5a (contracts file) dispatches first; Wave 5b (brief rewrites + lint) runs after. The lint is authored at the start of Wave 5b before briefs are rewritten, so it can be run iteratively. The lint must flag before the rewrites; the rewrites then make it pass. |
| **Step I3.5 rename breaks internal references**: if any section of `commands/masterplan.md` references "I3.5" meaning the current "Sequential cruft handling" step, the rename to I3.6 creates dangling references. | Low-Medium | Medium (confused implementer) | Wave 3 acceptance command explicitly greps for `I3\.5\|I3\.6` to confirm the correct count of references. Also grep for bare "I3.5" in text outside the section headers to catch cross-references. |
| **Doctor check count drift**: the parallelization brief's "25" count is already stale (checks exist through #28 with gaps). If Wave 6's fix is incomplete, the count may still be wrong after Wave 6. | Medium | Low (cosmetic drift, but triggers CLAUDE.md anti-pattern #4 warning) | Wave 6's acceptance command explicitly greps for the stale "25" string and expects 0 hits. |
| **transition_guard subcommand requires Python stdlib YAML parser**: `bin/masterplan-state.sh` uses embedded Python3; YAML parsing uses `python3`'s absence of a stdlib yaml module (the script may need `pyyaml` or custom parsing). The existing script uses custom frontmatter parsing, not `import yaml`. | Medium-High | High (Wave 1 guard logic fails silently) | Wave 1's edit spec requires the Python guard logic to use the same `parse_frontmatter` function pattern already in `masterplan-state.sh` (L104-119) rather than `import yaml`. The guard must reuse the existing in-script YAML parsing conventions. |
| **Wave 4 Jaccard false-positive rate unknown**: the 0.6 threshold is a single choice without test data against the v4.1 target repos. The petabit-os-mgmt CLI-parity bundles acceptance test may not cover common false-positive cases (e.g., unrelated features sharing common technical vocabulary like "API" or "auth"). | Medium | Medium (annoying UX; user sees spurious overlap gates) | Accept the risk for v4.0; plan explicitly defers threshold tuning to v4.1 per spec open item #1. The `SCOPE_OVERLAP_THRESHOLD` named constant makes it easy to tune. Document in CHANGELOG. |
| **v2 bundles with worktree_disposition: "" trigger ambiguous behavior at Step C**: a v2 bundle with an empty worktree field AND empty worktree_disposition hitting Step C 6a-worktree-refresh may not have a worktree path to check at all. The guard must handle the empty-worktree case cleanly. | Medium | Low-Medium (no crash, but noisy events) | Wave 6 edit spec must include: if `state.yml.worktree` is empty string, skip the `git worktree list` comparison entirely and leave `worktree_disposition: ""` unchanged (no worktree was ever associated). Document this as the "no worktree" sentinel. |

---

## Open questions for the orchestrator

1. **Step R3.5 naming collision** (surfaced during planning). The spec uses the label "Step R3.5 (resume, before continuing)" to informally describe a new resume-time guard. However, `commands/masterplan.md` already has `### Step R3.5 — Archive run bundle (v3.0.0+)` at L2060 inside Step R (Retro). The spec's label is informal shorthand for the new Resume controller guard. This plan uses "Step Resume-Guard step 0b" for the new concept to avoid collision. Confirm this naming is acceptable or select an alternate label before Wave 2 executes.

2. **Stopword and stem list for Jaccard** (spec open item #1). Hardcoded in Wave 4 per the spec's deferred resolution. If false-positive rate is unacceptable in early v4.0 usage, the config knob path is: add `worktree.scope_overlap_threshold: 0.6` to `.masterplan.yaml` schema and read it in B0 step 1b. Track as v4.1 item.

3. **Contract-registry storage format** (spec open item #2). This plan resolves to a separate `commands/masterplan-contracts.md` file. If it creates unacceptable synchronization burden, the alternative is inlining into `docs/internals.md`. Confirm before Wave 5a dispatches.

4. **Parent re-verification cost for doctor.schema_v2** (spec open item #3). This plan adopts sampling-based parent re-verify (3 random + violations) rather than full-scan. Confirm this is acceptable or specify a different sampling rate.

5. **`git worktree remove` failure semantics at Step C** (spec open item #5). The current plan falls through to `missing` + event on ALL failure categories. If the orchestrator should surface a one-time gate specifically for "uncommitted changes in worktree" (vs. other failure types), Wave 6 needs an additional AskUserQuestion branch for that case. This plan leaves it as fall-through-quietly per the spec's non-interactive requirement; but if this creates user confusion (lost uncommitted work in worktrees), it should be revisited before Wave 6 executes.

6. **Doctor check #28 disposition after Wave 2**. The `completed_plan_without_retro` check (#28) was the primary detection mechanism for FM-A before v4.0. After Wave 2, the completion guard prevents new hollow completions. The check remains useful for v2 bundles and bundles whose retro was waived. This plan leaves #28 in place with its current severity (Warning). If you want it changed to Info for newly-written v4.0 bundles, update the check severity logic in Wave 2 (check state.yml `schema_version` to determine severity).

7. **`/masterplan doctor --upgrade-schema` verb** (spec open item #4). Not a Phase 4 deliverable. Track as v4.1. No verb routing changes needed in Wave 7.
