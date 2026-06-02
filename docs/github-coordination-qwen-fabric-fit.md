# github-coordination ↔ Qwen Work Fabric — fit & gap analysis

> **Status:** analysis only (uncommitted draft). Written 2026-06-01 in response to
> "find the Qwen coding-harness plan in petabit-sysadmin (coordination through
> GitHub issue/PR), test our masterplan code against it, adjust if necessary."
> Whether to *act* on the gap (and where) is an open decision — see §6.

## 1. What the request connects

The request names two halves that map onto two **different** existing artifacts:

| Half of the request | Actual artifact | Coordination substrate |
|---|---|---|
| "a coding harness using Qwen, in petabit-sysadmin" | **Qwen Work Fabric** — `petabit-sysadmin/docs/superpowers/specs/2026-05-31-qwen-work-fabric-design.md` (+ bundle `docs/masterplan/qwen-work-fabric/`, 7/15 tasks done) | **node-local SQLite queue** (`/var/lib/petabit-qwen-queue/queue.db`, WAL, single-writer, epyc1-only) + `qctl` CLI + git worktree branches `qwen/<class>/<task-id>` → `qwen/auto` integration branch. **Deliberately not GitHub** (kept off `/srv/dev` so Syncthing never touches it; no external phone-home dep). |
| "coordination through GitHub issue and PR" | **masterplan's own `github-coordination` feature** — `lib/github-coord.mjs`, six fs-only `mp` subcommands, `publish`/`follow` verbs | **GitHub Issues + PRs**: lead `publish`es a wave's tasks as Issues; followers `follow` (claim 1 Issue → build → 1 PR against `mp-int/<slug>`); lead reconciles + merges (human-gated). |

**Read this as a marriage proposal, not a contradiction.** The Qwen fabric is
SQLite-coordinated by design; "coordination through GitHub issue and PR" is
masterplan's separate, already-shipped capability. The coherent test is:
**can masterplan's github-coordination drive the Qwen harness — i.e. can a Qwen
worker serve as the thing that produces a follower's diff?**

## 2. Test result — masterplan github-coordination as-is

- **Unit suite green.** `node --test test/github-coord.test.mjs` → **53 pass / 0 fail**;
  `node --test test/publish-hygiene.test.mjs` → **18 pass / 0 fail**.
- **Deployment.** Merged to `main` in source (`/srv/dev/masterplan`) and carried by
  the live **8.0.0** plugin cache (the one `mp` resolves to). The feature retro's
  note "not deployed to installed plugin caches" is **stale** — 8.0.0 has it.
- **Standing gap from the retro that is still true:** the feature has **never been
  dogfooded as a live multi-LLM run** — only unit-verified.

## 3. The role mapping (the key insight)

A masterplan **follower** is *not* the worker — it is a full agentic session that,
inside itself, dispatches an **implementer** (`follow` step 3: "dispatch the
existing `mp-implementer` agent + D6 `verify-scope` + `verify_commands`"). The
roles line up as:

| masterplan github-coordination | Qwen Work Fabric | Fit |
|---|---|---|
| **lead** (`publish`, reconcile, gated merge) | Claude curator + `qctl accept` | ✅ same role — orchestrator that dispatches & integrates |
| **follower session** (claim Issue, choreograph GitHub, open PR) | *(no equivalent — fabric has no GitHub actor)* | ⚠️ needs an agentic shim |
| **implementer** (`mp-implementer`, produces the diff) | **Qwen `pi` worker** (bwrap'd, `pi --mode json`, produces a diff in a worktree) | ✅ **this is where Qwen slots in** — same role, different backend |
| **D6 `verify-scope` + `verify_commands`** (git diff ⊆ declared scope ∧ verify rc==0, computed follower-side from filesystem) | **green gate** (git diff ⊆ declared scope ∧ verify rc==0 ∧ lint rc==0, from filesystem ground truth) | ✅ **near-identical philosophy** — both gate on filesystem truth, never the worker's self-report |
| GitHub Issue (dispatch) + PR (delivery) + `mp-int/<slug>` | SQLite queue row + `qwen/<class>/<task-id>` → `qwen/auto` | ⚠️ transport differs by design (GitHub vs node-local SQLite) |

So the green-gate philosophies **align** (this surprised me — the fabric's
"distrust the worker, gate on filesystem" rule is exactly what D6 `verify-scope`
already does). The divergences are narrower than they look:

## 4. The actual gaps ("if necessary")

1. **Implementer dispatch is hard-coded.** `follow` step 3 names `mp-implementer`
   directly; there is **no pluggable implementer-backend seam** (grep of source for
   `qwen` / `implementer-backend` / `pluggable` → nothing). To put a Qwen worker in
   the implementer slot you'd add a backend seam *or* write a follower variant whose
   step 3 dispatches a Qwen worker (via the live `skynet-qwen` MCP or the `pi`
   harness) instead of `mp-implementer`. **This is the one concrete code gap.**
2. **No headless-follower path.** A masterplan follower is a full agentic session
   that does the GitHub claim/PR choreography; a Qwen `pi` worker is a headless
   diff-producer with no agency to touch GitHub. Driving Qwen via github-coordination
   therefore needs an **agentic shim**: a session (Claude, or a thin script) that does
   claim/PR and delegates only code-gen to the Qwen worker. That shim does not exist.
3. **Transport is a deliberate architectural choice, not a defect.** The fabric
   chose node-local SQLite specifically to avoid GitHub/Syncthing/external-dep
   coupling. github-coordination's GitHub transport is the opposite choice. They can
   coexist (Qwen-as-implementer under a GitHub-coordinated follower) but the fabric's
   own design does **not ask** for GitHub — so adopting it is a *new* decision, not a
   fix to either system.

## 5. Honest verdict

masterplan's github-coordination is **sound and unit-green**, and the Qwen worker
maps cleanly onto its **implementer** role with an **already-aligned green gate**.
Nothing is broken. The only thing standing between "tested" and "wired" is (a) a
pluggable-implementer seam (small) and (b) an agentic follower shim (medium) — and
both are **only worth building if the user actually wants the Qwen fabric driven
over GitHub**, which contradicts the fabric's deliberate node-local-SQLite design.
The defensible default is therefore **gap-analysis only**; a code change to shared
masterplan tooling should be an explicit, separately-specced decision.

## 6. Open decision — what "adjust if necessary" should mean

(See the AskUserQuestion that accompanies this doc.)

- **A — Gap analysis only** (no masterplan code change): the models are deliberately
  different; this doc *is* the deliverable; the seam is documented for if/when wanted.
- **B — Add the pluggable-implementer seam** in masterplan source so a Qwen worker
  can be a follower's diff-producer: a real, small feature; its own bundle/branch in
  `/srv/dev/masterplan`, Codex review, no push without approval.
- **C — Dogfood github-coordination live** (close the retro's standing follow-up):
  no new feature, just exercise `publish`/`follow` end-to-end once for real.
- **D — Something else.**
