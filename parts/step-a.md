# Step A — Intake (list + pick)

<!-- Loads on demand: sourced from commands/masterplan.md L975-1024
     Spec: docs/masterplan/v5-lazy-phase-prompts/spec.md#L68
     Allocated size: ~30K (intake)
     Router loads this file when: user invokes /masterplan with no topic args,
     or after Step 0 determines no explicit verb that bypasses list+pick.
     Step 0 (parts/step-0.md) must already have run before this loads. -->

## Step A — List + pick (across worktrees)

0. **`step_m_plans_cache` short-circuit.** If `step_m_plans_cache` is populated (i.e., this is a resume-first ambiguous case from Step M or a "Resume in-flight" pick from the empty-state menu), skip steps 1–4 and use the cached list directly. Jump to step 5. The cache holds the same `[{path, frontmatter, parse_error?}]` shape that step 4 produces.
1. Enumerate all worktrees of the current repo from `git_state.worktrees` (cached in Step 0). Parse into `(worktree_path, branch)` tuples. Include the current worktree.
2. **Worktree-count short-circuit.** If more than 20 worktrees exist, surface a one-line warning and switch to a faster mode: scan only the current worktree plus any worktree with a `state.yml` or legacy status file modified in the last 14 days. Issue the per-worktree `find <worktree> \( -path '*/docs/masterplan/*/state.yml' -o -path '*/docs/superpowers/plans/*-status.md' \) -mtime -14` calls as **one parallel Bash batch**, not sequentially. Per CD-2, do not auto-prune worktrees — just narrow the scan.
3. For each worktree (after any short-circuit), glob `<worktree_path>/<config.runs_path>/*/state.yml` plus legacy `<worktree_path>/<config.plans_path>/*-status.md`. Issue the per-worktree globs as one parallel Bash batch.
4. **State parsing.**
   - **When worktrees ≥ 2:** dispatch parallel Haiku agents (pass `model: "haiku"` on each Agent call per §Agent dispatch contract; one per worktree, or one per ~10-file chunk if any single worktree holds many state/status files). Each agent's bounded brief: Goal=parse YAML state from these files, Inputs=`[<state-or-status-path>...]`, Scope=read-only, Constraints=CD-7 (do not modify state files), Return=`[{path, format: "bundle"|"legacy-status", frontmatter, parse_error?}]` JSON. Orchestrator merges results.
   - **When worktrees == 1:** read inline (Read tool) — agent dispatch latency is not worth it.
   - Keep entries where `status` is `in-progress` or `blocked`. Annotate each with the worktree path and branch it lives in. **If a state/status file fails to parse**, skip it and add a one-line note to the discovery report ("state file at `<path>` is malformed — run `/masterplan doctor` to inspect"). Do not abort the listing. Sort the parsed entries by `last_activity` descending.
5. Use `AskUserQuestion` with options laid out as: 2 most recent plans + "Start fresh". If more than 2 in-progress plans exist, replace the lower plan slot with a "More…" option that, when picked, re-asks with the next batch — keeps total options at 3, never exceeds the AskUserQuestion 4-option cap.
6. If user picks a plan → **Step C** with that `state.yml` path. If the picked item is a legacy status path, run the Step 0 legacy migration prompt first and continue against the migrated `state.yml` unless the user explicitly chooses one-invocation legacy mode. If the plan's worktree differs from the current working directory, `cd` to that worktree before continuing (run all subsequent commands from the plan's worktree). If "Start fresh" → consult **Verb-explicit override** below; if it does not divert, ask for a one-line topic via `AskUserQuestion` (free-form Other), then **Step B**.

7. **Verb-explicit override** (Bug B fix; never silently brainstorm when user typed `execute`). Before executing the "Start fresh → Step B" branch from step 6, consult `requested_verb` (set by Step 0's argument-parse precedence):

   - **If `requested_verb == 'execute'` AND user picked "Start fresh"** (or step 5's list+pick produced zero matching candidates because `topic_hint` did not match any in-progress plan): surface
     ```
     AskUserQuestion(
       question="No in-progress plan matches '<topic_hint or topic words>'. You typed `execute` explicitly — what now?",
       options=[
         "Run full kickoff: brainstorm + plan + execute as one flow (Recommended)",
         "Pick from existing in-progress plans (ignore my topic)",
         "Brainstorm-only — discovery + spec, no plan/execute yet",
         "Cancel"
       ]
     )
     ```
     Routing of choices:
     - **Run full kickoff** → set `halt_mode = none`, route to **Step B** with `topic_hint` as topic.
     - **Pick from existing** → re-fire step 5's list+pick `AskUserQuestion`, omitting the "Start fresh" option this time (forces a real plan choice).
     - **Brainstorm-only** → set `halt_mode = post-brainstorm`, route to **Step B** with `topic_hint` as topic.
     - **Cancel** → → CLOSE-TURN.

   - **If `requested_verb in {full, brainstorm, plan}` OR is unset** (existing kickoff paths and bare/empty-args paths via Step M0): use the existing step 6 "Start fresh → Step B" routing unchanged. The override only catches the `execute`-with-no-matching-plan case.

   This honors the user's explicit verb intent — `/masterplan execute <topic>` should never silently mean `/masterplan brainstorm <topic>`. Reproducer: petabit-os-mgmt 2026-05-07 00:53 — `/masterplan execute phase 7 restconf --complexity=high` was silently routed to brainstorm because no matching state/status files existed.

#### Spec-without-plan variant (triggered by `/masterplan plan` with no topic and no `--from-spec=`)

When the verb routing table in Step 0 matches `plan` with no args, Step A runs this variant instead of the standard in-progress picker above:

1. Glob `<config.runs_path>/*/spec.md` plus legacy `<config.specs_path>/*-design.md` across all worktrees as one parallel Bash batch (read worktrees from `git_state.worktrees`).
2. For each candidate spec, check whether the same run directory has `plan.md`; for legacy specs, check whether a matching run bundle exists or a legacy plan exists at `<config.plans_path>/<same-slug>.md`. Filter to specs **without** a plan.
3. Sort the filtered list by mtime descending.
4. **If ≥ 1 candidate:** present top 3 via `AskUserQuestion`. The 4th option is "Other — paste a path" (free-text). User picks → treat as `plan --from-spec=<picked>` and proceed to **plan --from-spec worktree handling** (Step B0a, above in Step B), then Step B2 + B3.
5. **If zero candidates:** surface `AskUserQuestion("No specs without plans found across <N> worktrees. What next?", options=["Start a new feature — /masterplan full <topic>", "Brainstorm-only — /masterplan brainstorm <topic>", "Cancel"])`. The first two redirect into the corresponding verb's flow with a topic prompted next; "Cancel" ends the turn.

`halt_mode` for this variant's outputs is `post-plan` (already set in Step 0 when `plan` was matched). Step B3's close-out gate fires after the plan is written.

---
