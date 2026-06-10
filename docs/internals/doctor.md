# Doctor Checks — Internals

> **Audience:** Maintainers adding or fixing doctor checks.
> **Source:** `bin/doctor.mjs` (dispatcher) + `lib/doctor/*.mjs` (14 check modules).

## How the doctor works

`node bin/doctor.mjs [repoRoot]` is the entry point. It:

1. **Discovers** every `lib/doctor/*.mjs` file alphabetically (via `readdirSync`).
   `README.md` and non-`.mjs` files are ignored; any `.mjs` that does not export a
   `check` function is also skipped silently.
2. **Runs** each module's `check` function in **crash isolation**: if a module throws,
   the dispatcher converts the exception into one `ERROR` finding rather than aborting
   the whole run. A doctor that dies on its own bug is worse than useless.
3. When invoked with `--fix`, calls optional module `fix(repoRoot, findings, opts)`
   handlers for checks that implement safe automatic repairs, then reruns all checks.
   Findings whose remedies require human judgment stay report-only.
4. **Aggregates** findings, prints them, and **exits non-zero iff any finding has
   severity `ERROR`**.

### Finding shape

Every module returns `Finding[]` (or a single `Finding`) from a synchronous
`check(repoRoot, opts)` export:

```js
{
  id:       string,          // stable identifier (matches the module name by convention)
  severity: 'PASS' | 'WARN' | 'ERROR' | 'SKIP',
  summary:  string,
  fix:      string | null,   // shown for WARN / ERROR only
}
```

A finding with an absent or unrecognised severity is forced to `ERROR` — a
malformed finding must never read as clean.

A module may also export a synchronous `fix(repoRoot, findings, opts) -> Repair[]`
handler. `--fix` handlers must be conservative: only safe, local, deterministic
repairs should be automated. Destructive, host-global, networked, or ambiguous
remedies should remain as `fix` text for the operator.

### Injectable seams

`opts.homeDir` (user home path), `opts.now` (epoch milliseconds), and
`opts.gitExec` (function that shells git) are all injectable so every module is
unit-testable without touching the real host. The main CLI passes
`process.env.HOME` and `Date.now()`.

### Scope conventions

- **Plan-scoped** modules glob `<repoRoot>/docs/masterplan/*/` internally. They
  emit one finding per problem and a single `PASS` when everything is clean, or
  `SKIP` when the directory does not exist / is empty.
- **User-scoped** modules ignore `repoRoot` and read host paths through `opts`
  (e.g. `homeDir`). They `SKIP` gracefully when the relevant tooling is not
  installed.

## The 14 check modules

| Module | Purpose |
|---|---|
| `codex-auth` | Reads `~/.codex/auth.json`; warns on expired or expiring-soon JWT claims. ChatGPT auth mode (`auth_mode: chatgpt` + `refresh_token`) short-circuits to `PASS` because Codex auto-refreshes the id_token per invocation. `SKIP` when auth.json is absent. |
| `codex-plugin-presence` | Mirrors the dispatch path (`bin/masterplan.mjs` nested `state.codex.{routing,review}`) to detect which bundles request Codex; warns when any requesting bundle cannot find the Codex plugin on the host. `SKIP` when no bundle uses Codex. |
| `coord-drift` | For GitHub-coordinated runs (bundles with a `coordination` object in `state.yml`): pure-filesystem drift detection between durable plan state and the published GitHub projection — done tasks whose `issue_map` entry is still open/claimed, orphan claims (claimed with no PR), `issue_map` vs `state.tasks` task-ID drift, and `published_waves` mismatches. No `gh`/network calls. `SKIP` when no bundle is coordinated. |
| `index-staleness` | For each bundle with a `plan.md`, computes a sha256 and compares it against the recorded hash in `plan.index.json` (and, for migrated-in-place bundles, `state.plan_hash`). `WARN` on mismatch; `SKIP` when no bundle has a plan. |
| `legacy-bundle` | Warns on any bundle with `schema_version < 6` (not yet migrated to v8) and on any actual planning artifacts remaining under `docs/superpowers/`. `SKIP` only when no bundles exist and `docs/superpowers/` is absent. |
| `owner-sentinel` | Guard D hygiene: scans `docs/masterplan/<slug>/.owner.lock` + `.owner.hb.*` heartbeats; `WARN` on a corrupt lock (unparseable), a stale lock (no heartbeat within TTL — recommends `release-owner --force` when no live session holds it), or orphan heartbeat files with no lock. Fresh locks emit nothing; `SKIP` when no bundles exist. |
| `plan-doc-cruft` | Repo-wide backstop for the finish flow's `docs_normalize` gate: anchored to **archived** bundles, it warns on markdown outside the runs dir that still carries plan provenance — an archived slug as a whole token in a filename, a body reference to `docs/masterplan/<slug>`, or a hyphenated slug in a heading line. Excludes the runs dir itself, `docs/superpowers/` (legacy-bundle owns that), dot-directories, node_modules, root history files (`WORKLOG`/`CHANGELOG*`/`HISTORY`), and files >1 MiB. Always `WARN`, never `ERROR`; `SKIP` when no archived bundles exist. |
| `plan-index-schema` | Runs `lib/plan-merge.validatePlanIndex` against every `plan.index.json` with `schema_version >= 6`; catches non-string `codex` fields and same-wave file overlaps that silently mis-route. `SKIP` when no canonical index exists. |
| `plugin-registry-drift` | Compares the installed masterplan plugin version in `installed_plugins.json` against the marketplace `plugin.json`; also compares `gitCommitSha` against marketplace HEAD to catch same-version stale caches. `SKIP` when either file is absent. |
| `scalar-cap` | Validates that no flat `key: value` line in `state.yml` exceeds 200 characters, and that every `*overflow at <file> L<n>*` pointer resolves to a real file and line within the same bundle directory. The cap is a prose-scalar discipline: values that parse to structured data (e.g. the inline-JSON `tasks` line the v8 writer emits) are exempt — both from the WARN and from the `--fix` handler, which moves only string scalars to `state-overflow.md`. |
| `stale-codex-task` | Walks `~/.claude/plugins/data/*/state/*/jobs/*.json`; warns on any non-terminal job (`status` not in `completed|done|cancelled|failed|error`) whose `startedAt` is older than 24 hours. `SKIP` when the data directory is absent. |
| `stale-lock` | Checks each bundle directory for a `.lock` file whose mtime is older than 1 hour; warns when found (a crashed run may have left it). |
| `state-schema` | Validates each bundle's `state.yml` against `lib/bundle.validateCoreState` (the single source of truth for required fields). Bundles with `schema_version < 6` are deferred to `legacy-bundle`. A slug directory with no readable `state.yml` produces a `WARN` (orphan directory). A `state.yml` that parses to zero keys is an `ERROR`. |
| `worktree-integrity` | **Bundle→git:** for each non-archived/non-retired bundle, verifies the recorded `worktree` path and `branch` exist in the git graph (`git worktree list` / `git branch`) — `ERROR` on a broken reference. **Git→bundle** (Phase 2): runs the shared pure `lib/worktree.classifyWorktrees` over the on-disk `.worktrees/*` dirs + bundle records to `WARN` on reconcilable strays — crash-leak (a retired bundle still registered + on disk → remove), repo-move (a dangling admin link → `git worktree repair`), foreign-repo leftover (→ remove), and a legacy `missing` disposition (→ normalize). A plain unowned dev worktree (e.g. `masterplan-ng`) stays untouched, and a repo-move/`missing` is reported once (as the WARN remedy), never also as a bundle→git ERROR. `SKIP` when git is unavailable or no bundles exist. |

## What changed from v7

v7's `parts/doctor.md` (deleted at the v8.2.0 cutover) was a single ~2,116-line
markdown file encoding 53 prose checks interpreted by a Sonnet coordinator at runtime. This had two structural
problems: the coordinator had to re-parse and re-interpret the prose on every
run, and the checks were untestable in isolation.

v8 replaces this with 11 Node.js modules (`lib/doctor/*.mjs`), each owning a
narrow, deterministic scope. The ~38 **self-instrumentation checks** (which
verified the plugin's own source files and were only meaningful inside the
development repo) were **deleted** — end users don't have the repo and should
never see repo-structure errors as doctor findings. Release-hygiene has moved
to CI via `lib/hygiene.mjs`, driven by `test/publish-hygiene.test.mjs`.

## Adding a new check

1. Create `lib/doctor/<name>.mjs` exporting a synchronous
   `check(repoRoot, opts) -> Finding[]` function.
2. Add an optional synchronous `fix(repoRoot, findings, opts) -> Repair[]` export
   only when the repair is safe to apply automatically under `--fix`.
3. No registration step: `bin/doctor.mjs` discovers all `*.mjs` files
   alphabetically at runtime. The new module is live immediately.
4. Follow the scope conventions above (plan-scoped vs user-scoped).
5. Add a unit test in `test/` covering PASS, WARN/ERROR, and SKIP branches; add
   an idempotent `--fix` test when a fix handler exists.
6. Add a one-line entry to the module table in this file.
