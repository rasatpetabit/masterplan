# Plan Compile — Internals

> **Source:** `lib/plan-merge.mjs` (deterministic merge engine), `workflows/plan.workflow.js`
> (L2 parallel-planning fan-out), `agents/mp-spec-decomposer.md`, `agents/mp-planner.md`.
> **Schema version:** `"6.0"` (constant at `lib/plan-merge.mjs:23`).

## Design principle

The LLM never authors the final `plan.index.json` bytes. Subsystem drafters propose task
fragments; deterministic JavaScript (`lib/plan-merge.mjs`) owns global id assignment, wave
computation, codex normalisation, and schema validation. This eliminates two anomaly classes
that plagued earlier designs: (1) the `codex` routing annotation arriving as an object or
boolean instead of the required string enum, silently falling through to the heuristic; and
(2) drafters authoring wave numbers directly, producing scattered single-task waves instead of
maximally-parallel groups.

## Two planning paths

### Serial path

`mp-planner` (opus) reads the approved spec and writes both `plan.index.json` and `plan.md`
directly into the run-bundle directory. It is the sole producer in this path — it emits the
tasks array with `id`, `wave`, and `codex` already set. `validatePlanIndex` is still run by
L1 after the planner returns to catch any silent-fallthrough trap violations before the plan
is accepted. L1 is the single durable state writer (CD-7); `mp-planner` writes only the plan
artifacts.

### Parallel path

Used when `mp-spec-decomposer` (opus) returns `recommend_parallel: true` and the config
`planning.mode` is `auto` or `parallel`, with ≥ 2 subsystems in the decomposition.

**Step 1 — Decompose.** `mp-spec-decomposer` reads the spec and carves it into a list of
subsystems — each a file-disjoint, coherent responsibility slice — and emits a digest of the
form `{ subsystems: [...], recommend_parallel: bool, reason: string }`. It does not plan
tasks. Its subsystem list is the seam map the fan-out drives.

**Step 2 — Fan-out.** `workflows/plan.workflow.js` (L2) launches one `mp-subsystem-planner`
(opus) per subsystem in a `parallel()` barrier. Each drafter returns a **fragment** — a
subsystem-scoped task list without global ids or waves. The fragment schema (enforced at the
Workflow tool boundary) is:

```json
{
  "key": "auth",
  "tasks": [
    {
      "key": "auth.token-store",
      "description": "...",
      "files": ["src/auth/tokens.ts"],
      "verify_commands": ["npx tsc --noEmit"],
      "deps": [],
      "codex": "ok"
    }
  ]
}
```

Critically, the fragment schema pins `codex` to `string|null` with `enum: ["ok","no",null]` —
an object or boolean shape cannot be returned at the tool boundary, making the layer-1 defence
against anomaly 1.

The workflow returns `{ subsystems: [<fragment>, ...], specPath, repoRoot }` and never writes
artifacts or commits.

**Step 3 — Deterministic merge (`lib/plan-merge.mjs`).** `mergePlanFragments` runs:

1. **Flatten and assign ids.** Tasks are numbered 1-based in fragment order, then task order.
   Duplicate task keys across fragments throw immediately (fail loud, never silent collision).

2. **Validate dependency references.** Every `deps` entry must reference an existing task key.
   Dangling deps throw.

3. **Wave layering via Kahn topological order.** A deterministic topological sort (lowest id
   wins among ready nodes) produces a processing order. For each task in that order:

   - `wave = max(wave of each dep) + 1`, or `0` if no deps.
   - **File-conflict bump:** while any already-placed task at the same wave shares a declared
     file with this task, increment `wave`. The bump repeats until the task's file set is
     disjoint from every same-wave peer.

   Result: disjoint, dependency-free tasks share the lowest possible wave (maximal safe
   parallelism); tasks that must sequence do so. Wave numbers are derived entirely from the
   dependency DAG and declared file sets — never authored by the LLM.

   A cycle in the dependency DAG throws: `"dependency cycle among tasks [a, b, ...]"`.

4. **Emit canonical `plan.index.json`.** Fields: `id` (int), `description` (str), `wave`
   (int ≥ 0), `files` (array), `verify_commands` (array), `codex` (`"ok"|"no"|null`),
   plus optional `sensitive`, `conversational`, `spec_refs`. Internal `key` and `deps` fields
   are dropped from the output.

### codex normalisation (`normalizeCodex`)

Called during merge step 1 on every task's raw `codex` value:

| Input shape | Output |
|---|---|
| `"ok"` or `"no"` | unchanged |
| `true` | `"ok"` |
| `false` | `"no"` |
| `{ eligible: true }` | `"ok"` |
| `{ eligible: false }` | `"no"` |
| anything else (missing, null, unrecognised) | `null` (heuristic) |

This is the belt-and-suspenders layer (layer 2 of the anomaly-1 defence). Even if the tool
boundary admits a malformed value, `normalizeCodex` collapses it to the string enum before it
can reach `lib/dispatch/routing.mjs`.

## Schema validation (`validatePlanIndex`)

Run against both the merge output (belt-and-suspenders) and the serial-path index (the explicit
gate). Checks:

- `id` is an integer, non-duplicate.
- `description` is a non-empty string.
- `wave` is an integer ≥ 0.
- `codex` is `"ok"`, `"no"`, `null`, or absent. Any other shape is an error; the error message
  names the silent-routing-fallthrough trap explicitly.
- `files` and `verify_commands`, if present, are arrays.
- No two tasks in the same wave share a declared file.

Returns an array of human-readable error strings; empty means valid. Never throws.

## plan.md as deterministic projection (`renderPlanMd`)

`plan.md` is always generated by `renderPlanMd(index, meta)` — it is never hand-authored
independently of the index. This keeps the human-readable and machine-readable plans from
drifting. The render groups tasks by wave, listing each task's files, verify commands, and
codex annotation. Because `plan.md` is a pure function of the index, any edit to task scope
or ordering is made in the index; `plan.md` is regenerated.

## plan.index.json schema reference

```
schema_version: "6.0"
tasks:
  - id:               integer, 1-based, unique
    description:      string (required)
    wave:             integer >= 0
    files:            array of repo-relative paths
    verify_commands:  array of shell strings
    codex:            "ok" | "no" | null
    sensitive:        bool (optional)
    conversational:   bool (optional)
    spec_refs:        array of strings (optional)
```

Example bundle layout: `/home/user/project/docs/masterplan/my-feature/plan.index.json`.
