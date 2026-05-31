# Doctor Checks — Internals

> **Audience:** Maintainers adding or fixing doctor checks.
> **Source:** `bin/doctor.mjs` (dispatcher) + `lib/doctor/*.mjs` (11 check modules).

## How the doctor works

`node bin/doctor.mjs [repoRoot]` is the entry point. It:

1. **Discovers** every `lib/doctor/*.mjs` file alphabetically (via `readdirSync`).
   `README.md` and non-`.mjs` files are ignored; any `.mjs` that does not export a
   `check` function is also skipped silently.
2. **Runs** each module's `check` function in **crash isolation**: if a module throws,
   the dispatcher converts the exception into one `ERROR` finding rather than aborting
   the whole run. A doctor that dies on its own bug is worse than useless.
3. **Aggregates** findings, prints them, and **exits non-zero iff any finding has
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

## The 11 check modules

| Module | Purpose |
|---|---|
| `codex-auth` | Reads `~/.codex/auth.json`; warns on expired or expiring-soon JWT claims. ChatGPT auth mode (`auth_mode: chatgpt` + `refresh_token`) short-circuits to `PASS` because Codex auto-refreshes the id_token per invocation. `SKIP` when auth.json is absent. |
| `codex-plugin-presence` | Mirrors the dispatch path (`bin/masterplan.mjs` nested `state.codex.{routing,review}`) to detect which bundles request Codex; warns when any requesting bundle cannot find the Codex plugin on the host. `SKIP` when no bundle uses Codex. |
| `index-staleness` | For each bundle with a `plan.md`, computes a sha256 and compares it against the recorded hash in `plan.index.json` (and, for migrated-in-place bundles, `state.plan_hash`). `WARN` on mismatch; `SKIP` when no bundle has a plan. |
| `legacy-bundle` | Warns on any bundle with `schema_version < 6` (not yet migrated to v8) and on any actual planning artifacts remaining under `docs/superpowers/`. `SKIP` only when no bundles exist and `docs/superpowers/` is absent. |
| `plan-index-schema` | Runs `lib/plan-merge.validatePlanIndex` against every `plan.index.json` with `schema_version >= 6`; catches non-string `codex` fields and same-wave file overlaps that silently mis-route. `SKIP` when no canonical index exists. |
| `plugin-registry-drift` | Compares the installed masterplan plugin version in `installed_plugins.json` against the marketplace `plugin.json`; also compares `gitCommitSha` against marketplace HEAD to catch same-version stale caches. `SKIP` when either file is absent. |
| `scalar-cap` | Validates that no flat `key: value` line in `state.yml` exceeds 200 characters, and that every `*overflow at <file> L<n>*` pointer resolves to a real file and line within the same bundle directory. |
| `stale-codex-task` | Walks `~/.claude/plugins/data/*/state/*/jobs/*.json`; warns on any non-terminal job (`status` not in `completed|done|cancelled|failed|error`) whose `startedAt` is older than 24 hours. `SKIP` when the data directory is absent. |
| `stale-lock` | Checks each bundle directory for a `.lock` file whose mtime is older than 1 hour; warns when found (a crashed run may have left it). |
| `state-schema` | Validates each bundle's `state.yml` against `lib/bundle.validateCoreState` (the single source of truth for required fields). Bundles with `schema_version < 6` are deferred to `legacy-bundle`. A slug directory with no readable `state.yml` produces a `WARN` (orphan directory). A `state.yml` that parses to zero keys is an `ERROR`. |
| `worktree-integrity` | For each non-archived bundle, verifies that the recorded `worktree` path and `branch` name exist in the git graph (`git worktree list` / `git branch`). `ERROR` on broken references; `SKIP` when git is unavailable. Intentionally does not check the reverse direction (git worktrees with no bundle). |

## What changed from v7

v7's `parts/doctor.md` was a single ~2,116-line markdown file encoding 53 prose
checks interpreted by a Sonnet coordinator at runtime. This had two structural
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
2. No registration step: `bin/doctor.mjs` discovers all `*.mjs` files
   alphabetically at runtime. The new module is live immediately.
3. Follow the scope conventions above (plan-scoped vs user-scoped).
4. Add a unit test in `test/` covering PASS, WARN/ERROR, and SKIP branches.
5. Add a one-line entry to the module table in this file.
