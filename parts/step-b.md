# Step B — Planning (B0..B3)

<!-- Loads on demand: sourced from commands/masterplan.md L1026-1371
     Spec: docs/masterplan/v5-lazy-phase-prompts/spec.md#L69
     Allocated size: ~40K (planning)
     Router loads this file when: user invokes /masterplan full, brainstorm, plan,
     or plan --from-spec=<path>; or when Step C determines no active plan exists
     and routing returns to kickoff.
     Step 0 (parts/step-0.md) must already have run before this loads. -->

---

## Step B — Kickoff (worktree decision → brainstorm → plan)

**Entry breadcrumb.** Emit on first line of this part, before the Step B0 worktree-decision logic (per Step 0 §Breadcrumb emission contract):

```
<masterplan-trace step=step-b0 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
/masterplan {verb} › Worktree setup  [{slug-if-known}]
```

Subsequent step entry breadcrumbs (step-b1, step-b2, step-b3) are emitted at the top of each respective section below. Each fires when the orchestrator transitions into that sub-step's first instruction.

### Step B0 — Worktree decision (do this BEFORE invoking brainstorming)

The run bundle will be committed inside whichever worktree you're in when brainstorming runs. Decide first. **Apply CD-2.**

**Constants:** `SCOPE_OVERLAP_THRESHOLD=0.6`

1. **Survey the current state.** Issue these as **one parallel Bash batch** (not sequential):
   - `git rev-parse --abbrev-ref HEAD` → current branch.
   - `git status --porcelain` → cleanliness. (Always live per CD-2; never cached.)
   - Worktree list — read from `git_state.worktrees` (Step 0 cache). If unavailable, run `git worktree list --porcelain` in the same batch.

   Then, for the per-worktree related-plan scan: when ≥ 2 non-current worktrees, dispatch parallel Haiku agents (`model: "haiku"`, one per worktree) each with brief starting `DISPATCH-SITE: Step B0 related-plan scan` + contract `related_scope_scan_v1` (algorithm in `commands/masterplan-contracts.md §Contract: related_scope_scan_v1`; return shape: `{contract_id, inputs_hash, processed_paths (≤ 20 items), violations (≤ 20 items), coverage: {expected, processed}, result: {worktree, branch, matching_slugs (≤ 10 items), matching_branch}}`). With 1 non-current worktree, do the glob+match inline. Verify `coverage.expected == coverage.processed`; if not, re-scan inline and append `contract_violation` event.

1b. **Scope-overlap fingerprint check.** Before the worktree-choice AskUserQuestion (step 3), compute overlap with existing bundles:

   a. **Compute new topic fingerprint.** Tokenize `topic + proposed_slug`: lowercase → strip punctuation → remove stopwords → apply suffix stemming (inline awk, no external deps). Result: `new_fingerprint: [token1, ...]`.

   b. **Load existing bundle fingerprints.** For each bundle in `docs/masterplan/*/state.yml` where `status != archived`:
      - Read `scope_fingerprint` field. If non-empty array, use it.
      - If empty/missing (v2 bundle), compute fingerprint inline from slug + spec.md H1 title (if file exists, read first H1) + `current_task` field. Persist the computed fingerprint on the bundle's next state write (piggyback via the lazy migration flag set in Wave 1).

   c. **Compute Jaccard similarity.** For each existing bundle: `|A ∩ B| / |A ∪ B|` (inline Bash/awk). Store as `(slug, similarity)` pairs, sort descending.

   d. **Threshold gate.** If max similarity ≥ `SCOPE_OVERLAP_THRESHOLD`, trigger the scope-overlap gate (step 1c below). Otherwise, record `scope_fingerprint: <new_fingerprint>` in the initial state.yml written in step 6 and proceed to step 2.

   **Edge case:** If there are no existing non-archived bundles in the repo, skip steps 1b–1c entirely and proceed directly to step 2 (worktree recommendation).

1c. **Scope-overlap gate (fires when max Jaccard ≥ `SCOPE_OVERLAP_THRESHOLD`).** Two-stage AskUserQuestion:

   **Stage 1 — Show top-3 matches** (or fewer if < 3 exist above threshold):

   ```
   AskUserQuestion(
     question="Topic '<new topic>' overlaps with existing bundles. Top-3 matches:",
     options=[
       "<slug-A> (sim=0.NN): <current_task or topic of A>",
       "<slug-B> (sim=0.NN): <current_task or topic of B>",
       "<slug-C> (sim=0.NN): <current_task or topic of C>",
       "None of these — proceed with new slug (acknowledge overlap)"
     ]
   )
   ```

   If user picks **"None of these"**: append `{"event":"scope_overlap_acknowledged","ts":"...","top_sim":<max_sim>,"new_slug":"<proposed>"}` to events.jsonl of the NEW bundle (written after step 6), set `scope_fingerprint` in initial state, and proceed to step 2.

   If user picks one of the matching slugs: proceed to Stage 2.

   **Stage 2 — Relation choice for the picked slug:**

   ```
   AskUserQuestion(
     question="How to relate '<new topic>' to '<picked-slug>'?",
     options=[
       "Resume <picked-slug> (Recommended) — load that bundle, route to Step C",
       "Create variant of <picked-slug> — new bundle with variant_of: <picked-slug> set",
       "Force new (acknowledge overlap) — new bundle with scope_overlap_acknowledged event"
     ]
   )
   ```

   - **"Resume <picked-slug> (Recommended)"**: load the picked bundle's state.yml, route to Step C. Do NOT create a new bundle.
   - **"Create variant of <picked-slug>"**: proceed to new bundle creation (step 6), set `variant_of: <picked-slug>` in initial state.yml. Append `{"event":"scope_overlap_variant_created","variant_of":"<picked-slug>"}`.
   - **"Force new (acknowledge overlap)"**: proceed to new bundle creation (step 6), set `scope_fingerprint` in initial state.yml. Append `{"event":"scope_overlap_force_new","acknowledged_sim":<max_sim>}`.

1d. **Slug-uniqueness pre-check (Guard B).** Before creating any bundle directory, run `bin/masterplan-state.sh check-slug-collision <slug>` where `<slug>` is the candidate slug from step 1a. Parse the returned JSON.

   - If `collisions` is empty: proceed to step 2 unchanged.
   - If `collisions` is non-empty: persist `pending_gate.id: guard_b_slug_collision` to `state.yml`, then surface `AskUserQuestion` with these options (assembled from the JSON — include worktree path, branch, and last_activity in the question text):

     ```
     question: "Slug `<slug>` is already in progress in <N> peer worktree(s): [list]. What now?"
     options:
       1. "Resume the peer session in `<path>` [branch: <b>, last activity: <t>]" (Recommended when N==1)
          → cd to that worktree silently (per parts/step-a.md:29 / D1); no second confirmation. Append {"event":"guard_b_peer_resumed","peer":"<path>"} to the peer bundle's events.jsonl.
       2. "Auto-suffix this slug to `<suggested_suffix>`"
          → Replace the candidate slug with <suggested_suffix>; continue to step 2. Append {"event":"guard_b_auto_suffixed","original":"<slug>","new":"<suggested_suffix>"} to the new bundle's events.jsonl (written at step 6).
       3. "Abort"
          → Clear pending_gate; append {"event":"guard_b_aborted"}; CLOSE-TURN.
       [4. "Peer worktree at `<path>` no longer exists — treat as orphaned, proceed with original slug"
          → Only rendered when at least one collision has stale: true (D2).
          → Ignore that collision; proceed to step 2 with original slug. Append {"event":"guard_b_orphan_peer_acknowledged","peer":"<path>"}. CD-2: do NOT invoke git worktree prune.]
     ```

   Per D6, this sub-step fires on the kickoff/full path (B0) but NOT on Step B0a (`plan --from-spec=<path>`), which cd's into an existing bundle by definition and bypasses B0 entirely.

2. **Compute a recommendation** using these heuristics, in order of strength:
   - **Use an existing worktree** if any non-current worktree has a branch name or in-progress slug that overlaps with the topic. Likely the same work is already underway.
   - **Create a new worktree** if any of these are true: current branch is `main`/`master`/`trunk`/`dev`/`develop`; current branch has uncommitted changes (`git status --porcelain` non-empty); another in-progress masterplan plan exists in the current worktree (one plan per branch).
   - **Stay in the current worktree** otherwise — already on a feature branch with a clean tree and no competing plan.

3. **Present the choice via `AskUserQuestion`** with options reflecting the recommendation. Always include:
   - "Stay in current worktree (`<branch>` at `<path>`)"
     - When `<branch>` is in `config.trunk_branches`, the option's description text gains a warning: `"(Note: superpowers:subagent-driven-development will refuse to start on this branch without explicit consent — choose Create new if you'll execute via subagents.)"` This surfaces the SDD constraint at the worktree-decision point rather than as a surprise at Step C. When `<branch>` is non-trunk, no warning.
   - One option per existing matching worktree, if any: "Use existing worktree (`<branch>` at `<path>`)"
   - "Create new worktree" (this invokes `superpowers:using-git-worktrees` to do it properly)
   - Mark the recommended option first with "(Recommended)" and a one-line reason in the description (e.g. "current branch is main — isolate this work").

4. **Act on the choice:**
   - Stay → proceed to Step B1 in cwd.
   - Use existing → `cd` into that worktree path, then proceed to Step B1.
   - Create new → Pre-empt `superpowers:using-git-worktrees`' directory prompt (it issues a free-text question that stalls compact sessions). Detect existing `.worktrees/`/`worktrees/` dirs and any CLAUDE.md `worktree.*director` preference; if neither, surface `AskUserQuestion("Where should the worktree live?", options=[Project-local .worktrees/ (Recommended) / Global ~/.config/superpowers/worktrees/<project>/ / Cancel])`. Invoke the skill with topic slug AND a brief pre-deciding the directory (`"Use directory <chosen> — do not ask."`). Then `cd` into the new worktree, proceed to Step B1.

5. Record the chosen worktree path and branch — they go into `state.yml` before Step B1.

6. **Create the run bundle immediately.** Derive `<slug>` from the topic (stable slug, no date prefix). Create `<config.runs_path>/<slug>/state.yml` and `events.jsonl` before invoking brainstorming. If the directory already exists: `AskUserQuestion(... options=["Resume existing run (Recommended)", "Use <slug>-v2", "Abort kickoff"])`. Initial state: `status: in-progress`, `phase: worktree_decided`, `current_task: ""`, `next_action: brainstorm spec`, `plan_kind: implementation`, `follow_ups: []`, `pending_gate: null`, `background: null`, `stop_reason: null`, `critical_error: null`, artifact paths under `docs/masterplan/<slug>/`, `legacy: {}`, and schema_v5.1 defaults (`schema_version: "5.1"`, `cached_compliance: {breadcrumb_ratio: null, summary_block_ratio: null, window_turns: null, last_audit_ts: null}`, `pending_retro_attempts: 0`, `retro_policy: {waived: false, reason: ""}`, `scope_fingerprint: []`, `supersedes/superseded_by/variant_of: ""`, `import_hydration: ""`, `import_contract: {contract_id: "", inputs_hash: "", processed_at: ""}`, `worktree_disposition: ""`, `worktree_last_reconciled: ""`). **Populate `scope_fingerprint`** from step 1b. If step 1c set a relation, populate `variant_of`. Override `worktree_disposition` (`kept_by_user` if `--keep-worktree` or config says so; else `active`) and set `worktree_last_reconciled: <now ISO>`. Append `{"type":"run_created","phase":"worktree_decided","progress_kind":"implementation_plan_created",...}`.

#### Step B0a — `plan --from-spec=<path>` worktree handling

When the verb is `plan --from-spec=<path>`, Step B0's worktree-decision flow is **skipped** — the spec's location is authoritative.

1. Resolve `<path>` to its containing git worktree via `git rev-parse --show-toplevel` from the spec's parent directory.
2. `cd` into that worktree before invoking Step B2.
3. Verify the worktree appears in `git_state.worktrees`. If not: `AskUserQuestion(..., options=["Refresh git_state and retry (Recommended)", "Abort"])`.
4. If spec is outside any git worktree: error `Spec at <path> is not inside a git worktree. Move it, or run /masterplan brainstorm <topic> to recreate.`
5. If the resolved worktree's branch is in `config.trunk_branches`: surface `AskUserQuestion` (Create a new worktree + copy spec (Recommended) / Continue on trunk anyway / Abort). "Create new worktree" → run B0 step 4's "Create new" flow, copy spec to new worktree's bundle path, commit (`masterplan: relocate spec for <slug> to feature worktree`), proceed to B2. "Continue" → append `note` event and proceed. "Abort" → CLOSE-TURN.

Then proceed to **Step B2**. Step B1 is skipped (spec already exists).

### Step B1 — Brainstorm

**Entry breadcrumb.** Emit on first line of this section:

```
<masterplan-trace step=step-b1 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
/masterplan {verb} › Brainstorm  [{slug}]
```

**Intent anchor (CRITICAL — prevents broad/audit-shaped prompts from turning into unconstrained feature ideation).** Before invoking `superpowers:brainstorming`, /masterplan owns a short repository-grounding pass. Brainstorming is still interactive, but it is briefed with durable intent, scope, and verification limits instead of receiving only the raw topic string.

1. Update `state.yml`: `phase: brainstorming`, `next_action: resolve brainstorm intent anchor`, `pending_gate: null`; append `brainstorm_started` to `events.jsonl`. **Emit before this state write:** `<masterplan-trace state-write field=phase from=<old-phase> to=brainstorming>`.

2. **Dispatch coordinator-brainstorm-anchor (v6.0.0+).** The orchestrator dispatches 1 Sonnet coordinator; the coordinator runs Haiku A (project-docs), Haiku B (run-state), and Haiku C (repo-sketch) in parallel internally. Do NOT inline-Read AGENTS.md, CLAUDE.md, WORKLOG.md, or recent state bundles — large logs blow parent context.

   ```
   DISPATCH-SITE: coordinator-brainstorm-anchor
   contract_id: "coordinator-brainstorm-anchor-v1"
   Tier: sonnet
   Goal: Run 3-Haiku anchor fan-out; return merged anchor JSON.
   Inputs: topic=<topic>, repo_root=<repo_root>, runs_path=<config.runs_path>
   Scope: read-only. Brief bodies for Haiku A/B/C: docs/internals/brainstorm-anchor.md §Haiku A/B/C.
   Constraints: CD-7 (read-only; do not write state).
   Return shape: {mode, repo_role, verification_ceiling, in_scope_paths, out_of_scope_repos, evidence, interview_depth, coordinator_version}
   ```

   **Haiku A — project-docs.** Reads AGENTS.md/CLAUDE.md/WORKLOG.md (limit 500/500/200). See `docs/internals/brainstorm-anchor.md §Haiku A` for full brief.
   **Haiku B — run-state.** Reads most-recent bundle state.yml/events.jsonl/spec.md (limit 300 each). See `docs/internals/brainstorm-anchor.md §Haiku B`.
   **Haiku C — repo-sketch.** Runs `rg --files <repo-root> | head -200`. See `docs/internals/brainstorm-anchor.md §Haiku C`.

   **Fallback** (coordinator returns malformed JSON or errors): log `{"event":"coordinator_fallback","site":"coordinator-brainstorm-anchor","reason":"<error>"}` and dispatch the 3 Haiku agents inline per `docs/internals/brainstorm-anchor.md §Haiku A/B/C` full briefs.

3. **Merge + classify + persist (orchestrator owns this).** Parse coordinator return as JSON. On malformed return (missing `mode`/`repo_role`/`verification_ceiling`): fall through to AUQ audit-mode gate with `pending_gate.id: brainstorm_anchor_audit_mode`. Do NOT silently default.

   **Merge rules, topic-derived mode fallback, validation gate, and YAML shape:** see `docs/internals/brainstorm-anchor.md §Merge Rules` and `parts/contracts/plan-annotations.md §brainstorm_anchor YAML Shape`.

**Anchor gates.** Persist `pending_gate` before each AUQ:
- Audit/review with ambiguous execution semantics → `pending_gate.id: brainstorm_anchor_audit_mode` → `AskUserQuestion("This looks like an audit/review. How should the spec behave?", options=["Fix-as-you-go audit (Recommended)", "Report-only audit", "Narrow deferred task", "Abort"])`.
- Cross-repo/sibling scope → `pending_gate.id: brainstorm_anchor_scope_boundary` → `AskUserQuestion("Topic crosses repo boundary. Scope?", options=["Stay in current repo (Recommended)", "Split sibling follow-up runs", "Abort and restate scope"])`.
- Deferred-task prompts: reuse prior plan/worklog evidence; keep task-scoped; gate only when verification ceiling or boundary is genuinely ambiguous.
- `unclear` prompts: gate only when wrong default is materially unsafe.

**Problem Interview Contract.** Every spec-creating kickoff MUST run an adaptive interview before approach selection. Derive `interview_depth` from `--complexity`, seriousness/blast radius, and `understanding_level` (`strong`/`partial`/`weak`). Persist in `brainstorm_anchor.interview_depth`.

Question count targets: `low` 2-6, `medium` 5-12, `high` 8-20 (upper end for critical/risky/auth/production/data-loss work). Cover: problem statement, affected user, desired outcome, success criteria, current workflow, scope boundaries, constraints, data/interfaces, risks, verification path, rollout path, remaining unknowns. Mark irrelevant areas `not-applicable`. Keep questions concrete per CD-9; batch tightly related choices, otherwise ask sequentially.

**Invoke brainstorming with the anchor.** **Emit before the Skill invocation:** `<masterplan-trace skill-invoke name=brainstorming args=topic="<short-topic-summary>">`.

Invoke `superpowers:brainstorming` with the topic plus a compact anchor brief (`mode`, `repo_role`, `yocto_ownership`, `in_scope_paths`, `out_of_scope_repos`, `evidence`, `verification_ceiling`, `interview_depth`, `gate_selection`). Always interactive. Brief MUST: include `Intent Anchor`/`Scope Boundary` section in spec; run Problem Interview Contract before approach selection; avoid broad feature-idea funnels unless `mode == feature-ideas`; forbid out-of-scope sibling repos unless gate selected split runs; carry `verification_ceiling` into spec; for Codex hosts, avoid native multi-select UI dependencies.

**Re-engagement gate (CRITICAL — fixes a class of bug where the orchestrator stops silently when brainstorming hits its "User reviews written spec" gate, leaving the session unable to continue after compaction).** **Emit on the first line of this gate's instructions, BEFORE the spec-existence check below:** `<masterplan-trace skill-return name=brainstorming expected-next-step=step-b1-re-engagement-gate>`.

After brainstorming returns control, verify state and drive the next step:

1. Check spec at `<config.runs_path>/<slug>/spec.md`. If upstream wrote to legacy path (`docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`), copy to bundle path and record under `legacy.spec`.
2. **Spec missing:** persist `pending_gate.id: brainstorm_missing`, surface `AskUserQuestion(... options=["Re-invoke with same topic", "Refine topic and re-invoke", "Abort kickoff"])`.
3. **No `Intent Anchor`/`Scope Boundary` section:** persist `pending_gate.id: brainstorm_anchor_missing`, surface `AskUserQuestion(... options=["Re-run with saved anchor (Recommended)", "Patch anchor now", "Abort"])`.
4. **Spec exists:** update `state.yml`: `phase: spec_gate`, `artifacts.spec: <path>`, `next_action: approve spec for planning`; append `spec_written`; consult `halt_mode`.
   **Adversarial review — spec gate (B2).** Before routing by `halt_mode`, run this block:
   1. **Enable check:** Resolve `config.adversarial_review` from merged config tiers (global `~/.masterplan.yaml` then repo `.masterplan.yaml`, last-writer wins). If `adversarial_review ∉ {both, spec}` OR `--no-adversarial-review` is set on this run → skip this block entirely (proceed to halt_mode routing below unchanged).
   2. **Availability probe (presence check only — not the dispatcher).** The review is dispatched by the `codex:codex-rescue` Agent subagent (step 3), NOT by shelling out to this script. Probe only to confirm Codex review infrastructure is installed, in order:
      - `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs`
      - `~/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs` (glob; pick highest semver if multiple)
      If neither path exists: append `{"event":"adversarial_review_skipped","gate":"spec_approval","reason":"companion_not_found","ts":"<now>"}` → skip to halt_mode routing unchanged. Never block the workflow over missing review infrastructure.
   3. **Run foreground review.** Append `{"event":"adversarial_review_started","gate":"spec_approval","ts":"<now>","artifact":"<slug>/spec.md"}`. **Dispatch the `codex:codex-rescue` subagent via the Agent tool** (`subagent_type: "codex:codex-rescue"`) — it is fully model-invocable; this is **NOT the /codex:adversarial-review slash command**, so never refuse citing `disable-model-invocation` and never punt to the user to type a slash command (see `parts/contracts/codex-review.md` §Dispatch mechanism). Use the brief at `parts/contracts/codex-review.md` §Dispatch brief template, setting `gate: "B2 spec"` and `artifact: "docs/masterplan/<slug>/spec.md"`. When `codex_host_suppressed == true`, route to `general-purpose` subagent at `model: sonnet`, foreground, per §Codex-host fallback (D20) in that contract; set `degraded_review: true` in the resulting `codex_review_returned` event.
   4. **Parse and emit.** Parse the review return per `parts/contracts/codex-review.md` §Parse algorithm. On JSON parse failure (D5, D21): preserve the first 2048 bytes of raw return in `raw_excerpt`, run the D23 regex fallback for verdict and findings count, and annotate inline with `(degraded-parse)`. Immediately emit the inline status block (D6 — before state write, before AUQ):
      ```
      ↳ codex review (B2 spec[, degraded-parse][, sonnet-fallback]): <VERDICT> — <N> findings
        • [<sev>] <file>:<line> — <issue>       (top-3 by severity)
        [+ N more in events.jsonl]
      ```
      On degraded-parse, append a second inline line: `raw excerpt: <first ~500 chars of raw_excerpt>`.
      Append `{"event":"codex_review_returned","gate":"spec_approval","verdict":"<v>","dimensions":[...],"findings":[...full list...],"summary":"<s>","raw_excerpt":"<≤2KB or null>","degraded_review":<bool>,"ts":"<now>"}`.
   5. **Gate routing override (aggressive-loose + pass only).** If `autonomy == aggressive-loose` AND `review_result == pass`: skip the spec_approval AUQ, append `{"event":"spec_approval_auto_accepted","reason":"adversarial_review_passed","ts":"<now>"}`, clear `pending_gate`, → proceed directly to Step B2. Do NOT fire the AUQ. This is the only path that suppresses the gate; every other combination proceeds to halt_mode routing below.
   — (end adversarial review block; fall through to halt_mode routing for all non-auto-close cases)

   - **`halt_mode == none`** (existing kickoff path, unchanged): <!-- Intentionally diverges from the L1360 plan_approval condition under loose autonomy: spec_approval still fires under `--autonomy=loose`, while plan_approval auto-approves. See CHANGELOG v4.2.0 for the rationale and doctor check #31 for the consistency audit. --> under `--autonomy != full`, persist `pending_gate` with `id: spec_approval`, then **emit** `<masterplan-trace gate=fire id=spec_approval auq-options=4>` and surface `AskUserQuestion("Spec written at <path>. Ready for writing-plans?", options=[Approve and run writing-plans (Recommended) / Open spec to review first then ping me / Request changes — describe what to change / Abort kickoff / (only when review_result==fail) View adversarial-review findings and decide — shows findings in option context; does not auto-approve])`. Under `--autonomy=full`: auto-approve, clear `pending_gate`, and proceed to Step B2 silently.
     Option routing (halt_mode == none):
     - "Approve and run writing-plans (Recommended)" → clear `pending_gate`, proceed to Step B2.
     - "Open spec to review first then ping me" → keep `pending_gate: spec_approval`, set `stop_reason: question`, → CLOSE-TURN. Next invocation re-fires this gate.
     - "Request changes — describe what to change" → **chat option**: user's notes contain requested changes. Acknowledge the changes; offer to re-invoke brainstorming with their changes as refinement context (reply inline — do not invoke the skill in this turn). Keep `pending_gate: spec_approval`, set `stop_reason: question`, → CLOSE-TURN. Do NOT proceed to B2.
     - "Abort kickoff" → clear `pending_gate`, append `kickoff_aborted`, set `stop_reason: question`, → CLOSE-TURN.
     - **Free-text Other** (response not matching any named option) → treat as "Request changes" — same handling as above. Per step-0.md free-text gate response rule.
   - **`halt_mode == post-brainstorm`** (new, fires when invoked via `/masterplan brainstorm <topic>`): persist `pending_gate` with `id: brainstorm_closeout`, set `stop_reason: question`, then **emit** `<masterplan-trace gate=fire id=brainstorm_closeout auq-options=4>` and surface `AskUserQuestion("Spec written at <path>. What next?", options=["Done — close out this run (Recommended)", "Continue to plan now — run B2+B3 as if /masterplan plan --from-spec=<path> (the B0 worktree decision from earlier this session still holds; B0a is not re-run)", "Open spec to review before deciding — then ping me", "Re-run brainstorming to refine"])`.
     - "Done" → clear `pending_gate`, leave `stop_reason: question`, set `phase: spec_gate`, append `gate_closed`, → CLOSE-TURN. The next bare `/masterplan` or Codex `Use masterplan` invocation resumes from `state.yml` even though no plan exists yet.
     - "Continue to plan now" → flip in-session `halt_mode` to `post-plan` and proceed to Step B2. The spec is reused.
     - "Open spec" → → CLOSE-TURN; user re-invokes whatever they want next.
     - "Re-run brainstorming to refine" → re-invoke `superpowers:brainstorming` against the same topic; the previous spec is overwritten.


### Step B2 — Plan

**Entry breadcrumb.** Emit on first line of this section:

```
<masterplan-trace step=step-b2 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
/masterplan {verb} › Plan  [{slug}]
```

**Dispatch guard.** If `halt_mode == post-brainstorm` *at this point*, skip Step B2 and Step B3 entirely — the B1 close-out gate already ended the turn. (B1's "Continue to plan now" option flips `halt_mode` to `post-plan` BEFORE control returns here, so the guard correctly does not fire on the flip case; B2+B3 run with their `post-plan` variants.)

After Step B1's gate confirms approval, update `state.yml` to `phase: planning`, clear `pending_gate`, append `planning_started`, then invoke `superpowers:writing-plans` against `<config.runs_path>/<slug>/spec.md`. **Emit before the state write:** `<masterplan-trace state-write field=phase from=<old-phase> to=planning>`. **Emit before the Skill invocation:** `<masterplan-trace skill-invoke name=writing-plans args=spec=<config.runs_path>/<slug>/spec.md>`. It should produce `<config.runs_path>/<slug>/plan.md`. If the upstream writing skill writes to a legacy path (`docs/superpowers/plans/YYYY-MM-DD-<slug>.md`), copy it into `<config.runs_path>/<slug>/plan.md`, record the old path under `legacy.plan`, and continue against the bundled plan. Brief plan-writing with **CD-1 + CD-6**, plus the full annotation brief at `parts/contracts/plan-annotations.md` (Codex, parallel-group, verify-pattern, skip-handoff, complexity-aware, plan-format markers).

**Re-engagement gate** (same silent-stop bug pattern as Step B1's gate — never end the turn silently waiting on a free-text question). **Emit on the first line of this gate's instructions, BEFORE the plan-existence check below:** `<masterplan-trace skill-return name=writing-plans expected-next-step=step-b2-re-engagement-gate>`.

After writing-plans returns:

1. Check whether the expected plan file exists at `<config.runs_path>/<slug>/plan.md`.
2. **If plan missing:** writing-plans was aborted or failed. Persist `pending_gate` with `id: plan_missing`, then surface `AskUserQuestion("writing-plans did not complete (no plan at <path>). Re-invoke against the existing spec / Edit the spec and re-invoke / Abort kickoff")`.
3. **If plan exists** (the normal case): update `state.yml`: `phase: plan_gate`, `artifacts.plan: <config.runs_path>/<slug>/plan.md`, `current_task` = first task from the plan, `next_action` = first step of that task; append `plan_written`; proceed to Step B3 silently. **Emit before the state write:** `<masterplan-trace state-write field=phase from=planning to=plan_gate>`. B3's existing AskUserQuestion handles the final plan-approval gate before Step C, so no separate B2 gate is needed in the success case.

### Step B3 — State update + approval

**Entry breadcrumb.** Emit on first line of this section:

```
<masterplan-trace step=step-b3 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
/masterplan {verb} › Plan-approval  [{slug}]
```

**Complexity kickoff prompt.** Fires once at kickoff (`/masterplan full <topic>`, `/masterplan plan <topic>`, `/masterplan brainstorm <topic>`) when:
- `--complexity` is NOT on this turn's CLI args, AND
- `complexity_source == default` (i.e., no config tier set it; built-in `medium` would be silently used).

Surface ONE `AskUserQuestion("What complexity for this project?", options=["medium — standard flow (Recommended)", "low — ~3-7 tasks, no eligibility cache", "high — codex review every task, retro required", "use config default"])` after B0 and BEFORE B1.

- `medium`/`low`/`high` → set `resolved_complexity`, `complexity_source = "flag"`, persist to `state.yml`.
- `use config default` → warn if built-in medium would apply.

Silenced when `--complexity` is on CLI or any config tier sets `complexity:`.

Update the existing `state.yml` created in Step B0 using the format in **Run bundle state format** below. **Populate every required field** (omitting any will fail doctor's schema check and break Step A's listing). Step B3 is not allowed to create state from scratch; if `state.yml` is missing here, that is a protocol violation and the run must halt with a recovery question.

**Codex native goal at plan-ready.** When `codex_host_suppressed == true` and the plan exists: call `get_goal`; if none, `create_goal` with `Complete Masterplan plan <slug>: <first task summary>` and persist `codex_goal`; if conflict, set `pending_gate.id: codex_goal_conflict`, `stop_reason: question`, and surface a structured gate before proceeding.

**Auto-compact nudge** (once per plan; respects `config.auto_compact.enabled`). If enabled and not yet nudged, emit before the close-out gate: `*(Recommended: pair this run with /loop {interval} /compact {focus})*`. Then flip `compact_loop_recommended: true` in `state.yml`.

**Adversarial review — plan gate (B3).** After appending `plan_written` and before the B3 close-out gate:

1. **Enable check:** If `adversarial_review ∉ {both, plan}` OR `--no-adversarial-review` set → skip this block; proceed to B3 close-out gate unchanged.
2. **Locate companion.** Same two-path discovery as B2 spec gate above. If neither exists: append `{"event":"adversarial_review_skipped","gate":"plan_approval","reason":"companion_not_found","ts":"<now>"}` → proceed to B3 close-out gate unchanged.
3. **Launch background review.** Append `{"event":"adversarial_review_started","gate":"plan_approval","ts":"<now>","artifact":"<slug>/plan.md"}`. Persist `pending_gate: {id: adversarial_review_plan_pending}` to `state.yml`. This dispatch is the companion's `adversarial-review` **shell subcommand**, run via Bash (it needs a background job) — it is **NOT the /codex:adversarial-review slash command**, so never refuse citing `disable-model-invocation` and never punt to the user to type a slash command (see `parts/contracts/codex-review.md` §Dispatch mechanism). Run and capture output:
   ```bash
   review_handle=$(node "<companion-path>" adversarial-review --scope working-tree --background "focus on docs/masterplan/<slug>/plan.md")
   log_file=$(echo "$review_handle" | jq -r '.logFile // empty')
   ```
   Persist `adversarial_review_plan_pending_job: {log_file: "<log_file>", started_at: "<now>"}` to `state.yml`. If `log_file` is empty (companion returned malformed output or jq unavailable): append `{"event":"adversarial_review_skipped","gate":"plan_approval","reason":"no_log_file_in_response","ts":"<now>"}` → proceed to B3 close-out gate unchanged.
4. **Close-turn with wakeup.** If `ScheduleWakeup` available: call `ScheduleWakeup(delaySeconds=120, prompt="/masterplan --resume=<state-path>", reason="Checking adversarial review result for <slug> plan gate")`. Set `stop_reason: scheduled_yield`, append `wakeup_scheduled` → CLOSE-TURN.
   If `ScheduleWakeup` unavailable: emit `<masterplan-trace gate=fire id=adversarial_review_plan_pending auq-options=2>` and surface `AskUserQuestion("Adversarial review running in background for <slug> plan gate.", options=["Poll now — check if review completed", "Resume later — run /masterplan when the review finishes"])`.
5. **On resume (wakeup or manual).** Read `log_file` from `state.adversarial_review_plan_pending_job.log_file`. Completion check: `test -s <log_file>` — file exists and is non-empty → review output landed. If NOT complete: re-schedule wakeup (same parameters) → CLOSE-TURN. If complete: read logFile contents (first 8192 chars) as `review_output`. Parse the review return per `parts/contracts/codex-review.md` §Parse algorithm. On JSON parse failure (D5, D21): preserve first 2048 bytes of raw return in `raw_excerpt`, apply D23 regex fallback for verdict and findings count, annotate inline with `(degraded-parse)`. Immediately emit inline status block (D6 — before clearing `pending_gate`, before AUQ):
   ```
   ↳ codex review (B3 plan[, degraded-parse][, sonnet-fallback]): <VERDICT> — <N> findings
     • [<sev>] <file>:<line> — <issue>       (top-3 by severity)
     [+ N more in events.jsonl]
   ```
   On degraded-parse, append a second inline line: `raw excerpt: <first ~500 chars of raw_excerpt>`.
   Append `{"event":"codex_review_returned","gate":"plan_approval","verdict":"<v>","dimensions":[...],"findings":[...],"summary":"<s>","raw_excerpt":"<≤2KB or null>","degraded_review":<bool>,"ts":"<now>"}`. Clear `pending_gate` and `adversarial_review_plan_pending_job`. Proceed to B3 close-out gate.
6. **B3 close-out gate override (aggressive-loose + pass only).** If `autonomy == aggressive-loose` AND `review_result == pass`: append `{"event":"plan_approval_auto_accepted","reason":"adversarial_review_passed","ts":"<now>"}`, proceed directly to Step C. When `review_result == fail` (any autonomy level): prepend findings summary to the halt_mode == none question text before surfacing the AUQ.

**Close-out gate.** Consult `halt_mode`:

- **`halt_mode == none`** (kickoff path): if `--autonomy == gated`, persist `pending_gate.id: plan_approval`, emit `<masterplan-trace gate=fire id=plan_approval auq-options=3>`, and surface `AskUserQuestion` (Start execution / Open plan to review / Cancel). If `--autonomy in {loose, full}`: auto-approve, append `plan_approval_auto_accepted`, proceed to Step C. (v4.2.0: loose now auto-approves; use `--autonomy=gated` for last-look. `spec_approval` still halts under loose.)

- **`halt_mode == post-plan`** (fires for `/masterplan plan <topic>`, `plan --from-spec`, or B1's "Continue to plan now" flip): persist `pending_gate.id: plan_closeout`, `stop_reason: question`, emit `<masterplan-trace gate=fire id=plan_closeout auq-options=4>`, surface `AskUserQuestion("Plan written at <path>. What next?", options=["Done — resume later with <manual-resume-command> (Recommended)", "Start execution now", "Open plan to review", "Discard plan + state file (spec kept)"])`. `<manual-resume-command>`: Claude Code uses `/masterplan execute <state-path>`; Codex uses `Use masterplan execute <state-path>`.
  - "Done" → clear `pending_gate`, leave `stop_reason: question`, → CLOSE-TURN. Next `/masterplan` resumes.
  - "Start execution now" → flip `halt_mode` to `none`, proceed to Step C.
  - "Open plan" → clear `pending_gate`, leave `stop_reason: question`, → CLOSE-TURN.
  - "Discard" → `git rm` plan + `state.yml`; commit (`masterplan: discard plan <slug>`); → CLOSE-TURN. Spec kept.

The state file's `autonomy`, `codex_routing`, `codex_review`, `loop_enabled` fields are populated from this run's flags per the post-plan flag-persistence rule in Step 0; they take effect on the eventual `execute` invocation.

---
