# v8 parity-dogfood report (clean-core rebuild — plan step 8)

**Date:** 2026-05-29 · **Branch:** `masterplan-ng` @ `561f348` · **Run bundle:** `docs/masterplan/2026-05-29-v8-dogfood/`

This is the gate **before** any v7→v8 cutover merge to `main`. The cutover itself stays **user-gated** and is not started here.

---

## Verdict (read this first)

- **End-to-end dogfood: PASS.** A real 3-task / 2-wave plan ran through the real L1 adapter (`bin/masterplan.mjs`) and the real L2 engine (`workflows/execute.workflow.js`) launched over the **real `Workflow`-tool boundary**. The cutover-blocker (stringified-args → empty wave) is empirically **dead at the production boundary**, not just in unit tests.
- **Token/context budget: PASS.** Deterministic paths spent zero LLM tokens; only digests crossed L2→L1; mid-run compaction resumed from disk.
- **Resume/crash drills: PASS** (Phase A, prior) — reinforced this session by two live disk-resume decisions.
- **ONE residual that blocks the cutover (not wave-2-today):** wave 2 ran with **stand-in agentTypes** (`general-purpose`+`sonnet` implementer, `codex:codex-rescue` reviewer) because the shipped-agent labels `masterplan:mp-implementer` / `masterplan:mp-codex-reviewer` **do not resolve in this session** and **cannot be made to resolve mid-session** (proven below). The real-`masterplan:*`-through-the-engine path therefore stays **untested end-to-end** and must be retired in a **fresh session after a dev-plugin install** before cutover.

---

## (a) Resume / crash drills

- **Phase A (prior session):** crash-and-resume drills against the L0 bundle + `lib/resume.mjs decideNextAction` — PASS (recorded in WORKLOG / state).
- **This session, live evidence:** `decide` is a pure disk read (no LLM). It was exercised twice as the actual loop driver:
  - mid-run, all of wave 1 done + t3 pending → `{"action":"dispatch_wave","wave":2,"tasks":[{"id":3,…}]}`
  - after t3 marked done → `{"action":"complete"}`
  Source of truth is `state.yml` on disk, never orchestrator in-context memory — confirmed because **this very session compacted** (context summary) between waves and the resume decision came straight off disk, unaffected.

## (b) End-to-end dogfood

**Plan** (`plan.index.json`, 3 tasks, 2 waves):
| task | wave | file | routed | codex |
|---|---|---|---|---|
| 1 greet(name) | 1 | `src/greet.mjs` | inline | – |
| 2 farewell(name) | 1 | `src/farewell.mjs` | inline | – |
| 3 conversation(name) = greet+" "+farewell | 2 | `src/index.mjs` | inline (`eligible:false reason:linked-worktree`) | review |

- **≥1 parallel wave:** wave 1 = t1 ∥ t2 (prior session, PASS).
- **≥1 Codex-routed task:** t3 ran with `review:"on"` → the codex reviewer fired (v8's *only* codex path by design — there is no codex-implementer; see engine header).

**Wave 2, this session — real L1→L2 trace** (every L1 op is `node bin/masterplan.mjs …`, i.e. zero LLM tokens):

1. `decide` → `dispatch_wave` wave 2.
2. `prepare-wave --wave=2 --review=on --linked-worktree` → lean routed payload `{wave:2, tasks:[t3…], review:"on"}` (routing resolved in L1; the engine never imports `routing.mjs`).
3. `set-active-run --wave=2` → `{wave:2,phase:"launching"}` (CD-7 phase-1 crash marker).
4. **`Workflow` tool** launched `workflows/execute.workflow.js` with object `args` (the tool **stringifies** them at the boundary; the engine `JSON.parse`s — the fix). `promote-active-run` then attached `{run_id:"wf_2edc51f6-165", task_id:"3"}` (phase-2).
5. Engine returned **digests only**:
   ```json
   {"wave":2,"summary":{"total":1,"done":1,"failed":0,"reviewed":1,"reviewOn":true},
    "tasks":[{"task_id":3,"target":"inline",
      "digest":{"status":"done","start_sha":"561f348…","files_changed":["…/src/index.mjs"],
                "verify":[{"command":"node -e \"…conversation('World')…\"","output":"ok","passed":true}]},
      "review":{"verdict":"inconclusive","findings":"… verdict: PASS — correctly imports greet/farewell, exports conversation(name) … No BLOCKER/MAJOR/MINOR/INFO issues."}}]}
   ```
   `total:1` (not 0) is the headline: the **non-empty wave dispatched over the real tool boundary**.
6. **D6 verify-scope** (`before`/`after` git path-sets captured by the shell, set-diff done in `lib/wave.mjs`): `{"ok":true,"touched":["src/index.mjs"],"outOfScope":[]}` — the wave touched **exactly** the declared scope.
7. `mark-task --id=3 --status=done` → `clear-active-run` → `decide` → `{"action":"complete"}`.

**Engine-created `src/index.mjs`** (matches spec byte-for-byte; verify `output:"ok"`):
```js
import { greet } from './greet.mjs';
import { farewell } from './farewell.mjs';
export function conversation(name) {
  return `${greet(name)} ${farewell(name)}`;
}
```

### Preserved-features comparison vs v7.2.3

Rubric priority (v8 review rubric): **(1) durable on-disk state · (2) token efficiency · (3) context-window mgmt**; reliability/parity rank below.

| Feature | v7.2.3 mechanism | v8 status (this gate) |
|---|---|---|
| Durable run-bundle state | `state.yml` (v5 schema) + `events.jsonl` replay | **Preserved & proven** — `state.yml` (schema 6) is sole truth; resume off disk across a real compaction |
| Resume / crash recovery | resume-first controller + event-log replay | **Preserved & proven** — `decideNextAction` + `active_run` phase-1/phase-2 markers |
| Wave dispatch (parallel) | parallel Agent batch + N-member barrier | **Preserved & proven** — L2 `pipeline()` per-wave; L1 awaits the completion barrier |
| Single-writer / digests-only (CD-7) | orchestrator sole writer; subagents ≤5KB digests | **Preserved & proven** — engine returns digests only, never writes state / never commits; L1 is sole writer+committer |
| Codex review path | `codex:codex-rescue` structured review at B2/B3/C4b | **Preserved (path proven), label residual** — config-gated per-task review; fired on t3; see fail-safe finding below |
| Token / context control | SDD dispatch + digest-only returns | **Preserved & proven** — see (c) |
| Codex-**implementer** write-access hardening | linked-worktree sandbox guard; silent-exit detection + retry streak; protocol-violation post-barrier reclassify (v7 `parts/step-c-dispatch.md`, Doctor #48) | **Deleted by design** — v8 has **no codex-implementer**; Codex is review-only (read-only `timeout codex exec` cannot orphan). Deleting it removes the entire sandbox/silent-exit/empty-diff/orphan series. Parity ranks below the rubric, so this buys nothing the rubric rewards. |
| Verb surface (13 verbs) / doctor checks (53) / telemetry hook | `commands/masterplan.md`, `parts/doctor.md`, `hooks/…` | **Out of scope for this gate** — not re-verified here; tracked by other build steps. Not claimed green. |

## (c) Token / context budget

- **Deterministic paths spend zero LLM tokens — confirmed.** Every L1 operation (`version`, `decide`, `prepare-wave`, `set-active-run`, `promote-active-run`, `verify-scope`, `mark-task`, `clear-active-run`) is a pure `node bin/masterplan.mjs` call — no agent dispatch. The engine's own orchestration (arg-normalization, `pipeline`, logging, summary math) is plain JS — also zero tokens. The **only** token spend was the two `agent()` dispatches: `subagent_tokens: 39388` for 2 agents (1 implementer + 1 reviewer), 8 tool-uses, 160s.
- **Only digests cross L2→L1 — confirmed.** The Workflow return value is the structured digest object above (status, files_changed, verify summary, review verdict/findings, counts). The orchestrator never received `src/index.mjs`'s contents from the engine; it was read separately, only for this report. The L2→L1 channel carried no raw file bodies.
- **Mid-run compaction resumes from disk — confirmed.** This session compacted between waves; on resume, `decideNextAction` reconstructed the next action purely from `state.yml`. In-context memory is not load-bearing for the resume decision.

---

## Findings

1. **`extractVerdict` fail-safe validated (NOT a bug).** The digest's `review.verdict` came back `inconclusive` while the prose said `verdict: PASS`. Root cause: the **stand-in** reviewer `codex:codex-rescue` emitted the off-contract word "PASS". The **real** `agents/mp-codex-reviewer.md:41` contracts the closing line to `verdict: blocking | advisory | clean | inconclusive` — **exactly** `extractVerdict`'s vocabulary. So the engine correctly fell back to `inconclusive` (its documented fail-safe: "no blocking findings, proceed with a logged caveat — NOT a clean pass"). The engine **degraded safely** under a non-contract reviewer; it did *not* read a non-clean review as clean. With the real `mp-codex-reviewer` the closing word would be `clean` and map straight through. → No code change required; this is the residual gap demonstrating itself favorably.
2. **Absolute path in `files_changed` (cosmetic).** The `general-purpose` stand-in returned an absolute path (`/srv/…/src/index.mjs`) though the implementer prompt frames paths as repo-relative. D6 is unaffected (verify-scope uses git's relative path-sets; `touched:["src/index.mjs"]`). The real `mp-implementer` (own system body) may normalize differently. → Minor note; re-check in the fresh-session real-agent run.

## Residual gap that blocks the **cutover** (not wave-2-today)

**Real-`masterplan:*`-resolution-through-the-engine is untested end-to-end.** Wave 2 used stand-ins because:

- **Orchestrator probe:** `Agent({subagent_type:"masterplan:mp-implementer"})` → *"agent type not found. Available: … codex:codex-rescue, … general-purpose, …"* (no `masterplan:*`).
- **Workflow-subprocess probe (the one that actually matters — the engine runs in a separate background subprocess):** a 1-agent Workflow attempting `masterplan:mp-implementer` returned the **identical** available-agents list as the orchestrator. → The subprocess uses the **same session snapshot**, not a fresh disk re-read at launch. **A mid-session dev-plugin install would not register `masterplan:*`.** (cost: 1 agent, 0 tokens, 4ms.)

**Closest-achievable parity ran instead:** real engine · real tool boundary · `implAgentType:'general-purpose'`+`implModel:'sonnet'` (matches `mp-implementer`'s frontmatter model, so token-budget capture is honest) · `reviewAgentType:'codex:codex-rescue'`+`review:'on'` (a real `codex exec`, a different wrapper than `mp-codex-reviewer`). **Residual = agentType *labels* + agent *system bodies* only** — models match and the engine's task-prompts are identical regardless of which agent resolves.

**To retire before cutover:** a **fresh session** with the `masterplan-ng` worktree installed **additively** as a distinct dev plugin (never replacing the shipped `masterplan` entry — that would hijack the user's working `/masterplan` and pre-empt the gated cutover), then re-run wave 2 with the seam args omitted so the real `masterplan:mp-implementer` / `masterplan:mp-codex-reviewer` resolve. Confirm: (i) real-agent dispatch resolves through the engine, (ii) the real reviewer's closing word is `clean` and maps through `extractVerdict`, (iii) `files_changed` path shape.

## Seam status

The L1↔L2 dogfood seam (`implAgentType`/`implModel`/`reviewAgentType`/`reviewModel` reads in `execute.workflow.js`) is **committed (`561f348`) as a prod-inert testability hook**: production L1 never sets those args, so the `masterplan:*` defaults reproduce shipping behavior byte-for-byte. This session is the first real exercise of that seam.
