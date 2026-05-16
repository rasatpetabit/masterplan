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
```

Subsequent step entry breadcrumbs (step-b1, step-b2, step-b3) are emitted at the top of each respective section below. Each fires when the orchestrator transitions into that sub-step's first instruction.

### Step B0 — Worktree decision (do this BEFORE invoking brainstorming)

The run bundle will be committed inside whichever worktree you're in when brainstorming runs. Decide first. **Apply CD-2.**

**Constants:** `SCOPE_OVERLAP_THRESHOLD=0.6`

1. **Survey the current state.** Issue these as **one parallel Bash batch** (not sequential):
   - `git rev-parse --abbrev-ref HEAD` → current branch.
   - `git status --porcelain` → cleanliness. (Always live per CD-2; never cached.)
   - Worktree list — read from `git_state.worktrees` (Step 0 cache). If unavailable, run `git worktree list --porcelain` in the same batch.

   Then, for the per-worktree related-plan scan: when there are ≥ 2 non-current worktrees, dispatch parallel Haiku agents (pass `model: "haiku"` on each Agent call per §Agent dispatch contract; one per worktree). Each agent's bounded brief must begin with the DISPATCH-SITE tag `Step B0 related-plan scan` as its first line (per §Agent dispatch contract dispatch-site table), followed by a blank line, then the body:

   ```
   DISPATCH-SITE: Step B0 related-plan scan

   contract_id: "related_scope_scan_v1"
   Follow the algorithm defined in commands/masterplan-contracts.md §Contract: related_scope_scan_v1.
   Goal: Identify any in-progress plans in this worktree whose slug or branch name overlaps with the topic's salient words (case-insensitive substring).
   Inputs: <worktree-path> + topic words.
   Scope: read-only.
   Return shape: {contract_id: "related_scope_scan_v1", inputs_hash: "<sha256>", processed_paths: [list of state.yml paths], violations: [], coverage: {expected: N, processed: N}, result: {worktree, branch, matching_slugs: [], matching_branch: bool}}.
   ```

   With 1 non-current worktree, do the glob+match inline (no dispatch needed). After the Haiku(s) return, verify `coverage.expected == coverage.processed` for each; if not, re-scan the worktree inline (parent reads state.yml files directly) and append `{"event":"contract_violation","contract_id":"related_scope_scan_v1","delta":<delta>}` to events.jsonl.

1b. **Scope-overlap fingerprint check.** Before the worktree-choice AskUserQuestion (step 3), compute overlap with existing bundles:

   a. **Compute new topic fingerprint.** Tokenize `topic + proposed_slug` with: lowercase → strip punctuation `[.,;:!?'"()\[\]{}\\/]` → split on whitespace → remove stopwords (`{the,and,or,of,for,to,in,on,a,an,is,are,was,were,be,been,has,have,had,it,its,this,that,these,those}`) → apply stem function (trim common suffixes: `-ing`, `-ed`, `-s`, `-es`, `-er`, `-tion` via inline awk — no external dependencies). Result is `new_fingerprint: [token1, token2, ...]`.

   b. **Load existing bundle fingerprints.** For each bundle in `docs/masterplan/*/state.yml` where `status != archived`:
      - Read `scope_fingerprint` field. If non-empty array, use it.
      - If empty/missing (v2 bundle), compute fingerprint inline from slug + spec.md H1 title (if file exists, read first H1) + `current_task` field. Persist the computed fingerprint on the bundle's next state write (piggyback via the lazy migration flag set in Wave 1).

   c. **Compute Jaccard similarity.** For each existing bundle: `|A ∩ B| / |A ∪ B|` where A=new_fingerprint, B=existing fingerprint. Implement via inline Bash/awk — compute intersection count and union count from the two token arrays, then divide. Store as `(slug, similarity)` pairs. Sort descending.

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
   - Create new → **pre-empt the skill's directory prompt.** `superpowers:using-git-worktrees` will otherwise issue a free-text `(1. .worktrees/ / 2. ~/.config/superpowers/worktrees/<project>/) — Which would you prefer?` question if no `.worktrees/`/`worktrees/` dir exists and no CLAUDE.md preference is set. That free-text prompt can stall a session if it compacts before the user answers. Avoid this by asking via `AskUserQuestion` FIRST: detect existing `.worktrees/`/`worktrees/` dirs and any CLAUDE.md `worktree.*director` preference; if neither exists, surface `AskUserQuestion("Where should the worktree live?", options=[Project-local .worktrees/ (Recommended) / Global ~/.config/superpowers/worktrees/<project>/ / Cancel kickoff])`. Then invoke `superpowers:using-git-worktrees` with the topic slug AND a brief that pre-decides the directory: `"Use directory <chosen> — do not ask. Proceed to safety verification + creation."` After it completes, `cd` into the new worktree, then proceed to Step B1.

5. Record the chosen worktree path and branch — they go into `state.yml` before Step B1.

6. **Create the run bundle immediately.** Derive `<slug>` from the topic (stable slug, no date prefix; the date lives in `started`). Create `<config.runs_path>/<slug>/state.yml` and `<config.runs_path>/<slug>/events.jsonl` before invoking brainstorming. If the directory already exists, surface `AskUserQuestion("Run docs/masterplan/<slug>/ already exists. What now?", options=["Resume existing run (Recommended)", "Use <slug>-v2", "Abort kickoff"])`. Initial state: `status: in-progress`, `phase: worktree_decided`, `current_task: ""`, `next_action: brainstorm spec`, `plan_kind: implementation`, `follow_ups: []`, `pending_gate: null`, `background: null`, `stop_reason: null`, `critical_error: null`, artifact paths under `docs/masterplan/<slug>/`, and `legacy: {}`. Also include the schema_v3 defaults for all new bundles (v4.0.0+). **Populate `scope_fingerprint` with the `new_fingerprint` token list computed in step 1b** (overriding the schema default `[]`). If step 1c set a relation, populate `variant_of` accordingly — `supersedes` and `superseded_by` default to `""` unless explicitly set.

```yaml
schema_version: 3
pending_retro_attempts: 0
retro_policy:
  waived: false
  reason: ""
scope_fingerprint: []
supersedes: ""
superseded_by: ""
variant_of: ""
import_hydration: ""
import_contract:
  contract_id: ""
  inputs_hash: ""
  processed_at: ""
worktree_disposition: ""
worktree_last_reconciled: ""
```

**After writing the initial state, override `worktree_disposition` and `worktree_last_reconciled`** (the schema_v3 defaults above write `""` as sentinels; step 6 always computes and persists the real values):

- If `--keep-worktree` flag is set → `worktree_disposition: kept_by_user`.
- Else if `config.worktree.default_disposition == "kept_by_user"` → `worktree_disposition: kept_by_user`.
- Else → `worktree_disposition: active`.

Also set `worktree_last_reconciled: <now ISO>`.

Append an event: `{"type":"run_created","phase":"worktree_decided","progress_kind":"implementation_plan_created",...}`.

#### Step B0a — `plan --from-spec=<path>` worktree handling

When the verb is `plan --from-spec=<path>` (directly, or via Step A's spec-without-plan variant's pick), Step B0's worktree-decision flow is **skipped** — the spec's location is authoritative. Run this short flow instead:

1. Resolve `<path>` to its containing git worktree via `git rev-parse --show-toplevel` from the spec's parent directory.
2. `cd` into that worktree before invoking `superpowers:writing-plans` (Step B2).
3. Verify the worktree appears in `git_state.worktrees` (Step 0 cache). If it doesn't, surface `AskUserQuestion("Worktree at <resolved-path> not in git_state cache. What now?", options=["Refresh git_state and retry (Recommended)", "Abort"])`.
4. If the spec is outside any git worktree (resolution fails), error with: `Spec at <path> is not inside a git worktree. Move it under a worktree, or run /masterplan brainstorm <topic> to recreate.`
5. If the resolved worktree's current branch is in `config.trunk_branches`, surface `AskUserQuestion("Spec lives on \`<branch>\` (a trunk branch). superpowers:subagent-driven-development will refuse to start on this branch at execute time. What now?", options=["Create a new worktree for the plan and copy the spec into it (Recommended)", "Continue on \`<branch>\` anyway — I'll handle SDD's refusal manually later", "Abort"])`.
   - "Create a new worktree" → run the same flow as B0 step 4's "Create new" branch (with the directory pre-decided per the existing AskUserQuestion + `superpowers:using-git-worktrees` pattern), then copy or `git mv` the spec into the new worktree's `<config.runs_path>/<slug>/spec.md`, update `state.yml`, commit (`masterplan: relocate spec for <slug> to feature worktree`), then proceed to Step B2 in the new worktree.
   - "Continue" → proceed to Step B2 on the trunk branch; append a `note` event to `events.jsonl` so the future `execute` invocation surfaces the SDD refusal up front.
   - "Abort" → → CLOSE-TURN.

Then proceed to **Step B2** (writing-plans). Step B1 is skipped because the spec already exists.

### Step B1 — Brainstorm

**Entry breadcrumb.** Emit on first line of this section:

```
<masterplan-trace step=step-b1 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
```

**Intent anchor (CRITICAL — prevents broad/audit-shaped prompts from turning into unconstrained feature ideation).** Before invoking `superpowers:brainstorming`, /masterplan owns a short repository-grounding pass. Brainstorming is still interactive, but it is briefed with durable intent, scope, and verification limits instead of receiving only the raw topic string.

1. Update `state.yml`: `phase: brainstorming`, `next_action: resolve brainstorm intent anchor`, `pending_gate: null`; append `brainstorm_started` to `events.jsonl`. **Emit before this state write:** `<masterplan-trace state-write field=phase from=<old-phase> to=brainstorming>`.

2. **Dispatch the intent-anchor read pass to three Haiku subagents in parallel (v5.4.0+ fan-out).** The orchestrator MUST NOT inline-Read AGENTS.md, CLAUDE.md, WORKLOG.md, or recent state bundles at this step — large logs (observed: 81KB / 861-line WORKLOG.md) blow the Opus parent context before any real work has started. Pre-v5.4.0 used a single Haiku reading all 7 source files serially. v5.4.0+ splits the work into three Haikus dispatched in ONE assistant message (Agent tool, all three blocks in the same turn), each with `subagent_type: "general-purpose"` (or `"Explore"` if available in the host) and `model: "haiku"`. Each Haiku reads ONLY its assigned file class and returns extracted *facts and hints* (not a fully-classified anchor). The orchestrator merges the three returns, performs the final classification, and persists the result.

   **Why partition this way.** Each file class has a different signal density and a different "natural" extraction. Project docs (AGENTS.md/CLAUDE.md/WORKLOG.md) carry repo role, scope, and ownership. Run state (state.yml/events.jsonl/spec.md) carries mode-defining signals (`execution-resume` / `deferred-task`) and the most recent verification ceiling. The repo sketch (rg --files) ground-truths the repo role and adds file-class evidence. Splitting cleanly avoids cross-source merge ambiguity that a 5- or 7-way split would introduce.

   **Haiku A — project-docs.** Bounded brief:

   > **Goal.** Extract project-doc facts and hints for the brainstorm anchor. Return JSON ONLY.
   >
   > **Read source (each Read tool call MUST pass `limit`).**
   > - `<repo-root>/AGENTS.md` — limit 500
   > - `<repo-root>/CLAUDE.md` — limit 500
   > - `<repo-root>/WORKLOG.md` — limit 200 (newest-at-top convention)
   >
   > **Constraints.** Read-only. Do NOT paste file content. If a file's tail beyond the cap is needed, note it in `notes`.
   >
   > **Return shape (JSON only).**
   > ```json
   > {
   >   "source_class": "project-docs",
   >   "facts": ["AGENTS.md: ...", "CLAUDE.md: ...", "WORKLOG.md: ..."],
   >   "extracted": {
   >     "repo_role_hint": "<short string or null>",
   >     "yocto_ownership_hint": "<distro/image policy|BSP/machine|app recipes|kas composition|builder orchestration|cross-repo|null>",
   >     "in_scope_paths_hint": ["..."],
   >     "out_of_scope_repos_hint": ["..."],
   >     "verification_ceiling_hint": "<local-static|repo-local-tests|requires-build-host|requires-runtime|requires-external-service|null>",
   >     "mode_hint": "<feature-ideas|implementation-design|audit-review|deferred-task|execution-resume|unclear|null>"
   >   },
   >   "notes": "<optional short string>"
   > }
   > ```

   **Haiku B — run-state.** Bounded brief:

   > **Goal.** Extract run-state facts and hints from the most recent run bundle. Return JSON ONLY.
   >
   > **Inputs (provided by orchestrator).** Topic string, `requested_verb`, repo root path, `config.runs_path`, slug of the most-recent bundle (orchestrator pre-resolves via `ls -t <config.runs_path>/*/state.yml | head -1`).
   >
   > **Read source (each Read tool call MUST pass `limit`).**
   > - `<config.runs_path>/<slug>/state.yml` — limit 300
   > - `<config.runs_path>/<slug>/events.jsonl` — limit 300
   > - `<config.runs_path>/<slug>/spec.md` — limit 300
   >
   > **Constraints.** Read-only. If no recent bundle exists (`<slug>` is null), return an empty `facts` array and all hints as null with `notes: "no recent bundle"`.
   >
   > **Return shape (JSON only).** Same shape as Haiku A's return but `source_class: "run-state"`. The `mode_hint` field is the highest-signal output of this Haiku — set to `execution-resume` if the bundle shows in-progress phase and no completed retro; `deferred-task` if events.jsonl shows skipped/deferred entries matching the topic; otherwise null.

   **Haiku C — repo-sketch.** Bounded brief:

   > **Goal.** Extract repo-structure facts from `rg --files`. Return JSON ONLY.
   >
   > **Inputs (provided by orchestrator).** Repo root path.
   >
   > **Read source.** `rg --files <repo-root>` piped through `head -200`; exclude `node_modules/`, `vendor/`, `.git/`, `legacy/.archive/`, `<config.runs_path>`, `<config.specs_path>`, `<config.plans_path>`.
   >
   > **Constraints.** Read-only. The rg output IS the read; do NOT Read individual files.
   >
   > **Return shape (JSON only).** Same shape as Haiku A's return but `source_class: "repo-sketch"`. Only `repo_role_hint` and (when file structure makes it derivable) `verification_ceiling_hint` are expected non-null; everything else can be null.

3. **Merge + classify + persist (orchestrator owns this).** Parse all three Haiku returns as JSON. If any return is malformed or missing the required `source_class` / `extracted` / `facts` fields, fall through to the `AskUserQuestion` audit-mode gate (below) with `pending_gate.id: brainstorm_anchor_audit_mode` and `notes_for_orchestrator: "haiku <A|B|C> return malformed"`. Do NOT silently default.

   **Merge rules** (field-by-field; first-non-null wins per the precedence below):
   - `repo_role` ← `A.extracted.repo_role_hint` || `C.extracted.repo_role_hint` || `B.extracted.repo_role_hint`. (Project docs are most specific; sketch ground-truths; run-state has it only when spec.md happened to record it.)
   - `yocto_ownership` ← `A.extracted.yocto_ownership_hint`. (Project docs only — neither state nor sketch carry this.)
   - `in_scope_paths` ← union of `A.extracted.in_scope_paths_hint` and `B.extracted.in_scope_paths_hint` (dedupe; preserve A's ordering).
   - `out_of_scope_repos` ← union of `A.extracted.out_of_scope_repos_hint` and `B.extracted.out_of_scope_repos_hint` (dedupe; preserve A's ordering).
   - `verification_ceiling` ← the *most restrictive* of the three hints, using the order `local-static < repo-local-tests < requires-build-host < requires-runtime < requires-external-service`. Null hints are ignored. If all three are null → fall through to AUQ gate (cannot guess ceiling).
   - `mode` ← `B.extracted.mode_hint` (highest signal — recent run state) || `A.extracted.mode_hint` || orchestrator-derives from topic string per the rules below.
   - `plan_kind` ← derived from final `mode`: `audit-review -> audit`, `execution-resume -> implementation`, `deferred-task -> implementation`, all others default to `implementation`. (When the requested verb is `doctor`, `import`, `status`, `clean`, or `retro`, the orchestrator overrides this downstream — leave the mode-derived value here.)
   - `evidence` ← concat of `A.facts` + `B.facts` + `C.facts` (preserve order; dedupe by exact-match string). If the merged list has > 8 entries, the orchestrator may keep the first 8 (chosen for source diversity: at least one from each Haiku when available).

   **Topic-derived mode fallback** (when B and A both return `mode_hint: null`): apply the existing single-Haiku classification rules verbatim against the topic string alone — `feature-ideas` for "new ideas/options/funnel" requests, `implementation-design` for "buildable design", `audit-review` for "reevaluate/review/inspect/audit/simplify/find problems", `deferred-task` for topics naming a task/phase/TODO/skipped/error/worklog entry, `execution-resume` for "continue planned work". If still ambiguous → `mode: "unclear"`.

   **Validation gate.** If merged `mode == "unclear"` OR any required field (`repo_role`, `evidence`, `verification_ceiling`) is empty/null → fall through to the existing `AskUserQuestion` audit-mode gate (below) with `pending_gate.id: brainstorm_anchor_audit_mode`. Do NOT silently default to `implementation-design`.

   **Persist.** On successful merge, persist the resulting anchor verbatim under `brainstorm_anchor:` in `state.yml` and append `brainstorm_anchor_resolved` to `events.jsonl` before any spec-writing call. The orchestrator is the canonical writer per CD-7; Haiku subagents never write state.

   Minimum shape:

```yaml
brainstorm_anchor:
  mode: audit-review
  repo_role: yocto-distro-policy-layer
  yocto_ownership: distro/image policy
  in_scope_paths:
    - conf/distro/
    - recipes-*/images/
  out_of_scope_repos:
    - meta-petabit-bsp
    - meta-petabit-apps
  evidence:
    - "AGENTS.md: current repo owns distro and image policy"
  verification_ceiling: requires-build-host
  gate_selection: null
  interview_depth:
    complexity: high
    seriousness: serious
    understanding_level: partial
    target_question_count: "12-20"
```

**Anchor gates.** Fire only when the anchor prevents likely drift, and always persist `pending_gate` before surfacing `AskUserQuestion`:

- Audit/review prompts with ambiguous execution semantics (for example "reevaluate Yocto configuration") persist `pending_gate.id: brainstorm_anchor_audit_mode`, then surface `AskUserQuestion("This looks like an audit/review. How should the spec behave?", options=["Fix-as-you-go audit (Recommended) — identify problems and implement safe repo-local fixes as they are found", "Report-only audit — write findings and recommendations, no code edits", "Narrow deferred task — use prior plan/worklog evidence and stay task-scoped", "Abort"])`.
- Cross-repo or sibling-owned scope persists `pending_gate.id: brainstorm_anchor_scope_boundary`, then surface `AskUserQuestion("The topic crosses this repo's ownership boundary. What scope should this run use?", options=["Stay in current repo (Recommended) — plan only in-scope paths and record sibling follow-ups", "Split sibling follow-up runs — create separate masterplan runs for each repo boundary", "Abort and restate scope"])`.
- Deferred-task prompts do not ask broad feature-idea questions. Reuse prior plan/worklog evidence, keep the spec task-scoped, and only gate if the task's verification ceiling or repo boundary is genuinely ambiguous.
- `unclear` prompts gate only when a wrong default would be materially unsafe. Prefer one foundational `AskUserQuestion` with concrete options over exploratory prose.

**Problem Interview Contract.** Every spec-creating kickoff (`brainstorm`, `plan`, and `full`) MUST run an adaptive interview before approach selection, design approval, or spec writing. Derive `interview_depth` from the resolved `--complexity` value, the seriousness/blast radius of the issue, and `understanding_level` after the cheap local truth pass (`strong`, `partial`, or `weak`). Persist the chosen values in `brainstorm_anchor.interview_depth`, including `target_question_count`.

- Baseline question counts: `low` asks 2-4 questions when well understood and 4-6 when serious or unclear; `medium` asks 5-8 normally and 8-12 when serious or poorly understood; `high` asks 8-12 normally and 12-20 for critical, risky, cross-system, auth/security, production, data-loss, or poorly understood work.
- Adjust within the range: decrease only when repo evidence already answers the topic; increase when the issue has user-visible impact, security/auth scope, production state, persistent data, external services, hardware/runtime dependency, or unclear ownership.
- Cover these areas before approaches: problem statement, affected user/audience, desired outcome, success criteria, current workflow, scope boundaries, constraints, data/interfaces, risks and failure modes, verification path, rollout/acceptance path, and remaining unknowns. Mark genuinely irrelevant areas `not-applicable` in the brief/spec rather than silently skipping them.
- Keep questions structured and concrete per CD-9. Batch only tightly related choices; otherwise ask sequentially so the next question can use the user's previous answer.

**Invoke brainstorming with the anchor.** **Emit before the Skill invocation:** `<masterplan-trace skill-invoke name=brainstorming args=topic="<short-topic-summary>">`.

Invoke `superpowers:brainstorming` with the original topic plus a compact anchor brief containing `mode`, `repo_role`, `yocto_ownership` when present, `in_scope_paths`, `out_of_scope_repos`, `evidence`, `verification_ceiling`, `interview_depth`, and any `gate_selection`. **Brainstorming is always interactive** — the `--autonomy` flag does not apply. The brief MUST instruct the skill to:

- Include a short `Intent Anchor` / `Scope Boundary` section in `<config.runs_path>/<slug>/spec.md`.
- Complete the Problem Interview Contract before proposing approaches or writing the spec.
- Avoid broad feature-idea funnels unless `brainstorm_anchor.mode == feature-ideas`.
- Forbid out-of-scope sibling repo implementation unless the anchor gate selected split follow-up runs.
- Carry the `verification_ceiling` into the spec so execution does not promise unavailable proof.
- For Codex hosts, avoid designs that depend on native multi-select UI or arbitrary free-form ID entry; offer concrete structured gates instead.

**Re-engagement gate (CRITICAL — fixes a class of bug where the orchestrator stops silently when brainstorming hits its "User reviews written spec" gate, leaving the session unable to continue after compaction).** **Emit on the first line of this gate's instructions, BEFORE the spec-existence check below:** `<masterplan-trace skill-return name=brainstorming expected-next-step=step-b1-re-engagement-gate>`.

After brainstorming returns control to /masterplan, the orchestrator MUST verify state and explicitly drive the next step — never end the turn waiting on the user's free-text response from brainstorming's gate:

1. Check whether the expected spec file exists at `<config.runs_path>/<slug>/spec.md`. If the upstream brainstorming skill writes to a legacy path (`docs/superpowers/specs/YYYY-MM-DD-<slug>-design.md`), copy it into `<config.runs_path>/<slug>/spec.md`, record the old path under `legacy.spec`, and continue against the bundled spec.
2. **If spec missing:** brainstorming was aborted or failed. Persist `pending_gate` with `id: brainstorm_missing`, `phase: brainstorming`, the exact options below, then surface `AskUserQuestion("Brainstorming did not complete (no spec at <path>). Re-invoke brainstorming with the same topic / Refine the topic and re-invoke / Abort kickoff")`.
3. Check that the spec contains an `Intent Anchor` or `Scope Boundary` section. If missing, update `state.yml`: `pending_gate.id: brainstorm_anchor_missing`, `phase: brainstorming`, then surface `AskUserQuestion("Spec is missing the brainstorm intent anchor. What now?", options=["Re-run brainstorming with the saved anchor (Recommended)", "Patch the spec anchor now", "Abort kickoff"])`.
4. **If spec exists** (the normal case): update `state.yml`: `phase: spec_gate`, `artifacts.spec: <config.runs_path>/<slug>/spec.md`, `next_action: approve spec for planning`; append `spec_written` to `events.jsonl`, then consult `halt_mode`.
   - **`halt_mode == none`** (existing kickoff path, unchanged): <!-- Intentionally diverges from the L1360 plan_approval condition under loose autonomy: spec_approval still fires under `--autonomy=loose`, while plan_approval auto-approves. See CHANGELOG v4.2.0 for the rationale and doctor check #31 for the consistency audit. --> under `--autonomy != full`, persist `pending_gate` with `id: spec_approval`, then **emit** `<masterplan-trace gate=fire id=spec_approval auq-options=4>` and surface `AskUserQuestion("Spec written at <path>. Ready for writing-plans?", options=[Approve and run writing-plans (Recommended) / Open spec to review first then ping me / Request changes — describe what to change / Abort kickoff])`. Under `--autonomy=full`: auto-approve, clear `pending_gate`, and proceed to Step B2 silently.
   - **`halt_mode == post-brainstorm`** (new, fires when invoked via `/masterplan brainstorm <topic>`): persist `pending_gate` with `id: brainstorm_closeout`, set `stop_reason: question`, then **emit** `<masterplan-trace gate=fire id=brainstorm_closeout auq-options=4>` and surface `AskUserQuestion("Spec written at <path>. What next?", options=["Done — close out this run (Recommended)", "Continue to plan now — run B2+B3 as if /masterplan plan --from-spec=<path> (the B0 worktree decision from earlier this session still holds; B0a is not re-run)", "Open spec to review before deciding — then ping me", "Re-run brainstorming to refine"])`.
     - "Done" → clear `pending_gate`, leave `stop_reason: question`, set `phase: spec_gate`, append `gate_closed`, → CLOSE-TURN. The next bare `/masterplan` or Codex `Use masterplan` invocation resumes from `state.yml` even though no plan exists yet.
     - "Continue to plan now" → flip in-session `halt_mode` to `post-plan` and proceed to Step B2. The spec is reused.
     - "Open spec" → → CLOSE-TURN; user re-invokes whatever they want next.
     - "Re-run brainstorming to refine" → re-invoke `superpowers:brainstorming` against the same topic; the previous spec is overwritten.

**Why this gate exists:** brainstorming's own "User reviews written spec" step ends with "Wait for the user's response" — open-ended prose that causes the session to stop. When the user comes back in a fresh turn (especially after a recap/compact), the brainstorming skill body may not be in active context, and the orchestrator has no breadcrumb telling it what to do. The re-engagement gate above is the orchestrator owning the transition explicitly so a session compact between turns doesn't lose the workflow. This pattern repeats in Step B2 for the same reason.

### Step B2 — Plan

**Entry breadcrumb.** Emit on first line of this section:

```
<masterplan-trace step=step-b2 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
```

**Dispatch guard.** If `halt_mode == post-brainstorm` *at this point*, skip Step B2 and Step B3 entirely — the B1 close-out gate already ended the turn. (B1's "Continue to plan now" option flips `halt_mode` to `post-plan` BEFORE control returns here, so the guard correctly does not fire on the flip case; B2+B3 run with their `post-plan` variants.)

After Step B1's gate confirms approval, update `state.yml` to `phase: planning`, clear `pending_gate`, append `planning_started`, then invoke `superpowers:writing-plans` against `<config.runs_path>/<slug>/spec.md`. **Emit before the state write:** `<masterplan-trace state-write field=phase from=<old-phase> to=planning>`. **Emit before the Skill invocation:** `<masterplan-trace skill-invoke name=writing-plans args=spec=<config.runs_path>/<slug>/spec.md>`. It should produce `<config.runs_path>/<slug>/plan.md`. If the upstream writing skill writes to a legacy path (`docs/superpowers/plans/YYYY-MM-DD-<slug>.md`), copy it into `<config.runs_path>/<slug>/plan.md`, record the old path under `legacy.plan`, and continue against the bundled plan. Brief plan-writing with **CD-1 + CD-6**, plus:

> When you judge a task as obviously well-suited for Codex (≤ 3 files, unambiguous, has known verification commands, no design judgment) or obviously unsuited (requires understanding broader system context, design tradeoffs, or files outside the stated scope), add a `**Codex:** ok` or `**Codex:** no` line in the per-task `**Files:**` block. See the Plan annotations subsection in Step C 3a for the exact syntax. The orchestrator's eligibility cache parses these as overrides on the heuristic checklist.

> **Parallel-group annotation (v2.0.0+).** When you identify mutually-independent verification, inference, lint, type-check, or doc-generation tasks, group them with `**parallel-group:** <thematic-name>` (e.g., `verification`, `lint-pass`, `inference-batch`). Each parallel-grouped task MUST have a complete `**Files:**` block declaring its exhaustive scope (no implicit additional paths). Codex-eligible tasks (those you'd mark `**Codex:** ok`) should NOT be parallel-grouped — they fall out of waves at dispatch time per the FM-4 mitigation. Use `**parallel-group:**` for tasks that are read-only or write to gitignored paths only (no commits). Place parallel-grouped tasks contiguously in plan-order — interleaved groups don't parallelize. The orchestrator's eligibility cache parses these annotations; the writing-plans skill just emits them.

> **Verify-pattern annotation (v2.8.0+, optional).** When a task's verification command produces output that does NOT match Step 4a's default PASS pattern (`PASSED?|OK|0 errors|0 failures|exit 0|✓`), add a `**verify-pattern:** <regex>` line in the per-task `**Files:**` block to override the default. The implementer's `commands_run_excerpts` (1–3 trailing output lines per command) is regex-matched against this pattern at trust-skip time per the G.1 mitigation. Useful when the test runner emits a domain-specific success signal (e.g., `**verify-pattern:** ^Total: \d+ passed; 0 failed$` for a custom harness, or `**verify-pattern:** finished without errors` for a build script). Optional — most tasks rely on the default pattern. Codex-routed tasks ignore this annotation (Codex review at 4b is the verifier there).

> **Skip your Execution Handoff prompt** ("Plan complete… Which approach?"). /masterplan has already decided execution mode based on the `--no-subagents` flag and config — do not ask the user. Just write the plan and return control.

> **Complexity-aware brief.** The orchestrator passes `resolved_complexity` (one of `low`, `medium`, `high`) into the writing-plans brief. Adjust the brief shape accordingly:
>
> - complexity == low — brief writing-plans to: produce a flat task list of ~3–7 tasks; SKIP the `**Codex:**` annotation prelude; SKIP the `**parallel-group:**` annotation guidance; mark `**Files:**` blocks as OPTIONAL (best-effort, not required). Plan output is leaner.
> - `complexity == medium` — current brief (above bullets are the canonical defaults; `**Files:**` encouraged, `**Codex:**` annotation optional, `**parallel-group:**` optional). No change.
> - `complexity == high` — brief writing-plans to: REQUIRE `**Files:**` block per task (exhaustive); REQUIRE `**Codex:**` annotation per task (`ok` or `no`); ENCOURAGE `**parallel-group:**` for verification/lint/inference clusters. Eligibility cache will be validated against `**Files:**` declarations at Step C step 1 (per spec §Behavior matrix / Plan-writing / `eligibility cache` row at high). Because every task carries a well-formed annotation pair by construction, Step C step 1's Build path always takes the inline fast-path at `high` (no Haiku dispatch); see **Inline-build verifier** in Step C step 1.

> **Plan-format markers (v5.0).** Every task in the emitted plan MUST include the following structured markers, in this order, before the task body. The orchestrator's `bin/masterplan-state.sh build-index` parses these to populate `plan.index.json`:
>
> ~~~markdown
> ### Task <N>: <name>
>
> **Files:** <comma-separated paths>
> **Parallel-group:** <wave-X or none>
> **Codex:** <true|false>
> **Spec:** [spec.md#L<a>-L<b>](spec.md#L<a>-L<b>)
> **Verify:**
> ```bash
> <verify commands>
> ```
>
> <task body>
> ~~~
>
> See spec §Plan-Format Change (§L161-L184) for full rationale. Doctor check #35 enforces this on v5.0 plans.

Plans without annotations behave exactly as before (heuristic-only). Annotations are an authoring aid; they're never required.

**Re-engagement gate** (same silent-stop bug pattern as Step B1's gate — never end the turn silently waiting on a free-text question). **Emit on the first line of this gate's instructions, BEFORE the plan-existence check below:** `<masterplan-trace skill-return name=writing-plans expected-next-step=step-b2-re-engagement-gate>`.

After writing-plans returns:

1. Check whether the expected plan file exists at `<config.runs_path>/<slug>/plan.md`.
2. **If plan missing:** writing-plans was aborted or failed. Persist `pending_gate` with `id: plan_missing`, then surface `AskUserQuestion("writing-plans did not complete (no plan at <path>). Re-invoke against the existing spec / Edit the spec and re-invoke / Abort kickoff")`.
3. **If plan exists** (the normal case): update `state.yml`: `phase: plan_gate`, `artifacts.plan: <config.runs_path>/<slug>/plan.md`, `current_task` = first task from the plan, `next_action` = first step of that task; append `plan_written`; proceed to Step B3 silently. **Emit before the state write:** `<masterplan-trace state-write field=phase from=planning to=plan_gate>`. B3's existing AskUserQuestion handles the final plan-approval gate before Step C, so no separate B2 gate is needed in the success case.

### Step B3 — State update + approval

**Entry breadcrumb.** Emit on first line of this section:

```
<masterplan-trace step=step-b3 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
```

**Complexity kickoff prompt.** Fires once at kickoff (`/masterplan full <topic>`, `/masterplan plan <topic>`, `/masterplan brainstorm <topic>`) when:
- `--complexity` is NOT on this turn's CLI args, AND
- `complexity_source == default` (i.e., no config tier set it; built-in `medium` would be silently used).

Surface ONE `AskUserQuestion` after Step B0's worktree decision and BEFORE Step B1's brainstorm:

```
AskUserQuestion(
  question="What complexity for this project? Affects plan size, execution rigor, and doctor checks. Brainstorm runs full regardless.",
  options=[
    "medium — standard /masterplan flow (Recommended; current behavior)",
    "low — small project, light treatment (skip codex review, simpler activity log, ~3-7 tasks, no eligibility cache)",
    "high — high-stakes; codex review on every task, decision-source cited, completion retro treated as required evidence",
    "use config default — read from .masterplan.yaml; warn if not set, fall through to medium"
  ]
)
```

On the user's pick:
- `medium` / `low` / `high` → flip in-session `resolved_complexity` to the chosen value; set `complexity_source = "flag"` (treated as user-explicit at this turn). Persist to `state.yml`'s `complexity:` field.
- `use config default` → no change to `resolved_complexity`; emit one-line warning if it would fall through to built-in default (`medium` — no config set complexity).

If `--complexity` IS on the CLI, OR any config tier sets `complexity:`, this prompt is silenced (no AskUserQuestion fires). The Step B3 close-out gate at the end of B3 still fires as today.

Update the existing `state.yml` created in Step B0 using the format in **Run bundle state format** below. **Populate every required field** (omitting any will fail doctor's schema check and break Step A's listing). Step B3 is not allowed to create state from scratch; if `state.yml` is missing here, that is a protocol violation and the run must halt with a recovery question.

**Codex native goal at plan-ready.** When `codex_host_suppressed == true` and the plan file exists, reconcile the native goal before the close-out gate. Call `get_goal`; if there is no active goal, call `create_goal` with `Complete Masterplan plan <slug>: <plan title or first task summary>` and persist `codex_goal` in `state.yml`. If a matching active goal already exists, persist `codex_goal` with `created_by_masterplan: false`. If a different active goal exists, persist `pending_gate.id: codex_goal_conflict`, set `stop_reason: question`, append `question_opened`, and surface a structured gate; do not start execution until the conflict is resolved.

**Auto-compact nudge** (fires once per plan; respects `config.auto_compact.enabled`). If `config.auto_compact.enabled && compact_loop_recommended == false && !auto_compact_nudge_suppressed`, output one passive notice immediately before the kickoff approval prompt below:
> *(Recommended: pair this run with `/loop {config.auto_compact.interval} /compact {config.auto_compact.focus}` in this same session. Note: this fires `/compact` every {config.auto_compact.interval} regardless of current context size, which may run unnecessary compactions on shorter plans. Set `auto_compact.enabled: false` in `.masterplan.yaml` to silence; consider `60m` or `90m` via `auto_compact.interval` for reduced waste.)*

Then flip `compact_loop_recommended: true` in `state.yml`. Whether or not the user pastes the command, the notice is suppressed for subsequent kickoffs/resumes of this plan.

**Close-out gate.** Consult `halt_mode`:

- **`halt_mode == none`** (kickoff path): if `--autonomy == gated`, persist `pending_gate` with `id: plan_approval`, then **emit** `<masterplan-trace gate=fire id=plan_approval auq-options=3>` and present a one-paragraph plan summary and the path to the plan file via `AskUserQuestion` with options "Start execution / Open plan to review / Cancel". Wait for approval. If `--autonomy in {loose, full}`: clear `pending_gate` (no-op if never opened), skip approval, append `plan_approval_auto_accepted` to `events.jsonl` with `{autonomy: "<loose|full>"}`, and proceed to **Step C** with the new `state.yml` path. **Behavior change (v4.2.0):** loose autonomy used to halt here; it now auto-approves like full. Users who want the old halt for last-look-before-execute should run kickoff with `--autonomy=gated` explicitly. Note that L1286 spec_approval is intentionally NOT changed — it still halts under loose for design-direction-correction safety.

- **`halt_mode == post-plan`** (new, fires when invoked via `/masterplan plan <topic>`, `/masterplan plan --from-spec=<path>`, Step A's spec-without-plan variant's pick, or via B1's "Continue to plan now" flip from a `brainstorm` invocation): persist `pending_gate` with `id: plan_closeout`, set `stop_reason: question`, then **emit** `<masterplan-trace gate=fire id=plan_closeout auq-options=4>` and surface `AskUserQuestion("Plan written at <path>. State file at <state-path>. What next?", options=["Done — resume later with <manual-resume-command> (Recommended)", "Start execution now — flip halt_mode to none and proceed to Step C", "Open plan to review before deciding", "Discard plan + state file (spec kept)"])`. Resolve `<manual-resume-command>` by host: Claude Code uses `/masterplan execute <state-path>`; Codex uses `normal Codex chat: Use masterplan execute <state-path>`.
  - "Done" → clear `pending_gate`, leave `stop_reason: question`, → CLOSE-TURN. `state.yml` persists with `status: in-progress`, `phase: plan_gate`, and `current_task` set to the first task. The next bare `/masterplan` or Codex `Use masterplan` invocation resumes from this state without requiring the operator to remember the command.
  - "Start execution now" → flip in-session `halt_mode` to `none` and proceed to **Step C**.
  - "Open plan" → clear `pending_gate`, leave `stop_reason: question`, → CLOSE-TURN. The next bare `/masterplan` or Codex `Use masterplan` invocation resumes from this state.
  - "Discard" → `git rm` the plan file and `state.yml`; commit (`masterplan: discard plan <slug>` subject); → CLOSE-TURN [pre-close: git rm + commit done above]. Spec is kept.

The state file's `autonomy`, `codex_routing`, `codex_review`, `loop_enabled` fields are populated from this run's flags per the post-plan flag-persistence rule in Step 0; they take effect on the eventual `execute` invocation.

---
