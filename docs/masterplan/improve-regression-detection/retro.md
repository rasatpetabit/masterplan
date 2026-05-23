# Retro: improve-regression-detection

**Bundle**: improve-regression-detection  
**Branch**: worktree-improve-regression-detection  
**Completed**: 2026-05-22  
**Tasks**: 15/15  
**Final test count**: 9/9 pass (6 fast + 3 full); 89 doctor-fixture checks pass

---

## What was built

| Area | Deliverable |
|---|---|
| Test runner | `tests/run-tests.sh` — tiered `--fast`/`--full`/`--all-worktrees` entry point |
| Structural tests | `tests/structural/test-coordinator-dispatch.sh` (A1–A4), `tests/structural/test-step-c-split.sh` (B1–B4) |
| Doctor fixtures | Extended `tests/doctor-fixtures/` from checks #32–#41 to #1–#47 (89 pass/fail fixtures total) |
| Doctor bash blocks | Added bash blocks to `parts/doctor.md` checks #1–#31, #42–#47 (every previously-unimplemented check) |
| Hook unit tests | `tests/hook-unit/test-telemetry-sections.sh` (C1–C4), `tests/hook-unit/test-self-host-audit.sh` (D1–D3) |
| Bin aliases | `bin/run-tests.sh`, `bin/run-tests-fast.sh` pointing to `tests/run-tests.sh` |
| Deprecation | `tests/run-static.sh` deprecated as a forwarding alias to `run-tests.sh --fast` |
| Fixes (incidental) | Cross-ref registration for coordinator contracts; manifest version sync; annotation `true`/`false` alias for `ok`/`no` |

---

## What went well

- **Fixture-driven approach held up.** Adding bash blocks to every check first, then wiring fixtures for them, gave clean incremental commits. No rework loops.
- **Tiered runner design was right-sized.** Fast tier (static + structural) runs in <10s; full tier adds fixture + hook-unit suites and stays under 2 min. No over-engineering.
- **Pre-existing failures caught early.** Task 6 (resolve pre-existing `--fast` failures) found three latent issues in the static suite before the structural tests were written, preventing false baselines.

---

## What was harder than expected

- **Check #42 bash fix required a scope expansion.** The check's original bash block had a process-substitution subshell bug that silently zeroed the violations counter. Fixing it was straightforward (process substitution instead of pipe), but it was an unplanned task discovered mid-run.
- **Fixture JSON for check #30 was gitignored.** Plugin JSON fixture files matched a `.gitignore` pattern; required a `git add -f` workaround. Documented but not ideal.
- **Cross-ref registration was a cross-cutting concern.** Three separate files needed updating to register the new coordinator contracts; the cross-ref check (#5) caught the drift but fixing it required touching files outside the planned scope.

---

## Decisions

- **`tests/run-static.sh` kept as alias, not removed** — downstream tooling may invoke it directly; breaking scripts is a larger blast radius than a forwarding shim.
- **Doctor check #33 bash block marked Reserved** — check #33 requires `TaskList` API which is not available in static verification; bash block documents this rather than writing a fake stub.
- **Hook-unit tests use fixture state files** — rather than mocking the telemetry hook's Bash env, tests drive it with minimal fixture state files and assert on exit codes + stdout patterns.

---

## Follow-ups

- `tests/doctor-fixtures/check-33/` is missing (TaskList API dependency); if TaskList becomes available, fixture can be added then.
- Check #46 fires on `parts/doctor.md` code-block content (bash implementation blocks flagged as orchestrator directives). Accepted as known false positive for now; a `# DOCTOR-BASH-BLOCK` sentinel scheme would fix it cleanly.
- Check #22 (retro file missing) was triggered by this bundle not writing its own retro at archive time. Fixed in doctor --fix run on 2026-05-23.
