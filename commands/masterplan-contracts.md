---
description: "Internal subagent contract registry — read by orchestrator dispatch briefs in parts/step-b.md and parts/doctor.md. Not user-invokable; this command file is a registry doc, not an action."
---

# Masterplan subagent contract registry

Each lifecycle subagent dispatch declares a `contract_id`. The orchestrator validates the return before acting on it. If validation fails, the orchestrator re-runs the invariant check locally and emits a `contract_violation` event.

## Contract: import.convert_v1

```yaml
purpose: Convert legacy planning artifacts to bundle-local spec.md and plan.md content strings
algorithm: |
  Parent stages copies before dispatching:
    - For each legacy.* path in the candidate's state that resolves to an extant file,
      copy it to /tmp/masterplan-import-<slug>-<pid>/ (PID-tagged directory that the
      temp-dir sweep in Step 0 will eventually prune). Validate read access before any
      bundle writes. If a legacy.* path does not resolve, record the missing path.

  Subagent reads staged inputs and returns content — subagent does NOT write files:
    - Produce a coherent spec.md and plan.md from the legacy artifact content.
    - Return content strings in artifacts.spec.content and artifacts.plan.content.
    - Record the source legacy path in artifacts.spec.source and artifacts.plan.source.
    - If the legacy artifact is a brief or chat dump (not a real plan), include a failure
      reason in violations and set coverage.processed to the count actually handled.

  Parent validates return shape:
    - If violations is non-empty OR coverage.processed != coverage.expected OR
      contract_id != "import.convert_v1": treat import as failed; go to fallback path.
    - Record {"event":"import_contract_violation","contract_id":"import.convert_v1","violations":[...]}

  Parent writes atomically on all-clear:
    a. Write <run-dir>/spec.md from artifacts.spec.content.
    b. Write <run-dir>/plan.md from artifacts.plan.content.
    c. Rewrite artifacts.spec and artifacts.plan in state.yml to bundle-local paths.
    d. Preserve legacy.* pointers for forensics.
    e. Write import_hydration: "full", import_contract.contract_id, inputs_hash, processed_at into state.yml.
    f. All of c/d/e are written in a single state.yml update (not incremental).
    g. On any failure: rm -rf /tmp/masterplan-import-<slug>-<pid>/, abort import, append
       {"event":"import_hydration_aborted","reason":"..."}.

return_shape: |
  contract_id: "import.convert_v1"
  inputs_hash: "<sha256 of staged inputs>"
  processed_paths: ["spec.md", "plan.md"]
  violations: []
  coverage: {expected: 2, processed: 2}
  artifacts:
    spec: {content: "...", source: "<legacy.spec>"}
    plan: {content: "...", source: "<legacy.plan>"}
```

## Contract: doctor.schema_v2

```yaml
purpose: Per-bundle schema_v2 compliance check
algorithm: |
  For each bundle path in scope:
    1. Read state.yml; YAML-parse. If parse fails, emit violation {bundle, field: "state.yml", kind: "parse_failed"}.
    2. For each required field in SCHEMA_V2_REQUIRED (see spec Section "Schema v3"):
       Read field by dotted path (e.g. "artifacts.spec").
       If field is absent OR str(value).strip() == "" (for artifact paths) OR value is null (for non-nullable fields):
         append violation { bundle, field, kind: "missing_or_empty" }
    3. Cross-check: for each non-empty legacy.* pointer, verify corresponding artifacts.* pointer is non-empty AND file exists. If not: append violation {bundle, field: "artifacts vs legacy", kind: "hydration_gap"}.
return_shape: |
  contract_id: "doctor.schema_v2"
  inputs_hash: "<sha256 of bundle state.yml paths processed>"
  processed_paths: [list of state.yml paths]
  violations: [{bundle, field, kind, detail}]
  coverage: {expected: int, processed: int}
```

## Contract: doctor.repo_scoped.schema_v1

```yaml
purpose: Run the five repo-scoped doctor checks (#26, #30, #31, #36, #39) in one Haiku batch (v5.4.0+)
algorithm: |
  Load deferred CronList via ToolSearch first (required for check #26).
  For each check, run the algorithm enumerated in parts/doctor.md's per-check row:
    #26 auto_compact_loop_attached: call CronList(); filter entries whose prompt contains "/compact"; cross-reference with state.yml compact_loop_recommended flags.
    #30 cross_manifest_version_drift: Read .claude-plugin/plugin.json (canonical), .claude-plugin/marketplace.json (root + nested[0].version), .codex-plugin/plugin.json; grep README.md for "Current release:.*v[0-9]+\.[0-9]+\.[0-9]+"; report any drifted file/field.
    #31 per_autonomy_gate_condition_consistency: Read parts/step-b.md; lint per-autonomy gate conditions for consistency per the rules documented in parts/doctor.md Check #31.
    #36 router_ceiling_and_phase_file_sanity: Read commands/masterplan.md (size check); check existence of parts/step-*.md per Check #36's manifest.
    #39 codex_auth_expiry: Read ~/.codex/auth.json; apply Check #39's chatgpt-mode-with-refresh-token suppression rule.
  Aggregate all per-check findings into a single violations[] array.
return_shape: |
  contract_id: "doctor.repo_scoped.schema_v1"
  checks_processed: [26, 30, 31, 36, 39]
  violations: [{check_id: int, severity: "warning"|"error"|"info", file: str, message: str}]
  notes: "<optional string, e.g. 'CronList unavailable; #26 skipped'>"
```

## Contract: retro.source_gather_v1

```yaml
purpose: Collect retro source material for a completed bundle
algorithm: |
  1. Read state.yml (fields: slug, branch, started, last_activity, artifacts.*).
  2. Read events.jsonl (last 200 lines; if events-archive.jsonl exists, also read last 50 lines).
  3. Read plan.md (full if ≤ 200 lines; first 200 lines otherwise).
  4. Read spec.md (first 100 lines).
  5. Run: git -C <worktree> log --reverse --format='%h %ci %s' <trunk>..<branch> (capture up to 50 lines).
  6. If gh available: gh pr list --search "head:<branch>" --state=all --json=number,title,url,mergedAt,additions,deletions.
  Return the structured digest {state, events, blockers, notes, task_list, spec_excerpt, commits, pr?}.
  Do NOT return raw file content — return excerpts and structured fields only.
return_shape: |
  contract_id: "retro.source_gather_v1"
  inputs_hash: "<sha256>"
  processed_paths: [state.yml, events.jsonl, plan.md, spec.md]
  violations: []
  coverage: {expected: 4, processed: 4}
  digest: {state, events_summary, blockers, task_list, spec_excerpt, commits, pr}
```

## Contract: related_scope_scan_v1

```yaml
purpose: Identify plans whose slug/branch overlaps with a new topic's salient words
algorithm: |
  For each state.yml in <worktree>/<runs_path>/:
    1. Read slug, current_task fields.
    2. Check substring overlap between (slug + current_task) and topic words (case-insensitive).
    3. If overlap: include in matching_slugs.
  For git_state.branches: check case-insensitive substring of branch name vs topic words.
return_shape: |
  contract_id: "related_scope_scan_v1"
  inputs_hash: "<sha256>"
  processed_paths: [list of state.yml paths]
  violations: []
  coverage: {expected: N, processed: N}
  result: {worktree, branch, matching_slugs: [], matching_branch: bool}
```
