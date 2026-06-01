# GitHub Coordination for masterplan — v1 Design Spec

**Status:** Draft 3 (brainstorm phase) — design approved at the user review gate (2026-05-31); contract-ref **Option B** selected
**Date:** 2026-05-31
**Bundle:** `docs/masterplan/github-coordination/`
**Complexity:** high · **Autonomy:** full · **Planning mode:** auto
**Scope of this spec:** v1 walking skeleton only. Named follow-on phases are in §13; they are explicitly out of scope.

> **Terminology note (read first).** Throughout, **"single-writer"** means *the lead is the sole writer of the canonical `state.yml`/`events.jsonl`* — this is masterplan's **L1 single-writer convention** (stated in `CLAUDE.md` / `commands/masterplan.md`), which the codebase informally labels "CD-7". The canonical `docs/conventions/cd-rules.md` **CD-7** is the broader *durable-handoff-state* rule. This spec leans on the **single-writer convention**; where it says "single-writer (the L1 convention)" that is the precise referent. (Fact-check correction — draft 1 conflated the two.)

> **Decision log.** Draft 1 → cross-vendor Codex adversarial review returned **FAIL** (3 BLOCKER / 4 MAJOR / 2 MINOR / 1 NIT) + a Sonnet codebase fact-check. Draft 2 incorporated every finding (§16). At the design-approval gate the user selected **Option B** for the contract ref (dedicated immutable ref + separate integration branch — the *structural* tier separation, Codex's recommendation) over the simpler run-branch+guard, and kept wave-batched merge in v1. Draft 3 bakes B in.

---

## 1. Problem & motivation

masterplan today coordinates exactly **one** orchestrator through a single local run bundle (`docs/masterplan/<slug>/`, with `state.yml` as the durable source of truth). All execution happens on one machine: the shell dispatches waves to local subagents, marks tasks done, and commits — serially, in one session, bounded by one context window.

This is the ceiling we want to lift. We want **many** LLM sessions — potentially across machines — to collaborate on the *same* development effort, so a large plan can be worked in parallel by a fleet rather than one orchestrator. The coordination substrate for that fan-out should be **GitHub** (Issues, PRs, labels) rather than a single local directory, because GitHub already provides the durable, network-visible, multi-writer primitives a fleet needs.

This addresses the **GitHub-follower fan-out dimension** of the deferred **Guard D** (cross-machine coordination) named in `docs/masterplan/concurrency-guards/spec.md`. It does **not** close Guard D in full: the owner-sentinel / heartbeat / stale-takeover / **multi-lead-prevention** machinery Guard D specifies remains deferred (§13). v1 assumes **a single lead per run**, operator-enforced (§10). It is also dogfooding: we are using masterplan to design a masterplan feature.

**From-state:** single orchestrator, local-only bundle, serial wave dispatch, one context window.
**To-state:** a **lead** orchestrator that projects its plan onto GitHub, plus any number of **followers** (other LLM sessions/machines) that claim individual units of work, build them, and deliver them back as PRs — while the lead's local bundle stays the canonical record and the lead stays the sole writer of it.

---

## 2. Goals & non-goals

**Goals**

- **Speed via parallelism.** Multiple followers build different tasks of the same wave concurrently.
- **Durability & visibility.** Work-in-flight is visible on GitHub (issues/labels/PRs), not trapped in one session's context. A dead follower loses only its own in-flight task, not the run.
- **Quality at scale.** The plan's existing guarantees (file-disjoint waves, per-task verification, gated review) survive the fan-out — *with their real limits stated honestly* (§6).

**Non-goals (v1)**

- **Not open contribution.** This is a **trusted fleet** of cooperating LLM sessions under one operator — *not* a public, adversarial PR pipeline. No fork isolation, no untrusted-PR sandboxing. Claims are assumed honest.
- **Not auto-merge.** Merge stays **gated** (§5).
- **Not multi-lead.** One lead per run in v1 (§10). Multi-lead lease/heartbeat is deferred (§13).
- **Not infrastructure.** No CI-native automation, no coordinator daemon, no GitHub Projects automation, no auto-reclaim TTL (§13).

---

## 3. The spine: masterplan's existing contract, lifted across the network

The central design tension is **single-writer** (the lead is the *sole* writer of canonical state) versus **multi-agent scaling** (many sessions doing work). The resolution: this feature is not a new architecture — it is masterplan's **existing shell↔worker contract projected onto GitHub**:

| masterplan today (local) | GitHub coordination (v1) |
|---|---|
| The **shell** — sole writer of `state.yml`, owns git | The **lead** — sole writer of the canonical bundle, owns merges |
| **Wave members** — stateless, return digests, never write state | **Followers** — stateless per task, return a PR, never write canonical state |
| **Wave dispatch** (`§2a`) hands a wave's tasks to the L2 engine | **`publish`** projects a wave's tasks as GitHub Issues |
| Agent returns a **digest**; shell records + commits | Follower opens a **PR**; lead merges + records + commits |

Followers are wave members that happen to run in other sessions/machines; GitHub Issues are the wave-dispatch channel. The lead remains the single writer of `state.yml`. This framing is the load-bearing idea — every component below is a direct consequence of it.

---

## 4. The augment boundary (three tiers) — and how single-writer is preserved

GitHub **augments** the local bundle; it does not replace it. Each artifact lives in exactly one tier. **Option B (selected): the dedicated-ref model** — the cleanest separation, in which tier-2 is *structurally absent* from GitHub rather than present-but-guarded:

1. **Immutable contract → PUBLISHED to a dedicated ref (followers' read-only input).**
   `spec.md`, `plan.md`, `plan.index.json`. Published as an **immutable, tier-1-only** git ref `mp-coord/<slug>/<plan_hash>` that the lead synthesizes — a tree carrying *only* these three files. Followers fetch it **read-only**. Immutable per `plan_hash`: a plan change publishes a *new* ref, never mutating an old one. It carries no tier-2 and no source.

2. **Canonical mutable state → WRITTEN ONLY BY THE LEAD, NEVER PUSHED.**
   `state.yml`, `events.jsonl` (the bundle dir `docs/masterplan/<slug>/`) live **only on the lead's local run branch, which is never pushed**. GitHub never sees tier-2 at all — neither the contract ref nor the integration branch (tier 3) carries it. The lead is the sole writer *and* the only reader of its canonical copy. This is the dedicated-ref model's payoff: *absent-from-GitHub* and *lead-only-writer* both hold, resolving the draft-1 boundary contradiction **structurally**, not by a runtime guard.

3. **Coordination projection → NATIVE GitHub.**
   Issues, labels, PRs, and the **integration branch** `mp-int/<slug>` — the PR base, carrying the **source tree only** (constructed from `base_sha` with the run bundle dir excluded; §7.1). The ephemeral, multi-writer coordination layer — *derived from* tier 1, *driving updates to* tier 2 via the lead's reconciliation (§7.2). Owned by GitHub's native concurrency primitives.

**The invariant, precisely:** tier-2 is **never pushed** and is written by **the lead alone**; everything GitHub carries (contract ref + integration branch + issues/PRs) is tier-1 or source. Structural separation — not a runtime guard — keeps the single-writer convention true across the fan-out. (A bundle-dir PR guard, §7.2, remains as **defense-in-depth**, but tier-2's absence from every pushed ref is the *primary* protection.)

---

## 5. Merge policy: gated, no auto-merge (a deliberate revision of the standing rule's *framing*)

The standing masterplan rule is "**never auto-merge**" (PR-awareness is report-only; merge happens only at the `branch_finish` gate or by the user on GitHub — see `lib/finish.mjs:summarizePr`, surfaced via `mp pr-summary`). This spec **keeps that rule verbatim**: followers' PRs are *surfaced*, never auto-merged.

The lead's role at merge time is to **surface a wave's ready PRs** and let a human — or the lead acting at a human-authorized gate — merge them into the integration branch `mp-int/<slug>`, **one task at a time**, after the per-PR safety checks of §7.2. To keep the gated path from becoming a per-PR chore at scale, the lead **batches the *presentation*** of a wave's ready PRs (one approval surface), but **still merges sequentially with a mergeability re-check between each** (§6/§7.2) — batching the *decision*, not bypassing the per-merge safety step.

> **v1 scope flag (deferrable):** wave-batched *presentation* is the mitigation for the grain×merge tension (§6). It is the one piece that could drop to **v1.1** if implementation proves heavy — a correct v1 can present/merge strictly one PR at a time. The per-merge re-check is **not** deferrable; it is load-bearing for conflict-safety. **(User confirmed: keep in v1, flagged deferrable.)**

This is the one place we *revise a standing rule's framing* (single-machine → fleet), so it is called out explicitly: **merge authority stays human-gated; only the number of PRs flowing into the gate changes.**

---

## 6. Claim grain: one task = one Issue = one PR

The claimable unit is **a single plan task** (the finest grain). One task → one GitHub Issue → one follower → one PR.

**Why the finest grain.** Same-wave tasks are validated **file-disjoint** at **plan-build time** — `mergePlanFragments` bumps a task to the next wave if it shares a file with an already-placed same-wave task (`lib/plan-merge.mjs`), and `validatePlanIndex` (run via `mp validate-plan-index`) re-checks that no two same-wave tasks share a declared file. (Fact-check note: this is a **plan-build property**, not a runtime gate; `verify-scope`/`verifyScope` in `lib/wave.mjs` is a *separate* post-wave check that touched paths ⊆ declared scope — it does **not** check inter-task disjointness. Draft 1 named both as the enforcer; only `validate-plan-index` enforces disjointness.) Task grain is the only grain that inherits this property: two followers building two tasks of the same wave touch disjoint *declared* files. Coarser grains break it (a subsystem spans waves; a wave-as-unit kills parallelism).

**The guarantee, stated honestly (corrected from draft 1's overclaim).** File-disjointness of *declared* scopes makes concurrent task PRs *textually* conflict-free **only for files within those declared scopes**. It does **not** by itself guarantee clean sequential merges, because:

- **Undeclared shared files** — a generated index, a lockfile (`package-lock.json`), a shared barrel/`mod` file — that two tasks both touch *without declaring* will conflict. **Mitigation:** such shared/generated files **must be declared in task scope** so the disjointness validator serializes the touching tasks into **different waves**. The planner must surface these (an explicit plan-phase concern).
- **Renames / deletes / directory-vs-file conflicts / binary or submodule changes** can conflict even across disjoint path sets.
- **Moving base** — each merge advances the integration branch, so a PR mergeable before merge *k* may become un-mergeable after it.

**Mitigation (load-bearing, not deferrable):** a PR is eligible to merge only after **(a)** lead-side diff-scope verification (the PR's actual diff ⊆ the task's declared scope **and** does not touch the bundle dir — defense-in-depth; the integration branch carries no bundle anyway), and **(b)** a fresh GitHub mergeability re-check **after every preceding merge in the batch** (§7.2). With these, sequential merges within a wave are safe; without them, the textual guarantee does not hold.

**No new *semantic* guarantee.** Two disjoint files can still be logically incompatible — exactly the semantic-conflict risk the current single-machine wave model already carries. No regression, no new promise; semantic conflicts surface where they always have: verification and review.

**The grain × gated-merge tension.** Finest grain maximises parallelism but maximises PR count. Mitigation: wave-batched *presentation* (§5), with the per-merge re-check preserved.

---

## 7. New surface area

All new logic follows v8 layering: the **shell** (`commands/masterplan.md`) sequences `gh`/`git` (shell owns git/gh; `bin` is fs-only); pure decisions live in `lib/github-coord.mjs`; `bin` exposes thin fs-only transforms (the `summarizePr`→`mp pr-summary` pattern: gh-output-in, pure-transform-out).

### 7.1 Two new verbs (`publish`, `follow`)

**`publish`** *(lead → GitHub).* Projects the **current wave only** of a planned run onto GitHub:
- **Preflight (fail loud — §9)** before any mutation.
- **First publish of a run also provisions the two refs (idempotent):**
  - synthesize/update the immutable contract ref `mp-coord/<slug>/<plan_hash>` (tier-1 only — a tree of just `spec.md`/`plan.md`/`plan.index.json`);
  - create the integration branch `mp-int/<slug>` from the source tree at `base_sha` **with the run bundle dir (`docs/masterplan/<slug>/`) excluded**, so tier-2 never reaches GitHub (§4).
- For each task in the wave with no existing issue (dedup — below): `gh issue create` with a body serialized by `lib/github-coord.mjs` carrying a **machine-readable metadata block** `{run_slug, task_id, plan_hash, base_sha, wave, files[], verify_commands[], deps[], contract_ref, integration_branch}` plus a human title `T<id>: <task title>`. Labels: `mp:run-<slug>`, `mp:wave-N`, `mp:open`.
- Pins `contract_ref` (= `mp-coord/<slug>/<plan_hash>`) + `base_sha` (= the **integration-branch** HEAD that already includes all merged prior-wave work — wave ordering, §8).
- **Idempotent dedup by the metadata key** `{run_slug, task_id}` parsed from the issue body (not the human title — titles/labels are editable), queried with an **explicit `--limit`**. On detecting an *unexpected duplicate* (two issues, same `{run_slug, task_id}`) → **fail loud**, do not silently update (§9).
- Publishes wave **N+1 only after wave N is fully merged** (§8).

**`follow`** *(a session → follower).* Claims and delivers one unit:
1. **Preflight (fail loud — §9).**
2. **Claim** (optimistic, tightened — §8): pick a claimable issue, `gh issue edit --add-assignee @me`, relabel `mp:open → mp:claimed`, re-read and **settle only if** (assignees == [me]) ∧ (label == `mp:claimed`) ∧ (no open PR already exists for the task). Lost settle → release (`mp:claimed → mp:open`, drop self-assignment) and pick another.
3. **Build** via the **existing execute machinery**: fetch the contract from `mp-coord/<slug>/<plan_hash>` (read-only) and seed an **ephemeral local bundle** in a path **outside tracked `docs/masterplan/`** (e.g. a temp dir / `.git/mp-coord/<slug>/<task>/`), scoped to the single claimed task; run the normal `mp-implementer` dispatch + `verifyScope` (D6) + `verify_commands`, on a branch `mp/<slug>/t<id>` cut from the **integration branch** `mp-int/<slug>` at `base_sha`.
4. **Deliver**: open a PR (**base = the integration branch `mp-int/<slug>`** — never the lead's local run branch, §4/§7.4) with `Closes #<n>`; relabel `mp:claimed → mp:pr-open`. Discard the ephemeral bundle — canonical state is the lead's.
   - Verification **failure** → do **not** open a non-draft PR; surface the failure on the issue (comment) and release the claim (`mp:claimed → mp:open`) for reclaim. Failures never silently merge.

### 7.2 Integration: no new verb (reuse the existing loop) — atomic & idempotent write-back

Integration reuses the v8 **`next`/`status`** report verbs and `summarizePr`/`mp pr-summary` — deliberately kept **out of** the per-resume `decideNextAction` tick (a "merge it" nag every tick is the over-asking v8 removed). The lead's loop:

1. `next`/`status` lists the run's `mp:pr-open` issues, runs `gh pr list` + `mp pr-summary` per PR, and surfaces the wave's **ready** (mergeable) PRs (batched *presentation* — §5).
2. **Per-PR merge protocol (gated, the BLOCKER-2 fix — atomic & ordered):** for each chosen PR, in sequence:
   a. **Re-read & dedup:** confirm exactly one open PR for the task (close any duplicate first); re-check GitHub mergeability *now* against the current `mp-int/<slug>` HEAD (after any preceding merge in the batch — §6).
   b. **Diff-scope guard:** assert the PR diff ⊆ the task's declared scope **and** touches no bundle-dir path (defense-in-depth — the integration branch carries no tier-2 anyway, §4). A violation → refuse the merge, surface it.
   c. **Merge:** `gh pr merge` into `mp-int/<slug>` (closes the linked issue).
   d. **Reconcile into the local run branch & assert:** `git fetch`; fast-forward/merge the new `mp-int/<slug>` source into the lead's **local run branch**; assert the PR's **merge SHA is an ancestor of the local run-branch HEAD** before recording — so tier-2 `done` never outruns the merged code the lead actually holds.
   e. **Write-back (single-writer, local only):** `mp mark-task --status=done` + `mp event` recording `{issue, pr, merge_sha}` for the task, then **commit** the bundle on the local run branch (state leads git; never pushed — a crash before the commit re-derives on resume).
3. **Resume reconciliation (idempotent — the BLOCKER-2 fix).** On restart, for each issue the lead reconciles GitHub state (PR merged into `mp-int/<slug>`?) against local state (task done?) using the recorded `issue_map` (§7.4): merged-but-not-marked → re-run step 2d–e (fetch + reconcile source + write-back); marked-but-not-merged → surface. Reconciliation is a pure function (`reconcileIntegration`, §7.3) over `{localState, ghIssues}`.
4. When **all** of the current wave's issues are merged/closed and marked done, the lead runs `publish` for wave N+1.

### 7.3 New pure module `lib/github-coord.mjs` (unit-tested)

All coordination *logic* is pure here; `gh`/`git` stay shell-side; `bin` wrappers are fs-only. Sketched surface (final names settled in the plan phase):

- `issueBodyForTask(task, { contractRef, integrationBranch, baseSha, planHash, runSlug })` → issue-body string with the machine-readable metadata block (serialize).
- `parseIssueBody(body)` → `{run_slug, task_id, plan_hash, base_sha, contract_ref, integration_branch, …}` (deserialize).
- `dedupKey(parsed)` → `"<run_slug>#<task_id>"`; `findDuplicates(issues)` → conflicting groups (fail-loud input).
- `canTransition(from, to)` → boolean — label state machine `open → claimed → pr-open → closed` (+ release edge `claimed → open`).
- `validateClaimSettle(issueAfterReread, myActor, existingPrsForTask)` → `won | lost` (the tightened single-assignee + no-existing-PR rule).
- `selectClaimableUnits(issues, mergedTaskIds, planIndexDeps)` → claimable issues (open ∧ deps satisfied ∧ current wave).
- `nextWaveToPublish(issuesByWave)` → wave number, or null if the current wave isn't fully merged.
- `reconcileIntegration(localState, ghIssues)` → ordered write-back actions (idempotent resume — §7.2 step 3).
- `mergeBatchPlan(readyPrs)` → ordered merge list with re-check points (§6).

Sketched fs-only `mp` surfaces (shell passes `gh` JSON in): `mp gh-issue-body`, `mp parse-issue`, `mp validate-claim`, `mp select-claimable`, `mp reconcile-integration`, `mp coord-status`.

### 7.4 Lifecycle: coordinated runs + the `decideNextAction` branch (the MAJOR fix)

A run is **local-execute** (today's path) or **GitHub-coordinated**. Invoking `publish` marks it coordinated by writing a **`coordination` state object** (via an `mp` subcommand — single-writer) holding:

```
coordination:
  mode: github
  contract_ref: mp-coord/<slug>/<plan_hash>   # immutable, tier-1 only
  integration_branch: mp-int/<slug>           # PR base; source only, tier-2 excluded
  local_run_branch: <name>                    # lead-only, NEVER pushed (holds the bundle)
  current_wave: N
  published_waves: [..]
  base_sha_by_wave: { N: <sha>, .. }          # integration-branch HEAD per wave
  issue_map: { <task_id>: { issue: <n>, pr: <n|null>, merge_sha: <sha|null>, status: open|claimed|pr-open|merged } }
```

From then on the lead **does not dispatch waves locally**. `decideNextAction` (`lib/resume.mjs`) gains branches for `phase=execute ∧ coordinated`:

- **current wave has unpublished pending tasks → `publish_needed`** — recover a partial/failed `publish` rather than stranding the run.
- **current wave fully published, tasks pending → `coordinate`** — do exactly two things: **halt local dispatch** (never `dispatch_wave`) and print a terse one-line pointer to `/masterplan next`. It does **not** poll PRs on the tick (that would reintroduce the per-tick nag §7.2 removed) — all PR-surfacing stays in human-invoked `next`/`status`.
- otherwise → existing behavior.

A follower on the lead's machine is just another `follow` session; the lead process never double-builds a published task. This `publish_needed` vs `coordinate` split (Codex MAJOR) prevents the binary switch from stranding partially-published runs.

---

## 8. Concurrency, claiming, and ordering

- **Optimistic claim, tightened (BLOCKER-3 fix).** GitHub assignees are **multi-valued**, so naive assign+relabel can leave two followers both "claimed." Settle therefore requires **all** of: assignees == [me], label == `mp:claimed`, and **no pre-existing open PR for the task**. The lead additionally enforces **one open PR per task** at merge time (close duplicates before merging — §7.2 step 2a).
- **Worst-case outcome, restated honestly.** *With* the tightened settle + lead-side one-PR-per-task dedup: worst case is **duplicated work** (two followers build the same task; the loser's PR is closed unmerged) — never base corruption. *Without* the lead-side dedup-before-merge, two PRs for the same task (same files) could double-merge and corrupt the base — so that guard is load-bearing, not optional. (Draft 1's flat "never corruption" was true only with these guards; they are now explicit.)
- **File-disjoint = textually conflict-free, conditionally (§6).** Within a wave, sequential merges of same-wave PRs are conflict-free **given** declared-scope discipline + the per-merge mergeability re-check.
- **Wave ordering.** The lead publishes wave N+1 only after wave N is fully merged (`nextWaveToPublish`), stamping `base_sha_by_wave[N+1]` to the merged `mp-int/<slug>` HEAD so wave N+1 followers build on merged wave-N work.
- **Liveness / deadlock.** A wave that never fully merges (a task whose followers keep dying) blocks wave N+1. v1 handling: **manual reclaim** (relabel `claimed→open`) surfaced by the `coord-drift` doctor check (§12). Auto-TTL reclaim + heartbeat are deferred (§13) — this is a *known* v1 liveness gap, operator-resolved, not a silent hang.
- **Stale-plan detection.** Each issue body carries `plan_hash`; a follower compares it to the current published `plan.index.json` `plan_hash` (the `mp-coord/<slug>/<plan_hash>` ref name itself encodes it); mismatch → release + resync (re-fetch the contract ref) rather than building stale.

---

## 9. Error handling, failure modes & preflight

**Preflight (both verbs, fail loud — the MINOR fix).** Before any mutation, assert: `gh auth status` OK; the repo grants **write + issues + PR** capability; **label upsert** permission (create the `mp:*` labels if absent); **ref/branch create** permission (for `mp-coord/*` + `mp-int/*`); **rate-limit headroom**; and (follower) a writable **ephemeral bundle path outside tracked `docs/masterplan/`**. Any failure → a clear, actionable error, **not** a silent no-op.

- **`gh` missing / unauthed / no remote → FAIL LOUD.** Unlike report-only `summarizePr` (best-effort silent skip), `publish`/`follow` *require* `gh` — it is the mechanism.
- **Claim race →** tightened settle (§8); worst case duplicate work.
- **Orphan claim** (follower dies after claim, before PR): issue sits `mp:claimed`, no PR. **v1: manual reclaim** (relabel `claimed→open`), surfaced by `coord-drift` (§12). Auto-TTL deferred (§13).
- **Stale plan →** `plan_hash` mismatch → release + resync (§8).
- **Verification failure in a follower →** no non-draft PR; surface on the issue + release (§7.1).
- **Duplicate issue on re-`publish` →** fail loud (§7.1), never silent-update.
- **Merge-time conflict / un-mergeable after a prior merge →** the per-merge re-check (§7.2 step 2a) catches it; that PR is skipped + surfaced, not force-merged.
- **Crash between remote merge and local write-back →** idempotent resume reconciliation (§7.2 step 3).
- **Semantic conflict between disjoint files →** caught at verification/review, same as today (§6).
- **Wave-ordering violation →** structurally prevented (`nextWaveToPublish`).

---

## 10. Trust & lead model

A **trusted fleet**: cooperating LLM sessions under one operator, all with write access to one repo. Consequences that simplify v1:

- No fork isolation, no PR sandboxing, no adversarial-diff defense.
- Claims assumed honest (the settle protocol guards *races*, not *malice*).
- **Same-repo branches only** (no cross-fork PRs in v1 — resolves former open-Q5).
- **Single lead per run**, operator-enforced. Nothing in v1 prevents two leads integrating the same run; a multi-lead lease/heartbeat is the deferred remainder of Guard D (§13). The lead's single-writer commits to one local (never-pushed) bundle make a *second* lead an operator error, not a corruption-by-design.

If this ever opens to untrusted contributors, that is a different, larger design (sandboxed CI, required reviews, fork-based PRs) — explicitly **not** this spec.

---

## 11. The verb-sync burden (anti-pattern #4 — corrected per fact-check)

Adding a verb requires syncing the **documentation/prose surfaces**; the test then **auto-derives** the verb list from `commands/masterplan.md`:

1. `commands/masterplan.md` frontmatter `description:` (line 2)
2. `commands/masterplan.md` §1 reserved-verbs list (+ arg-precedence)
3. `commands/masterplan.md` §3 routing table
4. `README.md` verb table
5. `docs/verbs.md`

**Corrections vs draft 1 (verified against live code):**
- **No `RESERVED_VERBS` constant exists in `lib/hygiene.mjs`.** The list is parsed dynamically by `parseReservedVerbs(commands/masterplan.md)`; `test/publish-hygiene.test.mjs` calls that parser and asserts the set — so updating `commands/masterplan.md` (1–3) is what the test keys off; there is **no hygiene.mjs constant to edit**.
- **`docs/internals.md` has no verb routing table** (it has a module/“Core Mechanisms Map”), so it is **not** a verb-sync location.
- The project `CLAUDE.md` anti-pattern #4 currently *overstates* this (it names `RESERVED_VERBS` and `docs/internals.md`). **The planner should treat the live code as ground truth and may fix the `CLAUDE.md` text** as part of this work.

Two new verbs (`publish`, `follow`) ⇒ this prose sync is paid twice (~5 locations each) + the hygiene test updates its expected set. The plan phase must budget tasks for it.

---

## 12. Testing strategy

- **Pure unit tests (the bulk)** for `lib/github-coord.mjs`: issue-body round-trip (`issueBodyForTask`↔`parseIssueBody`), `dedupKey`/`findDuplicates`, `canTransition` (legal/illegal/release edges), `validateClaimSettle` (the single-assignee + no-existing-PR rule — won/lost), `selectClaimableUnits`, `nextWaveToPublish` (blocks until wave fully merged), **`reconcileIntegration`** (merged-not-marked → write-back; marked-not-merged → surface; idempotent on re-run), `mergeBatchPlan` (ordering + re-check points). No network — the shell supplies `gh` JSON, exactly like `summarizePr`.
- **`mp` wrapper tests** for the fs-only transforms (input JSON → normalized output).
- **`coord-drift` doctor check** (light, v1): for a coordinated run, flag (WARN) issues for already-`done` tasks still open, `mp:claimed` issues with no PR (orphan claims — §8), and `published_waves`/`issue_map` drift vs the plan. Wired into `bin/doctor.mjs` + a test (the doctor-check sync of anti-pattern #4).
- **Manual integration smoke (the acceptance gate, CD-3).** Unit tests can't exercise real `gh`/PR flow, so v1 acceptance is a manual smoke: `publish` a real run (provisions both refs), `follow` it from a second session/machine, open + merge a PR through the §7.2 protocol, kill a follower mid-build to exercise orphan-reclaim, crash between merge and write-back to exercise resume reconciliation, and confirm wave advance. "Should work" is not evidence.

---

## 13. v1 scope vs deferred phases

**In v1 (the walking skeleton):**
- `publish` (provision `mp-coord` ref + `mp-int` branch on first call; current wave → issues + labels + contract pin), `follow` (tightened claim → build via existing machinery → PR against `mp-int`), integration via the existing `next`/`status` loop + the atomic/idempotent §7.2 write-back protocol.
- `lib/github-coord.mjs` pure logic + fs-only `mp` wrappers.
- Tightened optimistic claim, label state machine, wave-ordered publish, `plan_hash` staleness; the three-tier augment boundary via the **dedicated immutable contract ref `mp-coord/<slug>/<plan_hash>` + separate integration branch `mp-int/<slug>` (tier-2 never pushed)**; declared-scope discipline + per-merge mergeability re-check.
- `coordination` state object + the `publish_needed`/`coordinate` `decideNextAction` branches.
- `coord-drift` doctor check.
- Gated merge; wave-batched **presentation** (kept in v1, deferrable to v1.1 — §5).

**Deferred (named future phases — not designed here):**
- **CI-native automation** (approach B): GitHub Actions drive claim/verify/merge.
- **Coordinator daemon** (approach C): a long-lived assigner.
- **Tiered / auto-merge** (the speed path): trusted auto-merge of green PRs.
- **Auto-TTL stale-claim reclaim** + **cross-machine heartbeat / multi-lead lease** (the rest of concurrency-guards Guard D).
- **Untrusted / open contribution** (fork isolation, sandboxed CI, required reviews).

---

## 14. Resolved design decisions (formerly open questions)

The Codex review flagged that these are load-bearing prerequisites, not polish, so they are **resolved** rather than left open.

1. **Contract ref / PR base — DECIDED (user gate, 2026-05-31): Option B — dedicated immutable contract ref + separate integration branch.** The contract is published as `mp-coord/<slug>/<plan_hash>` (tier-1 only, immutable per `plan_hash`); followers PR against the integration branch `mp-int/<slug>` (source only); the canonical bundle (tier-2) stays on the lead's **local run branch, never pushed** (§4/§7). This is the cleanest tier separation — tier-2 is *structurally absent* from GitHub, not merely guarded — and was Codex's recommendation. **Considered & rejected for v1:** run-branch-as-both-contract-and-base + a bundle-dir guard (simpler, one ref, but leaves tier-2 present-though-guarded on GitHub). The user selected the dedicated-ref model at the design-approval gate; its extra machinery (synthesizing the tier-1 tree, constructing/maintaining the integration branch, and the lead reconciling it into the local run branch — §7.2 step 2d) is accepted.
2. **Coordinated-mode resume — DECIDED: the `decideNextAction` branches** (`publish_needed` + `coordinate`, §7.4), for resume correctness over a bare warn.
3. **Board — DECIDED: labels-only.** GitHub Projects is a deferred visualization nicety.
4. **Issue identity / idempotency — DECIDED: machine-readable body key** `{run_slug, task_id}` (+ `plan_hash`, `base_sha`) parsed from the issue body, queried with explicit `--limit`, fail-loud on duplicates. The human title `T<id>:` is for people, not dedup.
5. **Repo scope — DECIDED: same-repo branches only** in v1 (no fork-based PRs), consistent with the trusted-fleet model (§10).

---

## 15. Summary

GitHub coordination is masterplan's existing shell↔worker contract projected onto GitHub: the **lead** stays the sole writer of the canonical bundle (tier-2 never leaves its **local, never-pushed run branch**) and the sole merge authority; **followers** are stateless wave members in other sessions that claim one task each (tightened single-assignee settle), fetch the contract from an **immutable tier-1-only ref `mp-coord/<slug>/<plan_hash>`**, build it with the existing execute machinery in an ephemeral out-of-tree bundle, and return a PR **against the integration branch `mp-int/<slug>`**; **GitHub Issues/labels/PRs** are the wave-dispatch and delivery channel. Two new verbs (`publish`, `follow`), one new pure module (`lib/github-coord.mjs`), a `coordination` state object with `publish_needed`/`coordinate` resume branches, and reuse of the existing `next`/`mp pr-summary` loop for a gated, atomic, idempotent integration. The plan's declared-file-disjoint wave invariant makes concurrent task PRs textually conflict-free **conditionally** (declared-scope discipline + per-merge re-check); merge stays human-gated; v1 is a trusted-fleet, single-lead walking skeleton with CI/daemon/auto-merge/auto-reclaim/heartbeat/multi-lead-lease explicitly deferred.

---

## 16. Review incorporation (Codex adversarial pass + codebase fact-check → draft 2 → user gate → draft 3)

| Finding | Severity | Resolution |
|---|---|---|
| Tier boundary contradiction (run branch carries `state.yml`) | BLOCKER | Resolved **structurally** (user gate → Option B): dedicated tier-1-only contract ref `mp-coord/<slug>/<plan_hash>` + separate integration branch `mp-int/<slug>`; **tier-2 never pushed** (lead's local run branch only). Bundle-dir guard kept as defense-in-depth (§4/§7/§14.1). |
| Write-back not atomic/idempotent | BLOCKER | §7.2 per-PR protocol (re-read→diff-guard→merge into `mp-int`→fetch+reconcile-into-local-run-branch+ancestor-assert→write+commit) + idempotent resume reconciliation (`reconcileIntegration`). |
| Claim protocol multi-assignee / dual-PR corruption | BLOCKER | §8 tightened settle (single-assignee ∧ no-existing-PR) + lead-side one-PR-per-task before merge; worst-case restated honestly. |
| File-disjoint conflict-free overclaim | MAJOR | §6 made conditional (undeclared/generated/lockfiles, renames, moving base) + declared-scope discipline + per-merge re-check. |
| Guard D not actually closed | MAJOR | §1/§10 narrowed to the follower-fan-out dimension; multi-lead/heartbeat deferred (§13); single-lead v1 assumption stated. |
| `coordinate` strands partial runs | MAJOR | §7.4 `coordination` state object + `publish_needed` vs `coordinate` split. |
| v1 not minimal-correct; §14 are prerequisites | MAJOR | §14 questions resolved; contract-ref taken to the user gate (Option B chosen); wave-batched kept in v1 but flagged deferrable (§5); per-merge re-check kept as load-bearing. |
| Re-publish idempotency fragile | MINOR | §7.1/§14.4 machine-readable body key + `--limit` + fail-loud. |
| Operational prerequisites underspecified | MINOR | §9 preflight (auth, capabilities, label upsert, ref/branch create, rate-limit, ephemeral path). |
| CD-7 terminology conflation | NIT | Terminology note (top) + "single-writer (L1 convention)" used throughout. |
| Fact-check: no `RESERVED_VERBS`; `docs/internals.md` no verb table | — | §11 corrected; planner to fix `CLAUDE.md` anti-pattern #4 text. |
| Fact-check: `mp pr-summary` is the CLI surface for `summarizePr` | — | §5/§7 clarified. |
| **User gate (2026-05-31): contract-ref Option B over A** | DECISION | Drives §4/§7/§14.1/§15: dedicated-ref model, tier-2 structurally absent. |
| **User gate (2026-05-31): wave-batched merge stays in v1** | DECISION | §5/§13: kept, flagged deferrable to v1.1. |
