# Doctor — Self-Host Checks (#1 .. #41)

Invoked via `/masterplan doctor [--fix]`. Loaded by the router only when verb == doctor. Checks #32–#36 added in Wave C. Check #38 added in v5.1.0 (failure-instrumentation framework). Checks #39–#41 added in v5.1.1 (cosmic-cuddling-dusk Codex-routing instrumentation).

**Entry breadcrumb.** Emit on first line of this step (per Step 0 §Breadcrumb emission contract):

```
<masterplan-trace step=doctor phase=in verb=doctor halt_mode=none autonomy={autonomy}>
```

Doctor fires `<masterplan-trace gate=fire id=doctor-finding auq-options=<n>>` immediately before each `AskUserQuestion` raised by an interactive check (#28 completed-plan-without-retro, #23 opus-on-bounded, etc.). The exit breadcrumb fires when Doctor returns or closes the turn per CC-3-trampoline.

Triggered by `/masterplan doctor [--fix]`. Lints all masterplan state across all worktrees of the current repo.

### Scope

Read worktrees from `git_state.worktrees` (Step 0 cache). For each worktree, scan `<worktree>/<config.runs_path>/` plus legacy `<worktree>/<config.specs_path>/` and `<worktree>/<config.plans_path>/`.

**Parallelization.** When worktrees ≥ 2, dispatch one Haiku agent (pass `model: "haiku"` per §Agent dispatch contract) per worktree in a single Agent batch (each agent runs all plan-scoped checks (currently #1-24, #26, #28, #29, #32, #34, #35, #40, #41) for its worktree and returns findings as `[{check_id, severity, file, message}]` JSON). With 1 worktree, run inline — agent dispatch latency isn't worth it. The orchestrator merges results and applies the report ordering below. Repo-scoped checks #26 (`auto_compact_loop_attached`, v2.9.1+), #30 (`cross_manifest_version_drift`, v4.2.1+), #31 (`per_autonomy_gate_condition_consistency`, v4.2.1+), #36 (`router_ceiling_and_phase_file_sanity`, v5.0.0+), and #39 (`codex_auth_expiry`, v5.1.1+) fire ONCE per doctor run regardless of worktree/plan count and run inline at the orchestrator. #26's input is session-level state (`CronList` output); #30 reads the three repo-root manifests via the Read tool; #31 reads `parts/step-b.md` (v5.0+; gates moved from `commands/masterplan.md` during v5.0 lazy-load extraction); #36 reads `commands/masterplan.md` size + `parts/step-*.md` existence; #39 reads `~/.codex/auth.json` (user-global, not per-repo). (Self-host audits — deployment-drift detection and CD-9 free-text-question grep — moved to `bin/masterplan-self-host-audit.sh` in v2.11.0; that script is developer-only and runs against the project repo, not the user's working repo.) Plan-scoped check #28 (`completed_plan_without_retro`, v2.11.0+) is interactive: when it fires it surfaces `AskUserQuestion` to the user, so it can NOT be parallelized inside Haiku worktree dispatchers — instead each worktree's Haiku returns the candidate-list, and the orchestrator drives the prompts inline (sequentially) after the parallel detection completes. Plan-scoped check #29 (`worktree_bundle_reconciliation_mismatch`, v4.0.0+) is a lightweight repo-scoped structural check that applies to all complexity levels.

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

- `low` plans: run only checks #1 (orphan plan), #2 (orphan status), #3 (wrong worktree), #4 (wrong branch), #5 (stale in-progress), #6 (stale critical error), #8 (missing spec), #9 (schema, against the standard run-state field set), #10 (unparseable), #18 (codex misconfig), #29 (worktree-bundle reconciliation mismatch), #41 (missing degradation evidence — fires regardless of complexity when Codex was configured on). SKIP all sidecar / annotation / ledger / cache / queue / per-subagent-telemetry checks (#11–#17, #19–#21, #23, #24) — low plans do not produce those artifacts. Also skip #22 and #40 (both high-only — see below).
- `medium` plans: run all plan-scoped checks (currently #1-24, #26, #28, #29, #32, #34, #35, #41) except #22 and #40 (both high-only).
- `high` plans: run all plan-scoped checks (currently #1-24, #26, #28, #29, #32, #34, #35, #40, #41) INCLUDING #22 (high-complexity rigor evidence) and #40 (missing Codex/parallel-group annotations at complexity:high).
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
| 30 | **Cross-manifest version drift** (repo-scoped, v4.2.1+). Reads the three version-bearing manifests — `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root `version` AND nested `plugins[0].version`), `.codex-plugin/plugin.json` — and compares each `version` field against the canonical. `.agents/plugins/marketplace.json` is exempt (no `version` field by schema). Also reads `README.md` and greps for a line matching `Current release:.*v[0-9]+\.[0-9]+\.[0-9]+`; if found, compares the extracted version against canonical. Catches the v3.4.0–v4.1.1 drift pattern where `.claude-plugin/marketplace.json` was stuck at 3.3.0 across four releases, and the v3.2.7–v5.0.1 README drift. **Implementation:** runs inline at the orchestrator (does NOT dispatch per-worktree). Use the Read tool to load each manifest, extract `version` (and the nested `plugins[0].version` for `.claude-plugin/marketplace.json`), compare against `.claude-plugin/plugin.json` as canonical. Any mismatch → emit one Warning per drifted file/field: `version drift: <file>[:<json-path>] at <observed> (canonical: <canonical>)`. For README: if the `Current release:` line is absent, no warning (version was intentionally removed). | Warning | Report only. Auto-bumping is risky — canonical-source authority is ambiguous when multiple manifests have drifted. Suggest editing alongside the CHANGELOG entry for the next release. |
| 31 | **Per-autonomy gate-condition consistency** (repo-scoped, v4.2.1+). Maintains a static anchor table mapping gate-decision sites in `parts/step-b.md` (v5.0+; gates moved from `commands/masterplan.md` during v5.0 lazy-load extraction) to their expected `--autonomy [!=]= <value>` conditions. Initial table: `{anchor: "id: spec_approval", expected_regex: "--autonomy != full", note: "spec gate intentionally fires under loose"}`, `{anchor: "id: plan_approval", expected_regex: "--autonomy == gated", note: "plan gate auto-approves under loose per v4.2.0"}`. **Implementation:** runs inline at the orchestrator. For each table entry: grep `parts/step-b.md` for the anchor string, read the next 3 lines, regex-match the expected condition. Anchor not found → flag missing gate site. Anchor found but condition mismatches → flag drift with observed text. Maintainers adding a new gate site to the orchestrator MUST extend this static table; an existing entry that no longer matches → loud Warning. | Warning | Report only. Auto-rewriting gate conditions in the orchestrator prompt is never safe — these are deliberate semantic choices made per-release. |
| 32 | **state.yml scalar cap + overflow pointer** — every scalar value in `state.yml` ≤200 chars; overflow pointers resolve to existing files with valid line numbers. | Warning | Report-only |
| 33 | **TaskCreate projection mode mismatch** — active run bundle projection mode vs TaskList ledger disagrees. | Warning | Report-only |
| 34 | **plan.index.json staleness** — `plan_hash` in `state.yml` or `plan.index.json` doesn't match current `plan.md` sha256. | Warning | Report-only |
| 35 | **Plan-format conformance (v5.0 markers)** — every task heading in `plan.md` must be followed by `**Spec:**` and `**Verify:**` markers within 30 lines. | Warning | Report-only |
| 36 | **parts/step-*.md sanity + router ceiling** — `commands/masterplan.md` ≤20480 bytes; all phase files exist; CC-3-trampoline and DISPATCH-SITE tags present. | Warning | Report-only |
| 38 | **Anomaly file has records since last archive** — `<run-dir>/anomalies.jsonl` (or sidecar `anomalies-pending-upload.jsonl`) is non-empty for any in-progress or recently-archived bundle, indicating failure-instrumentation framework detected ≥1 orchestrator anomaly that has not been reviewed. | Warning | Report each anomaly record: class, signature, last-fired timestamp. If `anomalies-pending-upload.jsonl` is non-empty, suggest `bin/masterplan-anomaly-flush.sh` to drain to GitHub. Report-only otherwise. |
| 39 | **Codex auth expired or stale** (repo-scoped, v5.1.1+, refined v5.2.3+). Reads `~/.codex/auth.json`. Decodes JWT `exp` claim from `id_token` and `access_token` (nested under `.tokens.*` per schema_v3+; falls back to top-level for older schemas). Fires on: (a) either token expired (`now > exp`); (b) either token expires within 24h (`exp - now < 86400`); (c) `last_refresh` > 30 days ago even when tokens are within validity. **Skipped (returns PASS-with-info) when `auth_mode == "chatgpt"` AND `tokens.refresh_token` is present AND `last_refresh` is within the last 7 days** — that shape indicates the ChatGPT mode's short-lived JWT auto-refresh is healthy, so cosmetic `id_token.exp` past `now` is normal steady state, not degradation. Diagnoses the upstream cause of Codex routing/review silently degrading to off — Step 0's ping returns an error, the framework correctly applies `degrade-loudly`, but the user has no idea WHY. Pairs with check #18 (config-vs-plugin mismatch): #18 flags persistent misconfig; #39 flags expired credentials. Skipped silently when `~/.codex/auth.json` is absent (codex not installed). | Warning | Report per-token expiry timestamp + age in days. Suggest `codex login` (or equivalent shell-based refresh — varies by codex CLI version). No auto-fix (auth refresh is browser-based OAuth, user-owned per headless-host constraint). |
| 40 | **High-complexity plan missing Codex / parallel-group annotations** (plan-scoped, v5.1.1+, I-2 of cosmic-cuddling-dusk). Fires when `state.yml.complexity == "high"` AND the plan-scoped count of `**Codex:** (ok|no)` annotations in `plan.md` is LESS than the count of task headings (`^### Task `). Also INFO-flags when `state.yml.complexity == "high"` AND zero `**parallel-group:**` annotations exist in plan.md. Per `parts/step-b.md` complexity-aware brief, `complexity: high` REQUIRES a `**Codex:**` annotation per task and ENCOURAGES `**parallel-group:**` annotations for verification/lint/inference clusters; this check catches the writing-plans skill silently skipping the high-complexity brief, which suppresses Codex routing (eligibility cache falls back to heuristic-only) and parallel-wave dispatch (wave assembly pre-pass has nothing to assemble). Skipped silently on `complexity: low` and `complexity: medium`. | Warning | Report per-plan: complexity, task count, Codex annotation count, parallel-group annotation count, and the gap. Suggest re-running `/masterplan plan --from-spec=<spec>` to regenerate with the high-complexity brief, OR annotating by hand. No auto-fix (modifying plan.md mid-execution is risky per CD-7). |
| 41 | **Missing Codex degradation evidence** (plan-scoped, v5.1.1+, expanded v5.3.0+). Three sub-fires: (a) WARN when `state.yml.codex_routing == off` AND `state.yml.codex_review == off` AND `~/.codex/auth.json` is healthy AND `events.jsonl` has NO `codex degraded` event AND `state.yml.last_warning` is null/absent (silent override without evidence — violates the degrade-loudly visibility contract). (b) INFO when `state.yml.codex_routing == auto` OR `state.yml.codex_routing == manual` AND `events.jsonl` has NO `routing→.*\[codex\]` events anywhere AND `events.jsonl` has at least one `codex_ping ok` event (suggesting ping detected codex available but every task was judged ineligible by the planner or heuristic — symptomatic of root cause #2 in cosmic-cuddling-dusk: annotation-gap in plan). **(c) v5.3.0+ — Step 0 confabulation detector.** ERROR when `events.jsonl` contains a `degradation_self_doubt` event (Step 0 self-flagged a likely false-positive at warning-time) OR `events.jsonl` contains a `codex degraded — plugin not detected` event AND `~/.codex/auth.json` is healthy AND `ls ~/.claude/plugins/*/codex* 2>/dev/null` finds the codex plugin's files on disk. Indicates Step 0 emitted the degradation warning despite all on-disk evidence pointing to a healthy install — likely orchestrator confabulation under the legacy `ping` detection mode (fixed by default flip to `scan-then-ping` in v5.3.0). Pairs with #20/#21 from a different angle. | Warning (sub-fires a, b) / Error (sub-fire c) | Report each sub-fire with diagnostic context. For (a): suggest investigating why codex was forced off without trace — possibly Step 0 ping bug. For (b): cross-reference with #40 finding for the same plan. For (c): suggest setting `detection_mode: scan-then-ping` in `.masterplan.yaml` (or removing the explicit `ping` override) and re-running `/masterplan`. No auto-fix. |

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

(repo-scoped, v4.2.1+). Reads the three version-bearing manifests — `.claude-plugin/plugin.json` (canonical), `.claude-plugin/marketplace.json` (root `version` AND nested `plugins[0].version`), `.codex-plugin/plugin.json` — and compares each `version` field against the canonical. `.agents/plugins/marketplace.json` is exempt (no `version` field by schema). Also reads `README.md` and greps for a line matching `Current release:.*v[0-9]+\.[0-9]+\.[0-9]+`; if found, compares the extracted version against canonical. Catches the v3.4.0–v4.1.1 drift pattern where `.claude-plugin/marketplace.json` was stuck at 3.3.0 across four releases, and the v3.2.7–v5.0.1 README drift. **Implementation:** runs inline at the orchestrator (does NOT dispatch per-worktree). Use the Read tool to load each manifest, extract `version` (and the nested `plugins[0].version` for `.claude-plugin/marketplace.json`), compare against `.claude-plugin/plugin.json` as canonical. Any mismatch → emit one Warning per drifted file/field: `version drift: <file>[:<json-path>] at <observed> (canonical: <canonical>)`. For README: grep for `Current release:.*v[0-9]+\.[0-9]+\.[0-9]+`, extract the version token, compare. If the line is absent, no warning (version was intentionally removed from README).

**`--fix` action:** Report only. Auto-bumping is risky — canonical-source authority is ambiguous when multiple manifests have drifted. Suggest editing alongside the CHANGELOG entry for the next release. See `RELEASING.md` for the full release checklist.

---

## Check #31 — Per-autonomy gate-condition consistency

**Severity:** Warning

(repo-scoped, v4.2.1+). Maintains a static anchor table mapping gate-decision sites in `parts/step-b.md` (v5.0+; gates moved from `commands/masterplan.md` during v5.0 lazy-load extraction) to their expected `--autonomy [!=]= <value>` conditions. Initial table: `{anchor: "id: spec_approval", expected_regex: "--autonomy != full", note: "spec gate intentionally fires under loose"}`, `{anchor: "id: plan_approval", expected_regex: "--autonomy == gated", note: "plan gate auto-approves under loose per v4.2.0"}`. **Implementation:** runs inline at the orchestrator. For each table entry: grep `parts/step-b.md` for the anchor string, read the next 3 lines, regex-match the expected condition. Anchor not found → flag missing gate site. Anchor found but condition mismatches → flag drift with observed text. Maintainers adding a new gate site to the orchestrator MUST extend this static table; an existing entry that no longer matches → loud Warning.

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
for phase in 0 a b c; do
  if [ ! -f "parts/step-$phase.md" ]; then
    echo "WARN parts/step-$phase.md missing"; fail=1
  fi
done
grep -q 'CC-3-trampoline' commands/masterplan.md || \
  { echo "WARN CC-3-trampoline missing from router"; fail=1; }
grep -q 'CC-3-trampoline' parts/step-0.md || \
  { echo "WARN CC-3-trampoline missing from step-0"; fail=1; }
grep -q 'DISPATCH-SITE: step-c.md' parts/step-c.md 2>/dev/null || \
  { echo "WARN DISPATCH-SITE: step-c.md tags missing from step-c.md"; fail=1; }
[ $fail -eq 0 ] && echo "Check #36: PASS" || echo "Check #36: WARN"
```

---

## Check #38: Anomaly file has records since last archive

**Severity:** Warning
**Action:** Report records + suggest flush; Report-only otherwise

Scans each run bundle directory under `<config.runs_path>/` for the failure-instrumentation framework's anomaly sidecars (`anomalies.jsonl` and `anomalies-pending-upload.jsonl`). A non-empty `anomalies.jsonl` means the Stop hook's Section 9 detector recorded ≥1 orchestrator anomaly that has not yet been reviewed; a non-empty `anomalies-pending-upload.jsonl` means GitHub auto-filing failed (rate limit, auth lapse, network) and the records are queued for retry.

Each anomaly record carries: `ts`, `anomaly_class`, `signature`, `plan_slug`, `session_id`, `host`, `invocation`, `expected_behavior`, `observed_behavior`, `state_yml_at_failure`, `events_tail`, `step_trace_in_turn`, `config_snapshot`, `plugin_version`. The detector framework lives in `parts/failure-classes.md`.

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

The check is **report-only** — anomaly records are durable evidence of orchestrator misbehavior that the user (or the failure analyzer at `bin/masterplan-failure-analyze.sh`) reviews. Doctor surfaces their presence; it does not silently archive or delete them.

---

## Check #39: Codex auth expired or stale

**Severity:** Warning
**Action:** Report-only; suggest `codex login` to refresh.
**Scope:** Repo-scoped (fires once per doctor run; reads user-global `~/.codex/auth.json`).
**Added:** v5.1.1 (I-1 of cosmic-cuddling-dusk).

Diagnoses the upstream cause of Codex routing/review silently degrading to `off`: expired JWT credentials in `~/.codex/auth.json`. Step 0's `ping` mode dispatches a `codex:codex-rescue` health-check; if downstream `codex exec` fails due to expired auth, the framework correctly applies `unavailable_policy: degrade-loudly` and forces `codex_routing`/`codex_review` to `off` in-memory. But the user often doesn't notice WHY routing degraded — they just see less Codex activity. This check makes the credential state explicit.

Skipped silently when `~/.codex/auth.json` is absent (codex not installed for this user).

**Cosmetic-shape early-exit (v5.2.3+):** when `auth_mode == "chatgpt"` AND `tokens.refresh_token` is non-empty AND `last_refresh` is within the last 7 days, sub-conditions (a) and (b) are skipped — the ChatGPT auth mode uses short-lived JWTs that auto-refresh on every codex call, so cosmetic `id_token.exp` past `now` is normal steady state, not degradation. Sub-condition (c) — `last_refresh` > 30 days — still fires under this shape (it would indicate the refresh token itself has gone stale). This guard mirrors the predicate in `commands/masterplan.md` Step 3 and the (retired) `codex_jwt_only_health_false_positive` watcher in `lib/masterplan_session_audit.py`.

```bash
fail=0
auth="$HOME/.codex/auth.json"
if [ ! -r "$auth" ]; then
  echo "Check #39: SKIP (~/.codex/auth.json absent — codex not installed for this user)"
else
  now="$(date +%s)"
  # v5.2.3+ cosmetic-shape gate: skip JWT-exp sub-fires (a)/(b) under healthy auto-refresh.
  auth_mode="$(jq -r '.auth_mode // empty' "$auth" 2>/dev/null)"
  refresh_token="$(jq -r '.tokens.refresh_token // .refresh_token // empty' "$auth" 2>/dev/null)"
  last_refresh="$(jq -r '.last_refresh // empty' "$auth" 2>/dev/null)"
  jwt_skip=0
  if [ "$auth_mode" = "chatgpt" ] && [ -n "$refresh_token" ] && [ -n "$last_refresh" ]; then
    refresh_sec_gate="$(date -u -d "$last_refresh" +%s 2>/dev/null || echo 0)"
    if [ "$refresh_sec_gate" -gt 0 ]; then
      refresh_age_days_gate=$(( (now - refresh_sec_gate) / 86400 ))
      if [ "$refresh_age_days_gate" -le 7 ]; then
        jwt_skip=1
      fi
    fi
  fi
  if [ "$jwt_skip" -eq 1 ]; then
    echo "Check #39: PASS (auth_mode=chatgpt; JWT auto-refresh healthy; last_refresh ${refresh_age_days_gate}d ago)"
  else
    for field in id_token access_token; do
      # v5.2.3+: read from nested .tokens.<field> with top-level fallback for schema-compat.
      token="$(jq -r ".tokens.$field // .$field // empty" "$auth" 2>/dev/null)"
      if [ -z "$token" ]; then
        continue
      fi
      payload="$(echo "$token" | cut -d. -f2)"
      # Pad base64url to multiple of 4 before decoding
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

This check is **report-only**. Refreshing Codex auth is browser-based OAuth (per `~/.codex/auth.json` schema), which the headless-host constraint cannot run automatically — the user must execute `codex login` (or the codex CLI's documented refresh command for their version) interactively. Doctor surfaces the credential state; it does not modify auth.json.

Pairs with check #18 (Codex config-vs-plugin mismatch): #18 catches persistent misconfiguration; #39 catches expired credentials. Both can be live on the same run.

---

## Check #40: High-complexity plan missing Codex / parallel-group annotations

**Severity:** Warning (Codex annotation gap); Info (parallel-group gap)
**Action:** Report-only; suggest re-running `/masterplan plan --from-spec=<spec>` to regenerate.
**Scope:** Plan-scoped (per-plan; runs in worktree-Haiku dispatchers when worktrees ≥ 2).
**Added:** v5.1.1 (I-2 of cosmic-cuddling-dusk).

Catches the writing-plans skill silently skipping the high-complexity brief (per `parts/step-b.md` complexity-aware brief: `complexity: high` REQUIRES `**Codex:** (ok|no)` per task; ENCOURAGES `**parallel-group:**` for verification/lint/inference clusters). Without these annotations:

- Step C 3a's eligibility cache falls back to heuristic-only judgment → Codex routing silently suppressed
- Slice α wave assembly pre-pass has no parallel-group memberships → wave dispatch falls back to sequential

Empirically observed during cosmic-cuddling-dusk investigation: 3 of 4 recent high-complexity plans had 0/67 Codex annotations and 0 parallel-group annotations, while the planner brief required them all.

Skipped silently on `complexity: low` (annotations not required) and `complexity: medium` (annotations optional).

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
  codex_count="$(grep -cE '^\*\*Codex:\*\* (ok|no)' "$plan")"
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

This check is **report-only**. Modifying plan.md mid-execution is risky per CD-7 (orchestrator is canonical writer); regenerating the plan via `/masterplan plan --from-spec=<spec>` re-invokes the writing-plans skill under the active complexity brief. Manual annotation is also valid.

---

## Check #41: Missing Codex degradation evidence

**Severity:** Warning (silent-override sub-fire); Info (annotation-gap sub-fire); Error (Step 0 confabulation sub-fire, v5.3.0+)
**Action:** Report-only; cross-reference with #18, #39, #40 for diagnosis.
**Scope:** Plan-scoped (per-plan; runs in worktree-Haiku dispatchers when worktrees ≥ 2).
**Added:** v5.1.1 (I-3 of cosmic-cuddling-dusk); expanded v5.3.0 with sub-fire (c).

Three distinct sub-fires that surface the runtime-vs-config divergence from different angles:

- **(a) Silent override without evidence.** `state.yml.codex_routing == off` AND `state.yml.codex_review == off` AND `~/.codex/auth.json` is healthy (no expired JWTs) AND `events.jsonl` has NO `codex degraded` event AND `state.yml.last_warning` is null/absent. Indicates the routing was forced off WITHOUT going through Step 0's degrade-loudly path — possibly a Step 0 ping bug, an out-of-band user edit, or an orchestrator state-write that skipped the event-log obligation. The degrade-loudly contract requires written evidence; this check flags absence.
- **(b) Codex configured on but never dispatched.** `state.yml.codex_routing == auto` OR `state.yml.codex_routing == manual` AND `events.jsonl` has NO `routing→.*\[codex\]` events anywhere AND `events.jsonl` has at least one `codex_ping ok` event from Step 0 (added by I-5 of cosmic-cuddling-dusk). Indicates ping detected Codex available but every task was judged ineligible by the planner or heuristic. Symptomatic of root cause #2 in cosmic-cuddling-dusk: high-complexity plan annotation gap (cross-references #40 for the same plan).
- **(c) Step 0 confabulation (v5.3.0+).** Fires under EITHER condition: (1) `events.jsonl` contains a `degradation_self_doubt` event written by Step 0 itself at warning-time (Step 0's two on-disk probes — auth-healthy + plugin-manifest-on-disk — both passed but Step 0 was still about to emit the "plugin not detected" warning). (2) Older bundle without the self-doubt breadcrumb: `events.jsonl` contains a `codex degraded — plugin not detected` event AND `~/.codex/auth.json` is healthy AND `ls ~/.claude/plugins/*/codex* 2>/dev/null` returns a non-empty match (codex plugin's files present on disk). Either path indicates Step 0 emitted the degradation warning despite all on-disk evidence pointing to a healthy install — classic orchestrator confabulation under the legacy `ping` detection mode. The default flip to `scan-then-ping` in v5.3.0 prevents this; explicit `detection_mode: ping` users remain exposed. Suggested action: set `detection_mode: scan-then-ping` in `.masterplan.yaml` (or remove the explicit `ping` override) and re-run `/masterplan`.

```bash
fail=0
error=0
auth="$HOME/.codex/auth.json"
auth_healthy=0
if [ -r "$auth" ]; then
  now="$(date +%s)"
  # v5.2.3+ cosmetic-shape gate: ChatGPT auth mode with refresh_token + recent last_refresh
  # is healthy regardless of cosmetic JWT exp (short-lived JWTs auto-refresh on every call).
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
      # v5.2.3+: nested-path read with top-level fallback for schema-compat.
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
  # v5.3.1+ events.jsonl readability gate. Without this, `grep -c PATTERN $events 2>/dev/null || echo 0`
  # produced "0\n0" when the file existed with zero matches (grep -c always prints "0" and exits 1),
  # which failed `-eq 0` integer tests and silently skipped every sub-fire. Skip the bundle entirely
  # when events.jsonl is unreadable — sub-fires (a), (b), (c) are all events-driven and need it.
  [ -r "$events" ] || continue
  routing="$(grep -E '^codex_routing:' "$state_yml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  review="$(grep -E '^codex_review:' "$state_yml" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')"
  has_last_warning="$(grep -cE '^last_warning:' "$state_yml" 2>/dev/null)"
  if [ "$routing" = "off" ] && [ "$review" = "off" ] && [ $auth_healthy -eq 1 ] && [ "$has_last_warning" -eq 0 ]; then
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
  # v5.3.0+ sub-fire (c): Step 0 confabulation detector.
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

This check is **report-only**. Sub-fire (a) is the harder case to debug — surface the finding so the user (or a future investigation) can reproduce. Sub-fire (b) usually pairs with check #40 firing on the same plan; surface both findings together so the chain of causation is obvious.
