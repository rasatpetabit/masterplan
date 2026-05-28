# lib/doctor — external-integration check modules (build step 5)

One `*.mjs` module per surviving check, each a pure function

```
(bundleDir) -> { id, severity: 'PASS' | 'WARN' | 'ERROR', summary, fix }
```

with a fixture test reusing the existing `tests/doctor-fixtures/` data.

Only the ~12 **external-boundary** checks survive: plugin registry drift
(version + gitCommitSha), Codex plugin presence, Codex auth health, stale Codex
bg task, state schema parse/validate, scalar-cap integrity, index staleness,
worktree/branch integrity, stale lock, legacy-bundle-not-migrated.

The ~38 self-instrumentation checks (CC-2/CC-3 compliance, gate-consistency,
projection mismatch, anomaly records, review-coverage audits, …) are deleted with
the complexity they policed. Release-hygiene checks (cross-manifest version sync,
router-size/prose, namespace collision) move to CI / pre-commit, since end users
don't have the repo.
