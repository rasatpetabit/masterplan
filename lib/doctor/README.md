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
- The dispatcher (`bin/doctor.mjs`) **crash-isolates** each module (a throw → one synthesized
  `ERROR` finding) and exits non-zero **iff any finding is `ERROR`** (`WARN`/`SKIP` → exit 0).

**Fixtures** live under `test/fixtures/doctor/<check>/<scenario>/`; the scenario dir-name
prefix (`pass-`/`warn-`/`error-`/`skip-`) encodes the expected worst-severity. This is a
deliberate deviation from the plan's "reuse `tests/doctor-fixtures/`": that v7 set is
block-YAML (`schema_version: 3`) and tests the v7 doctor being deleted. Flat v8-compatible v7
fixtures (e.g. check-32, check-39 data) are copied into this single v8 root; schema-coupled
checks get fresh v8-flat fixtures.

## Survivors (~10 external-boundary checks)

| Module | v7 IDs | Severity | Built? |
|---|---|---|---|
| `scalar-cap` | #32 | WARN | ✅ slice |
| `worktree-integrity` | #3/#4/#29(a) | ERROR/SKIP | ✅ slice |
| `codex-auth` | #39 | WARN/SKIP | ✅ slice |
| `state-schema` | #9 (+#10 folded) | ERROR | ✅ batch |
| `legacy-bundle` | #1 | WARN | ✅ batch |
| `codex-plugin-presence` | #18 | PASS/WARN/SKIP | ✅ batch |
| `index-staleness` | #34 | WARN | ✅ batch |
| `stale-lock` | #42 | WARN | ✅ batch |
| `stale-codex-task` | #49 | WARN | ✅ batch |
| `plugin-registry-drift` | #50 | WARN | ✅ batch |

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
