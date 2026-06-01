# Retro: github-coord-fix

**Branch:** `fix/github-coord-wiring` · **Base:** `main` · **Run:** 3 tasks / 2 waves

## Goal

Repair the masterplan v8 **github-coordination** `publish`/`follow` (§7) path so it
executes end-to-end. A Lane-A dogfood proved the path non-executable on released main
(`3e6e513`) and produced a 9-gap audit (memory note `v8-github-coord-broken`). The lib
layer (`lib/github-coord.mjs`, `setCoordination`/`clearCoordination` in `lib/bundle.mjs`)
was already complete and unit-tested — **only the bin↔orchestrator glue was never built.**
This run lands exactly that glue (a bounded wiring fix), no `lib/github-coord.mjs` /
`resume.mjs` change, dormant-by-default preserved.

## Locked decisions (carried from spec)

1. **Writer = two verbs.** `set-coord` (per-wave coordination pin: base_sha_by_wave,
   published_waves, contract_ref, integration_branch, …) + `update-issue-map` (incremental
   per-task `issue_map` splice). Cleaner than one overloaded writer.
2. **`plan_hash` stamped in `load-plan`** — parity with `merge-plan-fragments` (`bin:654`),
   so a serial bundle's `plan.index.json` carries the same hash a parallel bundle's does and
   the contract-ref name (`mp-coord/<slug>/<plan_hash>`) is defined on both paths.
3. **Scope = all 9 gaps G1–G9.**
4. **Tests = unit tests for the new subcommands + re-run the `mp-dogfood` §7 path as the
   behavioral integration test.** No bespoke `gh`/`git` harness (YAGNI).

## Gap → fix mapping (all 9 landed)

| gap | fix | where |
|---|---|---|
| G1 | `set-coord` state-writer (wires `setCoordination`) | `bin/masterplan.mjs` |
| G2 | `plan_hash` stamped on the serial `load-plan` path | `bin/masterplan.mjs` |
| G3/G3b | `coord-status --fail-if-unconfigured` / `--fail-if-unpublishable` preflights | `bin/masterplan.mjs` |
| G4 | `gh-issue-body --task=<full task JSON>` (+ `--wave`/`--run-slug`) | `commands/masterplan.md` |
| G5 | drop broken `parse-issue \| select-claimable` pipe → `issue_map` dedup via `coord-status` | `commands/masterplan.md` |
| G6 | `select-claimable --plan-deps=… --issues=…` (drop phantom `--deps-from-coord-status`) | `commands/masterplan.md` |
| G7 | resolve `@me` via `gh api user --jq .login` before `validate-claim` | `commands/masterplan.md` |
| G8 | doctor fix-hint → `reconcile-integration` / `set-coord` (phantoms removed) | `lib/doctor/coord-drift.mjs` |
| G9 | post-`reconcile-integration` → `update-issue-map --status=merged` write-back | `commands/masterplan.md` |

Plus the new `update-issue-map` writer (G1 sibling) and the publish-side coordination writes
(`set-coord` + per-issue `update-issue-map --status=open`, real preflights).

## Execution

- **Wave 0** — T1 (bin glue + `test/coord-writer.test.mjs`, 26 tests) ∥ T2 (doctor-hint).
  Commit `6b26452`. Both `done`; coord-writer 26/26, full suite 487/487, doctor exit 0.
- **Wave 1** — T3 (`commands/masterplan.md` §7 rewiring, deps T1). Commit `5080c59`.
  All 9 structural verify conditions pass; publish-hygiene 18/18.

## Verification (CD-3, at HEAD `0cd990a`)

- `node --test test/*.test.mjs` → **494 pass / 0 fail**
- `node bin/doctor.mjs` → 0 error, exit 0
- `node --test test/publish-hygiene.test.mjs` → 18 pass / 0 fail
- Cross-vendor **Codex** review over `ba136a4..HEAD`: **CHANGES-NEEDED → resolved** (see "Post-wave hardening" below)

## Post-wave hardening (3 follow-on commits after the wave 1 finalize)

The wave-0/1 work landed the 9-gap glue, but a cross-vendor review pass plus a
re-read of the publish↔follow hand-off surfaced one **latent deadlock** and one
**dead-guard** bug — both in the very publish-advance path this run exists to
repair. Neither was caught by the wave-time unit suite because the tests codified
the same incomplete contract.

1. **`e01b0fe` — terminal-status deadlock.** `coord-status --fail-if-unpublishable`
   treated only `closed` as terminal, but the G9 reconcile write-back sets `merged`
   and nothing writes local `closed` → a fully-followed wave N never became
   "publishable", blocking wave N+1 forever. Fixed: terminal = `{merged, closed}`,
   plus a regression test exercising the `merged` case the old test never hit.
2. **`924a274` — single source of truth.** The terminal definition was scattered
   (inline `Set` in bin, hard-coded comparison in doctor) with no typo-guard on
   `update-issue-map --status`. Consolidated into `lib/github-coord.mjs` (A2b block:
   `ISSUE_MAP_STATUSES`, `isTerminalIssueStatus`, `isValidIssueStatus`), documenting
   the two DISTINCT status lifecycles that share string values (the GitHub LABEL
   machine `open→claimed→pr-open→closed` vs. the local issue_map mirror
   `open→claimed→pr-open→merged[→closed]`). Both bin + doctor now consume the one
   helper; `update-issue-map` dies on an off-vocabulary `--status` (no partial write).
3. **`0cd990a` — dead publish-advance guard (Codex-found, blocking).** The §7 publish
   flow pinned coordination without `--mark-published`, so `published_waves` stayed
   `[]` and the `--fail-if-unpublishable` guard's outer condition
   (`published_waves.length > 0`) was never true — the guard, and therefore the whole
   terminal-status fix above, was **unreachable on the real path**. Fixed by adding
   `--mark-published` to the publish `set-coord` call. Same commit fixes a G8-class
   coord-drift fix-hint that cited `mp set-coord` (a coordination-scalar writer) to
   update a per-task issue_map entry; corrected to `mp update-issue-map`.

**Review tooling note:** the `codex review` companion failed to converge twice
(re-read the full `ba136a4..HEAD` diff for 30–40 min without a verdict, then
restarted). Switching to the model-invocable `codex:codex-rescue` Agent with a
focused, severity-ranked review brief converged in ~7 min and returned the blocking
`--mark-published` finding. Lesson: for a moderately large diff, prefer the bounded
rescue Agent over the looping companion.

## What is NOT proven here (deliberate)

The §7 path is verified **structurally + by unit test**, not yet **behaviorally end-to-end**.
The orchestrator prompt (`commands/masterplan.md`) has no unit harness, and publish-hygiene
guards verb/namespace consistency, not §7 flag spellings. Per the locked test strategy, the
behavioral proof is the **gated `mp-dogfood` §7 re-run**, which can only happen *after*
redeploy (re-mirror to the 3 caches + a **user-only** `/plugin marketplace update` +
`/reload-plugins`). Sequence when unblocked: publish w0 → follow w0 → **user-gated PR merge** →
publish w1 → follow → merge → finish flow → `coord-drift` doctor PASS.

## Known wrinkles (out of scope, benign)

**load-plan plan_hash stamp ordering** (Codex nit, deferred). `load-plan` stamps
`plan.index.json` with `plan_hash`/`generated_at` *before* `loadPlanTasks` can throw
(bundle already has tasks / empty index / non-integer wave), so a load rejected for a
*state-level* reason still mutates the artifact. Low-risk: the stamped hash is the
correct `sha256(plan.md)` regardless of whether tasks load, and the stamp is
idempotent (a re-run at unchanged `plan.md` leaves the file byte-for-byte identical).
A future polish would move the `loadPlanTasks` call ahead of the stamp so a failed
load touches nothing; left as-is to keep this run scoped to the coordination path.

**verify-scope bundle-state false positive.**
`verify-scope` flagged the bundle's own `state.yml` as `outOfScope` on both waves — a
baseline-timing artifact: §2a captures the D6 baseline *before* the shell's own `set-active-run`/
`promote-active-run`/`mark-task` state writes, so those writes look "introduced." The
`wave.mjs:89-90` comment already documents that masterplan's own bundle writes are "not a wave
scope violation"; the shell commits `state.yml` regardless. Possible future polish: capture the
baseline after the phase-1 marker, or have `verify-scope` auto-exclude the bundle state path.

## Next steps (gated, outward — user-driven)

1. Merge `fix/github-coord-wiring` → `main` (**user-gated** risky action).
2. Re-mirror to the 3 caches; **user-only** `/plugin marketplace update` + `/reload-plugins`.
3. Re-run the paused `mp-dogfood` §7 path end-to-end (the behavioral test).
4. Cleanup obligation when dogfood done: `gh repo delete rasatpetabit/mp-dogfood` +
   `rm -rf /srv/dev/mp-dogfood*`.
