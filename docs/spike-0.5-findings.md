# Spike 0.5 — control-loop findings (throwaway run, real Workflow tool)

**Purpose.** Validate the L1↔L2 cross-boundary control loop against the *live* Workflow
primitive before building layers on it (build step 0.5). The spike code (a 2-agent toy
workflow + a `/tmp` git repo) is throwaway; **these written-down facts are the deliverable.**

**Method.** Drive the loop manually as the L1 shell: launch a real 2-agent `parallel()` wave
whose agents edit files in an isolated `/tmp/mp-spike-repo` git repo (instructed NOT to commit
and NOT to touch state) → kill mid-wave → inspect what a real killed agent left on disk → reconstruct
from a disk state file (NOT `resumeFromRunId`) → reset file-scope → re-dispatch → confirm a single
clean commit. Then separately check the `resumeFromRunId` same-session fast-path.

Status legend: ✅ confirmed · ⏳ in progress · ❓ open.

---

## F1 ✅ — Workflow launch is async and returns two distinct handles

Calling the Workflow tool returns **immediately** (does not block until the run finishes); a
`<task-notification>` arrives on completion. The launch result exposes:

| Handle | Example | Used for |
|---|---|---|
| **Task ID** | `wo5ekfyi0` | `TaskStop` / `TaskGet` / liveness probe |
| **Run ID** | `wf_bb110182-59f` | `resumeFromRunId` (same-session resume) |
| **Transcript dir** | `…/subagents/workflows/<runId>/` | per-agent records (Resolved #5 / R1 telemetry) |
| **Persisted script** | `…/workflows/scripts/<name>-<runId>.js` | `{scriptPath}` re-invocation |

**Implication for L1 (the shell):** `state.yml` must persist BOTH ids — the `wf_…` run id as
`active_run_id` (same-session fast-path) **and** the task id (liveness/stop). The transcript dir
is derivable from the run id. This already refines the plan's single `active_run_id` field into a
small `active_run: { run_id, task_id }` object. [confirm the liveness probe takes task_id — F3]

---

## F2 ✅ — a real killed agent leaves uncommitted edits and does NOT commit (safety-critical)

Killed the wave via `TaskStop wo5ekfyi0` (returns `task_type: local_workflow`, success). Frozen state:
- **`git log` = only `spike baseline`; reflog has no other entry** → neither agent committed, even though
  agent1 had full Bash/git access and had finished all 8 lines in file1. The no-commit contract holds with
  *real* agents — the empirical basis for Resolved #2's idempotent re-dispatch.
- **`git status` = `M file1.txt`** (agent1 edits uncommitted; agent2 hadn't started — kill landed ~8s in).
  Exactly the recoverable crash state.
- **Reset recipe works**: `git checkout -- . && git clean -fd` restored baseline (file1 = `baseline file1`,
  status clean). This IS the crash-recovery reset the shell runs before re-dispatch.

## F3 ✅ — liveness after stop: the task is ABSENT, not "stopped"

`TaskGet wo5ekfyi0` after the stop → **"Task not found"**. A dead run is *absent* from the registry, not a
queryable "stopped" status. **Absence is ambiguous** — completed-and-reaped, stopped, or never-existed all
look identical. So the shell cannot decide done-vs-dead from liveness alone; it must consult **the disk**
(was the digest/result durably recorded?) as the tiebreaker. Sharpens Resolved #3 into:
*active_run present & live → wait; active_run absent → check disk: results recorded → process; not recorded → reset + re-dispatch.*

## F-records ✅ — per-agent records exist, but cost fields are NOT in the cheap metadata

Transcript dir `…/subagents/workflows/<runId>/` held, per agent: `agent-<id>.jsonl` (29–96 KB full transcript —
do NOT Read wholesale, context overflow) + `agent-<id>.meta.json` (**33 B, only `{"agentType":"workflow-subagent"}`**)
+ a workflow-level `journal.jsonl`. **Cost telemetry (model/tokens/duration) is NOT in `.meta.json`** → it lives
inside the big `.jsonl`. Confirms **R1 is real**: harvesting per-agent cost in step 4 means parsing JSONL, not
reading a clean field — re-evaluate the ≤150-line-hook option (Resolved #5).

## F6 ✅ (from journal structure) — resume caches RETURN VALUES, not side effects → disk-reconstruct is primary

The killed run's `journal.jsonl` held only `{"type":"started","key":"v2:<hash-of-agent-call>","agentId":…}` per
agent — **no `"completed"`/result entries** (killed first). Two consequences, both validating the plan:
1. The resume cache is keyed on a hash of the `(prompt, opts)` agent call and only hits once an agent
   **completes and journals its result**; a killed-mid-flight agent re-runs on resume.
2. **The journal records agent return values, never their side effects** (file edits, commits). agent1's file1
   edits happened on disk yet appear nowhere in the journal. So after a crash-recovery *reset* (mandatory — F2),
   `resumeFromRunId` would replay cached *digests* without re-applying the *edits* — a resumed run would believe a
   "completed" agent succeeded while its file changes are gone.

⇒ **`resumeFromRunId` is safe only as a same-session fast-path when the worktree was NOT disturbed; after any reset,
the correct path is a full fresh re-dispatch (disk-reconstruct).** Exactly the plan's L1↔L2 premise — now evidence-backed.

## F4 ✅ — completion re-invocation delivers the digest (and cost) inline

The clean run completed and re-invoked me via a `<task-notification>` carrying, inline:
- `<status>completed</status>` + `<result>{"wave":[{…},{…}]}</result>` — **the workflow's return value (the
  schema-validated digests) is in the notification itself.** The shell reads the digest directly; no result-file read.
- `<usage><agent_count>2</agent_count><subagent_tokens>46462</subagent_tokens><tool_uses>10</tool_uses><duration_ms>47076</duration_ms></usage>`
  — **aggregate cost telemetry is delivered natively at the boundary.** So: aggregate cost = free (notification);
  per-agent breakdown = JSONL parse. Resolved #5's hook may be unnecessary for aggregate cost entirely.

## F5 ✅ (by construction) — L2 commits zero times; the single commit is L1's

Both clean-run digests reported `committed:false`, matching F2 and the journal (no commit entries). The wave
returns digests; the orchestrator (L1) is the only thing that commits, once, post-barrier. The single-commit
invariant holds because L2 structurally never commits — confirmed, not assumed.

## F6 ✅ — the journal caches the RESULT object, keyed by agent-call hash (no side-effect replay)

The completed run's `journal.jsonl` added, per agent, `{"type":"result","key":"v2:<same hash>","agentId":…,"result":{…digest…}}`
alongside the earlier `"started"`. So `resumeFromRunId` returns these cached `result` objects for matching
`(prompt,opts)` calls and skips re-running them ("completed agents return cached results", per the tool) — but it
replays **return values only, never the file edits/commits those agents made**. Therefore resume is a valid
same-session fast-path ONLY when the worktree is undisturbed; after a crash-recovery reset, a full fresh re-dispatch
(disk-reconstruct) is mandatory. *(Characterized from the journal + the tool's documented contract; a live
`resumeFromRunId` spot-check is deferred to step 2 — no new information expected.)*

## F-SCOPE 🚨 — agents do NOT reliably honor an out-of-cwd file path (new, design-changing)

Both runs told agent2 to edit `/tmp/mp-spike-repo/file2.txt` (absolute). It instead edited
**`/srv/dev/ras/masterplan/file2.txt` — the orchestrator's cwd (the main repo working tree)** — while agent1 obeyed
its `/tmp/…` path. Non-deterministic: agents anchor to the orchestrator cwd and may ignore an out-of-cwd absolute
target. The stray file was untracked and has been removed; `main` is pristine (only the user's `M WORKLOG.md`).

Implications (hardening, mostly for `mp-implementer` + the L2 engine):
1. **The run's cwd must BE the target worktree.** In real masterplan use cwd == the repo being worked on, so this
   is naturally satisfied; the spike only tripped it by targeting a *different* dir than cwd. Never dispatch an
   implementer against an out-of-cwd path and trust it to comply.
2. **File-scope cannot rely on agent obedience.** Post-barrier, the shell must diff `git status` and assert only the
   task's *declared* files changed; out-of-scope or out-of-tree writes → reject + reset + re-dispatch (or escalate).
3. **Crash-recovery reset must target ACTUAL touched paths** (`git status`/`clean`), not only declared scope, since a
   misbehaving agent can write outside its declared files.

---

## Architecture deltas (fold into plan / mp-implementer / lib designs)

- **D1 (F1):** `state.yml.active_run_id` → `active_run: { run_id, task_id }` — need the run id (resume) AND task id (liveness/stop).
- **D2 (F3):** liveness alone is insufficient (absence is ambiguous); `decideNextAction` consults disk for "results recorded?" as the done-vs-dead tiebreaker.
- **D3 (F4):** L1 reads the completion digest from the `<task-notification>` `<result>` inline; no result-file read.
- **D4 (F4/F-records):** aggregate cost from native `<usage>`; the telemetry hook is likely unnecessary for aggregate cost — keep only if a per-agent breakdown is required (then parse JSONL).
- **D5 (F6):** `resumeFromRunId` = fast-path only; disk-reconstruct is primary (now evidence-backed).
- **D6 (F-SCOPE) 🚨:** add a file-scope guard to the L2 engine + `mp-implementer` invariants — run in the target cwd, verify post-barrier that edits stayed within declared scope, reset on violation.

## Deferred (no silent caps)
- Live `resumeFromRunId` spot-check → step 2 (behavior already characterized; documented contract).
- Per-agent cost-field extraction from `agent-*.jsonl` → step 4 (Resolved #5 / R1), now scoped to "parse JSONL" since `.meta.json` lacks cost.

## Throwaway artifacts (discarded)
`/tmp/mp-spike-repo` (left in place — the sandbox declined the `rm -rf`; harmless, outside any tracked repo, safe to delete manually); the two persisted spike workflow scripts under the session `workflows/scripts/` dir (out-of-repo session artifacts, harmless).
