# Parity Runbook — fresh-session true-parity re-run

**Purpose.** Retire the **one residual** that blocks the v7→v8 cutover: real
`masterplan:*` agents dispatched **through the L2 engine** are untested
end-to-end. The 2026-05-29 wave-2 dogfood proved the full real loop (L1 → real
`Workflow` tool boundary → digest → L1) with **stand-in** agents
(`general-purpose`+`sonnet` implementer, `codex:codex-rescue` reviewer). The
residual is *agentType labels + agent system bodies only* — models match and the
engine's task-prompts are identical regardless of which agent resolves. Full
context: [`parity-report.md`](./parity-report.md). This runbook re-runs wave 2
with the **real** agents so the residual is closed.

**This cannot run in the session that wrote it.** PROVEN (parity-report §residual):
a Workflow **subprocess** registry probe returned the *identical* available-agents
list as the orchestrator → the engine subprocess uses the same session snapshot,
no disk re-read at launch → a **mid-session** dev-plugin install does NOT register
`masterplan:*`. Compaction does not help (same process). A genuinely **fresh
session**, started *after* an additive dev-plugin install, is mandatory.

---

## Preconditions

- [ ] Working in the `masterplan-ng` worktree (`/srv/dev/masterplan/.worktrees/masterplan-ng`), branch `masterplan-ng`, clean except untracked `src/`.
- [ ] `codex` binary present + authed (the real `masterplan:mp-codex-reviewer` runs a synchronous foreground `codex exec`; without it the reviewer returns an inconclusive NOTE, which would *not* close confirmation (ii)).
- [ ] Node ≥ whatever `package.json` engines pins; `node --test test/` green before starting (baseline 239/239).

---

## Step 1 — Additive dev-plugin install (setup; precedes the fresh session)

Install **this worktree** as a **distinct, additive** local/dev plugin so a new
session's agent registry includes `masterplan:mp-explorer / mp-implementer /
mp-planner / mp-codex-reviewer`.

> ⚠️ **Never replace the shipped `masterplan` marketplace entry.** Overwriting it
> hijacks the user's working `/masterplan` (still published **v7.2.3**) and
> pre-empts the user-gated cutover. Install as a *separate* entry alongside it.

This is the one step that needs plugin management (a `/plugin marketplace add`
of the local path + install, or the equivalent local-dev-plugin mechanism) and
must complete **before** the fresh session launches.

## Step 2 — Launch a FRESH session, verify `masterplan:*` registered

In the new session, before anything else, confirm resolution **at both layers**:

1. **Orchestrator layer** — dispatch `Agent({subagent_type:"masterplan:mp-implementer", …})` (a trivial no-op probe). It must NOT error "agent type not found".
2. **Engine-subprocess layer (the one that actually gated this)** — run a 1-agent `Workflow` whose single `agent()` call uses `agentType:'masterplan:mp-implementer'`. It must resolve there too. (Last time this is exactly where it failed — the orchestrator probe is necessary but not sufficient.)

If either probe still shows no `masterplan:*`, STOP — the additive install did not
take; re-do Step 1 and relaunch. Do not fall back to stand-ins (that just
reproduces the existing residual).

## Step 3 — Reset the dogfood bundle to re-run wave 2

Bundle: `docs/masterplan/2026-05-29-v8-dogfood/`. All 3 tasks are currently
`done`; `active_run` and `pending_gate` are already `null`.

1. Edit `state.yml` — flip **only task 3** back to `pending` (leave tasks 1–2 `done`):

   ```yaml
   tasks: [{"id":1,"status":"done","wave":1,"files":["src/greet.mjs"]},{"id":2,"status":"done","wave":1,"files":["src/farewell.mjs"]},{"id":3,"status":"pending","wave":2,"files":["src/index.mjs"]}]
   ```

2. Remove the wave-2 artifact so the implementer recreates it; **keep** the wave-1
   files (task 3 imports them, and the verify command needs them):

   ```bash
   rm -f src/index.mjs        # src/ is entirely untracked (git status -s src/ → "?? src/")
   ls src/                    # expect: farewell.mjs  greet.mjs   (no index.mjs)
   ```

3. `active_run` is already `null` — no `clear-active-run` needed.

`node bin/masterplan.mjs decide --state=docs/masterplan/2026-05-29-v8-dogfood/state.yml`
should now return `{"action":"dispatch_wave","wave":2,…}`.

## Step 4 — Drive wave 2 (L1 command sequence)

`mp = node bin/masterplan.mjs`. State = `docs/masterplan/2026-05-29-v8-dogfood/state.yml`,
plan-index = `…/plan.index.json`.

```bash
# (a) decide → dispatch_wave 2
mp decide --state=$STATE

# (b) resolve wave + routing (L1 pre-resolves; L2 never imports routing.mjs)
mp prepare-wave --state=$STATE --plan-index=$PLAN_INDEX --wave=2 --linked-worktree
#  → {wave:2, tasks:[lean-routed payload for task 3], review:"on"}
#  --linked-worktree because in a worktree git --git-dir ≠ --git-common-dir

# (c) D6 baseline (shell git, store as JSON array $BEFORE):
#     union of:  git -c core.quotePath=false diff --name-only HEAD
#                git ls-files -o --exclude-standard
#     NB: capture AFTER the Step-3 reset, so greet.mjs+farewell.mjs are in
#         $BEFORE and only src/index.mjs reads as "new" → touched=[src/index.mjs]

# (d) phase-1 crash marker
mp set-active-run --state=$STATE --wave=2

# (e) === Workflow tool launch — SEE STEP 5 (the whole point of this run) ===

# (f) phase-2 handles (after the Workflow launches, before awaiting completion)
mp promote-active-run --state=$STATE --run-id=<wf_id> --task-id=3

# --- await Workflow completion notification → receive digest ---

# (g) record digest (task 3 → done), then D6 verify, then clear, then re-decide
mp mark-task --state=$STATE --id=3 --status=done
#     capture $AFTER with the same two git commands as (c):
mp verify-scope --state=$STATE --wave=2 --before='<$BEFORE JSON>' --after='<$AFTER JSON>'
#  → expect {"ok":true,"touched":["src/index.mjs"],"outOfScope":[]}
mp clear-active-run --state=$STATE
mp decide --state=$STATE
#  → {"action":"complete"}
```

## Step 5 — The `Workflow` tool call (SEAM ARGS OMITTED — the whole point)

Launch `workflows/execute.workflow.js` (meta name `masterplan-execute`) with the
`prepare-wave` output, **omitting all four dogfood-seam keys** so the engine's
defaults resolve the real agents:

```jsonc
// args — pass the prepare-wave payload, and DO NOT set any of the seam keys:
{
  "wave": 2,
  "tasks": [ /* lean routed task 3 from prepare-wave */ ],
  "baseline": [ /* the $BEFORE array from Step 4c */ ],
  "repoRoot": "<abs repo root>",
  "review": "on"
  // ❌ OMIT implAgentType    → defaults to 'masterplan:mp-implementer'
  // ❌ OMIT implModel        → mp-implementer frontmatter model governs
  // ❌ OMIT reviewAgentType  → defaults to 'masterplan:mp-codex-reviewer'
  // ❌ OMIT reviewModel      → mp-codex-reviewer frontmatter model governs
}
```

The four seam keys live at `execute.workflow.js:66-69`
(`A.implAgentType ?? 'masterplan:mp-implementer'`, etc.). Production L1 never sets
them; this run must likewise leave them unset. (The engine self-normalizes the
tool-boundary-stringified `args` via `const A = (typeof args==='string') ?
JSON.parse(args) : (args ?? {})` — no action needed.)

## Step 6 — The three confirmations (this is the gate)

1. **(i) Real-agent dispatch resolves through the engine.** The Workflow digest shows the implementer ran as `masterplan:mp-implementer` (not a "agent type not found" error, not a stand-in). `summary.total:1, done:1`.
2. **(ii) Real reviewer closing word = `clean`, maps through `extractVerdict`.** The real `agents/mp-codex-reviewer.md` contracts the closing line `verdict: blocking|advisory|clean|inconclusive`; `extractVerdict`'s regex is `/verdict:\s*(blocking|advisory|clean|inconclusive)/i`. A clean review must surface as `verdict:"clean"` in the digest — **not** `inconclusive` (the stand-in's off-contract `"PASS"` correctly fell back to `inconclusive` last time; that fail-safe is fine, but a real `clean` must now map straight through).
3. **(iii) `files_changed` path shape.** Confirm the real `mp-implementer` returns a **git-relative** path (`src/index.mjs`), not the absolute path the `general-purpose` stand-in returned. Cosmetic only — D6 `verify-scope` uses shell-captured git-relative sets and is unaffected — but worth recording.

## Step 7 — Record + close the residual → cutover unblocked (still user-gated)

When all three confirm:

- Append a "RESIDUAL CLOSED" note to [`parity-report.md`](./parity-report.md) (real-agent run id, the three confirmations with evidence).
- Update plan `/home/grojas/.claude/plans/i-feel-like-we-ve-swift-lampson.md` Build-step 8 status: residual retired.
- Update memory `v8-clean-core-rebuild.md`: drop "ONE residual blocks the cutover" → "parity proven, cutover unblocked (user-gated)".
- The cutover (merge to `main` + version bump + manifest swap + the decided full v7 self-instrumentation removal — see `parity-report.md` / WORKLOG telemetry-gate entry) is now the only remaining v8 work, and it **stays user-gated** — do not start it unprompted.

## Cleanup / rollback

- Re-`done` task 3 in `state.yml` (or restore from git) and recreate `src/index.mjs` if you want the bundle back at its archived state; `src/` is untracked, so nothing leaks into the published tree either way.
- **Uninstall the additive dev plugin** when done so it doesn't linger in the registry. The shipped `masterplan` v7.2.3 entry was never touched.
