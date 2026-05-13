# Import — Legacy Artifact Migration

<!-- Loads on demand: sourced from commands/masterplan.md L2081-2205
     Spec: docs/masterplan/v5-lazy-phase-prompts/spec.md#L61-L86
     Allocated size: phase-file home for the import verb
     Router loads this file when: verb == import
     Prerequisite: legacy docs/superpowers/... artifacts present (or
     direct-routing flags --pr=, --issue=, --file=, --branch= supplied). -->

## Step I — Import legacy artifacts

Triggered by `/masterplan import [args]`. Brings legacy planning artifacts under the masterplan run-bundle schema (`docs/masterplan/<slug>/state.yml` + bundled spec/plan/events), with completion-state inference so already-done work isn't redone.

**Direct vs. discovery routing:** If `$ARGUMENTS` includes any of `--pr=<num>`, `--issue=<num>`, `--file=<path>`, `--branch=<name>`, skip discovery and jump to **Step I3** with that single candidate (Step I2 rank+pick is also skipped — the candidate is already determined). Otherwise run **Step I1**.

### Step I1 — Discover (parallel)

Dispatch four parallel `Explore` subagents (pass `model: "haiku"` on each Agent call per §Agent dispatch contract — bounded mechanical extraction). Each returns a JSON list of candidates with: `source_type`, `identifier`, `title`, `last_modified`, `summary` (1–2 sentences), `confidence` (0–1, based on density of plan-like structure: numbered steps, checkboxes, "Phase N" headings, etc.).

Each agent's brief MUST include: "Issue all globs/finds/`gh` calls as one parallel tool batch — do not run them sequentially within your turn." Within-agent batching tightens latency on top of the cross-class parallelism.

1. **Local plan files** — find `PLAN.md`, `TODO.md`, `ROADMAP.md`, `WORKLOG.md`, `docs/plans/*.md`, `docs/design/*.md`, `docs/rfcs/*.md`, `architecture/*.md`, `specs/*.md`, branch READMEs. Skip files inside `node_modules/`, `vendor/`, `.git/`, `legacy/.archive/`, and any path already under `config.runs_path`, `config.specs_path`, or `config.plans_path`.

2. **Git artifacts** — local + remote-tracking branches not yet merged into the trunk. **Enumerate refs explicitly via `git for-each-ref`, NOT `git branch -avv`** (more reliable: `git for-each-ref` returns one ref per line in a stable format, while `git branch -avv` parsing has tripped Haiku into emitting local-only commands like `git branch -v` that silently miss remote-only branches — issue #3, root cause of the petabit-os-mgmt false-negative). Brief MUST instruct: run `git for-each-ref refs/heads/ refs/remotes/ --format='%(refname)|%(refname:short)'` to list every local and remote-tracking ref with **both** its full and short forms (separated by `|`). Filter on the **full refname** (left of `|`) — drop any line whose full path ends in `/HEAD` (this catches `refs/remotes/origin/HEAD` cleanly; note that `git for-each-ref`'s `:short` formatter renders that symbolic ref as the bare token `origin`, which is NOT catchable by `grep -v HEAD` on the short form alone — v2.14.1 tightening, observed Haiku ambiguity on petabit-os-mgmt smoke test). Also drop the trunk ref itself (`refs/heads/<trunk>` and `refs/remotes/origin/<trunk>`). Use the short name (right of `|`) for display, the `git log` topology check, and the `gh` cross-reference. For each remaining ref, check `git log <trunk>..<short-name> --oneline` and keep refs whose output is non-empty. The check is **topology-based** (SHA reachability), not content-based: a rebased-equivalent branch whose content already landed on `<trunk>` via different SHAs is still flagged, because the cleanup action is deleting the stale ref, not re-importing the content (operator's call: `git push origin --delete <branch>` for remote, `git branch -D <branch>` for local). Cross-reference `gh pr list --state=all --head=<branch-name>` (strip `origin/` prefix from remote-tracking refs before the `--head=` query) to flag branches with no merged PR. Also include named git stashes (`git stash list`).

3. **GitHub issues + PRs** — only if `gh` is authenticated. `gh issue list --state=open --limit=50 --json=number,title,body,updatedAt,labels` and `gh pr list --state=open --limit=50 --json=number,title,body,updatedAt,headRefName`. Filter to entries whose body contains a task list (`- [ ]`/`- [x]`/numbered steps) OR whose labels include planning-shaped strings (`design`, `planning`, `epic`, `roadmap`, `in-progress`).

4. **Stale superpowers state** — legacy `docs/superpowers/{plans,specs,retros,archived-*}` records that have **neither** (a) a sibling `docs/masterplan/<slug>/state.yml` where `canonical_slug(legacy-slug) == canonical_slug(new-bundle-dir-name)` (date-prefix and `-status`/`-design`/`-retro` suffix stripped on both sides), **nor** (b) any existing `docs/masterplan/*/state.yml` whose `legacy.{status,plan,spec,retro}` pointers reference the legacy record's status/plan/spec/retro paths. Records matching either condition are already migrated and must be filtered from the candidate list. Frontmatter-supplied `slug:` fields that retain the date prefix (e.g., `slug: 2026-05-09-foo`) must be normalized through `canonical_slug()` before comparison — string-equal dedup against raw frontmatter slugs is a known false-positive source.

### Step I2 — Rank + pick

Dedupe across scans (the same project may appear as a PLAN.md AND an issue AND a branch — match by slug similarity). Sort by `last_modified` desc, breaking ties by `confidence` desc. Surface the top 8 via `AskUserQuestion(multiSelect=true)` with one option per candidate (label = title + source_type tag, description = `last_modified` + `summary`). Include a "Show more" option if the list exceeds 8 — re-asks with the next 8. User picks 1+ to import.

### Step I3 — Convert (parallel waves + sequential cruft/commit)

Conversions parallelize across candidates because each candidate writes to unique target paths. Cruft handling and `git commit` run sequentially after the parallel waves to keep a single writer per commit (avoids git index races and keeps activity-log entries clean).

#### Pre-flight collision checks (sequential, fast)

**Slug-collision pass:** For all picked candidates, sanitize each title to a slug and group by slug. When two or more candidates resolve to the same slug, suffix later ones with `-2`, `-3`, etc. If multiple collisions are detected (≥ 2 collision groups), confirm the renames once via `AskUserQuestion(Apply auto-suffixed slugs / Show me the conflicts and let me rename / Abort import)`. Use today's date for all kickoff dates.

This produces a `candidates[]` list with finalized `(slug, run_dir, spec_path, plan_path, state_path, events_path)` tuples — guaranteed unique within this batch (but not yet checked against existing on-disk paths). New paths are always inside `<config.runs_path>/<slug>/`.

**Path-existence pass:** For each candidate's `(run_dir, spec_path, plan_path, state_path, events_path)` tuple, check whether ANY target path already exists on disk. Implements the operational rule "Import never overwrites existing masterplan state silently". "Pre-existing collision" here covers two cases: (a) a target path already exists on disk, AND (b) the candidate matches an already-migrated bundle by `canonical_slug` or by `legacy.{status,plan,spec,retro}` pointer reference. Case (b) should normally be filtered upstream in Step I1.4, but the defense-in-depth check here catches direct-routing invocations (`--file=`, `--branch=`, `--pr=`, `--issue=`) that skip discovery entirely.

For each candidate with **≥ 1** pre-existing path collision, surface `AskUserQuestion` (one prompt per colliding candidate; sequential, not parallel — interactive prompts must not interleave): "Importing `<slug>` would overwrite existing masterplan state at: `<colliding-paths>`. What now?" with options:
- **(1) Overwrite (Recommended)** — proceed with the original tuple; existing files will be rewritten by I3.4.
- **(2) Write to `-v2` suffix** — append `-v2` to the slug and recompute the tuple; if `<slug>-v2` paths also collide, increment to `-v3`, `-v4`, etc. until all bundle target paths are free (mirrors the `-2`, `-3` slug-collision pattern above).
- **(3) Abort this candidate** — remove the candidate from `candidates[]` and skip its I3.2/I3.4/I3.5 processing.

Mutate `candidates[]` per the chosen action: aborted entries are removed; `-vN` entries have their `(slug, run_dir, spec_path, plan_path, state_path, events_path)` tuple rewritten before I3.2 begins.

When no candidate has any pre-existing collision, this step is silent (no prompt, no log line) and `candidates[]` is unchanged.

#### I3.2 — Parallel source-fetch wave

Dispatch one fetch agent per candidate in a single Agent batch. **Per-candidate model assignment per §Agent dispatch contract:**

- **Local file** → `Read` (no Agent dispatch — direct tool call).
- **Git branch** → Agent dispatch with `model: "sonnet"` (reverse-engineering needs judgment); given the full diff vs trunk (`git diff <trunk>...<branch>`) and commit list (`git log --reverse <trunk>..<branch> --format='%h %s%n%b'`). Brief: "Reverse-engineer goal/scope/inferred-tasks/open-questions. Output structured sections."
- **GH issue** → `gh issue view <num> --json=body,comments,labels` (no Agent dispatch — direct CLI call).
- **GH PR** → `gh pr view <num> --json=body,commits,comments,headRefName` (no Agent dispatch — direct CLI call).
- **Stale superpowers plan** → `Read` (no Agent dispatch — direct tool call).

Each agent's bounded brief: Goal=fetch this candidate's source content, Inputs=candidate identifier, Scope=read-only, Return=raw source content + (for branches) reverse-engineered structure. The orchestrator collects the results keyed by candidate id.

#### I3.4 — Parallel completion-state inference + conversion wave

First, for each candidate that has a discernible task list, run completion-state inference (see **Completion-state inference** below) — these inference runs can themselves be dispatched in parallel since each candidate is independent. The inference results feed the conversion briefs below.

Then dispatch one Sonnet conversion subagent (pass `model: "sonnet"` per §Agent dispatch contract) per candidate in a single Agent batch. Each agent owns unique target paths from I3.1 and writes only inside its own run directory — no contention. Brief per agent:

> Rewrite this legacy planning artifact into superpowers spec format and plan format following the writing-plans skill conventions. Drop tasks classified `done`. Move `possibly_done` tasks into a `## Verify before continuing` checklist at the top of the plan, each with its evidence. Keep `not_done` tasks as the active task list, reformatted into bite-sized steps (writing-plans style). Preserve constraints, decisions, and stakeholder context in the spec's Background section. Discard pure status narration. Do not invent tasks the source didn't mention. Return the proposed spec and plan as content strings in the return shape (do NOT write files to the bundle directory). Return the required schema per contract `import.convert_v1`: `{contract_id: "import.convert_v1", inputs_hash: "<sha256>", processed_paths: ["spec.md", "plan.md"], violations: [], coverage: {expected: 2, processed: 2}, artifacts: {spec: {content: "...", source: "<legacy.spec>"}, plan: {content: "...", source: "<legacy.plan>"}}}`. The parent orchestrator will perform all file writes. If you cannot produce a coherent spec or plan, include the failure reason in `violations` and set `coverage.processed` to the count you could handle.

Bounded scope per agent: writes only inside its own `(run_dir, spec_path, plan_path, state_path, events_path)`; do not touch other candidates' paths or the legacy source.

#### I3.5 — Import hydration guard (parent-owned transaction)

After I3.4's conversion wave completes, for each candidate, the parent orchestrator runs this transaction BEFORE I3.6 (cruft handling):

1. **Parent stages copies to temp dir.** For each `legacy.<artifact>` path in the candidate's state that resolves to an extant file, copy it to `/tmp/masterplan-import-<slug>-<pid>/` (the PID-tagged directory that the temp-dir sweep in Step 0 will eventually prune). Validate read access before any bundle writes. If a `legacy.*` path does not resolve, record the missing path; it will inform the fallback path below.

2. **Validate subagent return shape.** The I3.4 conversion subagent must return a result conforming to contract `import.convert_v1`:

   ```yaml
   contract_id: "import.convert_v1"
   inputs_hash: "<sha256 of staged inputs>"
   processed_paths: ["spec.md", "plan.md"]
   violations: []
   coverage: {expected: 2, processed: 2}
   artifacts:
     spec: { content: "...", source: "<legacy.spec>" }
     plan: { content: "...", source: "<legacy.plan>" }
   ```

   If `violations` is non-empty OR `coverage.processed != coverage.expected` OR `contract_id != "import.convert_v1"`, the parent treats import as failed (go to fallback path below). Record a `{"event":"import_contract_violation","contract_id":"import.convert_v1","violations":[...]}` event.

3. **Parent validates and writes atomically.** On all-clear from step 2:
   a. Parent writes `<run-dir>/spec.md` from `artifacts.spec.content`.
   b. Parent writes `<run-dir>/plan.md` from `artifacts.plan.content`.
   c. Parent rewrites `artifacts.spec` and `artifacts.plan` in `state.yml` to point to the bundle-local paths.
   d. Parent preserves `legacy.*` pointers for forensics.
   e. Parent writes `import_hydration: "full"`, `import_contract.contract_id: "import.convert_v1"`, `import_contract.inputs_hash: "<hash>"`, `import_contract.processed_at: "<now>"` into `state.yml`.
   f. All of c/d/e are written in a single `state.yml` update (not incremental).
   g. On any failure (file write error): `rm -rf /tmp/masterplan-import-<slug>-<pid>/`, abort import for this candidate, leave bundle in pre-import state (refuse to create the bundle if it hasn't been created yet), append `{"event":"import_hydration_aborted","reason":"..."}`.

4. **Fallback path.** If step 2 reports violations, OR if the subagent could not produce coherent spec/plan (e.g., legacy artifact is a brief or chat dump), parent writes:
   - `<run-dir>/spec.md`: a minimal "Import context" wrapper containing: the legacy file path, a one-paragraph summary the subagent produced (from the I3.4 return), and a pointer to verify.
   - `<run-dir>/plan.md`: a minimal "Import verification plan" with one task: "Read legacy file at `<path>`; confirm scope; produce a real plan if work is to continue."
   - `state.yml`: `import_hydration: "fallback"` and the same `import_contract.*` fields as above.
   Append `{"event":"import_hydration_fallback","reason":"..."}`.

5. **v2 bundle rehydration (lazy).** v2 imported bundles with empty `artifacts.spec`/`artifacts.plan` and non-empty `legacy.*` — detectable in the Resume controller's step 0 (Wave 1 lazy migration) by checking `import_hydration` is absent AND `legacy.*` is non-empty AND `artifacts.spec` is empty. On that condition: run Step I3.5 hydration retroactively, exactly as if importing fresh. Event log records `{"event":"v2_legacy_import_rehydrated"}`. If `legacy.*` paths no longer resolve: surface `AskUserQuestion("Legacy import paths for <slug> no longer exist. What now?", options=["Keep bundle as read-only history (Recommended)", "Attempt manual hydration — I'll paste the content", "Delete this bundle"])`.

#### I3.6 — Sequential cruft handling + commit (per candidate)

After all parallel waves complete, iterate candidates one-by-one:

1. **Cruft handling.** Apply `config.cruft_policy` (overridden by `--archive`/`--keep-legacy` flags). If policy is `ask` (the default), present `AskUserQuestion` per candidate:
   - **Local file:** Leave + banner / Archive to `<config.archive_path>/<date>/` / Delete (irreversible).
   - **Branch:** Keep / Rename to `archive/<branch>` / Delete local ref.
   - **GH issue or PR:** Comment with link to new spec / Comment + close / Do nothing.
   - **Stale superpowers plan:** Replace with new plan / Move to `<config.archive_path>/<date>/` / Leave both.

   Apply the chosen action.

2. **Commit.** `git add` the new run bundle (`spec.md`, `plan.md`, `state.yml`, `events.jsonl`) and any banner edits or moves. Commit with: `masterplan: import <slug> from <source-type>`.

Sequential here is deliberate: cruft prompts are user-interactive (parallel `AskUserQuestion` would scramble UX), and per-candidate `git commit` keeps the index clean.

**Hand off:** After all candidates are converted, list the new `state.yml` paths. `AskUserQuestion`: "Resume one now? / All done — exit." If resume → jump to **Step C** with the chosen state path.
