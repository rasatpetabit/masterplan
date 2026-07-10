# Spec: Reconcile legacy masterplan subagent profiles/models (debt cleanup)

**Slug:** `dispatch-subagent-reconcile`  
**Complexity:** high (topic breadth); **delivery scope:** debt cleanup only  
**Status:** draft for approval  

## Problem

Masterplan’s mp-* agents were migrated to **gateway-routed thin wrappers** (`model: fable` + fail-closed `model_group` lanes). That migration is incomplete on the **host and map surfaces**:

1. **Pi install drift.** `node bin/register-pi-agents.mjs --check` reports **10 drift items**. Installed copies under `~/.pi/agent/agents/` still pin several agents to `litellm/opus-4.8` while canonical `agents/*.md` all declare `model: fable`.
2. **Dead MODEL_MAP entry.** `bin/register-pi-agents.mjs` still maps `opus → litellm/opus-4.8` even though **no** live `agents/mp-*.md` declares `opus`.
3. **Stale agent prose.** `agents/mp-explorer.md` body still says it “Runs on haiku” while frontmatter is `fable` (wrapper model; judgment for other agents is lane-routed).
4. **Tests encode the old dual map.** `test/register-pi-agents.test.mjs` fixtures and assertions still exercise `opus` as a first-class live alias.

This is **not** a redesign of routing (thin wrappers + `model_group` stay). It is the last mile of the incomplete migration so installed profiles and the registration map match the canonical agents.

## Goals

1. Canonical `agents/mp-*.md` model claims (frontmatter + body) are internally consistent with the thin-wrapper design.
2. `MODEL_MAP` contains **only** aliases actually declared by live agents (today: `fable → litellm/fable-5`).
3. After a write-mode register, `register-pi-agents --check` is **green** (0 drift) on this host.
4. Unit tests for registration pass under the fable-only map.

## Non-goals

- Collapsing mp-* agents into pure `dispatch_task` / eliminating by-name profiles.
- Making `dispatch.fabric` the default wave path.
- Removing dual bare + `masterplan:` colon registration.
- Moving agent→class mapping into agent-dispatch policy (`compiled_frontmatter` / recipes).
- Doctor checks, CI wiring, or a broad scrub of workflows/docs beyond what this change forces.
- Changing `model_group` lane names or skynet MCP contracts.
- Re-registering or changing `mp-implementer` on pi (remains in `SKIP_FOR_PI`).

## Design

### Architecture (unchanged)

```
agents/mp-*.md (CC canonical, model: fable)
        │
        │  register-pi-agents (MODEL_MAP swaps model: only)
        ▼
~/.pi/agent/agents/mp-*.md
~/.pi/agent/agents/masterplan:mp-*.md   (colon alias copies)
        │
        │  by-name subagent / CC Agent tool
        ▼
wrapper runs → skynet / gateway calls with model_group
             → policy/dispatch-policy.jsonc resolves the real model
```

The wrapper’s frontmatter `model:` is the **host-executable default for the thin orchestrator**, not the judgment model. Judgment remains on governed lanes (`dispatch-agentic-loop`, `dispatch-planned-execution`, `dispatch-critic`, etc.).

### Change set

| # | Surface | Change |
|---|---------|--------|
| 1 | `agents/mp-explorer.md` | Replace “Runs on haiku …” with accurate thin-wrapper language: cheap read-only recon on the wrapper’s checked-in `fable` default; no gateway judgment lane required for pure fact-gathering. |
| 2 | `bin/register-pi-agents.mjs` | Set `MODEL_MAP = { fable: 'litellm/fable-5' }`. Update header comments that still claim “opus and fable are the only models” / dual-map audit date so they match live agents. |
| 3 | `test/register-pi-agents.test.mjs` | Drop `opus` map assertions and fixtures; use `fable` / `litellm/fable-5` throughout. Keep coverage of: map keys ⊆ declared aliases, colon alias naming, `SKIP_FOR_PI` for `mp-implementer`, drift detection. |
| 4 | Host install | Run `node bin/register-pi-agents.mjs` (write mode) so `~/.pi/agent/agents/` matches canonical+map. Verify with `--check` → 0 drift. |

### Failure / edge cases

- **Unknown alias after prune:** if someone reintroduces `model: opus` in an agent without updating `MODEL_MAP`, `mapModelLine` throws (existing behavior). That is intentional fail-closed.
- **Partial host resync:** write mode is idempotent; re-run is safe. `--check` remains the operator verification command (no new doctor surface in this run).
- **Non-pi hosts:** CC continues to load `agents/` via the plugin loader with bare `fable`; no register step required for CC.

### Verification (CD-3)

1. `node --test test/register-pi-agents.test.mjs` (or project-local test entry if preferred) — all pass.
2. `node bin/register-pi-agents.mjs --check` — exit 0, 0 drift.
3. Spot-check: every `agents/mp-*.md` has `model: fable`; installed bare pi copies have `model: litellm/fable-5`.
4. No requirement to run the full suite unless a local convention demands it for this touch surface; prefer the focused registration test + `--check`.

### Risks

| Risk | Mitigation |
|------|------------|
| Something outside this repo still passes raw `opus` into register | Map throw surfaces it; out of scope to hunt other repos |
| Host-only resync not committed (user home) | Document in plan step; verify `--check` in the implementing session |
| Explorer wording over-claims a gateway lane | Keep wording to “wrapper default fable; read-only, no model_group judgment” |

## Acceptance criteria

- [ ] `agents/mp-explorer.md` no longer claims haiku (or any model that is not the frontmatter default / an explicit `model_group` lane).
- [ ] `MODEL_MAP` keys are exactly the set of `model:` values used by non-skipped `agents/mp-*.md` (today: `{fable}`).
- [ ] Registration unit tests pass without `opus` fixtures as live requirements.
- [ ] `node bin/register-pi-agents.mjs --check` exits 0 on the implementer’s host after write-mode resync.
- [ ] Diff stays inside the change-set table; no fabric/doctor/policy redesign.

## Assumptions & Open Decisions

| question | decision | rationale | source |
|---|---|---|---|
| Primary outcome? | Finish incomplete migration (keep thin wrappers + model_group) | Collapse-to-dispatch and policy-owned profiles deferred | user-confirmed |
| Done bar? | Debt cleanup only | No doctor/CI/fabric/dual-registration redesign | user-confirmed |
| Surfaces in scope? | Repo agents + MODEL_MAP + tests + host resync | Clear 10-item pi drift; no workflow/doc scrub | user-confirmed |
| Approach? | Strict live-alias map (fable only) | Fail-closed if opus reintroduced without map update | user-confirmed |
| Keep dormant opus mapping? | No | Dead map entries re-create the dual-truth problem | user-confirmed |
| Change agent-dispatch policy? | No | Masterplan-side cleanup only | assumed |
| Expand to workflows/*.js comments? | No | Explicit non-goal this run | user-confirmed |
| mp-implementer on pi? | Still SKIP_FOR_PI | CC-only skynet MCP contract unchanged | assumed |

## Success signal

Operators and orchestrators no longer see **stale opus pi profiles** or **haiku explorer claims** that contradict the post-migration “all wrappers are fable + lane-routed” story. Registration map, tests, canonical agents, and installed pi agents tell the same truth.
