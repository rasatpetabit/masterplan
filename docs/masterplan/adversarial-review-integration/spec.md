# Adversarial-Review Integration — Spec

## Intent Anchor

**Mode:** feature-implementation
**Repo role:** Claude Code plugin — prompt-only orchestrator. The "program" is markdown. No runtime code; changes are edits to `.md` files.
**Verification ceiling:** `grep` discriminators + `bash -n` syntax check + manual smoke invocation only. No test suite.
**Scope boundary:** `commands/masterplan.md`, `parts/step-b.md`, `parts/step-c-dispatch.md` (for config schema reference), `parts/contracts/plan-annotations.md`, `parts/doctor.md`, `docs/config-schema.md`, `CHANGELOG.md`. No changes to upstream skills or the codex plugin.

---

## Problem

masterplan's B2 (spec gate) and B3 (plan gate) invoke writing-plans and then proceed to execution. There is no challenge phase — assumptions in the spec or design flaws in the plan go uncontested before code runs. This is the cheapest point to catch structural problems.

`codex:adversarial-review` is an existing tool (plugin at `openai-codex/plugins/codex`) that runs a Codex review challenging approach, design choices, tradeoffs, and assumptions. It is review-only (no patches). It is currently only available as a manual slash command (`/codex:adversarial-review`).

The goal is to dispatch adversarial-review automatically at the spec and plan gates as part of the normal masterplan workflow.

---

## Goals

1. At B2 (spec_approval), automatically run adversarial-review against `spec.md` before the gate AUQ fires. Surface findings if any.
2. At B3 (plan_approval), automatically run adversarial-review against `plan.md` before the gate AUQ fires. Surface findings if any.
3. Under `aggressive-loose` autonomy, a passing review auto-closes the gate (no AUQ). A failing review fires an AUQ with findings.
4. Under `loose` autonomy, always fire the gate AUQ, but include review findings in the question context when findings exist.
5. Users can opt out globally (`adversarial_review: off`) or selectively (`adversarial_review: spec|plan|both`) in `.masterplan.yaml`. Default: `both`. CLI flag `--no-adversarial-review` overrides for one run.
6. Spec gate (B2): run foreground (`--wait`), file is small.
7. Plan gate (B3): run background (close turn, resume on wakeup), plan files are large.
8. Two new doctor checks: config validity (#42) and gate-fire audit (#43).

---

## Non-Goals

- Do not modify the adversarial-review command or codex-companion.mjs.
- Do not run adversarial-review during Step C task execution (per-task review is already handled by Codex review gate 4b).
- Do not add adversarial-review to the doctor verb or import flows.

---

## Design Decisions

### Invocation method

Direct Bash call to `codex-companion.mjs`. No new coordinator wrapper.

Path discovery order (inline in the step, before calling):
1. `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs`
2. `~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` (glob, pick highest semver)

If neither path exists: log `adversarial_review_skipped` (companion not found), proceed to gate normally (never block the workflow over review infra absence).

Foreground invocation:
```bash
node "<companion-path>" adversarial-review --scope working-tree --wait "focus on <artifact-relative-path>"
```

Background invocation (plan gate):
```bash
node "<companion-path>" adversarial-review --scope working-tree --background "focus on <artifact-relative-path>"
```

The `--scope working-tree` keeps the review to changed files. The `focus on <path>` hint steers Codex toward the relevant artifact without preventing it from seeing any context it needs.

### Gate integration in step-b.md

**B2 (spec_approval) flow** (after spec.md is written, before the gate AUQ):

1. Check if adversarial review is enabled for spec gate: `config.adversarial_review ∈ {both, spec}` AND `--no-adversarial-review` not set.
2. If enabled: locate companion, run foreground adversarial-review against `spec.md`. Append event `adversarial_review_started` with `gate: spec_approval`.
3. Parse output: if output contains `PASS` or no findings of severity `high`/`critical` → `review_result: pass`. Otherwise → `review_result: fail` with `findings: <output>`.
4. Append event `adversarial_review_complete` with `gate: spec_approval, result: pass|fail, findings_chars: N`.
5. If `autonomy == aggressive-loose` AND `review_result == pass`: skip the spec_approval AUQ, append `spec_approval_auto_accepted` → CLOSE-TURN (auto-proceed to B2 plan writing).
6. Otherwise: fire spec_approval AUQ, adding a fifth option when `review_result == fail`: "View adversarial-review findings and decide" (shows findings in preview).

**B3 (plan_approval) flow** (after plan.md is written, before the close-out gate AUQ):

1. Same enable check for plan gate: `config.adversarial_review ∈ {both, plan}`.
2. If enabled: locate companion, launch background adversarial-review against `plan.md`.
3. Persist `pending_gate: {id: adversarial_review_plan_pending}`, append `adversarial_review_started` with `gate: plan_approval`.
4. Schedule wakeup if available (`ScheduleWakeup`), or surface AUQ ("Adversarial review running in background…", options: [Poll now / Resume later when done]).
5. On resume: check if background review completed. If complete, parse output same as B2. Then proceed to plan_approval gate with findings context if any.
6. If `autonomy == aggressive-loose` AND `review_result == pass`: auto-close plan_approval.

### Pass/fail heuristic

The adversarial-review output is returned verbatim from Codex. "Pass" is defined as: no lines matching `/\b(critical|fatal|serious|blocking|fundamental|wrong assumption)\b/i` in the output. "Fail" otherwise. This is a liberal threshold — adversarial reviews often note concerns; only flag things as blocking when Codex explicitly calls them critical.

### Config schema additions (docs/config-schema.md)

```yaml
adversarial_review: both   # off | spec | plan | both. Default: both.
```

### CLI flag

`--no-adversarial-review` — disables adversarial review for one run regardless of config. Documented in step-0.md recognized flags table.

### Doctor checks

**Check #44 — adversarial_review config valid:**
- Severity: warn
- Check: if `adversarial_review` field is present in any config tier, it must be `off|spec|plan|both`.
- Fix available: no (invalid value must be corrected by user).

**Check #45 — adversarial review gate-fire audit:**
- Severity: info (skipped for bundles with < 2 events)
- Check: for bundles where `config.adversarial_review != off` AND `status: complete`, verify `events.jsonl` contains at least one `adversarial_review_complete` event with `gate: spec_approval` and one with `gate: plan_approval`. If missing, emit: "Bundle <slug>: adversarial-review gate-fire not found in events.jsonl — may have been skipped or run before integration."
- Fix available: no (historical; informational only).

---

## Files to Change

| File | Change |
|---|---|
| `commands/masterplan.md` | Add `--no-adversarial-review` to recognized flags table (Step 0) |
| `parts/step-b.md` | Add adversarial-review dispatch block before B2 spec_approval gate; add dispatch + background-wait block before B3 plan_approval gate; add B3 resume logic |
| `docs/config-schema.md` | Add `adversarial_review` field with allowed values, default, description |
| `parts/doctor.md` | Add checks #42 and #43 |
| `CHANGELOG.md` | Add v6.1.0 entry |

---

## Acceptance Criteria

1. `/masterplan full <topic>` on a high-complexity bundle invokes adversarial-review at B2 and B3 gates (verifiable via `events.jsonl` showing `adversarial_review_complete` events).
2. `adversarial_review: off` in `.masterplan.yaml` suppresses both reviews — no `adversarial_review_started` events.
3. `adversarial_review: spec` runs review only at B2; plan gate proceeds normally.
4. `--no-adversarial-review` CLI flag suppresses review for one run without changing config.
5. Under `aggressive-loose` autonomy, a passing review auto-closes spec_approval (no AUQ fired).
6. A failing review fires an AUQ with findings in the option context.
7. Plan gate review runs in background (turn closes, wakeup scheduled).
8. `grep "adversarial_review" docs/masterplan/<slug>/events.jsonl` returns entries after a run with review enabled.
9. `/masterplan doctor` check #44 catches invalid `adversarial_review: sideways` config value (warns).
10. `bash -n hooks/masterplan-telemetry.sh` passes (no syntax error from changes).

---

## Verification

```bash
# Positive discriminator — step-b.md has adversarial-review dispatch
grep -n "adversarial.review" parts/step-b.md | grep -c "companion\|codex-companion"

# CLI flag registered
grep -n "no-adversarial-review" commands/masterplan.md

# Config schema documents the field
grep "adversarial_review" docs/config-schema.md

# Doctor checks are present
grep -n "#44\|#45" parts/doctor.md

# CHANGELOG updated
grep "adversarial.review" CHANGELOG.md

# Syntax check (no-op for markdown but validates hook)
bash -n hooks/masterplan-telemetry.sh
```
