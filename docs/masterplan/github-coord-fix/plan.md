# Plan: github-coord-fix

Wire the masterplan **github-coordination** `publish` / `follow` (§7) glue so the
path executes end-to-end. The lib layer is complete and unit-tested; this run lands
only the **bin↔orchestrator glue** + the new subcommand unit tests, fixing all nine
gaps (G1–G9) from the `v8-github-coord-broken` audit. Bounded **wiring fix** — no
change to `lib/github-coord.mjs`, `resume.mjs` coordination branches, or the
dormant-by-default guarantee.

Spec: [`spec.md`](./spec.md). Branch: `fix/github-coord-wiring`.

## Wave shape

The dominant subsystem (G1–G3) is all in **one file** (`bin/masterplan.mjs`), so
those bin edits MUST be a single implementer's work — never split across same-wave
parallel tasks (same-file collision). The doctor-hint (G8) is file-disjoint and rides
the same wave. The orchestrator §7 corrections (G4–G7, G9) reference the bin
subcommands the first task lands, so they are a **strictly later wave**.

| wave | task | files | parallel-safe with |
|---|---|---|---|
| 0 | T1 coord-writers | `bin/masterplan.mjs`, `test/coord-writer.test.mjs` | T2 (disjoint) |
| 0 | T2 doctor-hint | `lib/doctor/coord-drift.mjs` | T1 (disjoint) |
| 1 | T3 orchestrator | `commands/masterplan.md` | — (deps T1) |

Same-wave tasks are file-disjoint (the `validate-plan-index` D6 gate enforces it);
dependency ⇒ higher wave number.

---

## Task 1 — coord-writers (wave 0)

The bin glue for G1/G2/G3. Single file (`bin/masterplan.mjs`) + the new unit-test
file, one implementer. Transcribed from spec §"Implementation surface" A1–A4.

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
`base_sha_by_wave[wave]` and `published_waves` against existing values, **not**
replace, because `setCoordination` replaces those keys wholesale) → `setCoordination`
→ `writeState` → emit `{ coordination }`. `--base-sha`/`--mark-published` without
`--wave` → `die`.

**A2 — `update-issue-map` (new case).** Splice one task's `issue_map` entry.

```
mp update-issue-map --state=<path> --task-id=<id>
                    [--issue=<n>] [--pr=<n>] [--merge-sha=<sha>]
                    [--status=<open|claimed|pr-open|merged|closed>] [--wave=<n>]
```
Handler: `loadForWrite` → `entry = { ...issue_map[task_id] }` → assign only provided
fields (numbers via `coerceId`) → `issue_map[task_id] = entry` →
`setCoordination(state, { issue_map })` → `writeState` → emit `{ task_id, entry }`.
At least one mutating flag required else `die`.

**A3 — `load-plan` `plan_hash` parity (amend the case at ~418).** Accept optional
`--plan-md=<path>`. When provided and the loaded index lacks `plan_hash` (null/absent),
compute `sha256:${createHash('sha256').update(readText(planMd)).digest('hex')}` (the
exact form from `merge-plan-fragments` ~654), stamp `plan_hash` (and `generated_at` if
absent) onto the index object, **write the index file back**, then materialize tasks as
today. Idempotent: an index already carrying `plan_hash` is untouched. Net effect: a
serial bundle's `plan.index.json` carries the same `plan_hash` a parallel bundle's
does, so publish's `jq .plan_hash plan.index.json` works on both paths.

**A4 — `coord-status` preflight flags (amend the case at ~927).**
- `--fail-if-unconfigured` (used by `follow`): exit non-zero with a stderr diagnostic
  if `state.coordination` is absent **or** missing `contract_ref` / `integration_branch`.
- `--fail-if-unpublishable` (used by `publish`): exit non-zero with a diagnostic if the
  bundle can't publish a wave now — `phase !== 'execute'` **or** `tasks` empty **or**
  coordination exists and the most-recently-published wave still has an `issue_map`
  entry not in a terminal state (`merged`/`closed`).
- Absent both flags: behavior unchanged — emit `{ coordination }`, exit 0.

**Tests — `test/coord-writer.test.mjs` (new).** Per spec Test strategy:
- `set-coord`: pins each field; `--base-sha`+`--wave` merges into `base_sha_by_wave`
  without clobbering other waves; `--mark-published` dedups; `--base-sha` without
  `--wave` errors.
- `update-issue-map`: creates an entry; a second call shallow-merges (preserves `issue`
  when only `merge-sha`/`status` change); numeric coercion of `--issue`/`--pr`.
- `load-plan` parity: no-`plan_hash` index + `--plan-md` → index gains
  `plan_hash == sha256(plan.md)`; an index that already has one is untouched.
- `coord-status`: `--fail-if-unconfigured` non-zero on null/partial, zero when
  configured; `--fail-if-unpublishable` non-zero on wrong phase / empty tasks /
  unmerged prior wave, zero otherwise; both absent → exit 0.

**Files:** `bin/masterplan.mjs`, `test/coord-writer.test.mjs`
**Verify:** `node --test test/coord-writer.test.mjs` · `node --test test/*.test.mjs` · `node bin/doctor.mjs`
**Routing:** `codex: "no"` — per-key merge against existing coordination state + the
preflight-guard judgment is cross-cutting reasoning over the bundle data model, not
mechanical.
**Deps:** none.

---

## Task 2 — doctor-hint (wave 0)

**C — `lib/doctor/coord-drift.mjs` line ~89 (G8).** The WARN finding's `fix` string
cites phantom commands. Correct them, text only:
- `mp reconcile` → `mp reconcile-integration`
- `mp set-coordination` → `mp set-coord`

No logic change, no severity change, no exit-code change. File-disjoint from Task 1 →
shares wave 0.

**Files:** `lib/doctor/coord-drift.mjs`
**Verify:** `grep -q 'mp reconcile-integration' lib/doctor/coord-drift.mjs` ·
`grep -q 'mp set-coord' lib/doctor/coord-drift.mjs` · `node bin/doctor.mjs`

> The doctor exit code does **not** prove the change (the hint renders only on drift; a
> WARN doesn't move the exit code). The greps assert the *corrected* strings are
> present — the clean proof. We don't assert the phantoms absent: `mp reconcile`
> substring-matches `mp reconcile-integration` and `mp set-coord` is a prefix of
> `mp set-coordination`, so presence-of-corrected is the right check.

**Routing:** `codex: "ok"` — mechanical two-string replacement, one file, concrete grep
verify.
**Deps:** none.

---

## Task 3 — orchestrator (wave 1, deps: T1)

**B — `commands/masterplan.md` §7 publish/follow rows (~353–354).** Shell-side only
(the shell owns git/`gh`; `bin` is fs-only). Each corrected call-site references a bin
subcommand Task 1 lands → this task is a later wave depending on T1.

- **G4 (publish, issue body):** `mp gh-issue-body --task-id=<id>` →
  `mp gh-issue-body --task="$(jq -c '.tasks[] | select(.id==<id>)' plan.index.json)" --contract-ref=<ref> --integration-branch=<int> --base-sha=<sha> --plan-hash=<hash> --wave=<N> --run-slug=<slug>` (full task object as JSON).
- **G5 (publish dedup, `:353`):** drop the broken `… | mp parse-issue | mp select-claimable`
  pipe entirely — `select-claimable` is the follow-side claim-filter, the wrong tool for
  publish dedup, and receives no `--issues` here so it `die`s. Replace the pipe with
  `issue_map`-based dedup: compute the wave's unpublished tasks by filtering wave tasks
  against `coordination.issue_map` (read via `mp coord-status`; on first publish the map
  is empty so all wave tasks are unpublished), then iterate that set for `gh issue create`.
  Keep the gh-side `findDuplicates`/`validate-claim` backstop as a "fail loud on
  unexpected duplicate" guard. `parse-issue` and `select-claimable` remain valid
  standalone subcommands — neither belongs in publish dedup.
- **G6 (follow claim, `:354`):** `select-claimable` IS the right tool here; fix **both**
  defects on this row: (1) replace phantom `--deps-from-coord-status` with
  `--plan-deps="$(jq -c '[.tasks[] | {key: (.id|tostring), value: .deps}] | from_entries' plan.index.json)"`,
  AND (2) supply the issues array it requires:
  `--issues="$(gh issue list --label "mp:open,mp:run-<slug>" --json number,title,body,labels,assignees --limit 200)"`.
- **G7 (follow, claim validation):** resolve `@me` first —
  `actor="$(gh api user --jq .login)"` — then `mp validate-claim --issue=<json> --actor="$actor" --prs=<json>`.
- **G9 (follow/reconcile write-back):** after `mp reconcile-integration` returns
  actions, for each `{action:'mark_done', task_id, merge_sha}`: `mp mark-task --status=done`
  **and** `mp update-issue-map --task-id=<id> --merge-sha=<sha> --status=merged`; for
  `{action:'surface', …}` raise via `AskUserQuestion`. Commit the bundle.
- **publish coordination writes (G1 consumer):** wire `mp set-coord …` + per-issue
  `mp update-issue-map --task-id=<id> --issue=<n> --status=open --wave=<N>`, and make
  preflights real — `mp coord-status --fail-if-unpublishable` (publish) /
  `--fail-if-unconfigured` (follow).

No new orchestrator **verb** — `set-coord`/`update-issue-map` are `mp` subcommands;
no `RESERVED_VERBS` / verb-table sync.

**Files:** `commands/masterplan.md`
**Verify (structural):** `grep -q 'gh-issue-body --task=' commands/masterplan.md` ·
`grep -q -- '--plan-deps=' commands/masterplan.md` ·
`! grep -q -- '--deps-from-coord-status' commands/masterplan.md` ·
`! grep -q -- 'validate-claim --actor=@me' commands/masterplan.md` ·
`node --test test/publish-hygiene.test.mjs` ·
`! grep -q 'parse-issue | mp select-claimable' commands/masterplan.md` ·
`grep -q -- '--issues=' commands/masterplan.md` ·
`grep -q 'update-issue-map' commands/masterplan.md` ·
`grep -q 'set-coord' commands/masterplan.md`

> **No in-env behavioral verify for this task.** `commands/masterplan.md` is the
> markdown sequencer — it has no unit harness, and publish-hygiene only guards
> verb/namespace consistency, not §7 flag spellings. The spec explicitly defers the
> behavioral proof to the **gated `mp-dogfood` §7 re-run** (publish wave 0 → follow →
> merge → publish wave 1 → … → `coord-drift` PASS), post-redeploy. The structural greps
> above prove the corrections landed in text; they are the right in-env check, not a
> fabricated behavioral one.

**Routing:** `codex: "no"` — cross-file reasoning over the sensitive orchestrator
prompt with no runnable behavioral verify.
**Deps:** T1 (the bin subcommands every corrected call-site references).

---

## Regression gate (whole run)

- `node --test test/*.test.mjs` — full suite green incl. the new coord-writer cases.
- `node bin/doctor.mjs` — exit 0.
- Gated, outward, post-redeploy: re-run the `mp-dogfood` §7 path end-to-end (the
  integration test — no bespoke `gh`/`git` harness, per spec).
