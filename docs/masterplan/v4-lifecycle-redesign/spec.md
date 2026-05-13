---
title: Masterplan v4.0 — lifecycle hardening spec
slug: v4-lifecycle-redesign
schema_target: 3
phase: brainstorm-complete
status: ready-for-plan
inputs:
  - /home/grojas/.claude/plans/evaluate-recent-transcripts-from-staged-aurora.md
  - docs/masterplan/v4-lifecycle-redesign/codex-review.md
created: 2026-05-13
---

# Masterplan v4.0 — lifecycle hardening

## Why this exists

The runtime path (`brainstorm` → `plan` → `execute`) executes cleanly. The
**lifecycle** path — completion gates, import migration, kickoff overlap
detection, subagent brief contracts, worktree disposition — leaks. Forensic
audit across two repos (`petabit-os-mgmt`, `optoe-ng`) found **11 of 47
complete bundles (~24%) are hollow**: missing `retro.md` and/or missing
bundle-local `spec.md`/`plan.md` while `legacy.*` pointers still resolve
to extant files outside the bundle.

Failure modes catalogued in `/home/grojas/.claude/plans/evaluate-recent-transcripts-from-staged-aurora.md`
(FM-A through FM-D, FM-G). Phase 2 codex review of `commands/masterplan.md`
(see `codex-review.md` in this bundle) validated the structural direction
and surfaced concrete patterns that go beyond what the approved plan
specified — most notably the **transition_guard** pattern and the
**contract_id** subagent dispatch shape.

This spec is the Phase 1 brainstorm output. It defines:

1. The architectural cornerstone (`transition_guard`) shared across all
   failure-mode fixes.
2. Per-failure-mode design with concrete state-shape changes and UX flows.
3. `schema_v3` field additions and the v2→v3 migration story.
4. Wave structure for Phase 4 implementation.
5. Verification criteria.

## Architectural cornerstone — transition_guard

Codex review's strongest single observation: every failure mode shares the
same root pathology — lifecycle invariants enforced at **doctor time**
(detection) rather than **write time** (prevention). v4.0 inverts this:

```
transition_guard(state, target_phase) → {ok | gate | abort}
```

A parent-owned write barrier invoked **before any state mutation** that
moves a bundle between lifecycle phases. Specifically inserted at:

- **Step B0** (kickoff, before `bundle_created`): scope-overlap fingerprint check.
- **Step I3.5** (import, after legacy fetch, before bundle writes):
  hydration completeness + atomicity check.
- **Step C 6a** (completion, before `status: complete`): retro-presence
  + worktree-disposition cross-check.
- **Step R3.5** (resume, before continuing): v2→v3 lazy migration; FM-A
  pending_retro recovery; FM-G worktree reconciliation.
- **Step CL** (clean/archive, before move-to-archived): same retro +
  worktree gates as Step C, re-verified at archive time.

The guard returns one of three dispositions:
- `ok` — write may proceed unchanged.
- `gate` — present an `AskUserQuestion` (resume/variant/force-new style)
  and act on the answer. Persist the gate decision to `events.jsonl`.
- `abort` — refuse the transition with a clear reason; bundle remains in
  its prior phase with `pending_gate` populated.

The guard is **never delegated to a subagent**. Subagents may surface
findings (doctor remains, repurposed for observability and lazy migration
hints), but invariant enforcement at write boundaries lives in the
orchestrator's main turn so that compaction or subagent context isolation
cannot strand a bundle in an inconsistent state.

This single pattern resolves the doctor-time-vs-write-time tension that
codex flagged as cross-cutting. The per-FM sections below describe how each
failure mode plugs into the same guard.

---

## FM-A — hollow completion

### Mechanism (recap)

- Step C 6b: "If retro generation fails, append `completion_retro_failed`
  event, leave `status: complete`, continue" — terminal status set before
  retro is proven on disk.
- Step CL: archives any bundle with `status: complete` + terminal
  `next_action` without verifying `artifacts.retro` is non-empty or that
  the file exists on disk.

### Structural change

**Step C 6a — completion guard.** Before writing `status: complete`:

```
guard.completion_check(state):
  if state.artifacts.retro is empty OR not os.path.exists(state.artifacts.retro):
    if state.retro_policy.waived == true AND state.retro_policy.reason is non-empty:
      return ok   # explicit waiver
    return gate   # surface AskUserQuestion below
  if file_size(state.artifacts.retro) < MIN_RETRO_BYTES (default: 200):
    return gate
  return ok
```

**Step C 6b — retro generation.** Dispatch retro subagent. On success →
guard returns `ok` → write `status: complete`. On failure:

- First failure → set `status: pending_retro`, persist
  `pending_retro_attempts: 1` to state.yml, append
  `retro_generation_failed` event. Continue execution path (do NOT block
  the rest of Step C; non-retro completion artifacts can still be
  produced).
- On next `/masterplan` resume against this bundle, Step R3.5 guard fires
  with `pending_retro_recovery` branch: re-dispatch retro subagent once.
  If second attempt also fails, increment `pending_retro_attempts: 2` and
  surface AskUserQuestion:

```yaml
question: "Retro generation failed twice for <slug>. Disposition?"
options:
  - "Regenerate now (will re-dispatch retro subagent)"
  - "Mark complete_no_retro with waiver"    # writes retro_policy.waived: true + prompts for reason
  - "Leave pending (re-check on next /masterplan)"
```

**Step CL — archive guard.** Refuses to archive when completion_check
returns gate. If `retro_policy.waived: true`, archive proceeds with
`archived_no_retro_waived` event recording the reason for forensic trail.

### State-shape changes (schema_v3)

```yaml
status: complete | pending_retro | ...    # new value: pending_retro
pending_retro_attempts: 0                  # only meaningful when status: pending_retro
retro_policy:
  waived: false                            # opt-in skip; only true after explicit user gate answer
  reason: ""                               # required when waived: true
```

### v2 compat

- v2 bundles with `status: complete` + missing retro.md → on next access,
  Step R3.5 guard detects the inconsistency, runs the same recovery
  branch as fresh `pending_retro`. No silent reclassification — emit a
  visible event `v2_legacy_pending_retro_detected` so the user sees what
  changed.
- v2 bundles with retro present continue to load with `retro_policy:
  {waived: false, reason: ""}` defaults; no migration cost.

---

## FM-B — restart-thrash (kickoff scope-overlap)

### Mechanism (recap)

Step B accepts a topic string and creates a new slug without inspecting
existing run bundles for scope overlap. Evidence: 3 CLI-parity bundles in
petabit-os-mgmt; 4-way phase-8 fragmentation; 6 OPTOE refactor bundles.

### Structural change

**Step B0 — scope-overlap guard.** Before `bundle_created`:

1. **Compute scope_fingerprint for new topic.** Tokenize `topic + slug
   (proposed)` with: lowercase → strip punctuation → split on whitespace
   → remove stopwords (`the, and, or, of, for, to, in, on, a, an, is`) →
   stem (lightweight: trim common suffixes `-ing, -ed, -s, -es`).
2. **Compute scope_fingerprint for every active bundle** (any with
   `status != archived`) — same tokenization on the bundle's
   `slug + (spec.md H1 title if present, else state.yml current_task)`.
   Cache fingerprint in each bundle's `state.yml` as `scope_fingerprint:
   [token1, token2, ...]` after first computation; recompute only when
   slug/topic changes.
3. **Compute Jaccard similarity** between new fingerprint and each
   active bundle's fingerprint: `|A ∩ B| / |A ∪ B|`.
4. **Threshold gate.** If max similarity ≥ **0.6** (strict), guard
   returns `gate`. Otherwise `ok`.

**Gate flow (two-step AskUserQuestion):**

Step 1 — show top-3 matches with similarity scores:

```yaml
question: "Topic '<new topic>' overlaps with existing bundles. Top-3 matches:"
options:
  - "<slug-A> (sim=0.78): <topic-A>"
  - "<slug-B> (sim=0.71): <topic-B>"
  - "<slug-C> (sim=0.64): <topic-C>"
  - "None of these — proceed with new slug"
```

If user picks "None of these", record `scope_overlap_acknowledged` event
and proceed to bundle creation. Otherwise → Step 2 with the picked slug:

```yaml
question: "How to relate <new topic> to <picked-slug>?"
options:
  - "Resume <picked-slug>"   # load that bundle, route to Step R
  - "Create variant of <picked-slug>"   # new bundle with legacy.supersedes_or_variant: <picked-slug>
  - "Force new (acknowledge overlap)"   # new bundle with events.jsonl note
```

### State-shape changes (schema_v3)

```yaml
scope_fingerprint: []           # array of normalized tokens; computed lazily
supersedes: ""                  # slug this bundle replaces (if any)
superseded_by: ""               # slug that replaces this bundle (set retroactively)
variant_of: ""                  # slug this bundle is a variant of (preserves prior bundle as active)
```

### v2 compat

- v2 bundles have no `scope_fingerprint`. On first scope-overlap check
  against a v2 bundle, compute fingerprint from existing slug + spec.md
  H1 + state.yml `current_task` and persist on next state write
  (lazy migration).
- `supersedes` / `superseded_by` / `variant_of` default to empty strings.

### Edge cases

- **Multiple bundles ≥ threshold.** Show top-3, regardless of overlap
  between them (don't dedupe — user may need to see siblings).
- **All active bundles in unrelated worktrees.** Run the check anyway;
  worktree path is metadata, scope is what matters.
- **First bundle in the repo.** No existing bundles → guard returns `ok`
  trivially.

---

## FM-C — import hydration gap

### Mechanism (recap)

Step I converter subagent writes a `state.yml` stub referencing
`legacy.spec` / `legacy.plan` paths but does NOT copy legacy files into
the bundle directory or populate `artifacts.spec` / `artifacts.plan`
pointers. Doctor check #9 backfills null sentinels rather than copying.

### Structural change

**Step I3.5 — import hydration guard, parent-owned transaction:**

1. **Parent stages copies to temp dir.** For each `legacy.<artifact>`
   path that resolves to an extant file, copy it to a per-bundle temp
   staging directory: `/tmp/masterplan-import-<slug>-<pid>/`. Validate
   read access before any bundle writes.
2. **Subagent proposes artifact content.** Dispatch the conversion
   subagent (Sonnet) with the staged files as input, NOT as writers.
   Subagent returns the proposed bundle-local `spec.md` / `plan.md`
   content (and any transformations applied), plus a per-artifact
   status table. Subagent writes **no** files in the bundle directory.
3. **Parent validates subagent return.** Required return shape:
   ```yaml
   contract_id: "import.convert_v1"
   inputs_hash: "<sha256 of staged inputs>"
   processed_paths: ["spec.md", "plan.md"]
   violations: []                          # empty on success
   coverage: {expected: 2, processed: 2}   # must match
   artifacts:
     spec: { content: "...", source: "<legacy.spec>" }
     plan: { content: "...", source: "<legacy.plan>" }
   ```
   If `violations` non-empty OR `coverage.processed != coverage.expected`,
   parent treats import as failed.
4. **Atomic commit.** On all-clear: parent writes each artifact file
   into the bundle directory, rewrites `artifacts.*` pointers, preserves
   `legacy.*` pointers for forensics, then writes the final `state.yml`
   in a single update. On any failure: rm -rf the temp dir, abort import
   with explicit error, leave bundle in pre-import state (or refuse to
   create the bundle in the first place).

**Fallback path: import-context wrapper.** If the subagent cannot
produce a coherent spec/plan (e.g., legacy artifact is a brief or a
chat dump rather than a structured plan), parent writes:

- `spec.md`: a minimal "Import context" wrapper containing the legacy
  file path, a one-paragraph summary the subagent produced, and a
  pointer to verify.
- `plan.md`: a minimal "Import verification plan" with one task: "Read
  legacy file at `<path>`; confirm scope; produce a real plan if work
  is to continue."
- Mark `state.yml`: `import_hydration: fallback`.

This avoids the failure mode where a malformed legacy artifact leaves
the bundle entirely empty.

### State-shape changes (schema_v3)

```yaml
import_hydration: ""              # "" | "full" | "fallback"; set during Step I3.5
import_contract:
  contract_id: ""                 # "import.convert_v1" when populated
  inputs_hash: ""
  processed_at: ""
```

### v2 compat

- v2 imported bundles with empty `artifacts.spec`/`artifacts.plan` and
  non-empty `legacy.*` → on next access, Step R3.5 guard detects the gap
  and runs Step I3.5 hydration retroactively, exactly as if importing
  fresh. Event log records `v2_legacy_import_rehydrated`.
- If `legacy.*` paths no longer resolve (file was deleted after import),
  guard surfaces an AskUserQuestion asking whether to keep the bundle as
  read-only history or attempt manual hydration.

---

## FM-D — subagent brief contract weakness

### Mechanism (recap)

Subagent briefs typically describe outcomes ("validate the bundle
against the schema") rather than algorithms ("for each required field
in schema_v2, read state.yml; if absent or empty, emit a violation
record with shape {…}"). Haiku subagents are mechanical extractors;
outcome-described briefs leave too much interpretation surface and
miss invariants (recent doctor pass missed schema #9 on 29/29 bundles).

### Structural change — full contract pattern

**Every lifecycle subagent dispatch declares a `contract_id` and
required return shape.** The orchestrator validates the return before
acting on it; if validation fails, parent re-runs the invariant check
locally (NOT silently — emits `contract_violation` event with the
mismatched fields).

**Contract registry.** New file: `commands/masterplan-contracts.md`
(or inline in `docs/internals.md`) defining each contract. Example:

```yaml
- contract_id: "doctor.schema_v2"
  purpose: "Per-bundle schema_v2 compliance check"
  algorithm: |
    For each path in scope:
      1. Read state.yml; YAML-parse.
      2. For each required field in SCHEMA_V2_REQUIRED:
         if field is absent OR str(value).strip() == "":
           append violation { bundle, field, kind: "missing_or_empty" }
      3. Cross-check artifacts.* vs legacy.* per FM-C invariants.
  return_shape:
    contract_id: string (must echo)
    inputs_hash: string (sha256 of bundle paths processed)
    processed_paths: list[string]
    violations: list[ { bundle, field, kind, detail } ]
    coverage: { expected: int, processed: int }
```

**Parent re-verification.** For each invariant the contract claims to
have checked, the parent runs a minimal grep/test BEFORE acting on the
violations list. Example: doctor.schema_v2 — parent greps for `^retro:
""` across all state.yml paths; cross-references against the subagent's
violations list. Discrepancy → log `parent_reverify_mismatch` event,
prefer parent's own findings, treat subagent as observability not
oracle.

**Brief style guide.** New section in `docs/internals.md`:
"Algorithmic subagent briefs" — defines the difference, gives
3-4 concrete examples of outcome-described vs algorithmic for the
same task, lists the standard return-shape vocabulary.

**Grep-based lint.** New script `bin/masterplan-self-host-audit.sh
--brief-style` greps `commands/masterplan.md` (and any inline subagent
brief templates) for outcome-only language patterns:

- "validate against" without "for each ... if ..."
- "make sure that" without "check field X"
- "verify the bundle" without a per-field algorithm

Flags but does not auto-fix; CI/manual gate before commit.

### State-shape changes (events.jsonl, not state.yml)

```jsonl
{"ts": "...", "event": "contract_dispatched", "contract_id": "doctor.schema_v2", "inputs_hash": "..."}
{"ts": "...", "event": "contract_returned", "contract_id": "doctor.schema_v2", "coverage": {expected: 47, processed: 47}, "violation_count": 11}
{"ts": "...", "event": "parent_reverify_match", "contract_id": "doctor.schema_v2", "delta": 0}
```

No `state.yml` changes for FM-D; everything lives in event log + new
contract registry doc + lint script.

### v2 compat

- Pure additive to events.jsonl shape. v2 bundles continue to read
  fine; new event types are opaque to v2 readers.

---

## FM-G — orphaned worktrees

### Mechanism (recap)

Bundles record `worktree:` path at creation, but completion/archive
does not verify the worktree is gone (or prompt to remove it), and no
doctor check enumerates `git worktree list` vs active bundle worktree
pointers. Worktrees outlive their bundles; bundles can also reference
worktrees that no longer exist on disk.

### Structural change — 4-state disposition + auto-resolve (no completion gate)

**Worktree disposition vocabulary (per codex 4-state recommendation):**

```yaml
worktree_disposition: active | kept_by_user | removed_after_merge | missing
```

- `active` — worktree path exists in `git worktree list` AND on disk.
- `kept_by_user` — bundle archived but worktree intentionally preserved
  for ongoing follow-up work. Set **only** via pre-flag (see below);
  never via an interactive prompt at completion time.
- `removed_after_merge` — worktree was cleanly removed (either by
  masterplan itself at completion or by the user before Step C). The
  `worktree:` field is cleared at the same time.
- `missing` — recorded worktree path no longer exists in
  `git worktree list` OR not on disk. Default to this state when the
  guard detects a mismatch.

**Pre-flag mechanism — opt-in keep.** Users who want a worktree
preserved past completion must declare intent **before** Step C runs:

- **CLI flag at kickoff:** `--keep-worktree` on the `/masterplan
  brainstorm` or `/masterplan plan` verb sets `worktree_disposition:
  kept_by_user` in state.yml at bundle creation.
- **State edit:** manually setting `worktree_disposition: kept_by_user`
  in state.yml at any point before Step C runs has the same effect.
- **Config default:** `worktree.default_disposition: active | kept_by_user`
  in `.masterplan.yaml` (default `active`). Repos that always keep
  worktrees flip the default once.

**Step C entry — worktree refresh.** First action of Step C:
`git worktree list --porcelain` to refresh disposition. If recorded
worktree no longer matches reality:
- Recorded-but-missing → set `worktree_disposition: missing`, clear
  `worktree:` field, emit `worktree_orphan_cleaned` event. Continue.
- Untracked-but-present → emit `worktree_untracked_detected` event,
  leave bundle complete with `worktree_disposition: missing`. Continue.

**Step C completion — auto-remove unless pre-flagged.** After retro
generation succeeds and `completion_check` returns `ok`, evaluate
`worktree_disposition`:

- `active` → run `git worktree remove <path>` against the bundle's
  `worktree:` path, set `worktree_disposition: removed_after_merge`,
  clear the `worktree:` field, append `worktree_removed_at_completion`
  event with the removed path. If `git worktree remove` fails (uncommitted
  changes, locked worktree, path doesn't resolve), do NOT block
  completion: emit `worktree_removal_failed` event with the git error
  text, set `worktree_disposition: missing`, continue Step C. The user
  sees the event on next doctor pass and can disposition manually.
- `kept_by_user` → no removal attempt. Append
  `worktree_kept_per_user_flag` event. Continue.
- `removed_after_merge` → already removed (user did it manually before
  completion); no action. Continue.
- `missing` → already cleared by entry refresh; no action. Continue.

No interactive gate at Step C — this honors the loose-autonomy
contract and the batch-1 "auto-resolve with warning event" answer.

**Step CL — archive gate.** Re-runs the same refresh + disposition
logic at archive time **non-interactively**:
- `active` (disposition somehow regressed since Step C) → attempt
  removal as above; on failure, set `missing` and continue archive
  with `worktree_archive_orphan` event.
- `kept_by_user` / `removed_after_merge` / `missing` → permit archive.

**New doctor check.** Cross-repo: enumerate `git worktree list` for
the current repo; for each worktree path, find any bundle's
`state.yml#worktree:` pointing at it. Surface:
- Bundles claiming a worktree that isn't registered → `worktree_missing`.
- Worktrees registered with no bundle pointer →
  `worktree_orphan_untracked`.

### State-shape changes (schema_v3)

```yaml
worktree: ""                                # path (existing v2 field)
worktree_disposition: ""                    # new: active|kept_by_user|removed_after_merge|missing
worktree_last_reconciled: ""                # ISO timestamp of last git-worktree-list check
```

### v2 compat

- v2 bundles default to `worktree_disposition: ""` on first read.
- Step R3.5 guard on next access computes the disposition by running
  `git worktree list` against the recorded `worktree:` path and writes
  the result on next state write.
- v2 bundles with empty `worktree:` field → disposition stays empty
  (no worktree was ever associated).

---

## Schema v3

### Field additions (all additive)

```yaml
schema_version: 3                           # bumped from 2

# FM-A
status: complete | pending_retro | ...      # new value: pending_retro
pending_retro_attempts: 0
retro_policy:
  waived: false
  reason: ""

# FM-B
scope_fingerprint: []                       # array of normalized tokens
supersedes: ""
superseded_by: ""
variant_of: ""

# FM-C
import_hydration: ""                        # "" | "full" | "fallback"
import_contract:
  contract_id: ""
  inputs_hash: ""
  processed_at: ""

# FM-G
worktree_disposition: ""                    # active|kept_by_user|removed_after_merge|missing
worktree_last_reconciled: ""
```

### Migration story — lazy on access

- New bundles created under v4.0 write `schema_version: 3` from the
  start.
- v2 bundles load unchanged; on first state mutation against a v2
  bundle, the orchestrator hydrates missing v3 fields with defaults
  and bumps `schema_version: 3`. The event log records
  `schema_v2_to_v3_lazy_migrated`.
- v2 bundles that are read but never mutated stay at `schema_version: 2`
  indefinitely. The reader code path tolerates absent v3 fields by
  applying defaults in-memory.
- No deprecation timeline for v2 read support in v4.x. v2 read-compat
  may be reconsidered for v5.0+ if and when v2 bundles are demonstrably
  rare.

### Optional: eager migration

Add a future `/masterplan doctor --upgrade-schema` verb (deferred,
NOT a Phase 4 requirement) that walks all bundles in the current repo
and triggers the lazy-migration code path for each. Useful for repos
that want to normalize state ahead of a major orchestrator change.

---

## Phase 4 — wave structure

Implementation breaks into **7 waves**, in dependency order:

### Wave 1 — Foundation: transition_guard + schema_v3 plumbing + temp-dir hygiene

- New file `bin/masterplan-state.sh transition-guard <bundle> <target-phase>`
  helper (Bash) returning `ok | gate | abort` JSON for use by the
  orchestrator's main-turn checks.
- Wire schema_v3 field defaults into the orchestrator's bundle-creation
  step (Step B0 step 6).
- Add the lazy-migration shim at Step R entry: on read, hydrate v2
  bundles with v3 defaults in-memory; on first write, persist with
  `schema_version: 3`.
- **Temp-dir sweep at Step 0.** Add startup sweep at the end of Step 0
  (after config load, before verb routing): prune
  `/tmp/masterplan-import-*` directories where (a) mtime is older than
  24h AND (b) the embedded `<pid>` is not in `ps -p $pid` (i.e., no
  live parent owns it). Sweep emits one `tempdir_swept` event per
  pruned path. This guards against parent-crash leaks from the Wave 3
  Step I3.5 transaction.
- **Acceptance:** A fresh v4.0 `/masterplan brainstorm` creates a
  bundle with all v3 fields present at defaults. An old v2 bundle
  reads cleanly with derived defaults; first write bumps version.
  Stale `/tmp/masterplan-import-*` directories created in a prior
  killed run are pruned on next invocation; live ones (active pid)
  are untouched.

### Wave 2 — FM-A: hollow completion closed

- Step C 6a guard: completion_check function inline in
  `commands/masterplan.md`.
- Step C 6b: pending_retro path on first failure; new `pending_retro`
  status legal in state.yml.
- Step R3.5 guard: pending_retro recovery branch (auto-retry once,
  then AskUserQuestion).
- Step CL refusal logic: refuses to archive with empty retro unless
  `retro_policy.waived: true`.
- **Acceptance:** Deliberately kill retro subagent mid-Step C; bundle
  ends up `status: pending_retro` not `complete`. Re-run `/masterplan`;
  pending_retro recovery branch fires.

### Wave 3 — FM-C: import hydration atomic

- Step I3.5 guard: parent-owned transaction with temp dir staging,
  subagent-returns-content (NOT writes), all-or-nothing commit.
- Fallback import-context wrapper path.
- Doctor check #9: cross-check artifacts.* vs legacy.*; refuses to
  add null sentinels when legacy files are recoverable.
- **Acceptance:** Import a legacy plan from a non-existent path;
  bundle is not created (or is created in a coherent fallback state).
  Import a malformed legacy file; fallback wrapper appears with the
  import-verification task pre-populated.

### Wave 4 — FM-B: kickoff scope-overlap detection

- Step B0 fingerprint computation + Jaccard scorer (inline Bash:
  awk-based tokenization + set ops).
- Step B0 guard: top-3 match → resume/variant/force gate.
- New state.yml fields populated on bundle creation.
- **Acceptance:** Run `/masterplan brainstorm <topic>` against a
  petabit-os-mgmt clone with the 3 CLI-parity bundles present.
  Trigger fires; top-3 shown; user can resume, variant, or force.

### Wave 5 — FM-D: contract pattern + briefs rewrite

- New file `commands/masterplan-contracts.md` (or new section in
  `docs/internals.md`) defining contract_id registry.
- Rewrite doctor, importer, retro-generation, and conversion subagent
  briefs to algorithmic form per the registry.
- Parent re-verification inline in orchestrator after each lifecycle
  subagent return.
- New script `bin/masterplan-self-host-audit.sh --brief-style` grep
  lint.
- **Acceptance:** Re-run doctor pass against the petabit-os-mgmt +
  optoe-ng test corpora; coverage now reports 47/47 bundles; parent
  re-verify finds zero deltas. Lint flags any outcome-only language
  in `commands/masterplan.md`.

### Wave 6 — FM-G: worktree disposition + auto-resolve

- `--keep-worktree` flag on kickoff verbs + `worktree.default_disposition`
  config knob (default `active`).
- Step C entry: worktree refresh via `git worktree list --porcelain`;
  auto-set `missing` / clear `worktree:` on mismatch with event.
- Step C completion: non-interactive auto-remove when disposition is
  `active` (runs `git worktree remove`; on failure emits
  `worktree_removal_failed` event and continues with `missing`).
- Step CL archive: re-run the same non-interactive refresh + remove
  pass; never blocks archive on worktree state alone.
- New doctor check for cross-repo worktree-bundle reconciliation
  (surfaces `worktree_missing` and `worktree_orphan_untracked`).
- **Acceptance:** Create a worktree, complete the bundle without
  pre-flagging — worktree is auto-removed, `worktree_removed_at_completion`
  event appears, no interactive gate. Create another worktree with
  `--keep-worktree` — completion leaves it active with
  `worktree_disposition: kept_by_user`. Delete a worktree out-of-band;
  resume bundle — Step C entry auto-resolves to `missing` with
  `worktree_orphan_cleaned` event.

### Wave 7 — Migration + cross-repo smoke

- Run `/masterplan doctor` against petabit-os-mgmt and optoe-ng;
  confirm 0 hollow bundles (Phase 3 backfill already cleaned the
  test corpora). Confirm worktree-bundle cross-checks find 0
  unsurfaced orphans.
- Trigger each failure mode deliberately on a scratch bundle and
  confirm v4.0 refuses or transparently handles each.
- Tag `v4.0.0`.

### Wave parallelism

- Wave 1 must complete before any other wave (foundation).
- Waves 2 and 3 are independent and can run in parallel (FM-A is
  completion-side; FM-C is import-side; they don't share code paths).
- Waves 4, 5, and 6 each depend on Wave 1 only and can run in
  parallel after Waves 2 and 3 land.
- Wave 7 is final.

Under loose autonomy, the orchestrator should auto-progress between
waves; gates only at the verification failure of each acceptance test.

---

## Verification criteria

### Phase 1 success (this spec)
- This `spec.md` exists with sections covering all 5 failure modes.
- Schema_v3 field additions enumerated.
- v2 read-compat story documented.
- Wave structure with acceptance criteria per wave.

### Phase 2 success (codex review)
- `codex-review.md` exists in the bundle. ✅ (delivered 2026-05-13)
- Findings categorized per failure mode with line citations into
  `commands/masterplan.md`. ✅
- Validated structural direction; no contradictions with this spec.

### Phase 4 success (the headline test)
From a fresh masterplan run in a clean repo, deliberately trigger each
failure mode:

| Trigger | v3 behavior | v4 expected behavior |
|---|---|---|
| Kill retro subagent mid-Step C | `status: complete` + no retro | `status: pending_retro`; auto-retry on next access |
| Import legacy plan without copying artifacts | `state.yml` stub + missing bundle artifacts | Parent-owned atomic copy or coherent fallback wrapper |
| Restart with overlapping topic | New bundle silently created | Top-3 match gate; resume/variant/force |
| Outcome-only subagent brief | Missed invariants | Lint flags; contract violation event |
| Worktree exists past Step C | No event, no cleanup | Disposition gate at Step C; auto-resolve on next access |

Each must be **refused or transparently handled** — never allowed to
produce a hollow bundle.

Re-run forensics on petabit-os-mgmt + optoe-ng after v4.0 lands:
expect 0 new hollow completions over 30 days of use.

### Cross-cutting
- Doctor check count in the parallelization brief must match the
  actual check count (CLAUDE.md anti-pattern #4).
- All verb routing tables (Step 0, README, internals, frontmatter)
  remain in sync.
- `bash -n hooks/masterplan-telemetry.sh` still parses.
- `bash -n bin/masterplan-state.sh` still parses.
- `bin/masterplan-self-host-audit.sh --cd9` still finds zero free-text
  question regressions.
- New: `bin/masterplan-self-host-audit.sh --brief-style` finds zero
  outcome-only subagent briefs in `commands/masterplan.md`.

---

## Open items (carry into Phase 4 plan)

These design questions were deferred from the brainstorm and need
resolution during Phase 4 planning:

1. **Stopword and stem list for Jaccard.** Hardcoded vs configurable?
   Default list will be hardcoded in the orchestrator; if false-positive
   rate is high in practice, config knob can be added in v4.1.
2. **Contract-registry storage format.** Inline section in
   `docs/internals.md` (simpler), or separate
   `commands/masterplan-contracts.md` (cleaner separation, but a
   second file to keep synced).
3. **Parent re-verification cost.** Each contract call gets a parent
   re-verify; for some contracts (e.g., 47-bundle doctor scan), this
   is non-trivial. Mitigation: parent re-verify can be sampling-based
   (3 random bundles + any with violations in subagent return) rather
   than full-scan. Decision deferred to Wave 5 planning.
4. **`/masterplan doctor --upgrade-schema` verb.** Listed as optional
   eager migration; not a Phase 4 deliverable. Track as v4.1 follow-up.
5. **`git worktree remove` failure semantics at completion.** Current
   spec falls through to `missing` + event on removal failure (locked
   worktree, uncommitted changes). Confirm in Wave 6 planning whether
   any failure category should instead surface a one-time gate (e.g.,
   uncommitted changes specifically) versus all-falling-through-quietly.

---

## Pointers

- Approved plan (Phase 0 context):
  `/home/grojas/.claude/plans/evaluate-recent-transcripts-from-staged-aurora.md`
- Codex review (Phase 2 output):
  `docs/masterplan/v4-lifecycle-redesign/codex-review.md`
- Orchestrator source under review:
  `commands/masterplan.md` (~2650 lines; line ranges in codex-review.md)
- Phase 3 backfill (already completed in a prior session): 27 hollow
  bundles across petabit-os-mgmt and optoe-ng remediated; test corpus
  is now clean for Phase 4 acceptance tests.
