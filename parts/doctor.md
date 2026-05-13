# Doctor — Self-Host Checks (#1 .. #31)

Invoked via `/masterplan doctor [--fix]`. Loaded by the router only when verb == doctor. Checks #32–#36 added in Wave C.

Triggered by `/masterplan doctor [--fix]`. Lints all masterplan state across all worktrees of the current repo.

### Scope

Read worktrees from `git_state.worktrees` (Step 0 cache). For each worktree, scan `<worktree>/<config.runs_path>/` plus legacy `<worktree>/<config.specs_path>/` and `<worktree>/<config.plans_path>/`.

**Parallelization.** When worktrees ≥ 2, dispatch one Haiku agent (pass `model: "haiku"` per §Agent dispatch contract) per worktree in a single Agent batch (each agent runs all plan-scoped checks (currently #1-24, #26, #28, #29) for its worktree and returns findings as `[{check_id, severity, file, message}]` JSON). With 1 worktree, run inline — agent dispatch latency isn't worth it. The orchestrator merges results and applies the report ordering below. Repo-scoped checks #26 (`auto_compact_loop_attached`, v2.9.1+), #30 (`cross_manifest_version_drift`, v4.2.1+), and #31 (`per_autonomy_gate_condition_consistency`, v4.2.1+) fire ONCE per doctor run regardless of worktree/plan count and run inline at the orchestrator. #26's input is session-level state (`CronList` output); #30 reads the three repo-root manifests via the Read tool; #31 reads `commands/masterplan.md` itself. (Self-host audits — deployment-drift detection and CD-9 free-text-question grep — moved to `bin/masterplan-self-host-audit.sh` in v2.11.0; that script is developer-only and runs against the project repo, not the user's working repo.) Plan-scoped check #28 (`completed_plan_without_retro`, v2.11.0+) is interactive: when it fires it surfaces `AskUserQuestion` to the user, so it can NOT be parallelized inside Haiku worktree dispatchers — instead each worktree's Haiku returns the candidate-list, and the orchestrator drives the prompts inline (sequentially) after the parallel detection completes. Plan-scoped check #29 (`worktree_bundle_reconciliation_mismatch`, v4.0.0+) is a lightweight repo-scoped structural check that applies to all complexity levels.

Each per-worktree Haiku dispatch must use this bounded brief form:

```
DISPATCH-SITE: Step D doctor checks

contract_id: "doctor.schema_v2"
Follow the algorithm defined in commands/masterplan-contracts.md §Contract: doctor.schema_v2.
Goal: Run all plan-scoped doctor checks for the bundle paths in this worktree's runs_path.
Inputs: worktree path, runs_path glob, legacy paths glob.
Scope: read-only.
Return shape: {contract_id: "doctor.schema_v2", inputs_hash: "<sha256 of bundle state.yml paths processed>", processed_paths: [list of state.yml paths], violations: [{bundle, field, kind, detail}], coverage: {expected: N, processed: N}}.
```

**Sampling-based parent re-verification** (runs AFTER the parallel Haiku wave returns, BEFORE emitting findings): For each bundle path in the doctor scope, the orchestrator re-verifies a sample set: 3 randomly selected bundles + any bundle with violations in the Haiku return. Full scan only when Haiku reports 0 violations on a corpus with known history of violations. For each sampled bundle: grep state.yml for `^retro: ""` and for missing `import_hydration` when any `legacy.*` field is non-empty. Cross-reference against Haiku's violations list. On discrepancy (parent finds violations Haiku missed): append `{"event":"parent_reverify_mismatch","contract_id":"doctor.schema_v2","missed_count":<N>}` to events.jsonl and prefer parent findings. Emit a one-line notice: `⚠ doctor parent re-verify found <N> additional violation(s) not in Haiku return — using parent findings.`

**Legacy-reference index.** Before running legacy-artifact checks, build a per-worktree set of all paths referenced by every bundle `state.yml` under `artifacts.*` and `legacy.*`, normalized relative to that same worktree. A legacy file under `docs/superpowers/...` that appears in this referenced-path set is already attached to durable masterplan state. Do not report it as "legacy plan not migrated" merely because the legacy filename slug differs from the bundle directory slug.

**Complexity-aware check set.** For each scanned plan, read `complexity` from `state.yml` (default `medium` if absent — legacy/pre-feature plans). The active check set varies:

- `low` plans: run only checks #1 (orphan plan), #2 (orphan status), #3 (wrong worktree), #4 (wrong branch), #5 (stale in-progress), #6 (stale critical error), #8 (missing spec), #9 (schema, against the standard run-state field set), #10 (unparseable), #18 (codex misconfig), #29 (worktree-bundle reconciliation mismatch). SKIP all sidecar / annotation / ledger / cache / queue / per-subagent-telemetry checks (#11–#17, #19–#21, #23, #24) — low plans do not produce those artifacts. Also skip #22 (high-only — see below).
- `medium` plans: run all plan-scoped checks (currently #1-24, #26, #28, #29) except #22 (high-only).
- `high` plans: run all plan-scoped checks (currently #1-24, #26, #28, #29) INCLUDING #22 (high-complexity rigor evidence).
- Plans without a `complexity:` state field: treat as `medium`.

The check-set gate is per-plan: a single `/masterplan doctor` run against worktrees containing a mix of low/medium/high plans honors each plan's complexity individually. Findings are reported with the same severity as today. (Self-host audits — deployment-drift comparison vs HEAD and CD-9 free-text-question grep — moved out of doctor in v2.11.0; those run via the developer-only `bin/masterplan-self-host-audit.sh` script when working on the orchestrator source.)

## Severity / Action Table

For each worktree, run all checks. Report findings grouped by worktree → check → file.

| # | Check | Severity | `--fix` action |
|---|---|---|---|
| 1 | **Legacy plan not migrated** — pre-v3 plan/spec/status/retro exists under `docs/superpowers/...`, is not referenced by any bundle `state.yml` `artifacts.*` or `legacy.*` path in the same worktree, and has no matching `docs/masterplan/<slug>/state.yml`. | Warning | `--fix`: invoke `/masterplan import` and select `<slug>` from the picker (copy-only; no legacy delete). |
| 2 | **Orphan state** — `state.yml` points at a missing `artifacts.plan` / `artifacts.spec` required for its current `phase`, or a legacy status points at a missing plan. | Error | For bundle state: prompt to repair artifact path or mark archived. For legacy status: migrate if possible, otherwise move to `<config.archive_path>/<date>/`. |
| 3 | **Wrong worktree path** — `state.yml`'s `worktree` doesn't match any current `git worktree list` entry. | Error | Try to match by branch name; rewrite if unique match. Otherwise report. |
| 4 | **Wrong branch** — `state.yml`'s `branch` doesn't exist in `git branch --list`. | Error | Report only (manual fix). |
| 5 | **Stale in-progress** — `status: in-progress` with `last_activity` > 30 days. | Warning | Report only. |
| 6 | **Stale critical error** — `status: blocked` or `stop_reason: critical_error` with `last_activity` > 14 days. | Warning | Report only. |
| 7 | **Plan/log drift** — plan task count differs from activity-log task references by >50%. | Warning | Report only. |
| 8 | **Missing spec** — `state.yml`'s `artifacts.spec` points at a missing spec doc when the phase requires one. | Error | Report only; if `legacy.spec` exists, suggest re-copying it into the bundle. |
| 9 | **Schema violation** — `state.yml` missing required fields. Required set: `schema_version`, `slug`, `status`, `phase`, `artifacts.spec`, `artifacts.plan`, `artifacts.events`, `worktree`, `branch`, `started`, `last_activity`, `current_task`, `next_action`, `autonomy`, `loop_enabled`, `codex_routing`, `codex_review`, `compact_loop_recommended`, `complexity`, `pending_gate`, `stop_reason`, `critical_error`. | Error | Add missing fields with sentinel/derived values where possible (e.g. `pending_gate: null`, `stop_reason: null`, `critical_error: null`, `compact_loop_recommended: false`); report the rest. Cross-check: for each `legacy.*` pointer that is non-empty, verify that the corresponding `artifacts.*` pointer is also non-empty AND the file exists on disk. If `legacy.spec` is non-empty but `artifacts.spec` is empty or the file is missing: flag as Error (not just schema violation — this is an unhydrated import). `--fix`: invoke the Step I3.5 rehydration logic inline (parent-side, not as a subagent). Do NOT add null sentinel values when a recoverable `legacy.*` path exists — that was the pre-v4.0 bug this check now prevents. |
| 10 | **Unparseable state file** — `state.yml` YAML is malformed, or legacy status frontmatter/body is malformed. | Error | Report only (manual fix needed). Step A skips these silently, but doctor calls them out. |
| 11 | **Orphan events archive** — `events-archive.jsonl` exists without sibling `state.yml`, or legacy `<slug>-status-archive.md` exists without legacy status. | Warning | Suggest moving the archive to `<config.archive_path>/<date>/`. No auto-fix. |
| 12 | **Telemetry file growth** — `telemetry.jsonl` OR `subagents.jsonl` (or legacy equivalents) > 5 MB. | Warning | Rotate to `telemetry-archive.jsonl` / `subagents-archive.jsonl` (the active file becomes empty; new appends start fresh). |
| 13 | **Orphan telemetry file** — `telemetry.jsonl` (or archive) exists without sibling `state.yml`, or legacy telemetry exists without legacy status. | Warning | Suggest moving to `<config.archive_path>/<date>/`. No auto-fix. |
| 14 | **Orphan eligibility cache** — `eligibility-cache.json` exists without sibling `state.yml`, or legacy cache exists without legacy status. | Warning | Suggest moving to `<config.archive_path>/<date>/`. No auto-fix. |
| 15 | **`parallel-group:` set but `**Files:**` block missing/empty.** Section 2 eligibility rule 2 violated. Affects parallel-eligibility computation; task falls back to serial silently. | Warning | Report only. Author must add `**Files:**` block. |
| 16 | **`parallel-group:` and `**Codex:** ok` both set on the same task.** Section 2 eligibility rule 4 violated; FM-4 mitigation conflict (mutually exclusive). | Warning | Report only. Author must remove one of the annotations. |
| 17 | **File-path overlap detected within a `parallel-group:`.** Section 2 eligibility rule 5 violated. Multiple tasks in the same parallel-group declare overlapping `**Files:**` paths. | Warning | Report the overlapping task pairs. No auto-fix. |
| 18 | **Codex config on but plugin missing.** Config has `codex.routing != off` OR `codex.review == on` AND no entry prefixed `codex:` is present in the system-reminder skills list at lint time. Step 0's codex-availability detection auto-degrades silently per-run; doctor surfaces the persistent misconfiguration as a Warning so the user notices and either installs codex or sets the defaults to `off`. | Warning | Suggest `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex` to enable, OR set `codex.routing: off` and `codex.review: off` in `.masterplan.yaml` to suppress this check. No auto-fix (changing user's config is out of scope per CD-2). |
| 19 | **Orphan subagents file** — `subagents.jsonl` exists with no sibling `state.yml`, or legacy `<slug>-subagents.jsonl` / `<slug>-subagents-cursor` exists with no legacy status. | Warning | Suggest moving the subagents file to `<config.archive_path>/<date>/`. Cursor file (if present) can simply be deleted. No auto-fix. |
| 20 | **Codex routing configured but eligibility cache missing.** `state.yml` has `codex_routing: auto` OR `codex_routing: manual` AND no bundled `eligibility-cache.json` exists AND `events.jsonl` has at least one `routing→` or `[codex]`/`[inline]` entry. | Warning | `--fix`: Rebuild `eligibility-cache.json` deterministically (mirrors Step C step 1's Build path), append an event `eligibility cache: rebuilt (...) -- via doctor --fix`, and commit the cache/state update. |
| 21 | **Step C step 1 cache-build evidence missing.** `state.yml` has `codex_routing: auto` OR `codex_routing: manual` AND task-completion events exist AND no event contains `eligibility cache:`. | Warning | Same action as #20. No-`--fix`: suggest re-running the next task via `/masterplan execute <state-path>` with codex installed, or setting `codex_routing: off` in `state.yml` if codex is intentionally disabled for this plan. |
| 22 | **High-complexity plan missing rigor evidence.** Fires when `state.yml` has `complexity: high` AND the run lacks ALL THREE of: (a) a retro artifact/event, (b) at least one `Codex review:` event indicating a review pass, (c) `[reviewed: ...]` tags in >= 50% of task-completion events. Skipped on `complexity: low` and `complexity: medium`. | Warning | No auto-fix. Suggest re-running the most recent task with `--complexity=medium` if high is overkill, OR running `/masterplan retro` to generate the retro reference. |
| 23 | **Opus on bounded-mechanical dispatch sites** (C.1 mitigation, v2.8.0+). Scans the most recent `min(20, len(jsonl))` entries in `subagents.jsonl` for records whose **EITHER** `dispatch_site` substring-matches `Step C step 1`, `Step C step 2 wave dispatch`, or `Step C step 2 SDD` (per the §Agent dispatch contract dispatch-site mapping table) **OR** `routing_class == "sdd"` (the hook's classification when `subagent_type` contains `subagent-driven-development`) **AND** whose `model` field is `opus`. Excludes records whose `prompt_first_line` matches `re-dispatched with model=opus per blocker gate` (intentional escalation per the wave-member retry path). Indicates the model-passthrough override clause leaked or was missing in the orchestrator's SDD/wave brief — cost regression today; potentially a correctness issue if it indicates upstream skill-prompt drift. | Warning | Surface `AskUserQuestion` per finding: "Detected `<N>` SDD/wave/eligibility dispatch(es) with `model: opus` (cost contract calls for sonnet). How to proceed? — `Run \`bin/masterplan-self-host-audit.sh --models\` to lint orchestrator dispatch sites (Recommended)` / `Investigate transcript: print suspected session prompts from JSONL` / `Suppress for this plan (sets model_attribution_suppressed: true in state.yml)` / `Skip this finding only`". The first option chains into running the audit script and surfacing its output. See §Agent dispatch contract recursive-application for the verbatim preamble that should be present in SDD invocations. |
| 24 | **State-write queue file present and non-empty** (F.4 mitigation, v2.8.0+). `state.queue.jsonl` exists with non-zero size, AND `state.yml` shows no `last_activity` update within the last `config.loop_interval_seconds`. | Warning | `--fix`: replay each queued entry into `events.jsonl` / `state.yml` idempotently, then truncate the queue file. No-`--fix`: report queued-entry count + suggest `/masterplan --resume=<state-path>` to trigger drain naturally. |
| 26 | **`auto_compact_loop_attached`** (repo-scoped). Skipped silently when `config.auto_compact.enabled == false`, or when no `docs/masterplan/*/state.yml` has `compact_loop_recommended: true`. Otherwise calls `CronList()` and filters entries whose `prompt` contains `/compact`. | Warning | No `--fix` available; report the copy-pasteable `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` command and the run slugs whose `state.yml` has `compact_loop_recommended: true`. |
| 28 | **`completed_plan_without_retro`** (plan-scoped). Detects completed run bundles with no `retro.md`, or legacy completed plans without a migrated bundle/retro. | Warning | Surface `AskUserQuestion` per finding: generate retro + archive run bundle (Recommended), generate retro only, skip this plan, or skip all findings this run. |
| 29 | **Worktree-bundle reconciliation mismatch** (v4.0.0+). Cross-repo: enumerate `git worktree list --porcelain` for the current repo; for each worktree path, find any bundle's `state.yml.worktree:` pointing at it. Surface: (a) bundles claiming a worktree path not registered in `git worktree list` (`worktree_missing`); (b) worktree paths registered in git with no bundle pointer (`worktree_orphan_untracked`). Skip worktrees with `worktree_disposition: removed_after_merge` or `kept_by_user` — those are intentionally settled. | Warning | `--fix`: for (a), set `worktree_disposition: missing`, clear `worktree:` field, write state, commit. For (b): report only (user must decide). |
| 30 | **Cross-manifest version drift** (repo-scoped, v4.2.1+). Reads the three version-bearing manifests — `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root `version` AND nested `plugins[0].version`), `.codex-plugin/plugin.json` — and compares each `version` field against the canonical. `.agents/plugins/marketplace.json` is exempt (no `version` field by schema). Catches the v3.4.0–v4.1.1 drift pattern where `.claude-plugin/marketplace.json` was stuck at 3.3.0 across four releases. **Implementation:** runs inline at the orchestrator (does NOT dispatch per-worktree). Use the Read tool to load each manifest, extract `version` (and the nested `plugins[0].version` for `.claude-plugin/marketplace.json`), compare against `.claude-plugin/plugin.json` as canonical. Any mismatch → emit one Warning per drifted file/field: `version drift: <file>[:<json-path>] at <observed> (canonical: <canonical>)`. | Warning | Report only. Auto-bumping is risky — canonical-source authority is ambiguous when multiple manifests have drifted. Suggest editing alongside the CHANGELOG entry for the next release. |
| 31 | **Per-autonomy gate-condition consistency** (repo-scoped, v4.2.1+). Maintains a static anchor table mapping gate-decision sites in `commands/masterplan.md` to their expected `--autonomy [!=]= <value>` conditions. Initial table: `{anchor: "id: spec_approval", expected_regex: "--autonomy != full", note: "spec gate intentionally fires under loose (L1286)"}`, `{anchor: "id: plan_approval", expected_regex: "--autonomy == gated", note: "plan gate auto-approves under loose per v4.2.0 (L1360)"}`. **Implementation:** runs inline at the orchestrator. For each table entry: grep `commands/masterplan.md` for the anchor string, read the next 3 lines, regex-match the expected condition. Anchor not found → flag missing gate site. Anchor found but condition mismatches → flag drift with observed text. Maintainers adding a new gate site to the orchestrator MUST extend this static table; an existing entry that no longer matches → loud Warning. | Warning | Report only. Auto-rewriting gate conditions in the orchestrator prompt is never safe — these are deliberate semantic choices made per-release. |
| 32 | **state.yml scalar cap + overflow pointer** — every scalar value in `state.yml` ≤200 chars; overflow pointers resolve to existing files with valid line numbers. | Warning | Report-only |
| 33 | **TaskCreate projection mode mismatch** — active run bundle projection mode vs TaskList ledger disagrees. | Warning | Report-only |
| 34 | **plan.index.json staleness** — `plan_hash` in `state.yml` or `plan.index.json` doesn't match current `plan.md` sha256. | Warning | Report-only |
| 35 | **Plan-format conformance (v5.0 markers)** — every task heading in `plan.md` must be followed by `**Spec:**` and `**Verify:**` markers within 30 lines. | Warning | Report-only |
| 36 | **parts/step-*.md sanity + router ceiling** — `commands/masterplan.md` ≤20480 bytes; all phase files exist; CC-3-trampoline and DISPATCH-SITE tags present. | Warning | Report-only |

---

## Check #1 — Legacy plan not migrated

**Severity:** Warning

pre-v3 plan/spec/status/retro exists under `docs/superpowers/...`, is not referenced by any bundle `state.yml` `artifacts.*` or `legacy.*` path in the same worktree, and has no matching `docs/masterplan/<slug>/state.yml`.

**`--fix` action:** `--fix`: invoke `/masterplan import` and select `<slug>` from the picker (copy-only; no legacy delete).

---

## Check #2 — Orphan state

**Severity:** Error

`state.yml` points at a missing `artifacts.plan` / `artifacts.spec` required for its current `phase`, or a legacy status points at a missing plan.

**`--fix` action:** For bundle state: prompt to repair artifact path or mark archived. For legacy status: migrate if possible, otherwise move to `<config.archive_path>/<date>/`.

---

## Check #3 — Wrong worktree path

**Severity:** Error

`state.yml`'s `worktree` doesn't match any current `git worktree list` entry.

**`--fix` action:** Try to match by branch name; rewrite if unique match. Otherwise report.

---

## Check #4 — Wrong branch

**Severity:** Error

`state.yml`'s `branch` doesn't exist in `git branch --list`.

**`--fix` action:** Report only (manual fix).

---

## Check #5 — Stale in-progress

**Severity:** Warning

`status: in-progress` with `last_activity` > 30 days.

**`--fix` action:** Report only.

---

## Check #6 — Stale critical error

**Severity:** Warning

`status: blocked` or `stop_reason: critical_error` with `last_activity` > 14 days.

**`--fix` action:** Report only.

---

## Check #7 — Plan/log drift

**Severity:** Warning

plan task count differs from activity-log task references by >50%.

**`--fix` action:** Report only.

---

## Check #8 — Missing spec

**Severity:** Error

`state.yml`'s `artifacts.spec` points at a missing spec doc when the phase requires one.

**`--fix` action:** Report only; if `legacy.spec` exists, suggest re-copying it into the bundle.

---

## Check #9 — Schema violation

**Severity:** Error

`state.yml` missing required fields. Required set: `schema_version`, `slug`, `status`, `phase`, `artifacts.spec`, `artifacts.plan`, `artifacts.events`, `worktree`, `branch`, `started`, `last_activity`, `current_task`, `next_action`, `autonomy`, `loop_enabled`, `codex_routing`, `codex_review`, `compact_loop_recommended`, `complexity`, `pending_gate`, `stop_reason`, `critical_error`.

**`--fix` action:** Add missing fields with sentinel/derived values where possible (e.g. `pending_gate: null`, `stop_reason: null`, `critical_error: null`, `compact_loop_recommended: false`); report the rest. Cross-check: for each `legacy.*` pointer that is non-empty, verify that the corresponding `artifacts.*` pointer is also non-empty AND the file exists on disk. If `legacy.spec` is non-empty but `artifacts.spec` is empty or the file is missing: flag as Error (not just schema violation — this is an unhydrated import). `--fix`: invoke the Step I3.5 rehydration logic inline (parent-side, not as a subagent). Do NOT add null sentinel values when a recoverable `legacy.*` path exists — that was the pre-v4.0 bug this check now prevents.

---

## Check #10 — Unparseable state file

**Severity:** Error

`state.yml` YAML is malformed, or legacy status frontmatter/body is malformed.

**`--fix` action:** Report only (manual fix needed). Step A skips these silently, but doctor calls them out.

---

## Check #11 — Orphan events archive

**Severity:** Warning

`events-archive.jsonl` exists without sibling `state.yml`, or legacy `<slug>-status-archive.md` exists without legacy status.

**`--fix` action:** Suggest moving the archive to `<config.archive_path>/<date>/`. No auto-fix.

---

## Check #12 — Telemetry file growth

**Severity:** Warning

`telemetry.jsonl` OR `subagents.jsonl` (or legacy equivalents) > 5 MB.

**`--fix` action:** Rotate to `telemetry-archive.jsonl` / `subagents-archive.jsonl` (the active file becomes empty; new appends start fresh).

---

## Check #13 — Orphan telemetry file

**Severity:** Warning

`telemetry.jsonl` (or archive) exists without sibling `state.yml`, or legacy telemetry exists without legacy status.

**`--fix` action:** Suggest moving to `<config.archive_path>/<date>/`. No auto-fix.

---

## Check #14 — Orphan eligibility cache

**Severity:** Warning

`eligibility-cache.json` exists without sibling `state.yml`, or legacy cache exists without legacy status.

**`--fix` action:** Suggest moving to `<config.archive_path>/<date>/`. No auto-fix.

---

## Check #15 — `parallel-group:` set but `**Files:**` block missing/empty

**Severity:** Warning

`parallel-group:` set but `**Files:**` block missing/empty. Section 2 eligibility rule 2 violated. Affects parallel-eligibility computation; task falls back to serial silently.

**`--fix` action:** Report only. Author must add `**Files:**` block.

---

## Check #16 — `parallel-group:` and `**Codex:** ok` both set on the same task

**Severity:** Warning

`parallel-group:` and `**Codex:** ok` both set on the same task. Section 2 eligibility rule 4 violated; FM-4 mitigation conflict (mutually exclusive).

**`--fix` action:** Report only. Author must remove one of the annotations.

---

## Check #17 — File-path overlap detected within a `parallel-group:`

**Severity:** Warning

File-path overlap detected within a `parallel-group:`. Section 2 eligibility rule 5 violated. Multiple tasks in the same parallel-group declare overlapping `**Files:**` paths.

**`--fix` action:** Report the overlapping task pairs. No auto-fix.

---

## Check #18 — Codex config on but plugin missing

**Severity:** Warning

Config has `codex.routing != off` OR `codex.review == on` AND no entry prefixed `codex:` is present in the system-reminder skills list at lint time. Step 0's codex-availability detection auto-degrades silently per-run; doctor surfaces the persistent misconfiguration as a Warning so the user notices and either installs codex or sets the defaults to `off`.

**`--fix` action:** Suggest `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex` to enable, OR set `codex.routing: off` and `codex.review: off` in `.masterplan.yaml` to suppress this check. No auto-fix (changing user's config is out of scope per CD-2).

---

## Check #19 — Orphan subagents file

**Severity:** Warning

`subagents.jsonl` exists with no sibling `state.yml`, or legacy `<slug>-subagents.jsonl` / `<slug>-subagents-cursor` exists with no legacy status.

**`--fix` action:** Suggest moving the subagents file to `<config.archive_path>/<date>/`. Cursor file (if present) can simply be deleted. No auto-fix.

---

## Check #20 — Codex routing configured but eligibility cache missing

**Severity:** Warning

`state.yml` has `codex_routing: auto` OR `codex_routing: manual` AND no bundled `eligibility-cache.json` exists AND `events.jsonl` has at least one `routing→` or `[codex]`/`[inline]` entry.

**`--fix` action:** `--fix`: Rebuild `eligibility-cache.json` deterministically (mirrors Step C step 1's Build path), append an event `eligibility cache: rebuilt (...) -- via doctor --fix`, and commit the cache/state update.

---

## Check #21 — Step C step 1 cache-build evidence missing

**Severity:** Warning

`state.yml` has `codex_routing: auto` OR `codex_routing: manual` AND task-completion events exist AND no event contains `eligibility cache:`.

**`--fix` action:** Same action as #20. No-`--fix`: suggest re-running the next task via `/masterplan execute <state-path>` with codex installed, or setting `codex_routing: off` in `state.yml` if codex is intentionally disabled for this plan.

---

## Check #22 — High-complexity plan missing rigor evidence

**Severity:** Warning

Fires when `state.yml` has `complexity: high` AND the run lacks ALL THREE of: (a) a retro artifact/event, (b) at least one `Codex review:` event indicating a review pass, (c) `[reviewed: ...]` tags in >= 50% of task-completion events. Skipped on `complexity: low` and `complexity: medium`.

**`--fix` action:** No auto-fix. Suggest re-running the most recent task with `--complexity=medium` if high is overkill, OR running `/masterplan retro` to generate the retro reference.

---

## Check #23 — Opus on bounded-mechanical dispatch sites

**Severity:** Warning

(C.1 mitigation, v2.8.0+). Scans the most recent `min(20, len(jsonl))` entries in `subagents.jsonl` for records whose **EITHER** `dispatch_site` substring-matches `Step C step 1`, `Step C step 2 wave dispatch`, or `Step C step 2 SDD` (per the §Agent dispatch contract dispatch-site mapping table) **OR** `routing_class == "sdd"` (the hook's classification when `subagent_type` contains `subagent-driven-development`) **AND** whose `model` field is `opus`. Excludes records whose `prompt_first_line` matches `re-dispatched with model=opus per blocker gate` (intentional escalation per the wave-member retry path). Indicates the model-passthrough override clause leaked or was missing in the orchestrator's SDD/wave brief — cost regression today; potentially a correctness issue if it indicates upstream skill-prompt drift.

**`--fix` action:** Surface `AskUserQuestion` per finding: "Detected `<N>` SDD/wave/eligibility dispatch(es) with `model: opus` (cost contract calls for sonnet). How to proceed? — `Run \`bin/masterplan-self-host-audit.sh --models\` to lint orchestrator dispatch sites (Recommended)` / `Investigate transcript: print suspected session prompts from JSONL` / `Suppress for this plan (sets model_attribution_suppressed: true in state.yml)` / `Skip this finding only`". The first option chains into running the audit script and surfacing its output. See §Agent dispatch contract recursive-application for the verbatim preamble that should be present in SDD invocations.

---

## Check #24 — State-write queue file present and non-empty

**Severity:** Warning

(F.4 mitigation, v2.8.0+). `state.queue.jsonl` exists with non-zero size, AND `state.yml` shows no `last_activity` update within the last `config.loop_interval_seconds`.

**`--fix` action:** `--fix`: replay each queued entry into `events.jsonl` / `state.yml` idempotently, then truncate the queue file. No-`--fix`: report queued-entry count + suggest `/masterplan --resume=<state-path>` to trigger drain naturally.

---

## Check #25 — Reserved

_This check ID was retired in an earlier version. Reserved to prevent renumbering of subsequent checks._

---

## Check #26 — `auto_compact_loop_attached`

**Severity:** Warning

(repo-scoped). Skipped silently when `config.auto_compact.enabled == false`, or when no `docs/masterplan/*/state.yml` has `compact_loop_recommended: true`. Otherwise calls `CronList()` and filters entries whose `prompt` contains `/compact`.

**`--fix` action:** No `--fix` available; report the copy-pasteable `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` command and the run slugs whose `state.yml` has `compact_loop_recommended: true`.

---

## Check #27 — Reserved

_This check ID was retired in an earlier version. Reserved to prevent renumbering of subsequent checks._

---

## Check #28 — `completed_plan_without_retro`

**Severity:** Warning

(plan-scoped). Detects completed run bundles with no `retro.md`, or legacy completed plans without a migrated bundle/retro.

**`--fix` action:** Surface `AskUserQuestion` per finding: generate retro + archive run bundle (Recommended), generate retro only, skip this plan, or skip all findings this run.

---

## Check #29 — Worktree-bundle reconciliation mismatch

**Severity:** Warning

(v4.0.0+). Cross-repo: enumerate `git worktree list --porcelain` for the current repo; for each worktree path, find any bundle's `state.yml.worktree:` pointing at it. Surface: (a) bundles claiming a worktree path not registered in `git worktree list` (`worktree_missing`); (b) worktree paths registered in git with no bundle pointer (`worktree_orphan_untracked`). Skip worktrees with `worktree_disposition: removed_after_merge` or `kept_by_user` — those are intentionally settled.

**`--fix` action:** `--fix`: for (a), set `worktree_disposition: missing`, clear `worktree:` field, write state, commit. For (b): report only (user must decide).

---

## Check #30 — Cross-manifest version drift

**Severity:** Warning

(repo-scoped, v4.2.1+). Reads the three version-bearing manifests — `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root `version` AND nested `plugins[0].version`), `.codex-plugin/plugin.json` — and compares each `version` field against the canonical. `.agents/plugins/marketplace.json` is exempt (no `version` field by schema). Catches the v3.4.0–v4.1.1 drift pattern where `.claude-plugin/marketplace.json` was stuck at 3.3.0 across four releases. **Implementation:** runs inline at the orchestrator (does NOT dispatch per-worktree). Use the Read tool to load each manifest, extract `version` (and the nested `plugins[0].version` for `.claude-plugin/marketplace.json`), compare against `.claude-plugin/plugin.json` as canonical. Any mismatch → emit one Warning per drifted file/field: `version drift: <file>[:<json-path>] at <observed> (canonical: <canonical>)`.

**`--fix` action:** Report only. Auto-bumping is risky — canonical-source authority is ambiguous when multiple manifests have drifted. Suggest editing alongside the CHANGELOG entry for the next release.

---

## Check #31 — Per-autonomy gate-condition consistency

**Severity:** Warning

(repo-scoped, v4.2.1+). Maintains a static anchor table mapping gate-decision sites in `commands/masterplan.md` to their expected `--autonomy [!=]= <value>` conditions. Initial table: `{anchor: "id: spec_approval", expected_regex: "--autonomy != full", note: "spec gate intentionally fires under loose (L1286)"}`, `{anchor: "id: plan_approval", expected_regex: "--autonomy == gated", note: "plan gate auto-approves under loose per v4.2.0 (L1360)"}`. **Implementation:** runs inline at the orchestrator. For each table entry: grep `commands/masterplan.md` for the anchor string, read the next 3 lines, regex-match the expected condition. Anchor not found → flag missing gate site. Anchor found but condition mismatches → flag drift with observed text. Maintainers adding a new gate site to the orchestrator MUST extend this static table; an existing entry that no longer matches → loud Warning.

**`--fix` action:** Report only. Auto-rewriting gate conditions in the orchestrator prompt is never safe — these are deliberate semantic choices made per-release.

---

## Output

Plain-text grouped report. Apply **CD-10**: order findings by severity (errors first, then warnings), each line grounded in `<worktree>:<file>` so the user can jump straight to the offender. Summary line at the end with counts: `<E> errors, <W> warnings across <N> worktrees`. If `--fix` ran, include a list of files changed/moved.

**`--fix` actionability diagnostic (v2.14.0+).** When `--fix` ran but produced **0 file changes** despite **N > 0 findings**, surface a top-line warning BEFORE the per-finding details (not buried in the trailing summary):

```
⚠ doctor --fix found <N> warnings, 0 of which match the auto-fix action set.
   Findings grouped by check:
     #<check-num> (<short title>) ×<count> — <one-line remediation hint>
   ...
   See per-finding details below for full remediation paths.
```

Suppress this top-line warning when ≥ 1 file change occurred (in that case the changed-files list IS the evidence; no extra diagnostic needed) and when no `--fix` flag was passed (no-`--fix` runs are read-only by definition). Without this diagnostic, the historical UX failure (issue #1) was: user ran `--fix`, got 10 warnings + a buried "0 files changed/moved" line, and concluded `--fix` was broken. The diagnostic makes "all your findings are in the no-auto-fix set" loud, so the gap between detected and remediable is explicit.

If no issues: `masterplan doctor: clean (<N> worktrees, <P> plans)`.

**End-of-run gate (no `--fix` flag).** After emitting the report, when `--fix` was NOT passed AND at least one finding maps to an auto-fix action (checks with a non-"Report only" fix cell: #1a, #2, #3, #9, #12, #20, #21, #24) — fixable count F > 0:

```
AskUserQuestion(
  question="doctor found <E> error(s), <W> warning(s) — <F> are auto-fixable. Run --fix to apply?",
  options=[
    "Run --fix now (Recommended) — repairs schema gaps, rebuilds missing caches, rotates oversized telemetry, removes stale-duplicate snapshots; 'report only' findings left for manual resolution",
    "Leave as-is — exit now; run /masterplan doctor --fix whenever ready"
  ]
)
```

When the user picks "Run --fix now": execute Step D with `--fix` semantics inline — skip re-emitting the detection report; emit only the changed-files list + updated summary line. Omit this gate when `--fix` was already passed, when F = 0 (nothing auto-fixable), or when the report is clean.

---

## Check #32: state.yml scalar cap + overflow pointer integrity

**Severity:** Warning
**Action:** Report-only

For every `state.yml` in `docs/masterplan/*/`, verify:
1. Every scalar value (`key: <value>` and every list item) is ≤200 characters.
2. Any scalar matching `*overflow at <file> L<n>*` resolves: `<file>` exists in the bundle dir AND `<n>` is a valid line number.

```bash
fail=0
for s in docs/masterplan/*/state.yml; do
  while IFS= read -r line; do
    # strip leading whitespace + key prefix; extract value
    val="${line#*: }"
    if [ "${#val}" -gt 200 ]; then
      echo "WARN $s: scalar exceeds 200 chars on line: ${line:0:80}..."
      fail=1
    fi
    # overflow pointer integrity
    if [[ "$val" =~ \*overflow\ at\ ([^\ ]+)\ L([0-9]+)\* ]]; then
      target="$(dirname "$s")/${BASH_REMATCH[1]}"
      lineno="${BASH_REMATCH[2]}"
      if [ ! -f "$target" ]; then
        echo "WARN $s: overflow target missing: $target"; fail=1
      elif [ "$(wc -l < "$target")" -lt "$lineno" ]; then
        echo "WARN $s: overflow target $target has fewer than $lineno lines"; fail=1
      fi
    fi
  done < <(grep -E '^[[:space:]]*[a-zA-Z_-]+:' "$s")
done
[ $fail -eq 0 ] && echo "Check #32: PASS" || echo "Check #32: WARN"
```

---

## Check #33: TaskCreate projection mode mismatch

**Severity:** Warning
**Action:** Report-only

For each active run bundle: compute the current projection mode from
`tasks.projection_threshold` vs `len(plan.tasks)`. Compare against the actual
TaskList ledger entries owned by this run. Warn if they disagree (stale
projection entries past threshold cross, or missing projection when within
threshold).

```bash
# Pseudocode — requires reading TaskList state via runtime
# Skip when no TaskList API access; report SKIPPED.
echo "Check #33: SKIPPED (requires TaskList API access — runtime-only)"
```

Note: this check is best executed by the orchestrator itself during `doctor`
verb dispatch, where TaskList API access is available. Standalone CLI runs of
this check report SKIPPED.
