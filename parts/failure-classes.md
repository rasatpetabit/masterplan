# Failure classes — `/masterplan` anomaly taxonomy

**Schema version:** 1
**Owner:** Stop hook Section 9 (`hooks/masterplan-telemetry.sh`)
**Issue destination default:** `rasatpetabit/superpowers-masterplan`

This file is the versioned source of truth for which `/masterplan` failure shapes the instrumentation framework knows how to detect, name, and auto-file. The Stop hook reads the detector functions referenced here; the analyzer (`bin/masterplan-failure-analyze.sh`) reads the class IDs to roll up issue streams.

Adding a class is a single-PR-sized change: append an entry below + add the matching shell detector function to Section 9 + extend the smoke fixture (`bin/masterplan-anomaly-smoke.sh`) with a synthetic transcript that triggers it.

## Signature schema

Every auto-filed issue carries a stable signature:

```
sha1( <anomaly_class> "|" <last_step> "|" <verb> "|" <halt_mode> "|" <autonomy> "|" <skill_name|none> )
```

- `anomaly_class` — exact id below.
- `last_step` — `step-0` / `step-a` / `step-b1` / `step-b2` / `step-b3` / `step-c` / `import` / `doctor` / `unknown`. Read from the last `<masterplan-trace step=… phase=in>` breadcrumb in the turn.
- `verb` — `plan` / `next` / `resume` / `status` / `import` / `doctor` / `retro` / `clean` / `unknown`. Read from the last `verb=` breadcrumb token, falling back to the slash-command argv if the breadcrumb is absent.
- `halt_mode` — `none` / `post-brainstorm` / `post-plan`. Read from state.yml; defaults to `none`.
- `autonomy` — `gated` / `loose` / `full`. Read from state.yml; defaults to `loose`.
- `skill_name` — `writing-plans` / `brainstorming` / `subagent-driven-development` / `executing-plans` / `none`. Read from the last `<masterplan-trace skill-invoke|skill-return name=…>` breadcrumb in the turn.

Signature is stable across runs of the same failure shape (same class hitting the same step/verb/config), distinct across shapes. Embedded as `[auto:<sig>]` prefix in the issue title so dedup is grep-able without a custom label scheme. Labels: `auto-filed` + `class/<anomaly_class>`.

## Breadcrumb stream

Detectors depend on the orchestrator emitting structured markers in its assistant-turn output. Patterns (additive — no existing behavior changes):

| Marker | Where emitted |
|---|---|
| `<masterplan-trace step=<X> phase=in verb=<V> halt_mode=<H> autonomy=<A>>` | Entry of every step part (Step 0, A, B1/2/3, C, import, doctor) |
| `<masterplan-trace step=<X> phase=out next=<Y> reason=<R>>` | Exit of every step part |
| `<masterplan-trace skill-invoke name=<N> args=…>` | Just before `Skill` tool invocation for orchestrator-significant skills |
| `<masterplan-trace skill-return name=<N> expected-next-step=<X>>` | First assistant turn after the skill returns |
| `<masterplan-trace gate=fire id=<I> auq-options=<N>>` | Just before `AskUserQuestion` for a planning/execution gate |
| `<masterplan-trace state-write field=<F> from=<A> to=<B>>` | Immediately before any state.yml mutation |

Breadcrumbs are greppable, parseable, and survive context compaction (they live in the visible turn output, not internal reasoning).

## Anomaly classes

### 1. `silent-stop-after-skill`

**Symptom:** Turn ends within ~10s of a `superpowers:writing-plans` / `superpowers:brainstorming` / `superpowers:subagent-driven-development` / `superpowers:executing-plans` skill returning, with no orchestrator output emitted after the skill-return marker and no `state.yml` mutation following.

**Why this matters:** This is Issue #5 Failure 1 — the orchestrator's context drops the resume-after-skill instruction and the turn ends mid-flow.

**Signals:**
- Last `<masterplan-trace skill-return name=…>` marker in turn.
- No subsequent breadcrumb (`step=…`, `state-write`, `gate=fire`) before turn end.
- `state.yml` `phase` value unchanged vs. start of turn (compare against prior turn's telemetry snapshot).

**Detector (pseudo-shell):**
```sh
last_skill_return=$(grep -oE '<masterplan-trace skill-return name=[^>]+>' "$turn_output" | tail -n1)
post_skill_breadcrumbs=$(awk -v anchor="$last_skill_return" 'index($0,anchor){found=1; next} found' "$turn_output" \
  | grep -cE '<masterplan-trace (step|state-write|gate=fire)')
[[ -n "$last_skill_return" && "$post_skill_breadcrumbs" -eq 0 ]] && fire_anomaly silent-stop-after-skill
```

**Signature inputs:** class, last_step (the step active when skill was invoked), verb, halt_mode, autonomy, skill_name (from the skill-return marker).

**Issue body must include:** invocation argv, full last-turn breadcrumb stream, state.yml phase at failure, events.jsonl tail (5 lines), config snapshot.

### 2. `unexpected-halt`

**Symptom:** Turn ends with `state.yml.pending_gate` non-null, but no `AskUserQuestion` was emitted this turn referencing that gate id, AND the configured `halt_mode` + `autonomy` combination says auto-proceed was expected.

**Why this matters:** Issue #5 Failure 2 class — gates promised in state but not delivered to the user, leaving the run wedged.

**Signals:**
- `state.yml.pending_gate.id` non-null at turn end.
- No `<masterplan-trace gate=fire id=<pending_gate.id>>` breadcrumb in this turn.
- Auto-proceed expected: `autonomy=loose` with `halt_mode=none`, OR `autonomy=full` regardless of `halt_mode` for non-blocker gates.

**Detector:**
```sh
pgid=$(yq -r '.pending_gate.id // ""' "$state_yml")
[[ -z "$pgid" ]] && return
fired=$(grep -cE "<masterplan-trace gate=fire id=$pgid>" "$turn_output")
[[ "$fired" -gt 0 ]] && return
auto_expected=$(autonomy_expects_auto_proceed "$autonomy" "$halt_mode" "$pgid")
[[ "$auto_expected" == "yes" ]] && fire_anomaly unexpected-halt
```

**Signature inputs:** class, last_step, verb, halt_mode, autonomy, pending_gate.id (substitutes for skill_name).

### 3. `state-mutation-dropped`

**Symptom:** `state.yml.phase` has a transitional value (`planning`, `executing`, `importing`, `brainstorming`) at turn start AND turn ends without a state-write breadcrumb that would have advanced it AND `pending_gate` is null (so the orchestrator wasn't legitimately parked at a gate).

**Why this matters:** Catches silent state drops — the orchestrator did work but never wrote the result. Resume in next turn finds stale state and re-does the work or stalls.

**Signals:**
- `phase` at turn start ∈ {`planning`, `executing`, `importing`, `brainstorming`} (read from previous turn's telemetry snapshot, or events.jsonl `phase_transition` tail).
- No `<masterplan-trace state-write field=phase from=… to=…>` in this turn.
- `pending_gate` null.
- Turn had ≥1 substantive activity (skill invocation, ≥3 Bash, ≥1 Edit/Write).

**Detector:** see `bin/masterplan-failure-analyze.sh` for the prior-snapshot lookup helper.

### 4. `orphan-pending-gate`

**Symptom:** `state.yml.pending_gate.id` is set after a turn ends, but the turn's transcript contains no `AskUserQuestion` tool_use referencing that gate. The user has no way to respond.

**Why this matters:** The gate was promised structurally but not delivered to the UI. The /loop will spin or the user sees nothing.

**Signals:**
- `state.yml.pending_gate.id` non-null at turn end.
- Transcript scan: no `tool_use` of `AskUserQuestion` in this turn referencing `pending_gate.id` in any option label or question prose.

**Distinction from `unexpected-halt`:** `unexpected-halt` fires when auto-proceed *should* have happened but a gate was raised; `orphan-pending-gate` fires when a gate *should* have been shown but wasn't. Two distinct shapes; both can fire on the same turn if the orchestrator both raised an unexpected gate AND failed to render it.

### 5. `step-trace-gap`

**Symptom:** A `<masterplan-trace step=X phase=in …>` breadcrumb has no matching `<masterplan-trace step=X phase=out …>` breadcrumb within the same turn.

**Why this matters:** The orchestrator entered a step and the turn ended mid-step. Resume in next turn has to infer where the step was when interrupted; often it restarts the step from scratch (wasted work) or skips remaining work (silent regression).

**Signals:**
- Count `step=X phase=in` and `step=X phase=out` markers in turn output.
- Phase-in without matching phase-out for any X → fire.

**Signature includes:** the orphaned `step` value.

### 6. `verification-failure-uncited`

**Symptom:** An events.jsonl record this turn has `event=verify_*` and `result=failed`, but the next turn proceeds as if verification passed (no remediation event recorded, phase advances forward).

**Why this matters:** CD-3 violation captured structurally. The orchestrator declared work complete without acknowledging the verification failure — recurring class of "fix didn't fix" issue.

**Signals:**
- events.jsonl tail: `result=failed` on a `verify_task_N` / `verify_codex_N` / `verify_smoke_N` event in current turn.
- Next turn (or same turn after the failure) advances `phase` forward via state-write breadcrumb OR completes the parent task without a `remediation` event.

**Detection lifecycle:** This class spans two turns. The detector records candidate state in `<plan>-anomaly-candidates.jsonl` on the failure turn; the next turn's hook run confirms or clears.

### 7. `wave_codex_review_skip`

**Symptom:** Doctor check #43 `codex_review_coverage` finds coverage < 100% on a wave-mode bundle where the run was not inside a Codex host.

**Why this matters:** Addresses F2 finding in the codex-routing-fix bundle.

**Signals:**
- Detector reference: doctor check #43 `codex_review_coverage` (added in T1 of the codex-routing-fix bundle; see `parts/doctor.md`).
- Severity: `WARN`.
- Suggested remediation: re-run wave-end review with Codex, OR accept-and-document if wave members are themselves Codex-produced (asymmetric review rule).

**Detector:** `parts/doctor.md` check #43 reports Codex review coverage below 100% for a wave-mode bundle.

**Signature inputs:** class, last_step, verb, halt_mode, autonomy, review coverage percentage.

### 8. `subagent_return_oversized`

**Symptom:** A per-subagent JSONL record reports `subagent_return_bytes > 5120`.

**Why this matters:** Addresses F4 finding (no instrumentation for subagent context impact).

**Signals:**
- Detector reference: `subagent_return_bytes` field in `hooks/masterplan-telemetry.sh` per-subagent JSONL records (added in T2 of the codex-routing-fix bundle).
- Severity: `WARN`.
- Threshold: `5120` bytes (the v3.3.0 WORKLOG-regression threshold).
- Suggested remediation: tighten the dispatch brief's return shape (require digest-only, specify max bytes, list forbidden inclusions); revisit subagent type selection if the subagent is summarizing too much.

**Detector:** Compare each per-subagent JSONL record's `subagent_return_bytes` value against the explicit `5120` byte threshold.

**Signature inputs:** class, last_step, verb, halt_mode, autonomy, subagent name.

### 9. `eligibility_cache_event_missing`

**Symptom:** Step C entry `events.jsonl` is missing the v2.4.0+ MANDATORY `eligibility_cache` event (per `parts/step-c.md:96`).

**Why this matters:** Addresses F3 finding (mandatory event vs wave-pin contradiction).

**Signals:**
- Detector reference: future event-presence check OR doctor check #43 sibling (TBD; detector wiring is part of a follow-up bundle, not this one).
- Severity: `WARN`.
- Suggested remediation: re-emit the mandatory event before next dispatch; audit the wave-pin short-circuit at `parts/step-c.md:87` (addressed for new runs by T4/A3 in this bundle).

**Detector:** TBD follow-up event-presence check scans Step C entry `events.jsonl` for the mandatory `eligibility_cache` event.

**Signature inputs:** class, last_step, verb, halt_mode, autonomy, Step C entry event stream.

### 10. `dispatch_brief_unregistered`

**Symptom:** The self-host audit encounters a lifecycle dispatch site in `parts/step-c.md` or `parts/doctor.md` that lacks a `contract_id` reference into `commands/masterplan-contracts.md`.

**Why this matters:** Addresses F6 finding (4 contracts registered vs many freeform dispatch sites).

**Signals:**
- Detector reference: `bin/masterplan-self-host-audit.sh --brief-style` (strengthened in T8/B4 of the codex-routing-fix bundle).
- Severity: `WARN`.
- Suggested remediation: register the brief shape as a new contract in `commands/masterplan-contracts.md`; cite the new `contract_id` at the dispatch site.

**Detector:** `bin/masterplan-self-host-audit.sh --brief-style` scans lifecycle dispatch sites for a `contract_id` reference that resolves into `commands/masterplan-contracts.md`.

**Signature inputs:** class, last_step, verb, halt_mode, autonomy, dispatch site path.

## Detector framework defenses

The detectors themselves MUST NOT silently fail. Three defenses per the framework design:

1. **Hook-internal error log.** Each detector function in Section 9 runs inside a `set +e` block wrapped by `trap`. Any non-zero exit from a detector is logged to `~/.claude/projects/-home-ras-dev-superpowers-masterplan/hook-errors.log` with the failing detector name, the slug, and stderr capture. Per-turn telemetry continues regardless.

2. **Local-first persistence.** Anomaly records land in `<plan>-anomalies.jsonl` (inside the bundle directory) BEFORE any `gh` call. The local file is canonical; GitHub is a mirror. `gh` failure (rate limit, auth lapse, network) writes the record to `<plan>-anomalies-pending-upload.jsonl` for later flushing via `bin/masterplan-anomaly-flush.sh`.

3. **Smoke fixture parity.** `bin/masterplan-anomaly-smoke.sh` feeds a synthetic transcript per class through the hook in dry-run + live modes. Run before every plugin release. Assertions: 6 unique signatures, dedup pair produces 1 issue + 1 comment, regression pair reopens prior issue, idempotent on re-run.

## Adding a new class

When the analyzer flags an issue cluster that doesn't fit the 6 classes above:

1. Append a new section to this file in the same shape (Symptom / Why / Signals / Detector / Signature inputs).
2. Add the matching shell detector function to `hooks/masterplan-telemetry.sh` Section 9 — name it `detect_<class_id>()`, register it in the detector dispatch loop.
3. Extend `bin/masterplan-anomaly-smoke.sh` with a synthetic transcript that triggers it; assert the new signature is emitted.
4. Document the class in `docs/internals.md` § "Failure instrumentation framework".
5. Bump the schema_version at the top of this file when the class set changes (analyzers gate on schema_version for snapshot compatibility).

Never silently merge a class without smoke coverage — the framework is the safety net; gaps in the net are unobserved by definition.
