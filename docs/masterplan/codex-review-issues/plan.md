# Plan: codex-review-issues

## Wave 0 - Seed default and seed CLI

### Task 1

Default new bundles to finish-time Codex review being armed, while preserving an explicit seed opt-out.

Files:
- `lib/bundle.mjs`
- `bin/masterplan.mjs`
- `test/bundle.test.mjs`
- `test/bin-masterplan.test.mjs`

Implementation notes:
- Extend `buildSeedState` with a `codexReview` option that defaults to enabled.
- Emit the existing nested schema shape, `codex: { routing: 'auto', review: true }`, only when default-on or explicitly on.
- Add `mp seed --codex-review=on|off`, defaulting to `on`; validate bad values.
- Keep `set-codex-config` as the existing schema writer for later updates.

Verification:
- `node --test test/bundle.test.mjs test/bin-masterplan.test.mjs`

## Wave 1 - Finish-step defensive review gate

### Task 2

Make finish-time Codex review robust and auditable in `lib/finish-step.mjs`.

Files:
- `lib/finish-step.mjs`

Implementation notes:
- Compute an effective review setting that defensively treats missing `state.codex.review` as armed for legacy bundles.
- Emit `codex_review_defensively_armed` once per bundle/head when the defensive default is used.
- Expand finish-step base resolution beyond local `main`/`master`: local branches, origin branches, any remote main/master, an ancestor-derived main/master match where available, and the empty-tree SHA as the last-resort diff baseline.
- Emit durable `codex_review_skipped` events for typed skip reasons: `no_base_branch`, `codex_host_suppressed`, `state.codex.review not armed`, `companion_unresolved`, and `companion_timeout`.
- Surface Codex-host suppression in the `branch_finish` gate payload so the user can see why review did not run.

Verification:
- `node --test test/finish-step.test.mjs`

## Wave 2 - Extended tests

### Task 3

Add focused regression coverage for the default, defensive legacy behavior, skip auditing, suppression notice, and expanded base handling.

Files:
- `test/bundle.test.mjs`
- `test/bin-masterplan.test.mjs`
- `test/finish-step.test.mjs`

Implementation notes:
- Cover default-on and explicit-off seed state.
- Cover `mp seed --codex-review=on|off` and invalid values.
- Cover missing legacy `state.codex`, explicit off, Codex-host suppression, degraded companion skip reasons, and base fallback behavior.
- Preserve the existing re-entry guarantees: a durable review or skip at the same head must prevent review loops.

Verification:
- `node --test test/bundle.test.mjs test/bin-masterplan.test.mjs test/finish-step.test.mjs`
- `node --test test/*.test.mjs`

## Wave 3 - Documentation

### Task 4

Document the default-on review behavior, the seed opt-out, and the finish-time skip/audit semantics.

Files:
- `README.md`
- `docs/verbs.md`
- `commands/masterplan.md`
- `skills/masterplan/SKILL.md`
- `CHANGELOG.md`
- `WORKLOG.md`

Implementation notes:
- Update user-facing seed flag references with `--codex-review=on|off`.
- Mention that new bundles arm finish-time Codex review by default.
- Document that legacy bundles missing `state.codex.review` are defensively armed at finish and that review skips are written to `events.jsonl`.
- Keep verb/skill surfaces synchronized.

Verification:
- `node --test test/publish-hygiene.test.mjs test/prompt-structure.test.mjs`
- `node bin/doctor.mjs`
