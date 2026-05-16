# concurrency-guards — Cross-worktree slug collisions + same-worktree write races

## Purpose

Close two unguarded concurrency surfaces in the masterplan framework, surfaced by analysis on 2026-05-16:

1. **Cross-worktree slug collision.** Two worktrees of the same repo can create `docs/masterplan/<same-slug>/state.yml` independently. The v5.0 schema (`parts/contracts/run-bundle.md:17-44`) carries no `worktree:` or owner field; older fixtures still do (`bin/masterplan-anomaly-smoke.sh:148`) but the live schema dropped them. Two independent bundles diverge silently; on eventual merge they conflict on `state.yml`, and `events.jsonl` (append-only) produces irreconcilable EOF conflicts that break the JSONL readers in `hooks/masterplan-telemetry.sh:195,249,552,773`.

2. **Same-worktree write race.** `bin/masterplan-state.sh` uses `mktemp` + rename (lines 380, 439) for atomic single writes but holds no mutex. The Stop-hook `hooks/masterplan-telemetry.sh` appends to `events.jsonl` concurrently with the foreground orchestrator's next turn. POSIX `O_APPEND` keeps lines whole, but writes interleave and `state.yml` updates suffer last-writer-wins. No `flock` exists anywhere in `bin/` or `hooks/`.

Both gaps are silent today: no anomaly event fires, no doctor check catches divergence, no peer-session detection exists.

## Scope (in)

- **Guard B — Slug-uniqueness check at run-bundle creation, with auto-suffix.** Before writing a new `docs/masterplan/<slug>/state.yml`, glob the same path across all worktrees in `git_state.worktrees`. If a peer match exists with `status: in_progress`, surface `AskUserQuestion` with three concrete options: resume the peer / auto-suffix to `<slug>-N` / abort. The auto-suffix path is the load-bearing one — it guarantees the two bundles never share a path, which means **the events.jsonl merge-conflict problem cannot occur**, because no two branches ever modify the same file.

- **Guard C — `flock` around state/event writes.** Wrap the write paths in `bin/masterplan-state.sh` (around the rename sites at lines 380, 439, plus the events-append paths) and the `events.jsonl` append in `hooks/masterplan-telemetry.sh` with `flock -w 5 "<bundle>/.lock" <existing-write>`. Five-second timeout so a stuck process fails loudly rather than wedging the orchestrator forever. Detect `flock(1)` absence at runtime and degrade with a one-line WARN (no behavior change) so non-Linux installs are not broken.

## Scope (out, deferred)

- **Guard D — Owner sentinel (`worktree:` + `owner: {host, pid, started_at, last_heartbeat}` in state.yml).** Captures active-peer-session detection and cross-machine collisions. Requires schema bump (v5.0 → v5.1), bundle migration, doctor-check additions, and a "force-take" UI for stale-lock recovery. Defer until B+C in production reveal incidents B+C cannot catch.

- **Guard A — Worktree-scoped paths (`docs/masterplan/<worktree-id>/<slug>/state.yml`).** Rejected: breaks every existing run bundle, breaks portability across machines (worktree paths are not stable across `~/dev/...` on epyc1 vs epyc2), couples the user's intentional slug to an accidental property of which worktree the run started in.

- **Cross-worktree lock.** Out of scope. `flock` on a path inside a worktree only locks that worktree's copy of the file. A cross-worktree mutex would require a shared lock surface (e.g., `.git/masterplan.lock`), which conflicts with the run-bundle-as-source-of-truth principle (CD-7). Guard B prevents the *creation* collision; Guard D would be the right answer for the *active-peer* collision if it becomes a real incident.

## Desired behavior

### Guard B — slug-uniqueness at creation

**Trigger sites:** Step B0 in `parts/step-b.md` (creating a new run bundle from a topic), and equivalent paths in `bin/masterplan-state.sh init` / `import` flows. Reuses Step A's existing cross-worktree glob — no new infrastructure.

**Algorithm:**

1. Compute the candidate slug (existing slugifier; unchanged).
2. Issue one parallel Bash batch globbing `<worktree>/docs/masterplan/<slug>/state.yml` for each entry in `git_state.worktrees` (already cached in Step 0).
3. For each match found, dispatch one Haiku to parse the `status:` field (read-only; CD-7-compliant; `model: "haiku"`). Skip matches with `status: archived` or `status: complete`.
4. If zero remaining matches → proceed to create the bundle as today.
5. If ≥1 remaining matches → emit `AskUserQuestion`:
   ```
   "Slug `<slug>` is in-progress in <N> other worktree(s):
     1. <path-1> (branch <b1>, last activity <t1>)
     [...]
   Pick:"
   options:
     - "Resume the peer in <path-1>" (Recommended when N==1)  → Step A flow against that state.yml; cd to that worktree
     - "Auto-suffix this slug to `<slug>-<N+1>`"               → continue creation under new slug
     - "Abort"                                                  → end the turn
   ```
6. **Suffix scheme:** monotonic `-2`, `-3`, ... picked by globbing `<all-worktrees>/docs/masterplan/<slug>-*/` and taking `max(N)+1`. Document in `docs/internals.md`.

**Negative test:** running `/masterplan full deploy-x` in worktree-1, then again in worktree-2 with no peer-status-change in between, MUST surface the AUQ in worktree-2. Verifier:
```bash
# After worktree-1 run reaches step-b, in worktree-2:
test -d worktree-2/docs/masterplan/deploy-x   && echo "FAIL: silently shared slug" && exit 1
test -d worktree-2/docs/masterplan/deploy-x-2 || test "$user_picked" = abort \
  || (echo "FAIL: neither suffixed nor aborted" && exit 1)
```

### Guard C — `flock` in the canonical writer + telemetry hook

**Trigger sites:**

- `bin/masterplan-state.sh`: every block that ends in `mv "$tmp" "$target"` (lines 380, 439 + any add'l rename sites the implementer finds in a full audit).
- `bin/masterplan-state.sh`: every `>> "$events_path"` or equivalent append to `events.jsonl`.
- `hooks/masterplan-telemetry.sh`: the per-turn `events.jsonl` append.

**Pattern:**

```bash
lockfile="${bundle}/.lock"
if command -v flock >/dev/null 2>&1; then
  flock -w 5 "$lockfile" <existing-write-command-or-block>
else
  # Non-Linux/BSD install without util-linux flock.
  # WARN once per process, then proceed unlocked.
  if [[ -z "${MASTERPLAN_FLOCK_WARNED:-}" ]]; then
    echo "WARN: flock(1) not found; concurrent writes to ${bundle} are unguarded" >&2
    export MASTERPLAN_FLOCK_WARNED=1
  fi
  <existing-write-command-or-block>
fi
```

**Five-second timeout rationale:** any single state-write operation completes in tens of milliseconds. Five seconds is "something is wedged" territory, not "contention" territory. On timeout, exit non-zero with a clear error so the orchestrator's CD-4 ladder kicks in (read error → retry → escalate) rather than silently dropping the write.

**Non-Linux fallback:** the install is Linux-tested; the plugin is cross-platform-aspirational. `flock(1)` is shipped on Linux (`util-linux`) and BSD but not macOS by default (requires `brew install util-linux`). The fallback above degrades to current behavior (unguarded) with a one-time WARN so macOS installs are not broken and the operator knows the guarantee is weakened.

**Negative test:** spawn two `bin/masterplan-state.sh append-event ...` invocations in tight loop in the same shell (`for i in {1..100}; do ... & done`); expect zero corrupted lines in `events.jsonl` (every line a valid JSON object) and zero overwrites in `state.yml.recent_events`.

## Constraints

- **CD-7 (run bundle is source of truth):** Both guards write only to files inside the run bundle. No external lock service, no `.git/` writes.
- **CD-2 (user-owned worktree):** The `.lock` file is the only new file; it lives inside the bundle dir, which masterplan owns. No writes to user-owned files outside the bundle.
- **CD-3 (verification before completion):** Each guard ships with a negative test (above). A successful smoke must demonstrate the prevented collision.
- **CD-9 (concrete-options AUQ):** Guard B's collision prompt uses `AskUserQuestion` with 2–4 options, recommended-first, never trailing prose.
- **Schema stability:** Neither guard changes `parts/contracts/run-bundle.md`. v5.0 schema is preserved. (Guard D would bump to v5.1; that's deferred.)
- **Cross-platform:** Guard C must not break macOS installs. Fallback above is mandatory, not optional.
- **No new doctor check required for B.** Auto-suffix at creation means the collision the doctor would have to detect cannot exist on disk. (Guard D would need one.)
- **One new doctor check candidate for C:** detect `.lock` files older than 1 hour as evidence of a wedged write. Out of scope for this spec unless brainstorm adds it.

## Brainstorm decisions (2026-05-16)

Resolved in-session against the spec's own constraints (CD-2, CD-3, CD-7, CD-9) and the cited grounding in `parts/step-a.md:29`, `parts/import.md`, and `bin/masterplan-state.sh:380,439`. Override path: pick "Re-run brainstorming to refine" at the B1 close-out gate.

### D1 — Resume-peer `cd` is silent (no confirmation prompt)

Mirror Step A's existing silent-cd behavior (`parts/step-a.md:29`). The user has already picked "Resume the peer in <path>" from the AUQ — adding a second confirmation diverges from established flow without adding safety. Surface the destination path in the `AskUserQuestion` option label itself (e.g., "Resume the peer in `/home/ras/dev/sp-mp-wt2`") so the user sees the target before clicking.

### D2 — Stale peer worktree is a 4th AUQ option

When `git worktree list` lists a peer path that no longer exists on disk (deleted or moved out-of-band), surface a 4th option in the Guard B AUQ:

> "Peer worktree at `<path>` no longer exists — treat as orphaned and proceed with original slug."

CD-2 forbids invoking `git worktree prune` from inside the orchestrator (touches user-owned git state without explicit ask). The user can prune at their leisure; the orphan-acknowledge option lets the run proceed without forcing them to clean first. Detection: `[ -d "$peer_worktree" ]`. Total AUQ options stay within CD-9 (2–4); when no peers are stale, the 4th option is omitted and the AUQ shows the standard three.

### D3 — Auto-suffix increment is global across worktrees

Compute `max(N) + 1` across the union of `<all-worktrees>/docs/masterplan/<slug>-*/state.yml` matches. Per-worktree incrementing is simpler but reintroduces the exact class of bug Guard B exists to close — a `-2` in worktree-A and a `-2` in worktree-B is a future merge conflict on the same path. The scan reuses Step 0's already-cached `git_state.worktrees`; cost is one parallel-Bash glob batch, same shape as the primary collision check.

### D4 — Telemetry hook uses blocking `flock -w 5`, not non-blocking `-n`

The Stop-hook append to `events.jsonl` MUST use `flock -w 5` (blocking, 5-second timeout), not `flock -n` (non-blocking, skip-on-contention). `events.jsonl` is the audit trail — silent event drops are the exact failure mode Guard C exists to prevent; degrading from "interleaved writes" to "missing events" trades one corruption class for a worse one. The 5-second window is far above realistic contention (single-event writes complete in tens of milliseconds) and squarely in "something is wedged" territory; on timeout, the hook exits non-zero with a clear error so the orchestrator's CD-4 read-error ladder kicks in. Same pattern applies to `bin/masterplan-state.sh` writes.

### D5 — Add stale-`.lock` doctor check at WARN severity

Add a new doctor check (number assigned by implementer per the parallelization brief in `parts/doctor.md`): for each run bundle, stat `<bundle>/.lock` if present; WARN when mtime is older than 1 hour. Older `.lock` files are evidence of a wedged or orphaned writer that crashed before `flock` released. WARN (not ERROR) is correct because:

- The framework still functions — the next write blocks 5s, then proceeds when `flock` reaps the abandoned lock.
- False-positive risk is non-zero (a legitimate long-running write during the stat window).
- Cost is one `stat(2)` per bundle — well within doctor's existing budget.

Recommended fix surfaced by the check: `rm <bundle>/.lock` after confirming no live writer (operator judgment; no auto-remediation).

### D6 — Guard B fires on `import`, NOT on `plan --from-spec=<path>`

- **`import` (parts/import.md Step I3) → YES, fires Guard B.** The import flow creates a new `docs/masterplan/<slug>/` bundle dir from external sources (legacy `docs/superpowers/...`, file paths, topic strings). It is a creation site, indistinguishable from `/masterplan full <topic>` for collision purposes. Add Guard B as a pre-creation check at the same point as Step B0's slug-uniqueness scan.

- **`plan --from-spec=<path>` → NO, does not fire Guard B.** Step B0a (parts/step-b.md:150-163) `cd`s into the spec's containing worktree and proceeds to B2 against the existing bundle. It does not create a new `docs/masterplan/<slug>/` dir — the dir already exists by definition (it contains the spec being planned against). Adding Guard B here would either no-op or false-fire on the bundle's own state.yml.

Verifier for Guard B on import: run `bin/masterplan-state.sh import` against a slug that already exists in a peer worktree; expect the AUQ to surface, not silent overwrite.

## Success criterion

After implementation:

1. Re-run the cross-worktree negative test above → AUQ surfaces in worktree-2; no silent shared slug.
2. Re-run the same-worktree race test → 100 concurrent appends produce 100 valid JSONL lines, no `state.yml.recent_events` overwrites.
3. `bash -n` clean on every modified shell file.
4. Existing run bundles unaffected — no schema migration, no path move, no events shape change.
5. macOS `flock`-absent install runs the smoke without erroring; emits the one-line WARN.

## How to run (when ready)

```
/masterplan brainstorm docs/masterplan/concurrency-guards/spec.md
```

Brainstorm resolves the open questions above into design decisions; `/masterplan plan` then produces `plan.md` against the resolved spec; `/masterplan execute` ships B and C as separate waves (B first — it eliminates the dominant collision mode; C second — it closes the residual same-worktree race).
