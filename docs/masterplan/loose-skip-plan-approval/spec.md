# Spec: loose autonomy auto-approves plan_approval gate

## Goal

Under `--autonomy=loose`, Step B3's `plan_approval` close-out gate should auto-approve and proceed silently to Step C. The gate fires only under `--autonomy=gated`. The Step B1 `spec_approval` gate is **unchanged** — it still halts under loose. End result: a full kickoff under loose halts once (spec_approval), not twice.

## Context

Diagnostic on 2026-05-13 (session `2be1cd7e-f4ad-49e3-8cfd-4ab168d58328`) established:

1. `~/.masterplan.yaml: autonomy: loose` IS honored at config-load time. Survey of 10 most recently modified `state.yml` files across `~/dev/` shows 9 of 10 persisted `autonomy: loose`; the YAML→state.yml flow is correct.
2. `commands/masterplan.md` L1286 (spec_approval) and L1360 (plan_approval) both gate on `--autonomy != full`, **ignoring `halt_mode`**. Under the `full` verb (`halt_mode = none`) with loose autonomy, kickoff halts twice during B1→B3.
3. The user-global `~/.claude/CLAUDE.md` "Masterplan loose-autonomy contract" expects only (a) blocker re-engagement, (b) B0/B1/B2 user-question close-out gates **per halt_mode**, and (c) verification gates to fire under loose. Current spec violates this for spec_approval + plan_approval since they fire regardless of `halt_mode`.
4. Primary evidence: `docs/masterplan/p4-suppression-fix/events.jsonl` contains both `halt_gate_post_brainstorm` AND `halt_gate_post_plan` events despite `state.yml: autonomy: loose, halt_mode: none`.

The user explicitly chose a conservative middle ground: keep `spec_approval` under loose (correcting a wrong spec is cheap; cheap halt is worth keeping), drop `plan_approval` under loose (largely redundant after spec_approval, costs an extra round-trip).

## In scope

- **Edit `commands/masterplan.md` L1360**: change the `plan_approval` condition from `if --autonomy != full` to `if --autonomy == gated`. Under loose AND full → auto-approve, clear `pending_gate`, append `gate_closed` (or skip event if no gate was opened), proceed to Step C silently. Under gated → halt as today.
- **Sync targets** (per project CLAUDE.md anti-pattern #4 — verb/halt_mode/gate behavior changes need cross-doc consistency):
  - `README.md` — autonomy section, if it documents plan_approval gate behavior
  - `CHANGELOG.md` — new `v4.2.0` entry: behavior change + one-line migration note
  - `docs/internals.md` — autonomy / gate behavior subsection, if present
- **Version bump to v4.2.0** in all four manifest files:
  - `.claude-plugin/plugin.json`
  - `.codex-plugin/plugin.json`
  - `.claude-plugin/marketplace.json`
  - `.agents/plugins/marketplace.json`
- **Manual smoke validation**: run `/masterplan full <small-topic>` in a throwaway repo (or in `~/dev/sandbox` if one exists) under loose autonomy; confirm exactly one `gate_opened` for `spec_approval` and zero for `plan_approval`. Capture the events.jsonl excerpt in this bundle's events.jsonl.
- **Fresh-eyes verification** (per project CLAUDE.md anti-pattern #5): dispatch a Haiku Explore subagent after the edit to read commands/masterplan.md end-to-end for any contradictions or dangling references to the old condition.

## Out of scope

- **L1286 `spec_approval` gate behavior** — user chose to keep it firing under loose for design-direction-correction safety.
- **New opt-in flag for old behavior** (e.g., `--autonomy=loose-with-kickoff-approvals`) — explicitly rejected to avoid config surface bloat. Users who want both kickoff halts switch to `--autonomy=gated` (release note will mention this).
- **Step C per-task gate behavior under loose** — separate concern, documented elsewhere; not touched here.
- **Codex routing / review behavior** — orthogonal axis; unchanged.

## Open questions

- *(Decided.)* Should the v4.2.0 release note suggest users who relied on the plan_approval halt switch to `--autonomy=gated` for full kickoffs? **Yes**, mention in CHANGELOG migration note.
- *(Decided.)* Schema version of new `state.yml`? **Use `schema_version: 2`** to match recent in-repo bundles (e.g., p4-suppression-fix); the lazy v2→v3 migration in Step Resume-Guard step 0 will hydrate v3 fields on first write if/when needed.

## Acceptance criteria

1. `grep -nE 'id: plan_approval' commands/masterplan.md` shows the gate guarded by `autonomy == gated`, not `autonomy != full`.
2. The behavior wording in L1360 explicitly says: "under `--autonomy in {loose, full}`: auto-approve, clear `pending_gate`, proceed to Step C silently. Under `--autonomy == gated`: persist `pending_gate` and surface AskUserQuestion."
3. Manual smoke in a throwaway repo: `/masterplan full <topic>` under loose autonomy produces exactly ONE AskUserQuestion gate during kickoff (the spec_approval one). The smoke run's events.jsonl shows `halt_gate_post_brainstorm` but NOT `halt_gate_post_plan`.
4. `CHANGELOG.md` has a v4.2.0 entry describing the behavior change + recommending `--autonomy=gated` for users who want both kickoff halts.
5. Version is `4.2.0` in all four plugin/marketplace JSON files.
6. README autonomy section (if it documents `plan_approval`) reflects new behavior.
7. Haiku fresh-eyes Explore subagent report shows no dangling references to the old condition text and no internal contradictions introduced.

## Verification commands

- `grep -nE 'autonomy.*(gated|loose|full)' commands/masterplan.md` — should show the new condition wording around L1360.
- `bash -n hooks/masterplan-telemetry.sh` — sanity (unrelated to this change but cheap).
- `git grep -nE '--autonomy != full' commands/ docs/ README.md` — should return 0 hits for the plan_approval site; any remaining hit must be the still-firing spec_approval gate at L1286 (verify that's the only match).
- `cat .claude-plugin/plugin.json | grep version` → `"version": "4.2.0"`.

## Risks + mitigations

- **R1: behavior change silently surprises existing loose-autonomy users who relied on the plan_approval halt for last-look-before-execute.** → Mitigate by CHANGELOG migration note + suggestion to use `--autonomy=gated` for full kickoff approvals.
- **R2: editing the orchestrator's own gate behavior while running under loose autonomy means this very plan will halt at plan_approval (under current spec).** → That's fine — the halt is by design under v4.1.1; v4.2.0 ships the new behavior. We're eating our own dog food once.
- **R3: drift between L1286 (still halts) and L1360 (no longer halts) under loose creates an asymmetry users may not expect.** → CHANGELOG explicitly documents the asymmetry + rationale. Future work could revisit L1286, but not in this plan.
