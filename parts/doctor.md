# Doctor — Self-Host Checks (#1 .. #50)

Invoked via `/masterplan doctor [--fix]`. Loaded by the router only when verb == doctor. Checks #32–#36 added in Wave C. Check #38 added in v5.1.0 (failure-instrumentation framework). Checks #39–#41 added in v5.1.1 (cosmic-cuddling-dusk Codex-routing instrumentation); Check #42 (stale .lock) added in concurrency-guards wave; Check #43 (codex_review_coverage) added in codex-routing-fix wave. Checks #44–#45 added in v6.1.0 (adversarial-review-integration). Checks #46–#47 added in v6.2.0 (improve-subagents-parallelism). Check #48 added in v6.3.0 (masterplan-token-efficiency). Check #49 added in v6.3.1 (stale-codex-task detection — surfaced by production telemetry 2026-05-25). Check #50 added in v6.3.3 (plugin registry drift — installed_plugins.json pinned to v5.8.3 for three weeks while v6.x shipped).

**Entry breadcrumb.** Emit on first line of this step (per Step 0 §Breadcrumb emission contract):

```
<masterplan-trace step=doctor phase=in verb=doctor halt_mode=none autonomy={autonomy}>
/masterplan doctor › Doctor  [{slug-if-bundle-loaded}]
```

Doctor fires `<masterplan-trace gate=fire id=doctor-finding auq-options=<n>>` immediately before each `AskUserQuestion` raised by an interactive check (#28 completed-plan-without-retro, #23 opus-on-bounded, etc.). The exit breadcrumb fires when Doctor returns or closes the turn per CC-3-trampoline.

Triggered by `/masterplan doctor [--fix]`. Lints all masterplan state across all worktrees of the current repo.

### Scope

Read worktrees from `git_state.worktrees` (Step 0 cache). For each worktree, scan `<worktree>/<config.runs_path>/` plus legacy `<worktree>/<config.specs_path>/` and `<worktree>/<config.plans_path>/`.

**Parallelization.** When worktrees ≥ 2, dispatch one Haiku agent (pass `model: "haiku"` per §Agent dispatch contract) per worktree in a single Agent batch (each agent runs all plan-scoped checks (currently #1-24, #28, #29, #32, #34, #35, #38, #40, #41, #42, #43, #45) for its worktree and returns findings as `[{check_id, severity, file, message}]` JSON). With 1 worktree, run inline — agent dispatch latency isn't worth it. The orchestrator merges results and applies the report ordering below.

**Repo-scoped checks #26 / #30 / #31 / #36 / #39 / #44 / #46 / #47 / #48 / #49 / #50 (v5.4.0+ — single Haiku batch).** These eleven checks fire ONCE per doctor run regardless of worktree/plan count. Before v5.4.0 they ran inline at the orchestrator (serial reads, ~5 round-trips through the Opus context). v5.4.0+ dispatches a single Haiku in the SAME Agent batch as the per-worktree Haikus above, so all parallelizable doctor work returns in one wave. Inputs per check: #26 (`auto_compact_loop_attached`, v2.9.1+) consumes `CronList` output (session-level state — the Haiku must call `ToolSearch(query: "select:CronList", max_results: 1)` to load the deferred tool before invoking it); #30 (`cross_manifest_version_drift`, v4.2.1+) reads `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` (root `version` + nested `plugins[0].version`), `.codex-plugin/plugin.json`, and greps `README.md` for `Current release:`; #31 (`per_autonomy_gate_condition_consistency`, v4.2.1+) reads `parts/step-b.md` (v5.0+; gates moved from `commands/masterplan.md` during v5.0 lazy-load extraction); #36 (`router_ceiling_and_phase_file_sanity`, v5.0.0+) reads `commands/masterplan.md` size + checks `parts/step-*.md` existence; #39 (`codex_auth_expiry`, v5.1.1+) reads `~/.codex/auth.json` (user-global, not per-repo); #44 (`adversarial_review_config_valid`, v6.1.0+) reads `~/.masterplan.yaml` and `.masterplan.yaml` for the `adversarial_review` config key (global config tiers, not per-bundle); #46 (`cc2_self_enforcement`, v6.2.0+) scans `parts/step-*.md` for CC-2 sentinel presence; #47 (`return_shape_caps`, v6.2.0+) scans `parts/step-*.md` for uncapped return-shape descriptions; #48 (`codex_linked_worktree`, v6.3.0+) runs `git rev-parse --git-dir` vs `--git-common-dir` to detect linked-worktree topology where Codex sandbox cannot commit; #49 (`stale_codex_background_task`, v6.3.1+) scans `~/.claude/plugins/data/*/state/*/jobs/*.json` for non-terminal tasks whose `startedAt` is more than 24 hours ago — surfaces runaway background workers before they become multi-day orphans; #50 (`plugin_registry_drift`, v6.3.3+) compares the `superpowers-masterplan` version in `~/.claude/plugins/installed_plugins.json` against `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/.claude-plugin/plugin.json` — when they differ, Claude Code silently runs an older build and newly shipped features are invisible at runtime. Brief shape:

```
DISPATCH-SITE: Step D doctor repo-scoped checks

contract_id: "doctor.repo_scoped.schema_v1"
Follow the algorithm defined in commands/masterplan-contracts.md §Contract: doctor.repo_scoped.schema_v1.
Goal: Run the eleven repo-scoped doctor checks (#26, #30, #31, #36, #39, #44, #46, #47, #48, #49, #50) in one pass. Each check's input list and decision rule is also enumerated in the per-check rows below the Severity / Action Table.
Inputs: repo root path; for #26, first load CronList via ToolSearch(query: "select:CronList", max_results: 1).
Scope: read-only.
Return shape: {contract_id: "doctor.repo_scoped.schema_v1", checks_processed: [26, 30, 31, 36, 39, 44, 46, 47, 48, 49, 50], violations: [{check_id, severity, file, message}] (≤ 50 items), notes: "<optional>"}.
```

**Partial-failure handling.** If the repo-scoped Haiku returns malformed JSON, missing `contract_id`, OR `checks_processed` ≠ `[26, 30, 31, 36, 39, 44, 46, 47, 48, 49, 50]`, the orchestrator falls back to running the eleven checks inline (pre-v5.4.0 path) and appends one `doctor_repo_scoped_haiku_fallback` event to the bundle-agnostic doctor telemetry log. Single missing-check (e.g., #26 returned `CronList unavailable`) is reported as a per-check INFO and does NOT trigger full fallback. (Self-host audits — deployment-drift detection and CD-9 free-text-question grep — moved to `bin/masterplan-self-host-audit.sh` in v2.11.0; that script is developer-only and runs against the project repo, not the user's working repo.)

Plan-scoped check #28 (`completed_plan_without_retro`, v2.11.0+) is interactive: when it fires it surfaces `AskUserQuestion` to the user, so it can NOT be parallelized inside Haiku worktree dispatchers — instead each worktree's Haiku returns the candidate-list, and the orchestrator drives the prompts inline (sequentially) after the parallel detection completes. Plan-scoped check #29 (`worktree_bundle_reconciliation_mismatch`, v4.0.0+) is a lightweight repo-scoped structural check that applies to all complexity levels.

Each per-worktree Haiku dispatch must use this bounded brief form:

```
DISPATCH-SITE: Step D doctor checks

contract_id: "doctor.schema_v2"
Follow the algorithm defined in commands/masterplan-contracts.md §Contract: doctor.schema_v2.
Goal: Run all plan-scoped doctor checks for the bundle paths in this worktree's runs_path.
Inputs: worktree path, runs_path glob, legacy paths glob.
Scope: read-only.
Return shape: {contract_id: "doctor.schema_v2", inputs_hash: "<sha256 of bundle state.yml paths processed>", processed_paths: [list of state.yml paths (≤ 20 items)], violations: [{bundle, field, kind, detail}] (≤ 200 items), coverage: {expected: N, processed: N}}.
```

**Sampling-based parent re-verification** (after Haiku wave, before emitting findings): re-verify 3 randomly selected bundles + any bundle with Haiku violations. Run as a single parallel Bash batch (background N greps, `wait`): grep state.yml for `^retro: ""` and missing `import_hydration`. On discrepancy: append `parent_reverify_mismatch` event, prefer parent findings, emit `⚠ doctor parent re-verify found <N> additional violation(s) not in Haiku return — using parent findings.`

**Legacy-reference index.** Before running legacy-artifact checks, build a per-worktree set of all paths referenced by every bundle `state.yml` under `artifacts.*` and `legacy.*`, normalized relative to that same worktree. A legacy file under `docs/superpowers/...` that appears in this referenced-path set is already attached to durable masterplan state. Do not report it as "legacy plan not migrated" merely because the legacy filename slug differs from the bundle directory slug.

**Complexity-aware check set.** For each scanned plan, read `complexity` from `state.yml` (default `medium` if absent — legacy/pre-feature plans). The active check set varies:

- `low` plans: run only checks #1 (orphan plan), #2 (orphan status), #3 (wrong worktree), #4 (wrong branch), #5 (stale in-progress), #6 (stale critical error), #8 (missing spec), #9 (schema, against the standard run-state field set), #10 (unparseable), #18 (codex misconfig), #29 (worktree-bundle reconciliation mismatch), #38 (anomaly file has records since last archive), #41 (missing degradation evidence — fires regardless of complexity when Codex was configured on), #42 (stale .lock file — cheap structural check), #43 (codex review coverage — event-log consistency check), #45 (adversarial review gate-fire audit). SKIP all sidecar / annotation / ledger / cache / queue / per-subagent-telemetry checks (#11–#17, #19–#21, #23, #24) — low plans do not produce those artifacts. Also skip #22 and #40 (both high-only — see below).
- `medium` plans: run all plan-scoped checks (currently #1-24, #28, #29, #32, #34, #35, #38, #41, #42, #43, #45) except #22 and #40 (both high-only).
- `high` plans: run all plan-scoped checks (currently #1-24, #28, #29, #32, #34, #35, #38, #40, #41, #42, #43, #45) INCLUDING #22 (high-complexity rigor evidence) and #40 (missing Codex/parallel-group annotations at complexity:high).
- Plans without a `complexity:` state field: treat as `medium`.

Check-set gate is per-plan (a mixed worktree run honors each plan's complexity individually). Self-host audits run via `bin/masterplan-self-host-audit.sh`, not doctor.

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
| 30 | **Cross-manifest version drift** (repo-scoped, v4.2.1+). Reads the three version-bearing manifests — `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root `version` AND nested `plugins[0].version`), `.codex-plugin/plugin.json` — and compares each `version` field against the canonical. `.agents/plugins/marketplace.json` is exempt (no `version` field by schema). Also reads `README.md` and greps for a line matching `Current release:.*v[0-9]+\.[0-9]+\.[0-9]+`; if found, compares the extracted version against canonical. Catches the v3.4.0–v4.1.1 drift pattern where `.claude-plugin/marketplace.json` was stuck at 3.3.0 across four releases, and the v3.2.7–v5.0.1 README drift. **Implementation:** runs inline at the orchestrator (does NOT dispatch per-worktree). Use the Read tool to load each manifest, extract `version` (and the nested `plugins[0].version` for `.claude-plugin/marketplace.json`), compare against `.claude-plugin/plugin.json` as canonical. Any mismatch → emit one Warning per drifted file/field: `version drift: <file>[:<json-path>] at <observed> (canonical: <canonical>)`. For README: if the `Current release:` line is absent, no warning (version was intentionally removed). | Warning | Report only. Auto-bumping is risky — canonical-source authority is ambiguous when multiple manifests have drifted. Suggest editing alongside the CHANGELOG entry for the next release. |
| 31 | **Per-autonomy gate-condition consistency** (repo-scoped, v4.2.1+). Static anchor table for gate-decision sites in `parts/step-b.md`: `spec_approval` expects `--autonomy != full`; `plan_approval` expects `--autonomy == gated`. For each entry: grep `parts/step-b.md` for anchor, read next 3 lines, regex-match condition. Anchor missing → flag missing site; condition mismatch → flag drift. Extend table when adding new gate sites. Implementation: inline. | Warning | Report only. Auto-rewriting gate conditions in the orchestrator prompt is never safe — these are deliberate semantic choices made per-release. |
| 32 | **state.yml scalar cap + overflow pointer** — every scalar value in `state.yml` ≤200 chars; overflow pointers resolve to existing files with valid line numbers. | Warning | Report-only |
| 33 | **TaskCreate projection mode mismatch** — active run bundle projection mode vs TaskList ledger disagrees. | Warning | Report-only |
| 34 | **plan.index.json staleness** — `plan_hash` in `state.yml` or `plan.index.json` doesn't match current `plan.md` sha256. | Warning | Report-only |
| 35 | **Plan-format conformance (v5.0 markers)** — every task heading in `plan.md` must be followed by `**Spec:**` and `**Verify:**` markers within 30 lines. | Warning | Report-only |
| 36 | **parts/step-*.md sanity + router ceiling** — `commands/masterplan.md` ≤20480 bytes; all phase files exist; CC-3-trampoline and DISPATCH-SITE tags present. | Warning | Report-only |
| 38 | **Anomaly file has records since last archive** — `<run-dir>/anomalies.jsonl` (or sidecar `anomalies-pending-upload.jsonl`) is non-empty for any in-progress or recently-archived bundle, indicating failure-instrumentation framework detected ≥1 orchestrator anomaly that has not been reviewed. | Warning | Report each anomaly record: class, signature, last-fired timestamp. If `anomalies-pending-upload.jsonl` is non-empty, suggest `bin/masterplan-anomaly-flush.sh` to drain to GitHub. Report-only otherwise. |
| 39 | **Codex auth expired or stale** (repo-scoped, v5.1.1+, refined v5.2.3+). Reads `~/.codex/auth.json`. Decodes JWT `exp` claim from `id_token` and `access_token` (nested under `.tokens.*` per schema_v3+; falls back to top-level for older schemas). Fires on: (a) either token expired (`now > exp`); (b) either token expires within 24h (`exp - now < 86400`); (c) `last_refresh` > 30 days ago even when tokens are within validity. **Skipped (returns PASS-with-info) when `auth_mode == "chatgpt"` AND `tokens.refresh_token` is present AND `last_refresh` is within the last 7 days** — that shape indicates the ChatGPT mode's short-lived JWT auto-refresh is healthy, so cosmetic `id_token.exp` past `now` is normal steady state, not degradation. Diagnoses the upstream cause of Codex routing/review silently degrading to off — Step 0's ping returns an error, the framework correctly applies `degrade-loudly`, but the user has no idea WHY. Pairs with check #18 (config-vs-plugin mismatch): #18 flags persistent misconfig; #39 flags expired credentials. Skipped silently when `~/.codex/auth.json` is absent (codex not installed). | Warning | Report per-token expiry timestamp + age in days. Suggest `codex login` (or equivalent shell-based refresh — varies by codex CLI version). No auto-fix (auth refresh is browser-based OAuth, user-owned per headless-host constraint). |
| 40 | **High-complexity plan missing Codex / parallel-group annotations** (plan-scoped, v5.1.1+, I-2 of cosmic-cuddling-dusk). Fires when `state.yml.complexity == "high"` AND the plan-scoped count of `**Codex:** (ok|no|true|false)` annotations in `plan.md` is LESS than the count of task headings (`^### Task `). Also INFO-flags when `state.yml.complexity == "high"` AND zero `**parallel-group:**` annotations exist in plan.md. Per `parts/step-b.md` complexity-aware brief, `complexity: high` REQUIRES a `**Codex:**` annotation per task and ENCOURAGES `**parallel-group:**` annotations for verification/lint/inference clusters; this check catches the writing-plans skill silently skipping the high-complexity brief, which suppresses Codex routing (eligibility cache falls back to heuristic-only) and parallel-wave dispatch (wave assembly pre-pass has nothing to assemble). Skipped silently on `complexity: low` and `complexity: medium`. | Warning | Report per-plan: complexity, task count, Codex annotation count, parallel-group annotation count, and the gap. Suggest re-running `/masterplan plan --from-spec=<spec>` to regenerate with the high-complexity brief, OR annotating by hand. No auto-fix (modifying plan.md mid-execution is risky per CD-7). |
| 41 | **Missing Codex degradation evidence** (plan-scoped, v5.1.1+, expanded v5.3.0+, false-positive fix v5.7.1). Three sub-fires: (a) WARN when `state.yml.codex_routing == off` AND `state.yml.codex_review == off` AND `~/.codex/auth.json` is healthy AND `events.jsonl` has NO `codex degraded` event AND `state.yml.last_warning` is null/absent AND `events.jsonl` has at least one Codex-related event (`codex_ping`, `codex degraded`, `routing→[codex]`) — skipped when zero Codex events exist (Codex was configured off from bundle creation; no evidence required). (b) INFO when `state.yml.codex_routing == auto` OR `state.yml.codex_routing == manual` AND `events.jsonl` has NO `routing→.*\[codex\]` events anywhere AND `events.jsonl` has at least one `codex_ping ok` event (suggesting ping detected codex available but every task was judged ineligible by the planner or heuristic — symptomatic of root cause #2 in cosmic-cuddling-dusk: annotation-gap in plan). **(c) v5.3.0+ — Step 0 confabulation detector.** ERROR when `events.jsonl` contains a `degradation_self_doubt` event (Step 0 self-flagged a likely false-positive at warning-time) OR `events.jsonl` contains a `codex degraded — plugin not detected` event AND `~/.codex/auth.json` is healthy AND `ls ~/.claude/plugins/*/codex* 2>/dev/null` finds the codex plugin's files on disk. Indicates Step 0 emitted the degradation warning despite all on-disk evidence pointing to a healthy install — likely orchestrator confabulation under the legacy `ping` detection mode (fixed by default flip to `scan-then-ping` in v5.3.0). Pairs with #20/#21 from a different angle. | Warning (sub-fires a, b) / Error (sub-fire c) | Report each sub-fire with diagnostic context. For (a): suggest investigating why codex was forced off without trace — possibly Step 0 ping bug. For (b): cross-reference with #40 finding for the same plan. For (c): suggest setting `detection_mode: scan-then-ping` in `.masterplan.yaml` (or removing the explicit `ping` override) and re-running `/masterplan`. No auto-fix. |
| 42 | **Stale `.lock` file in bundle** (concurrency-guards wave). For each run bundle, stat `<bundle>/.lock` if present. Fires when the file's mtime is older than 1 hour. Indicates a writer process crashed or wedged before releasing the `flock` (Guard C). The framework still functions — the next write blocks 5 s, then proceeds when `flock` reaps the abandoned lock. False-positive risk is non-zero (a legitimate long-running write during the stat window). | Warning | Report only (no auto-remediation). Confirm no live writer process holds the lock, then `rm <bundle>/.lock`. |
| 43 | **codex_review_coverage** — For each run bundle's `events.jsonl`, every `wave_task_completed` event must have a paired `review→CODEX(...)` or `review→SKIP(<reason>)` event with explicit `decision_source`. Coverage = paired_reviews / wave_task_completed events. Skip entirely for Codex-hosted runs. | Warning (coverage < 100% and run was not inside Codex host) / Skip (Codex-hosted run) | Report bundle slug, coverage percentage, and list of `wave_task_completed` events lacking a paired `review→` event. |
| 44 | **`adversarial_review` config valid** (repo-scoped, v6.1.0+). If `adversarial_review` key is present in `~/.masterplan.yaml` or `.masterplan.yaml`, validates value is one of `off`, `spec`, `plan`, `both`. | Warning | Report-only; no auto-fix. |
| 45 | **Adversarial review gate-fire audit** (plan-scoped, v6.1.0+). For each completed bundle where `adversarial_review != off`, verifies `events.jsonl` contains `adversarial_review_complete` events for both `spec_approval` and `plan_approval` gates. Historical bundles predating v6.1.0 always fire INFO. | Info | Report-only. |
| 46 | **CC-2 self-enforcement** (prompt-scoped, v6.2.0+). Scans `parts/step-*.md` for 3+ consecutive Bash-type directives feeding one decision without an upstream `dispatch Haiku` or `DISPATCH-SITE:` gate. | Warning | Report-only. |
| 47 | **Return-shape caps** (prompt-scoped, v6.2.0+). Scans `parts/step-*.md` for `Return shape:` blocks lacking item-count constraints (`max`, `≤`, `limit`). | Warning | Report-only. |
| 48 | **Codex dispatch blocked by linked-worktree** (repo-scoped, v6.3.0+). Detects when masterplan runs in a linked git worktree where Codex sandbox cannot commit (`.git` index lives outside the workspace path; `git_dir` ≠ `git_common`). | Warning | Report-only. |
| 49 | **Stale Codex background task** (user-scoped, v6.3.1+). Scans `~/.claude/plugins/data/*/state/*/jobs/*.json` for tasks whose `status` is non-terminal (not `completed`, `done`, `cancelled`, `failed`, or `error`) and whose `startedAt` is more than 24 hours ago. Surfaces runaway background workers (e.g., tasks stuck in `verifying` phase) before they become multi-day orphans. Skipped when the plugin data directory is absent. | Warning | Report-only; emits `node <companion> cancel <task-id>` suggestion for each stale task when the codex-companion.mjs is resolvable. |

---

## Check #1 — Legacy plan not migrated

**Severity:** Warning

pre-v3 plan/spec/status/retro exists under `docs/superpowers/...`, is not referenced by any bundle `state.yml` `artifacts.*` or `legacy.*` path in the same worktree, and has no matching `docs/masterplan/<slug>/state.yml`.

**`--fix` action:** `--fix`: invoke `/masterplan import` and select `<slug>` from the picker (copy-only; no legacy delete).

```bash
fail=0
for d in docs/superpowers/*/; do
  [ -d "$d" ] || continue
  slug="$(basename "$d")"
  ref=0
  for s in docs/masterplan/*/state.yml; do
    [ -f "$s" ] || continue
    grep -qF "$slug" "$s" && ref=1 && break
  done
  [ $ref -eq 0 ] && [ ! -d "docs/masterplan/$slug" ] && {
    echo "WARN $d: legacy plan not migrated (not referenced by any bundle state.yml)"; fail=1
  }
done
[ $fail -eq 0 ] && echo "Check #1: PASS" || echo "Check #1: WARN"
```

---

## Check #2 — Orphan state

**Severity:** Error

`state.yml` points at a missing `artifacts.plan` / `artifacts.spec` required for its current `phase`, or a legacy status points at a missing plan.

**`--fix` action:** For bundle state: prompt to repair artifact path or mark archived. For legacy status: migrate if possible, otherwise move to `<config.archive_path>/<date>/`.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  phase="$(grep -E '^phase:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  spec="$(grep -E '^[[:space:]]+spec:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  plan_f="$(grep -E '^[[:space:]]+plan:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  if [ -n "$spec" ] && [ ! -f "$spec" ]; then
    echo "ERROR $state: artifacts.spec points at missing file: $spec"; fail=1
  fi
  case "$phase" in spec_gate|brainstorming|"") ;;
    *) [ -n "$plan_f" ] && [ ! -f "$plan_f" ] && \
       { echo "ERROR $state: artifacts.plan missing for phase=$phase: $plan_f"; fail=1; } ;;
  esac
done
[ $fail -eq 0 ] && echo "Check #2: PASS" || echo "Check #2: ERROR"
```

---

## Check #3 — Wrong worktree path

**Severity:** Error

`state.yml`'s `worktree` doesn't match any current `git worktree list` entry.

**`--fix` action:** Try to match by branch name; rewrite if unique match. Otherwise report.

```bash
fail=0
declare -a valid_paths=()
while IFS= read -r wt; do
  valid_paths+=("$wt")
done < <(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}')
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  disp="$(grep -E '^worktree_disposition:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [[ "$disp" == "removed_after_merge" || "$disp" == "kept_by_user" ]] && continue
  wt="$(grep -E '^worktree:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ -z "$wt" ] && continue
  ok=0
  for vp in "${valid_paths[@]}"; do [ "$wt" = "$vp" ] && ok=1 && break; done
  [ $ok -eq 0 ] && { echo "ERROR $state: worktree '$wt' not in git worktree list"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #3: PASS" || echo "Check #3: ERROR"
```

---

## Check #4 — Wrong branch

**Severity:** Error

`state.yml`'s `branch` doesn't exist in `git branch --list`.

**`--fix` action:** Report only (manual fix).

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  disp="$(grep -E '^worktree_disposition:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [[ "$disp" == "removed_after_merge" || "$disp" == "kept_by_user" ]] && continue
  status_val="$(grep -E '^status:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [[ "$status_val" == "archived" ]] && continue
  branch="$(grep -E '^branch:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ -z "$branch" ] && continue
  git branch --list "$branch" 2>/dev/null | grep -q . \
    || { echo "ERROR $state: branch '$branch' not in git branch --list"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #4: PASS" || echo "Check #4: ERROR"
```

---

## Check #5 — Stale in-progress

**Severity:** Warning

`status: in-progress` with `last_activity` > 30 days.

**`--fix` action:** Report only.

```bash
fail=0
now="$(date +%s)"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  status="$(grep -E '^status:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$status" = "in-progress" ] || continue
  last="$(grep -E '^last_activity:' "$state" | head -1 | awk '{print $2}' | tr -d "'")"
  [ -z "$last" ] && continue
  ts="$(date -u -d "$last" +%s 2>/dev/null || echo 0)"
  age=$(( (now - ts) / 86400 ))
  [ $age -gt 30 ] && { echo "WARN $state: in-progress for ${age} days (last_activity $last)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #5: PASS" || echo "Check #5: WARN"
```

---

## Check #6 — Stale critical error

**Severity:** Warning

`status: blocked` or `stop_reason: critical_error` with `last_activity` > 14 days.

**`--fix` action:** Report only.

```bash
fail=0
now="$(date +%s)"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  status="$(grep -E '^status:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  stop="$(grep -E '^stop_reason:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$status/$stop" in blocked/*|*/critical_error) ;; *) continue ;; esac
  last="$(grep -E '^last_activity:' "$state" | head -1 | awk '{print $2}' | tr -d "'")"
  [ -z "$last" ] && continue
  ts="$(date -u -d "$last" +%s 2>/dev/null || echo 0)"
  age=$(( (now - ts) / 86400 ))
  [ $age -gt 14 ] && { echo "WARN $state: blocked/critical_error for ${age} days"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #6: PASS" || echo "Check #6: WARN"
```

---

## Check #7 — Plan/log drift

**Severity:** Warning

plan task count differs from activity-log task references by >50%.

**`--fix` action:** Report only.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  bundle="$(dirname "$state")"
  plan="$bundle/plan.md"
  events="$bundle/events.jsonl"
  [ -f "$plan" ] || continue
  task_count="$(grep -cE '^### Task [0-9]' "$plan" 2>/dev/null || echo 0)"
  [ "${task_count:-0}" -eq 0 ] && continue
  log_refs=0
  [ -f "$events" ] && log_refs="$(grep -cE '"task_completed"|"wave_task_completed"' "$events" 2>/dev/null || echo 0)"
  if [ "${log_refs:-0}" -gt 0 ]; then
    diff=$(( task_count - log_refs ))
    abs_diff="${diff#-}"
    pct=$(( abs_diff * 100 / task_count ))
    [ $pct -gt 50 ] && {
      echo "WARN $state: plan=$task_count tasks, events=$log_refs completions (${pct}% drift)"
      fail=1
    }
  fi
done
[ $fail -eq 0 ] && echo "Check #7: PASS" || echo "Check #7: WARN"
```

---

## Check #8 — Missing spec

**Severity:** Error

`state.yml`'s `artifacts.spec` points at a missing spec doc when the phase requires one.

**`--fix` action:** Report only; if `legacy.spec` exists, suggest re-copying it into the bundle.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  phase="$(grep -E '^phase:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$phase" in spec_gate|brainstorming|complete|archived|retro|"") continue ;; esac
  spec="$(grep -E '^[[:space:]]+spec:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  if [ -z "$spec" ] || [ ! -f "$spec" ]; then
    echo "ERROR $state: phase=$phase requires artifacts.spec; missing: ${spec:-<empty>}"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #8: PASS" || echo "Check #8: ERROR"
```

---

## Check #9 — Schema violation

**Severity:** Error

`state.yml` missing required fields. Required set: `schema_version`, `slug`, `status`, `phase`, `artifacts.spec`, `artifacts.plan`, `artifacts.events`, `worktree`, `branch`, `started`, `last_activity`, `current_task`, `next_action`, `autonomy`, `loop_enabled`, `codex_routing`, `codex_review`, `compact_loop_recommended`, `complexity`, `pending_gate`, `stop_reason`, `critical_error`.

**`--fix` action:** Add missing fields with sentinel/derived values where possible (e.g. `pending_gate: null`, `stop_reason: null`, `critical_error: null`, `compact_loop_recommended: false`); report the rest. Cross-check: for each `legacy.*` pointer that is non-empty, verify that the corresponding `artifacts.*` pointer is also non-empty AND the file exists on disk. If `legacy.spec` is non-empty but `artifacts.spec` is empty or the file is missing: flag as Error (not just schema violation — this is an unhydrated import). `--fix`: invoke the Step I3.5 rehydration logic inline (parent-side, not as a subagent). Do NOT add null sentinel values when a recoverable `legacy.*` path exists — that was the pre-v4.0 bug this check now prevents.

```bash
fail=0
required="schema_version slug status phase worktree branch started last_activity current_task next_action autonomy loop_enabled codex_routing codex_review compact_loop_recommended complexity pending_gate stop_reason critical_error"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  for field in $required; do
    grep -qE "^${field}:" "$state" \
      || { echo "ERROR $state: missing required field: $field"; fail=1; }
  done
  grep -qE '^[[:space:]]+spec:' "$state" \
    || { echo "ERROR $state: missing required field: artifacts.spec"; fail=1; }
  grep -qE '^[[:space:]]+plan:' "$state" \
    || { echo "ERROR $state: missing required field: artifacts.plan"; fail=1; }
  grep -qE '^[[:space:]]+events:' "$state" \
    || { echo "ERROR $state: missing required field: artifacts.events"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #9: PASS" || echo "Check #9: ERROR"
```

---

## Check #10 — Unparseable state file

**Severity:** Error

`state.yml` YAML is malformed, or legacy status frontmatter/body is malformed.

**`--fix` action:** Report only (manual fix needed). Step A skips these silently, but doctor calls them out.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  if command -v python3 >/dev/null 2>&1; then
    err="$(python3 -c "import yaml, sys; yaml.safe_load(open(sys.argv[1]))" "$state" 2>&1)"
    if [ -n "$err" ]; then
      echo "ERROR $state: YAML parse error: ${err:0:120}"; fail=1
    fi
  else
    grep -Pq '\t' "$state" 2>/dev/null \
      && { echo "ERROR $state: contains tab characters (YAML invalid)"; fail=1; }
  fi
done
[ $fail -eq 0 ] && echo "Check #10: PASS" || echo "Check #10: ERROR"
```

---

## Check #11 — Orphan events archive

**Severity:** Warning

`events-archive.jsonl` exists without sibling `state.yml`, or legacy `<slug>-status-archive.md` exists without legacy status.

**`--fix` action:** Suggest moving the archive to `<config.archive_path>/<date>/`. No auto-fix.

```bash
fail=0
for archive in docs/masterplan/*/events-archive.jsonl; do
  [ -f "$archive" ] || continue
  dir="$(dirname "$archive")"
  [ -f "$dir/state.yml" ] \
    || { echo "WARN $archive: orphan events archive (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #11: PASS" || echo "Check #11: WARN"
```

---

## Check #12 — Telemetry file growth

**Severity:** Warning

`telemetry.jsonl` OR `subagents.jsonl` (or legacy equivalents) > 5 MB.

**`--fix` action:** Rotate to `telemetry-archive.jsonl` / `subagents-archive.jsonl` (the active file becomes empty; new appends start fresh).

```bash
fail=0
threshold="${TELEMETRY_SIZE_THRESHOLD:-5242880}"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  dir="$(dirname "$state")"
  for f in "$dir/telemetry.jsonl" "$dir/subagents.jsonl"; do
    [ -f "$f" ] || continue
    sz="$(wc -c < "$f")"
    [ "$sz" -gt "$threshold" ] \
      && { echo "WARN $f: ${sz} bytes exceeds threshold (${threshold})"; fail=1; }
  done
done
[ $fail -eq 0 ] && echo "Check #12: PASS" || echo "Check #12: WARN"
```

---

## Check #13 — Orphan telemetry file

**Severity:** Warning

`telemetry.jsonl` (or archive) exists without sibling `state.yml`, or legacy telemetry exists without legacy status.

**`--fix` action:** Suggest moving to `<config.archive_path>/<date>/`. No auto-fix.

```bash
fail=0
for f in docs/masterplan/*/telemetry.jsonl docs/masterplan/*/telemetry-archive.jsonl; do
  [ -f "$f" ] || continue
  [ -f "$(dirname "$f")/state.yml" ] \
    || { echo "WARN $f: orphan telemetry file (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #13: PASS" || echo "Check #13: WARN"
```

---

## Check #14 — Orphan eligibility cache

**Severity:** Warning

`eligibility-cache.json` exists without sibling `state.yml`, or legacy cache exists without legacy status.

**`--fix` action:** Suggest moving to `<config.archive_path>/<date>/`. No auto-fix.

```bash
fail=0
for f in docs/masterplan/*/eligibility-cache.json; do
  [ -f "$f" ] || continue
  [ -f "$(dirname "$f")/state.yml" ] \
    || { echo "WARN $f: orphan eligibility cache (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #14: PASS" || echo "Check #14: WARN"
```

---

## Check #15 — `parallel-group:` set but `**Files:**` block missing/empty

**Severity:** Warning

`parallel-group:` set but `**Files:**` block missing/empty. Section 2 eligibility rule 2 violated. Affects parallel-eligibility computation; task falls back to serial silently.

**`--fix` action:** Report only. Author must add `**Files:**` block.

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  [ -f "$plan" ] || continue
  mapfile -t task_lines < <(grep -nE '^### Task [0-9]' "$plan" | cut -d: -f1)
  for i in "${!task_lines[@]}"; do
    start="${task_lines[$i]}"
    end="${task_lines[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    if printf '%s\n' "$block" | grep -qE '^\*\*parallel-group:\*\*'; then
      printf '%s\n' "$block" | grep -qE '^\*\*Files:\*\*' \
        || { echo "WARN $plan task at L$start: **parallel-group:** set but **Files:** missing"; fail=1; }
    fi
  done
done
[ $fail -eq 0 ] && echo "Check #15: PASS" || echo "Check #15: WARN"
```

---

## Check #16 — `parallel-group:` and `**Codex:** ok` both set on the same task

**Severity:** Warning

`parallel-group:` and `**Codex:** ok` both set on the same task. Section 2 eligibility rule 4 violated; FM-4 mitigation conflict (mutually exclusive).

**`--fix` action:** Report only. Author must remove one of the annotations.

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  [ -f "$plan" ] || continue
  mapfile -t task_lines < <(grep -nE '^### Task [0-9]' "$plan" | cut -d: -f1)
  for i in "${!task_lines[@]}"; do
    start="${task_lines[$i]}"
    end="${task_lines[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    if printf '%s\n' "$block" | grep -qE '^\*\*parallel-group:\*\*' \
    && printf '%s\n' "$block" | grep -qE '^\*\*Codex:\*\* (ok|true)'; then
      echo "WARN $plan task at L$start: **parallel-group:** and **Codex:** ok both set (mutually exclusive)"
      fail=1
    fi
  done
done
[ $fail -eq 0 ] && echo "Check #16: PASS" || echo "Check #16: WARN"
```

---

## Check #17 — File-path overlap detected within a `parallel-group:`

**Severity:** Warning

File-path overlap detected within a `parallel-group:`. Section 2 eligibility rule 5 violated. Multiple tasks in the same parallel-group declare overlapping `**Files:**` paths.

**`--fix` action:** Report the overlapping task pairs. No auto-fix.

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  [ -f "$plan" ] || continue
  declare -A group_files=()
  mapfile -t task_lines < <(grep -nE '^### Task [0-9]' "$plan" | cut -d: -f1)
  for i in "${!task_lines[@]}"; do
    start="${task_lines[$i]}"
    end="${task_lines[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    pg="$(printf '%s\n' "$block" | grep -E '^\*\*parallel-group:\*\*' | head -1 \
          | sed 's/^\*\*parallel-group:\*\* *//')"
    [ -z "$pg" ] && continue
    while IFS= read -r fpath; do
      [ -z "$fpath" ] && continue
      key="${pg}|${fpath}"
      if [ -n "${group_files[$key]:-}" ]; then
        echo "WARN $plan: file-path overlap in parallel-group '$pg': $fpath (tasks L${group_files[$key]} and L$start)"
        fail=1
      else
        group_files[$key]="$start"
      fi
    done < <(printf '%s\n' "$block" | grep -E '^- (Create|Modify|Test):' | awk '{print $NF}')
  done
  unset group_files
done
[ $fail -eq 0 ] && echo "Check #17: PASS" || echo "Check #17: WARN"
```

---

## Check #18 — Codex config on but plugin missing

**Severity:** Warning

Config has `codex.routing != off` OR `codex.review == on` AND no entry prefixed `codex:` is present in the system-reminder skills list at lint time. Step 0's codex-availability detection auto-degrades silently per-run; doctor surfaces the persistent misconfiguration as a Warning so the user notices and either installs codex or sets the defaults to `off`.

**`--fix` action:** Suggest `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex` to enable, OR set `codex.routing: off` and `codex.review: off` in `.masterplan.yaml` to suppress this check. No auto-fix (changing user's config is out of scope per CD-2).

```bash
fail=0
routing="off"; review="off"
for cfg in "$HOME/.masterplan.yaml" ".masterplan.yaml"; do
  [ -r "$cfg" ] || continue
  r="$(grep -E '^  routing:|^codex_routing:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  rv="$(grep -E '^  review:|^codex_review:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  [ -n "$r" ] && routing="$r"
  [ -n "$rv" ] && review="$rv"
done
if [ "$routing" != "off" ] || [ "$review" = "on" ]; then
  plugin_found=0
  ls "$HOME/.claude/plugins/"*codex* 2>/dev/null | grep -q . && plugin_found=1
  if [ $plugin_found -eq 0 ]; then
    echo "WARN codex.routing=$routing / codex.review=$review but no codex plugin found under ~/.claude/plugins/"
    fail=1
  fi
fi
[ $fail -eq 0 ] && echo "Check #18: PASS" || echo "Check #18: WARN"
```

---

## Check #19 — Orphan subagents file

**Severity:** Warning

`subagents.jsonl` exists with no sibling `state.yml`, or legacy `<slug>-subagents.jsonl` / `<slug>-subagents-cursor` exists with no legacy status.

**`--fix` action:** Suggest moving the subagents file to `<config.archive_path>/<date>/`. Cursor file (if present) can simply be deleted. No auto-fix.

```bash
fail=0
for f in docs/masterplan/*/subagents.jsonl; do
  [ -f "$f" ] || continue
  [ -f "$(dirname "$f")/state.yml" ] \
    || { echo "WARN $f: orphan subagents file (no sibling state.yml)"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #19: PASS" || echo "Check #19: WARN"
```

---

## Check #20 — Codex routing configured but eligibility cache missing

**Severity:** Warning

`state.yml` has `codex_routing: auto` OR `codex_routing: manual` AND no bundled `eligibility-cache.json` exists AND `events.jsonl` has at least one `routing→` or `[codex]`/`[inline]` entry.

**`--fix` action:** `--fix`: Rebuild `eligibility-cache.json` deterministically (mirrors Step C step 1's Build path), append an event `eligibility cache: rebuilt (...) -- via doctor --fix`, and commit the cache/state update.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  routing="$(grep -E '^codex_routing:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$routing" in auto|manual) ;; *) continue ;; esac
  dir="$(dirname "$state")"
  events="$dir/events.jsonl"
  [ -f "$events" ] || continue
  grep -qE 'routing→|\[codex\]|\[inline\]' "$events" 2>/dev/null || continue
  [ -f "$dir/eligibility-cache.json" ] \
    || { echo "WARN $state: codex_routing=$routing, routing events present, eligibility-cache.json missing"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #20: PASS" || echo "Check #20: WARN"
```

---

## Check #21 — Step C step 1 cache-build evidence missing

**Severity:** Warning

`state.yml` has `codex_routing: auto` OR `codex_routing: manual` AND task-completion events exist AND no event contains `eligibility cache:`.

**`--fix` action:** Same action as #20. No-`--fix`: suggest re-running the next task via `/masterplan execute <state-path>` with codex installed, or setting `codex_routing: off` in `state.yml` if codex is intentionally disabled for this plan.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  routing="$(grep -E '^codex_routing:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$routing" in auto|manual) ;; *) continue ;; esac
  dir="$(dirname "$state")"
  events="$dir/events.jsonl"
  [ -f "$events" ] || continue
  grep -qE '"task_completed"|"wave_task_completed"' "$events" 2>/dev/null || continue
  grep -qE 'eligibility cache:' "$events" 2>/dev/null \
    || { echo "WARN $state: codex_routing=$routing, completions exist, no 'eligibility cache:' event"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #21: PASS" || echo "Check #21: WARN"
```

---

## Check #22 — High-complexity plan missing rigor evidence

**Severity:** Warning

Fires when `state.yml` has `complexity: high` AND the run lacks ALL THREE of: (a) a retro artifact/event, (b) at least one `Codex review:` event indicating a review pass, (c) `[reviewed: ...]` tags in >= 50% of task-completion events. Skipped on `complexity: low` and `complexity: medium`.

**`--fix` action:** No auto-fix. Suggest re-running the most recent task with `--complexity=medium` if high is overkill, OR running `/masterplan retro` to generate the retro reference.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  complexity="$(grep -E '^complexity:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$complexity" = "high" ] || continue
  dir="$(dirname "$state")"
  events="$dir/events.jsonl"
  retro_path="$(grep -E '^[[:space:]]+retro:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  has_retro=0
  { [ -n "$retro_path" ] && [ -f "$retro_path" ]; } && has_retro=1
  { [ -f "$dir/retro.md" ]; } && has_retro=1
  has_review=0
  [ -f "$events" ] && grep -qE 'Codex review:.*pass' "$events" 2>/dev/null && has_review=1
  has_tags=0
  [ -f "$events" ] && grep -qE '\[reviewed:' "$events" 2>/dev/null && has_tags=1
  if [ $has_retro -eq 0 ] && [ $has_review -eq 0 ] && [ $has_tags -eq 0 ]; then
    echo "WARN $state: complexity=high but no retro/codex-review/reviewed-tags evidence found"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #22: PASS" || echo "Check #22: WARN"
```

---

## Check #23 — Opus on bounded-mechanical dispatch sites

**Severity:** Warning

(C.1 mitigation, v2.8.0+). Scans the most recent `min(20, len(jsonl))` entries in `subagents.jsonl` for records whose **EITHER** `dispatch_site` substring-matches `Step C step 1`, `Step C step 2 wave dispatch`, or `Step C step 2 SDD` (per the §Agent dispatch contract dispatch-site mapping table) **OR** `routing_class == "sdd"` (the hook's classification when `subagent_type` contains `subagent-driven-development`) **AND** whose `model` field is `opus`. Excludes records whose `prompt_first_line` matches `re-dispatched with model=opus per blocker gate` (intentional escalation per the wave-member retry path). Indicates the model-passthrough override clause leaked or was missing in the orchestrator's SDD/wave brief — cost regression today; potentially a correctness issue if it indicates upstream skill-prompt drift.

**`--fix` action:** Surface `AskUserQuestion` per finding: "Detected `<N>` SDD/wave/eligibility dispatch(es) with `model: opus` (cost contract calls for sonnet). How to proceed? — `Run \`bin/masterplan-self-host-audit.sh --models\` to lint orchestrator dispatch sites (Recommended)` / `Investigate transcript: print suspected session prompts from JSONL` / `Suppress for this plan (sets model_attribution_suppressed: true in state.yml)` / `Skip this finding only`". The first option chains into running the audit script and surfacing its output. See §Agent dispatch contract recursive-application for the verbatim preamble that should be present in SDD invocations.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  dir="$(dirname "$state")"
  subs="$dir/subagents.jsonl"
  [ -f "$subs" ] || continue
  total="$(wc -l < "$subs")"
  start=1; [ "$total" -gt 20 ] && start=$(( total - 19 ))
  while IFS= read -r rec; do
    dispatch="$(printf '%s' "$rec" | jq -r '.dispatch_site // empty' 2>/dev/null)"
    routing_class="$(printf '%s' "$rec" | jq -r '.routing_class // empty' 2>/dev/null)"
    model="$(printf '%s' "$rec" | jq -r '.model // empty' 2>/dev/null)"
    prompt_first="$(printf '%s' "$rec" | jq -r '.prompt_first_line // empty' 2>/dev/null)"
    [ "$model" = "opus" ] || continue
    printf '%s\n' "$prompt_first" | grep -q 're-dispatched with model=opus per blocker gate' && continue
    sdd_site=0
    case "$dispatch" in *"Step C step 1"*|*"Step C step 2 wave"*|*"Step C step 2 SDD"*) sdd_site=1 ;; esac
    [ "$routing_class" = "sdd" ] && sdd_site=1
    [ $sdd_site -eq 1 ] && {
      echo "WARN $(basename "$dir"): SDD/wave dispatch with model=opus (should be sonnet): $dispatch"
      fail=1
    }
  done < <(sed -n "${start},${total}p" "$subs" 2>/dev/null)
done
[ $fail -eq 0 ] && echo "Check #23: PASS" || echo "Check #23: WARN"
```

---

## Check #24 — State-write queue file present and non-empty

**Severity:** Warning

(F.4 mitigation, v2.8.0+). `state.queue.jsonl` exists with non-zero size, AND `state.yml` shows no `last_activity` update within the last `config.loop_interval_seconds`.

**`--fix` action:** `--fix`: replay each queued entry into `events.jsonl` / `state.yml` idempotently, then truncate the queue file. No-`--fix`: report queued-entry count + suggest `/masterplan --resume=<state-path>` to trigger drain naturally.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  queue="$(dirname "$state")/state.queue.jsonl"
  [ -s "$queue" ] || continue
  count="$(wc -l < "$queue")"
  echo "WARN $state: $count queued state write(s) in $(basename "$queue") — resume with /masterplan execute to drain"
  fail=1
done
[ $fail -eq 0 ] && echo "Check #24: PASS" || echo "Check #24: WARN"
```

---

## Check #25 — Reserved

_This check ID was retired in an earlier version. Reserved to prevent renumbering of subsequent checks._

---

## Check #26 — `auto_compact_loop_attached`

**Severity:** Warning

(repo-scoped). Skipped silently when `config.auto_compact.enabled == false`, or when no `docs/masterplan/*/state.yml` has `compact_loop_recommended: true`. Otherwise calls `CronList()` and filters entries whose `prompt` contains `/compact`.

**`--fix` action:** No `--fix` available; report the copy-pasteable `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` command and the run slugs whose `state.yml` has `compact_loop_recommended: true`.

```bash
compact_needed=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  val="$(grep -E '^compact_loop_recommended:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$val" = "true" ] && compact_needed=1 && break
done
if [ $compact_needed -eq 0 ]; then
  echo "Check #26: PASS (no bundles have compact_loop_recommended:true)"
else
  echo "Check #26: SKIP (CronList API access required to verify loop attachment — run /masterplan doctor for full check)"
fi
```

---

## Check #27 — Reserved

_This check ID was retired in an earlier version. Reserved to prevent renumbering of subsequent checks._

---

## Check #28 — `completed_plan_without_retro`

**Severity:** Warning

(plan-scoped). Detects completed run bundles with no `retro.md`, or legacy completed plans without a migrated bundle/retro.

**`--fix` action:** Surface `AskUserQuestion` per finding: generate retro + archive run bundle (Recommended), generate retro only, skip this plan, or skip all findings this run.

```bash
fail=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  status="$(grep -E '^status:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$status" = "complete" ] || continue
  dir="$(dirname "$state")"
  retro_path="$(grep -E '^[[:space:]]+retro:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  if { [ -z "$retro_path" ] || [ ! -f "$retro_path" ]; } && [ ! -f "$dir/retro.md" ]; then
    echo "WARN $state: status=complete but no retro artifact (neither artifacts.retro nor retro.md found)"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #28: PASS" || echo "Check #28: WARN"
```

---

## Check #29 — Worktree-bundle reconciliation mismatch

**Severity:** Warning

(v4.0.0+). Cross-repo: enumerate `git worktree list --porcelain` for the current repo; for each worktree path, find any bundle's `state.yml.worktree:` pointing at it. Surface: (a) bundles claiming a worktree path not registered in `git worktree list` (`worktree_missing`); (b) worktree paths registered in git with no bundle pointer (`worktree_orphan_untracked`). Skip worktrees with `worktree_disposition: removed_after_merge` or `kept_by_user` — those are intentionally settled.

**`--fix` action:** `--fix`: for (a), set `worktree_disposition: missing`, clear `worktree:` field, write state, commit. For (b): report only (user must decide).

```bash
fail=0
declare -a git_wts=()
while IFS= read -r wt; do
  git_wts+=("$wt")
done < <(git worktree list --porcelain 2>/dev/null | grep '^worktree ' | awk '{print $2}')
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  disposition="$(grep -E '^worktree_disposition:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  case "$disposition" in removed_after_merge|kept_by_user) continue ;; esac
  claimed="$(grep -E '^worktree:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ -z "$claimed" ] && continue
  found=0
  for wt in "${git_wts[@]}"; do [ "$claimed" = "$wt" ] && found=1 && break; done
  [ $found -eq 0 ] && { echo "WARN $state: worktree_missing — '$claimed' not in git worktree list"; fail=1; }
done
[ $fail -eq 0 ] && echo "Check #29: PASS" || echo "Check #29: WARN"
```

---

## Check #30 — Cross-manifest version drift

**Severity:** Warning

(repo-scoped, v4.2.1+). Reads `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root `version` AND nested `plugins[0].version`), `.codex-plugin/plugin.json`; `.agents/plugins/marketplace.json` is exempt. Also greps `README.md` for `Current release:.*v[0-9]+\.[0-9]+\.[0-9]+`. Any mismatch → `version drift: <file>[:<json-path>] at <observed> (canonical: <canonical>)`. Absent `Current release:` line → no warning. Implementation: inline (does NOT dispatch per-worktree).

**`--fix` action:** Report only. Auto-bumping is risky — canonical-source authority is ambiguous when multiple manifests have drifted. Suggest editing alongside the CHANGELOG entry for the next release. See `RELEASING.md` for the full release checklist.

```bash
fail=0
canonical=""
[ -f ".claude-plugin/plugin.json" ] && \
  canonical="$(jq -r '.version // empty' ".claude-plugin/plugin.json" 2>/dev/null)"
if [ -z "$canonical" ]; then
  echo "Check #30: SKIP (.claude-plugin/plugin.json not found)"
else
  for f in ".codex-plugin/plugin.json" ".claude-plugin/marketplace.json"; do
    [ -f "$f" ] || continue
    v="$(jq -r '.version // empty' "$f" 2>/dev/null)"
    [ -n "$v" ] && [ "$v" != "$canonical" ] && \
      { echo "WARN $f: version drift: $v (canonical: $canonical)"; fail=1; }
    if [ "$f" = ".claude-plugin/marketplace.json" ]; then
      nv="$(jq -r '.plugins[0].version // empty' "$f" 2>/dev/null)"
      [ -n "$nv" ] && [ "$nv" != "$canonical" ] && \
        { echo "WARN $f[plugins[0].version]: version drift: $nv (canonical: $canonical)"; fail=1; }
    fi
  done
  if [ -f "README.md" ]; then
    rv="$(grep -oP 'Current release:.*v\K[0-9]+\.[0-9]+\.[0-9]+' README.md | head -1)"
    [ -n "$rv" ] && [ "$rv" != "$canonical" ] && \
      { echo "WARN README.md: Current release version drift: $rv (canonical: $canonical)"; fail=1; }
  fi
  [ $fail -eq 0 ] && echo "Check #30: PASS" || echo "Check #30: WARN"
fi
```

---

## Check #31 — Per-autonomy gate-condition consistency

**Severity:** Warning

(repo-scoped, v4.2.1+). Static anchor table for gate-decision sites in `parts/step-b.md`: `spec_approval` expects `--autonomy != full`; `plan_approval` expects `--autonomy == gated`. For each entry: grep `parts/step-b.md` for anchor, read next 3 lines, regex-match condition. Anchor missing → flag missing site; condition mismatch → flag drift. Extend table when adding new gate sites. Implementation: inline.

**`--fix` action:** Report only. Auto-rewriting gate conditions in the orchestrator prompt is never safe — these are deliberate semantic choices made per-release.

```bash
fail=0
step_b="parts/step-b.md"
if [ ! -f "$step_b" ]; then
  echo "Check #31: SKIP (parts/step-b.md not found)"
else
  if grep -q 'spec_approval' "$step_b"; then
    # grep across the full file for the gate-decision line; head -8 clips early when many occurrences exist
    grep -qiE 'spec_approval.*autonomy.*(!=|not.*full)|autonomy.*!=.*full.*spec_approval|halt_mode == none.*autonomy.*!=.*full' "$step_b" \
      || { echo "WARN $step_b: spec_approval gate missing autonomy!=full condition"; fail=1; }
  else
    echo "WARN $step_b: spec_approval anchor not found"; fail=1
  fi
  if grep -q 'plan_approval' "$step_b"; then
    grep -qiE 'plan_approval.*autonomy.*(==|gated)|autonomy.*(==.*gated|gated).*plan_approval|halt_mode == none.*autonomy == gated' "$step_b" \
      || { echo "WARN $step_b: plan_approval gate missing autonomy==gated condition"; fail=1; }
  else
    echo "WARN $step_b: plan_approval anchor not found"; fail=1
  fi
  [ $fail -eq 0 ] && echo "Check #31: PASS" || echo "Check #31: WARN"
fi
```

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

---

## Check #34: plan.index.json staleness

**Severity:** Warning
**Action:** Report-only

```bash
fail=0
for d in docs/masterplan/*/; do
  plan="${d}plan.md"
  state="${d}state.yml"
  idx="${d}plan.index.json"
  [ -f "$plan" ] || continue
  current="$(sha256sum "$plan" | awk '{print $1}')"
  if [ -f "$state" ]; then
    state_hash="$(grep -E '^plan_hash:' "$state" | sed 's/.*"sha256:\([a-f0-9]*\)".*/\1/')"
    [ -n "$state_hash" ] && [ "$state_hash" != "$current" ] && \
      { echo "WARN $state: plan_hash drift (state=$state_hash, current=$current)"; fail=1; }
  fi
  if [ -f "$idx" ]; then
    idx_hash="$(jq -r '.plan_hash' "$idx" 2>/dev/null | sed 's/sha256://')"
    [ -n "$idx_hash" ] && [ "$idx_hash" != "$current" ] && \
      { echo "WARN $idx: plan.index.json stale (index=$idx_hash, current=$current)"; fail=1; }
  fi
done
[ $fail -eq 0 ] && echo "Check #34: PASS" || echo "Check #34: WARN"
```

---

## Check #35: Plan-format conformance (v5.0 markers)

**Severity:** Warning
**Action:** Report-only

For each `docs/masterplan/*/plan.md`, every task heading (e.g., `### Task N:`)
MUST be followed (within 30 lines, before the next task heading) by both
`**Spec:**` and `**Verify:**` markers.

```bash
fail=0
for plan in docs/masterplan/*/plan.md; do
  bundle="$(dirname "$plan")"
  # extract task heading line numbers
  mapfile -t tasks < <(grep -n -E '^### Task [0-9]+' "$plan" | cut -d: -f1)
  for i in "${!tasks[@]}"; do
    start="${tasks[$i]}"
    end="${tasks[$((i+1))]:-$(wc -l < "$plan")}"
    block="$(sed -n "${start},${end}p" "$plan")"
    echo "$block" | grep -q -F '**Spec:**' || \
      { echo "WARN $plan task at L$start: missing **Spec:**"; fail=1; }
    echo "$block" | grep -q -F '**Verify:**' || \
      { echo "WARN $plan task at L$start: missing **Verify:**"; fail=1; }
  done
done
[ $fail -eq 0 ] && echo "Check #35: PASS" || echo "Check #35: WARN"
```

---

## Check #36: parts/step-*.md sanity + router ceiling

**Severity:** Warning
**Action:** Report-only

```bash
fail=0
size="$(wc -c < commands/masterplan.md)"
if [ "$size" -gt 20480 ]; then
  echo "WARN commands/masterplan.md is $size bytes (ceiling 20480)"
  fail=1
fi
for phase in 0 a b; do
  if [ ! -f "parts/step-$phase.md" ]; then
    echo "WARN parts/step-$phase.md missing"; fail=1
  fi
done
for sub in resume dispatch verification completion; do
  if [ ! -f "parts/step-c-$sub.md" ]; then
    echo "WARN parts/step-c-$sub.md missing"; fail=1
  fi
done
grep -q 'CC-3-trampoline' commands/masterplan.md || \
  { echo "WARN CC-3-trampoline missing from router"; fail=1; }
grep -q 'CC-3-trampoline' parts/step-0.md || \
  { echo "WARN CC-3-trampoline missing from step-0"; fail=1; }
grep -q 'DISPATCH-SITE: step-c-resume.md' parts/step-c-resume.md 2>/dev/null || \
  { echo "WARN DISPATCH-SITE labels missing from step-c-resume.md"; fail=1; }
[ $fail -eq 0 ] && echo "Check #36: PASS" || echo "Check #36: WARN"
```

---

## Check #37 — Reserved

_This check ID was retired in an earlier version. Reserved to prevent renumbering of subsequent checks._

```bash
echo "Check #37: SKIP (reserved — retired check ID)"
```

---

## Check #38: Anomaly file has records since last archive

**Severity:** Warning
**Action:** Report records + suggest flush; Report-only otherwise
**Scope:** Plan-scoped (per-bundle; scans `anomalies.jsonl` and `anomalies-pending-upload.jsonl` for each run bundle).

Scans each run bundle for `anomalies.jsonl` and `anomalies-pending-upload.jsonl`. Non-empty `anomalies.jsonl` → Stop hook recorded ≥1 unreviewed anomaly. Non-empty `anomalies-pending-upload.jsonl` → GitHub auto-filing queued for retry. Detector framework: `parts/failure-classes.md`.

```bash
fail=0
for state_yml in docs/masterplan/*/state.yml; do
  run_dir="$(dirname "$state_yml")"
  slug="$(basename "$run_dir")"
  anom="$run_dir/anomalies.jsonl"
  pending="$run_dir/anomalies-pending-upload.jsonl"
  if [ -s "$anom" ]; then
    count="$(wc -l < "$anom")"
    classes="$(jq -r '.anomaly_class' "$anom" 2>/dev/null | sort -u | tr '\n' ',' | sed 's/,$//')"
    echo "WARN $slug: $count anomaly record(s) in $anom (classes: $classes)"
    fail=1
  fi
  if [ -s "$pending" ]; then
    pcount="$(wc -l < "$pending")"
    echo "WARN $slug: $pcount record(s) queued in $pending — run bin/masterplan-anomaly-flush.sh"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #38: PASS" || echo "Check #38: WARN"
```

Report-only. Use `bin/masterplan-failure-analyze.sh` to review anomaly records.

---

## Check #39: Codex auth expired or stale

**Severity:** Warning
**Action:** Report-only; suggest `codex login` to refresh.
**Scope:** Repo-scoped (fires once per doctor run; reads user-global `~/.codex/auth.json`).
**Added:** v5.1.1 (I-1 of cosmic-cuddling-dusk).

Skipped when `~/.codex/auth.json` absent. v5.2.3+ cosmetic-shape gate: `auth_mode == "chatgpt"` AND `tokens.refresh_token` present → skip ALL sub-conditions and emit PASS immediately. ChatGPT uses short-lived JWTs that auto-refresh on every Codex invocation via `refresh_token`; neither `id_token.exp` past now nor `last_refresh` age is a meaningful health signal for this auth mode. Non-chatgpt modes run all sub-conditions.

```bash
fail=0
auth="$HOME/.codex/auth.json"
if [ ! -r "$auth" ]; then
  echo "Check #39: SKIP (~/.codex/auth.json absent — codex not installed for this user)"
else
  now="$(date +%s)"
  auth_mode="$(jq -r '.auth_mode // empty' "$auth" 2>/dev/null)"
  refresh_token="$(jq -r '.tokens.refresh_token // .refresh_token // empty' "$auth" 2>/dev/null)"
  last_refresh="$(jq -r '.last_refresh // empty' "$auth" 2>/dev/null)"
  if [ "$auth_mode" = "chatgpt" ] && [ -n "$refresh_token" ]; then
    # chatgpt mode: refresh_token auto-refreshes id_token on every Codex invocation.
    # No age check needed — idle time is irrelevant to auth health.
    echo "Check #39: PASS (auth_mode=chatgpt; refresh_token present; auto-refreshes on next invocation)"
  else
    for field in id_token access_token; do
      # v5.2.3+: read from nested .tokens.<field> with top-level fallback for schema-compat.
      token="$(jq -r ".tokens.$field // .$field // empty" "$auth" 2>/dev/null)"
      if [ -z "$token" ]; then
        continue
      fi
      payload="$(echo "$token" | cut -d. -f2)"
      pad=$(( 4 - ${#payload} % 4 ))
      [ $pad -eq 4 ] && pad=0
      padded="${payload}$(printf '=%.0s' $(seq 1 $pad))"
      exp="$(echo "$padded" | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r .exp 2>/dev/null)"
      if [ -z "$exp" ] || [ "$exp" = "null" ]; then
        echo "WARN $field: cannot decode exp claim (token malformed?)"
        fail=1
        continue
      fi
      age_sec=$(( now - exp ))
      age_days=$(( age_sec / 86400 ))
      iso_exp="$(date -u -d "@$exp" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$exp" +%Y-%m-%dT%H:%M:%SZ)"
      if [ $age_sec -gt 0 ]; then
        echo "WARN $field expired $iso_exp ($age_days days ago)"
        fail=1
      elif [ $age_sec -gt -86400 ]; then
        echo "WARN $field expires $iso_exp (within 24h)"
        fail=1
      fi
    done
    if [ -n "$last_refresh" ]; then
      refresh_sec="$(date -u -d "$last_refresh" +%s 2>/dev/null || echo 0)"
      if [ "$refresh_sec" -gt 0 ]; then
        refresh_age_days=$(( (now - refresh_sec) / 86400 ))
        if [ $refresh_age_days -gt 30 ]; then
          echo "WARN last_refresh $last_refresh ($refresh_age_days days ago — token rotation may be broken)"
          fail=1
        fi
      fi
    fi
    if [ $fail -eq 0 ]; then
      echo "Check #39: PASS"
    else
      echo "Check #39: WARN — run \`codex login\` to refresh credentials"
    fi
  fi
fi
```

Report-only (auth refresh requires `codex login`). Pairs with #18 (misconfig) and #41 (degradation evidence).

---

## Check #40: High-complexity plan missing Codex / parallel-group annotations

**Severity:** Warning (Codex annotation gap); Info (parallel-group gap)
**Action:** Report-only; suggest re-running `/masterplan plan --from-spec=<spec>` to regenerate.
**Scope:** Plan-scoped (per-plan; runs in worktree-Haiku dispatchers when worktrees ≥ 2).
**Added:** v5.1.1 (I-2 of cosmic-cuddling-dusk).

Skipped silently on `complexity: low` and `complexity: medium`.

```bash
fail=0
for state_yml in docs/masterplan/*/state.yml; do
  run_dir="$(dirname "$state_yml")"
  slug="$(basename "$run_dir")"
  plan="$run_dir/plan.md"
  complexity="$(grep -E '^complexity:' "$state_yml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$complexity" = "high" ] || continue
  [ -r "$plan" ] || continue
  task_count="$(grep -cE '^### Task ' "$plan")"
  codex_count="$(grep -cE '^\*\*Codex:\*\* (ok|no|true|false)' "$plan")"
  pgroup_count="$(grep -cE '^\*\*parallel-group:\*\*' "$plan")"
  if [ "$task_count" -gt 0 ] && [ "$codex_count" -lt "$task_count" ]; then
    gap=$(( task_count - codex_count ))
    echo "WARN $slug: complexity=high, $task_count tasks, $codex_count **Codex:** annotations (expected $task_count, gap $gap)"
    fail=1
  fi
  if [ "$task_count" -gt 0 ] && [ "$pgroup_count" -eq 0 ]; then
    echo "INFO $slug: complexity=high, $task_count tasks, 0 **parallel-group:** annotations (wave dispatch unavailable; planner brief encourages clustering verification/lint tasks)"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #40: PASS" || echo "Check #40: WARN"
```

Report-only.

---

## Check #41: Missing Codex degradation evidence

**Severity:** Warning (silent-override sub-fire); Info (annotation-gap sub-fire); Error (Step 0 confabulation sub-fire, v5.3.0+)
**Action:** Report-only; cross-reference with #18, #39, #40 for diagnosis.
**Scope:** Plan-scoped (per-plan; runs in worktree-Haiku dispatchers when worktrees ≥ 2).
**Added:** v5.1.1 (I-3 of cosmic-cuddling-dusk); expanded v5.3.0 with sub-fire (c).

Sub-fires: **(a)** routing+review forced `off`, no `codex degraded` event, auth healthy → silent-override-without-evidence. Skipped when zero Codex-related events exist (intentionally-off bundle). **(b)** `codex_routing` not `off`, zero `routing→[codex]` events, `codex_ping ok` exists → Codex never dispatched despite availability; cross-check #40. **(c) v5.3.0+** `degradation_self_doubt` event in events.jsonl, OR `codex degraded — plugin not detected` event with healthy auth + codex files on disk → Step 0 confabulation; set `detection_mode: scan-then-ping` in `.masterplan.yaml` and re-run.

```bash
fail=0
error=0
auth="$HOME/.codex/auth.json"
auth_healthy=0
if [ -r "$auth" ]; then
  now="$(date +%s)"
  auth_mode_41="$(jq -r '.auth_mode // empty' "$auth" 2>/dev/null)"
  refresh_token_41="$(jq -r '.tokens.refresh_token // .refresh_token // empty' "$auth" 2>/dev/null)"
  last_refresh_41="$(jq -r '.last_refresh // empty' "$auth" 2>/dev/null)"
  if [ "$auth_mode_41" = "chatgpt" ] && [ -n "$refresh_token_41" ] && [ -n "$last_refresh_41" ]; then
    refresh_sec_41="$(date -u -d "$last_refresh_41" +%s 2>/dev/null || echo 0)"
    if [ "$refresh_sec_41" -gt 0 ] && [ $(( (now - refresh_sec_41) / 86400 )) -le 7 ]; then
      auth_healthy=1
    fi
  fi
  if [ "$auth_healthy" -ne 1 ]; then
    for field in id_token access_token; do
      token="$(jq -r ".tokens.$field // .$field // empty" "$auth" 2>/dev/null)"
      [ -z "$token" ] && continue
      payload="$(echo "$token" | cut -d. -f2)"
      pad=$(( 4 - ${#payload} % 4 )); [ $pad -eq 4 ] && pad=0
      padded="${payload}$(printf '=%.0s' $(seq 1 $pad))"
      exp="$(echo "$padded" | tr '_-' '/+' | base64 -d 2>/dev/null | jq -r .exp 2>/dev/null)"
      if [ -n "$exp" ] && [ "$exp" != "null" ] && [ "$exp" -gt "$now" ]; then
        auth_healthy=1
      else
        auth_healthy=0
        break
      fi
    done
  fi
fi
# v5.3.0+ sub-fire (c) precondition: codex plugin files present on disk.
plugin_on_disk=0
if ls $HOME/.claude/plugins/*/codex* 2>/dev/null | head -1 | grep -q .; then
  plugin_on_disk=1
fi
for state_yml in docs/masterplan/*/state.yml; do
  run_dir="$(dirname "$state_yml")"
  slug="$(basename "$run_dir")"
  events="$run_dir/events.jsonl"
  [ -r "$events" ] || continue
  routing="$(grep -E '^codex_routing:' "$state_yml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  review="$(grep -E '^codex_review:' "$state_yml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  has_last_warning="$(grep -cE '^last_warning:' "$state_yml" 2>/dev/null)"
  codex_ever_active="$(grep -cE 'codex_ping|codex degraded|routing→.*\[codex\]' "$events" 2>/dev/null)"
  if [ "$routing" = "off" ] && [ "$review" = "off" ] && [ $auth_healthy -eq 1 ] && [ "$has_last_warning" -eq 0 ] && [ "${codex_ever_active:-0}" -gt 0 ]; then
    degraded_event="$(grep -cE 'codex degraded' "$events" 2>/dev/null)"
    if [ "${degraded_event:-0}" -eq 0 ]; then
      echo "WARN $slug: codex routing+review forced off; auth healthy; no \`codex degraded\` event in events.jsonl; no last_warning set — silent override without evidence (degrade-loudly visibility violation)"
      fail=1
    fi
  fi
  if [ "$routing" = "auto" ] || [ "$routing" = "manual" ]; then
    codex_routing_events="$(grep -cE 'routing→.*\[codex\]' "$events" 2>/dev/null)"
    ping_ok_events="$(grep -cE 'codex_ping ok' "$events" 2>/dev/null)"
    if [ "${codex_routing_events:-0}" -eq 0 ] && [ "${ping_ok_events:-0}" -gt 0 ]; then
      echo "INFO $slug: codex_routing=$routing; ping returned ok ($ping_ok_events times); zero routing→[codex] events — every task judged ineligible. Cross-check #40 for annotation gap."
      fail=1
    fi
  fi
  self_doubt_events="$(grep -cE 'degradation_self_doubt' "$events" 2>/dev/null)"
  plugin_not_detected_events="$(grep -cE 'codex degraded — plugin not detected' "$events" 2>/dev/null)"
  if [ "${self_doubt_events:-0}" -gt 0 ]; then
    echo "ERROR $slug: events.jsonl contains $self_doubt_events \`degradation_self_doubt\` event(s) — Step 0 self-flagged a likely false-positive at warning-time. Set \`detection_mode: scan-then-ping\` in .masterplan.yaml (or remove explicit \`ping\` override) and re-run."
    error=1
  elif [ "${plugin_not_detected_events:-0}" -gt 0 ] && [ $auth_healthy -eq 1 ] && [ $plugin_on_disk -eq 1 ]; then
    echo "ERROR $slug: events.jsonl contains \`codex degraded — plugin not detected\` event(s), but auth is healthy AND codex plugin files exist under ~/.claude/plugins/. Step 0 confabulation suspected (legacy \`detection_mode: ping\` failure mode). Set \`detection_mode: scan-then-ping\` and re-run."
    error=1
  fi
done
if [ $error -ne 0 ]; then
  echo "Check #41: ERROR"
elif [ $fail -ne 0 ]; then
  echo "Check #41: WARN"
else
  echo "Check #41: PASS"
fi
```

Report-only. Sub-fire (b) usually co-fires with #40 on the same plan.

---

## Check #42 — Stale `.lock` file in bundle

**Severity:** Warning
**--fix:** Report only (no auto-remediation)

Stat `<bundle>/.lock`; emit WARN when mtime > 1 hour. False-positive risk exists (long-running write). Fix: confirm no live writer, then `rm <bundle>/.lock`.

```bash
fail=0
now="$(date +%s)"
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  lock="$(dirname "$state")/.lock"
  [ -f "$lock" ] || continue
  mtime="$(stat -c %Y "$lock" 2>/dev/null || echo 0)"
  age=$(( now - mtime ))
  if [ "$age" -gt 3600 ]; then
    echo "WARN $lock: lockfile age ${age}s exceeds 1h threshold (possible wedged writer)"
    fail=1
  fi
done
[ $fail -eq 0 ] && echo "Check #42: PASS" || echo "Check #42: WARN"
```

---

## Check #43 — codex_review_coverage

**Severity:** Warning (coverage < 100% and run was not inside Codex host) / Skip (Codex-hosted run)
**--fix:** Report only (no auto-remediation)

**Goal:** For each run bundle's `events.jsonl`, every `wave_task_completed` event must have a paired `review→CODEX(...)` or `review→SKIP(<reason>)` event with explicit `decision_source`. Coverage = paired_reviews / wave_task_completed events.

**Detector:** Iterate `docs/masterplan/*/events.jsonl`. For each `wave_task_completed` event, search forward in the file for a matching `review→` event referencing the same task. Skip the check entirely when the run executed inside a Codex host — detect this by checking for `codex_host: true` in `state.yml` or any `codex_host_suppressed: false` evidence in events.

**Severity:**
- PASS: coverage = 100%
- WARN: coverage < 100% AND run was not inside Codex host
- SKIP: Codex-hosted run (include reason in output)

**Action:** Report bundle slug, coverage percentage, and list of `wave_task_completed` events lacking a paired `review→` event.

**Expected backfill warnings:** Running this check against existing bundles `concurrency-guards` and `p4-suppression-smoke` should WARN — both predate the wave-mode review-visibility rule. This is expected and does not indicate a regression.

```bash
fail=0; skip=0
for state in docs/masterplan/*/state.yml; do
  [ -f "$state" ] || continue
  codex_host="$(grep -E '^codex_host:' "$state" | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$codex_host" = "true" ] && { skip=$((skip+1)); continue; }
  dir="$(dirname "$state")"
  slug="$(basename "$dir")"
  events="$dir/events.jsonl"
  [ -f "$events" ] || continue
  completed="$(grep -c '"wave_task_completed"' "$events" 2>/dev/null || echo 0)"
  [ "${completed:-0}" -eq 0 ] && continue
  reviewed="$(grep -c 'review→' "$events" 2>/dev/null || echo 0)"
  if [ "${reviewed:-0}" -lt "${completed:-0}" ]; then
    gap=$(( completed - reviewed ))
    pct=$(( reviewed * 100 / completed ))
    echo "WARN $slug: wave_task_completed=$completed, review→ events=$reviewed (${pct}% coverage, $gap uncovered)"
    fail=1
  fi
done
[ $skip -gt 0 ] && echo "INFO: $skip Codex-hosted run(s) skipped (codex_host:true)"
[ $fail -eq 0 ] && echo "Check #43: PASS" || echo "Check #43: WARN"
```

---

## Check #44 — `adversarial_review` config valid

**Severity:** Warning
**Action:** Report-only; no auto-fix. Invalid values must be corrected by the user.
**Scope:** Global (config tiers only — not per-plan).
**Added:** v6.1.0 (adversarial-review-integration).

If the `adversarial_review` key is present in any config tier (`~/.masterplan.yaml` or `.masterplan.yaml`), its value must be one of `off`, `spec`, `plan`, or `both`. Any other value is flagged.

```bash
fail=0
for cfg in "$HOME/.masterplan.yaml" ".masterplan.yaml"; do
  [ -r "$cfg" ] || continue
  val="$(grep -E '^adversarial_review:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' | tr -d "'")"
  [ -z "$val" ] && continue
  case "$val" in
    off|spec|plan|both) ;;
    *)
      echo "WARN $cfg: adversarial_review: \"$val\" — must be off|spec|plan|both"
      fail=1
      ;;
  esac
done
[ $fail -eq 0 ] && echo "Check #44: PASS" || echo "Check #44: WARN"
```

Report-only.

---

## Check #45 — Adversarial review gate-fire audit

**Severity:** Info (skipped for bundles with fewer than 2 events or status != complete)
**Action:** Report-only; informational only. Historical bundles predating v6.1.0 will always show INFO.
**Scope:** Plan-scoped (per-plan; applies to completed bundles only).
**Added:** v6.1.0 (adversarial-review-integration).

For each completed bundle where `config.adversarial_review != off` (resolved from merged config tiers at check time), verify that `events.jsonl` contains at least one `adversarial_review_complete` event with `gate: spec_approval` and one with `gate: plan_approval`. If missing, emit INFO. Bundles predating v6.1.0 will always fire INFO — this is expected and not a regression.

```bash
for state_yml in docs/masterplan/*/state.yml; do
  run_dir="$(dirname "$state_yml")"
  slug="$(basename "$run_dir")"
  events="$run_dir/events.jsonl"
  status="$(grep -E '^status:' "$state_yml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  [ "$status" = "complete" ] || continue
  [ -r "$events" ] || continue
  event_count="$(wc -l < "$events" 2>/dev/null)"
  [ "${event_count:-0}" -lt 2 ] && continue

  ar_val="both"
  for cfg in "$HOME/.masterplan.yaml" ".masterplan.yaml"; do
    [ -r "$cfg" ] || continue
    v="$(grep -E '^adversarial_review:' "$cfg" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"' | tr -d "'")"
    [ -n "$v" ] && ar_val="$v"
  done
  [ "$ar_val" = "off" ] && continue

  spec_gate_fire="$(grep -c '"adversarial_review_complete"' "$events" 2>/dev/null | tr -d ' ')"
  has_spec="$(grep '"adversarial_review_complete"' "$events" 2>/dev/null | grep -c '"spec_approval"' || echo 0)"
  has_plan="$(grep '"adversarial_review_complete"' "$events" 2>/dev/null | grep -c '"plan_approval"' || echo 0)"

  missing=""
  [ "${has_spec:-0}" -eq 0 ] && missing="${missing}spec_approval "
  [ "${has_plan:-0}" -eq 0 ] && missing="${missing}plan_approval"
  if [ -n "$missing" ]; then
    echo "INFO $slug: adversarial_review=$ar_val, status=complete — adversarial_review_complete event(s) missing for: ${missing}. Bundle predates v6.1.0 or review was skipped."
  fi
done
echo "Check #45: INFO (historical audit — see per-bundle lines above for details)"
```

Report-only. Expected to fire INFO on all bundles created before v6.1.0.

---

## Check #46 — CC-2 self-enforcement

**Severity:** Warning
**Action:** Report-only.
**Scope:** Prompt-scoped (scans `parts/step-*.md`). Fires regardless of plan complexity.
**Added:** v6.2.0 (improve-subagents-parallelism).

Scan `parts/step-*.md` (and `parts/doctor.md`) for 3+ consecutive Bash-type directives feeding
one decision without an upstream `dispatch Haiku` or `DISPATCH-SITE:` gate. The CC-2 rule
(dispatch Haiku before reading files >300 lines or before commands expected to print >100 lines)
degrades silently as the prompt evolves; this check enforces it at lint time. Lines inside
`` ```bash `` … `` ``` `` code fences are skipped (they are implementation blocks, not inline
orchestrator directives).

```bash
violations=0
for f in parts/step-0.md parts/step-b.md parts/step-c-resume.md parts/step-c-dispatch.md \
          parts/step-c-verification.md parts/step-c-completion.md parts/doctor.md; do
  [ -r "$f" ] || continue
  consecutive=0
  gate_seen=0
  in_fence=0
  while IFS= read -r line; do
    if [ "$line" = '```bash' ]; then in_fence=1; consecutive=0; continue; fi
    if [ "$line" = '```' ] && [ "$in_fence" -eq 1 ]; then in_fence=0; consecutive=0; continue; fi
    [ "$in_fence" -eq 1 ] && continue
    case "$line" in
      *"dispatch Haiku"*|*"DISPATCH-SITE:"*) gate_seen=1; consecutive=0 ;;
      *"Read \`"*|*"node "*|*"bash -"*|*"curl "*|*"grep "*)
        consecutive=$((consecutive + 1))
        if [ "$consecutive" -ge 3 ] && [ "$gate_seen" -eq 0 ]; then
          echo "WARN $f: 3+ consecutive Bash-type directives without upstream Haiku gate (near: $line)"
          violations=$((violations + 1))
          consecutive=0
        fi
        ;;
      "") consecutive=0; gate_seen=0 ;;
    esac
  done < "$f"
done
[ "$violations" -eq 0 ] && echo "Check #46: PASS" || echo "Check #46: WARN ($violations sequence(s) found)"
```

Report-only.

---

## Check #47 — Return-shape caps

**Severity:** Warning
**Action:** Report-only.
**Scope:** Prompt-scoped (scans `parts/step-*.md`). Fires regardless of plan complexity.
**Added:** v6.2.0 (improve-subagents-parallelism).

Scan `parts/step-*.md` for `Return shape:` blocks (in `Brief:` sections and coordinator
`DISPATCH-SITE:` blocks) that lack any of `max`, `≤`, `limit`, or an item-count constraint.
Uncapped return shapes allow subagents to return unbounded content directly into the
orchestrator's context.

```bash
violations=0
for f in parts/step-0.md parts/step-b.md parts/step-c-resume.md parts/step-c-dispatch.md \
          parts/step-c-verification.md parts/step-c-completion.md parts/doctor.md; do
  [ -r "$f" ] || continue
  while IFS=: read -r lineno rest; do
    case "$rest" in *'grep '*) continue ;; esac  # skip self-referential code-block matches
    context="$(awk -v s="$lineno" -v e="$((lineno+3))" 'NR>=s && NR<=e' "$f" 2>/dev/null)"
    if ! echo "$context" | grep -qiE "≤|max|limit|[0-9]+ items?|[0-9]+ chars?"; then
      echo "WARN $f:$lineno: Return shape block lacks item/char cap"
      violations=$((violations + 1))
    fi
  done < <(grep -n "Return shape:\|return shape:" "$f" 2>/dev/null)
done
[ "$violations" -eq 0 ] && echo "Check #47: PASS" || echo "Check #47: WARN ($violations uncapped block(s))"
```

Report-only.

---

## Check #48 — Codex dispatch blocked by linked-worktree

**Severity:** Warning
**Action:** Report-only.
**Scope:** Repo-scoped. Fires once per doctor run regardless of worktree/plan count.
**Added:** v6.3.0 (masterplan-token-efficiency).

Detects when masterplan is running inside a linked git worktree, where the `.git` index
directory lives outside the workspace path. In this topology the Codex sandbox restricts
writes to the workspace, so `git add` and `git commit` fail silently — Codex appears to
complete a task but no commits appear.

The `step-c-dispatch.md` linked-worktree guard gates Codex dispatch at runtime (routing
inline with `decision_source: linked-worktree`). This check surfaces the same condition at
lint time so plans can be annotated `**Codex:** no` preemptively, preventing the eligibility
cache from dispatching tasks that will silently fail to commit.

See `docs/conventions/codex-failure-policy.md §4` for the full failure class definition.

```bash
git_dir="$(git rev-parse --git-dir 2>/dev/null)"
git_common="$(git rev-parse --git-common-dir 2>/dev/null)"
superproject="$(git rev-parse --show-superproject-working-tree 2>/dev/null)"
if [ -n "$git_dir" ] && [ -n "$git_common" ] \
   && [ "$git_dir" != "$git_common" ] && [ -z "$superproject" ]; then
  echo "WARN: running inside a linked git worktree (git_dir=$git_dir, git_common=$git_common)."
  echo "      Codex sandbox cannot commit — step-c-dispatch will route all tasks inline."
  echo "      Consider annotating Codex-eligible tasks with '**Codex:** no' in the plan."
else
  echo "Check #48: PASS"
fi
```

Report-only.

## Check #49 — Stale Codex background task

**Severity:** Warning
**Action:** Report-only; suggests `node <companion> cancel <task-id>` for each stale task when codex-companion.mjs is resolvable.
**Scope:** User-scoped (reads `~/.claude/plugins/data/*/state/*/jobs/*.json`). Fires once per doctor run.
**Added:** v6.3.1 (stale-codex-task detection — surfaced by production telemetry 2026-05-25).

Scans Codex job state files for tasks whose `status` is non-terminal (not `completed`, `done`, `cancelled`,
`failed`, or `error`) and whose `startedAt` timestamp is more than 24 hours ago. Surfaces runaway background
workers (e.g., tasks stuck in `verifying` phase) before they become multi-day orphans. Skipped when the
plugin data directory does not exist.

```bash
now="$(date +%s)"
threshold=$((now - 86400))
stale=0
data_root="$HOME/.claude/plugins/data"

if [ ! -d "$data_root" ]; then
  echo "Check #49: SKIP (no plugin data directory at $data_root)"
else
  companion=""
  for c in \
    "$HOME/.claude/plugins/cache/openai-codex/codex"/*/scripts/codex-companion.mjs \
    "$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"; do
    [ -f "$c" ] && companion="$c" && break
  done

  for job_file in "$data_root"/*/state/*/jobs/*.json; do
    [ -f "$job_file" ] || continue
    status="$(jq -r '.status // empty' "$job_file" 2>/dev/null)"
    case "$status" in completed|done|cancelled|failed|error|"") continue ;; esac

    started_raw="$(jq -r '.startedAt // empty' "$job_file" 2>/dev/null)"
    [ -z "$started_raw" ] && continue
    started_epoch="$(date -d "$started_raw" +%s 2>/dev/null)" || continue
    [ -z "$started_epoch" ] && continue

    if [ "$started_epoch" -lt "$threshold" ]; then
      task_id="$(jq -r '.id // "unknown"' "$job_file")"
      workspace="$(jq -r '.workspaceRoot // "unknown"' "$job_file")"
      summary="$(jq -r '(.summary // .title // "no summary") | .[0:80]' "$job_file")"
      age_h=$(( (now - started_epoch) / 3600 ))
      echo "WARN: stale Codex task ${task_id} (${age_h}h old, status=${status})"
      echo "      workspace: ${workspace}"
      echo "      summary:   ${summary}..."
      if [ -n "$companion" ]; then
        echo "      to cancel: node \"$companion\" cancel ${task_id}"
      fi
      stale=$((stale + 1))
    fi
  done
  [ "$stale" -eq 0 ] && echo "Check #49: PASS" || echo "Check #49: WARN ($stale stale task(s) found)"
fi
```

Report-only.

## Check #50 — Plugin registry drift

**Severity:** Warning
**Action:** Report-only; suggests updating `~/.claude/plugins/installed_plugins.json` to point at the marketplace version.
**Scope:** User-scoped (reads `~/.claude/plugins/installed_plugins.json` + marketplace `.claude-plugin/plugin.json`). Fires once per doctor run.
**Added:** v6.3.3 (registry-version vs marketplace-version divergence — silently ran v5.8.3 for three weeks while v6.x features shipped).

Compares the `superpowers-masterplan` version in `~/.claude/plugins/installed_plugins.json` (what Claude Code actually loads) against the version in `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/.claude-plugin/plugin.json` (the installed git checkout). When they differ, Claude Code silently runs an older build — newly shipped features (doctor checks, breadcrumbs, telemetry fixes, etc.) are invisible at runtime until the registry is updated and Claude Code is restarted.

```bash
registry_version="$(jq -r '.plugins["superpowers-masterplan@rasatpetabit-superpowers-masterplan"][0].version // empty' \
  "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null)"
marketplace_plugin="$HOME/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/.claude-plugin/plugin.json"

if [ -z "$registry_version" ]; then
  echo "Check #50: SKIP (superpowers-masterplan not found in installed_plugins.json)"
elif [ ! -f "$marketplace_plugin" ]; then
  echo "Check #50: SKIP (no marketplace plugin.json at $marketplace_plugin)"
else
  marketplace_version="$(jq -r '.version // empty' "$marketplace_plugin" 2>/dev/null)"
  if [ "$registry_version" = "$marketplace_version" ]; then
    echo "Check #50: PASS (registry and marketplace both at v${registry_version})"
  else
    echo "WARN: plugin registry drift — Claude Code loads v${registry_version} but marketplace is v${marketplace_version}"
    install_path="$(jq -r '.plugins["superpowers-masterplan@rasatpetabit-superpowers-masterplan"][0].installPath // empty' \
      "$HOME/.claude/plugins/installed_plugins.json" 2>/dev/null)"
    echo "      active installPath: ${install_path}"
    echo "      Fix: copy marketplace to ~/.claude/plugins/cache/.../superpowers-masterplan/${marketplace_version}/"
    echo "           update installPath + version in ~/.claude/plugins/installed_plugins.json"
    echo "           restart Claude Code to pick up the new version."
  fi
fi
```

Report-only.
