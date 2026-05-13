# Plan: loose autonomy auto-approves plan_approval gate (v4.2.0)

**Plan kind:** implementation
**Complexity:** high
**Spec:** [docs/masterplan/loose-skip-plan-approval/spec.md](./spec.md)
**Slug:** loose-skip-plan-approval
**Branch:** loose-skip-plan-approval
**Target version:** v4.2.0
**Eat-own-dogfood note:** this kickoff itself will halt at B3 plan_closeout (per `halt_mode: post-plan`); v4.2.0 lands the new behavior for future kickoffs under `halt_mode == none` + loose autonomy.

## Tasks

### T1 — Edit L1360 plan_approval gate condition

Change the `halt_mode == none` branch of Step B3's close-out gate so the `plan_approval` gate fires only under `--autonomy == gated`, not `--autonomy != full`. Under loose OR full → auto-approve, clear `pending_gate`, proceed to Step C silently. Under gated → halt as today.

**Files:**
- `commands/masterplan.md` (single `Edit` at L1360; rewrite the bullet body in place)

**Codex:** no
**Rationale:** orchestrator change with very specific phrasing requirements (must match the surrounding spec voice); inline edit is faster than briefing Codex.

**Concrete edit target.** Current text at L1360:
> - **`halt_mode == none`** (existing kickoff path, unchanged): if `--autonomy != full`, persist `pending_gate` with `id: plan_approval`, then present a one-paragraph plan summary and the path to the plan file via `AskUserQuestion` with options "Start execution / Open plan to review / Cancel". Wait for approval. If `--autonomy=full`: clear `pending_gate` and skip approval. Proceed to **Step C** with the new `state.yml` path.

New text:
> - **`halt_mode == none`** (kickoff path): if `--autonomy == gated`, persist `pending_gate` with `id: plan_approval`, then present a one-paragraph plan summary and the path to the plan file via `AskUserQuestion` with options "Start execution / Open plan to review / Cancel". Wait for approval. If `--autonomy in {loose, full}`: clear `pending_gate` (no-op if never opened), skip approval, append `plan_approval_auto_accepted` to `events.jsonl` with `{autonomy: "<loose|full>"}`, and proceed to **Step C** with the new `state.yml` path. **Behavior change (v4.2.0):** loose autonomy used to halt here; it now auto-approves like full. Users who want the old halt for last-look-before-execute should run kickoff with `--autonomy=gated` explicitly.

### T2 — Verify L1286 spec_approval gate is unchanged

Confirm the spec_approval gate at L1286 still gates on `--autonomy != full` (NOT `--autonomy == gated`). Spec_approval is explicitly out of scope for this plan; we only touched plan_approval.

**Files:**
- (read-only) `commands/masterplan.md` L1280–L1295

**Codex:** no
**parallel-group:** verification-pre-commit
**Verification:** `grep -nE 'id: spec_approval' commands/masterplan.md` shows L1286 still references the autonomy condition; manual eyeball confirms the wording matches v4.1.1.

### T3 — CHANGELOG v4.2.0 entry

Add a new `## [4.2.0] — 2026-05-13` section to CHANGELOG.md. Describe the behavior change in one short paragraph + migration note + reference to this plan's slug. Keep entry style consistent with v4.1.1 entry above it (verify format first).

**Files:**
- `CHANGELOG.md`

**Codex:** no
**Rationale:** judgment about wording + cross-references; inline is faster.

**Required content:**
- Headline: behavior change — loose autonomy no longer halts at plan_approval during kickoff.
- One-line root-cause note: the gate condition was `--autonomy != full` but should have been `--autonomy == gated` per the loose-autonomy "auto-progress through wave boundaries" contract.
- Migration: users who relied on the halt for last-look-before-execute should add `--autonomy=gated` to their kickoff invocation.
- Reference: `docs/masterplan/loose-skip-plan-approval/spec.md`.
- Note that L1286 spec_approval gate is intentionally NOT changed.

### T4 — Version bump in .claude-plugin/plugin.json

Bump `version` from `4.1.1` to `4.2.0`.

**Files:**
- `.claude-plugin/plugin.json`

**Codex:** ok
**parallel-group:** version-bumps
**Verification:** `grep -E '"version":\s*"4.2.0"' .claude-plugin/plugin.json` returns one match.

### T5 — Version bump in .codex-plugin/plugin.json

Bump `version` from current value to `4.2.0` (verify current value first; should mirror .claude-plugin/plugin.json).

**Files:**
- `.codex-plugin/plugin.json`

**Codex:** ok
**parallel-group:** version-bumps
**Verification:** `grep -E '"version":\s*"4.2.0"' .codex-plugin/plugin.json` returns one match.

### T6 — Version bump in .claude-plugin/marketplace.json

Bump version reference (location TBD — verify schema). Likely a `"version"` field on the masterplan plugin entry.

**Files:**
- `.claude-plugin/marketplace.json`

**Codex:** ok
**parallel-group:** version-bumps
**Verification:** `grep -nE '"version"' .claude-plugin/marketplace.json` confirms `4.2.0` appears (and the prior `4.1.1` does not, or only appears in a different context like dependency version).

### T7 — Version bump in .agents/plugins/marketplace.json

Bump version reference. Verify schema before editing.

**Files:**
- `.agents/plugins/marketplace.json`

**Codex:** ok
**parallel-group:** version-bumps
**Verification:** `grep -nE '"version"' .agents/plugins/marketplace.json` confirms `4.2.0`.

### T8 — docs/internals.md autonomy-behavior subsection (conditional)

Scan docs/internals.md for any subsection that documents per-autonomy gate behavior (especially around the loose-autonomy contract or the B1/B3 close-out gate semantics). If a relevant section exists and would be inaccurate after T1, add a one-paragraph note describing the v4.2.0 change. If no relevant section exists, this task is a no-op — record the no-op in events.jsonl and continue.

**Files:**
- (read first) `docs/internals.md` near L242, L312, L866 per grep results
- `docs/internals.md` (only if edit needed)

**Codex:** no
**Rationale:** discretionary edit dependent on what's there; orchestrator judgment.

### T9 — Fresh-eyes Explore subagent: read commands/masterplan.md end-to-end

Per project CLAUDE.md anti-pattern #5: after the multi-line edit at T1, dispatch a Haiku Explore subagent to read commands/masterplan.md cover-to-cover and report any (a) dangling references to the OLD condition wording (`--autonomy != full` near plan_approval); (b) internal contradictions between the new L1360 and other parts of the spec referencing plan_approval gate behavior; (c) any remaining gate sites that still say "autonomy != full" — separate them into "still spec_approval (expected, T2 verifies)" vs "anything else (potential miss)".

**Files:**
- (read-only) `commands/masterplan.md` end-to-end

**Codex:** no
**parallel-group:** verification-post-commit
**Subagent dispatch:** `Agent(subagent_type=Explore, model=haiku, prompt=<bounded brief>)`.

### T10 — Manual smoke validation in a throwaway repo

Create a one-shot throwaway repo at `/tmp/masterplan-smoke-loose-fix-$$`, init git, set autonomy=loose in a local `.masterplan.yaml`, invoke `/masterplan full <tiny-topic>`, observe gate sequence. Expected: ONE `gate_opened` event for `spec_approval`, ZERO for `plan_approval`. Capture the events.jsonl excerpt + screenshot/transcript excerpt into this bundle's events.jsonl as a `manual_smoke_observed` event.

**Files:**
- (smoke artifacts in /tmp; nothing committed in this repo)
- `docs/masterplan/loose-skip-plan-approval/events.jsonl` (append smoke result)

**Codex:** no
**Rationale:** requires interactive `/masterplan` invocation in a fresh session; not subagent-able.
**Acceptance recordkeeping:** the smoke event payload must include the verbatim count of `gate_opened`/`gate_closed` events from the throwaway repo's events.jsonl and the verbatim list of `event` values from the post-spec → post-plan phase.

### T11 — Final acceptance-grep verification

Run the acceptance verification commands from the spec; record results in events.jsonl as `acceptance_verified` with all command output excerpts.

**Files:**
- (read-only) `commands/masterplan.md`, `CHANGELOG.md`, 4 manifest files
- `docs/masterplan/loose-skip-plan-approval/events.jsonl` (append)

**Codex:** no
**parallel-group:** verification-post-commit
**Required commands:**
- `grep -nE 'id: plan_approval' commands/masterplan.md` → guards on `autonomy == gated`
- `grep -nE 'id: spec_approval' commands/masterplan.md` → unchanged from v4.1.1
- `git grep -nE '--autonomy != full' commands/ docs/ README.md` → only L1286 (spec_approval site)
- `grep -nE '"version":\s*"4.2.0"' .claude-plugin/plugin.json .codex-plugin/plugin.json .claude-plugin/marketplace.json .agents/plugins/marketplace.json` → exactly 4 matches (one per file)
- `grep -nE '## \[4.2.0\]' CHANGELOG.md` → exactly 1 match

### T12 — Commit + push

Stage all edited files (NOT the run bundle — bundle is committed separately for traceability). Compose commit message in v4.1.1 style. Push to `origin/loose-skip-plan-approval`.

**Files:**
- (commits) `commands/masterplan.md`, `CHANGELOG.md`, 4 manifest files, optionally `docs/internals.md`, run bundle (`docs/masterplan/loose-skip-plan-approval/*`)

**Codex:** no
**Pre-conditions:** T1, T3, T4–T7, T8 (if non-empty), T9 (clean report), T11 (all acceptance commands pass).
**Commit shape:** Two commits — (a) bundle scaffolding (state.yml, spec.md, plan.md, events.jsonl up through T9); (b) the actual feature change + release artifacts (manifests + CHANGELOG + L1360 + optionally internals.md). After T10 + T11 + this commit, append a third commit with the final events.jsonl updates (smoke + acceptance).
**Push gate:** confirm via AskUserQuestion before `git push`. Push is user-visible (publishes the branch).

## Codex eligibility summary

- ok: T4, T5, T6, T7 (mechanical version bumps with verifiable diff)
- no: everything else

## Parallel-group summary

- `verification-pre-commit`: T2 (single member — no actual parallel dispatch, but tagged for consistency with the writing-plans annotation contract; treat as serial)
- `version-bumps`: T4, T5, T6, T7 — write-eligible files; NOT actually parallel-safe per the v2.0.0 contract (parallel-group requires read-only or gitignored writes). **De-tag at execution time** and run serially in fast succession. The annotation is present here as a thematic grouping for the codex eligibility cache; the orchestrator should explicitly NOT dispatch them as a wave.
- `verification-post-commit`: T9, T11 — read-only; safe to parallelize.

## Task order

T1 → T2 → T3 → T4 → T5 → T6 → T7 → T8 → T9 → T10 → T11 → T12

Linear serial execution. The parallel-group annotations are advisory for future plan-shape consistency; this plan's tasks are small and the marginal speedup from waves is < per-wave dispatch overhead.

## Out of scope (do not do as part of this plan)

- L1286 spec_approval gate behavior change.
- New opt-in flag for old behavior.
- Step C per-task gate behavior under loose.
- Codex routing or review changes.
- Adding a retro for this plan to docs/masterplan/loose-skip-plan-approval/retro.md — retro happens at Step R after Step C completion, not authored here.
