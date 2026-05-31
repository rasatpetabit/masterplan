# GitHub Coordination for masterplan — v1 Design Spec

**Status:** Draft for review (brainstorm phase)
**Date:** 2026-05-30
**Bundle:** `docs/masterplan/github-coordination/`
**Complexity:** high · **Autonomy:** full · **Planning mode:** auto
**Scope of this spec:** v1 walking skeleton only. Named follow-on phases are listed in §13; they are explicitly out of scope here.

---

## 1. Problem & motivation

masterplan today coordinates exactly **one** orchestrator through a single local run bundle (`docs/masterplan/<slug>/`, with `state.yml` as the CD-7 source of truth). All execution happens on one machine: the shell dispatches waves to local subagents, marks tasks done, and commits — serially, in one session, bounded by one context window.

This is the ceiling we want to lift. We want **many** LLM sessions — potentially across machines — to collaborate on the *same* development effort, so a large plan can be worked in parallel by a fleet rather than one orchestrator. The coordination substrate for that fan-out should be **GitHub** (Issues, PRs, labels) rather than a single local directory, because GitHub already provides the durable, network-visible, multi-writer primitives a fleet needs.

This is the answer to the deferred **Guard D** (cross-machine coordination) named in `docs/masterplan/concurrency-guards/spec.md`. It is also dogfooding: we are using masterplan to design a masterplan feature.

**From-state:** single orchestrator, local-only bundle, serial wave dispatch, one context window.
**To-state:** a **lead** orchestrator that projects its plan onto GitHub, plus any number of **followers** (other LLM sessions/machines) that claim individual units of work, build them, and deliver them back as PRs — while the lead's local bundle stays the canonical record.

---

## 2. Goals & non-goals

**Goals**

- **Speed via parallelism.** Multiple followers build different tasks of the same wave concurrently.
- **Durability & visibility.** Work-in-flight is visible on GitHub (issues/labels/PRs), not trapped in one session's context. A dead follower loses only its own in-flight task, not the run.
- **Quality at scale.** The plan's existing guarantees (file-disjoint waves, per-task verification, gated review) survive the fan-out unchanged.

**Non-goals (v1)**

- **Not open contribution.** This is a **trusted fleet** of cooperating LLM sessions under one operator — *not* a public, adversarial PR pipeline. No fork isolation, no untrusted-PR sandboxing, no CI-enforced gating of malicious diffs. Claims are assumed honest.
- **Not auto-merge.** Merge stays **gated** (see §5). The lead surfaces ready PRs; a human (or the lead at a human-authorized gate) merges.
- **Not infrastructure.** No CI-native automation, no coordinator daemon, no GitHub Projects automation, no auto-reclaim TTL. Those are named deferred phases (§13).

---

## 3. The spine: this is masterplan's existing contract, lifted across the network

The central design tension is **CD-7** (the shell is the *sole* state writer) versus **multi-agent scaling** (many sessions doing work). The resolution is that the feature is not a new architecture — it is masterplan's **existing shell↔worker contract projected onto GitHub**:

| masterplan today (local) | GitHub coordination (v1) |
|---|---|
| The **shell** — sole CD-7 writer, owns git | The **lead** — sole CD-7 writer of the canonical bundle, owns merges |
| **Wave members** — stateless, return digests, never write state | **Followers** — stateless per task, return a PR, never write the canonical state |
| **Wave dispatch** (`§2a`) hands a wave's tasks to the L2 engine | **`publish`** projects a wave's tasks as GitHub Issues |
| Agent returns a **digest**; shell records + commits | Follower opens a **PR**; lead merges + records + commits |

So followers are wave members that happen to run in other sessions/machines, and GitHub Issues are the wave-dispatch channel. The lead remains the single writer of `state.yml`; CD-7 is preserved, not bent. This framing is the load-bearing idea of the whole feature — every component below is a direct consequence of it.

---

## 4. The augment boundary (three tiers)

GitHub **augments** the local bundle; it does not replace it. Each artifact lives in exactly one tier:

1. **Immutable contract → PUBLISHED to GitHub (followers' read-only input).**
   `spec.md`, `plan.index.json`, `plan.md`. These are the published contract a follower builds against. They are already committed to the run branch by the normal masterplan plan flow; `publish` only ensures they are pushed to a ref followers can fetch. Followers treat them as read-only.

2. **Mutable canonical state → LOCAL to the lead (CD-7 intact).**
   `state.yml`, `events.jsonl`. Never published, never written by a follower. The lead is the sole writer, exactly as today. This is what keeps CD-7 true across the fan-out.

3. **Coordination projection → NATIVE GitHub.**
   Issues, labels, PRs. The ephemeral, multi-writer coordination layer. It is *derived from* tier 1 and *drives updates to* tier 2, but is itself owned by GitHub's native concurrency primitives (assignees, label edits, PR state).

The invariant: **tier 2 is never on GitHub; tier 1 is never written by a follower; tier 3 is never the source of truth** (it is reconciled back into tier 2 by the lead on merge).

---

## 5. Merge policy: gated, no auto-merge (a deliberate revision of the standing rule)

The standing masterplan rule is "**never auto-merge**" (PR-awareness is report-only; merge happens only at the `branch_finish` gate or by the user on GitHub — see `lib/finish.mjs:summarizePr` and the v8 plan). This spec **keeps that rule verbatim**: followers' PRs are *surfaced*, never auto-merged.

The lead's role at merge time is to **surface a wave's ready PRs** (via the existing `summarizePr` machinery) and let a human — or the lead acting at a human-authorized gate — merge them. To keep the gated path from becoming a per-PR clicking chore, the lead **batches** a wave's ready PRs into one merge pass: it presents all green/mergeable PRs for the current wave together, the human approves the batch, and the lead merges them in sequence (file-disjoint within a wave ⇒ the sequential merges never textually conflict — see §8).

This is the one place we are *revising* a standing rule's framing (single-machine → fleet), so it is called out explicitly rather than buried: **merge authority stays human-gated; only the number of PRs flowing into that gate changes.**

---

## 6. Claim grain: one task = one Issue = one PR

The claimable unit is **a single plan task** (the finest grain). One task → one GitHub Issue → one follower → one PR.

**Why the finest grain.** Same-wave tasks are validated **file-disjoint** by `verify-scope` / `validate-plan-index` (the wave invariant). Task grain is the *only* grain that cleanly inherits this property: two followers building two tasks of the same wave touch disjoint files, so their PRs are **textually** conflict-free by construction. Coarser grains break this — a *subsystem* spans multiple waves and is not guaranteed disjoint; a *wave* as one unit kills the parallelism we are building this for.

**Honest scope of the guarantee.** File-disjointness makes concurrent task PRs *textually* conflict-free. It does **not** add any new *semantic*-conflict guarantee: two disjoint files can still be logically incompatible. This is exactly the same semantic-conflict risk the current single-machine wave model already carries — no regression, but also not a new promise. Semantic conflicts surface where they always have: at verification and review.

**The grain × gated-merge tension (and its mitigation).** Finest grain maximises parallelism but maximises PR count, which would load the gated merge. Mitigation: the **wave-batched merge** of §5 — the lead collapses a wave's N ready PRs into one approval + sequential-merge pass, so merge effort scales per-*wave*, not per-*PR*.

---

## 7. New surface area

### 7.1 Two new verbs (`publish`, `follow`)

Both follow the established v8 layering: the **shell** (`commands/masterplan.md`) sequences `gh`/`git` calls (shell owns git/gh; `bin` is fs-only); pure decisions live in `lib/github-coord.mjs`; `bin` exposes thin fs-only transforms.

**`publish`** *(lead → GitHub).* Projects the **current wave only** of an already-planned run onto GitHub:
- For each task in the wave with no existing issue: `gh issue create` with a body serialized by `lib/github-coord.mjs` (task id, file scope, `verify_commands`, deps, wave, `plan_hash`, `base_sha`, and a pointer to the published contract ref + path). Labels: `mp:run-<slug>`, `mp:wave-N`, `mp:open`.
- Ensures the contract (tier 1) is pushed to the ref followers fetch, stamped with the current run-branch HEAD as `base_sha`.
- **Idempotent.** Re-running `publish` for a wave finds existing run issues (by `mp:run-<slug>` label + deterministic task-id title prefix) and updates rather than duplicating.
- Publishes wave **N+1 only after wave N is fully merged** (wave ordering — §8), so wave N+1 issues carry a `base_sha` that already includes wave N's merged work.

**`follow`** *(a session → follower).* Claims and delivers one unit:
1. **Claim** (optimistic — §8): pick a claimable issue, `gh issue edit --add-assignee @me`, relabel `mp:open → mp:claimed`, re-read to settle. Lost race → release (`mp:claimed → mp:open`, drop self-assignment) and pick another.
2. **Build** via the **existing execute machinery**: seed an **ephemeral local bundle** (a throwaway, *not* the canonical bundle, kept outside tracked `docs/masterplan/`) from the fetched contract, scoped to the single claimed task; run the normal `mp-implementer` dispatch + `verify-scope` (D6) + `verify_commands` against `base_sha` on a branch `mp/<slug>/t<id>`.
3. **Deliver**: open a PR with `Closes #<n>`; relabel `mp:claimed → mp:pr-open`. The ephemeral bundle is discarded — the canonical state is the lead's.

### 7.2 Integration: no new verb (reuse the existing loop)

Integration reuses the v8 **`next`/`status`** report verbs and `summarizePr` — the manual-tick model, deliberately kept **out of** the per-resume `decideNextAction` loop (per the v8 PR-awareness decision: a "merge it" nag on every tick is the exact over-asking we already removed). The lead's loop:

1. `next`/`status` lists the run's `mp:pr-open` issues, runs `gh pr list` + `summarizePr` per PR, and surfaces the **wave-batched** set of ready (mergeable) PRs.
2. Human merges the batch (gated — §5). The lead runs `gh pr merge`, which closes the linked issue.
3. **Write-back (CD-7):** for each merged task the lead — the sole writer — runs `mp mark-task --status=done` + `mp event`, then commits. This is the tier-3 → tier-2 reconciliation.
4. When **all** of the current wave's issues are merged/closed, the lead runs `publish` for wave N+1.

### 7.3 New pure module `lib/github-coord.mjs` (unit-tested)

All coordination *logic* is pure and lives here; `gh`/`git` stay shell-side; `bin` wrappers are fs-only thin transforms. Sketched surface:

- `issueBodyForTask(task, { specRef, planIndexPath, baseSha, planHash })` → issue-body string (serialize).
- `parseIssueBody(body)` → structured task contract (deserialize).
- `canTransition(from, to)` → boolean — the label state machine `open → claimed → pr-open → closed` (+ the release edge `claimed → open`).
- `arbitrateClaim(issueAfterReread, myActor)` → `won | lost` — optimistic settle.
- `selectClaimableUnits(issues, mergedTaskIds, planIndexDeps)` → claimable issues (open, deps satisfied, current wave).
- `nextWaveToPublish(issuesByWave)` → wave number, or null if the current wave isn't fully merged.

Sketched fs-only `mp` surfaces (shell passes `gh` JSON in, gets a pure transform out): `mp gh-issue-body`, `mp parse-issue`, `mp arbitrate-claim`, `mp select-claimable`, `mp coord-status`. (Final names settled in the plan phase.)

### 7.4 Lifecycle change: coordinated runs execute via publish+integrate

A run is either **local-execute** (today's path) or **GitHub-coordinated**. Invoking `publish` on a planned run marks it coordinated (a `coordination: { mode: github }` field, written via an `mp` subcommand — CD-7). From then on the lead **does not dispatch waves locally**; execution is driven by publish → (followers build) → integrate. A follower running on the lead's own machine is just another follower (a separate `follow` session) — the lead process itself never double-builds a published task.

Because a coordinated run's tasks sit `pending` while followers work, the resume controller must not mistake that for "go build locally." `decideNextAction` gains one branch: **phase=execute + coordinated + tasks pending → a `coordinate` action** that does exactly two things — **halts local dispatch** (never `dispatch_wave`) and prints a terse one-line pointer to `/masterplan next` for the integration view. Crucially, the `coordinate` action **does not poll PRs on the resume tick** — that would reintroduce the per-tick "merge it" nag §7.2 deliberately removed. All PR-surfacing stays in the human-invoked `next`/`status` verbs. This is the minimal change that keeps `resume` correct for a coordinated run. (Alternative lighter approach in §14 open questions.)

---

## 8. Concurrency, claiming, and ordering

- **Optimistic claim protocol.** `gh issue edit --add-assignee @me` + relabel `open→claimed`; re-read; if assignee is me and label is still mine → won; else → release and retry. No lock, no daemon.
- **Worst-case race outcome.** Two followers both pass the settle in a tiny window → both build task *t* → two PRs for `#n`. The lead merges one and closes the other as a duplicate. Worst case is **duplicated work, never corruption** — acceptable for a trusted fleet.
- **File-disjoint = textually conflict-free PRs.** Within a wave, sequential merges of same-wave PRs never textually conflict (§6). Across waves, ordering is enforced: the lead publishes wave N+1 only after wave N is fully merged, and stamps `base_sha` accordingly so wave N+1 followers build on top of merged wave-N work.
- **Stale-plan detection.** Each issue body carries the `plan_hash` of the plan it was published from. A follower compares it to the current published `plan.index.json` `plan_hash`; mismatch → release the claim and resync (re-fetch the contract) rather than building against a stale plan.

---

## 9. Error handling & failure modes

- **`gh` missing / unauthenticated / no remote → FAIL LOUD.** Unlike report-only `summarizePr` (best-effort, silent skip), `publish`/`follow` *require* `gh` — it is the coordination mechanism. Absence is a hard, clearly-messaged error, not a silent no-op.
- **Claim race →** settle protocol (§8); worst case duplicate work.
- **Orphan claim** (follower dies after claiming, before PR): the issue sits `mp:claimed` with no PR. **v1: manual reclaim** — a human or the lead relabels `claimed→open`. (Auto-TTL reclaim is deferred — §13.)
- **Stale plan →** `plan_hash` mismatch → release + resync (§8).
- **Verification failure in a follower →** the follower does **not** open a PR (or opens a draft and surfaces the failure on the issue); the claim is released or left for reclaim. Failures never silently merge.
- **Semantic conflict between disjoint files →** caught at verification/review, same as today (§6); no new guarantee, no new silent-merge risk.
- **Wave-ordering violation →** prevented structurally: `nextWaveToPublish` refuses to publish wave N+1 until wave N is fully merged.

---

## 10. Trust model

A **trusted fleet**: cooperating LLM sessions under one operator, all with write access to one repo. Consequences that simplify v1:

- No fork isolation, no PR sandboxing, no adversarial-diff defense.
- Claims are assumed honest (the settle protocol guards *races*, not *malice*).
- PRs target branches in the same repo (no cross-fork flow in v1).

If this ever opens to untrusted contributors, that is a different, larger design (sandboxed CI, required reviews, fork-based PRs) — explicitly **not** this spec.

---

## 11. The verb-sync burden (anti-pattern #4 — flagged for the plan phase)

Each new verb must be synced across **seven** locations or autocomplete / the hygiene test break:

1. `commands/masterplan.md` frontmatter `description:` (line 2)
2. §1 reserved-verbs list + arg-precedence
3. §3 routing table
4. `README.md` verb table
5. `docs/verbs.md`
6. `docs/internals.md` routing table
7. `RESERVED_VERBS` in `lib/hygiene.mjs`

Plus `test/publish-hygiene.test.mjs` asserts the consistency. Two new verbs (`publish`, `follow`) ⇒ this sync is paid twice. The plan phase must budget tasks for it explicitly.

---

## 12. Testing strategy

- **Pure unit tests (the bulk)** for `lib/github-coord.mjs`: issue body round-trip (`issueBodyForTask`↔`parseIssueBody`), the `canTransition` state machine (legal + illegal edges + release), `arbitrateClaim` (won/lost), `selectClaimableUnits` (open + deps-satisfied + current-wave filtering), `nextWaveToPublish` (blocks until wave fully merged). These need no network — the shell supplies `gh` JSON, exactly like `summarizePr` today.
- **`mp` wrapper tests** for the fs-only transforms (input JSON → normalized output).
- **Doctor check** (light, v1): a `coord-drift` module flagging, for a coordinated run, issues for already-`done` tasks still open, or `mp:claimed` issues with no PR (WARN). Wired into `bin/doctor.mjs` + a test (anti-pattern #4 doctor-check sync).
- **Manual integration smoke (the acceptance gate).** Unit tests can't exercise real `gh`/PR flow, so v1 acceptance is a manual smoke: `publish` a real run, `follow` it from a second session/machine, open + merge a PR, confirm the lead's write-back + wave advance. This is the honest proof; "should work" is not evidence (CD-3).

---

## 13. v1 scope vs deferred phases

**In v1 (the walking skeleton):**
- `publish` (current wave → issues + labels + contract push), `follow` (claim → build via existing machinery → PR), integration via the existing `next`/`status` loop + `summarizePr` write-back.
- `lib/github-coord.mjs` pure logic + fs-only `mp` wrappers.
- Optimistic claim, label state machine, wave-ordered publish, `plan_hash` staleness check, three-tier augment boundary.
- The `coordinate` decide branch + `coordination` state field.
- Light `coord-drift` doctor check.
- Gated, wave-batched merge.

**Deferred (named future phases — not designed here):**
- **CI-native automation** (approach B): GitHub Actions drive claim/verify/merge.
- **Coordinator daemon** (approach C): a long-lived process assigning work.
- **Tiered / auto-merge** (the speed path): trusted auto-merge of green PRs.
- **Auto-TTL stale-claim reclaim**: automatic release of orphaned claims.
- **Cross-machine heartbeat / liveness** (the rest of concurrency-guards Guard D).
- **Untrusted / open contribution** (fork isolation, sandboxed CI).

---

## 14. Open questions for the review gate

1. **Contract ref.** Publish the contract on the **run branch directly** (simplest; followers fetch it) or a dedicated **`mp-coord/<slug>` coordination branch** (more stable/immutable contract)? *Lean: run branch for v1.*
2. **Coordinated-mode resume.** The full `decideNextAction` `coordinate` branch (§7.4 — correct, slightly larger change) vs a **lighter** approach where coordinated runs are driven only by explicit `publish`/`next` and a bare `resume` just warns "this run is coordinated"? *Lean: the decide branch, for resume correctness.*
3. **Board.** Labels-only (v1) vs a **GitHub Projects** board for visualization? *Lean: labels-only; Projects is a deferred nicety.*
4. **Issue identity / idempotency.** Confirm the dedup key for re-`publish`: `mp:run-<slug>` label + deterministic `T<id>:` title prefix. Acceptable?
5. **Repo scope.** Confirm same-repo branches only in v1 (no fork-based PRs), consistent with the trusted-fleet model.

---

## 15. Summary

GitHub coordination is masterplan's existing shell↔worker contract projected onto GitHub: the **lead** stays the sole CD-7 writer of the canonical bundle and the sole merge authority; **followers** are stateless wave members in other sessions that claim one task each, build it with the existing execute machinery, and return a PR; **GitHub Issues/labels/PRs** are the wave-dispatch and delivery channel. Two new verbs (`publish`, `follow`), one new pure module (`lib/github-coord.mjs`), a small lifecycle branch for coordinated runs, and reuse of the existing `next`/`summarizePr` loop for gated, wave-batched integration. The plan's file-disjoint wave invariant makes concurrent task PRs textually conflict-free; merge stays human-gated; v1 is a trusted-fleet walking skeleton with CI/daemon/auto-merge/auto-reclaim explicitly deferred.
