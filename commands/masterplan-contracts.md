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

## Contract: step-c.eligibility_cache_build_v1

```yaml
purpose: Step C step 1 Haiku eligibility-cache shard build (v5.4.0+, contractified v5.8.0)
algorithm: |
  Orchestrator shards the plan task list per the v5.4.0 sharding strategy
  (one Haiku per **parallel-group:** if any are declared; otherwise
  ceil(task_count/10) shards of ~10 tasks; single Haiku for plans <10 tasks
  with no parallel-groups). One Haiku per shard.

  Per-shard brief (Goal/Inputs/Scope/Constraints/Return):
    Goal: Apply the Step C 3a Codex eligibility checklist AND the
          parallel-eligibility rules (1-5) to each task in the shard.
    Inputs:
      Full plan task list (read-only, for rule-5 cohort visibility)
      Shard's task_indices subset (the tasks to evaluate)
      Plan annotations: **Codex:**, **parallel-group:**, **Files:**,
                        optional **non-committing:** override
    Scope: Read-only.
    Constraints: Return JSON only — no narration.
    Return: One JSON object per shard with top-level cache_schema_version
            "1.0", shard_id string ("group:<name>" | "unassigned:<range>"
            | "full"), and tasks array (only the shard's subset).

  Runtime-audit fields (dispatched_to, dispatched_at, decision_source)
  are always null at cache build time; Step 3a fills them.

return_shape: |
  contract_id: "step-c.eligibility_cache_build_v1"
  cache_schema_version: "1.0"
  shard_id: "<group:name | unassigned:range | full>"
  tasks:
    - idx: int
      name: str
      eligible: bool
      reason: str
      annotated: bool
      parallel_group: str | null
      files: [str]
      parallel_eligible: bool
      parallel_eligibility_reason: str
      dispatched_to: null
      dispatched_at: null
      decision_source: null
```

## Contract: step-c.wave_implementer_v1

```yaml
purpose: Step C step 2 wave-member implementer dispatch (Slice α v2.0.0+, contractified v5.8.0)
algorithm: |
  Orchestrator dispatches N parallel Agent calls in a single assistant
  message (N = wave member count). Each call uses subagent_type
  "general-purpose" with model: "sonnet" per §Agent dispatch contract.

  Per-member brief (standard implementer brief PLUS three wave-specific
  clauses):
    Goal: Implement THIS wave member's task per the plan entry.
    Inputs:
      Task name + index
      Acceptance criteria from plan entry
      **Files:** list (exhaustive — implementer must not read/modify
                       anything outside this list)
      Spec excerpt: relevant section of design doc
    Scope:
      WAVE CONTEXT clause: "You are dispatched as part of a parallel
        wave of N tasks (group: <name>). Your declared scope is
        **Files:** (exhaustive — do not read or modify anything outside
        this list, including plan.md, state.yml, events.jsonl, sibling
        tasks' scopes, or the eligibility cache)."
      START-SHA clause: "Capture `git rev-parse HEAD` BEFORE any work;
        return as task_start_sha (required per implementer-return
        contract)."
      NO-COMMIT clause: "DO NOT commit your work — return staged-changes
        digest only. DO NOT update run state — orchestrator handles
        batched wave-end updates."
    Constraints: Failure handling — if you BLOCK or NEEDS_CONTEXT,
                 return immediately; orchestrator's blocker
                 re-engagement gate handles you alongside the rest of
                 the wave.
    Return: implementer-return digest with task_start_sha (required),
            verification output excerpt, staged-changes summary,
            any BLOCK/NEEDS_CONTEXT signal.

return_shape: |
  contract_id: "step-c.wave_implementer_v1"
  task_idx: int
  task_name: str
  task_start_sha: "<sha>"  # REQUIRED
  staged_changes:
    files_modified: [str]
    diff_summary: str
  verification:
    commands_run: [str]
    excerpt: str  # tail -3 per command
    passed: bool
  outcome: "complete" | "blocked" | "needs_context"
  blocker: str | null
  notes: str | null
```

## Contract: step-c.codex_exec_v1

```yaml
purpose: Step C step 3a Codex EXEC dispatch (v2.4.0+ pre-dispatch visibility, contractified v5.8.0)
algorithm: |
  Orchestrator dispatches codex:codex-rescue subagent in EXEC mode.
  Codex sites are exempt from §Agent dispatch contract — do NOT pass
  model: parameter.

  Brief (Goal/Inputs/Scope/Constraints/Return per CLAUDE.md):
    Goal: Implement the named task per the plan entry.
    Inputs:
      Task name + index
      Acceptance criteria from plan entry
      **Files:** list (exhaustive scope)
      Spec excerpt: relevant section of design doc
      Branch context: current branch + worktree path
    Scope: Edit + verify within **Files:** only. May commit per the
           per-task commit convention if running outside a wave;
           wave-mode dispatch uses step-c.wave_implementer_v1 instead.
    Constraints: CD-10. Edit-only when sandbox .git is read-only;
                 return a signed digest if commit is blocked.
    Return: implementer-return digest with task_start_sha (required),
            verification output, commit SHA (when commit succeeded) or
            edit-only flag.

return_shape: |
  contract_id: "step-c.codex_exec_v1"
  task_idx: int
  task_name: str
  task_start_sha: "<sha>"  # REQUIRED
  commit_sha: "<sha>" | null  # null when edit-only mode
  files_modified: [str]
  verification:
    commands_run: [str]
    excerpt: str
    passed: bool
  outcome: "complete" | "blocked" | "needs_context"
  blocker: str | null
  notes: str | null
```

## Contract: step-c.codex_review_serial_v1

```yaml
purpose: Step C step 4b serial Codex REVIEW dispatch (v2.4.0+ pre-dispatch visibility, contractified v5.8.0)
algorithm: |
  Orchestrator dispatches codex:codex-rescue subagent in REVIEW mode
  for serial (non-wave) tasks. Asymmetric review rule applies:
  dispatched_by == "codex" tasks skip serial 4b entirely (see Step
  3a's post-Codex flow).

  Brief (Goal/Inputs/Scope/Constraints/Return):
    Goal: Adversarial review of this task's diff against the spec and
          acceptance criteria.
    Inputs:
      Task: <task name from plan>
      Acceptance criteria: <bullet list from plan>
      Spec excerpt: <relevant section of design doc>
      Diff range: <task_start_sha>..HEAD
      Files in scope: <task's **Files:** list>
      Verification: <captured output from 4a>
    Scope: Review only — no writes, no commits, no file modifications.
           Run `git diff <range> -- <files...>` yourself to obtain the
           diff. Diff range NOT inlined into the brief.
    Constraints: CD-10. Be adversarial about correctness, not style.
    Return: severity-ordered findings (high/medium/low) grounded in
            file:line, OR the literal string "no findings" if clean.

return_shape: |
  contract_id: "step-c.codex_review_serial_v1"
  task_idx: int
  task_name: str
  diff_range: "<task_start_sha>..HEAD"
  files_in_scope: [str]
  severity_summary: "clean" | "<N high, N medium, N low>"
  findings: [{severity, file, line, message}] OR []
  notes: str | null
```

## Contract: codex.review_wave_member_v1

```yaml
purpose: Per-wave-member Codex REVIEW dispatch at wave-end Step 4b (v5.8.0+)
algorithm: |
  Orchestrator emits N parallel Codex REVIEW Agent calls in a single assistant
  message — one per qualifying wave member (one that passed gate eval +
  asymmetric-review rule). Each call is bounded to a single wave member.

  Per-member brief shape (Goal/Inputs/Scope/Constraints/Return):
    Goal: Adversarial review of THIS wave member's portion of the wave-end
          commit against the spec and acceptance criteria.
    Inputs:
      Task: <member task name from plan>
      Acceptance criteria: <bullet list from member's plan entry>
      Spec excerpt: <member's relevant section of design doc>
      Diff range: <wave_start_sha>..<wave_end_sha>
      Files in scope: <member's **Files:** list>
      Verification: <captured output from 4a's wave verification, member-filtered>
    Scope: Review only — no writes, no commits, no file modifications.
           Run `git diff <range> -- <files...>` yourself to obtain the diff.
    Constraints: CD-10. Be adversarial about correctness, not style.
                 Do NOT review other wave members' files even if they
                 share the diff range.
    Return: severity-ordered findings (high/medium/low) grounded in file:line,
            OR the literal string "no findings" if clean.

  Codex sites are exempt from §Agent dispatch contract — do NOT pass model:.

  Reviewer-batching: all N calls in ONE assistant message. Read-only
  reviewers do not conflict on shared state, so batching is correct
  (this is the same batching rule that governs N parallel
  feature-dev:code-reviewer dispatches across independent tasks).

return_shape: |
  contract_id: "codex.review_wave_member_v1"
  member_task_id: "<task name>"
  diff_range: "<wave_start_sha>..<wave_end_sha>"
  files_in_scope: [list of files]
  severity_summary: "clean" | "<N high, N medium, N low>"
  findings: [{severity, file, line, message}] OR []
  notes: "<optional, e.g. 'diff was empty for this member'>"
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
