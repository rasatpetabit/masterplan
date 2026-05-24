# Failure-instrumentation framework

## Failure-instrumentation framework (v5.1.0+)

The Stop hook's Section 9 detects orchestrator anomalies at end-of-turn and files
GitHub issues per occurrence against `rasatpetabit/superpowers-masterplan` (or a
configured override). The framework is the response to "you ship random fixes
without data" — failures become structured records first, and fixes are designed
from the accumulated record.

**Taxonomy (versioned in `parts/failure-classes.md`).** Six initial classes:

| Class | Trigger |
|:------|:--------|
| `silent-stop-after-skill` | A `<masterplan-trace skill-return …>` breadcrumb fires but no subsequent step/state-write/gate breadcrumb appears before turn end. |
| `unexpected-halt` | `state.yml#pending_gate.id` is set but the matching `<masterplan-trace gate=fire id=…>` did not emit AND autonomy/halt configuration says auto-proceed was expected. |
| `state-mutation-dropped` | `phase ∈ {planning, executing, importing, brainstorming}`, substantive turn (skill-invoke or completed tasks), but no `state-write field=phase` breadcrumb and no `pending_gate`. |
| `orphan-pending-gate` | `pending_gate.id` set; no `AskUserQuestion` tool_use in transcript tail. |
| `step-trace-gap` | `step=X phase=in` emitted but no matching `step=X phase=out` before turn end. |
| `verification-failure-uncited` | `events.jsonl` tail has `verify_*` with `result: failed` AND the same turn wrote a phase-forward without remediation. |
| `wave_codex_review_skip` | Doctor check #43 finds Codex review coverage < 100% on a wave-mode bundle not running inside Codex host. |
| `subagent_return_oversized` | A per-subagent JSONL record reports `subagent_return_bytes > 5120`. |
| `eligibility_cache_event_missing` | Step C entry `events.jsonl` lacks the mandatory `eligibility_cache` event (v2.4.0+). |
| `dispatch_brief_unregistered` | A lifecycle dispatch site in the step-c or doctor parts lacks a `contract_id` reference into `commands/masterplan-contracts.md`. |
| `wave-barrier-interrupted` | At resume time, `tasks[*].status == "in_flight"` AND `background: null` AND no completion event in `events.jsonl` for those task indices — session died mid-wave while the blocking wave-completion barrier waited. |

**Breadcrumb stream.** The orchestrator emits structured markers in its visible
output (in `parts/step-0.md` through `parts/step-c-completion.md` + `parts/import.md` +
`parts/doctor.md`) at step boundaries, skill invocations, gate fires, and state
writes:

```
<masterplan-trace step=b2 phase=in verb=plan halt_mode=post-plan autonomy=loose>
<masterplan-trace step=b2 phase=out next=b3 reason=success>
<masterplan-trace skill-invoke name=writing-plans args=spec=<path>>
<masterplan-trace skill-return name=writing-plans expected-next-step=b2-re-engagement>
<masterplan-trace gate=fire id=plan_closeout auq-options=4>
<masterplan-trace state-write field=phase from=planning to=plan_gate>
```

These are additive — no existing behavior changes. They survive context
compaction (visible turn output, not internal reasoning) and are the input
substrate for every detector.

**Signature semantics.** Each detection computes a stable SHA1 over
`<class>|<step>|<verb>|<halt_mode>|<autonomy>|<skill_or_gate>`. The first 12
hex chars get embedded in the issue title prefix `[auto:<sig12>]`, so dedup
queries are plain `gh issue list --search "in:title [auto:<sig12>]"` — no
custom label scheme needed. Same shape → same signature; different inputs →
different signatures.

**Dedup, recurrence, regression.**

1. **No match** → create a new issue with labels `auto-filed` + `class/<class>`.
2. **Match exists and open** → comment with the new record (recurrence log).
3. **Match exists and closed** → reopen with a regression comment. This is the
   single most important signal: the analyzer's recurrence-after-fix histogram
   says whether earlier fixes actually held.

**Local-first persistence.** The canonical record lives in
`<run-dir>/anomalies.jsonl` (always written, gh failures never lose data). On
any `gh` failure (rate limit, auth lapse, network), the record is duplicated
to `<run-dir>/anomalies-pending-upload.jsonl` and drained later by
`bin/masterplan-anomaly-flush.sh`. The local file is the source of truth;
GitHub is a mirror.

**Configuration (`.masterplan.yaml`).** All three knobs default to safe values
when the file is absent.

```yaml
failure_reporting:
  repo: rasatpetabit/superpowers-masterplan
  enabled: true
  dry_run: false           # true → write local records, skip gh
```

**Analyzer recipes (`bin/masterplan-failure-analyze.sh`).** Queries GitHub for
all `auto-filed`-labeled issues, parses signatures from titles, computes:

- Frequency table by class
- Recurrence-after-fix histogram (which fixes broke their own coverage)
- Open-time-to-close median per class
- Per-verb / per-step breakdown
- Same-day co-occurrence pairs (suggests shared root cause)

Output: markdown to stdout AND a dated snapshot at
`docs/failure-analysis/<YYYY-MM-DD>.md`. Diff between snapshots tracks whether
the system is improving over time.

**Smoke test (`bin/masterplan-anomaly-smoke.sh`).** Synthetic transcripts +
mocked `gh` exercise all six classes, dedup, regression-reopen, dry-run mode.
Eleven assertions; must pass before every plugin release. Run-isolated via
`$HOME=$tmp/fake-home` and `PATH=$tmp/fake-bin:$PATH` so it never touches the
real Claude Code session log or real GitHub.

**Defenses against silent framework failure.** Per-detector exceptions are
trapped via `set +e` shells and logged to
`~/.claude/projects/<slugified-worktree>/hook-errors.log` (where
`<slugified-worktree>` is the active repo's absolute path with `/` replaced
by `-`, matching Claude Code's transcript storage encoding) —
the rest of the telemetry path is unaffected. Section 9 is additive: removing
it leaves the original telemetry hook untouched.

**Doctor check #38** (`anomaly-file-has-records-since-last-archive`) surfaces
a warning when `<run-dir>/anomalies.jsonl` or `anomalies-pending-upload.jsonl`
contains records, so users get a periodic nudge to run the analyzer or flush
pending uploads. Report-only.

## Policy-regression watcher (v5.2.0+)

A second instrumentation lane sits beside the failure-instrumentation framework.
Where Section 9 catches *orchestrator anomalies at end-of-turn*, the
policy-regression watcher catches *plan-level policy compliance drift over time*
— the class of regression that caused 24h of silent codex degradation to ship
unnoticed pre-v5.1.1.

Implementation is additive to the existing recurring-audit cron path. The
detectors live in `lib/masterplan_session_audit.py`, alongside the other
audit categories. The dispatcher (`bin/masterplan-findings-to-issues.sh`) is
called from the tail of `bin/masterplan-recurring-audit.sh` after the audit
JSON + table writes complete.

**Fifteen detector categories.** Each emits a `WarningItem` with a stable
`code` snake_case slug and a citation back to the policy source line. Hard
(file a GH issue): ten categories. Soft (local-only): five categories. The
hard list is hard-coded into `POLICY_REGRESSION_HARD_CODES` in the audit
module and mirrored in the dispatcher's `hard_codes_csv` — drift here
silently skips dispatch.

| Code | Severity | Detects | Policy citation |
|:-----|:---------|:--------|:----------------|
| `codex_annotation_gap_on_high` | hard | `complexity: high` plan with task headings but fewer `**Codex:**` annotations than tasks | `parts/step-b.md:324` |
| `codex_parallel_group_missing_on_high` | soft | `complexity: high` plan with zero `**parallel-group:**` annotations | `parts/step-b.md:324` |
| `codex_routing_configured_but_zero_dispatches` | hard | `codex_routing` is auto/manual on a complete plan with zero codex-route events in `events.jsonl` | `parts/step-c-dispatch.md` (Codex routing section) |
| `codex_review_configured_but_zero_invocations` | hard | `codex_review: on` on a complete plan with zero codex-review events | `parts/step-c-dispatch.md` (Codex review section) |
| `missing_codex_ping_event` | hard | Plan has ≥3 events but no `codex_ping` record (Step 0 should emit one per session) | `parts/step-0.md:106` |
| `silent_codex_degradation` | hard | `complexity: high` substantive plan with `codex_routing=off` AND `codex_review=off` AND healthy `~/.codex/auth.json` AND no `codex degraded` event AND empty `last_warning` | `parts/step-0.md:119` |
| `pending_gate_orphaned` | soft | `pending_gate` set, `last_activity` >24h stale, phase not in {blocked, critical_error} | Step C 0e pending-gate resume |
| `cc3_trampoline_skipped_after_subagents` | hard | Claude turn dispatched `Agent(...)` but emitted no plain-text summary in the same turn | `commands/masterplan.md` CC-3-trampoline |
| `cd3_verification_missing_on_complete` | hard | `phase: complete` with zero `verify_*`/`test`/`lint`/`verification` events in `events.jsonl` | CD-3 (`parts/contracts/cd-rules.md`) |
| `cd9_free_text_question_at_close` | soft | Assistant turn ended with `?` and no `AskUserQuestion` tool_use; `<no-auq>`/`[oneshot]` markers absent | CD-9 |
| `auq_guard_blocked_count_high` | soft | The AUQ Stop hook (`~/.claude/hooks/auq-guard.sh`) emitted `AUQ guard blocked: …` ≥5 times in one session | `~/.claude/CLAUDE.md` AUQ rule |
| `brainstorm_anchor_missing_before_planning` | hard | `phase: planning` reached with no `brainstorm_anchor_resolved` event preceding the transition | `parts/step-b.md:232` |
| `wave_dispatched_without_pin` | hard | `wave_dispatch` event fired without a preceding `cache_pinned_for_wave=true` event | `parts/step-c-dispatch.md` (M-2 wave assembly) |
| `complexity_unset_fallthrough` | soft | `complexity: medium` AND `complexity_source: default` (planner skill never re-classified) | `parts/step-b.md:365` |
| `parallel_eligible_but_serial_dispatched` | hard | Plan has ≥2 tasks in the same `**parallel-group:**` AND two `wave_dispatch` events for that group are separated by ≥3 unrelated events (serial-in-parallel) | `parts/step-c-dispatch.md` (Slice α wave assembly) |

The Claude-side detectors (CC-3, CD-9, AUQ guard) operate on transcript turns
collected by the regular audit pass; the plan-side detectors operate on
`state.yml`, `plan.md`, and `events.jsonl` per run bundle. Both lanes flow
into the same `findings.jsonl` stream.

**Dispatcher (`bin/masterplan-findings-to-issues.sh`).** Mirrors the
v5.1.0 anomaly-flush pattern but reads global `findings.jsonl` instead of
per-bundle `anomalies.jsonl`:

1. Drains `findings-pending-upload.jsonl` first (retry queue).
2. Walks new findings since `findings-last-run-id.txt` sentinel.
3. For each hard-threshold finding: computes
   `sha1(code|repo|session)[:12]`, searches GH for a matching `[auto:<sig>]`
   title prefix, files / comments / reopens accordingly. Labels:
   `auto-filed` + `class/policy-regression` + `class/<code>`.
4. On gh failure: row carries forward in
   `findings-pending-upload.jsonl`. Sentinel advances only when the run
   finishes failure-free.
5. Honors `.masterplan.yaml failure_reporting.{repo, enabled, dry_run}` —
   identical knobs to the v5.1.0 framework.

**Wipe-breadcrumb gate.** Plan-source findings whose `state.yml` carries an
`events_wiped:` block (set by `bin/masterplan-wipe-telemetry.sh` during the
pre-v5.1.1 cleanup) are skipped by default — they pre-date the visibility
surfaces and would flood the tracker with historical noise. Override via
`--no-skip-wiped`. Orphan slugs whose plan dir is no longer on disk are
skipped on the same grounds (defensive).

**Backfill controls.** `--since-run-id RUN_ID` starts processing from a
specific run; `--all` ignores the sentinel; `--limit N` caps dispatches per
invocation (used during initial rollouts to avoid creating dozens of issues
in one cron tick). `--dry-run` honors the same path but skips gh and leaves
the sentinel unchanged. The cron path passes nothing — full apply, sentinel-
tracked.

**Skip flag.** `MASTERPLAN_AUDIT_SKIP_FINDINGS_DISPATCH=1` in the environment
suppresses the dispatcher call from the recurring-audit tail, used by CI
fixture tests that should not file real issues.

**Smoke test (`bin/masterplan-policy-regression-smoke.sh`).** Twelve
synthetic plan-side fixtures (one per detector) + one negative-control clean
plan + eight dispatcher scenarios (eligibility, soft-skip, wipe-skip,
orphan-skip, sentinel advance, open-issue comment, closed-issue reopen,
gh-failure pending replay, dry-run, `--no-skip-wiped`). PATH-stubs `gh`,
isolates `$HOME` under `mktemp`, runs `lib/masterplan_session_audit.py`
directly against the fixtures. 44 assertions; must pass before every release.

## Hook portability notes

- Linux smoke-tested. macOS portable-by-construction (uses `head -n1` instead of GNU `find -quit`; uses `stat -c '%Y' || stat -f '%m'` dual form instead of GNU `find -printf`). Not smoke-tested on macOS.
- Hook bails silently if `jq` is not installed (presence check at startup).
- Defensive bail: hook exits 0 in any session not on a /masterplan-managed plan branch (matches branch frontmatter).
- Failure-instrumentation framework requires `gh` for issue filing; without it, local `anomalies.jsonl` writes succeed and the pending-upload queue grows until `bin/masterplan-anomaly-flush.sh` is run.
