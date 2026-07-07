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

## plan.html as a rendered projection (renderPlanHtml)

`plan.html` is a second, **additive** projection of the index — `plan.md` stays canonical;
`plan.html` is the rendered, browser-openable view (planf3-inspired). Like `renderPlanMd`,
`renderPlanHtml(index, meta)` is a **pure, deterministic** function: identical `(index, meta)`
yields byte-identical output (including its SVG), with no clock/randomness/measured text — any
timestamp shown comes from `meta.generated_at`/`index.generated_at`, never `new Date()`. It is
self-contained (inline CSS, no JS, no remote resources). The `meta` bag threads render context:
`title`, `taskStatus` ({id → status}), `refs`, `narrative`, `bundleDir`, `generated_at`,
`amendmentsMd`/`amendments`, and an injectable `fileExists` (for offline trust-boundary tests).

### Expanded section order

The document body is assembled top-to-bottom in one fixed order (`renderPlanHtml`,
`lib/plan-merge.mjs`); every block after the header is **conditionally emitted** and collapses
to an empty string when its data is absent, so an old minimal index still renders cleanly:

1. **Header + refs** — `<h1>` title, a one-line `summary` (`N task(s) across M wave(s).`), an
   optional `Generated:` stamp (only when `meta`/`index.generated_at` is set), the optional
   hero image, then the **References** block (`refsBlock`): `back:`/`forward:` cross-bundle ref
   links from `meta.refs` (`{ back, forward }`), omitted when both are empty. Each ref renders
   as an `<a href>` only when its target `plan.html` exists (by-presence), else inert text.
2. **Narrative meta** (`narrativeBlock`) — `Purpose` / `Problem` / `Solution` `<h2>`+`<p>`
   pairs, each emitted only when its narrative string is present and non-empty.
3. **Wave SVG** (`renderWaveSvg`) — the inline wave-banded node diagram (below), wrapped in
   `<figure class="diagram">`.
4. **Task table** — one `<section class="wave">` per wave, each with an optional
   `assets/wave-<n>.png` illustration then a table whose columns are
   #, Status (badge), Task, Files, Verify, Codex, Spec refs.
5. **Goals** (`goalsBlock`) — the distinct goal ids cited across all tasks, de-duped and
   sorted for determinism; omitted when no task cites a goal.
6. **Amendments timeline** (`amendmentsBlock`) — the parsed `## Amendments` history rendered
   as an ordered `<ol class="timeline">` (below).

### The inline wave SVG (a node layout, not a dependency graph)

The inline `<svg>` (`renderWaveSvg`) is a **wave-banded node layout, not a dependency graph** —
the merged index carries no deps (the merge drops internal `key`/`deps`), so drawing dependency
edges would be fabricated. Each wave is a horizontal band; tasks (id-sorted) are `#id` nodes
within it, colored by status. Geometry is a pure function of node counts — no measured text, no
generated ids, no clock — so the SVG is byte-stable for a given `(index, taskStatus)`.

### by-presence image embedding (`assets/{hero,wave-<n>}.png`)

Images are embedded strictly **by presence on disk**, never by any render flag: the `imgTag`
helper resolves a slot to a path via `resolveAssetSrc(bundleDir, slot)` and emits an `<img>`
only when `bundleDir` is set **and** `fileExists(abs)` is true — otherwise it returns `''`, so
a missing asset yields no broken image. Two slots are consulted: `hero` (rendered once in the
header) and `wave-<n>` per wave `<section>`. The `<img src>` uses the bundle-relative path and
is HTML-escaped like every other interpolated value.

### The `## Amendments` markdown parse (`parseAmendments`)

`parseAmendments(md)` turns the `## Amendments` section that the F2 amend flow appends to
`plan.md` into an ordered timeline. It accepts either the whole `plan.md` or just the section,
and is a pure string parse (no fs, no clock): it scans for the `## Amendments` H2, then reads
`### <date> — <summary>` entry headings (em-dash separated; a heading with no em-dash keeps an
empty `date` and treats the whole heading as `summary`), collecting following non-`###` lines
as that entry's `detail` body. A subsequent `##` H2 ends the section. Each entry becomes
`{ date, summary, detail }`. `render-plan` reads `plan.md` best-effort (`meta.amendmentsMd`);
an absent/unreadable `plan.md` yields no timeline, never a throw.

### Trust boundaries: escaping + path traversal

Two independent trust boundaries keep untrusted plan text and stored slugs from becoming
executable markup, a remote fetch, or a filesystem-traversal primitive:

- **Escaping.** Every interpolated string field (descriptions, files, commands, spec_refs,
  title, ref labels, asset `src`, amendment date/summary/detail) routes through `escapeHtml`
  (`& < > " '`), so untrusted markup can never open a `<script>` or `src=`/`href=` fetch. The
  numeric `id`/`wave` fields are interpolated **raw** (not via `escapeHtml`) but are
  `Number()`-coerced up front, so a hand-edited index that smuggles markup through them renders
  as `NaN`, not an open tag. Task status reaches a CSS class only through the
  `PLAN_HTML_STATUSES` whitelist (`pending`/`done`/`failed`/`blocked`; anything else →
  `pending`), so a hostile status string cannot inject a class.
- **Path traversal.** Asset and ref paths are pure `node:path` math (no fs) with a confinement
  check. `resolveAssetSrc` keeps an embedded `<img>` inside the bundle's `assets/` dir — a slot
  that resolves outside `assets/` returns `null` (no tag). `resolveRefTarget` re-validates the
  **stored** ref slug against `SLUG_RE` (`^[a-z0-9][a-z0-9-]*$`) and resolves the target under
  the ref's stored **canonical repo root** (`ref.repo`, else the bundle's `<root>/docs/masterplan/<slug>`
  → `<root>` ancestor); a target that escapes that root returns `null`. So a hostile
  `state.refs` slug renders as inert text, never a traversal.

### Two entry points (both fs-only, no network/secrets)

- **Auto-emit** at the plan→execute seam: `mp load-plan` best-effort writes a static `plan.html`
  (all tasks `pending`) right after the index validates and before the atomic state write. A
  render/write failure is swallowed (logged) — it never fails `load-plan` or perturbs `state.yml`.
- **`mp render-plan`** (the `render` verb): re-renders `plan.html` with **live** per-task status
  read from `state.tasks` (badge values `pending`/`done`/`failed`/`blocked`; anything else →
  `pending`), plus refs from state, narrative from `index.meta`, and the amendments timeline from
  `plan.md`. **Read-only w.r.t. state** — it never calls `writeState`, so F1 (refs) and F2 (amend)
  callers can idempotently retry the render after a post-commit render failure without touching
  `state.yml`.

### `state.render` config (`mp set-render-config` / `seed --render-images`)

Whether a run arms image/diagram render artifacts is a per-bundle toggle held in a nested
`state.render` object (currently just `state.render.images`, `'on'`|`'off'`), symmetric with
`state.review`/`state.codex`:

- **Seed default.** `buildSeedState` writes `state.render = { images: <seed> }`, defaulting to
  `'off'` unless `seed --render-images=on` is passed. The bin boundary enum-validates
  `--render-images` to `on`|`off`; migration back-fills a missing `state.render` to
  `{ images: 'off' }`.
- **`mp set-render-config --images=on|off`.** The reversible setter (mirrors
  `set-review-config`): `setRenderConfig` merge-updates only the supplied facet so other render
  keys survive, and every `{...state}` writer round-trips `state.render` untouched. This is the
  single non-seed writer of the key — the toggle is flipped via the verb, never a CD-7 hand-edit
  of `state.yml`.

### Narrative meta threading (`--meta` / `mp-planner` / back-compat)

The optional narrative `meta` (`{ purpose, problem, solution }`, each 1–3 plain-prose sentences
distilled from `spec.md`) is carried into `index.meta` by **both** planning paths so the
Purpose/Problem/Solution sections render identically regardless of path:

- **Parallel path.** `merge-plan-fragments --meta=<JSON>` forwards the parsed meta to
  `mergePlanFragments(fragments, { meta })`, which distils `{purpose, problem, solution}` into
  `index.meta`. Non-object meta, missing fields, and non-string/empty values are **soft-ignored**
  (never a throw); when no valid narrative field is present, `index.meta` is omitted entirely so
  an old no-meta index keeps its exact byte shape.
- **Serial path.** `mp-planner` emits the same optional top-level `meta` object directly in
  `plan.index.json` (same `{purpose, problem, solution}` contract), keeping the two paths in sync.
- **`validatePlanIndex` back-compat.** The validator is **accept-and-ignore** for `index.meta`:
  it inspects only `index.tasks`, so an old index carrying no meta stays valid, a new index with
  meta stays valid, and a malformed meta value is a soft-ignore, never a hard error.

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
