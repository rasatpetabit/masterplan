# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.2.3] — 2026-05-15 — Auto-retro backfill + Codex JWT cosmetic-expiry fix

Two coupled refinements that close known gaps in v5.2.x: (1) auto-retro becomes durable even when Step C 6 is bypassed, and (2) the Step 0 boot banner and doctor Check #39 stop emitting false "Codex: degraded" warnings when ChatGPT-mode auth is healthy.

### Fixed

- **Codex auth cosmetic-expiry false positive.** Step 3 of CC-2 (boot banner in `commands/masterplan.md`), doctor Check #39 (`codex_auth_expiry`), and Check #41's `auth_healthy` probe now skip sub-conditions (a)/(b) — token-expired and token-expires-within-24h — when `auth_mode == "chatgpt"` AND `tokens.refresh_token` is non-empty AND `last_refresh` is within the last 7 days. ChatGPT mode uses short-lived JWTs that auto-refresh on every codex call via the persistent refresh token; `id_token.exp` being minutes-to-hours past `now` is the normal steady state, not degradation. Sub-condition (c) — `last_refresh > 30d` — still fires, since a stale refresh_token IS a real degradation signal. Check #39 emits an INFO-style PASS line: `Check #39: PASS (auth_mode=chatgpt; JWT auto-refresh healthy; last_refresh Nd ago)`. Boot banner is silent under this shape.
- **`~/.codex/auth.json` JSON-path bug at three sites.** `commands/masterplan.md` Step 3, `parts/doctor.md` Check #39, and Check #41's `auth_healthy` probe were reading `jq -r ".id_token"` / `".access_token"` (top-level) — but the schema_v3+ shape of `~/.codex/auth.json` nests tokens under `.tokens.*`. All three now read `jq -r ".tokens.<field> // .<field> // empty"` for forward/backward schema-compat. The Read-tool-driven LLM interpretation in the boot banner compensated for the bug at runtime; the bash sites broke silently against the real schema.

### Added

- **Auto-retro backfill in Step 0 resume controller.** `parts/step-0.md` resume controller item 4 now invokes Step R inline as a backfill on any `/masterplan` touch of a `status: complete` (or `pending_retro`) bundle missing `retro.md`, provided `schema_version >= 3` and `retro_policy.waived/exempt != true`. Catches the paths where Step C 6 is bypassed entirely — manual `state.yml` edits flipping `status: complete`, brainstorm-only completions under `halt_mode=post-brainstorm`, or first-attempt retro failures that left `status: pending_retro`. Makes auto-retro durable by default, mirroring the in-flight 6a-guard.
- **`retro_policy.exempt` field.** Marks a bundle as deliberately retro-less (e.g., the `p4-suppression-smoke` hand-crafted fixture); bypasses both the resume-controller backfill and Doctor #28's `--fix` `AskUserQuestion`.
- **`bin/masterplan-state.sh` auto-heal shim.** `transition-guard` normalizes the typo'd `status: retro_pending` (one outlier bundle in the corpus from an earlier writer) to the canonical `status: pending_retro` on read, rewriting `state.yml` on disk.

### Removed

- **`codex_health_check_jwt_only` watcher** in `lib/masterplan_session_audit.py` — retired after serving its purpose. The watcher (added v5.2.1) flagged the false-positive class; the proper fix is now landed in v5.2.3, so the watcher is no longer load-bearing. The user-visible boot banner IS the regression detector going forward — if the false positive returns, it returns visibly on every `/masterplan` invocation. Also removed from `bin/masterplan-findings-to-issues.sh` hard-codes CSV.

### Documentation

- **`docs/internals.md` §4 Run bundle format** documents the auto-retro backfill clause and `retro_policy.exempt` field.
- **`docs/internals.md` Codex-routing visibility section** documents the v5.2.3 cosmetic-expiry refinement and the watcher retirement.
- **`parts/step-c.md` 6b** cross-references the resume controller as the catch-all for paths that reach `status: complete` without entering Step C 6.

### Verification

- Check #39 bash extracted and run against live `~/.codex/auth.json` (auth_mode=chatgpt, last_refresh=2026-05-15T16:41:36Z): returned `Check #39: PASS (auth_mode=chatgpt; JWT auto-refresh healthy; last_refresh 0d ago)`.
- Check #41 `auth_healthy` probe: sets `auth_healthy=1` under the cosmetic-shape gate against the same auth.json.
- `python3 -m py_compile lib/masterplan_session_audit.py`: clean.
- `bash -n` on `bin/masterplan-findings-to-issues.sh` and `bin/masterplan-state.sh`: clean.
- `bin/masterplan-state.sh transition-guard` smoke against a temp copy of a `status: retro_pending` bundle: file successfully rewritten to `status: pending_retro`.
- Router byte ceiling: `commands/masterplan.md` now 11460 bytes (well under the 20480 limit).

---

## [5.2.2] — 2026-05-15 — AUQ-guard softening: bash-input + classifier-denial escape hatches

Targeted softening of the AUQ-guard Stop hook (`hooks/auq-guard.sh`) to suppress two false-positive dialog-cycle cases observed in real sessions:

1. When the user runs a shell command directly via the harness's `!` prefix (the prior user message contains a `<bash-input>` or `<bash-stdout>` tag), the assistant's natural response is a free-text ack/recap — forcing an AUQ creates pointless choreography after work the user already performed.
2. When the user's tool call was denied by the Claude Code auto-mode classifier ("denied by the Claude Code auto mode classifier" in the last `tool_result`), the natural recovery is free-text instructions ("run it via `!` or add a permission rule") — not another AUQ ceremony.

### Changed

- **`hooks/auq-guard.sh` — Escape hatch B** (~lines 67-74): bail when the most recent real user message contains `<bash-input>` or `<bash-stdout>`. Sequenced after the existing `<no-auq>` / `[oneshot]` hatch.
- **`hooks/auq-guard.sh` — Escape hatch C** (~lines 76-95): scan the most recent `tool_result` content for the literal classifier-denial string and bail when present. Uses the same `jq` shape the existing turn-block walker uses, scoped to the current user turn.

Both hatches preserve the substantive-turn gate and circuit breaker; they only short-circuit the violation-detection cascade for the two specific shapes named above. Smoke-verified with synthetic transcripts.

### Notes

- This is a hook-only patch: no orchestrator behavior changes, no doctor checks, no plan-bundle schema bumps. Existing in-flight runs are unaffected.
- The deployed `~/.claude/hooks/auq-guard.sh` had already drifted ahead of the committed `hooks/auq-guard.sh`; this release also resyncs the in-repo copy to the deployed shape (substantive-turn gate, Mode C flat-ending detection, circuit breaker, JSON `decision: block` output, all prior iterative improvements).

---

## [5.2.1] — 2026-05-15 — Doctor #39 false-positive watcher + README release-pin fix

Follow-up to v5.2.0 driven by a real `/masterplan doctor` run that produced a misleading "Codex auth expired" warning despite `/codex:setup` reporting full health. Per `feedback_failures_drive_instrumentation_not_fixes`, the doctor check itself is not patched here — instead, the recurring-audit module gains a new continuous watcher that surfaces the false-positive shape so the analyzer can drive prioritization of a proper fix.

### Added

- **New policy-regression watcher `codex_health_check_jwt_only`** in `lib/masterplan_session_audit.py` (hard-threshold). Emits a `meta`-source finding when `~/.codex/auth.json` has the shape that triggers doctor check #39 sub-conditions (a)/(b) cosmetically: `auth_mode == "chatgpt"` AND `tokens.refresh_token` present AND `last_refresh` within 7 days AND `id_token.exp` < now. This is the exact pattern where Codex auto-refreshes JWTs on every call and a doctor warning is meaningless. Mirrored in `bin/masterplan-findings-to-issues.sh` hard-codes CSV. `meta`-source findings bypass the wipe-breadcrumb gate (the gate only applies to plan-source findings).

### Fixed

- **`README.md` release pin drift** (`Current release: **v5.1.1**` → `**v5.2.0**`). Surfaced by doctor check #30 in the v5.2.0 release validation run.

### Notes

- Doctor check #39 itself is intentionally NOT modified in this release. The watcher surfaces every false-positive occurrence; the proper fix (delegate to `/codex:setup`-equivalent health logic instead of rolling its own JWT arithmetic) will land via a separate change once the analyzer has accumulated enough recurrence data per `feedback_failures_drive_instrumentation_not_fixes`.
- Smoke-verified against live `~/.codex/auth.json` on the development host: watcher correctly detected the cosmetic-expiry shape (id_token 30 minutes past `exp` with healthy refresh state).

---

## [5.2.0] — 2026-05-15 — Wipe helper + policy-regression watcher

Two coupled additions under the `radiant-watchful-dawn` plan:

1. **Workstream A — telemetry wipe helper** that erases mixed pre/post-v5.1.1 telemetry so the new doctor-check evidence in `events.jsonl` is no longer conflated with stale silent-degradation-era data.
2. **Workstream B — continuous policy-regression watcher** that extends the recurring-audit pipeline with 15 new detector categories. Hard-threshold breaches auto-file GH issues; soft breaches remain local. Watches for the same class of regression that motivated v5.1.1 (annotation gaps, missing routing/review dispatches, missing ping events, silent degradation, CC-3 trampoline skips, CD-3 verification gaps, parallel-eligible-serial dispatch, etc.).

### Added — Policy-regression watcher (radiant-watchful-dawn, Workstream B)

Aimed at the post-instrumentation question of "how do we know future regressions don't silently slip past?" — extends `lib/masterplan_session_audit.py` with 15 new `WarningItem` categories and wires the recurring-audit cron to dispatch hard-threshold breaches to GitHub issues with the same signature/dedup/reopen semantics as the v5.1.0 anomaly framework. No new data sources: detectors operate on already-loaded artifacts (`plan.md`, `state.yml`, `events.jsonl`, Claude/Codex transcripts).

- **15 new detector categories in `lib/masterplan_session_audit.py`**. Hard-threshold (file GH issue): `codex_annotation_gap_on_high`, `codex_routing_configured_but_zero_dispatches`, `codex_review_configured_but_zero_invocations`, `missing_codex_ping_event`, `silent_codex_degradation`, `cc3_trampoline_skipped_after_subagents`, `cd3_verification_missing_on_complete`, `brainstorm_anchor_missing_before_planning`, `wave_dispatched_without_pin`, `parallel_eligible_but_serial_dispatched`. Soft-threshold (local snapshot only): `codex_parallel_group_missing_on_high`, `pending_gate_orphaned`, `cd9_free_text_question_at_close`, `auq_guard_blocked_count_high`, `complexity_unset_fallthrough`. Each category cites the policy in `parts/step-b.md` / `parts/step-c.md` / `parts/step-0.md` / `commands/masterplan.md` it watches.
- **`bin/masterplan-findings-to-issues.sh`** (~250 lines). Reads `${MASTERPLAN_AUDIT_STATE_DIR}/findings.jsonl`, filters to the hard-code allowlist, computes `sha1(code|repo|session)[:12]` signature, dispatches to `gh` with labels `auto-filed` + `class/policy-regression` + `class/<code>`. Local-first persistence: failures land at `findings-pending-upload.jsonl` for next-run drain (mirrors `anomalies-pending-upload.jsonl`). Sentinel at `findings-last-run-id.txt` advances by `run_id` so each audit pass only dispatches newly-emitted findings. Honors `.masterplan.yaml` `failure_reporting.{repo, enabled, dry_run}` — same knobs as v5.1.0 anomaly framework. Args: `--dry-run`, `--all`, `--since-run-id`, `--limit N`, `--no-skip-wiped`, `--repo`, `--state-dir`, `--plans-roots`.
- **Wipe-breadcrumb gate.** Default behavior skips any finding whose plan `state.yml` contains an `events_wiped:` block, so the WS-A wipe does not flood the tracker with historical noise. Override with `--no-skip-wiped` for backfill of legitimate pre-wipe gaps.
- **Wired into `bin/masterplan-recurring-audit.sh`.** The audit cron now dispatches at the tail after JSON+table writes complete. Disable per-run with `MASTERPLAN_AUDIT_SKIP_FINDINGS_DISPATCH=1`.
- **`bin/masterplan-policy-regression-smoke.sh`** (~340 lines, 44 assertions). 12 plan-side detector fixtures + 1 clean negative control (one per detector category, with positive + negative assertions); 8 dispatcher scenarios (PATH-stubbed `gh` + isolated `$HOME`): hard-code dispatch, soft-code skip, wipe-breadcrumb skip, orphan-plan-dir skip, sentinel advance, open-issue comment, closed-issue reopen, gh-failure pending replay, dry-run no-sentinel-touch, `--no-skip-wiped` override. Mirrors `masterplan-anomaly-smoke.sh` pattern; run before every release.
- **`docs/internals.md` § 9 Policy-regression watcher subsection** — design overview, 15-row detector reference table (hard/soft + policy citation), dispatcher mechanics, wipe-breadcrumb gate explanation, backfill controls, skip-flag, smoke-test summary.

### Why this release ships the watcher AND a wipe together

The wipe (WS-A) creates a clean baseline for the new visibility surfaces shipped in v5.1.1. Without the watcher (WS-B), the next regression of the same class would again take 12 months to surface — the wipe alone solves nothing forward-looking. The watcher without the wipe would file ~200 GH issues against pre-v5.1.1 historical noise that the user can do nothing about. Both shipped together: clean baseline + continuous monitoring of policy compliance against the baseline. The dispatcher's wipe-breadcrumb gate makes this composable — if you ever wipe again, history is automatically suppressed.

### Verified before release

- 44/44 smoke assertions pass on `bin/masterplan-policy-regression-smoke.sh`
- Real dry-run against the user's live audit state: 366 findings eligible → 7 dispatched (live plans with real policy gaps) / 160 skipped-soft / 182 skipped-wiped / 17 skipped-orphan / 0 failed. Wipe-breadcrumb gate proven to work against real post-wipe filesystem state.

### Added — Pre-v5.1.1 telemetry wipe helper (radiant-watchful-dawn, Workstream A)

Aimed at the post-v5.1.1 cleanup step: erase 12 months of mixed pre-and-post-instrumentation telemetry so the new doctor-check evidence in `events.jsonl` is not conflated with stale data from the silent-degradation era. Destructive surface is gated behind a default `--dry-run`, an explicit `--apply`, and a `wipe-confirmed` confirmation token (or `--yes` for unattended runs).

- **`bin/masterplan-wipe-telemetry.sh`** (thin bash wrapper) + **`lib/masterplan_wipe_telemetry.py`** (deletion logic). Walks Claude transcripts under `~/.claude/projects/*/*.jsonl`, Codex transcripts/history/log/archived under `~/.codex/`, and per-bundle telemetry (`events.jsonl`, `anomalies.jsonl`, `anomalies-pending-upload.jsonl`, `subagents.jsonl`, `eligibility-cache.json`) across every repo under `$MASTERPLAN_REPO_ROOTS` (default: `~/dev`) including `.worktrees/` copies.
- **Hard keep-list** preserves all bundle work product (`plan.md`, `state.yml`, `spec.md`, `retro.md`, `worklog.md`, `next-actions.md`, `gap-register.md`) and protected directories (`reviews/`, `notes/`, `subagent-reports/`, `artifacts/`). Codex `auth.json` and `config.toml` are untouched.
- **mtime skip** defends against in-progress writes — files modified within the last 5 minutes (configurable via `--mtime-skip=N`) are never deleted.
- **Manifest** at `${XDG_STATE_HOME:-~/.local/state}/superpowers-masterplan/wipes/<UTC-timestamp>.txt` is written BEFORE any deletion, listing every path with byte count + per-category totals, so post-mortem is always recoverable.
- **State.yml breadcrumb**: each affected bundle's `state.yml` gains a top-level `events_wiped:` block (`ts`, `manifest`, `note`) so future `/masterplan status` / doctor runs can distinguish "never had telemetry" from "telemetry was wiped at <ts>". Append-only; does not mutate other fields per CD-7.
- **Per-category opt-out flags:** `--no-claude`, `--no-codex`, `--no-bundle-logs`, `--no-worktrees`, `--repo-roots=A:B` for narrow runs.
- **Verified on this repo's host:** 1600 files / 1.32GB deleted on 2026-05-15; bundle work product across 280 bundles preserved; `events_wiped:` breadcrumb confirmed on sample bundles.

### Why a wipe and not a quarantine

Pre-v5.1.1 telemetry contains 24h of silent-degradation evidence (zero `codex_ping` events, missing `**Codex:**` annotations, expired auth with no warning). Quarantining preserves data nobody will ever query and complicates doctor checks #39/#40/#41 by forcing them to filter by `events_wiped:` timestamp. Wipe gives the new visibility surfaces a clean baseline; the manifest preserves the file inventory for forensic reference.

## [5.1.1] — 2026-05-15 — Codex-routing visibility instrumentation

### Added — Codex-routing visibility instrumentation (cosmic-cuddling-dusk)

Five surgical additions that surface the silent-degradation failure modes observed across 24h of `/masterplan` runs: Codex auth expiring without any user-facing signal, planner skill silently skipping `**Codex:**` and `**parallel-group:**` annotations at `complexity: high`, and the degrade-loudly visibility contract failing to write evidence to `events.jsonl`. All read-only diagnostics — none alter routing logic, eligibility cache, dispatch contract, or persisted state schema.

- **Doctor check #39 — `codex_auth_expiry` (Warning, repo-scoped, v5.1.1+, I-1).** Reads `~/.codex/auth.json`, base64url-decodes the JWT `exp` claim from `id_token` and `access_token`, and warns when either token is expired, expiring within 24h, or when `last_refresh` is older than 30 days. Pairs with check #18 (config-vs-plugin mismatch): #18 flags persistent misconfig; #39 flags expired credentials. Skipped silently when `~/.codex/auth.json` is absent (codex not installed). Report-only — auth refresh is browser-based OAuth, user-owned per headless-host constraint.
- **Doctor check #40 — `high_complexity_codex_annotation_gap` (Warning, plan-scoped, v5.1.1+, I-2).** For each `state.yml.complexity == "high"` plan: counts `^### Task ` headings in `plan.md` and compares against `**Codex:** (ok|no)` annotation count; warns when annotations are fewer than tasks. INFO-flags when zero `**parallel-group:**` annotations exist (planner brief encourages clustering verification/lint tasks). Catches the writing-plans skill silently skipping the high-complexity brief — which suppresses Codex routing (eligibility cache falls back to heuristic-only) and parallel-wave dispatch (wave assembly pre-pass has nothing to assemble). Skipped silently on `complexity: low` and `complexity: medium`.
- **Doctor check #41 — `missing_codex_degradation_evidence` (Warning/Info, plan-scoped, v5.1.1+, I-3).** Two sub-fires: (a) WARN when `codex_routing == off` AND `codex_review == off` AND `~/.codex/auth.json` is healthy AND `events.jsonl` has no `codex degraded` event AND `last_warning` is null (silent override without evidence — violates the degrade-loudly visibility contract); (b) INFO when `codex_routing == auto|manual` AND `events.jsonl` has zero `routing→[codex]` events AND at least one `codex_ping ok` event (suggesting ping detected codex available but every task was judged ineligible — cross-references #40 for the same plan).
- **Boot-banner Codex health indicator** (`commands/masterplan.md` CC-2, I-4). Conditional second sentinel line emitted directly under the version sentinel when ALL of the following hold: `codex.routing != off` OR `codex.review == on` in resolved config, `~/.codex/auth.json` exists, and any JWT is expired. Format: `↳ Codex: degraded (id_token expired Nd ago, access_token expired Md ago) — run \`codex login\` to refresh`. Softer variant `↳ Codex: stale (last_refresh Nd ago — consider running \`codex login\`)` when tokens are within validity but `last_refresh` > 30 days. Silent when codex is intentionally off or auth is healthy. Cost: 1 Read + 2 base64-decodes ≈ 50ms.
- **`codex_ping` event class in `events.jsonl`** (`parts/step-0.md`, I-5). Step 0's Codex availability detection always logs the outcome to `events.jsonl`, regardless of result: `codex_ping ok — detection_mode=<ping|scan>` on success; `codex_ping skipped — detection_mode=trust` or `codex_ping skipped — codex_host_suppressed` when detection is bypassed; existing `codex degraded — ...` event on failure (no duplicate). Makes the per-run codex-availability decision auditable in every events.jsonl so check #41 can distinguish "ping never ran" from "ping returned ok but no Codex dispatches" from "ping returned error".

Doctor.md heading and parallelization brief updated to (#1 .. #41); complexity-aware check set updated (#41 fires on all complexity levels; #40 only on high); severity table extended with three new rows. Doctor #39 is repo-scoped and runs inline at the orchestrator; #40 and #41 are plan-scoped and run in per-worktree Haiku dispatchers when worktrees ≥ 2.

### Why instrumentation, not fixes

Per the project's failure-instrumentation principle (codified in `[5.1.0]` and reinforced by user feedback): never design a `/masterplan` fix on the spot. The instrumentation surfaces the failure rate; subsequent releases prioritize fixes once the analyzer (`bin/masterplan-failure-analyze.sh`) produces durable evidence of which failure modes recur and which were one-offs. The Codex auth-expiry case is unusual in that the upstream cause is user-owned (browser OAuth refresh), so doctor #39 reports rather than auto-fixes.

### Deferred items

- Should Step 0's `ping` mode actually exercise `codex exec` (force the auth path) rather than just dispatching the subagent_type? Currently the ping returns OK if the subagent dispatches OK, even with broken downstream auth. Specification question — surface via #41 sub-fire (a) when it bites.
- Should the boot-banner Codex degraded line gate downstream behavior via an `AskUserQuestion` rather than passive stdout? UX question.
- Should the framework offer to launch `codex login` via shell-out when the user invokes `/masterplan` with expired auth? Headless-host constraint permits user-initiated interactive OAuth.
- Why is the planner skill silently skipping high-complexity annotations? Needs transcript analysis of the writing-plans subagent invocations.

## [5.1.0] — 2026-05-14 — Failure-instrumentation framework

### Added
- **Failure-instrumentation framework** (`hooks/masterplan-telemetry.sh` Section 9, ~280 lines). Six anomaly classes auto-detected at end-of-turn from `<masterplan-trace …>` breadcrumbs + `state.yml` + `events.jsonl`: `silent-stop-after-skill`, `unexpected-halt`, `state-mutation-dropped`, `orphan-pending-gate`, `step-trace-gap`, `verification-failure-uncited`. Each detection writes a canonical record to `<run-dir>/anomalies.jsonl` first, then files/comments/reopens a GitHub issue against `rasatpetabit/superpowers-masterplan` (or configured override) with stable SHA1 signatures and dedup. Local-first persistence: gh failures land in `<run-dir>/anomalies-pending-upload.jsonl` for later drain. Configurable per `.masterplan.yaml` `failure_reporting.{repo, enabled, dry_run}`.
- **Versioned anomaly taxonomy** (`parts/failure-classes.md`): per-class symptom, signals, detector pseudo-shell, and signature inputs. Adding a class requires extending this file + the hook detector dispatch.
- **Step-boundary breadcrumb stream** in `parts/step-0.md`, `step-a.md`, `step-b.md`, `step-c.md`, `import.md`, `doctor.md` — additive `<masterplan-trace step=… phase=in|out>`, `skill-invoke`, `skill-return`, `gate=fire`, `state-write` emit points at well-defined control flow boundaries. Visible turn output (not internal reasoning) so they survive context compaction.
- **`bin/masterplan-failure-analyze.sh`** — over-time analysis script. Queries `auto-filed`-labeled issues from the destination repo, computes frequency by class, recurrence-after-fix histogram (regression signal — the single most important metric for evaluating whether fixes actually held), open-time-to-close median per class, per-verb / per-step breakdown, same-day co-occurrence pairs. Output: markdown to stdout + dated snapshot at `docs/failure-analysis/<YYYY-MM-DD>.md`.
- **`bin/masterplan-anomaly-flush.sh`** — drain pending-upload queue. Walks every run bundle under `docs/masterplan/`, retries each pending record via `gh`. Records that fail again are preserved in place for the next run.
- **`bin/masterplan-anomaly-smoke.sh`** — synthetic-transcript smoke test. Eleven assertions across all six classes + signature stability + dedup + regression reopen + dry-run mode. Mock `gh` via PATH stub; isolated `$HOME=/tmp/...` so it never touches the real Claude Code session log or real GitHub. Run before every release.
- **Doctor Check #38** (`anomaly-file-has-records-since-last-archive`): warns when `<run-dir>/anomalies.jsonl` or `anomalies-pending-upload.jsonl` contains records, nudging users to run the analyzer or flush pending uploads. Report-only.
- **`docs/failure-analysis/`** directory for analyzer snapshots (with `.gitkeep`).
- **`docs/internals.md` § 9 Failure-instrumentation framework subsection** — design overview, anomaly classes table, signature semantics, dedup/regression branches, analyzer recipes, smoke-test workflow, configuration knobs.

### Why this release ships before any bug fix

Per direct user feedback: "even the most basic of `/loop /masterplan next`s fail in spectacularly catastrophic ways, which shows me you've done absolutely nothing to test this at all." The fix wasn't to design more fixes — it was to stop shipping fixes designed on the spot and start designing them from accumulated failure data. This release ships the instrumentation; subsequent releases will fix specific anomaly classes identified by the analyzer.

### Known followups

- Redaction layer for sensitive paths/slugs in issue bodies (Phase 2). The default destination `rasatpetabit/superpowers-masterplan` is private to the user; redaction becomes necessary only if a future deployment files to a public repo.
- Codex-host parity for failure detection. Section 9 is currently Claude Code Stop-hook only.

## [5.0.1] — 2026-05-13 — Doctor #31 v5 fix + bundle maintenance

### Fixed
- **Doctor check #31** (`per_autonomy_gate_condition_consistency`): update grep target from `commands/masterplan.md` to `parts/step-b.md` (gates moved during v5.0 lazy-load extraction); drop stale `L1286`/`L1360` line-number references from all three spec locations (parallelization preamble, check table row, check body).
- **6 archived bundle `state.yml` files** had stale `worktree:` path (`/home/ras/dev/…`) from pre-migration home directory; `worktree_disposition: missing` was absent; `stop_reason`/`critical_error` fields missing. All six repaired: `auto-compact-nudge-fixes`, `cd-9-enforcement`, `complexity-levels`, `intra-plan-parallelism`, `subagent-execution-hardening`, `v2.3.0-cost-leak-recurrence`.

### Added
- **`docs/masterplan/masterplan-taskcreate-projection/`** run bundle: imported from legacy spec + plan (2026-05-12 P4 design artifacts). Status `completed`; implementation lives in `p4-suppression-fix` bundle. Deferred smoke test tracked in `p4-suppression-smoke`.

## [5.0.0] — 2026-05-13 — Lazy-loaded phase prompts (router/parts split + 5 new doctor checks)

**Breaking architectural reorganization.** `commands/masterplan.md` is no longer
a 341 KB monolith loaded in full on every invocation. v5.0.0 splits the
orchestrator into a thin router (7.9 KB / 97 lines) plus per-phase prompt files
under `parts/` that are loaded lazily by verb. Wave dispatch sites in
phase files now scope the orchestrator's working context to only the prompt
text needed for the current phase, eliminating the chronic context-pressure
issue documented across v4.0–v4.2.

No `state.yml` schema bump. Existing run bundles resume unchanged. Existing
plans authored under v4.x continue to execute. Plans authored without v5
plan-format markers (`**Spec:**` / `**Verify:**`) surface as warnings on
doctor check #35 — intentional drift signal, not a regression.

Run bundle for this work: `docs/masterplan/v5-lazy-phase-prompts/`.

### Added

- **Router + parts/ lazy-load layout (T1–T20).** `commands/masterplan.md`
  becomes a 97-line router that dispatches by verb to the right phase file.
  New `parts/` tree: `step-0.md` (M/N/S inline + bootstrap, 320 lines),
  `step-a.md` (spec-pick, 59), `step-b.md` (brainstorm/plan, 376),
  `step-c.md` (execute, 723), `doctor.md` (all 36 doctor checks, 560),
  `import.md` (import verb, 131), `codex-host.md` (host suppression rules,
  9.4 KB), and `contracts/` (cross-cutting: agent-dispatch, cd-rules,
  run-bundle, taskcreate-projection). Documentation moves to `docs/`:
  `verbs.md` cheat sheet, `config-schema.md` schema reference.
- **Doctor check #32 — `scalar_cap_enforcement` (Error, write-time).**
  Validates that no scalar field in `state.yml` exceeds 200 characters at
  write time. Overflow content must be redirected to `handoff.md`,
  `blockers.md`, or `overflow.md` with a pointer stored in `state.yml`.
  Closes the v4.x failure mode where multi-page free-text leaked into
  `current_task` / `blocker` / `handoff` scalars and bloated the resume
  context to multi-MB sizes.
- **Doctor check #33 — `projection_mode` (Warning, repo-scoped).** Verifies
  the host's TaskCreate projection mode matches its declared environment
  (Claude Code: projection on; Codex: projection no-op). Catches drift
  between actual behavior and the `codex_host_suppressed` gate.
- **Doctor check #34 — `plan_index_staleness` (Warning, run-scoped).**
  Compares `state.yml plan.index` against `plan.md` task headings; reports
  when the index is out of sync after manual plan edits. Built on top of
  the new `bin/masterplan-state.sh build-index` subcommand.
- **Doctor check #35 — `plan_format_conformance` (Warning, run-scoped).**
  Validates that each task block in `plan.md` carries the v5 plan-format
  markers (`**Spec:**` / `**Verify:**` / `**Files:**`, plus optional
  `**Parallel-group:**` / `**Codex:**`). Pre-v5 plans authored without
  these markers will surface as warnings — by design, not a regression.
- **Doctor check #36 — `router_byte_ceiling` (Error, repo-scoped).** Hard
  ceiling of 20 KB on `commands/masterplan.md`. The router must stay thin;
  growth past the ceiling is a regression toward the v4.x monolith.
  Current size at release: 7.9 KB (40% of the ceiling).
- **`bin/masterplan-state.sh build-index` (T21).** Generates the
  `plan.index` projection from `plan.md` headings + body markers. Idempotent;
  diff-clean re-runs on unchanged input. Used by doctor #34.
- **`bin/masterplan-state.sh migrate-state` (T22).** Migrates `state.yml`
  documents between schema versions. Currently a no-op for v3→v3 (no schema
  bump in v5.0.0), but in place for future schema evolution. Named
  `migrate-state` rather than bare `migrate` to avoid collision with the
  separately-named `migrate-plan`.
- **`bin/masterplan-state.sh migrate-plan` (T23).** Converts pre-v5 `plan.md`
  files to v5 plan-format by injecting `**Spec:**` / `**Verify:**` /
  `**Files:**` markers at task boundaries. Best-effort — surfaces tasks
  where automated injection would be lossy, leaves them for manual edit.
- **200-character scalar cap enforcement at `write_state()` (T24).** Step C's
  state-writer path now validates every scalar against the 200-char cap
  before persisting. Overflow content must be redirected to a sibling
  artifact file (`handoff.md` / `blockers.md` / `overflow.md`) with a
  pointer stored in `state.yml`. Surface for doctor #32 to detect drift.
- **`parent_turn` telemetry records (T25).** The Stop hook
  (`hooks/masterplan-telemetry.sh`) now emits separate `parent_turn` records
  (orchestrator decisions) and `subagent_turn` records (dispatched
  subagents) to `subagents.jsonl`, both tagged with a `type:` field.
  Enables clean parent-vs-subagent attribution in routing rollups.
- **`bin/masterplan-routing-stats.sh --parent` (T26).** New flag splits the
  rollup output into two attribution sections: parent-only and subagent-only.
  Model labels are bucketed (e.g. `claude-opus-4-7` → `opus`) for display
  normalization. Per-section `codex_calls` no longer bleed across sections.
- **Self-host audit phase-file checks (T27).** Five new checks in
  `bin/masterplan-self-host-audit.sh`: `check_cc3_trampoline` (anchor in
  router + step-0), `check_cd9_coverage` (CD-9 references across parts/),
  `check_dispatch_sites` (DISPATCH-SITE tag scoping — must live in parts/,
  not router), `check_sentinel_v4_refs` (grep for orphan v4 monolith
  line-number references), and `check_plan_format` (delegates to doctor #35
  surface). The plan-format check intentionally surfaces failures on pre-v5
  plan.md files; that's the check working as designed.

### Changed

- **`skills/masterplan/SKILL.md`** rewritten for the v5.0 lazy-load layout.
  "Source of truth" section now describes the router-plus-parts dispatch
  model and lists verb→phase-file mapping. Doctor checks #32–#36 documented
  with one-line descriptions.
- **`docs/internals.md`** expanded to enumerate the `parts/` tree, document
  v5 doctor checks #32–#36 in §10, and update "when adding a check" guidance
  to point at `parts/doctor.md` (v5.0+ authoritative location).
- **Manifest versions** bumped 4.2.1 → 5.0.0:
  `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (root +
  nested), `.codex-plugin/plugin.json`. `.agents/plugins/marketplace.json`
  remains exempt (no `version` field by schema, per doctor #30).

### Migration

- **No `state.yml` schema bump.** Existing run bundles resume unchanged.
- **Existing plans without v5 plan-format markers** continue to execute, but
  surface as warnings on doctor check #35 and the new self-host audit
  `check_plan_format`. To convert in place, run
  `bin/masterplan-state.sh migrate-plan <path-to-plan.md>`; review the
  output for tasks flagged as lossy and complete the marker injection
  manually.
- **Custom forks that patched the v4.x `commands/masterplan.md` monolith**
  will need to re-port their patches against the appropriate `parts/`
  phase file. The router is intentionally thin and unlikely to be the
  right merge target for most patches.

### Verification

- `wc -l commands/masterplan.md` → 97 lines (was ~2150 pre-v5).
- `stat -c %s commands/masterplan.md` → 7,975 bytes (40% of the 20,480-byte
  doctor #36 ceiling).
- `bash -n bin/masterplan-state.sh bin/masterplan-routing-stats.sh
  bin/masterplan-self-host-audit.sh hooks/masterplan-telemetry.sh` all
  pass.
- T27 self-host audit (`bin/masterplan-self-host-audit.sh`) executes the
  five new phase-file checks. Audit currently exits 1 due to the
  plan-format check flagging legacy plan.md files (auto-compact-nudge-fixes,
  v4-lifecycle-redesign, etc.) — that's the check working as designed.
  AUDIT-OK fires for the surface-presence assertions.
- **Status at tag time:** cold-load smoke test (T33), v4→v5 migration smoke
  against a fixture (T34), and a full verification gates pass (T32) are
  the final remaining items in the v5.0 plan. If any of those surface a
  blocker, a v5.0.1 patch will land the corrective change before broader
  rollout.

### Notes

- The router byte ceiling (#36) is the most important regression guard for
  v5.0+. If a future change wants to add inline orchestration logic to
  `commands/masterplan.md`, the right answer is almost always to push it
  into a `parts/` phase file or a `parts/contracts/` cross-cutting file.
  Doctor #36 is an Error, not a Warning, by deliberate design.
- The `parent_turn` / `subagent_turn` split in telemetry is a prerequisite
  for future per-role cost attribution and for the routing-stats
  `--parent` flag. The split is purely additive — pre-v5 consumers reading
  `subagents.jsonl` without filtering on `type:` will see both record kinds
  interleaved; the field is safe to ignore.
- The `migrate-plan` subcommand is best-effort and surfaces lossy
  conversions rather than guessing. It is not part of any automatic
  upgrade path; plans must be migrated explicitly.

## [4.2.1] — 2026-05-13 — Doctor checks #30 + #31 (cross-manifest version drift + per-autonomy gate consistency)

Two new doctor checks plus a drive-by self-documenting comment. Both checks
ship as carried-forward items from the v4.2.0 retro. Report-only — no
auto-fix; manifest/gate edits are too risky to remediate without a human.

### Added

- **Doctor check #30 — `cross_manifest_version_drift` (Warning, repo-scoped, v4.2.1+).** Detects when the four JSON manifests with a `version` field drift out of sync: `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root + nested plugin), and `.codex-plugin/plugin.json`. Skips `.agents/plugins/marketplace.json` (no version field by schema). Background: the v4.2.0 retro documented that `.claude-plugin/marketplace.json` was stuck at 3.3.0 for four releases because it has no enumerator pointing at it; #30 closes that gap with a single source-of-truth diff.
- **Doctor check #31 — `per_autonomy_gate_condition_consistency` (Warning, repo-scoped, v4.2.1+).** Audits the per-autonomy gate decision sites in `commands/masterplan.md` against a static anchor table of expected `--autonomy [!=]=` conditions. Initial table covers the two known sites: spec_approval (L1286, expected `--autonomy != full`) and plan_approval (L1360, expected `--autonomy == gated`). Mismatches are reported as Warnings with the anchor + observed-vs-expected line context. The table is maintained by hand — drift between table and gate is itself a known risk (see retro R1).
- **L1286 self-documenting asymmetry comment (drive-by).** A single inline HTML comment on the spec_approval gate-condition line explicitly calls out the intentional asymmetry with plan_approval under loose autonomy, with a pointer to the CHANGELOG v4.2.0 rationale and doctor check #31. Closes the v4.2.0-retro carry-forward "future readers will grep for this" item.

### Changed

- `commands/masterplan.md` Step D parallelization brief (~L2435) updated to include `#30` and `#31` in the inline list of repo-scoped checks that fire ONCE per doctor run (alongside `#26`).
- `docs/internals.md` §10 gains two new family entries describing the cross-manifest version drift family (#30) and the per-autonomy gate-condition consistency family (#31). The authoritative check table stays in `commands/masterplan.md`; §10 remains orientation-only.

### Verification

- `grep -n '"version": "4.2.1"' .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json` returns 4 hits (1 + 2 + 1).
- `grep -nE '^\| #(30|31) ' commands/masterplan.md` returns the two new rows in the Step D table.
- `grep -n 'Intentionally diverges from the L1360 plan_approval' commands/masterplan.md` returns one hit at the L1286 spec_approval site.
- `bash -n hooks/masterplan-telemetry.sh` passes (hook unchanged but cheap to re-verify).
- Manual doctor-check dry-runs of #30 logic against the bumped manifests confirms a clean report when all four hits are at 4.2.1, and a one-mismatch report when one manifest is temporarily reverted.
- Haiku fresh-eyes Explore review dispatched against the edited `commands/masterplan.md`, `docs/internals.md`, and this CHANGELOG entry to catch dangling references and contradictions (project anti-pattern #5).

### Migration

None. Pure addition. No `state.yml` schema bump. Existing run bundles are unaffected — the new doctor checks fire only when the user invokes `/masterplan doctor` (or `doctor --fix`).

### Notes

- Both checks are report-only by design. Auto-fixing manifest versions is risky (publishing wrong versions); auto-fixing gate-condition source code is even riskier (silent semantic changes). The fix logic for both stops at a clear violation message + file:line pointer.
- The static anchor table for #31 is a maintenance burden — every new per-autonomy gate site needs a table row. The retro carries this forward as R1 (consider replacing with a derived approach if the table grows past ~5 anchors).

## [4.2.0] — 2026-05-13 — loose autonomy auto-approves plan_approval gate

Behavior change for kickoff under `--autonomy=loose`. The Step B3 close-out `plan_approval` gate now auto-approves and proceeds silently to Step C; previously it halted regardless of `halt_mode`. Step B1 `spec_approval` is intentionally **unchanged** — it still halts under loose, so direction-correction stays cheap.

Diagnostic context: the gate condition at `commands/masterplan.md` L1360 was `--autonomy != full`, but per the loose-autonomy "auto-progress through wave boundaries" contract (documented in user-global CLAUDE.md) it should have been `--autonomy == gated`. Evidence: `docs/masterplan/p4-suppression-fix/events.jsonl` contains both `halt_gate_post_brainstorm` and `halt_gate_post_plan` despite `autonomy: loose, halt_mode: none`. The user-global `~/.masterplan.yaml: autonomy: loose` was honored at config-load time — survey of 10 recent `state.yml` files showed 9 of 10 persisted the value correctly. The bug was purely in the downstream gate-condition logic.

Run bundle for this work: `docs/masterplan/loose-skip-plan-approval/`.

### Changed
- **`commands/masterplan.md` L1360** — `plan_approval` close-out gate now guards on `--autonomy == gated` (was `--autonomy != full`). Under `--autonomy in {loose, full}`: clear `pending_gate`, append `plan_approval_auto_accepted` to `events.jsonl`, proceed to Step C silently. Under `gated`: persist `pending_gate` and surface `AskUserQuestion` as before.
- Versions in `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` bumped 4.1.1 → 4.2.0.
- **`.claude-plugin/marketplace.json`** — both the top-level catalog `version` and the plugin entry `version` bumped 3.3.0 → 4.2.0, catching up pre-existing drift accumulated across the v3.4.0–v4.1.1 releases. The Claude Code marketplace publishes from `marketplace.json`, so the catch-up is the right hygiene moment.

### Not changed (intentional)
- **`commands/masterplan.md` L1286 (`spec_approval` gate)** still gates on `--autonomy != full`. Under loose, spec_approval continues to halt. Rationale: correcting a wrong spec direction is cheap and worth the round-trip; the asymmetry with L1360 is documented and deliberate, not an oversight.
- **`.agents/plugins/marketplace.json`** has no `version` field in its schema; T7 was a documented no-op rather than a schema addition (would have required Codex marketplace schema research out of scope here).

### Migration
Users who relied on the L1360 halt for last-look-before-execute should add `--autonomy=gated` to kickoff invocations. Setting `autonomy: gated` in `~/.masterplan.yaml` restores both halts globally.

### Verification
- `grep -nE 'id: plan_approval' commands/masterplan.md` → guarded on `autonomy == gated` (L1360). ✓
- `grep -nE 'id: spec_approval' commands/masterplan.md` → unchanged from v4.1.1 (L1286 still gates on `--autonomy != full`). ✓
- `git grep -nE '--autonomy != full' commands/ docs/ README.md` → exactly one hit at L1286 (the still-firing spec_approval gate). ✓
- Fresh-eyes Haiku Explore subagent read `commands/masterplan.md` end-to-end: **zero** dangling references to old plan_approval wording, **zero** internal contradictions with the new L1360, and the only remaining `--autonomy != full` site is L1286 (expected, out of scope). Bundle: `docs/masterplan/loose-skip-plan-approval/events.jsonl` event `haiku_explore_report`. ✓
- **Status at tag time:** manual smoke run in a throwaway repo was **NOT** executed at release. Reason: smoke requires a fresh Claude Code session against the deployed plugin path (a new `/masterplan` invocation cannot be dispatched from inside the release session itself). Precedent: v4.1.1 shipped with smoke similarly deferred. If a future deferred smoke run shows `plan_approval` still firing under loose autonomy, a v4.2.1 patch will land the corrective change.

### Notes
- This release "ate its own dog food" once: the v4.2.0 plan itself was authored under v4.1.1 behavior, so kickoff still halted at plan_approval. Future loose-autonomy kickoffs against this codebase pick up the new behavior on the next `/masterplan` invocation.
- Spec: `docs/masterplan/loose-skip-plan-approval/spec.md`. Plan: `docs/masterplan/loose-skip-plan-approval/plan.md`.

## [4.1.1] — 2026-05-12 — Verified reminder suppression + Step C entry split

Addresses both findings from the codex adversarial review of v4.1.0 (commit `bbe5a38`).

### Added
- **Per-state-write `TaskUpdate` priming (HIGH).** Extends v4.1.0's per-transition mirror to every Step C `state.yml` write. Closes the idle-turn gap that left the harness reminder firing between task transitions. Mechanism is additive — v4.1.0's transition hooks remain unchanged. Gated on `codex_host_suppressed == false` AND `current_task != ""`.
- **Step C entry split (MEDIUM).** New optional `state.yml` field `step_c_session_init_sha` (UUID from `bin/masterplan-state.sh session-sig`). First entry per session: full rehydration. Subsequent entries in same session: drift-check (verify `current_task` alignment + status counts; correct via `TaskUpdate`). Closes the codex finding that v4.1.0 skipped drift recovery on re-entry.
- **`bin/masterplan-state.sh session-sig`** subcommand: returns `${CLAUDE_SESSION_ID}` if set, else a fresh v4 UUID via `uuidgen` or `/proc/sys/kernel/random/uuid`. The orchestrator never reads the envvar directly.

### Changed
- README amended to scope the suppression claim: "suppresses the TaskCreate reminder during Step C execution" (brainstorm / plan / halt / doctor phases keep the reminder).
- `docs/internals.md` L291 rewritten — no longer claims projection makes the reminder a no-op outright; distinguishes v4.1.0 transition-only suppression from v4.1.1 per-state-write priming.
- `docs/internals.md` §12 gains a v4.1.1 design-rationale subsection covering mechanism, empirical basis, verification gate, and scope discipline.

### Verification
- Release gated on a real-session smoke run against `docs/masterplan/p4-suppression-smoke/`. The bundle's spec encodes a per-turn `smoke_observation` event contract; success criterion is `reminder_fired == false` on every state-write turn within Step C. Failure routes to pre-registered Option D rescope (idle-turn heartbeat) or to dropping the suppression claim.
- **Status at tag time:** smoke run was NOT executed at release. The smoke bundle and its `smoke_observation` contract are ready; verification is deferred to a future fresh-session run. If that deferred run fails, follow-up release will apply the Option D rescope or drop the suppression claim per the spec's failure-handling section.

### Notes
- Codex hosts are unaffected — the entire projection layer (including the new priming touch) skips silently per the existing `codex_host_suppressed` gate.

## [4.1.0] — 2026-05-12 — TaskCreate projection (partial reminder suppression)

### Added
- TaskCreate projection layer: plan tasks are mirrored to the harness's native task ledger so wave progress is visible in the UI. Claude Code-only; Codex no-op.
- Per-transition `TaskUpdate` mirror at every Step C `state.yml` task transition (`current_task` advance, wave dispatch, wave-member digest, `pending_retro`, `complete`, `blocked`).
- Drift recovery on rehydration entry (corrects TaskList toward `state.yml`).
- Four new `events.jsonl` event types: `taskcreate_projection_rehydrated`, `taskcreate_mirror_failed`, `taskcreate_drift_corrected`, `taskcreate_orphan_cancelled`.
- `bin/masterplan-self-host-audit.sh --taskcreate-gate` check enforcing the Codex no-op invariant.

### Known limitations
- **Per-turn reminder suppression is partial.** Transitions fire `TaskUpdate` only at transition points; idle turns between transitions can still emit the harness `<system-reminder>`. The codex adversarial review of this release flagged the original "silences the per-turn reminder" claim as inaccurate. v4.1.1 closes this gap via per-state-write priming.

### Notes
- Pure addition. No schema bump. `state.yml` shape is unchanged. Existing bundles get a projection the next time they're resumed; no backfill needed.

## [4.0.0] — 2026-05-13 — lifecycle hardening (FM-A/B/C/D/G)

**Breaking:** `state.yml` schema bumps `schema_version: 2 → 3`. Existing v2
bundles migrate lazily on first state write performed by v4.0.0 — the
migration shim adds `worktree_disposition`, normalizes `retro_policy`, and
preserves all v2 fields. v2 bundles remain readable and resumable; downgrading
to ≤3.3.0 after a write is not supported.

Run bundle for the redesign work: `docs/masterplan/v4-lifecycle-redesign/`.

### Added

- **Wave 1 — Foundation.** New parent-owned `transition_guard(state,
  target_phase)` write barrier called at every Step C status/phase transition
  (returns `{ok|gate|abort}`); `bin/masterplan-state.sh transition-guard`
  subcommand exposes the same logic to subagents. Schema_v3 additive bump
  with `worktree_disposition: active|kept_by_user|removed_after_merge|missing`,
  `retro_policy: {auto|manual|waived, reason?}`, and `scope_fingerprint`
  fields. Lazy v2→v3 migration at Step B0 step 6. Temp-dir sweep at Step 0
  sweeps stale `/tmp/masterplan-import-*-<pid>/` from prior failed imports.

- **Wave 2 — FM-A (hollow completion closed).** Step C 6a guards every
  status/phase write through `transition_guard`. Step C 6b downgrades retro
  generation failures to new status `pending_retro` instead of leaving a
  hollow `complete` bundle. Step CL archive refuses bundles where
  `artifacts.retro` is empty or the file is missing on disk unless
  `retro_policy.waived` is set with a reason. Retro recovery picker added at
  Step R entry for `pending_retro` bundles.

- **Wave 3 — FM-C (import hydration atomic).** Step I3 import now stages all
  legacy artifact copies in `/tmp/masterplan-import-<slug>-<pid>/` and
  atomically promotes them into the bundle directory on success; failure
  rolls back the temp directory and leaves the bundle untouched. New step
  I3.5 hydration guard refuses to write `artifacts.spec`/`artifacts.plan`
  pointers without verifying the bundle-local copy is on disk; I3.6 (renamed
  from prior I3.5) handles cruft sweep. Doctor check #9 cross-checks
  `legacy.*` vs `artifacts.*` and surfaces hydration gaps instead of
  silently null-sentinel-filling.

- **Wave 4 — FM-B (kickoff scope-overlap detection).** Step B0 steps 1b/1c
  scan `docs/masterplan/*/state.yml` before slug creation; Jaccard token-set
  similarity over `scope_fingerprint` against existing non-archived bundles
  with named threshold constant `SCOPE_OVERLAP_THRESHOLD = 0.6`. When a hit
  exceeds threshold, `AskUserQuestion` prompts: resume existing, derive
  variant (records `variant_of:`), or force new slug (records
  `supersedes:`/`superseded_by:` cross-links). Stopword list local; no Python
  dependency.

- **Wave 5 — FM-D (algorithmic subagent briefs + contract pattern).** New
  `commands/masterplan-contracts.md` registry with 4 contracts:
  `import.convert_v1`, `doctor.schema_v2`, `retro.source_gather_v1`,
  `related_scope_scan_v1`. Each contract specifies algorithm, return shape,
  and parent re-verify rules. Three dispatch sites (Step I import, Step D
  doctor, Step C retro) now carry `contract_id:` in the brief and a
  sampling-based parent re-verification step (3 random + all
  violation-claiming bundles). New `--brief-style` lint mode in
  `bin/masterplan-self-host-audit.sh` greps for outcome-only brief patterns
  (Patterns A/B/C/D, scoped to lifecycle DISPATCH-SITE contexts). `docs/internals.md`
  gains an "Algorithmic subagent briefs" subsection with before/after
  examples and a contract registry pointer.

- **Wave 6 — FM-G (worktree disposition + auto-resolve).** New schema field
  `worktree_disposition` with 4 states. Step C 6a worktree refresh
  reconciles bundle pointer against `git worktree list` before status
  writes. Step C 6a worktree completion auto-removes worktrees on bundle
  completion (NON-INTERACTIVE — no `AskUserQuestion` gate, honors the
  loose-autonomy contract); opt-out via new `--keep-worktree` flag or
  `worktree.default_disposition: kept_by_user` config. Step CL1 category 6
  refuses to archive bundles whose worktree state is inconsistent. New
  doctor check #29 enumerates `git worktree list` against `state.yml#worktree:`
  pointers across all bundles and surfaces recorded-but-missing AND
  present-but-untracked orphans.

### Migration notes

- v2 bundles continue to work; migration is lazy and writes-only. To force
  migration without a state change, run `/masterplan doctor --fix` on the
  bundle (the autofix path performs a no-op state write that triggers the
  shim).
- Existing hollow bundles surfaced in the audit pass (11 across petabit-os-mgmt
  and optoe-ng) are handled by Phase 3 backfill in those repos; v4.0.0 alone
  does not retro-fill them.

### Doctor

- New check #29 (worktree reconciliation). The full table count in `docs/internals.md`
  and the Step D parallelization brief have been updated accordingly.

## [3.3.0] — 2026-05-12 — sentinel hardening + brainstorm intent-anchor Haiku dispatch

### Fixed

- **Invocation-sentinel version rendered as `v?` or as the unsubstituted template
  `v<version-from-plugin.json>`.** Observed in the optoe-ng session
  `d7dfc481-…` (May 12 16:29): the Step 0 sentinel emitted both `v?`
  (paraphrased fallback) and the literal angle-bracket template across
  adjacent turns, even though both candidate `plugin.json` files contained a
  valid `"version": "3.2.9"`. Root cause: the angle-bracket syntax
  `<version-from-plugin.json>` was used for both the template placeholder and
  the Read instruction, and the LLM treated it as a literal placeholder to
  emit instead of as an instruction to call the Read tool; the documented
  fallback `vUNKNOWN` was being paraphrased to `v?`.

  Rewrote the sentinel block in `commands/masterplan.md`:
  - Imperative Read-tool language: "Use the Read tool to load
    `.claude-plugin/plugin.json` from the FIRST readable candidate path. The
    Read tool call is mandatory — do not skip it, do not paraphrase its
    result, do not infer a version from session memory."
  - Concrete rendered example using a real semver
    (`→ /masterplan v3.3.0 args: 'doctor --fix' cwd: /home/grojas/dev/optoe-ng`)
    so the LLM has a pattern to emit, not a template to render literally.
  - Explicit prohibition: the version slot must be either a parsed semver or
    the literal six-character string `vUNKNOWN`. `v?`, `v??`, `vTBD`,
    `v<unknown>`, and the angle-bracket template token itself are all banned.

- **Brainstorm intent-anchor read pass blew Opus context.** Step 939.2
  previously instructed the orchestrator to "Read cheap local truth in one
  bounded batch: `AGENTS.md`, `CLAUDE.md`, `WORKLOG.md`, the most recent
  relevant `docs/masterplan/*/{state.yml,events.jsonl,spec.md}` bundles".
  "Bounded" applied to the file list, not per-file size — the optoe-ng
  `WORKLOG.md` is 81KB / 861 lines, costing ~25K Opus tokens alone before
  any real work. The optoe-ng transcript reported "this session is being
  continued from a previous conversation that ran out of context",
  confirming exhaustion in the prior session.

  Refactored Step 939 to dispatch a `model: "haiku"` subagent that performs
  the cheap-local-truth reads (each Read capped at 500 lines; WORKLOG.md
  capped at 200 lines under the newest-at-top convention) and returns the
  `brainstorm_anchor` JSON object directly. The orchestrator owns state-write
  entry (939.1) and persistence (939.3); the Haiku subagent owns reads +
  classification + evidence extraction (939.2). When Haiku returns
  `mode: "unclear"` or invalid JSON, the orchestrator falls through to the
  existing `brainstorm_anchor_audit_mode` `AskUserQuestion` gate instead of
  silently defaulting.

  This aligns with CLAUDE.md anti-pattern #1 ("Don't run substantive work in
  the orchestrator's own context. Dispatch to subagents…") and reuses the
  CD-7 invariant that only the orchestrator writes state.

### Out of scope

- Step I1 import flow's inline-Read of `WORKLOG.md` candidates (line 1743 +
  1780 area) remains unchanged. Import already routes raw bytes to Sonnet
  conversion subagents, and the optoe-ng complaint was about the brainstorm
  path, not import.

## [3.2.9] — 2026-05-12 — `/masterplan import` dedup false-positive fix

### Fixed

- **Already-migrated legacy records were being flagged for re-import.** A user
  ran `/masterplan import` in a repo where every legacy plan had a sibling
  `docs/masterplan/<slug>/state.yml` and got back `skip: 34, would-migrate: 1`
  — the one "would-migrate" candidate was a date-prefixed legacy plan
  (`2026-05-09-phase-10-cli-parity`) whose canonical bundle
  (`docs/masterplan/phase-10-cli-parity/state.yml`) already existed and
  recorded `migrated_from_legacy` in its events log. Accepting the dry-run
  would have created a second, date-prefixed bundle duplicating completed
  work.

  Two independent bugs in `bin/masterplan-state.sh`'s dedup predicate caused
  this:
  1. `canonical_slug()` was applied to legacy directory names but not to the
     explicit `slug:` field of legacy `-status.md` frontmatter. When a legacy
     record's frontmatter retained the date prefix (`slug:
     2026-05-09-foo`), it was compared verbatim against canonical bundle dir
     names (`foo`), so the string-equal check always missed.
  2. Existing bundles' `legacy:` pointers (the `legacy.{status,plan,spec,
     retro}` paths recorded in state.yml at migration time) were never read
     back during a subsequent import. A user who had renamed a migrated
     bundle's slug after the fact would still have its `legacy:` block
     pointing at the source legacy files, but the import script had no way
     to consult that pointer.

  Fix: rewrote the dedup logic in `bin/masterplan-state.sh` to build two
  parallel indices — `by_canonical` (canonical slug of every bundle dir name)
  and `by_legacy_path` (every `legacy.{status,plan,spec,retro}` value parsed
  out of existing state.yml files) — and check both before declaring a legacy
  record "would-migrate". Skip-reason strings now distinguish which check
  fired (`canonical slug match` vs `legacy: pointer reference`) for
  debuggability of dry-run output.

  Also tightened the Step I documentation in `commands/masterplan.md`:
  Step I1.4 ("Stale superpowers state") now spells out the two-part dedup
  predicate explicitly so future edits don't drift back to the broken
  string-equal behavior; the Step I3 pre-flight collision pass now
  acknowledges that "pre-existing collision" covers both target-path
  collisions and legacy-pointer/canonical-slug matches (defense-in-depth
  against `--file=`/`--branch=` direct-routing invocations that skip
  discovery).

### Unchanged

- The migration script remains copy-only (legacy files are never deleted).
- `state.yml` schema is unchanged.
- The orchestrator's Step I conversion flow (Step I3.2/I3.4/I3.5) is unchanged.

## [3.2.8] — 2026-05-11 — User-facing scrub of `bin/masterplan-state.sh`

### Fixed

- **Broken path recommendations in user-facing surfaces.** The plugin runs in
  *other* projects, so `bin/masterplan-state.sh` does not exist in the user's
  CWD — it lives inside the plugin install dir
  (`~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/bin/...`).
  Suggesting that path to end-users (or to the orchestrator running in the
  user's CWD) always 404s. Removed every user-facing reference and replaced
  with the corresponding slash-command flow:
  - `skills/masterplan-detect/SKILL.md` — frontmatter and the rendered legacy
    artifact suggestion now recommend only `/masterplan import`.
  - `skills/masterplan/SKILL.md` — Codex summary-first inventory phrasing now
    uses `rg --files docs/masterplan` plus targeted `state.yml` reads; removed
    the "if `bin/masterplan-state.sh` is present, prefer" fallback block.
  - `commands/masterplan.md` — Step 0 host loading, legacy migration prose,
    Step D next-feature discovery, the doctor `--fix` action for
    "Legacy plan not migrated", the clean `legacy` category detector, and the
    state.yml schema-example comment all stop pointing at the script. The
    doctor `--fix` action now reads "invoke `/masterplan import` and select
    `<slug>` from the picker" (Step I itself is unchanged — no new `--slug`
    short-circuit was introduced).
  - `README.md` — removed `bin/masterplan-state.sh inventory` /
    `migrate --write` from the prose paragraph and from the user-runnable
    command block (`/masterplan import` was already listed there).
  - `docs/masterplan/README.md` — the run-bundle README now recommends
    `/masterplan import` for legacy migration.

### Unchanged

- `bin/masterplan-state.sh` itself stays in the repo as plugin-internal dev
  tooling. Repo-internal references in `CLAUDE.md`, `docs/internals.md`,
  earlier `CHANGELOG.md` entries, and `bin/masterplan-self-host-audit.sh` are
  preserved — they describe the plugin's own dev surfaces for plugin
  developers, not end-user instructions.

## [3.2.7] — 2026-05-12 — Forward-progress audit instrumentation

### Added

- **Structured follow-up routing for completed meta-plans.** Run state now
  carries `plan_kind` and `follow_ups` so audit/doctor/import/status work that
  discovers confirmed implementation gaps must materialize routable follow-up
  records instead of leaving prose `next_action` text behind. The archived
  petabit-os-mgmt audit class is explicitly mapped to implementation follow-ups
  for DNS/oper reporting cleanup and datastore list-key merging.
- **Forward-progress session audit warnings.** `bin/masterplan-session-audit.sh`
  now scans run state in addition to Claude/Codex transcripts and telemetry,
  reporting stable warning codes for meta-resume loops, shell invocation traps,
  activity without outcome events, unroutable prose next actions, and completed
  meta-plans whose confirmed gaps were not materialized as structured
  follow-ups.
- **Recurring local audit loop.** Added `bin/masterplan-recurring-audit.sh` to
  persist redacted audit snapshots and `bin/masterplan-audit-schedule.sh` to
  install/status/uninstall a managed cron block without touching unrelated
  crontab entries.

### Fixed

- **Codex shell-trap recovery.** Codex-hosted Masterplan now treats
  `<user_shell_command>` transcripts for `$masterplan ...` or `masterplan ...`
  as recoverable normal-chat invocations, records the recovery on the next state
  write, and routes through the normal verb handler instead of asking the user
  to retype.
- **Implementation work outranks completed audit resumption.** Resume selection
  prefers in-progress implementation plans and pending implementation
  follow-ups over completed meta-plans, preventing the orchestrator from looping
  on an already-finished audit.

## [3.2.6] — 2026-05-12 — Codex native goal pursuit

### Added

- **Codex native goal bridge.** Codex-hosted Masterplan runs now use Codex's
  native goal tools as the cross-turn pursuit wrapper after a plan exists:
  reconcile with `get_goal`, create a matching plan goal with `create_goal` when
  needed, and call `update_goal(status="complete")` only after Masterplan's own
  completion finalizer succeeds. `/goal` remains a Codex host feature, not a
  Masterplan verb or shell command.

### Fixed

- **Cleanup preserves completed plans with follow-up work.** The `completed`
  clean detector now skips `status: complete` bundles whose `next_action` still
  names concrete follow-up work, classifying them as `completed_with_follow_up`
  for Step N instead of archiving them as done.
- **Session audit detects unfinished native goals.** The Codex session audit now
  recognizes `create_goal` and `update_goal(status="complete")` tool calls and
  reports native goals that were created but never completed.

## [3.2.5] — 2026-05-12 — Codex normal-chat resume hints

### Fixed

- **Codex resume hints avoid shell mode.** Codex-facing close-out and
  budget-stop text now tells users to send a normal chat message such as
  `Use masterplan execute <state-path>` instead of printing `$masterplan ...`,
  which Codex TUI shell-command mode sends to Bash as environment-variable
  expansion.
- **Codex goal outcome audit.** `bin/masterplan-session-audit.sh` now classifies
  Codex guardian approval sub-sessions as auxiliary, reads Codex
  `task_complete.last_agent_message` stop signals, exposes `session_role`,
  `goal_outcome`, and `goal_failure_reasons` in JSON output, and prints a
  redacted "Started goals at risk" section for primary sessions.

## [3.2.4] — 2026-05-12 — loop-first resume contract

### Added

- **Session audit regression harness.** `bin/masterplan-session-audit.sh` is now
  a thin wrapper around `lib/masterplan_session_audit.py`, with fixture-backed
  unit tests covering ambient `/masterplan` mentions, active sessions with and
  without telemetry, duplicate warning collapse, stable JSON warning codes, and
  legacy environment-variable defaults. `bin/masterplan-self-host-audit.sh`
  also includes a `--session-audit` gate so future prompt/docs changes cannot
  silently regress the incident-audit contract.
- **Loop-first resume contract.** `state.yml` now distinguishes
  `stop_reason` from execution `status`, reserves `status: blocked` for
  safety-only `critical_error` recovery, and documents the resume controller
  that re-renders gates, polls background work, or continues the active plan
  without operator-maintained state.

### Fixed

- **Codex interactive gate selections.** Codex-hosted `request_user_input`
  results now count as explicit interactive selection evidence whenever the
  tool returns an answer label, including the first/recommended option with no
  free-form note. Masterplan no longer preserves `pending_gate` or emits a
  no-action terminal response solely because the selected option was marked
  recommended.
- **Session audit masterplan classification.** `bin/masterplan-session-audit.sh`
  now treats `/masterplan` telemetry coverage as active only when a user
  invocation or orchestrator runtime marker is present, avoiding false missing-
  telemetry warnings from ambient repo names, skill listings, docs, and
  developer prompt text. The warning report also de-duplicates identical
  source/repo/session/code warning entries before computing repo warning totals,
  and JSON output exposes stable `code` fields for automation.
- **Codex resume hints.** Codex-hosted close-out and budget-stop text now uses
  the portable `$masterplan ...` skill form, such as
  `$masterplan execute <state-path>`, instead of telling Codex users to resume
  with Claude Code's `/masterplan ...` slash command. The Codex self-host audit
  now checks that command prompt, README, and skill docs keep this contract.
- **Session audit stop classification.** Active Masterplan sessions now report
  `stop_kind` (`question`, `critical_error`, `complete`, `scheduled_yield`, or
  `unknown`) and warn with `active_masterplan_unclassified_stop` when a session
  closes without a classified loop-first stop signal.

## [3.2.3] — 2026-05-11 — adaptive brainstorm interviews

### Added

- **Adaptive brainstorm interview contract.** Step B1 now briefs every spec-creating kickoff (`brainstorm`, `plan`, and `full`) to ask enough structured interview questions before approaches/spec writing, scaling depth by resolved complexity, issue seriousness, and current understanding.

## [3.2.2] — 2026-05-11 — Codex host budget and telemetry audit fixes

### Added

- **Redacted session telemetry audit.** Added `bin/masterplan-session-audit.sh`, a read-only audit over Claude JSONL, Codex JSONL, and `docs/masterplan/*/telemetry*.jsonl` that reports repo-level totals, top offending sessions, Codex runaway thresholds, Claude fanout/SessionStart payload warnings, telemetry-size warnings, and missing-telemetry coverage gaps without printing prompts, commands, tool results, or secrets.

### Fixed

- **Codex-host runaway execution.** Codex-hosted `/masterplan` now has explicit performance budgets, summary-first loading, unresolved-gate/phase budget checkpoints, and a sensitive live-auth stop rule so host-suppressed runs do not turn a status/audit request into hundreds of inline tool calls.
- **Codex post-gate continuation.** Explicit Codex `request_user_input` continuation answers now keep `full` / `execute` flows moving after `gate_closed`; host suppression blocks recursive Codex dispatch, not same-turn continuation requested by the user.
- **Codex entrypoint prompt loading.** The Codex-visible `masterplan` skill now instructs Codex to load targeted sections of `commands/masterplan.md` instead of dumping the full canonical prompt on ordinary runtime invocations.
- **Claude SessionStart prompt exposure.** The SessionStart self-healing hook now installs a compact `/masterplan` shim (`<!-- masterplan-shim: v3 -->`) instead of symlinking the full orchestrator prompt into `~/.claude/commands/masterplan.md`; the full prompt is loaded only when the plugin command is invoked.

## [3.2.1] — 2026-05-10 — Codex gate-consent hardening

### Fixed

- **Codex recommended-answer guard.** Codex-hosted `request_user_input` results that select only the first/recommended option with no `user_note` are now treated as weak evidence, not consent. Masterplan preserves `pending_gate`, avoids phase/artifact mutation, and renders a no-action terminal message instead of writing `gate_closed`.
- **Doctor legacy-reference false positives.** Legacy `docs/superpowers/...` artifacts referenced from bundle `state.yml` `artifacts.*` or `legacy.*` entries no longer report as unmigrated just because the legacy filename slug differs from the bundle slug.

### Added

- **Self-host Codex audit coverage.** `bin/masterplan-self-host-audit.sh --codex` now verifies the recommended-answer guard remains present in the shipped orchestrator prompt.

## [3.2.0] — 2026-05-10 — anchored brainstorming and Codex config bootstrap

### Added

- **Brainstorm intent anchor.** Step B1 now reads cheap repo truth before invoking `superpowers:brainstorming`, classifies the topic (`feature-ideas`, `implementation-design`, `audit-review`, `deferred-task`, `execution-resume`, or `unclear`), persists `brainstorm_anchor` in `state.yml`, and records `brainstorm_anchor_resolved` before spec writing.
- **Anchor regression fixtures and audit coverage.** The self-host audit now checks the prompt contract and the transcript-derived fixtures for meta-petabit Yocto review drift, deferred ERROR_QA work, image/package policy scoping, and the one feature-ideas case that should still use an idea funnel.

### Fixed

- **Broad brainstorming drift.** Audit/review prompts, deferred task prompts, and cross-repo Yocto layer prompts now get structured anchor gates and scope boundaries before spec writing instead of immediately expanding into unconstrained feature planning.
- **Codex config bootstrap.** The Codex-visible `masterplan` skill now explicitly loads `~/.masterplan.yaml` and repo-local `.masterplan.yaml` before deriving defaults, so Codex-hosted invocations preserve user-global settings like `autonomy` and `complexity` while still suppressing recursive `codex:codex-rescue` routing/review inside Codex.

## [3.1.1] — 2026-05-09 — continuation and Codex prompt exposure fixes

### Fixed

- **Codex masterplan entrypoint.** Added a Codex-visible `masterplan` skill so fresh Codex sessions can see the workflow, load `commands/masterplan.md`, and recognize Claude-created `docs/masterplan/<slug>/state.yml` run bundles. The previous packaging only proved marketplace registration; it did not prove prompt exposure.
- **`next` follow-up hardening.** Step N now treats completed plans with a concrete `next_action` as follow-up work instead of routing straight to "start a new plan." Follow-ups route to the branch finish gate, retro, doctor/status, or background polling as appropriate, and stale `plan.md` checkboxes no longer override completed `state.yml`.
- **Background dispatch continuations.** Codex/Agent returns that keep running in the background must persist a `background:` marker plus an exact poll `next_action`; the next Step C entry polls that marker before any redispatch instead of ending on an informal "I'll review when it finishes" handoff.
- **Completion dirty gate.** Step C now runs live `git status --porcelain` before writing `status: complete`. Task-scope dirt keeps the run in `finish_gate` with a concrete commit/finish action, preventing "complete" state from hiding uncommitted work.

## [3.1.0] — 2026-05-09 — Codex host compatibility

### Added

- **`next` verb — "what's next?" router (Step N).** `/masterplan next` now intercepts the word "next" before it can fall through to the bare-topic catch-all. Without this, typing "next" after a completed phase launched a new `/masterplan full next` brainstorm cycle, bloated context, triggered auto-compaction, wrote `last-prompt: next` metadata, and replayed "next" into a cascade. Step N scans state files inline (no subagent dispatch) and presents an `AskUserQuestion` gate: resume an active plan, start a new plan, or check status. Routing to Step C / Step A / Step B / Step S / Step M as appropriate. Updated all six sync'd locations per the anti-pattern #4 rule: routing table, arg-parse match set, reserved-verbs warning, README command table, internals routing table, and frontmatter `description:`.
- **Codex-native plugin packaging.** Added `.codex-plugin/plugin.json`, `.agents/plugins/marketplace.json`, and the `plugins/superpowers-masterplan -> ..` symlink so Codex can discover the repository as a plugin marketplace while keeping `commands/masterplan.md` as the single behavior source. The portable Codex invocation is `/superpowers-masterplan:masterplan`.
- **Codex host suppression.** Step 0 now detects when `/masterplan` is already running inside Codex and suppresses `codex:codex-rescue` ping/routing/review for that invocation. Step C routes inline with `decision_source: host-suppressed`, skips eligibility-cache requirements, and records a host-suppression event instead of misreporting the Claude Code companion as missing.

### Changed

- README, internals, release notes, and the orchestrator prompt now distinguish Codex as a plugin host from the separate Claude Code `codex:codex-rescue` companion used for delegated execution/review.
- Codex compatibility docs now state that Codex-hosted runs use `/superpowers-masterplan:masterplan` directly, while Claude Code-hosted runs may still use the optional `openai/codex-plugin-cc` companion for cross-model execution/review.

## [3.0.0] — 2026-05-08 — run bundles, migration, and default completion finalization

Major release that moves `/masterplan` state to run bundles and makes successful completion durable by default.

### Added

- **Run bundles under `docs/masterplan/<slug>/`.** `state.yml`, `spec.md`, `plan.md`, `retro.md`, `events.jsonl`, archives, telemetry, subagent records, eligibility cache, and queued state writes now live together. `state.yml` is created before brainstorming so compaction or a stopped session has a durable resume pointer from the start.
- **Legacy migration helper.** New `bin/masterplan-state.sh` inventories and copy-migrates pre-v3 `docs/superpowers/...` plans, standalone specs, standalone retros, archives, and sidecars into run bundles. Migration is copy-only and preserves source paths under `legacy:`.
- **Default completion finalizer.** When Step C finishes all tasks, `/masterplan` now marks the run complete, generates `retro.md`, archives the run state in `state.yml`, and then runs a completion-safe archive-only cleanup for verified legacy/orphan state. Use `--no-retro`, `--no-cleanup`, `completion.auto_retro: false`, or `completion.cleanup_old_state: false` to opt out.
- **Run-bundle-aware tooling.** Routing stats, telemetry capture, detect skill guidance, internals docs, and README examples now read/write the new layout while retaining legacy compatibility where needed.

### Changed

- `/masterplan retro` remains available manually, but successful completion auto-invokes the retro path by default for low, medium, and high complexity plans.
- `/masterplan clean` remains the broad manual cleanup verb. Step C's automatic cleanup uses only the safe subset: `legacy` and `orphans`, archive mode, current worktree, no prompts, no deletes, no stale/crons/worktrees.

### Migration Notes

- Existing pre-v3 artifacts are not deleted by migration. Run `bin/masterplan-state.sh migrate --write` or `/masterplan import` to copy them into bundles, then let completion cleanup or `/masterplan clean --category=legacy` archive verified originals. This release dogfooded that path: six legacy records were migrated to `docs/masterplan/`, and verified originals were archived under `legacy/.archive/2026-05-08/`.
- Archived legacy records with no original spec keep `artifacts.spec` empty; consumers must tolerate empty artifact values for migrated archived records.

## [2.17.1] — 2026-05-08 — version bump (no functional changes)

Patch release to advance version numbering; no functional changes since v2.17.0.

## [2.17.0] — 2026-05-07 — `--resume=<path>` worktree-aware path resolution

Folds in a fix surfaced during the AUQ-violation investigation (see WORKLOG `2026-05-07 (PM)`). When `/masterplan --resume=<rel-path>` is invoked from a parent of the worktree containing the status file (typical `xcvr-tools-fresh` / `optoe-ng` layout — repo root has `.worktrees/<feature>/docs/superpowers/plans/...`), the path doesn't resolve at cwd and Step 0 previously had no fallback. The user had to manually `cd` into the worktree before re-invoking.

### Added

- **`--resume=<path>` worktree-aware path resolution (`commands/masterplan.md` Step 0; v2.17.0+).** When `--resume=<path>` (or `--resume <path>` / `execute <path>`) is given AND `<path>` is relative AND `test -e <path>` is false against the current working directory, the orchestrator now searches `.worktrees/*/<path>` glob candidates against both `<cwd>` and `<repo-root>` before erroring. Resolution rules:
  - **Exactly one match** → `cd` to that worktree before Step 0's repo-local config reload, emit a one-line stdout notice (`↻ --resume path resolved into worktree <path>; cd'd before Step C config load.`), then proceed to Step C step 1's batched re-read with the resolved absolute path. The repo-local `<worktree>/.masterplan.yaml` is now picked up.
  - **Zero matches** → surface `AskUserQuestion("--resume path '<path>' not found at cwd or in any .worktrees/*/ subdirectory of <cwd> or <repo-root>. What now?", options=["Abort and let me re-run with a correct path (Recommended)", "Search the entire repo for matching status files (slower; uses find . -path '*/<path>')", "Treat <path> as a topic and route to Step A"])`. Preserves the existing `execute <topic>` fallback semantics.
  - **Multiple matches** → surface `AskUserQuestion("--resume path '<path>' matches multiple candidates. Which one?", options=[<one option per candidate, label = '<worktree-path>/<path>', up to 4>, ...])`. If more than 4 candidates, the first 3 are ordered by `last_activity` from each matching status file's frontmatter (descending), plus a fourth "List all in stdout and abort" option.

  Absolute paths bypass the search (existing direct-load behavior unchanged — Step C step 1's parse guard catches missing absolute paths at file-read time).

### Notes

- The orchestrator-side fix complements an out-of-orchestrator hardening pass landing in the same release window: a new `~/.claude/skills/auq-override/SKILL.md` user-level skill plus `hooks/auq-guard.sh` Stop hook (registered in `~/.claude/settings.json`) that warn when an assistant turn ends on a prose question outside an `AskUserQuestion` tool call. These pieces live outside the plugin (user-config territory) and are not shipped via the marketplace; the orchestrator change in this version is the only plugin-side delta.

## [2.16.0] — 2026-05-07 — May 7 failure resolution: per-task CD-9 hole, verb-explicit routing, compaction notice, invocation sentinel

Synthesizes findings from a transcript audit of every May 7, 2026 `/masterplan` session across `~/dev` (16 transcripts, ~36 MB). Two parallel Sonnet survey agents plus a deep-read of `commands/masterplan.md` triangulated four root causes that survived v2.10.x–v2.15.x. Three are orchestrator bugs with prompt-level fixes; one is a Claude Code harness bug we mitigate with a sentinel + docs.

### Fixed

- **Per-task CD-9 hole at Step C step 4→5 (Bug A; `commands/masterplan.md`).** When `/loop` was not active, Step C's post-task finalization fell into step 5's `"skip scheduling silently — the user resumes manually"` branch with no positive directive on what to do next. The orchestrator improvised free-text gates like *"Want me to continue to T11 (per-page content rendering …)? It's a bigger task"* and ended the turn (`stop_reason: end_turn`), violating CD-9. Reproducer: petabit-www 2026-05-07 23:26 (T10→T11 boundary). New **Step C step 4e — Post-task router** routes deterministically by autonomy + `ScheduleWakeup` availability:
  - `/loop` active → step 5 (existing wakeup scheduling, every 3 tasks).
  - `/loop` inactive AND `--autonomy=full` → re-enter step 2 silently with `current_task` updated.
  - `/loop` inactive AND `--autonomy ∈ {gated, loose}` → fire structured per-task gate via `AskUserQuestion(Continue (Recommended) / Pause here / Schedule wakeup)`. Continue dispatches the next task in the same turn; Pause here closes turn via CC-3-TRAMPOLINE; Schedule wakeup calls `ScheduleWakeup` honoring `loop_max_per_day`.
  - All-tasks-done → step 6 (finishing-branch wrap, unchanged).
  - Status flipped to `blocked` → → CLOSE-TURN (4a/4b/4c already wrote `## Blockers`).
  - Wave-end variant: gate fires once per wave (not N times), with task name = `<wave-group> wave (<N> tasks)`.

  New operational rule reinforces this at the top level: *"Per-task boundaries are not natural stopping points. Step C step 4e is the only legal close site between tasks."*

- **`/masterplan execute <topic>` silently routes to brainstorm (Bug B; `commands/masterplan.md`).** When the user typed `/masterplan execute phase 7 restconf`, the routing table only matched `execute <status-path>` — non-path arguments fell into Step A which discarded the explicit `execute` verb when no status files matched. Step A then routed to "Start fresh → Step B" (brainstorm). Reproducer: petabit-os-mgmt 2026-05-07 00:53 (`/masterplan execute phase 7 restconf --complexity=high` produced *"Routing: Step A → no active plans → fresh start → Step B1 (brainstorm)"*; the word "execute" never appeared in any orchestrator output). Three changes:
  - **New routing-table row.** `execute <topic-or-fuzzy-slug>` → Step A with `requested_verb=execute`, `topic_hint=<remaining args>`. The path-vs-topic disambiguation is `test -e <remaining>`.
  - **Argument-parse precedence stash.** Step 0's verb-match step now stashes `requested_verb = <matched-verb>` for downstream steps to consult.
  - **Step A verb-explicit override (new step 7).** Before the existing "Start fresh → Step B" branch, consult `requested_verb`. When `requested_verb == 'execute'` AND user picked Start fresh OR `topic_hint` did not match: surface `AskUserQuestion(Run full kickoff (Recommended) / Pick from existing / Brainstorm-only / Cancel)`. The user's explicit `execute` verb is no longer silently discarded.

- **Compaction-recent state ignored on re-entry (Bug C; `commands/masterplan.md`).** After `/compact` fired, `/masterplan` re-derived state from the filesystem (status files via Step M0) and discarded the compaction summary's workflow position. Reproducer: petabit-os-mgmt 2026-05-07 00:46→00:54 (compaction summary said *"interrupted before Step B1"*; orchestrator at 00:54 re-ran Step 0 + Step A from scratch, output *"Zero status files found across all worktrees"*). New **Step 0 Compaction-recent notice** detects (a) `"session was compacted"` / `"post-compaction"` in the first system reminder, (b) literal `/compact` in the preceding user message, (c) optional best-effort: a `type:summary` jsonl message ≤ 30 minutes old. When detected, emits a single non-blocking line: *"↻ Compaction detected this session — verifying plan state from filesystem. If you intended to resume specific work: `/masterplan --resume=<status-path>`. Otherwise this run will route per the args you typed."* Pairs with Bug B's verb-explicit override — together they catch the case where the user expected to resume but the filesystem disagrees. Conservative by design: no JSONL parsing in the hot path, no pre-routing prompts.

### Added

- **Invocation sentinel (Bug D mitigation; `commands/masterplan.md`).** Before config load, before git_state cache, before verb routing, every `/masterplan` turn emits ONE plain-text first line: *"→ /masterplan v\<version-from-plugin.json\> args: '\<$ARGUMENTS or empty\>' cwd: \<repo-root or pwd\>"*. Makes "did `/masterplan` run?" trivially observable. Reproducer: optoe-ng 2026-05-07 23:14→23:19 (sequence `/compact` → `/plugin` → `/reload-plugins` → `/masterplan --complexity=high` produced **zero assistant response** — last record was a queue-operation, no orchestrator output at all). The sentinel makes the harness-level command-de-registration visible: if the user sees no `→ /masterplan` line, they know to re-install via `/plugin`. CC-3-TRAMPOLINE does not apply — the sentinel is an unconditional first-line render.

- **Self-host audit catches the new free-text gate phrasings (`bin/masterplan-self-host-audit.sh`).** `check_cd9`'s regex extended to flag: `Want me to (continue|proceed|advance|run|execute)`, `Should I (continue|proceed|advance)`, `Shall I (continue|proceed)`, `Let me know (when|if|how)`, `(when|after) you're ready, (let me|I'll)`, `Continue to T<N>?`. Existing exemption logic (cd9-exempt marker, AskUserQuestion proximity, CD-9 rule definition skip, "Don't stop silently" restatement) unchanged — auto-skips legitimate restatements inside the rule-definition section. Catches future regressions of Bug A at audit time before commit.

### Notes

- **Known issue: `/reload-plugins` may de-register `/masterplan`.** After `/reload-plugins`, the next `/masterplan` invocation can produce zero output (observed once on 2026-05-07 in optoe-ng session 0cbe737f). The Step 0 invocation sentinel introduced here makes this observable: if you don't see `→ /masterplan v…` on the first line, the harness has de-registered the command. **Workaround:** re-install via the marketplace (`/plugin` → uninstall → install `superpowers-masterplan`) and re-invoke. v2.13.1's marketplace install self-healing covers fresh installs but does not fire on `/reload-plugins`. Upstream tracking will be filed at the Claude Code repo with the optoe-ng transcript as the reproducer; the URL will be added to this note in a follow-up.
- **No regressions of v2.14.x or v2.15.0.** v2.14.0/2.14.1's `git for-each-ref` import discovery is preserved; v2.14.0's `doctor --fix` for checks #20/#21/#1a is preserved; v2.15.0's doctor end-gate `AskUserQuestion` and noargs precedence rule are preserved. The v2.16.0 fixes are additive.
- **Per-task gate is autonomy-aware by contract.** Under `--autonomy=full` the gate is suppressed (silent advance). Under `/loop` step 5 takes precedence (wakeup scheduling). Under `gated` and `loose` without `/loop`, every task boundary is a structured AskUserQuestion checkpoint per the user's chosen contract from the May 7 review.

## [2.15.0] — 2026-05-07 — doctor end-gate (`AskUserQuestion` offer `--fix`) + noargs resume-first routing fix

### Added

- **Doctor end-gate: offer `--fix` via `AskUserQuestion` after lint-only runs (`commands/masterplan.md`).** When `/masterplan doctor` (without `--fix`) finds at least one auto-fixable issue (checks #1a, #2, #3, #9, #12, #20, #21, #24), it now closes the turn with `AskUserQuestion` asking whether to run `--fix` inline. Picking "Run --fix now" re-executes Step D with `--fix` semantics, emitting only the changed-files list and updated summary (not the full detection report again). Gate is suppressed when `--fix` was already passed, when no auto-fixable findings exist, or when the report is clean. Previously, a lint-only run that found fixable issues was a dead end — the user had to manually type the `--fix` invocation.

### Fixed

- **Bare-invoke argument-parse missing step 0 (`commands/masterplan.md`).** The argument-parse precedence section (in Step 0) listed three match cases (known verb / `--` flag / non-flag word) but had no case for zero-token invocation. A Claude instance reading only this section could fall through all three without a match and route unpredictably (catch-all / Step B / Step A) on a bare `/masterplan` call. Added explicit step 0: "If no args → route to Step M (resume-first)." The verb routing table already had the `_(empty)_` row and Step M0 step 8 already implemented the correct resume-first logic — this closes the prose gap that caused intermittent wrong-step routing.

## [2.14.1] — 2026-05-07 — Step I1 brief tightening: filter symbolic `refs/remotes/<remote>/HEAD` by full refname

Follow-up to v2.14.0 issue #3 fix, surfaced by smoke-testing the v2.14.0 brief against `petabit-os-mgmt` with a Haiku Explore subagent.

### Fixed

- **Step I1 source class 2 brief — symbolic-HEAD ambiguity (`commands/masterplan.md`).** v2.14.0's brief said "exclude `HEAD`" but `git for-each-ref refs/remotes/ --format='%(refname:short)'` renders `refs/remotes/origin/HEAD` as the **bare token `origin`** — NOT catchable by `grep -v HEAD` on the short form. A Haiku running the v2.14.0 brief self-reported the ambiguity verbatim during smoke test: *"the brief says to exclude 'HEAD' but doesn't specify whether to filter on the literal substring 'HEAD' in refname:short output (doesn't appear here), [or] the `refs/remotes/<remote>/HEAD` symbolic ref nature."* It guessed right by interpretation, but a worse-luck run would either drop the bare `origin` (false negative) or flag it (phantom finding when HEAD diverges from `<trunk>`). New brief uses `--format='%(refname)|%(refname:short)'` to emit both forms in one line, instructs Haiku to **filter on the full refname** (drop any line whose full path ends in `/HEAD`), and **use the short name** for display + topology check. Removes the ambiguity at the source.

## [2.14.0] — 2026-05-07 — Step I1 ref enumeration fix + doctor `--fix` actionability (cache rebuild, stray-orphan rm, no-fix diagnostic)

Closes GitHub issues #1 and #3.

### Fixed

- **Step I1 git artifact scan misses remote-only branches (issue #3).** The Haiku brief's `git branch -avv` instruction was being silently downgraded to `git branch -v` (or to local-only iteration) by some agent runs, producing false negatives where remote branches with diverged commits were never flagged. Replaced with explicit `git for-each-ref refs/heads/ refs/remotes/ --format='%(refname:short)'` enumeration in `commands/masterplan.md` Step I1 source class 2. `git for-each-ref` returns one ref per line in a stable format (no parsing ambiguity), and the brief now mandates this command verbatim. Also clarified that the check is topology-based (`git log <trunk>..<ref>` non-empty SHA reachability), not content-based — rebased-equivalent branches are still flagged because the cleanup action is deleting the stale ref, not re-importing the content. Reproducer was petabit-os-mgmt `origin/phase-5-southbound-ipc` (3 commits ahead of main), silently skipped across two consecutive import sessions.

### Added

- **`doctor --fix` extends to checks #20 and #21 (eligibility cache rebuild) — issue #1 Fix 1.** Cache rebuild is deterministic from plan annotations (mirrors Step C step 1's Build path) — no judgment call. The new `--fix` action runs the annotation-completeness scan inline; if complete, the orchestrator builds the cache inline (no subagent dispatch); if incomplete, dispatches one Haiku per the existing fallback path. Writes `<slug>-eligibility-cache.json`, appends `eligibility cache: rebuilt (...) — via doctor --fix` to the status's `## Activity log`, and commits as `masterplan: rebuild eligibility cache for <slug> via doctor --fix`. When both #20 and #21 fire on the same plan (the common case — same root cause, different footprint), one `--fix` invocation resolves both. Closes the largest "10 warnings, 0 fixes" hole in steady-state mature-repo doctor runs.
- **`doctor --fix` extends to check #1 sub-class #1a (stray-duplicate-orphan plans) — issue #1 Fix 2.** New sub-classification fires when an orphan plan has an in-status counterpart in another worktree of the same repo, the orphan is at-or-behind the canonical copy (mtime/hash check), and the orphan's worktree is NOT the worktree the in-status frontmatter points at. The orphan is provably a stale snapshot from a sibling worktree (common after creating a worktree and finalizing the plan elsewhere); `--fix` runs `git rm <stale-path>` per stray plus one commit per affected worktree (`masterplan: remove <N> stray-duplicate orphan plan(s) via doctor --fix`). The original #1 (true orphan, no in-status counterpart anywhere) still has "no auto-fix" — judgment call: the user may have intentional rough notes that aren't ready for masterplan schema.
- **`doctor --fix` actionability diagnostic — issue #1 Fix 3.** When `--fix` ran but produced 0 file changes despite N > 0 findings, surface a top-line warning BEFORE the per-finding details: `⚠ doctor --fix found <N> warnings, 0 of which match the auto-fix action set.` followed by check-grouped one-line remediation hints. Suppresses when ≥ 1 file change occurred (the changed-files list is its own evidence) and when `--fix` was not passed (no-`--fix` runs are read-only by definition). Closes the historical UX failure where users would run `--fix`, get 10 warnings + a buried "0 files changed/moved" line, and conclude `--fix` was broken.

## [2.13.1] — 2026-05-07 — marketplace install self-healing: auto-symlink `/masterplan` slash command

### Fixed

- **`/masterplan` not found after marketplace install.** The Claude Code marketplace installer deploys command files to `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/commands/` but Claude Code's slash-command discovery only scans `~/.claude/commands/`. When the marketplace installer ran, it backed up any prior direct-install copy of `masterplan.md` but did not create a replacement in `~/.claude/commands/`, causing `/masterplan` to vanish from autocomplete.

### Added

- **`hooks/hooks.json` — self-healing SessionStart hook.** On each session start, checks whether `~/.claude/commands/masterplan.md` is a live symlink to the marketplace copy; if missing or dangling, recreates it silently. Mirrors the `hooks/hooks.json` convention used by `obra/superpowers`. Prevents the "upgrade broke /masterplan" class of failures for future reinstalls.

## [2.13.0] — 2026-05-06 — CC-2 threshold tightening + CC-3-TRAMPOLINE close-turn discipline + stats `--plan` slug fix

### Fixed

- **`/masterplan stats --plan=<bare-slug>`** silently returned zero records when callers passed a human-readable slug (e.g., `phase-4-cli-engine-mvp`) because the on-disk status filename includes a `YYYY-MM-DD-` prefix that the equality check never stripped. `bin/masterplan-routing-stats.sh` now falls back to a date-prefix-stripped match when the literal equality fails. Surfaced from real petabit-os-mgmt usage.

### Changed

- **CC-2 — Subagent-delegate triggers tightened (`commands/masterplan.md`).** Bash-output threshold lowered from `> 100 lines` → `> 50 lines`; file-read threshold lowered from `> 300 lines` → `> 50 lines` (orientation reads ≤ 50 still excepted; cumulative reads of the same file count). Added two new triggers: **coordinated edits to ≥ 2 files** for one conceptual change → dispatch a single Sonnet subagent with the full edit-set as the bounded brief; **cumulative inline Edits > 5 within a single turn** for any single file → at the 5th Edit, stop and dispatch Sonnet to complete the rest as a batched edit. Root cause: petabit-os-mgmt Phase 4 telemetry showed Opus consuming ~70%+ of session tokens via inline tool calls that the prior thresholds never caught — the v2.12.0 model-passthrough enforcement only governed *explicitly dispatched* subagents, not the inline work the orchestrator was doing itself.

### Added

- **CC-3-TRAMPOLINE — Canonical turn-close sequence (`commands/masterplan.md`).** New ~20-line operational rule defines a single enforcement point for CC-3. Every turn-close routes through: (1) CC-3 summary if `subagents_this_turn` is non-empty, (2) site-specific pre-close action (commit, status-file write, ledger append, etc.), (3) closer (`AskUserQuestion` / `ScheduleWakeup` / terminal render). Authoring convention: new turn-close sites write `→ CLOSE-TURN`; bare `"end the turn"` reserved for negation contexts ("never end the turn waiting on..."), AskUserQuestion option labels, and YAML/comment blocks. 19 existing turn-close sites converted to the new convention across Steps A/B/C/T/CL (Cancel/Abort/Done/Open spec/Open plan/Discard, blocker policies, daily quota exhaust, wakeup-ledger append, `stats` verb, `clean` verb).

### Notes

- Underlying fix landed in marketplace install copy as commit `24e6546d` during in-session work in `petabit-os-mgmt`; this release brings it into project HEAD with a proper version bump so subsequent plugin updates carry it everywhere.
- Followup for v2.14.0: extend `bin/masterplan-self-host-audit.sh` with a CD-style grep that flags non-negated `"end the turn"` occurrences in `commands/masterplan.md` (per CC-3-TRAMPOLINE's authoring rule).

## [2.12.0] — 2026-05-06 — per-turn subagent summary + model attribution enforcement

### Added

- **Per-turn subagent dispatch summary (`commands/masterplan.md`).** A new sub-section "Per-turn dispatch tracking and summary" mandates the orchestrator track every `Agent` invocation in a session-local list `subagents_this_turn` (reset at every top-level Step entry) and emit a one-line summary at end of every turn that dispatched ≥ 1 subagent. Format: `Subagents this turn: <N> dispatched (<count by model>) • <site> (<model>)`. Zero-dispatch turns emit nothing. The summary surfaces as plain stdout, NOT inside an `AskUserQuestion`, so the user has immediate visibility into what models were used. Cross-validation at next-turn-entry compares the in-memory tracker to the prior turn's `<plan>-subagents.jsonl` records and surfaces a `## Notes` warning on divergence (which would indicate the model-passthrough preamble was paraphrased or dropped by an upstream skill template). New operational rule **CC-3** at line 1981 codifies the end-of-turn render requirement.
- **Verbatim SDD model-passthrough preamble (Recursive application clause).** §Agent dispatch contract's recursive-application paragraph now requires the orchestrator to insert a literal fenced text block as the FIRST paragraph of every `superpowers:subagent-driven-development` and `superpowers:executing-plans` brief — not paraphrase it. The signature string `For every inner Task / Agent invocation you make` is the verifiable sentinel. This closes the gap where prose-only override clauses were being silently dropped, which is the root cause of the `model: "opus"` leakage on inner SDD Task calls.
- **`bin/masterplan-self-host-audit.sh --models` mode.** New `check_model_passthrough()` function: greps `commands/masterplan.md` for the verbatim preamble's signature string (must find ≥ 1), counts explicit `model:` attribution lines, warns on any `model: "opus"` occurrence outside blocker-stronger-model context. Run `bin/masterplan-self-host-audit.sh --models` to lint dispatch-site model attribution before commits.
- **`bin/masterplan-routing-stats.sh --models` mode.** New flag surfaces ONLY the model breakdown section (skips the routing table). Default render now also includes a "Model breakdown" section showing dispatches + token share per model (haiku / sonnet / opus / codex / unknown), plus the existing `opus_share` health metric. Users can run `bin/masterplan-routing-stats.sh --models` at any time to spot-check actual model distribution against the orchestrator's design intent.

### Fixed

- **Doctor check #23 (`Opus on bounded-mechanical dispatch sites`) now uses `AskUserQuestion` per CD-9.** The check itself shipped in v2.8.0 but its auto-fix cell printed plain text — violating the CD-9 rule introduced in later versions. Replaced with a 4-option `AskUserQuestion`: run audit script (Recommended) / investigate transcript / suppress for this plan / skip this finding. Stale `commands/masterplan.md:217-235` line citation also removed (post-merge drift); replaced with section-name reference (`§Agent dispatch contract recursive-application`).

### Notes

- **Why this exists.** User reported seeing nearly 100% Opus usage in `/masterplan` runs. Investigation found: telemetry hook captures the data correctly; Stop hook is wired; default models at each dispatch site are specified. **The gap was that recursive model passthrough through `superpowers:subagent-driven-development` was prose-only with zero programmatic enforcement** — if SDD's upstream prompt template stops parsing the override clause, every inner Task call silently inherits Opus from the parent, and there was no per-turn summary anywhere to surface this to the user. The verbatim-preamble + sentinel-grep pattern (Section 2 of the plan) closes the enforcement gap; the per-turn summary (Section 1) closes the visibility gap.
- **No telemetry data is required for the per-turn summary to work.** Tracking is in-orchestrator-memory; the JSONL cross-check is a safety net that runs only when the Stop hook is installed and a JSONL exists. Users without the hook still get accurate per-turn summaries.
- **Manual smoke-test deferred.** The cross-validation drift detection requires a real `/masterplan execute` turn against an existing plan to populate the JSONL. If the per-turn summary or drift detection misbehaves under real use, file as v2.12.1.
- **Upgrade hint for users with manual `~/.claude/bin/` copies.** v2.12.0 modified `bin/masterplan-routing-stats.sh` (added `--models` flag + Model breakdown render). After plugin update, run `bin/masterplan-self-host-audit.sh --fix` to re-sync the user-level copy, OR manually `cp` the new version over the stale user-level shim.

## [2.11.1] — 2026-05-06 — workflow simplification + skills/ drift detection

### Fixed

- **`/masterplan-detect` slash-command duplication.** A May-3 manual copy at `~/.claude/skills/masterplan-detect/` was shadowing the plugin's own registration, surfacing two `/masterplan-detect` entries in the slash-command list (one user-level, one plugin-namespaced). Cleaned up the user-level copy. The plugin's `skills/masterplan-detect/SKILL.md` continues to provide the registration.
- **`bin/masterplan-self-host-audit.sh` now detects `skills/` drift**, not just `commands/` and `hooks/`. New `check_skill_drift()` function iterates over every skill the plugin ships and warns on user-level shadow copies. Same shim-sentinel exemption pattern as the existing checks (skip if the user-level file contains `<!-- masterplan-shim: v[0-9]+ -->`). Closes the gap that allowed the masterplan-detect duplicate to slip past previous audits.

### Changed

- **Workflow simplification across `commands/masterplan.md`.** Ten sub-steps that existed primarily for documentation organization or pure routing have been inlined into their callers, flattening the structural surface from ~32 to ~21 distinct Step/sub-step headings (~30% reduction):
  - **Step M0 empty-state picker** — Tier 1 / Tier 2a / Tier 2b collapsed into one inline empty-state sub-block with the same option text and routing.
  - **Step P → Step A's spec-without-plan variant.** Step P had only one caller (the `plan` verb with no args/spec).
  - **Step I0 → Step I entry inline.** The "if direct args, skip to I3; else I1" routing is a one-line condition.
  - **Step I3.1 + I3.1.5 → Step I3's pre-flight collision checks.** Slug-collision and path-collision pre-passes combined under one section header.
  - **Step C 4a/4b/4c/4d → "Post-task finalization"** with four labeled internal sub-blocks (Verify, Codex-review, Worktree-integrity, Status-update). Conditional/ordering logic preserved.
  - **Step S4 → Step S3's `--plan` deep-dive branch.** The `--plan=<slug>` variant is a render-mode conditional, not a separate gather phase.
  - **Step I3.3 → inlined into Step I3.4's brief** as a pre-convert phase.
  - **Step I4 → inlined at end of Step I3.5.** The hand-off prompt was a single AskUserQuestion.
  - **Step CL0 → Step CL1's pre-flight block.** Banner emission and worktree-scope narrowing fold naturally into CL1's processing.
  - **Step CL4 → Step CL5's timer-status block.** Pure reporting; appended to the final report.

  All cross-references updated. No user-visible behavior change. No features removed. Wave dispatch, telemetry, complexity meta-knob, `clean` verb, doctor checks, AskUserQuestion options, and config knobs all stay intact. Net file delta: -14 lines (the structural value is in flattening, not byte-count).

### Notes

- The `/masterplan-detect` cleanup is a one-time fix for one user; future installs with deployment-drift will surface via the new `check_skill_drift()` audit.
- Step C's post-task finalization keeps its four internal sub-blocks clearly labeled — readability is preserved despite the flatter outer structure.
- Plugin cache may still contain old version directories under `~/.claude/plugins/cache/.../`. These are managed by Claude Code's plugin install path; `/plugin update` should clean them.

## [2.11.0] — 2026-05-06 — extract self-host checks; shim v2; retro auto-archive; doctor #28

### Fixed

- **`/masterplan` shim now uses slash-command re-invocation (sentinel `<!-- masterplan-shim: v2 -->`).** The v1 shim's body said "Invoke the `superpowers-masterplan:masterplan` skill with $ARGUMENTS", which routed through Claude Code's Skill tool. The Skill tool requires the skill to appear in the session's available-skills list — in some sessions it does not, and `/masterplan` returned "missing skill" forcing users to type the long form (`/superpowers-masterplan:masterplan`) manually. The v2 shim's body is just `/superpowers-masterplan:masterplan $ARGUMENTS`; Claude Code's slash-command resolver intercepts the qualified path at message-receive time, bypassing the Skill tool entirely. Forward-compatible: `bin/masterplan-self-host-audit.sh` matches any `<!-- masterplan-shim: v\d+ -->` sentinel so future shim revisions don't trigger drift warnings.
- **Architectural conflation: doctor checks #25 + #27 moved out of the runtime orchestrator.** Both checks silently skipped outside the `superpowers-masterplan` repo — they only fired when the developer was editing the orchestrator source. Living inside `commands/masterplan.md` meant they consumed prompt-token weight for every `/masterplan` invocation in every user's session despite never producing findings for end users. Extracted to `bin/masterplan-self-host-audit.sh` (developer-only shell script, mirrors the existing `bin/masterplan-routing-stats.sh` pattern). Run with `--fix` to apply drift repairs, `--drift` to scope to deployment-drift only, `--cd9` to scope to free-text-question grep only.

### Added

- **Step R3.5 — auto-archive after retro generation.** When `/masterplan retro` writes a retrospective, the source plan is now `git mv`'d to `docs/superpowers/archived-plans/` and the paired spec to `docs/superpowers/archived-specs/`. Spec collision avoidance: if other plans still reference the same spec, the user is prompted via `AskUserQuestion` whether to archive anyway (rewriting sibling status files), leave the spec, or abort. Behavior is opt-out via `retro.auto_archive_after_retro: false` config or `--no-archive` flag. Step R4 gains a commit-now option that bundles the retro file with the staged archive moves.
- **Doctor check #28 — `completed_plan_without_retro`.** Plan-scoped Warning that detects plans which look complete (status `complete`, OR all task checkboxes are `- [x]`, OR the activity log mentions `final ship` / `release v` / `merged`) but have no sibling retro file. For each finding, surfaces `AskUserQuestion`: "Generate retro + archive (Recommended) / Generate retro only / Skip / Skip all". The "Generate retro + archive" option chains into Step R + Step R3.5. A secondary stale-plan trigger (mtime > 30 days, status: in-progress, no recent activity) offers "Mark complete + retro + archive / Just archive without retro / Skip" so genuinely-abandoned plans can be cleaned without going through the full retro flow.
- **`bin/masterplan-self-host-audit.sh` — developer-only audit script** (new). Implements the deployment-drift comparison and CD-9 free-text-question grep that previously lived as doctor checks #25 and #27. Auto-skips when not run inside the `superpowers-masterplan` repo. Run before commits to catch regressions in the orchestrator source.

### Changed

- **Goal #4 (`Structured questions, never free-text`)** now references `bin/masterplan-self-host-audit.sh --cd9` for the regression guard instead of the (removed) doctor check #27.
- **Doctor parallelization brief** updated: only check #26 remains repo-scoped. Plan-scoped check count is **25** (was 24, +1 for the new check #28). Check #28 is interactive (surfaces `AskUserQuestion` per finding), so per-worktree Haiku doctors return candidate-lists rather than running the prompt themselves; the orchestrator drives the prompts inline after the parallel detection completes.
- **Doctor numbering gap.** Check #25 is removed (extracted to bin/) and check #27 is removed (extracted to bin/). Renumbering would invalidate CHANGELOG/retro references; leaving gaps. Active checks: #1–#24, #26, #28.

### Notes

- Ship sequence today: v2.9.1 (auto-compact nudge fixes) → v2.10.0 (codify CD-9, plugin-shim sentinel recognition for #25) → v2.11.0 (architectural correction + new automation features). v2.10.0's #25/#27 were stepping stones; v2.11.0 finishes the refactor by moving them out of the user-facing orchestrator entirely.
- Migration for users still on shim v1: edit `~/.claude/commands/masterplan.md` to replace the body. The bin script's regex matches both v1 and v2 sentinels, so drift detection won't fire either way.

## [2.10.0] — 2026-05-06 — codify CD-9 (no free-text user questions) + plugin-shim recognition

### Fixed

- **Line 660 branch-mismatch on resume.** Replaced free-text "ask the user before continuing" with explicit `AskUserQuestion` (3 options: switch / continue / abort), mirroring the line-659 worktree-mismatch precedent. CD-9 violation #1 of 2 in the orchestrator.
- **Line 1900 import collision rule + Step I3.1.5 implementation.** Replaced free-text "ask the user: overwrite / write to a -v2 slug / abort" with `AskUserQuestion` syntax. Added new sequential pre-pass step I3.1.5 (path-existence check) between I3.1 (slug-collision) and I3.2 (parallel fetch) — implements the rule (previously the rule had no actual call site). Aborted candidates skip the entire pipeline. CD-9 violation #2 of 2.

### Added

- **Design goal #4 — Structured questions, never free-text.** Promoted CD-9 from a deep-file rule (line 182) to a peer-level architectural goal at the top of the orchestrator (lines 9-16, "Three design goals" → "Four design goals"). First-time readers see the rule without scrolling.
- **Doctor check #27 `orchestrator_free_text_user_question`.** Repo-scoped Warning. Greps `commands/masterplan.md` for forbidden free-text patterns ("ask the user", "prompt the user", etc.) and scans ±20 lines for paired `AskUserQuestion` or `<!-- cd9-exempt: <reason> -->` exemption marker. Skips matches inside the CD-9 rule definitions themselves. Regression guard for Goal #4.
- **Shim exemption in doctor check #25 (self-host deployment drift).** When the user-level `~/.claude/commands/masterplan.md` contains the literal sentinel `<!-- masterplan-shim: v1 -->`, treat it as a managed plugin shim and skip the md5 comparison for that path (emits an info-line note instead of a drift Warning). Hook and bin/ script have no shim concept and compare normally. Closes Phase B from the prior planning session.

### Notes

- Investigation found CD-9 was *already* baked into the project (lines 182, 1903) and not actually dependent on user-level `~/.claude/` settings as initially suspected. The two known violations were within the orchestrator itself; doctor #27 is the regression guard.
- See plan: `~/.claude/plans/curious-coalescing-rose.md` (v2.10.0).

## [2.9.1] — 2026-05-06 — auto-compact nudge fixes

### Fixed

- **Auto-compact nudge wording.** The kickoff/resume nudge previously advised running `/loop … /compact …` "in another shell or session" — backward, since `CronCreate` jobs are session-scoped and the cron fires into the session that *created* it. Reworded to "in this same session" and added disclosure of the unconditional-firing tradeoff so users on shorter plans can self-select longer intervals or opt out via `auto_compact.enabled: false`.

### Added

- **Config validator** for `auto_compact.interval` empty/null when `auto_compact.enabled == true`. Prevents the silent degrade-to-dynamic-mode failure (no-interval `/loop` routes through `ScheduleWakeup`, which cannot fire built-in `/compact`). Skips the nudge for this run and warns.
- **Doctor check #26** `auto_compact_loop_attached`. Verifies a `/compact` cron is actually attached to the current session when one or more plans were nudged. Repo-scoped (runs once per doctor invocation), Warning severity. Surfaces the user error of running the loop in the wrong shell.

### Notes

- Mechanism critique resolved (no behavior change needed): fixed-interval `/loop 30m /compact …` does fire built-in compaction via the harness's `CronCreate`-mode interception path, per the documented `<<autonomous-loop>>` sentinel. Dynamic-mode `/loop /compact` (no interval) does NOT fire built-ins — the new validator is the guardrail against accidentally landing in dynamic mode.
- See spec: `docs/superpowers/specs/2026-05-06-auto-compact-nudge-fixes-design.md`.

## [2.9.0] — 2026-05-06

### Added

- **Doctor check #25 — Self-host deployment drift.** Repo-scoped check that
  fires once per `/masterplan doctor` run when `git config --get
  remote.origin.url` matches `superpowers-masterplan`. Compares md5 of
  three runtime files the user's Claude Code session loads against
  project HEAD: `~/.claude/commands/masterplan.md`,
  `~/.claude/hooks/masterplan-telemetry.sh`,
  `~/.claude/bin/masterplan-routing-stats.sh`. Each file flagged when md5
  differs OR is missing user-side AND the plugin is NOT registered in
  `~/.claude/plugins/installed_plugins.json` (plugin install is the
  legitimate "no legacy file" case). With `--fix`: per-file, backup as
  `<path>.bak-pre-<utc-ts>` and `cp` from HEAD; `chmod +x` on the hook +
  bin script; `mkdir -p ~/.claude/bin/` if absent; verify md5 match.
  Surfaces as Warning. Severity is intentional — drift doesn't break
  anything immediately; it just means recently-shipped fixes aren't
  loaded yet, which is exactly the foot-gun this check exists to catch.

### Why

In v2.8.0's release session we discovered that ~593 lines of fixes
shipped across v2.0.0 → v2.8.0 (model: passthrough contract, /masterplan
stats verb, opus_share telemetry metric, doctor check #23 model-leakage
detection) had been sitting at HEAD in the project repo without ever
reaching the user's runtime. Claude Code was loading the slash command
from `~/.claude/commands/masterplan.md` — a manual copy made before the
plugin system existed and never re-synced. The user reported "100% Opus
utilization" that prior fix attempts didn't dent; root cause was that
none of the fixes had actually deployed. Check #25 surfaces this drift
at lint time rather than at the next time the symptom recurs.

Companion cleanup: the parallelization brief now correctly says "all 24
plan-scoped checks" (was incorrectly "all 22 current checks PLUS new
check #22 (added by Task 13)" — leftover wording from the
complexity-levels plan that wasn't updated when v2.8.0 added checks #23
and #24). Repo-scoped #25 is called out separately in the brief since
it doesn't fit the per-plan complexity-aware check-set gate.

## [2.8.0] — 2026-05-05

### Added

- **Eligibility cache schema versioning (closes audit finding D.2).** The
  cache JSON now carries a top-level `cache_schema_version: "1.0"` field
  emitted on every write (inline-build path, Haiku brief, atomic rotate).
  Load-side validation rebuilds on missing-or-mismatch field with a new
  activity-log variant: `eligibility cache: rebuilt — schema version
  mismatch`. Pre-v2.8.0 caches lacking the field rebuild on next Step C
  entry. Closes the gap where a stale cache from a prior plugin version
  could silently consume routing decisions made under different
  eligibility rules.

- **Step 4b mid-plan codex availability re-check (closes D.4).** Step 4b's
  third gate condition now triggers an inline availability re-check (per
  the Step 0 detection heuristic) at gate time. On miss: writes the
  standard degradation marker (activity log + `## Notes`), flips in-memory
  `codex_review = off` for the rest of the session, and skips 4b. Catches
  the mid-plan plugin-uninstall case where Step 0 saw codex present but
  the plugin was removed before review fired.

- **Ping-based codex availability detection (closes D.1).** Step 0's
  fragile `codex:` prefix string-scan is replaced by an actual no-op
  dispatch ping that exercises the codex subagent_type. Result is cached
  as `codex_ping_result` per invocation; subsequent steps consult the
  cache. New config flag `codex.detection_mode` (`ping` | `scan` | `trust`,
  default `ping`) lets users opt into the legacy scan or the
  detection-skipping `trust` mode for locked-down accounts. New
  activity-log variant differentiates plugin-missing from
  plugin-present-but-broken.

- **Doctor check #23 — Opus on bounded-mechanical dispatch sites (closes
  C.1).** Telemetry-driven post-mortem detection of model-passthrough
  leakage. Scans the most recent 20 records in `<slug>-subagents.jsonl`
  for SDD/wave/Step-C-step-1 dispatches running on Opus, excluding the
  intentional-Opus-re-dispatch case (matched against
  `prompt_first_line`). Surfaces as Warning with mitigation advice
  pointing at `commands/masterplan.md:217-235` (the §Agent dispatch
  contract). Parallelization brief check-count bumps to 24.

- **Post-hoc slow-member detection (closes E.1, reframed).** The original
  E.1 design called for active wave-member cancellation at a 600s
  timeout, but an LLM orchestrator has no async/cancel primitive for
  in-flight Agent calls — the prose would have been runtime-unenforceable.
  Reframed as post-hoc detection: after the wave-completion barrier
  returns, the orchestrator reads each member's `duration_ms` from
  `<slug>-subagents.jsonl` (already captured by the telemetry hook) and
  tags any whose duration exceeds `config.parallelism.member_timeout_sec`
  (default 600s) as `slow_member` at the NEXT Step C entry. Behavior per
  `config.parallelism.on_member_timeout`: `warn` (default — Notes
  warning) or `blocker` (re-classify and route through the blocker gate).
  No-op when the telemetry hook is not installed. Detection is
  observability, not active cancellation.

- **Step 4d concurrent-write guard via `flock` (closes F.4).** The Step
  4d update sequence (rotation + append + atomic temp+fsync+rename) now
  wraps in `flock <status-file> -c '...'` with a 5s timeout. On
  contention (typically a user-editor saving the status file in another
  window), the would-be entry queues to `<slug>-status.queue.jsonl` and
  the next 4d cycle drains it BEFORE its own append; replays are
  idempotent (match-by `last_activity` + first 80 chars). flock-
  unavailable hosts (Windows / no util-linux) fall through to unguarded
  write with a once-per-session warning. New doctor check #24 surfaces
  non-empty queue files post-session; `--fix` replays the queue.

- **Step 4a excerpt-validator on the trust contract (closes G.1).** The
  trust-skip is no longer license alone — it requires evidence of
  execution. New required field `commands_run_excerpts: {cmd → [str]}` on
  the implementer's return digest carries 1–3 trailing output lines per
  command. The orchestrator regex-matches each excerpt against the plan
  task's `**verify-pattern:** <regex>` annotation (if present) or a
  default PASS pattern (`PASSED?|OK|0 errors|0 failures|exit 0|✓`). On
  miss, that command falls through to inline re-run with a tagged
  activity-log entry; on missing field entirely, all commands re-run with
  a once-per-session `## Notes` warning. Closes the gap where a
  fabricated `tests_passed: true` would silently pass.

### Why

The v2.8.0 cycle is the first defensive-correctness pass driven by
`docs/audit-2026-05-05-subagent-execution.md`, an end-to-end audit of the
orchestrator's subagent-dispatch and verification surfaces. Each closed
finding had a documented gap between "convention" and "structurally
enforceable"; this release converts the seven highest-severity cases.
The remaining audit findings (G.2-G.6, A.1, F.1-F.3, H-class, E.2-E.5)
are catalogued for v2.9.0+ as scoped follow-ups.

## [2.7.0] — 2026-05-05

### Added

- **Step C step 1 inline fast-path for the eligibility cache.** When every plan
  task carries a well-formed `**Codex:** ok|no` annotation paired with a
  non-empty `**Files:**` block, the orchestrator now builds the eligibility
  cache inline (parsing annotations + applying the parallel-eligibility rules
  directly) instead of dispatching the Haiku subagent. Two new activity-log
  variants distinguish the path: `eligibility cache: built inline (...)` and
  `eligibility cache: rebuilt inline (...)`. The Haiku is preserved for plans
  with under-annotated tasks, where heuristic application (judgment) still
  belongs in a subagent per the context-control architecture. Doctor #21's
  regex (`eligibility cache:`) matches both inline and Haiku-built variants —
  no doctor-side change required.
- **Annotation-completeness verifier (CD-3 evidence anchor).** The inline
  shortcut activates only when ALL tasks pass a structural validation: any
  malformed annotation, missing `**Files:**` block, or unknown `**Codex:**`
  value silently falls back to Haiku dispatch. Analogous to Step 4a's
  implementer-return trust contract — the orchestrator never trusts data it
  can't structurally validate.
- **Wave-pin precedence note (decision-tree clarification).** The Step C step
  1 decision tree now explicitly lists `cache_pinned_for_wave == true` as the
  first short-circuit, before any other bullet evaluates. Behavior is
  unchanged from prior (the **Skip-with-pinned-cache exception** block already
  documented this normatively); the new ordering removes ambiguity for
  readers landing in the imperative "step 1, 2, 3" Build-path structure.

### Why

Most measurable win: at `complexity == high`, every Step C step 1 cache build
is now mechanical extraction (no Haiku dispatch). Saves the Haiku roundtrip
(~10–30s wall + tokens) on every fresh build and every plan-edit-driven
rebuild. At `medium`, kicks in opportunistically when writing-plans happens to
annotate every task. At `low`, irrelevant — the cache is skipped entirely.

The change resolves feedback that called out the Step C step 1 Haiku as
re-derivation of structured data already present in the plan file. The
trust-contract anchor (plan-file annotations as the structured return)
generalizes the Step 4a `tests_passed` / `commands_run` pattern to
cache-build.

## [2.6.0] — 2026-05-05

### Added

- **New `/masterplan clean` verb** (Step CL) — automates the cleanup that
  previously required hand-running `git mv` + `mkdir` + commit per artifact.
  Doctor detects orphans + cruft; clean remediates. Five categories:
  - **Completed plans** — archive plan + status + every sidecar
    (`<slug>-eligibility-cache.json`, `<slug>-telemetry.jsonl`,
    `<slug>-subagents.jsonl`, `<slug>-status-archive.md`, etc.) to
    `<config.archive_path>/<status.last_activity-date>/`.
  - **Orphan sidecars** — reuses Step D check predicates (#11, #13, #14, #19)
    to find sidecars whose sibling status file no longer exists; archives them.
  - **Stale plans** — `status: in-progress | blocked` with `last_activity > 90
    days`. Per-item `AskUserQuestion` (Archive / Keep / Skip) — never
    auto-archives stale items because staleness is a judgment call.
  - **Dead crons** — calls `CronList`, finds duplicates by exact prompt match,
    `CronDelete`s the non-oldest. Same predicate as doctor #19 with `--fix`.
  - **Dead worktrees** — `git worktree list` entries whose path is missing on
    disk; `git worktree remove --force` per stale entry.
- **Flags:** `--dry-run` (preview without changes; skips confirmation gate),
  `--delete` (archival categories `git rm` instead of `git mv` to archive
  path; OS-level categories always delete), `--category=<name>` (limit to one
  or comma-separated subset of `completed|orphans|stale|crons|worktrees`),
  `--worktree=<path>` (limit per-worktree scan to one path).
- **Confirmation gate:** structured summary + `AskUserQuestion(Apply all /
  Apply selected categories / Cancel)` before any execution. `--dry-run`
  skips the gate. Mirrors `/masterplan import`'s cruft-handling pattern but
  with a single up-front confirm rather than per-candidate prompts.
- **Per-category atomic commits:** `clean: archive N completed plan(s)`,
  `clean: archive M orphan sidecar(s)`, `clean: archive K stale plan(s)`.
  OS-level categories (crons, worktrees) skip the commit step.
- **Skip rule:** Step CL never touches files inside `<archive_path>/` —
  re-running clean on an already-cleaned tree produces `clean: nothing to do`.

### Changed

- Doctor remains read-only by default. The destructive/archival path moved
  to the new clean verb so doctor's `--fix` action stays scoped to its
  current narrow set (auto-fix only on check #2 today). Future doctor `--fix`
  expansions will defer to clean for archival categories.

## [2.5.0] — 2026-05-05

### Added

- **3-level `complexity` variable** (`low | medium | high`) at every config tier
  (CLI flag `--complexity=<level>`, `~/.masterplan.yaml`, repo `.masterplan.yaml`,
  status frontmatter). Sets defaults for `autonomy`, `codex_routing`,
  `codex_review`, `parallelism.enabled`, `gated_switch_offer_at_tasks`, and
  `review_max_fix_iterations` per the precedence table in Operational rules.
  Explicit overrides (CLI flag, frontmatter, config) win over complexity-derived
  defaults. `medium` is the default and preserves all current behavior; existing
  plans without the field are read as `medium` (no migration needed).
- **`low` skips:** eligibility cache build, telemetry sidecar, wakeup ledger,
  parallelism waves, codex routing + codex review. Activity log uses one-line
  entries; rotation threshold drops to 50 (archives most recent 25). Plan-writing
  brief produces leaner plans (~3–7 tasks, optional `**Files:**`, no annotations).
  Doctor at low runs only checks #1–#10 + #18 (skips sidecar/annotation/ledger
  checks that don't apply).
- **`high` adds:** `codex_review` always on with `review_prompt_at: low`;
  required `**Files:**` + `**Codex:**` annotations per task; eligibility cache
  validated against the plan's `**Files:**` blocks; verification re-runs
  implementer's tests; retro becomes a recommended option at plan completion;
  new doctor check #22 (high-only) fires when a high plan lacks all three
  rigor signals (retro reference, codex review pass, `[reviewed: …]` tags).
- **Kickoff prompt:** when `--complexity` is not on the CLI and no config tier
  sets it, /masterplan surfaces one `AskUserQuestion` between worktree decision
  and brainstorm (kickoff verbs only). Setting any value in any config tier
  silences the prompt.
- **Activity-log audit line** at first Step C entry per session: cites the
  resolved complexity, its source (`flag` / `frontmatter` / `repo_config` /
  `user_config` / `default`), and any knobs whose final value differs from the
  complexity-derived default.

## [2.4.1] — 2026-05-05

### Added
- **Competing-scheduler check** at Step C step 1. Defensive guard against an
  externally-created cron (e.g., a stale `/schedule` one-shot, a leftover from
  a prior session) that targets the same plan as `/loop`'s `ScheduleWakeup`
  self-pacing. `/masterplan` itself never calls `CronCreate`, so this is not a
  fix for an internal code path — it is a runtime guard against a footgun
  introduced by other plugins or earlier user actions. When the orchestrator
  detects a cron whose prompt starts with `/masterplan` AND contains the
  status file's basename, it surfaces an `AskUserQuestion` with four options:
  delete the cron (Recommended), suspend `/loop` wakeups for the session, keep
  both (with a one-time acknowledgement that suppresses future warnings via
  `competing_scheduler_acknowledged: true` in frontmatter), or abort. Skips
  silently when `ScheduleWakeup` is unavailable, when `CronList`/`CronDelete`
  schemas can't be loaded via `ToolSearch`, or when the acknowledgement flag
  is set. Honest scope: the check fires after the current resume already
  started, so it cannot prevent the very-next concurrent firing — only future
  ones, after the user picks delete or acknowledges.

## [2.4.0] — 2026-05-04

### Added
- New `/masterplan stats` verb (Step T) — codex-vs-inline routing distribution,
  inline model breakdown (Sonnet/Haiku/Opus when activity logs carry
  `[subagent: <model>]` tags or `<plan>-subagents.jsonl` is populated), token
  totals by `routing_class`, decision-source breakdown, and per-plan health
  flags (degraded / cache-missing / silent-skip-suspected). Backed by new
  `bin/masterplan-routing-stats.sh` (~280-line bash + python3) supporting
  `--plan=<slug>`, `--format=table|json|md`, `--all-repos`, `--since=<date>`.
- New `unavailable_policy` config key under `codex:`. Default `degrade-loudly`
  preserves Fix 1 behavior (warn + degrade). Opt-in `block` halts before B/C/I
  with status: blocked when codex_routing != off and the codex plugin is
  unavailable. For users who'd rather a stuck plan than silent-codex-skip.
- Two new doctor checks. **#20**: codex_routing configured but eligibility
  cache file missing AND activity log shows ≥1 routing/completion entry —
  catches the cache-FILE footprint of silent codex degradation. **#21**: same
  symptom from the activity-log angle (no `eligibility cache:` evidence
  entries from Step C step 1) — catches the protocol-violation footprint.
  Total checks: 21.
- Pre-dispatch routing visibility. Step C step 3a now emits a `routing→CODEX`
  or `routing→INLINE` activity-log entry BEFORE dispatching, plus a stdout
  banner for real-time observability during /loop runs. Step 4b emits
  `review→CODEX` or `review→SKIP` symmetrically. Eligibility cache extended
  with `dispatched_to`/`dispatched_at`/`decision_source` runtime-audit fields.

### Changed
- Step 0 codex-availability detection no longer silently records degradation
  "on the next status-file write." Degradation now writes immediately on the
  next status update of the run (Step B3 close, Step C step 1's first write,
  or Step I3) AND emits a visible stdout warning + `## Notes` one-liner. If
  no status write would naturally happen this turn, the orchestrator forces a
  `## Notes`-only update so the marker lands. Per-task pre-dispatch banners
  (Fix 5) carry a `(codex degraded — plugin missing)` suffix when degradation
  is in effect.
- Step C step 1 now emits a mandatory `eligibility cache: <verdict>`
  activity-log entry per Step C entry (built / rebuilt / loaded / skipped
  variants + wave-pinned exception). Makes the silent-skip failure mode
  impossible to hide; doctor check #21 surfaces the absence at lint time.
- Step C step 3a now HALTS when codex_routing != off and eligibility_cache is
  missing — no more silent fallthrough to inline. Branches on
  `config.codex.unavailable_policy`: `degrade-loudly` surfaces a 4-option
  AskUserQuestion (Rebuild cache / Run inline with degradation marker / Set
  codex_routing: off / Abort); `block` sets status: blocked with a
  wave-mode-aware single-writer exception.
- Step C step 1 now performs a resume sanity check on every resume entry: scans
  the activity log for `**Codex:** ok`-annotated tasks completed inline without
  a `degraded-no-codex` decision_source. If found, surfaces a `## Notes`
  warning + 4-option AskUserQuestion (Continue / Run doctor / Investigate
  transcript / Suppress). Forensic recovery for plans that experienced silent
  codex-skip in a prior session.
- Stop hook (`hooks/masterplan-telemetry.sh`) now walks linked worktrees:
  fans out across `<root>/.worktrees/*/docs/superpowers/plans/`, matches by
  `worktree:` field equality OR `$PWD` prefix OR branch, picks
  most-recently-modified candidate. Resolves `plans_dir` to the chosen status
  file's parent so sidecar JSONLs land alongside worktree-resident plans
  (previously invisible to the hook).
- Stop hook subagent capture now dedups by `agent_id` (replacing the v2.3.0
  plan-keyed line cursor). Old cursor was invisible to multi-session runs and
  silently dropped dispatches — typical symptom: 0-line subagents.jsonl
  despite many actual dispatches. New mechanism reads existing JSONL into a
  seen-set and skips records already emitted. Each emission now carries a
  `routing_class` field (`"codex"` / `"sdd"` / `"explore"` / `"general"`)
  for greppable codex-routing distribution analytics.

### Fixed
- Codex degradation pattern silently bypassed all routing in optoe-ng
  project-review (root cause pinned to a specific transcript: 7 agents
  dispatched, zero codex-rescue, zero Step 0 warning text emitted, zero
  eligibility cache writes). Fixes 1-5 + P1-P5 prevention layer ensure
  silent recurrence is impossible: the orchestrator either has a populated
  eligibility cache + visible routing tags OR it has loud user-facing
  prompts + persistent markers — never quiet inline-bypass.
- Stop hook telemetry/subagents JSONL siblings now land for worktree-resident
  plans (previously invisible). Doctor check #19 description acknowledges the
  legacy `<slug>-subagents-cursor` files (deprecated v2.4.0) as harmless.
- Doctor table parallelization brief count synced across `commands/masterplan.md`
  and `docs/internals.md` (20 → 21 with the two new checks).

## [2.3.1] — 2026-05-04

### Changed
- Bare `/masterplan` is now resume-first: it auto-continues the current/only
  in-progress plan, opens the resume picker when active work is ambiguous, and
  shows the broad phase/operations menu only when no active plan exists.
- README install docs now include a Claude Desktop Code-tab path, scope guidance,
  and the `/superpowers-masterplan:masterplan` collision fallback.

### Fixed
- Runtime telemetry sidecars are now protected from accidental commits. This
  repo ignores generated `*-telemetry*.jsonl`, `*-subagents*.jsonl`, and
  `*-subagents-cursor` files, and downstream hook/Step C telemetry writers add
  matching patterns to `.git/info/exclude` before writing. If telemetry files
  are tracked or cannot be ignored, telemetry is skipped instead of written.

## [2.3.0] — 2026-05-04

**Model-dispatch contract + per-subagent telemetry layer.** Two threads bundled
into one minor release:

1. **Cost-leak fix.** Subagent dispatches now structurally require the `model:`
   parameter at every site (was prose-only). Without this, subagents inherited
   the orchestrator's Opus 4.7 silently — a real 2-day /masterplan-heavy session
   consumed 94% Opus ($458 of $487) despite the design intent of Haiku for
   mechanical extraction and Sonnet for general implementation.
2. **Per-subagent observability.** Stop hook now captures one record per Agent
   dispatch into `<plan>-subagents.jsonl`, with full token breakdown
   (`input/output/cache_creation/cache_read`), duration, dispatch-site
   attribution, subagent_type, model, and tool_stats. Six jq cookbook recipes
   added so "find the biggest token consumers and optimize them" is tractable
   instead of guessing.

### Added
- **`### Agent dispatch contract` subsection** under `## Subagent and
  context-control architecture` in `commands/masterplan.md`. Normative MUST
  language plus a value-by-use table (`haiku` = mechanical, `sonnet` =
  implementation, `opus` = user-escalated only). Includes a recursive-application
  clause for skill invocations and a Codex exemption.
- **Recursive override clause for SDD invocation** at Step C step 2. Tells
  `superpowers:subagent-driven-development` to pass `model: "sonnet"` on its
  inner Task calls (implementer / spec-reviewer / code-quality-reviewer) —
  required because SDD's prompt-template files are upstream and don't carry
  model parameters by default.
- **`<plan>-subagents.jsonl`** stream — one record per subagent dispatch
  emitted by `hooks/masterplan-telemetry.sh`. Cursor-based incremental parsing
  via `<plan>-subagents-cursor` keeps the hook fast on long sessions.
- **`DISPATCH-SITE:` tag convention** for every Agent brief — a central
  contract table in `commands/masterplan.md` enumerates the 14 dispatch-site
  values so the hook can attribute cost to orchestrator-step granularity
  (Step A vs Step C step 1 vs wave vs SDD vs etc.).
- **Doctor check #19** — orphan `<plan>-subagents.jsonl` /
  `<plan>-subagents-cursor` files (sibling to a missing status file). Suggests
  archive on `--fix`. Doctor check #12 extended to also catch
  `<plan>-subagents.jsonl > 5 MB`; rotates to `-archive.jsonl`.
- **Six jq cookbook recipes** in `docs/design/telemetry-signals.md`:
  top-N dispatches by total tokens, per-subagent_type aggregates,
  per-dispatch-site aggregates, per-model breakdown by site,
  anomaly detection (>2σ above type mean), cost trend over 14 days.
- **First automated runtime smoke test** for the project: hand-crafted JSONL
  fixture with three Agent dispatches verifies the hook's record emission,
  cursor advancement, and idempotence under re-runs.

### Fixed
- **14 inline dispatch sites** in `commands/masterplan.md` now carry explicit
  `model:` instructions: Step A status parse (`haiku`), Step B0 worktree scan
  (`haiku`), Step C step 1 eligibility cache builder (`haiku`), Step C step 2
  wave dispatch (`sonnet`), Step C step 2 SDD invocation (`sonnet`, recursive
  override), Step C step 3 Codex EXEC (exempt note), Step C 4b Codex REVIEW
  (exempt note), Step I1 discovery (`haiku`), Step I3.2 fetch (per-candidate
  `haiku` / `sonnet` / no-Agent), Step I3.4 conversion (`sonnet`), Step S1
  situation gather (`haiku`), Step R2 retro source (`haiku`), Step D doctor
  (`haiku`), Completion-state inference (`haiku`).
- **Blocker re-engagement gate option 2** ("Re-dispatch with a stronger model")
  now actually dispatches with `model: "opus"` on the re-dispatch Agent call.
  Previously a UI-only promise — the option label promised behavior the prompt
  didn't structurally deliver.

### Migration notes
- **Hook re-install required.** `hooks/masterplan-telemetry.sh` gained ~120
  lines (subagent-capture pipeline). Users with the hook installed at
  `~/.claude/hooks/masterplan-telemetry.sh` must `cp` the new version per the
  README install instructions. Old hook continues working (still emits
  per-turn records) but doesn't capture per-dispatch data.
- **Existing telemetry files keep working.** `<plan>-telemetry.jsonl` schema
  is unchanged from v2.2.x. New `<plan>-subagents.jsonl` and
  `<plan>-subagents-cursor` files appear once the new hook runs.
- **No config or status schema change.** Status frontmatter unchanged. Doctor
  table now 19 rows (was 18). CD-rule numbering (CD-1…CD-10) unchanged — the
  dispatch contract lives under `## Subagent and context-control architecture`,
  not as a new CD rule.
- **SDD upstream not modified.** The model-passthrough override contains the
  fix to `/masterplan`. If future upstream SDD changes ignore the override
  clause, fallback is to wrap SDD invocation in an outer `Agent(subagent_type:
  "general-purpose", model: "sonnet", ...)`.

### Verification
- 10 grep discriminators (contract section landed once, ≥14 `model:`
  parameters, Codex exemption notes ≥2, opus-on-blocker wire-up,
  `<plan>-subagents.jsonl` referenced in hook, 14 `DISPATCH-SITE` values in
  the contract table, doctor check #19 + Step D brief at "all 19 checks",
  new schema in telemetry-signals.md, version bumps consistent across
  CHANGELOG/README/plugin.json/marketplace.json).
- `claude plugin validate .` — clean.
- `bash -n hooks/masterplan-telemetry.sh` — clean.
- Smoke fixture against the new hook (3 dispatches → 3 records, cursor
  advancement, idempotence on re-run).

## [2.2.3] — 2026-05-04

**Marketplace-readiness patch.** Fixes Claude Code plugin validation blockers
and adds the missing repository marketplace catalog needed by the documented
install path.

### Added
- **`.claude-plugin/marketplace.json`** — publishes this repository as a
  self-contained marketplace named `rasatpetabit-superpowers-masterplan`, with
  the `superpowers-masterplan` plugin sourced from the repository root.
- **Dependency metadata** — declares `superpowers@claude-plugins-official` as
  the required upstream plugin and allowlists the official marketplace for that
  cross-marketplace dependency.
- **`docs/release-submission.md`** — durable submission checklist and form-copy
  draft for the Claude plugin directory / Anthropic Verified review request.

### Fixed
- **`plugin.json` schema drift** — `repository` is now the string form required
  by current Claude Code validation, not an npm-style `{type,url}` object.
- **`commands/masterplan.md` frontmatter** — quoted the description so the
  colon in `Verbs:` parses as YAML instead of dropping metadata at runtime.
- **Manifest description** — shortened to a marketplace-friendly summary rather
  than embedding release-history detail in plugin metadata.

### Verification
- `claude plugin validate .`
- `claude plugin validate .claude-plugin/plugin.json`
- `jq empty .claude-plugin/plugin.json .claude-plugin/marketplace.json .claude/settings.local.json`
- `bash -n hooks/masterplan-telemetry.sh`
- `git diff --check`
- Isolated clean install smoke with a temporary `HOME`, official marketplace
  dependency resolution, local marketplace add, and
  `claude plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan`.

## [2.2.2] — 2026-05-04

**Removed standing "no backward-compat / hard-cut renames" rule.** Documentation-only patch. Going forward, decisions about migration aliases for breaking renames are made case-by-case rather than dictated by a project-level prohibition.

### Removed
- **`CLAUDE.md` "Top anti-patterns" #2** — the "Don't add backward-compatibility shims when renaming things" rule. Surrounding 5 (renumbered) anti-patterns stay.
- **`docs/internals.md` `### Why hard-cut name changes` subsection** plus the corresponding bulleted entry under "Architectural anti-patterns".
- **Project-scoped auto-memory entry** (`feedback_no_backward_compat_aliases.md` + its `MEMORY.md` index line). Project memory is reset on this topic.

### Changed
- **README top-of-file rewritten.** New tagline and `## Key benefits` section with three structured categories (long-term planning consistency, token efficiency, cross-checking via Codex) replace the previous "Overview" + "What it provides" prose. Substance unchanged; framing now leads with concrete user-facing benefits before drilling into install + command surface.
- **`WORKLOG.md` v2.2.0 entry** — two policy-framing references scrubbed (the deleted `Why hard-cut renames` heading rewrite reference; the "Hard-cut, no alias." preface on the verb-rename narrative). Functional record of what changed in v2.2.0 unchanged.

### Migration notes
- **No code or behavior change.** Orchestrator, status schema, command surface, and config schema all unchanged. Past breaking renames (`new → full`, `claude-superflow → superpowers-masterplan`, etc.) stay shipped — only the rule that drove those decisions is being removed.
- **No replacement rule added.** Future renames are now case-by-case. If you want a heuristic: prefer hard-cuts for tiny user surfaces (e.g., a single command verb) and consider migration aliases when renaming high-traffic config keys or frequently-typed paths.

## [2.2.1] — 2026-05-04

**Inline status preamble on bare `/masterplan`.** Patch release adding orientation + doctor-tripwire signal to the bare-invocation flow; cleanup pass also removes stray feature branches + worktrees from origin in preparation for wider public visibility.

### Added
- **Step M0 — Inline status orientation on bare `/masterplan`.** Before the Tier-1 picker fires, the orchestrator emits a structured plain-text preamble: headline (`<N> in-flight, <M> blocked across <W> worktrees`), up to 3 in-flight/blocked plan bullets with `current_task` + age, optional `… and N more` tail, and an optional `· <K> issue(s) detected — consider /masterplan doctor` tripwire flag. The tripwire runs 7 cheap inline checks (subset of the 18 doctor checks: #2 orphan status, #3 wrong worktree, #4 wrong branch, #5/#6 stale, #9 schema violation, #10 unparseable) — all derivable from frontmatter + the `git_state` cache already in memory; no Haiku dispatch. The empty-state line is `No active plans.` Step A consumes a `step_m_plans_cache` short-circuit when invoked from "Resume in-flight" so the worktree scan doesn't run twice.

### Changed
- **"Stay on script" guardrail** at Step M's Notes updated (not replaced) to acknowledge M0's structured preamble while reaffirming the no-tangents rule and explicitly forbidding per-check enumeration in the preamble — that remains `/masterplan doctor`'s job. Doctor table size stays at 18; M0 reuses checks by name + semantics, no new check #19.

### Fixed
- Documentation now consistently describes the v2.2.0 surface: bare `/masterplan` opens the two-tier picker, README release/status text names v2.2.0 as current, README's full config schema matches the v2.x defaults, and `docs/internals.md` mirrors the Step M empty-argument route.
- README simplified into a tighter user guide, and command prompt docs now match the advertised public surface: `--no-codex-review` is listed as the `--codex-review=off` shorthand, `--parallelism` is documented as a run/config override rather than a status-frontmatter field, and stale future-only wording for Slice α parallelism is removed.

### Migration notes
- **Purely additive on bare `/masterplan`.** Direct verb invocations (`/masterplan full ...`, `/masterplan execute`, etc.) are unchanged — M0 only fires for empty `$ARGUMENTS`. Existing plans, status files, and `.masterplan.yaml` configs work unchanged.
- **No new doctor check.** M0's tripwire reuses existing checks #2/#3/#4/#5/#6/#9/#10 evaluated inline. The full `/masterplan doctor` lint surface is unchanged at 18 checks.

## [2.2.0] — 2026-05-04

**Doc revisionism + verb rename + no-args picker.** Three threads bundled. The bare `/masterplan` invocation now opens a two-tier picker menu (category → specific verb) so first-touch users don't have to memorize the verb table. The kickoff verb `new` is renamed to `full` (breaking — no alias). Doc revisionism cleanup removes pre-v1.0.0 release-history references throughout the repo.

### Added
- **Two-tier no-args picker (Step M).** `/masterplan` (no args) now surfaces an `AskUserQuestion` menu. Tier 1: Phase work / Operations / Resume in-flight / Cancel. Tier 2a (Phase work): brainstorm / plan / execute / full + topic prompt. Tier 2b (Operations): import / status / doctor / retro. "Resume in-flight" delegates to Step A's existing list+pick. "Cancel" exits cleanly.

### Changed
- **`new` verb renamed to `full`.** All sync'd locations updated: frontmatter description, Step 0 routing table rows, reserved-verbs warning, argument-parse precedence list, README verb table + quick-start examples + reserved-verb prose + Aliases-and-shortcuts table, `docs/internals.md` Step 0 mirror.
- **Doc revisionism pass.** Removed all pre-v1.0.0 (v0.x) release-history references from CHANGELOG (older blocks deleted entirely + remaining v0.x mentions in v1.0.0/v2.0.0 entries scrubbed), README ("Path to v2.0.0" → "Releases since v1.0.0", v0.x bullets removed), `docs/internals.md` (v0.x parentheticals dropped from "Why" section headings + audit-pass bullet wording), `docs/design/intra-plan-parallelism.md` + the v1.1.0 spec ("v0.1 → v0.2 → v0.3 → v0.4 → v1.0.0" deferral-chain framing rewritten as "deferred prior to v1.0.0"). WORKLOG v2.0.0 entry's rename narrative trimmed; functional deliverables (parallelism Slice α, Codex defaults, internal docs) preserved.

### Migration notes
- **Breaking:** `/masterplan new <topic>` is now `/masterplan full <topic>`. No alias. Memorize the new verb. (The bare-topic shortcut `/masterplan <topic>` continues to work and routes to the same flow as `full`.)
- **No-args picker is additive** for users who previously used bare `/masterplan` to reach the worktree picker — they now select "Resume in-flight" (one extra click) to land in the same Step A logic. Direct verb invocations (`/masterplan full ...`, `/masterplan execute`, etc.) bypass the picker entirely.
- **Doc revisionism is non-breaking** — only documentation surface changes; orchestrator behavior is unchanged for these edits.
- **No status-file or config schema changes.** Existing plans and `.masterplan.yaml` files work unchanged.

## [2.1.0] — 2026-05-04

**README polish + gated→loose switch offer + Roadmap section.** Additive release on the v2.x track; no breaking changes. Adds a benefits paragraph + a "Defaults at a glance" YAML block + a "Roadmap" section to README. Adds a one-time AskUserQuestion at Step C step 1 offering to switch from `--autonomy=gated` to `--autonomy=loose` when a long plan (≥15 tasks by default) is in progress — reduces friction for users who don't want to click through every per-task gate on a trusted plan.

### Added
- **README `## Why this exists` rewritten + reordered** to precede `## What you get`. New 6-bullet benefits paragraph: long-term complex planning, aggressive context discipline, dramatic token reduction, parallelism for faster operation, cross-session resume, cross-model review.
- **README `### Defaults at a glance`** sub-section under `## Configuration`. Compact YAML block (~50 lines) showing every default in one scannable view, with one-line comments for the most-overridden fields. Full schema with explanations follows below.
- **README `## Roadmap`** top-level section between `## Project status` and `## Author`. Surfaces 6 deferred items + 4 documented non-features. Each deferred item has a measurable revisit trigger.
- **Gated→loose switch offer (v2.1.0+).** New AskUserQuestion at Step C step 1 (after telemetry inline snapshot, before the per-task autonomy loop): when `autonomy == gated` AND `config.gated_switch_offer_at_tasks > 0` AND plan task count ≥ threshold AND not already dismissed/shown, offer 4-option switch:
  - Switch to `--autonomy=loose` (Recommended for trusted plans)
  - Stay on gated
  - Switch + don't ask again on any plan (recommends user edit `.masterplan.yaml`; orchestrator does NOT modify user's config per CD-2)
  - Stay + don't ask again on this plan (sets `gated_switch_offer_dismissed: true` in status frontmatter)
- **Config key `gated_switch_offer_at_tasks: 15`** (top-level; default 15). Set to 0 to disable the offer entirely.
- **Status file frontmatter optional fields:**
  - `gated_switch_offer_dismissed: true` — permanent per-plan suppression of the offer.
  - `gated_switch_offer_shown: true` — per-session suppression (re-fires on cross-session resume by design — gives the user another chance after a break).

### Changed
- README section ordering: `## Why this exists` now precedes `## What you get` (value pitch before surface area). Existing content of both sections preserved verbatim except for the new benefits paragraph appended to "Why this exists."
- Plugin.json description mentions the gated→loose offer.

### Migration notes
- **No breaking changes.** Additive release. Existing `.masterplan.yaml` files without `gated_switch_offer_at_tasks` get the default 15.
- Users who never want the gated→loose offer set `gated_switch_offer_at_tasks: 0` in `.masterplan.yaml`.
- Users who want the offer on but with a different threshold (e.g., 25 tasks) override per-repo or globally in `~/.masterplan.yaml`.
- Status frontmatter fields `gated_switch_offer_dismissed` and `gated_switch_offer_shown` are both optional. Doctor check #9 (schema-required-fields) is unchanged — these fields aren't required.

## [2.0.0] — 2026-05-04

**Intra-plan parallelism Slice α + Codex defaults on.** Single coherent v2.0.0 release bundling Slice α of intra-plan task parallelism (read-only parallel waves only — verification, inference, lint, type-check, doc-generation; implementation tasks remain serial), Codex defaults flipped to on with graceful-degrade when codex plugin isn't installed, a new `## Codex integration` README section, internal documentation for LLM contributors (`CLAUDE.md` + `docs/internals.md`), and pruning of older spec/plan/WORKLOG history (institutional knowledge migrated to `docs/internals.md`).

### Added
- **`**parallel-group:** <name>` plan annotation.** Tasks sharing the same `<name>` value dispatch as one parallel wave in Step C step 2. Read-only only (verification, inference, lint, type-check, doc-generation). Mutually exclusive with `**Codex:** ok`. Requires complete `**Files:**` block (becomes exhaustive scope under wave). See [`docs/design/intra-plan-parallelism.md`](./docs/design/intra-plan-parallelism.md) for the failure-mode catalog and Slice β/γ deferral.
- **Wave dispatch in Step C step 2** — contiguous-plan-order wave assembly; per-instance bounded brief (DO NOT commit, DO NOT update status); parallel `Agent` dispatch; wave-completion barrier.
- **Single-writer status funnel in Step C 4d** — orchestrator aggregates wave digests, computes `current_task` as lowest-indexed not-yet-complete, appends N entries to `## Activity log` in plan-order with `[wave: <group>]` tag, runs wave-aware activity log rotation (fires once per wave per FM-2), commits status file once per wave with subject `masterplan: wave complete (group: <name>, N tasks)`.
- **Files-filter in Step C 4c under wave** — single porcelain check filters against union of all wave-task `**Files:**` declarations (post-glob-expansion) plus implicit-paths whitelist.
- **Eligibility cache pin (M-2 mitigation)** — `cache_pinned_for_wave` flag suppresses mtime invariant during wave; new CD-2 in-wave scope rule forbids wave members from modifying plan/status/cache.
- **Per-member outcome reconciliation** — three outcomes (`completed` / `blocked` / `protocol_violation`); `protocol_violation` detected by orchestrator post-barrier (commits despite "DO NOT commit", out-of-scope writes, status file modification).
- **Wave-level outcomes** — all-completed / all-blocked / partial. Partial preserves K completed digests UNLESS `parallelism.abort_wave_on_protocol_violation: true` (default), in which case the entire 4d batch is suppressed.
- **Blocker re-engagement gate integration** — fires once at wave-end with the union of N-K blocked members; option semantics extend naturally.
- **Step C 5 wave-count threshold** — wave-end counts as ONE completion regardless of N (a wave of 5 doesn't trigger 5 wakeup-threshold increments).
- **3 new doctor checks (#15-17, total 14 → 18 with #18):** parallel-group without Files: block; parallel-group + Codex: ok mutual conflict; file-path overlap within parallel-group.
- **Doctor check #18: Codex config on but plugin missing.** Flags persistent misconfiguration when `codex.routing != off` OR `codex.review == on` AND no `codex:` skill in scope at lint time. Step 0's auto-degrade handles per-run; doctor surfaces persistent state.
- **Step 0 codex-availability detection (graceful degrade).** When config has codex on but plugin not installed, emit one-line warning and treat both routing + review as `off` for the run. Persisted config is unchanged.
- **`hooks/masterplan-telemetry.sh` gains `tasks_completed_this_turn` (int) + `wave_groups` (array of strings) fields** — FM-3 mitigation. Linux smoke-tested; macOS portable-by-construction (not smoke-tested).
- **New `parallelism:` config block** — `enabled` (kill switch, default true), `max_wave_size` (default 5), `abort_wave_on_protocol_violation` (default true).
- **New `--parallelism=on|off` and `--no-parallelism` CLI flags.**
- **Step B2 writing-plans brief paragraph** — guidance for the planner on emitting `parallel-group:` annotations.
- **README `## Codex integration` section** (~490 words). Covers why/how/defaults/install/disable/cross-references.
- **`CLAUDE.md` at repo root** (~620 words) — always-loaded project orientation for Claude Code sessions in this repo. Top anti-patterns, operating principles, doc index.
- **`docs/internals.md`** (~8000 words, 15 sections) — comprehensive deep-dive for future LLM contributors: architecture, dispatch model, status format, CD rules, operational rules, wave dispatch + failure-mode catalog FM-1 to FM-6, Codex integration, telemetry, doctor checks, verb routing, design history, common dev recipes, anti-patterns, cross-references.

### Changed
- **`codex.review` default flipped: `off` → `on`.** Behavior change. Users who don't want Codex to review every inline-completed task should set `codex.review: off` in `.masterplan.yaml` or pass `--no-codex-review`. (Auto-degrades to `off` when codex plugin not installed — no impact on users without Codex.)
- **Step C step 1 eligibility cache schema extended** with `parallel_group`, `files`, `parallel_eligible`, `parallel_eligibility_reason` (all optional; backward-compatible with prior cache files which load with `parallel_eligible: false`).
- **Step D parallelization brief: `each agent runs all 14 checks` → `each agent runs all 18 checks`.**
- **`docs/design/intra-plan-parallelism.md` rewritten** — replaces brief design notes with v2.0.0 status doc (what ships in Slice α, what's deferred, sharpened revisit trigger, failure-mode catalog summary).
- **`docs/design/telemetry-signals.md`** — documents the two new fields with first-turn caveat; adds "Average tasks-per-wave-turn" jq example.
- **README** — Plan annotations table adds `parallel-group:` + `non-committing:` rows; Useful flag combinations adds `--no-parallelism` row; "Path to v2.0.0" entry added; Project status bumped; Useful flag combinations row for default invocation updated to mention `codex.review: on` v2.0.0 default + graceful-degrade.

### Removed
- **5 older spec/plan files pruned.** Knowledge migrated to `docs/internals.md` §12 (Design decisions).
- **Older WORKLOG entries trimmed.** Only the v2.0.0 entry remains. CHANGELOG retains the full release history.

### Migration notes

**Required user steps for v1.0.0 → v2.0.0 upgrade:**

1. **`codex.review` is now on by default.** If you don't have the codex plugin installed, this auto-degrades silently with a one-line warning at Step 0. If you have codex installed but DON'T want auto-review, set `codex.review: off` in `.masterplan.yaml`.
2. **Existing in-flight plans keep working** — status file paths inside `docs/superpowers/plans/` are unchanged. Resume with `/masterplan execute <status-path>`.
3. **Eligibility cache files** (`<slug>-eligibility-cache.json`) created prior to v2.0.0 are valid — load with `parallel_eligible: false` for every task. Cache rebuild fires on plan.md mtime change as today.

**No status-file schema changes** beyond the optional new eligibility cache fields. Existing status files load unchanged.

---

## [1.0.0] — 2026-05-03

**First stable public release.** Consolidates retrospective generation into the `/masterplan retro` verb (replacing the previously-auto-firing `masterplan-retro` skill), standardizes terminology on "verbs" instead of mixing "subcommands" and "invocation forms," and applies a pre-release audit fix pass that closed 10 blockers and 13 polish items found by three parallel fresh-eyes Explore agents auditing the orchestrator, telemetry hook, remaining skill, and human-facing docs.

### Added
- **`/masterplan retro [<slug>]` verb.** Generates a retrospective doc for a completed plan and writes it to `docs/superpowers/retros/YYYY-MM-DD-<slug>-retro.md` with outcomes, blockers, deviations, follow-ups, and Codex routing observations. With no slug, picks from completed plans that don't yet have a retro; with one candidate, runs without a picker. New `Step R` section in `commands/masterplan.md` (R0 resolve target → R1 pre-write guard → R2 gather → R3 synthesize + write → R4 offer follow-ups). Pre-write guard globs `*-<slug>-retro.md` so re-runs surface `Open / Generate v2 / Abort` instead of silently duplicating.
- **`new` (no topic) verb routing row.** `/masterplan new` with no topic now prompts for a topic via `AskUserQuestion` before falling through to Step B, mirroring the established `brainstorm` (no topic) handling. Previously bare `new` silently passed empty args to brainstorming.

### Removed
- **`masterplan-retro` skill removed.** Functionality consolidated into the `/masterplan retro` verb. The skill's auto-fire-on-plan-completion behavior is gone — retro generation is now explicit. Users who relied on the auto-suggestion can run `/masterplan retro` after a plan completes (it picks the most recent completed plan without a retro). The skill deletion drops one auto-trigger surface from the install footprint; `masterplan-detect` (parallel-shape skill that suggests `/masterplan import`) is retained.

### Changed
- **README terminology standardized on "verbs."** `## Subcommand reference` → `## Verb reference`. "Other subcommands" header in "What you get" → "Operation verbs" (paired with the existing "Phase verbs"). `### Invocation forms (back-compat detail)` → `### Aliases and shortcuts` (back-compat framing dropped — the bare-topic shortcut and `--resume=<path>` are documented aliases, not legacy forms). Slash command's `### Subcommand routing` → `### Verb routing`.
- **Verb reference table now uses "Effect" column instead of "Phases."** The previous "Phases" column was inaccurate for operation verbs (import/doctor/status/retro aren't pipeline phases). Each row now has a one-line effect description rather than `(unchanged)` placeholders.
- **Reserved-verb list expanded.** Step 0's "Verb tokens are reserved" warning previously listed only the four phase verbs; now lists all eight (new, brainstorm, plan, execute, retro, import, doctor, status) — matches what the routing table actually consumes.
- **README install (Option A) rewritten.** Previous text was gated on a future condition. Replaced with the current `/plugin marketplace add rasatpetabit/superpowers-masterplan` + `/plugin install` flow, with the interactive `/plugin` Discover tab documented as a syntax-drift fallback.

### Fixed
- **Doctor section was missing its `## Step D` header.** The section started directly with `### Scope` after Step S4. Restored the `## Step D — Doctor` heading.
- **Doctor parallelization brief told each Haiku worker to run "all 10 checks"** but the doctor checks table has 14 entries. Workers were silently skipping orphan archive, telemetry growth, orphan telemetry, and orphan eligibility cache. Corrected to "all 14 checks."
- **Step I3.4's status-file conversion brief omitted `compact_loop_recommended`** from its required frontmatter enumeration. Doctor check #9 requires the field; every imported plan would have failed schema validation immediately. Field added to the brief.
- **Step 4b's zero-commit handling contradicted itself.** Step 1 said "skip 4b for zero-commit tasks"; step 2's rationale paragraph said "inline the diff via the existing fallback in step 1" (no such fallback existed). The stale fallback claim was removed.
- **Step C dispatch guard misstated B1's "Continue to plan now" path.** The guard described a non-existent composite option `"Continue to plan now → Start execution now"` blending B1 (which flips `halt_mode` to `post-plan`) with B3 (which flips it to `none`). Rewrote to clarify the actual flow: B1's flip falls through B2 to B3, where the user explicitly picks "Start execution now" to enter Step C. B3's `post-plan` close-out gate description and B2's dispatch guard prose were updated to match.
- **Blocker re-engagement gate had 5 options, violating CD-9's 2–4 cap.** Dropped option 3 ("Break this task into smaller pieces — pause so I can edit the plan to decompose, then continue") since it overlapped semantically with option 1 ("Provide context and re-dispatch"). Option 5 (the legacy `status: blocked` end-turn path) is preserved — resume-from-blocker depends on it being the only path to the legacy blocked state.
- **Dispatch model table cell referenced a nonexistent "Task 2."** Stale draft pointer; removed.
- **Codex annotation syntax was inconsistent across the orchestrator.** Eligibility checklist and the operational-rule mention used lowercase `codex: ok|no`; the canonical syntax block and the eligibility-cache builder used `**Codex:** ok|no` (bold, capital). Plan authors had no way to know which form the parser expected. Standardized on `**Codex:** ok|no` everywhere.
- **README verb-table cell** pointed readers to "see invocation forms below" — that section is now called `### Aliases and shortcuts`. Dangling anchor; updated.
- **`docs/design/telemetry-signals.md`'s "Tokens-per-turn estimate"** `jq foreach` query was broken: the UPDATE expression `$r` overwrote the accumulator each iteration, so `growth = $r.transcript_bytes - $r.transcript_bytes = 0` for every record. Rewrote using `range`-based indexed access; verified against a 3-record fixture that growth values are now real (non-zero where expected).
- **`hooks/masterplan-telemetry.sh` used GNU-only `find -quit` and `find -printf`** — both silently break on macOS BSD `find`. The most-used transcript-resolution fallback returned no output on macOS. Rewrote with portable `head -n1` and a `stat -c '%Y' || stat -f '%m'` dual form. Verified end-to-end on Linux; the macOS path is portable-by-construction but not smoke-tested (call for issues added to the README).
- **`hooks/masterplan-telemetry.sh` had no `jq` presence check** despite declaring jq as Required in the header. Without jq, the hook silently wrote nothing forever. Added explicit `command -v jq` guard at startup that bails silently if jq is absent.
- **`hooks/masterplan-telemetry.sh` wakeup-count cutoff** could become empty in stripped or musl-libc environments where neither GNU `date -d` nor BSD `date -v` works. Awk's `ts > ""` is true for every non-empty timestamp, so `wakeup_count_24h` would over-count every wakeup ever recorded. Added a sentinel cutoff (`9999-12-31T23:59:59Z`) that produces zero matches when both date forms fail — safe degraded behavior beats silent over-counting.

### Polish
- **Step P note** said "(Step B0a, below in Step B)"; B0a is *above* Step P. Direction corrected.
- **Completion-state inference header** claimed it was "(and optionally Step C on resume to validate the plan against current reality)"; no Step C site actually invokes it. Forward intention that was never wired up; claim removed.
- **B1 "Continue to plan now" option** didn't note that B0a's worktree check is skipped (already settled by the earlier B0 run). Parenthetical added.
- **Step I0 direct-import** ("skip discovery and jump to Step I3") didn't note that Step I2 (rank+pick) is also skipped — the candidate is already determined. Added.
- **Activity log archive description** overstated `/masterplan doctor`'s involvement — doctor only flags orphan archives via check #11, doesn't read content. Removed the misleading "and by `/masterplan doctor`" clause.
- **Telemetry hook had a dead `out_file` assignment** (line 80 was overwritten by line 82) with a comment that described line 82's behavior, not line 80's. Removed the dead line and the orphan comment.
- **`masterplan-detect` skill body** described two detection execution paths (Claude Code `Glob` tool vs shell `fd` snippets) as a single mechanism. Reframed as two layers: Glob is the always-available skill-tool path; the `fd` snippets in **Detection commands** give richer matching where `fd` is installed.
- **Historical status-file example** had a real `/home/ras/...` worktree path. Anonymized to `/home/you/...` to match the README's status-file example convention.
- **README hook section** softened to make the Linux-only smoke-test gap explicit: portable code paths are documented, but the macOS path hasn't been verified — readers are pointed at GitHub issues if telemetry doesn't land.

### Migration notes
- If you installed via Option B (manual copy) and copied `skills/masterplan-retro/` into `~/.claude/skills/`, you can safely `rm -rf ~/.claude/skills/masterplan-retro/`. The skill is no longer shipped or referenced.
- If you installed as a plugin (Option A), pulling v1.0.0 removes the skill automatically.
- No status-file or config schema changes. Existing plans, status files, and `.masterplan.yaml` files work unchanged.
