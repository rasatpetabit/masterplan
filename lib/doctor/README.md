# lib/doctor — external-integration check modules (build step 5, L4)

One `*.mjs` module per surviving check. Each exports a **synchronous**

```
check(repoRoot, opts) -> Finding[]
```

where a `Finding` is `{ id, severity: 'PASS' | 'WARN' | 'ERROR' | 'SKIP', summary, fix }`.

**Contract (settled in the slice, advisor-pressure-tested):**

- **`Finding[]`, never a singular result.** A module owns its own scope and can emit several
  findings — e.g. `worktree-integrity` scans N bundles × {worktree, branch} sub-checks, each
  with a distinct `fix`. Collapsing to one `{severity, fix}` would gut actionable remediation.
  A module always returns **≥1 finding** (a single `PASS` when clean, `SKIP` when nothing
  applies) so the output proves it ran.
- **Scope is the module's job.** Plan-scoped checks glob `<repoRoot>/docs/masterplan/*`
  internally; user-scoped checks ignore `repoRoot` and read host paths via `opts`.
- **`opts` is the testability seam** (mirrors `lib/paths.mjs` env-injection): `opts.homeDir`
  (host file roots), `opts.gitExec` / `opts.repoRoot` (git access — injectable stub in tests),
  `opts.now` (ms clock for expiry math). Defaults hit the real host; tests inject everything.
- **`SKIP` is a first-class outcome**, not a failure: codex-not-installed, no `auth.json`,
  not-a-git-repo, no run bundles. The doctor must run anywhere.
- The dispatcher (`bin/doctor.mjs`) **auto-discovers** every `lib/doctor/*.mjs` that exports a
  `check()` (there is NO registry to edit — add a module by dropping a file). It
  **crash-isolates** each module (a throw → one synthesized `ERROR` finding) and exits non-zero
  **iff any finding is `ERROR`** (`WARN`/`SKIP` → exit 0).
- A module may additionally export an optional synchronous
  `fix(repoRoot, findings, opts) -> Repair[]`; the dispatcher calls fix handlers only when the
  CLI is invoked with `--fix`.

**Fixtures** live under `test/fixtures/doctor/<check>/<scenario>/`; the scenario dir-name
prefix (`pass-`/`warn-`/`error-`/`skip-`) encodes the expected worst-severity. This is a
deliberate deviation from the plan's "reuse `tests/doctor-fixtures/`": that v7 set was
block-YAML (`schema_version: 3`) and tested the v7 doctor — both deleted at the v8.2.0 cutover. Flat v8-compatible v7
fixtures (e.g. check-32, check-39 data) are copied into this single v8 root; schema-coupled
checks get fresh v8-flat fixtures.

## Module inventory (auto-discovered — keep in sync with the filesystem)

The dispatcher globs `lib/doctor/*.mjs`; there is no registry. **Every module is listed here.**
`test/doctor-readme.test.mjs` asserts this table's ids exactly match the filesystem modules, so
a new module that ships without a README row (or a deleted module that leaves a stale row) fails
CI rather than silently drifting. `v7 ID` is the ported v7 check id, where applicable.

| Module | v7 ID | Severity | Purpose |
|---|---|---|---|
| `scalar-cap` | #32 | WARN | Flat `key: value` scalars in bundle `state.yml` must be ≤ 200 chars; `*overflow at <file> L<n>*` pointers must resolve in-bundle (has a `--fix` handler). |
| `worktree-integrity` | #3/#4/#29(a) | ERROR/SKIP | Each bundle's `worktree`/`branch` references must still resolve in git, unless archived or intentionally retired. |
| `codex-auth` | #39 | WARN/SKIP | User-scoped Codex `auth.json` health (exp / expiring-soon / stale-refresh; auth-mode-aware). Informational only. |
| `state-schema` | #9 (+#10 folded) | ERROR | Validates each bundle's `state.yml` against the canonical v8 core schema (single source of truth in `lib/bundle.mjs`); unparseable folds in. |
| `legacy-bundle` | #1 | WARN | Any bundle with `schema_version < 6`, or `docs/superpowers/` containing actual legacy planning artifacts. |
| `routing-policy-health` | — | PASS/WARN | Repo-local routing policy (classes/agents/lanes) resolves — adversarial panel and required classes usable. |
| `index-staleness` | #34 | WARN | `plan.index.json`'s `plan_hash` matches the current `plan.md` content. |
| `stale-lock` | #42 | WARN | Bundle `.lock` files older than the 1-hour threshold (a crashed run may have left one). |
| `plugin-registry-drift` | #50 | WARN | User-scoped: installed masterplan plugin version vs marketplace-cached version mismatch. Detection only. |
| `coord-drift` | — | WARN | Coordination-state drift for GitHub-coordinated run bundles. |
| `dangling-run` | — | WARN | Non-archived dangling run bundles: past the staleness threshold, or a stale in-progress bundle still holding an owner-lock. |
| `goals` | — | ERROR | Goals-enabled bundles have consistent goal state: a frozen hash matching the current `goals.md`, and (archived) a valid `goal_check` receipt or covering waivers. |
| `owner-sentinel` | — | WARN | Stale/corrupt owner locks (`.owner.lock`, orphan `.owner.hb.*`) left by a crashed session. |
| `pi-agent-registration` | — | WARN | Host drift of pi-installed `mp-*` agents (stale pins, missing copies, body mismatch). |
| `plan-doc-cruft` | — | WARN | Repo-wide markdown outside run bundles that still carries provenance of an archived run. |
| `plan-index-schema` | — | WARN | `plan.index.json` files must validate against the same strict validator the merge path uses (non-string `codex`, same-wave file overlap, etc.). |
| `rejected-idea-kb` | — | WARN | Durable rejected-idea KB files under `.out-of-scope/` carry the required sections. |
| `spec-assumptions` | — | WARN | Version-scoped: post-feature bundles whose `spec.md` omits the required `## Assumptions` section. |
| `stalled-bundle` | — | WARN | A bundle seeded and driven through brainstorm/plan that never recorded any of it (the CD-7 durability contract). |

**`#9` stays minimal** — v8 bundles are well-formed by construction (`serializeState`), so #9
guards only the migrate/hand-edit boundary: validate what the control loop dereferences
(`schema_version ≥ 6`, `slug`/`status`/`phase` present, `tasks` is an array,
`active_run`/`pending_gate` present-or-null). The required-field set lives as a single source
of truth in the bundle/lib layer (the future writer imports the same constant), never a second
definition here. `#10` (unparseable) folds in: `parseState` is tolerant, so the only
"unparseable" is *zero modellable keys* = ERROR.

**Deliberately NOT ported:** #29(b)/#48 "orphan untracked worktree" (a git worktree no bundle
points at) — false-positives on every ordinary worktree, including masterplan-ng's own. We flag
bundle→git drift, never git→bundle. (Confirmed: the live dispatcher run did not flag this
worktree.)

The ~38 self-instrumentation checks (CC-2/CC-3 compliance, gate-consistency, projection
mismatch, anomaly records, review-coverage audits, …) are deleted with the complexity they
policed. Release-hygiene checks (cross-manifest version sync, router-size/prose, namespace
collision) move to CI / pre-commit, since end users don't have the repo.
