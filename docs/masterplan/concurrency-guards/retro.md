# concurrency-guards — Retrospective

**Date:** 2026-05-16
**Status at retro:** complete
**Complexity:** high
**Duration:** 2026-05-16 (single session)
**Released as:** v5.7.0

---

## What this was

Two concurrency guards addressing long-standing race windows in the masterplan framework:

- **Guard B** — cross-worktree slug collision at bundle creation time. Before this, two simultaneous invocations in different git worktrees with the same topic could silently create overlapping bundles.
- **Guard C** — same-worktree concurrent write serialization. `events.jsonl` and `state.yml` were written with `>>` redirects with no locking, making them susceptible to interleaved corruption under concurrent Stop hook invocations.

The session went spec (pre-authored) → brainstorm (6 open questions resolved as D1-D6) → plan (10 tasks, 2 waves) → execute (both waves completed in-session) → merge → v5.7.0 release.

## What worked

**Guard B stale detection fix.** The original `_check_worktree` implementation checked `[ -f "$state_file" ] || return 0` before `[ -d "$wt" ]`. If a worktree dir was deleted but still registered in git, the state file was also gone → early return → stale collision invisible. Catching and fixing this before the smoke run rather than after was the key correctness improvement. The fix: check `[ ! -d "$wt" ]` first, record the stale entry, return.

**fd-based flock form.** The exec-form `flock -w 5 "$lockfile" bash_function` fails with "Permission denied" because bash functions cannot be exec'd as external binaries. The fd-based form `(flock -w 5 9; "$@") 9>"$lockfile"` runs `"$@"` in a subshell where functions are in scope. This was caught during Guard C smoke Pass 1 and fixed before any production use. All three copies of `with_bundle_lock()` (state.sh, telemetry.sh, smoke script) were updated atomically.

**macOS fallback isolation.** Trying to override `command` in subshells to simulate flock-absent behavior is unreliable. The fix: a separate `with_bundle_lock_noflock()` function that directly exercises the else branch, used only in the smoke test. Production code is unchanged; test isolation is complete.

**Bail-silent contract preservation.** Telemetry hook uses `|| true` on all lock-wrapped append sites to maintain the contract that telemetry failures never abort the user's workflow. This was required by the hook's existing design and preserved in all 5 wrapped sites.

## Key design decisions (D1-D6)

| ID | Decision | Rationale |
|---|---|---|
| D1 | Silent `cd` to worktree root in `check-slug-collision` | Avoids polluting Step A's `git worktree list` output; Step A already uses this pattern |
| D2 | 4th AUQ option: orphan-acknowledge | Some peer runs are genuinely dead (crashed mid-execution); user needs an escape without auto-suffix |
| D3 | Global suffix scope (across ALL worktrees) | Per-worktree suffixing can still collide across machines; global eliminates the whole class |
| D4 | Blocking `flock -w 5` (not `-n`) | `-n` fails under normal concurrent load; blocking with 5s timeout is the standard pattern |
| D5 | Stale-lock detection at WARN severity (report-only) | Automatic deletion is dangerous (active writer during stat window); human confirmation required |
| D6 | Guard B on import but NOT on `--from-spec` | `--from-spec` doesn't create a bundle; the guard fires only where a bundle is created |

## What didn't work

**Haiku agent tool invocation.** The doctor run at the end dispatched Haiku agents for parallel plan-scoped checks, but all three returned fabricated or incomplete findings without reading files. The doctor fell back to inline bash checks. This is a known limitation of Haiku agents in the Explore subagent type when the task requires reading many files across multiple paths.

## Lessons learned

- The `flock` exec-form limitation is subtle and would have silently "worked" (no error) on Linux where bash functions are in scope in certain execution contexts, but failed on macOS. Testing the fd-based form explicitly in the smoke is the right approach.
- For multi-file helper functions duplicated across scripts (with_bundle_lock in state.sh and telemetry.sh), both copies must be updated atomically. The smoke test that covers both files in a single run is essential.
- Doctor check #22 (high-complexity rigor evidence) fires on this plan because Codex routing was off throughout. The plan was inherently sequential (guard implementation) and didn't warrant Codex dispatch. Check #22 is correct to flag it but the absence of Codex review is intentional here.

## Open items

- Doctor check #41 fires for this plan (codex_routing=off, no `codex degraded` event). This is an expected false positive for plans where Codex was never enabled. Check #41(a) would benefit from a "was_codex_ever_enabled" heuristic that skips the finding when `events.jsonl` has no Codex ping or routing events at all.
- The `worktree_decision_note` scalar in `state.yml` exceeds 200 chars (check #32). This field is informational brainstorm context that doesn't need to be in the state file long-term. Future: truncate or move to spec.md on completion.
