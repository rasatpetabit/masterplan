---
type: reference
title: masterplan — doctor structural-lint subsystem
timestamp: 2026-07-01T00:00:00Z
privacy: private
tags: [masterplan, doctor, lint, validation]
---

# Doctor structural-lint subsystem

`bin/doctor.mjs` is the L4 layer of masterplan: it dispatches across 14
auto-discovered check modules in `lib/doctor/` to validate the integrity of
an L0 run bundle (`docs/masterplan/<slug>/`). Each check module produces
`Finding{id, severity, summary, fix}` results; `doctor` exits non-zero when
any finding has `ERROR` severity, making it usable as a CI/pre-flight gate
before resuming or finishing a run.

Check modules are auto-discovered, so adding a new structural rule is a
matter of dropping a new module into `lib/doctor/` rather than editing a
central dispatch table — keeping the L4 surface in sync with L0 bundle shape
changes as the format evolves.

See [`docs/internals/doctor.md`](../docs/internals/doctor.md) for the full
list of checks and severities.
</content>
