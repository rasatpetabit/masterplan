# Spec: github-coord-fix

## Goal

Repair the masterplan **github-coordination** `publish` / `follow` (§7) orchestrator
path so it executes end-to-end. The lib layer (`lib/github-coord.mjs`,
`setCoordination`/`clearCoordination` in `lib/bundle.mjs`) is complete and
unit-tested; only the **bin↔orchestrator glue** was never built. A deliberate
Lane-A dogfood (`rasatpetabit/mp-dogfood`, bundle `dogfood-notes`) proved the path
is non-executable as shipped on released main (`3e6e513`) and produced a complete
**9-gap audit** (memory note `v8-github-coord-broken`). This run wires the glue,
unit-tests the new subcommands, and leaves every existing
brainstorm/plan/execute/finish run unaffected (the feature stays opt-in/dormant).

This is **wiring, not a rewrite.** No change to `lib/github-coord.mjs` (pure +
correct), no change to `resume.mjs` coordination branches, no change to the
dormant-by-default guarantee.

## The 9 gaps (what this run fixes)

| id | site | defect | class |
|---|---|---|---|
| **G1** | `mp set-coord` missing | `setCoordination` exported + imported but wired to no case → `state.coordination` never written | **publish blocker** |
| **G2** | serial `load-plan` | `plan_hash` stamped only in `merge-plan-fragments`; serial path never stamps it → contract-ref name undefined | publish |
| **G3/G3b** | `coord-status --fail-if-unpublishable` / `--fail-if-unconfigured` | flags ignored, always exit 0 | preflight no-ops |
| **G4** | orch `gh-issue-body --task-id=<id>` | handler wants `--task=<JSON>` (full object); orch passes wrong flag + scalar | publish |
| **G5** | orch `gh issue list \| mp parse-issue \| mp select-claimable` | `parse-issue` parses ONE body; `select-claimable` wants `--issues=<JSON array>` — pipeline shape mismatch | follow |
| **G6** | orch `select-claimable --deps-from-coord-status` | phantom flag (real: `--plan-deps=<json>`) | follow |
| **G7** | orch `validate-claim --actor=@me` | literal `@me` compared to real login in `validateClaimSettle` → always `'lost'` | **follow blocker** |
| **G8** | doctor `coord-drift.mjs:89` | fix-hints cite phantom `mp reconcile` / `mp set-coordination` | bad hint |
| **G9** | post-`reconcile-integration` write-back | reconcile is read-only (correct); after `mark_done` the shell must update `issue_map` — needs the G1 writer | wave never advances |

`reconcile-integration` itself is correct (pure read-only → actions). `follow` is
arguably more broken than `publish`: G7 kills it before any build work.

## Locked design decisions

1. **Coordination writer = two verbs.**
   - `set-coord` — per-wave pin (`--wave` / `--base-sha` / `--contract-ref` / `--integration-branch`, plus `--mark-published`).
   - `update-issue-map` — incremental per-task entry (`--task-id` / `--issue` / `--pr` / `--status` / `--merge-sha` / `--wave`). Serves both publish issue-creation **and** the G9 reconcile write-back.
   Two small, single-purpose writers beat one overloaded verb; both delegate to the existing `setCoordination` helper.
2. **`plan_hash` stamped in `load-plan` (parity).** The serial path stamps `sha256(plan.md)` the same way the parallel path (`merge-plan-fragments`) already does, so both paths yield a self-describing index carrying `plan_hash`. Publish reads it identically regardless of planning mode.
3. **Scope = all 9 gaps (G1–G9).** Partial wiring leaves the path non-executable; the dogfood re-run requires the whole chain.
4. **Tests = unit tests + re-run dogfood.** Unit-test the new bin subcommands and the `plan_hash` parity directly. Rely on the `mp-dogfood` re-run as the §7 **orchestrator** behavioral test (the markdown sequencer has no unit harness). No `gh`/`git` integration harness (YAGNI — the dogfood is the integration test).

## Data model — `state.coordination` (canonical schema)

`setCoordination(state, patch)` shallow-merges field-by-field (preserves fields not
in the patch). The new writers must satisfy exactly this schema (the shape every
consumer in `resume.mjs` / `coord-drift.mjs` / `github-coord.mjs` reads):

```yaml
coordination:
  mode: github                       # optional tag
  contract_ref: mp-coord/<slug>/<plan_hash>
  integration_branch: mp-int/<slug>
  local_run_branch: <lead-only, never pushed>   # optional
  current_wave: <int>
  published_waves: [<int>, ...]      # waves whose issues were created on GitHub
  base_sha_by_wave: { "<wave>": "<sha>" }        # per-wave base at publish time
  issue_map:
    "<task_id>":
      issue: <int>                   # GitHub issue number
      pr: <int>                      # optional
      merge_sha: <sha>               # optional, set on merge
      status: open|claimed|pr-open|merged|closed
      wave: <int>                    # optional
```

`setCoordination` replaces `base_sha_by_wave` / `issue_map` / `published_waves`
**wholesale** when the corresponding patch key is present. Therefore the new bin
handlers own the **per-key merge**: read the existing map/array off state, splice in
the one wave/task/entry, then pass the fully-merged object to `setCoordination`.
This keeps the helper a dumb field-merger and confines incremental logic to the
handlers.

## Implementation surface

### A. `bin/masterplan.mjs` — new + amended subcommands

**A1 — `set-coord` (new case).** Pin per-wave coordination fields.

```
mp set-coord --state=<path>
             [--wave=<N>]                 → coordination.current_wave = N
             [--base-sha=<sha>]           → merges into base_sha_by_wave[<wave>]   (requires --wave)
             [--contract-ref=<ref>]       → coordination.contract_ref
             [--integration-branch=<br>]  → coordination.integration_branch
             [--local-run-branch=<br>]    → coordination.local_run_branch
             [--mode=<s>]                 → coordination.mode
             [--mark-published]           → append --wave to published_waves (dedup; requires --wave)
```
Handler: `loadForWrite` → read existing `coordination` → build a patch (merge
`base_sha_by_wave[wave]` and `published_waves` against the existing values, not
replace) → `setCoordination(state, patch)` → `writeState` → emit
`{ coordination }`. `--base-sha`/`--mark-published` without `--wave` → `die(...)`.

**A2 — `update-issue-map` (new case).** Splice one task's issue_map entry.

```
mp update-issue-map --state=<path> --task-id=<id>
                    [--issue=<n>] [--pr=<n>] [--merge-sha=<sha>]
                    [--status=<open|claimed|pr-open|merged|closed>] [--wave=<n>]
```
Handler: `loadForWrite` → `entry = { ...issue_map[task_id] }` → assign only the
provided fields (numbers via `coerceId`) → `issue_map[task_id] = entry` →
`setCoordination(state, { issue_map })` → `writeState` → emit
`{ task_id, entry }`. At least one mutating flag required else `die`.

**A3 — `load-plan` `plan_hash` parity (amend the case at ~418).** Accept an
optional `--plan-md=<path>`. When provided and the loaded `plan.index.json` lacks
a `plan_hash` (null/absent), compute
`sha256:${createHash('sha256').update(readText(planMd)).digest('hex')}` (the exact
form from `merge-plan-fragments` ~654), stamp it onto the index object **and write
the index file back** (and `generated_at` if absent), then materialize tasks as
today. Idempotent: an index that already carries `plan_hash` is left untouched.
Net effect: a serial bundle's `plan.index.json` carries the same `plan_hash` a
parallel bundle's does, so publish's `jq .plan_hash plan.index.json` works on both.

**A4 — `coord-status` preflight flags (amend the case at ~927).**
- `--fail-if-unconfigured` (used by `follow`): exit non-zero with a diagnostic on
  stderr if `state.coordination` is absent **or** missing `contract_ref` /
  `integration_branch`. A follower cannot claim without a configured substrate.
- `--fail-if-unpublishable` (used by `publish`): exit non-zero with a diagnostic if
  the bundle cannot publish a wave now — `phase !== 'execute'` **or** `tasks` empty
  (nothing materialized to publish), **or** coordination exists and the
  most-recently-published wave still has an `issue_map` entry not in a terminal
  state (`merged`/`closed`) — the local view of the publish-ordering guard
  (complements, does not replace, the orchestrator's authoritative `gh`-side
  `nextWaveToPublish` check).
  Absent both flags, behavior is unchanged (emit `{ coordination }`, exit 0).

### B. `commands/masterplan.md` — §7 call-site corrections

All shell-side (shell owns git/`gh`; `bin` is fs-only). Edit the `publish` and
`follow` table rows (~353–354):

- **G4 (publish, issue body):** replace `mp gh-issue-body --task-id=<id> …` with
  `mp gh-issue-body --task="$(jq -c '.tasks[] | select(.id==<id>)' plan.index.json)" --contract-ref=<ref> --integration-branch=<int> --base-sha=<sha> --plan-hash=<hash> --wave=<N> --run-slug=<slug>` — pass the **full task object** as JSON.
- **G5 (follow, claim filter):** drop `parse-issue` from the pipe. Gather issues as
  a JSON array and pass directly:
  `gh issue list --label "mp:open,mp:run-<slug>" --json number,title,body,labels,assignees --limit 200` → `mp select-claimable --issues="$(…)" --plan-deps="$(…)"` (select-claimable parses each body internally). `parse-issue` stays a valid standalone single-body subcommand — just not in this pipe.
- **G6 (follow, deps):** replace the phantom `--deps-from-coord-status` with
  `--plan-deps="$(jq -c '[.tasks[] | {key: (.id|tostring), value: .deps}] | from_entries' plan.index.json)"`.
- **G7 (follow, claim validation):** resolve `@me` to the real login first —
  `actor="$(gh api user --jq .login)"` — then `mp validate-claim --issue=<json> --actor="$actor" --prs=<json>`.
- **G9 (follow/reconcile write-back):** after `mp reconcile-integration` returns
  actions, for each `{action:'mark_done', task_id, merge_sha}`: `mp mark-task --status=done` (as today) **and** `mp update-issue-map --task-id=<id> --merge-sha=<sha> --status=merged`; for `{action:'surface', …}` raise it via `AskUserQuestion`. Commit the bundle. This is what lets the next `publish` see the prior wave merged and advance.
- **publish coordination writes:** the `mp set-coord …` and per-issue
  `mp update-issue-map --task-id=<id> --issue=<n> --status=open --wave=<N>` calls
  replace the previously non-existent writer (G1). Preflights become real:
  `mp coord-status --fail-if-unpublishable` (publish) / `--fail-if-unconfigured` (follow).

### C. `lib/doctor/coord-drift.mjs` — G8 fix-hint

Line ~89: `mp reconcile` → `mp reconcile-integration`; `mp set-coordination` →
`mp set-coord`. Hint text only; no logic change.

## Test strategy

**Unit (new):** add `test/coord-writer.test.mjs` (or extend `test/coord.test.mjs`
if present) covering, via direct `mp` subprocess or the lib helpers:
- `set-coord`: pins each field; `--base-sha`+`--wave` merges into `base_sha_by_wave`
  without clobbering other waves; `--mark-published` dedups; `--base-sha` without
  `--wave` errors.
- `update-issue-map`: creates an entry; a second call shallow-merges (preserves
  `issue` when only `merge-sha`/`status` change); numeric coercion of `--issue`/`--pr`.
- `load-plan` parity: an index with no `plan_hash` + `--plan-md` → index gains
  `plan_hash` equal to `sha256(plan.md)`; an index that already has one is untouched.
- `coord-status`: `--fail-if-unconfigured` exits non-zero on null/partial
  coordination, zero when configured; `--fail-if-unpublishable` exits non-zero on
  wrong phase / empty tasks / unmerged prior wave, zero otherwise; both absent →
  exit 0 unchanged.

**Behavioral (§7 orchestrator):** the `mp-dogfood` re-run is the integration test —
publish wave 0 → follow wave 0 → user-gated PR merge → publish wave 1 → follow →
merge → finish → `coord-drift` doctor PASS. No bespoke `gh`/`git` harness.

**Regression:** full suite `node --test test/*.test.mjs` stays green; `node
bin/doctor.mjs` exit 0.

## Out of scope

- `lib/github-coord.mjs` — pure + correct; unchanged.
- `lib/resume.mjs` coordination branches — unchanged (dormant-by-default preserved).
- Any new orchestrator **verb** — `set-coord`/`update-issue-map` are `mp`
  subcommands, not verbs; no `RESERVED_VERBS` / verb-table sync needed.
- The dormant-by-default guarantee — an uncoordinated bundle's path stays
  byte-identical; these changes only fire under explicit `publish`/`follow`.
- Multi-actor race semantics beyond what `validateClaimSettle` already enforces.

## Verification

- `node --test test/*.test.mjs` — suite green incl. new coord-writer cases (cite count).
- `node bin/doctor.mjs` — exit 0.
- `bash -n` not needed (no shell-script edits beyond the markdown sequencer).
- Then (gated, outward, post-redeploy): re-run the `mp-dogfood` §7 path end-to-end.

## Task/wave decomposition hint (for the planner)

Natural seams — most of these are file-disjoint and could parallelize, but the
orchestrator §7 edits depend on the bin subcommands existing:

- **Wave 1 (bin + doctor + tests, file-disjoint):** A1/A2 (`set-coord` +
  `update-issue-map`) · A3 (`load-plan` parity) · A4 (`coord-status` flags) · C
  (doctor hint) · the new unit tests. All in `bin/masterplan.mjs` /
  `lib/doctor/coord-drift.mjs` / `test/`.
- **Wave 2 (orchestrator, depends on Wave 1):** B (§7 call-site corrections in
  `commands/masterplan.md`) — references the subcommands Wave 1 lands.

The planner (`mp-spec-decomposer`, planning-mode=auto) makes the final
serial-vs-parallel + wave call; Wave-1 bin edits to one file (`bin/masterplan.mjs`)
likely want a single implementer to avoid same-file collisions.
