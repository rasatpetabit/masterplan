# Retro: codex-review-issues

> **Run bundle:** `docs/masterplan/codex-review-issues/`
> **Branch:** `masterplan/codex-review-issues`
> **Plan:** 4 tasks, 4 waves (each task its own wave — sequential because most touched overlapping files)
> **Status:** finalized via `mp finish-step` (verify + retro + branch_finish gate)

## What shipped

The hindsight-historian fix the user identified: `codex.review` was never armed at seed time, so the finish-time review gate failed closed at the first conjunct and `run_codex_review` was never emitted — three compounding factors made the gap invisible (execution path rerouted, finish-time safety net defeated, doctor audit didn't catch never-configured).

### The behavior change

- `lib/bundle.mjs` `buildSeedState` now defaults `codexReview: true`. Fresh bundles emit `state.codex = { routing: 'auto', review: true }`. Explicit opt-out via `codexReview: false` (CLI: `--codex-review=off`) leaves `state.codex` absent (A9 absent-field style — `codexArmed(undefined) === false` at runtime, audit trail differs from never-decided).

### The defensive safety net (legacy bundles)

- `lib/finish-step.mjs` gate restructured into **7a/7b/7c/7d**:
  - **7a** computes `effectiveArmed = codexArmed(state.codex?.review) || defensiveArmed` where `defensiveArmed = state.codex === undefined`. Emits `codex_review_defensively_armed` once per bundle (presence-scoped, NOT sha-scoped) so legacy bundles missing `state.codex` reach the finish gate with the review armed and the audit trail shows the legacy state was rescued.
  - **7b** resolves base via `lib/finish.mjs` `detectBaseAuto(branchesText, remoteBranchesText)`: local `main|master` → `origin/main|master` → any remote → `EMPTY_TREE_SHA` (`4b825dc6…`) as universal-diff last resort. The empty-tree SHA is intentionally applied HERE (not inside `detectBaseAuto`) so a missing-everything repo still produces a typed skip event.
  - **7c** emits `codex_review_skipped` with a typed reason (`state.codex.review not armed`, `codex_host_suppressed`, `no_base_branch`) — sha-keyed, idempotent at HEAD via the existing `hasCodexSkipAtSha` re-entry guard.
  - **7d** runs review.
- The `branch_finish` AUQ payload now carries a `notice` field surfacing the skip reason / suppression / defensive-arm note so the user sees WHY review didn't run, not just that it didn't.

### The durable audit channel

Three new event types in `events.jsonl` (all searchable by `codex_review*` prefix):

| Event | Summary format | When |
|---|---|---|
| `codex_review` | `codex review complete (whole-branch, base <X>) — <N> findings` | review ran successfully |
| `codex_review_skipped` | `codex review skipped — <typed reason>` | armed but didn't run (skip reasons: `state.codex.review not armed`, `codex_host_suppressed`, `no_base_branch`) |
| `codex_review_defensively_armed` | `codex review defensively armed — legacy bundle missing state.codex.review; finish-step gate would otherwise silently skip` | legacy bundle rescued once |

A future `codex_review_configured_but_zero_invocations` doctor module would match the `codex review` summary format (the success regex `\bcodex\s+review\b`) but NOT the `codex review skipped` format (hyphenated phrase breaks the regex) — so a degraded finish where nothing reviewed would still trip the future audit.

## Verification (CD-3)

Cited real command output and exit codes:

| Verify command | Pass / fail | Cited |
|---|---|---|
| `node --test test/bundle.test.mjs test/bin-masterplan.test.mjs` | 155/155 pass | Wave 0 + Wave 2 |
| `node --test test/finish-step.test.mjs` | 35/35 pass | Wave 2 |
| `node --test test/*.test.mjs` (full suite) | 950/951 pass | 1 pre-existing `agents/mp-implementer.md` tools-regex failure, unrelated |
| `node --test test/publish-hygiene.test.mjs test/prompt-structure.test.mjs` | 35/35 pass | Wave 3 docs |
| `node bin/doctor.mjs` | 0 error, 4 warn | All 4 warns pre-existing (plugin-registry stale cache, scalar-cap on `finish-flow-hardening` topic, 2 stale-codex-task jobs from earlier sessions) |

## Out of scope (explicit)

- `codex_review_configured_but_zero_invocations` doctor audit module — user picked the no-audit option.
- Changes to `mp-codex-reviewer` itself (the per-task reviewer).
- Changes to `state.codex.routing` (this plan only touched `review`).
- Migration script for existing bundles — defensive arm is enough.

## Residual risks

- **Auto-detect-any-main-master is the most aggressive base fallback.** A stale remote ref (`origin/HEAD` from a year ago) becomes the base, and review fires against the wrong diff. Mitigation: priority order prefers local branches first, then origin, then other remotes; the universal-diff fallback only triggers if literally nothing is found; the AUQ surfaces the base + `base_source` so the user can reject.
- **Defensive arm is a one-time per-bundle event**, not sha-keyed. If a legacy bundle is re-seeded (via `mp seed --force`), the defensive arm no longer fires — the new seed has the explicit `state.codex.review: true` from the new default. Documented in the WORKLOG entry.
- **The empty-tree SHA `4b825dc642cb6eb9a060e54bf8d69288fbee4904`** is a git-stable constant. If it ever changes (it won't, but the assertion in `test/finish.test.mjs` would catch it), every review-against-empty tool on Earth breaks simultaneously — i.e., the constant is well-known enough that a wrong value would be caught by reviewers immediately.

## Lessons learned

- **The dispatchers were broken during this run.** `agent-dispatch` returned `chain_exhausted` for every class I tried; `MiniMax API 401` for `pi/claude-fable` and `claude/opus`; the local `pi` subagent tool failed to find any model. The `paseo run --provider codex --model gpt-5.5` path worked end-to-end. The plan was written by codex/gpt-5.5 via Paseo (the same dispatch path the fix targets); the implementation ran inline in this session (host-suppressed `dispatch_foreground` per §2 Residual 3B). Documented in WORKLOG.
- **D6 verify-scope caught a real cross-wave out-of-scope commit.** Wave 2's commit included a `freshEvents` re-read in `lib/finish-step.mjs` that was technically out of Task 3's scope (test files only). D6 reverted it; I fixed by amending Wave 1's commit via `git rebase --autosquash` to include the fixup. The pattern: any wave that touches a file outside its declared scope gets reverted by D6, even if the change is functionally correct. Future waves: keep commits strictly within scope, or split the change into a separate wave.
- **makeFixture needed an `explicitCodex` opt-out.** The default-bundle got `codex: { review: false }` so existing tests kept their semantics (the old implicit-no-codex behavior, which would now defensively-arm everything). New tests that exercise the defensive-arm path pass `explicitCodex: false` to omit the field entirely.
- **The `notice` field on `branch_finish` was the user's "WHY review didn't run" requirement made durable.** Previously the AUQ said "codex review was not done" with no context; now it carries the typed reason so the user can decide whether to fix-and-redispatch or proceed-anyway.

## Commit graph

```
96c8ddd Wave 3: docs for default-on review + defensive gate
823b16c Wave 1: finish-step defensive Codex-review gate
70bae34 Wave 2: extended regression tests for defensive gate + skip auditing
27ce7f1 Wave 0: seed default codex.review=on + --codex-review=off CLI opt-out
6b22b5d masterplan: codex-review-issues plan (4 tasks, 4 waves)
```

(Wave 1 squashed with the `freshEvents` re-read fixup via `git rebase --autosquash`; the squash produced the same Wave 2 → 1 parent relationship the plan tracking expects.)