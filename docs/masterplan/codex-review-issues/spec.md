# Spec: codex-review-issues

> **Status:** approved design (brainstorming → spec). Topic: investigate & fix
> the gaps that prevented codex review from firing in the hindsight-historian run.
> **Predecessor investigation:** the in-session root-cause analysis that found
> (a) `codex.review` was never armed, plus three compounding factors that made
> the gap invisible. This spec writes the fix.

## 1. Motivation

In the hindsight-historian run, codex adversarial review never fired. The
post-run audit found a single primary cause and three compounding factors. This
spec addresses each.

### 1.1 Primary cause

`mp seed` never initializes `state.codex` at all (`lib/bundle.mjs:285`, the
fresh-bundle seed builder). `state.codex?.review` is therefore `undefined` for
every new bundle, and `codexArmed(undefined)` in `lib/finish-step.mjs:71`
returns `false`. The finish-time gate condition at `lib/finish-step.mjs:451` is

```js
codexArmed(state.codex?.review) && base && !codexSuppressed && codex === null && …
```

so the gate fails closed at the first conjunct and the `run_codex_review` op is
never emitted. Users have to discover and run `mp set-codex-config --review=on`
manually; nobody did for the run in question.

### 1.2 Compounding factors (what made the gap invisible)

1. **Execution path was rerouted.** The local skynet/minimax-m3 writer was
   broken and Codex was implementer-ineligible (reason: linked-worktree), so
   the run was hand-driven by Claude general-purpose agents plus a same-vendor
   Claude "adversarial spec-conformance verify." That looked like adversarial
   review was happening; Codex was never in the loop.
2. **Finish-time safety net was defeated three ways over.** Even if `codex.review`
   had been armed, `detectBase` returned `null` (the repo has no
   main/master), the prior finish session's `--agents-md` host-misclassification
   had set `--codex-suppressed`, and the flag itself was never armed. Any
   one of these would have skipped review; all three were true.
3. **The doctor audit couldn't flag it.** The `codex_review_configured_but_zero_invocations`
   audit (referenced in `commands/masterplan.md:237`, `WORKLOG.md:104`,
   `bin/masterplan.mjs:482`, `lib/finish-step.mjs:221`) was proposed in
   `.claude/plans/cosmic-cuddling-dusk.md` but never implemented as a
   `lib/doctor/*.mjs` module. Even if it had been, it only fires when review
   is *configured* but ran zero times — the never-configured case it cannot
   catch.

## 2. Goal

1. Make codex review fire by default for new bundles, without requiring users to
   discover and run a separate opt-in subcommand.
2. Make the finish-time safety net robust against the three failure modes that
   converged on the hindsight-historian run (null base, suppressed host,
   missing config).
3. Make every review skip durable and auditable, so future regressions of any
   kind surface in `events.jsonl` instead of vanishing.
4. Leave existing bundles untouched on disk; defend them with a one-time
   per-bundle defensive arm at finish time.
5. Do NOT add a new doctor audit in this run (out of scope, see §6).

## 3. Non-goals

- A new `codex_review_configured_but_zero_invocations` doctor audit module
  (the user picked the no-audit option).
- Changes to `mp-codex-reviewer` itself (the per-task reviewer).
- Changes to routing (`state.codex.routing`); this plan only touches `review`.
- Migration script for existing bundles — the defensive arm covers them.

## 4. Design

### 4.1 Seed default — `codex.review` defaults to on

**`lib/bundle.mjs`** — extend `buildSeedState` with a `codexReview` opt
(default `true`). When the opt is truthy, emit `codex: { routing: 'auto',
review: true }` on the seeded state. When the opt is `false`, omit `review`
(leaving the existing behavior — opt-in via `mp set-codex-config`).

**`bin/masterplan.mjs`** — the `seed` subcommand parser adds
`--codex-review=on|off`. Default `on`. Persists via the same setter
`setCodexConfig` already used by `set-codex-config`, so the schema
(`state.codex.{routing,review}`) is unchanged.

**No migration.** Existing bundles keep whatever they have. New bundles get
`codex.review: true` automatically.

### 4.2 Finish-time defensive measures

All four live in `lib/finish-step.mjs`, in and around the gate at line 451.

**A. Auto-detect any main/master base (when `detectBase()` returns null).**
Extend `detectBase()` to search, in priority order:

1. Existing detection (local `main` / `master`)
2. `refs/remotes/origin/main`, `refs/remotes/origin/master`
3. `refs/remotes/*/main`, `refs/remotes/*/master` (any remote)
4. `git merge-base` against the branch's first-parent ancestor whose name
   matches the main/master pattern
5. Last-resort: the empty-tree SHA
   `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (universal diff baseline)

If all five fail, the gate falls through with a `no_base_branch` skip (see B).

**B. Durable skip events.** Every skip path in the gate now emits a
`codex_review_skipped` event with a typed `reason` field:

- `no_base_branch`
- `codex_host_suppressed`
- `state.codex.review not armed`
- `companion_unresolved`
- `companion_timeout`

The event text format matches the existing audit channel (already compatible
with the `\bcodex\s+review\b` regex the proposed-but-not-implemented
`codex_review_configured_but_zero_invocations` audit would use). A future
audit module can pick this up without re-shaping events.

**C. Defensive arming for bundles missing `state.codex`.** In the gate
condition, if `state.codex` is missing or `state.codex.review` is undefined,
auto-arm for this finish step only:

```js
const effectiveArmed = state.codex?.review ?? true; // defensive default
```

Emit `codex_review_defensively_armed` so the run bundle is auditable. This is
a one-time defensive per-bundle safety net for legacy bundles pre-dating the
seed default change. Once the seed default is on, this auto-arm path is
dormant for new bundles (they carry `codex.review: true` from birth).

**D. Audit the `--codex-suppressed` path.** When `--codex-suppressed` is set
(Codex hosting), emit `codex_review_skipped` with reason
`codex_host_suppressed` AND surface a one-line notice in the `branch_finish`
gate AUQ payload so the user sees why review was skipped. Currently silent.

### 4.3 Touched files (summary)

- `lib/bundle.mjs` — extend `buildSeedState` with `codexReview` opt
- `bin/masterplan.mjs` — add `--codex-review` to seed parser
- `lib/finish-step.mjs` — extend `detectBase`, arm the gate defensively,
  add `codex_review_skipped` / `codex_review_defensively_armed` event helpers,
  surface suppression notice in gate AUQ
- `test/bundle.test.mjs` — new seed-default cases
- `test/finish-step.test.mjs` — new gate cases (auto-detect, defensive arm,
  skip events, suppression notice)
- `test/bin-masterplan.test.mjs` — new `--codex-review` flag cases
- `README.md` — flag-table updates
- `docs/verbs.md` — document the new flag
- `commands/masterplan.md` §3 — mention the seed default
- `skills/masterplan/SKILL.md` — same
- `CHANGELOG.md` — entry under v8.x
- `WORKLOG.md` — active-section entry

## 5. Verification (CD-3)

- `node --test test/*.test.mjs` — all tests pass, including the new ones.
  Must report the actual pass count.
- `node bin/doctor.mjs` — no new findings.
- Manual end-to-end: a tiny test repo with no main/master, seeded with the
  new default, driven through the finish step. Verify the defensive-arm
  event fires and review attempts to run (will degrade-skip with
  `no_base_branch` if no remotes either, which is the expected outcome for
  such a fixture).
- Manual end-to-end: an existing bundle (state.codex missing) drives
  through finish. Verify the defensive-arm event fires and the finish step
  proceeds.
- Cite real command output and exit code in `retro.md`.

## 6. Out of scope (explicit)

- `codex_review_configured_but_zero_invocations` doctor audit module.
- Changes to `mp-codex-reviewer` (the per-task reviewer).
- Changes to routing.
- Migration script for existing bundles.

## 7. Locked decisions

- **Scope = primary + finish-time safety nets** (no new audit).
- **Flag strategy = default-on, opt-out** (matches `docs.normalize` polarity).
- **No-base fallback = auto-detect any main/master** (the most aggressive
  option; priority order + universal-diff last-resort reduce the wrong-base
  risk).
- **Defensive arming applies to bundles missing `state.codex` entirely**
  (legacy bundles pre-dating the seed change; dormant for new bundles).
- **No existing-bundle migration** — defensive arming is enough.