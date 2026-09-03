# Enhance masterplan so it does a better job of interviewing the operator to understand the true intent of the requested feature. The goal isn't to have the operator tell the model exactly what to it, it's to help the model understand the operators' intentions, so it can design its own solution. We currently don't do a good job of this, and our --complexity=high mode isn't nearly high enough in terms of getting the system to ask probing questions until it has a true understanding. We're also poor at recording those "goals", our current goals implementation gathers a large list of specific items which may or may not be helpful, but it doesn't make much effort to try and capture the true "intent". And lastly, we're particularly bad about the end of the project, driving the task to completion, and making sure it is ACTUALLY deployed and completed at the end of the work.

Spec: /srv/dev/ras/masterplan/docs/masterplan/intent-to-completion/spec.md

48 task(s) across 11 wave(s).

## Wave 0

### Task 1: Extend the schema-v9 bundle contract without a version bump: validate new-seed autonomy and derived source fields while tolerating legacy fields and autonomy full, support complete/incomplete/merged completion with an absent field remaining legacy, and add append-time schemas for interview, overlap/config, deploy/final-goal-check, completion/archive, required-successor, and bootstrap armed/step events. Export the bootstrap event validation and fixed step enum needed by the one-off driver while preserving existing generic event compatibility. Own focused tests in test/bundle-events.test.mjs covering a valid and an invalid instance of every new event type, the append-time rejection path, the exported bootstrap validation and step enum, legacy-field tolerance (complexity_source, predecessor_transcript, autonomy full), the absent-completion legacy reading, and the post-archive restriction (only archive_pushed is accepted after archived). Generic event types already present in existing bundles (for example the pre_finish_stage_required note recorded on this run) stay readable and replayable: append-time validation binds only the new typed events.
- files: lib/bundle.mjs, test/bundle.test.mjs, test/bundle-events.test.mjs
- verify: node --test test/bundle-events.test.mjs ; node --test test/bundle.test.mjs ; for t in interview_question overlap_review deploy_step_started completion_confirmed required_successor archive_pushed bootstrap_armed bootstrap_step; do grep -q "$t" lib/bundle.mjs || { echo "missing $t in lib/bundle.mjs"; exit 1; }; done
- codex: heuristic
- spec_refs: spec.md §4.1, spec.md §5.3, spec.md §6.2, spec.md §7.2, spec.md §7.4, spec.md §8, spec.md §10, spec.md §11, spec.md §12

### Task 2: Repair the pre-existing RED test A1 in test/cli-surface.test.mjs. The actual defect: --goals-choice is already in KNOWN_FLAGS and threaded to finishStep, but die() exits 2 for every uncaught error, so the ENOENT for the test's nonexistent state file collides with the unknown-flag exit code the test rules out. Give uncaught and I/O errors a distinct exit code (keep 2 for the unknown-flag contract) so a recognized flag is provably not rejected as unknown, and keep every other CLI exit-code assertion green.
- files: bin/masterplan.mjs, test/cli-surface.test.mjs
- verify: node --test test/cli-surface.test.mjs
- codex: heuristic
- spec_refs: spec.md §6.2, spec.md §7.2, spec.md §11

### Task 10: Add the fresh-context intent critic agent prompt with the required critic/breaker/frontier posture, quoted-data boundary, intent-versus-how review rules, and schema-constrained unknowns, misclassified question ids, contradictions, and synthesized intent draft. Document the interview budgets, round cadence, durable artifacts, honesty-bound receipts, terminal states, and disk-based resume behavior. Reuse the existing critic workflow-map class without changing policy/workflow-map.json.
integration note: bootstrap-release's Pi registration must discover mp-intent-critic, while the existing Claude agent loader should register it through normal agent discovery; orchestration-integration's sequencer should dispatch it with the verbatim anchor, ledger, and draft as quoted data. Add test/intent-critic-prompt.test.mjs, which parses the agent file's frontmatter and schema section and asserts the critic/breaker/frontier posture, the quoted-data boundary text, and the complete output schema (unknowns with why_it_changes_design, misclassified question ids, contradictions, intent draft).
- files: agents/mp-intent-critic.md, docs/design/intent-interview.md, test/intent-critic-prompt.test.mjs
- verify: grep -q '^name: mp-intent-critic$' agents/mp-intent-critic.md && grep -q 'why_it_changes_design' agents/mp-intent-critic.md && grep -q 'misclassified' agents/mp-intent-critic.md && grep -q 'contradictions' agents/mp-intent-critic.md ; grep -q 'converged' docs/design/intent-interview.md && grep -q 'exhausted' docs/design/intent-interview.md && grep -q 'critic_off' docs/design/intent-interview.md && grep -q 'content_head' docs/design/intent-interview.md ; node --test test/intent-critic-prompt.test.mjs
- codex: heuristic
- spec_refs: spec.md §5.1, spec.md §5.2, spec.md §5.3, spec.md §5.4, spec.md §12

### Task 13: Extend goal parsing, validation, hashing, amendment comparison, and tests for v2 documents containing an Intent block with why, outcome, anti_goals, and done_means followed by three to five outcome goals. Preserve v1 parsing behavior, keep optional signal and evidence fields in canonical hashes when present, include all Intent fields in goalsHash, retain the immutable topic anchor, and make an intent-only amendment re-arm the existing spec-gate change contract.
- files: lib/goals.mjs, test/goals.test.mjs
- verify: node --test test/goals.test.mjs
- codex: heuristic
- spec_refs: spec.md §6.1, spec.md §11, spec.md §12

### Task 16: Choose and implement a dependency-free YAML parser for the recognized `.masterplan.yaml` subset inside `lib/config.mjs`, rather than adding a runtime package that installed plugin trees cannot assume is present. Implement `resolveRunConfig({ cli, repoRoot, home, env })`, deterministic warnings, CLI > repo > user > default precedence, whole-object replacement with partial `context_watch` defaults, complexity-derived planning mode, enum validation, `full` and `auto_compact` aliases, unknown-key handling, and repo-only `done`. Validate `done: none`, group and step shapes, `version_from`, hostile or unresolved `${version}` values, shell-safe version substitution, and `commit_paths` defaults and warnings; expose reusable parsing/revision-validation helpers so finish can resolve the definition at a supplied git SHA and calculate its digest. Export `readEnv(name)` as the sole permitted `process.env` access and schema metadata for the inventory guard. Cover source precedence, malformed files, aliases, nested replacement, schema failures, revision re-resolution, and warnings with resolver-level tests. Integration note: orchestration-integration.cli must feed seed/config-show overrides through this API, persist resolved values and derived source fields, print warnings and append one `config_warning` event, reject the removed flags, and expose the harness `autoCompactWindow`; finish-live must consume the revision helper at `deploy_base_sha`. Every owner of files under `lib/` or `bin/` must replace direct environment reads, including `MP_DISPATCH_WAVE_CONCURRENCY`, `MP_ROUTING_POLICY`, `SKYNET_VERIFY_ALLOWLIST`, and `MP_CONTEXT_WINDOW`, with `readEnv`. Alongside `readEnv`, export the single child-process environment passthrough used wherever a spawned process needs the inherited environment, so no module other than lib/config.mjs touches process.env.
- files: lib/config.mjs, test/config.test.mjs
- verify: node --test test/config.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.1, spec.md §4.2, spec.md §4.3, spec.md §4.4, spec.md §7.1, spec.md §9, spec.md §11, spec.md §12

### Task 22: Add deterministic finish helpers for canonical deploy-group ordering, exit-status-only run/check classification, safe validated ${version} substitution, deploy-chain hashing, and complete/incomplete/merged/legacy classification. Extend unit coverage for absent, none, and object done definitions and ensure command output never affects check classification.
- files: lib/finish.mjs, test/finish.test.mjs
- verify: node --test test/finish.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.1, spec.md §7.2, spec.md §7.4, spec.md §11

### Task 31: Implement reusable repo-wide seed-lock primitives using atomic creation of docs/masterplan/.seed.lock, PID and ownership metadata, live-lock refusal, and owner-safe release. Cover competing acquisitions, release after failure, and live/dead owner inspection with temporary repositories.
integration note: orchestration-integration must hold this lock across overlap-digest revalidation and validate-then-create seeding, release it in a finally path, and leave no bundle directory when validation fails.
- files: lib/seed-lock.mjs, test/seed-lock.test.mjs
- verify: node --test test/seed-lock.test.mjs
- codex: heuristic
- spec_refs: spec.md §8, spec.md §11, spec.md §12

### Task 33: Implement active-run brief resolution and rendering in a new library module: zero active bundles produce no output, one produces the five durable lines for slug, phase, open gate, goals.md outcome, and next mp operation, and several produce one summary line each. Surface unresolved required_successor obligations before active-run output, require the matching predecessor link when evaluating successors, and include the exact seed command.
integration note: orchestration-integration must expose this renderer as mp resume-brief --repo-root and reuse its obligation projection for runs list and status; doctor policy and severity remain owned by doctor-obligations.
- files: lib/resume-brief.mjs, test/resume-brief.test.mjs
- verify: node --test test/resume-brief.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.4, spec.md §9, spec.md §11, spec.md §12

### Task 36: Add the auto-discovered resume-brief-hook doctor check. Inspect /srv/workflows/hooks/policy.toml when present, accept only a session_start rule whose command invokes resume-brief with --repo-root, WARN for missing or incomplete wiring, and return SKIP without a warning when the policy file is absent. Keep the production path fixed while allowing tests to supply a fixture path through internal check options rather than a new environment or CLI knob. Cover valid wiring, no matching rule, a resume-brief command lacking --repo-root, and an absent policy file through the doctor runner.
- files: lib/doctor/resume-brief-hook.mjs, test/resume-brief-hook.test.mjs
- verify: node --test test/resume-brief-hook.test.mjs
- codex: heuristic
- spec_refs: spec.md §9, spec.md §11, spec.md §12

### Task 42: Implement scripts/release.mjs --version=V so it validates the release version, refuses version files that were not already bumped, never bumps them itself, inserts and commits only a missing CHANGELOG release header, creates an annotated tag, replays idempotently when its tag already points at HEAD, and fails for a foreign tag. Add the 10.0.0 release notes section to CHANGELOG.md and document the release contract and corrective 10.0.x path in RELEASING.md. The version-bearing files are NOT bumped here: the publish-hygiene live test requires every manifest and README to agree, so the bump of all of them to 10.0.0 lands together in the docs task (orchestration-integration.docs), which owns README.md. Add test/release-script.test.mjs with isolated temporary-repository cases: an invalid version string is refused, unbumped version files are refused, a foreign tag at the version is refused, the release commit touches only CHANGELOG.md, and the tag is annotated and idempotent on replay.
- files: scripts/release.mjs, .claude-plugin/plugin.json, package.json, CHANGELOG.md, RELEASING.md, test/publish-hygiene.test.mjs, test/release-script.test.mjs
- verify: node --test test/publish-hygiene.test.mjs ; node --check scripts/release.mjs ; grep -q 'never bumps' RELEASING.md && grep -Eq 'corrective.*10\.0\.x|10\.0\.x.*corrective' RELEASING.md ; node --test test/release-script.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.1, spec.md §10.1, spec.md §10.3, spec.md §11, spec.md §12

### Task 43: Add self-contained registration coverage proving the generic Pi registrar discovers an agents directory entry named mp-intent-critic.md, maps its lane model, writes it into the managed manifest, and reports clean under --check without taking ownership of the agent prompt itself.
- files: test/register-pi-agents.test.mjs
- verify: node --test test/register-pi-agents.test.mjs
- codex: heuristic
- spec_refs: spec.md §11, spec.md §12

## Wave 1

### Task 11: Implement the replayable interview ledger and its initial focused suite. Derive question, answer, round, active-design-pick, critic, budget, and terminal status from events; append mutations through the bundle writer; enforce question sequencing, unanswered-question and cap guards; record verbatim answers, withdrawals, supersession and resolution links; persist intent drafts and numbered critic payload artifacts with computed digests and honesty-bound receipt fields; support unavailable critic attempts, waiver, end, reopen, read-only status (the budget/state summary), and a verbatim ledger replay — every question, answer, withdrawal, draft, and critic receipt in order — as a distinct library operation, without relying on in-memory counters.
integration note: orchestration-integration CLI should expose these library operations as mp interview ask|answer|withdraw|draft|critic|end|reopen|status|replay and route goals-load --interview-waived through the waiver operation; this task does not edit bin/masterplan.mjs. Flag surface for the CLI wiring, verbatim from spec §5.3: --id --round --kind --text --corrected --supersedes --resolves --file --receipt --payload-file --unavailable --error --reason --critic-unavailable-ack.
- files: lib/interview.mjs, test/interview-ledger-resume.test.mjs
- verify: node --check lib/interview.mjs ; node --test test/interview-ledger-resume.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.2, spec.md §5.3, spec.md §5.4, spec.md §11, spec.md §12

### Task 17: Update migration parsing so pre-v10 bundles containing `complexity_source`, `predecessor_transcript`, nullable historical values, or `autonomy: full` remain readable without a schema-version bump or destructive rewriting, while newly resolved configuration still uses validated non-null values and `loose`. Add migration compatibility cases to the config suite. Integration note: orchestration-integration.schema must retain validation tolerance for these legacy state fields and `autonomy: full` while treating the new source fields as derived data.
- files: lib/migrate.mjs, test/config.test.mjs, lib/config.mjs
- verify: node --test test/config.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.1, spec.md §4.3, spec.md §11, spec.md §12

### Task 23: Extend the one-op finish driver from branch disposition into the deploy pipeline: re-resolve the repo-local done definition from .masterplan.yaml at deploy_base_sha through the config contract, record deploy_base with branch_tip and done_sha256, handle no_definition_of_done with ad-hoc or incomplete paths, treat done: none as an empty deploy chain, execute groups in release → install → user_only → live_check order, and emit durable authorized → started → deploy_step transitions. Consume autonomy as a behavioral input: gated asks before each runnable step, loose auto-authorizes successful progression, failures and indeterminate results halt, and user_only always hands back for a checked result. Preserve the existing pre-disposition finish order. integration note: orchestration-integration.cli must expose --deploy-authorize, --deploy-step-done, --deploy-rerun, --deploy-attest, --deploy-retry, --deploy-skip, --deploy-abort, --deploy-abort-incomplete, --done-adhoc-file, --merged, --merge-sha, --version-fix, --goals-choice, --intent-confirmed, --intent-rejected, --class, --reason, --archive-pushed, and --sha and pass them to finishStep.
- files: lib/finish-step.mjs, test/finish-step.test.mjs
- verify: node --test test/finish-step.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.1, spec.md §7.2, spec.md §7.4, spec.md §7.6, spec.md §11

### Task 32: Extend sweepWorktrees so dry runs report a seed lock owned by a dead recorded PID and apply mode removes it through the shared lock primitive, while preserving live-owner locks and existing worktree cleanup behavior. Route lib/sweep.mjs's environment access through lib/config.mjs's readEnv.
- files: lib/sweep.mjs, test/sweep.test.mjs
- verify: node --test test/sweep.test.mjs
- codex: heuristic
- spec_refs: spec.md §8, spec.md §11, spec.md §12

### Task 34: Implement the integration-facing run-awareness libraries. Enrich discoverRuns records with the full topic, phase, worktree path or null, parsed goals [{id,text}], and the sorted deduplicated union of plan.index.json task files; export canonical inventory serialization, inventory_sha256 computation over exactly the returned records, and a stale overlap-review assertion. Add transcript lineage resolution and context measurement in lib/context-status.mjs: encode the MAIN project path, prefer its session transcript, fall back only to direct sibling project transcripts, ignore subagent task transcripts, derive the last assistant usage total and trailing four-characters-per-token estimate, and return current, post-compaction, malformed, unsupported, or not-found without fabricating usage. Implement explicit-window, injected MP_CONTEXT_WINDOW, [1m] harness-model, and 200k window precedence with window_source, plus threshold/focus recommendations using the active-run projection for the generated default. Tests cover resumed and fresh transcripts, trailing records, compaction, malformed usage, missing sessions, subdirectory lineage, 200k/1M windows, and configured versus generated focus.
integration note: orchestration-integration must wire runs list and both overlap-review recorders to these digest helpers; acquire the seed lock before recomputing the digest; wire context-status and pass MP_CONTEXT_WINDOW through config-knobs' readEnv helper rather than reading process.env here; and complete the black-box seed/resume event-order coverage in test/overlap-sequencer.test.mjs. Route lib/runs.mjs's environment access through readEnv as well.
- files: lib/runs.mjs, lib/context-status.mjs, test/runs.test.mjs, test/context-status-session-lineage.test.mjs
- verify: node --test test/runs.test.mjs ; node --test test/context-status-session-lineage.test.mjs ; node --test test/resume-brief.test.mjs
- codex: heuristic
- spec_refs: spec.md §8, spec.md §9, spec.md §11, spec.md §12

### Task 37: Add the auto-discovered no-definition-of-done doctor check using the repo-config parser from lib/config.mjs rather than a second YAML parser. WARN only when the repository has a .masterplan.yaml with no done key; emit no warning when the file is absent, when done is the literal none sentinel, or when a done object is declared. Assert that WARN and non-applicable states keep the doctor exit code at zero.
- files: lib/doctor/no-definition-of-done.mjs, test/no-definition-of-done.test.mjs
- verify: node --test test/no-definition-of-done.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.4, spec.md §11, spec.md §12

### Task 38: Add incomplete-archive as a separate auto-discovered check instead of extending dangling-run, preserving file-disjoint implementation. Emit a PASS informational finding for each archived bundle classified as incomplete:<reason> or merged, include its slug and completion class, and do not report complete, legacy, or active bundles. Cover incomplete reasons and the done:none merged class. Scope: fixture bundles only at this wave (the real writers land later); the bootstrap recovery suite re-runs this check against writer-produced bundles.
- files: lib/doctor/incomplete-archive.mjs, test/incomplete-archive.test.mjs
- verify: node --test test/incomplete-archive.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.4, spec.md §11, spec.md §12

### Task 39: Add legacy-archive as a separate auto-discovered check that emits a PASS informational finding for archived bundles lacking the completion field, without treating pre-v10 state as a schema crash or as complete. Exclude active bundles and archived bundles carrying complete, merged, or incomplete:* classes, and cover the v9-finished bootstrap run shape. Scope: fixture bundles only at this wave (the real writers land later); the bootstrap recovery suite re-runs this check against writer-produced bundles.
- files: lib/doctor/legacy-archive.mjs, test/legacy-archive.test.mjs
- verify: node --test test/legacy-archive.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.4, spec.md §10.2, spec.md §11, spec.md §12

### Task 40: Add the auto-discovered required-successor check. For every required_successor event, match only a bundle whose slug equals the required slug and whose seed record names the obligation source via predecessor. Report an absent linked successor as WARN with an actionable seed command, a linked non-archived successor as an informational PASS, and an archived complete successor as PASS; report an archived incomplete:*, merged, or legacy successor as ERROR. Assert doctor exit codes for all lifecycle states and prove that a same-slug bundle without the predecessor link leaves the obligation absent and WARN-only. Scope: fixture bundles only at this wave (the real writers land later); the bootstrap recovery suite re-runs this check against writer-produced bundles. The slug in the event comes from the emitter (the finish --successor flag, or the operator's `mp event` for the bootstrap obligation); the matcher stays slug plus predecessor link.
- files: lib/doctor/required-successor.mjs, test/required-successor.test.mjs
- verify: node --test test/required-successor.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.4, spec.md §10.2, spec.md §10.3, spec.md §11, spec.md §12

### Task 41: Extend install-pi checking with --expect=vV so it resolves the current release, executes <install-root>/current/bin/masterplan.mjs version, and fails unless the executable reports the expected version while preserving the existing structural, fixture-root, and rollback behavior. Add success, mismatch, missing/non-executable binary, and fixture-root coverage. Route bin/install-pi.mjs's HOME lookup through lib/config.mjs's readEnv.
- files: bin/install-pi.mjs, test/install-pi.test.mjs
- verify: node --test test/install-pi.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.1, spec.md §10.1, spec.md §11, spec.md §12

## Wave 2

### Task 12: Harden the interview replay and tests for the complete terminal-state contract: rounds seal on the first answer, withdrawal, draft, or critic event; batches may ask within the current round; completed intent rounds require an answered intent question; high complexity refuses a new intent round without the preceding receipt and convergence requires distinct per-round receipts; design events do not move content_head; drafts must follow all intent content; unavailable critics require two same-head failures plus operator acknowledgement; floors, intent floors, caps, and round minima cannot be padded by withdrawals or design picks; terminal and waived states are absorbing; reopen is brainstorm-only before goals freeze; exhausted events retain every unresolved item from the latest available payload. Extend replay fixtures to prove these rules after simulated compaction and to reject forged or malformed receipts and payloads.
- files: lib/interview.mjs, test/interview-ledger-resume.test.mjs
- verify: node --test test/interview-ledger-resume.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.2, spec.md §5.3, spec.md §5.4, spec.md §11

### Task 18: Add this repository's literal `done:` configuration with `.claude-plugin/plugin.json` as `version_from` and the specified release, install, user-only, and live-check commands and exit-status predicates. Extend the config suite to load the checked-in file, exercise the default metadata-only `commit_paths`, reject `{text, evidence}`, and run the literal normalized `git ls-remote` predicate against a tagless bare remote to prove absence reports exit 1 rather than indeterminate.
- files: .masterplan.yaml, test/config.test.mjs
- verify: node --test test/config.test.mjs ; grep -q '^done:' .masterplan.yaml
- codex: heuristic
- spec_refs: spec.md §4.1, spec.md §7.1, spec.md §9, spec.md §11, spec.md §12

### Task 21: Route every remaining direct process.env read outside lib/config.mjs through its exported accessors, preserving behaviour and the injected-env test seams: CLAUDE_CONFIG_DIR and HOME in lib/paths.mjs; MP_ROUTING_POLICY in lib/dispatch/routing-policy.mjs and lib/doctor/routing-policy-health.mjs; MP_DISPATCH_WAVE_CONCURRENCY, MP_ROUTING_POLICY, and SKYNET_VERIFY_ALLOWLIST in lib/dispatch-wave.mjs; HOME in bin/doctor.mjs, lib/doctor/codex-auth.mjs, and lib/doctor/pi-agent-registration.mjs (its spawn uses the config-owned passthrough). The existing suites for these modules stay green; the repo-wide zero-process.env assertion belongs to config-knobs.inventory, this task asserts only its own files. lib/continue.mjs, lib/sweep.mjs, lib/runs.mjs, and bin/install-pi.mjs are converted by their owning tasks. As the owner of bin/doctor.mjs, also add the `--only=<check-id>` option the spec relies on (spec §7.1 checks and the G6 evidence use `node bin/doctor.mjs --only=<check-id>`): run exactly one discovered check by id, exit with that check's outcome, and exit 2 with the list of known ids for an unknown id; cover it in test/doctor.test.mjs. While in test/doctor.test.mjs, update the discovered-module count assertion (19 today) to derive from the modules on disk or to the new total, since the wave-0 doctor checks are auto-discovered.
- files: lib/paths.mjs, lib/dispatch/routing-policy.mjs, lib/dispatch-wave.mjs, lib/doctor/routing-policy-health.mjs, lib/doctor/codex-auth.mjs, lib/doctor/pi-agent-registration.mjs, bin/doctor.mjs, test/paths.test.mjs, test/routing-policy.test.mjs, test/dispatch-wave.test.mjs, test/doctor.test.mjs, lib/config.mjs
- verify: node --test test/paths.test.mjs ; node --test test/routing-policy.test.mjs ; node --test test/dispatch-wave.test.mjs ; node --test test/doctor.test.mjs ; test "$(grep -l "process\.env" lib/paths.mjs lib/dispatch/routing-policy.mjs lib/dispatch-wave.mjs lib/doctor/routing-policy-health.mjs lib/doctor/codex-auth.mjs lib/doctor/pi-agent-registration.mjs bin/doctor.mjs | wc -l)" = 0 && grep -q "readEnv" lib/paths.mjs lib/dispatch-wave.mjs bin/doctor.mjs
- codex: heuristic
- spec_refs: spec.md §4.4, spec.md §11, spec.md §12

### Task 24: Enforce deploy commit identity and release guards: open version_not_bumped before merge or PR retirement when the branch version is already tagged locally or on origin; require the branch tip in the deploy base; require --merged and --merge-sha for PRs; accept merge ancestry or a single squash with git patch-id --verbatim on git 2.39 or newer; and reject rebase merges, whitespace-different squashes, or unsupported git versions with explicit diagnostics. Audit every deploy boundary per commit, allowing single-parent docs/masterplan bundle commits and recorded stage-produced commits only within done.commit_paths, requiring ${version} to remain unchanged, and treating every other commit as a base move that invalidates old receipts. Refuse authorization when MAIN is dirty outside docs/masterplan.
- files: lib/finish.mjs, lib/finish-step.mjs, test/deploy-commit-identity.test.mjs
- verify: node --test test/deploy-commit-identity.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.1, spec.md §7.2, spec.md §7.3, spec.md §11

### Task 35: Extend the existing runs-list regression suite to prove enriched records expose untruncated multiline topics, phase, worktree path or null, parsed goal ids and text, and deterministic planned-path unions, including bundles where optional goals or plan artifacts are absent.
- files: test/runs-list.test.mjs
- verify: node --test test/runs-list.test.mjs
- codex: heuristic
- spec_refs: spec.md §8, spec.md §11

### Task 44: Implement the one-off scripts/bootstrap-v10.mjs driver with status, arm, record, and corrective-pass start subcommands; the fixed step enum and pass ordering; schema-validated bootstrap_armed/bootstrap_step writes through appendEvent; same-SHA authorization matching; failed/recovered semantics; command and digest binding; fixture-target overrides; per-step preconditions and postconditions; workspace-root bundle scanning; carried-main commit reporting; reviewed-to-tag identity checks; PR reconciliation data; and the gate's clean-tree, remote-tip equality, ancestry, branch-path, and per-commit bundle-only audits. Status must reconstruct pass, completed steps, failures, and the next action solely from disk after compaction.
integration note: orchestration-integration must invoke this script's arm → printed command → record loop as a serial pre-finish bootstrap stage and must not expose a permanent mp bootstrap CLI verb. Own test/bootstrap-driver.test.mjs: fixture-bundle smoke cases proving status reconstructs pass and next action from disk, arm refuses when a precondition fails without writing an event, record refuses without a matching arm at the same base SHA, and --targets overrides route every path to fixture locations. The smoke suite includes one precondition and one postcondition from each of the three step shapes (git-only, gh-network, filesystem-install) so the step abstraction is proven before the dependent suites build on it.
- files: scripts/bootstrap-v10.mjs, test/bootstrap-driver.test.mjs
- verify: node --check scripts/bootstrap-v10.mjs ; node --test test/bootstrap-driver.test.mjs
- codex: heuristic
- spec_refs: spec.md §10.1, spec.md §10.2, spec.md §10.3, spec.md §11, spec.md §12

## Wave 3

### Task 14: Extend the library-level goals-load and goal-check contracts. Accept only converged, exhausted, critic_off, or durable waived interview exits; reject open or reopened interviews; require every unknown, contradiction, and misclassified id listed by an exhausted terminal event to appear in the spec Assumptions table with assumed_row_missing on omissions; validate final assessor receipts against deploy_base_sha, deploy_chain_hash, live_check_digest, and the final intent_verdict while preserving the implementation-assessment and v1 receipt shapes. Add focused regression cases to the existing goals suite.
integration note: orchestration-integration CLI should pass the bundle replay and spec path into this goals-load validation and preserve the assumed_row_missing error code; finish wiring should supply the expected final receipt bindings rather than accepting caller-provided values unbound.
- files: lib/goals.mjs, test/goals.test.mjs
- verify: node --test test/goals.test.mjs
- codex: heuristic
- spec_refs: spec.md §5.4, spec.md §6.1, spec.md §6.2, spec.md §11

### Task 25: Implement event-keyed deploy recovery for every interruption point. Re-entry must preserve an authorization that has no started event, reject started without authorization, probe a started step's check before replay, require a new gated authorization before rerunning a previously started command, classify check exit 1 as absent and every other nonzero check result as indeterminate, and leave deploy abort resumable. Permit attestation only for an interrupted check-less step, record it as status attested, and prevent attestation from proving a checked step. Add real-writer replay cases for gated and loose authorization order and recovery after each deploy gate.
- files: lib/finish-step.mjs, test/finish-replay.test.mjs
- verify: node --test test/finish-replay.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.2, spec.md §7.3, spec.md §7.4, spec.md §11

### Task 45: Implement the v9-to-v10 rehearsal shell walk using the same bootstrap arm/record loop and fixture targets used by the live stage: copy and pin the installed 9.10.0 tree before any installation, route every rehearsed finish invocation through that copy, construct the bare remote and second-clone merge fixtures, exercise fixture Pi and Claude installations, preserve and audit bundle-only base commits, prove the non-empty v9 assessment/review diff and no-op finish merge, and clean up a real private throwaway GitHub repository after a gh pr create/merge cycle. The credentialed GitHub cycle is intentionally executed during the live rehearsal rather than routine CI, and its output digest becomes the rehearsal receipt. Own test/rehearse-v9-finish.test.mjs: with a gh shim on PATH and --targets fixture overrides, the walk pins the 9.10.0 copy before any install, routes every rehearsed finish through it, builds the bare remote and second clone, drives arm and record through the fixture driver, asserts the non-empty v9 diff and the no-op finish merge, audits the bundle-only base commits, and cleans up; the gh shim is stateful — it records every invocation and simulates repo create, pr create, pr merge, and repo delete — so the test asserts the full create/PR/merge/delete command sequence, the private-repository flag, cleanup after success, and cleanup after a simulated mid-cycle failure; real network execution is reserved for the live stage. The script also drives every §10.3 failure row (partial or mismatched push, red tag CI, install failure with the 9.10.0 rollback, PR reconciliation for MERGED/OPEN/other, rejected main push, unexpected or missing remote merge, dirty non-bundle state, sibling remote movement) through the same arm/record loop against fixture targets, and test/rehearse-v9-finish.test.mjs asserts each row's disposition. Co-owns scripts/bootstrap-v10.mjs so a driver defect the rehearsal exposes has a fix path.
- files: scripts/rehearse-v9-finish.sh, test/rehearse-v9-finish.test.mjs, scripts/bootstrap-v10.mjs
- verify: bash -n scripts/rehearse-v9-finish.sh ; test -x scripts/rehearse-v9-finish.sh ; grep -q 'bootstrap-v10.mjs' scripts/rehearse-v9-finish.sh && grep -q '9.10.0' scripts/rehearse-v9-finish.sh && grep -q 'gh pr create' scripts/rehearse-v9-finish.sh && grep -q 'gh pr merge --merge' scripts/rehearse-v9-finish.sh ; node --test test/rehearse-v9-finish.test.mjs
- codex: heuristic
- spec_refs: spec.md §10.1, spec.md §10.2, spec.md §10.3, spec.md §11, spec.md §12

## Wave 4

### Task 3: Wire bin/masterplan.mjs to the sibling subsystem APIs: resolve seed and config-show values and sources, persist warnings after the required second-position overlap_review event, enforce the overlap review and seed-lock sequence, expose interview and goals-load options, register overlap recording, enriched runs/status, context-status, resume-brief, and sweep behavior, forward all deploy/final-check/completion/archive finish flags, accept final goal-check receipts, and default plan commands from stored plan_path. Keep KNOWN_FLAGS and isKnownFlag authoritative, reject retired flags and any bootstrap verb, preserve the generic event verb, and route this file's environment reads through readEnv. Exact contracts: (a) `mp goals-load --interview-waived --reason` routes through the interview waiver operation, and goals-load receives the bundle replay and the spec path so the `assumed_row_missing` error code is raised exactly as the library emits it; (b) `mp config show` prints `harness.autoCompactWindow`, and the module exports the final `KNOWN_FLAGS` and `isKnownFlag`; (c) `mp seed --predecessor` projects the predecessor bundle's intent-rejection event (class and correction text) into the new bundle's seed record so the interview can open with it; (d) this task owns implementation-facing smoke cases in test/cli-surface.test.mjs and test/bin-masterplan.test.mjs: one accepted invocation per new verb and per new finish-step flag, one waiver-forwarding case, one final-receipt binding case, one config-show output case, and the stored plan-path default; the exhaustive behavioural matrix belongs to orchestration-integration.cli-contract. (e) `mp runs list` and `mp status` print the completion class (complete, incomplete:<reason>, merged, or legacy when the field is absent) and `pushed: no` until archive_pushed, and both call lib/resume-brief.mjs's obligation projection to print open required_successor obligations with the exact successor seed command; (f) `mp config show` reports `harness.autoCompactWindow` when the harness settings are readable, recommends a value no lower than the run's `context_watch.threshold`, and never writes harness settings. Also expose `mp interview replay` (the verbatim ledger from lib/interview.mjs). Interview flag surface, verbatim from spec §5.3: --id --round --kind --text --corrected --supersedes --resolves --file --receipt --payload-file --unavailable --error --reason --critic-unavailable-ack. The rejection interface is `--intent-rejected --class=<implementation|intent> --reason --successor=<slug>`; --successor is required and names the successor bundle that discharges the required_successor obligation. Smoke suite additions: the semantics of --deploy-retry versus --deploy-rerun and one gate-routing case per finish flag.
- files: bin/masterplan.mjs, test/cli-surface.test.mjs, test/bin-masterplan.test.mjs
- verify: node --test test/cli-surface.test.mjs ; node --test test/bin-masterplan.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.1, spec.md §4.3, spec.md §5.3, spec.md §5.4, spec.md §6.2, spec.md §7.2, spec.md §8, spec.md §9, spec.md §10, spec.md §11, spec.md §12

### Task 15: Update the goal assessor prompt with separate implementation and final assessment modes, per-goal evidence rules, the final met|partial|missed intent verdict, and receipt bindings to the deployed base, deploy chain, and live-check digest. Add explicit v1 compatibility behavior to both the goal assessor and adversarial reviewer so a goals document without an Intent block or a legacy single-dispatch request returns the v9 verdict shape without intent_verdict.
integration note: orchestration-integration's sequencer should invoke the implementation mode before disposition and the final mode after live checking, passing only the mode-appropriate evidence and binding tuple. Own test/agents-compat.test.mjs: parse both prompts and assert the separate implementation/final modes, the per-goal evidence rules, the final intent verdict and its binding fields, and the declared v1 mode; feed a v1 goals document through the compatibility path; validate a fixture legacy assessor result with the v9-compatible goal-check validator; and prove that no intent_verdict is required or emitted in v1 mode while final v2 receipts retain their stronger bindings.
- files: agents/mp-goal-assessor.md, agents/mp-adversarial-reviewer.md, test/agents-compat.test.mjs
- verify: grep -qi 'v1 mode' agents/mp-goal-assessor.md && grep -q 'intent_verdict' agents/mp-goal-assessor.md && grep -q 'deploy_base_sha' agents/mp-goal-assessor.md && grep -q 'deploy_chain_hash' agents/mp-goal-assessor.md && grep -q 'live_check_digest' agents/mp-goal-assessor.md ; grep -qi 'v1 mode' agents/mp-adversarial-reviewer.md ; node --test test/agents-compat.test.mjs
- codex: heuristic
- spec_refs: spec.md §6.2, spec.md §11, spec.md §12

### Task 26: Complete the finish replay suite against temporary real git repositories using the real bundle event writer. Cover fixed group order regardless of declaration order, user_only checks returning 0/1/other, sibling and same-repo bundle commits, foreign base moves and full run replay, stage-produced commits inside and outside commit_paths, dirty-tree refusal, mandatory-group skips, live-check retry-only behavior, done: none with an empty final chain, and a release rerun failing when moved code still names an already-tagged version.
- files: lib/finish-step.mjs, test/finish-replay.test.mjs
- verify: node --test test/finish-replay.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.1, spec.md §7.2, spec.md §7.3, spec.md §7.4, spec.md §11

### Task 46: Create the v9-to-v10 bootstrap suite foundation with isolated git, remote, installation, Claude-config, workspace-root, and gh-shim fixtures. Prove the exact step order, arm-before-record and same-base-SHA requirements, refusal of repeated or out-of-order steps, no event on failed arm preconditions, postcondition refusal, failed-record rules, recovered records, next-step blocking after failure, pass-2 startup at verify with the omitted steps enforced, target validation, and status reconstruction after simulated compaction. Assert that `gate` is the only step whose arm and record are permitted after finish begins, and that status reports the pass complete through surfaces_live before finish.
- files: test/v9-to-v10-bootstrap.test.mjs, scripts/bootstrap-v10.mjs
- verify: node --test test/v9-to-v10-bootstrap.test.mjs
- codex: heuristic
- spec_refs: spec.md §10.1, spec.md §10.3, spec.md §11

## Wave 5

### Task 4: Connect planning and resume consumers to persisted controls: use state.plan_path when fragment merge or planner work-item construction omits plan-md while preserving explicit paths, make resume-phase routing observe resolved planning_mode, prevent the bootstrap-stage marker from entering plan-wave dispatch, and move environment reads in these modules through readEnv. Add behavioural cases: an explicit --plan-md wins over state.plan_path, the stored path is used when the flag is omitted, resume-phase routing follows the resolved planning_mode, and the bootstrap-stage marker never enters plan-wave dispatch. Render the index meta narrative (purpose, problem, solution) in plan.md the way plan.html already does, so a post-wave stage stated in index.meta is visible in the canonical plan after every wave; the sequencer task owns the stage's execution protocol.
- files: lib/continue.mjs, lib/resume.mjs, lib/plan-merge.mjs, test/plan-merge.test.mjs, test/continue.test.mjs, test/resume.test.mjs
- verify: node --test test/plan-merge.test.mjs ; node --test test/continue.test.mjs ; node --test test/resume.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.2, spec.md §4.3, spec.md §10, spec.md §11, spec.md §12

### Task 5: Update wave summaries to read v2 goals and quote the Intent outcome line in the mid-run reminder, with a compatible fallback for v1 bundles that have no Intent block. Add wave-summary cases proving the v2 Intent outcome line is quoted verbatim and a v1 bundle without an Intent block falls back without error.
- files: lib/wave.mjs, test/wave.test.mjs
- verify: node --test test/wave.test.mjs ; node --test test/goals.test.mjs
- codex: heuristic
- spec_refs: spec.md §6.1, spec.md §6.2, spec.md §11, spec.md §12

### Task 27: Add the post-deploy final assessment transition after the required live check, binding run_final_check and its accepted receipt to deploy_base_sha, deploy_chain_hash, live_check_digest, and the final intent verdict. Re-audit commit identity before final assessment and intent confirmation, route partial or missed final verdicts through goals_unmet with waiver, abort, or reject-intent only, and emit intent_confirm only after a valid final receipt; for done: none, pass an empty chain and null live digest. integration note: consume the sibling-owned lib/goals.mjs final-receipt validator rather than duplicating it; that module must export validation for deploy_base_sha, deploy_chain_hash, live_check_digest, and intent_verdict, and orchestration-integration.cli must route mp record-goal-check --final receipts to the existing event writer.
- files: lib/finish-step.mjs, test/final-check.test.mjs, test/finish-step-goals.test.mjs
- verify: node --test test/final-check.test.mjs ; node --test test/finish-step-goals.test.mjs
- codex: heuristic
- spec_refs: spec.md §6.2, spec.md §7.2, spec.md §7.3, spec.md §11

### Task 47: Extend the bootstrap suite with the complete fixture-backed successful rollout: pre-publish verify/review/assessment receipts, release refusal before a version bump, CHANGELOG-only release commit and annotated-tag identity, idempotent release replay, branch/tag push and CI receipts, executable Pi check, workspace_roots discovery across multiple depths, carried non-bundle main commits, publish acknowledgement, PR merge ancestry, Claude-cache evidence, both-surface checks, per-commit state-only auditing, dirty-bundle commit before gate rebase, remote-tip equality, conflict-free rebase, no-op v9 merge, branch retirement, legacy archive, and fast-forward archive push.
- files: test/v9-to-v10-bootstrap.test.mjs, scripts/bootstrap-v10.mjs
- verify: node --test test/v9-to-v10-bootstrap.test.mjs
- codex: heuristic
- spec_refs: spec.md §10.1, spec.md §10.2, spec.md §11

## Wave 6

### Task 6: Expand the CLI surface regression suite to cover all newly registered verbs and finish-step flags, required overlap-review seed behavior, interview and final-receipt forwarding, config/context/resume commands, stored plan-path defaults, removal of retired flags, and the intentional absence of an mp bootstrap verb. Assert the config-show `harness.autoCompactWindow` field, the exported KNOWN_FLAGS/isKnownFlag surface, and the black-box successor case: a bundle seeded with --predecessor naming a predecessor whose finish recorded an intent-class rejection carries that correction text in its seed record. Also assert: an archived bundle with no completion field prints `legacy` in both runs list and status; both commands print an open required_successor obligation with the exact seed command; config show's recommendation is no lower than the configured threshold and the harness settings file is byte-identical after the call. Assert that runs list and status print `pushed: no` for an archived bundle until archive_pushed lands. This task co-owns bin/masterplan.mjs so a wiring defect its matrix exposes can be fixed in the same task.
- files: test/cli-surface.test.mjs, bin/masterplan.mjs
- verify: node --test test/cli-surface.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.1, spec.md §4.3, spec.md §5.3, spec.md §6.2, spec.md §7.2, spec.md §8, spec.md §9, spec.md §10, spec.md §11

### Task 28: Enforce durable archive authorization and completion classes. Write completion_confirmed only for an accepted intent confirmation bound to the latest deploy base; write incomplete_authorized transactionally for keep, discard, deploy skip, no-definition abort-incomplete, attested mandatory steps, and both intent-rejection classes; and refuse archive without the matching authorization. Archive a fully deployed and confirmed run as complete, done: none as merged, and all authorized shortfalls as incomplete:<reason>. Persist implementation-versus-intent rejection and correction text, keep rejected runs receipt-isolated from successors, and ensure keep/discard never enter deploy replay. Emit `required_successor {slug, reason}` for both intent-rejection classes, with slug taken from the required --successor flag (a rejection without it is refused before any event is written); the successor is seeded with --predecessor naming this run, and for class intent the stored correction text is what the successor's interview opens with.
- files: lib/finish-step.mjs, test/intent-rejected.test.mjs, test/finish-replay.test.mjs
- verify: node --test test/intent-rejected.test.mjs ; node --test test/finish-replay.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.2, spec.md §7.4, spec.md §7.5, spec.md §11

### Task 48: Complete the bootstrap suite with every recovery and refusal path from the bootstrap failure table: partial or mismatched push, red tag CI, Pi install failure and v9.10.0 rollback, PR reconciliation for MERGED/OPEN/other states, rejected main push, unexpected or missing remote merge, dirty non-bundle state, merge commits and change-then-revert audit failures, review rejection before tagging, release farther than one CHANGELOG-only commit from its reviewed SHA, branch changes under docs/masterplan at the gate, sibling remote movement with stop/acknowledged retarget/rebase behavior, foreign overlap refusal, and a corrective 10.0.x pass that re-runs verify/review/assessment before release, uses a second PR without a second local-main push, assesses G6 at the latest version, and records the operator-declined keep/legacy path. Also run the required-successor, incomplete-archive, and legacy-archive doctor checks against the bundles the rollout and recovery fixtures actually produce, so the doctor tasks' fixture-only coverage is confirmed against real writer output. Co-owns scripts/bootstrap-v10.mjs (as do the protocol and rollout suites) so a driver defect found here is fixable in the same task.
- files: test/v9-to-v10-bootstrap.test.mjs, scripts/bootstrap-v10.mjs
- verify: node --test test/v9-to-v10-bootstrap.test.mjs
- codex: heuristic
- spec_refs: spec.md §10.2, spec.md §10.3, spec.md §11

## Wave 7

### Task 29: Add the post-archive push_archive state. Emit it only when an install-group receipt proves that it pushed the base and identifies pushed_base; always halt for operator approval under gated and loose autonomy; list exactly pushed_base..HEAD; and accept archive_pushed as the sole post-archive event. Re-entry without that event must re-emit the gate, while no done block, done: none, or an install chain that did not push must stop without a push gate. Exercise exact fast-forward publication and the non-fast-forward recovery path of fetch, per-commit audit, rebase, one retry, then stop, while reporting pushed: no until archive_pushed lands. The producer of the trigger is finish-step itself: after each install-group step it fetches origin/<base> and records pushed_base on the receipt when the remote tip moved to that receipt's base_after; an install chain that never moved the remote records no pushed_base and never reaches push_archive. Test rows cover both. The producer runs on every install-group deploy_step receipt write, including the check-only recovery record, and test/finish-replay.test.mjs gets the row "push succeeded, crash before --deploy-step-done, recovery records pushed_base".
- files: lib/finish-step.mjs, test/finish-replay.test.mjs
- verify: node --test test/finish-replay.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.2, spec.md §7.3, spec.md §7.4, spec.md §11

## Wave 8

### Task 7: Replace the sequencer contract with the complete intent-to-completion flow: perform runs-list overlap review before every seed, drive bounded ledger-backed intent rounds and fresh-context critic dispatches using quoted bundle data, enforce named terminal states, consume intent during planning and assessment, and render the full deploy/final-assessment/intent-confirm/archive-push operation table and autonomy stop set. Add the post-wave bootstrap arm-command-record stage without making it a plan task or mp verb, emit measured or explicit-unknown context status at every gate with compact advice, and declare every prompt-only control with a knob marker. Exact dispatch contracts: mp-intent-critic receives exactly three quoted-data blocks (the verbatim goals.md topic anchor, the verbatim interview ledger (every question, answer, withdrawal, draft, and critic receipt in order) from `mp interview replay`, and the current intent draft) and its receipt is recorded through `mp interview critic`; mp-goal-assessor is invoked in `implementation` mode before disposition with the base..tip diff and verify output, and in `final` mode after the live check with the binding tuple {deploy_base_sha, deploy_chain_hash, live_check_digest}, recorded via `mp record-goal-check --final`; at interview start on a bundle seeded with --predecessor the predecessor's stored intent-correction text is presented as quoted context; the bootstrap-stage rows record `required_successor {slug: v10-validation, reason}` through the pinned v9 `mp event` before `mp finish` on this run. Cover the dispatch payloads, mode names, and binding fields in test/prompt-structure.test.mjs and every new op row in test/op-table-parity.test.mjs. test/prompt-structure.test.mjs asserts that the critic dispatch block carries question and answer text, not only the budget summary. Bootstrap-stage rows encode two preconditions: (a) `node scripts/bootstrap-v10.mjs status` reports the pass complete through `surfaces_live` before `mp finish` starts; (b) `arm --step=gate` and `record --step=gate` execute inside the branch_finish handling before `--choice=merge`, the gate step being the only bootstrap step permitted after finish begins.
- files: commands/masterplan.md, test/op-table-parity.test.mjs, test/prompt-structure.test.mjs
- verify: node --test test/op-table-parity.test.mjs ; node --test test/prompt-structure.test.mjs ; for t in 'overlap.review' 'mp interview status' 'mp interview replay' 'mp-intent-critic' 'run_deploy_step' 'deploy_indeterminate' 'run_final_check' 'intent_confirm' 'push_archive' 'bootstrap-v10.mjs' 'mp context-status' '<!-- knob:'; do grep -qF "$t" commands/masterplan.md || { echo "missing $t in commands/masterplan.md"; exit 1; }; done ; grep -Eq 'bootstrap-v10\.mjs.*arm' commands/masterplan.md
- codex: heuristic
- spec_refs: spec.md §4.2, spec.md §5.1, spec.md §5.3, spec.md §5.4, spec.md §6.2, spec.md §7.2, spec.md §7.3, spec.md §8, spec.md §9, spec.md §10, spec.md §11, spec.md §12

### Task 30: Update finish retro rendering to print complete, incomplete:<reason>, merged, or legacy from durable state and events, treating pre-v10 archives with no completion field as legacy rather than complete or invalid. Include the archive publication state so a local archive without archive_pushed is visibly pushed: no.
- files: lib/retro-goals.mjs, test/finish-step-goals.test.mjs, test/retro-goals.test.mjs
- verify: node --test test/finish-step-goals.test.mjs ; node --test test/retro-goals.test.mjs
- codex: heuristic
- spec_refs: spec.md §7.4, spec.md §11, spec.md §12

## Wave 9

### Task 8: Publish the integrated public contract across README, the masterplan skill, and the verb reference: document CLI > repo > user > default resolution, exact complexity/autonomy levels and aliases, overlap and interview verbs, done configuration and fixed deploy order, final intent confirmation, completion and push classes, context-status and resume-brief wiring, required successors, and the one-off v10 bootstrap boundary. Add an Environment section naming every readEnv-backed control, including MP_DISPATCH_WAVE_CONCURRENCY, MP_ROUTING_POLICY, SKYNET_VERIFY_ALLOWLIST, and MP_CONTEXT_WINDOW. The Environment section also names CLAUDE_CODE_SESSION_ID (Guard D session identity, with its --session/--host flag companions). Bump every version-bearing file to 10.0.0 together — .claude-plugin/plugin.json, .claude-plugin/marketplace.json (root version and plugins[0].version), .codex-plugin/plugin.json, package.json, and README.md's "Current release" line — so the publish-hygiene live test passes with 10.0.0 everywhere (spec §11 publish-hygiene). README.md's doctor module-inventory gains one row per new check (resume-brief-hook, no-definition-of-done, incomplete-archive, legacy-archive, required-successor) so test/doctor-readme.test.mjs E9 matches the auto-discovered modules again.
- files: README.md, skills/masterplan/SKILL.md, docs/verbs.md, test/docs-contract.test.mjs, .claude-plugin/plugin.json, .claude-plugin/marketplace.json, .codex-plugin/plugin.json, package.json, test/doctor-readme.test.mjs
- verify: for t in complexity autonomy planning_mode context_watch done:; do grep -q "$t" README.md || { echo "missing $t in README.md"; exit 1; }; done ; for t in complexity autonomy context-status resume-brief overlap; do grep -q "$t" skills/masterplan/SKILL.md || { echo "missing $t in skills/masterplan/SKILL.md"; exit 1; }; done ; for t in Environment MP_DISPATCH_WAVE_CONCURRENCY MP_ROUTING_POLICY SKYNET_VERIFY_ALLOWLIST MP_CONTEXT_WINDOW CLAUDE_CODE_SESSION_ID incomplete merged legacy required; do grep -q "$t" docs/verbs.md || { echo "missing $t in docs/verbs.md"; exit 1; }; done ; node --test test/docs-contract.test.mjs ; node --test test/publish-hygiene.test.mjs ; node --test test/doctor-readme.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.1, spec.md §4.2, spec.md §4.3, spec.md §4.4, spec.md §5.3, spec.md §7.1, spec.md §7.4, spec.md §8, spec.md §9, spec.md §10, spec.md §11, spec.md §12

### Task 9: Own test/overlap-sequencer.test.mjs, the black-box integration suite named by G1: seed refuses without --overlap-review; the overlap_review event is written second, after bundle_created; a review whose inventory_sha256 no longer matches the runs inventory is refused as overlap_review_stale; a refused seed leaves no bundle directory; the seed lock is held across validate-then-create so a concurrent seed observes it, and sweep breaks a dead-pid lock; resume after simulated compaction reconstructs the overlap outcome from events; and runs list exposes topic, goals, planned_paths, and worktree for the conflict view. Cover the full §8 matrix with durable-event assertions: an in-progress worktree/file conflict, a plan-level planned_paths intersection, an archived topic/goals candidate offered as --predecessor, no overlap (seed proceeds with the review recorded), the predecessor link recorded on the seed, the resume path recording the same review on the resumed bundle via mp record-overlap-review, abort (nothing seeded, nothing on disk), and gated versus loose behaviour (loose fires the ask only for in-progress or plan-level conflicts and records archived candidates silently). Co-owns bin/masterplan.mjs, lib/seed-lock.mjs, and lib/runs.mjs so a defect the suite exposes has a fix path in the same task.
- files: test/overlap-sequencer.test.mjs, bin/masterplan.mjs, lib/seed-lock.mjs, lib/runs.mjs
- verify: node --test test/overlap-sequencer.test.mjs
- codex: heuristic
- spec_refs: spec.md §8, spec.md §11, spec.md §12

### Task 19: Implement the knob contract registry and its single-variable fixture harness. Build both fixtures from one shared base, prove exactly one input differs, and require a consumer-side observable rather than seeded state. Register or add two-value behavioral contracts for every current non-metadata flag, config path, emitted state control, environment control, and prompt-only marker, including complexity caps, autonomy deploy asks, planning-mode phase selection, both `context_watch` outputs, and the documented environment controls. Permit rendered protocol lines only for prompt-only controls. Assert the guard rejects a read-but-ignored synthetic knob, a seeded-state-only synthetic knob, and a fixture pair that changes two inputs. Integration note: these tests consume the final CLI, interview, finish, context-status, resume-phase, and sequencer surfaces but do not edit their owning files. Register CLAUDE_CODE_SESSION_ID (and its --session/--host flag companions) with the owner-lock acquire/heartbeat observable rather than an exemption.
- files: test/knob-contract.test.mjs, test/fixtures/knobs/contracts.mjs
- verify: node --test test/knob-contract.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.2, spec.md §4.3, spec.md §4.4, spec.md §7.1, spec.md §9, spec.md §11

## Wave 10

### Task 20: Implement the generated knob inventory guard over exported CLI flags, all recognized config paths including nested paths, recursively emitted `buildSeedState` fields, every literal `readEnv` call site, and sequencer `<!-- knob: name -->` markers. Require each discovered control to resolve to a named behavioral contract or to one of the four closed metadata exemptions (`created_at`, `schema_version`, `slug`, `topic`), retain the lexical reader check as an early signal, and fail on unmapped additions. Reject every direct `process.env` token outside the `readEnv` implementation and test member access, destructuring, bracket access, aliasing, and `Object.entries` escape attempts. Verify contract names exist and add synthetic unmapped-control cases so the inventory cannot pass through stale metadata alone. Integration note: orchestration-integration.cli must export the final `KNOWN_FLAGS` and `isKnownFlag`, orchestration-integration.sequencer must provide the prompt-only markers, and source owners must remove inert controls or route their reads through `readEnv` before this guard can pass.
- files: test/knob-inventory.test.mjs
- verify: node --test test/knob-inventory.test.mjs ; node --test test/knob-contract.test.mjs
- codex: heuristic
- spec_refs: spec.md §4.3, spec.md §4.4, spec.md §11, spec.md §12

## Amendments

### 2026-09-03 — Task 7 verify tightened after plan gate panel 3 (should-fix): per-term AND loop over commands/masterplan.md replaces the grep alternation; the recorded gate review bound the previous bytes (hash 5fd620be)
Planning-time task amendment applied through mp amend-tasks / amend-plan.

### 2026-09-03 — Doctor --only=<check-id> option assigned to config-knobs.env-reads (owner of bin/doctor.mjs)
Planning-time task amendment applied through mp amend-tasks / amend-plan.

### 2026-09-03 — Version bump ownership moved from bootstrap-release.release-surface (wave 0) to orchestration-integration.docs (wave 9): the publish-hygiene live test requires every manifest and README to agree, so all version-bearing files bump to 10.0.0 together in the docs task
Planning-time task amendment applied through mp amend-tasks / amend-plan.

### 2026-09-03 — Wave-0 doctor regressions assigned: README doctor inventory rows (docs task, owns test/doctor-readme.test.mjs) and the discovered-module count in test/doctor.test.mjs (config-knobs.env-reads)
Planning-time task amendment applied through mp amend-tasks / amend-plan.

### 2026-09-03 — release-surface verify: the temp-clone 10.0.0 smoke command dropped (it presupposed the version bump that now lands in the docs task); test/release-script.test.mjs covers success, replay, foreign tag, unbumped files, dirty tree
Planning-time task amendment applied through mp amend-tasks / amend-plan.
