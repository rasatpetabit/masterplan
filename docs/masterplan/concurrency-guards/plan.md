# concurrency-guards — Implementation Plan (Guards B + C)

**Goal.** Close the two unguarded concurrency surfaces documented in [`spec.md`](spec.md): cross-worktree slug collisions (Guard B) and same-worktree state/event write races (Guard C). Schema stays at v5.0; no Guard D, no Guard A, no cross-worktree lock. Decisions D1–D6 from `spec.md#Brainstorm decisions (2026-05-16)` are baked-in inputs and not re-litigated.

**Architecture.** Two independently shippable waves:

- **Wave 1 — Guard B (slug uniqueness + auto-suffix + AUQ).** Pre-creation check in Step B0 (`parts/step-b.md`) and Step I3 (`parts/import.md`). Eliminates the dominant failure mode: two bundles ever sharing a path. Because no shared path is created, the irreconcilable `events.jsonl` merge-conflict class is closed as a corollary.
- **Wave 2 — Guard C (`flock -w 5` around state/event writes + macOS fallback + stale-`.lock` doctor check).** Wraps the rename and append sites in `bin/masterplan-state.sh` and the per-turn append in `hooks/masterplan-telemetry.sh`. Adds a new doctor WARN for `.lock` files older than 1 hour as evidence of a wedged writer.

Wave 1 first because it eliminates the dominant collision mode (spec's own success-ordering rationale, `spec.md#How to run`). Wave 2 second; it is independent — no Wave-1 artifact is required to execute Wave 2.

**Out of scope (binding — do NOT add to a future wave from this plan):** Guard D (owner sentinel + `worktree:` re-add + schema bump); Guard A (worktree-scoped paths); cross-worktree mutex on `.git/masterplan.lock`; any schema change to `parts/contracts/run-bundle.md` (v5.0 stays at v5.0); any CI; any new external dependency. The execute agent must refuse "while we're here" cleanup of unrelated files.

**Constraints summary.** CD-2 (no writes outside the bundle except the intentional in-scope files in `bin/`, `hooks/`, `parts/`); CD-3 (each wave's success criterion is a cited negative-test output, not "should work"); CD-7 (orchestrator is canonical writer — this constrains the *execute* turns when Wave 1/2 run; the plan itself is plan-only); CD-9 (AUQs in Guard B carry 2–4 concrete options, no trailing prose).

---

## Wave 1 — Guard B (slug uniqueness + auto-suffix + AUQ)

**Independently shippable.** Wave 1 ends with a green negative-test artifact (two-worktree collision smoke) committed into the bundle.

### Task 1: Implement the slug-uniqueness pre-check helper

**Files:**
- Modify: `bin/masterplan-state.sh` (new subcommand `check-slug-collision <slug>`)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L29-L58](spec.md#L29-L58)
**Verify:**
```bash
bash -n bin/masterplan-state.sh
bin/masterplan-state.sh check-slug-collision __nonexistent-slug__ \
  | jq -e '.collisions == [] and .suffix == "__nonexistent-slug__"'
```

- [ ] **Step 1: Add a `check-slug-collision` subcommand to `bin/masterplan-state.sh`.**

  Insert a new `case` arm in the early-dispatch block alongside the existing `transition-guard` / `session-sig` arms (i.e., before the generic flag-parsing loop at L497). Positional arg shape:

  ```
  bin/masterplan-state.sh check-slug-collision <slug>
  ```

  Implementation (read-only; CD-7-compliant — emits JSON to stdout only, no state writes):

  1. Enumerate worktrees via `git worktree list --porcelain` (matches the pattern in `transition-guard` at L249-254). Parse `^worktree ` lines into an absolute-path list. Include the current worktree.
  2. For each worktree, glob `<worktree>/docs/masterplan/<slug>/state.yml`. Run all globs as one parallel Bash batch where possible (background `&` + `wait`, matching the doctor parent-reverify pattern at `parts/doctor.md:51`). For each hit, read the `status:` field via the inline awk used by the telemetry hook at L548. Skip matches whose `status` is `archived`, `complete`, or `pending_retro`.
  3. For each in-progress match, also stat the peer worktree path — when `[ ! -d "$peer_worktree" ]`, flag the match `stale: true` (per D2).
  4. Compute the next free suffix per **D3** (global): glob `<all-worktrees>/docs/masterplan/<slug>-*/state.yml`, parse the trailing `-N`, take `max(N)+1`. If no suffix exists yet, start at `-2`. Worktrees that are listed but missing on disk are skipped for the glob (no error).
  5. Emit a JSON object to stdout:

     ```json
     {
       "slug": "<slug>",
       "collisions": [
         {"worktree": "<abs path>", "branch": "<short ref>",
          "last_activity": "<iso-ts or empty>", "stale": false}
       ],
       "suggested_suffix": "<slug>-N"
     }
     ```

  Exit 0 on success regardless of collision count. Exit 2 on argument-parse failure.

- [ ] **Step 2: Cover the stale-peer case in the JSON shape.**

  Verify the `stale` flag is emitted for any collision where `[ -d "$peer_worktree" ]` is false. This is the surface the caller in Tasks 2 and 3 uses to decide whether to render the 4th AUQ option (D2).

- [ ] **Step 3: Smoke from the command line.**

  ```bash
  bin/masterplan-state.sh check-slug-collision concurrency-guards \
    | jq '.'
  ```

  Expected: this slug currently exists only in the current worktree; shape matches the contract above.

---

### Task 2: Integrate Guard B into Step B0 (kickoff)

**Files:**
- Modify: `parts/step-b.md` (between L119 initial-state-write and L148 `run_created` event)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L29-L58](spec.md#L29-L58) [spec.md#L106-L116](spec.md#L106-L116)
**Verify:**
```bash
grep -nE 'Guard B|check-slug-collision' parts/step-b.md
grep -nE 'silent[- ]cd|D1' parts/step-b.md
```

- [ ] **Step 1: Insert a Step B0 sub-step `1d — Slug-uniqueness pre-check (Guard B)`.**

  Anchor: immediately AFTER step 1c (scope-overlap gate) at `parts/step-b.md:99` and BEFORE step 2 (worktree-recommendation compute). The placement is intentional — scope-overlap is a *content* gate (different topic, same fingerprint); Guard B is a *path* gate (same slug-on-disk in a peer worktree). They are independent and must both run.

  Inline spec (paraphrase into `parts/step-b.md` in the existing numbered-step prose style):

  > 1d. **Slug-uniqueness pre-check (Guard B).** Compute the candidate slug per step 6's slugifier. Before any bundle creation, run `bin/masterplan-state.sh check-slug-collision <slug>` once. Parse the returned JSON. If `collisions` is empty, proceed to step 2 unchanged. Otherwise, fire the Guard B AUQ described below. Per D6, this sub-step fires on the kickoff/full path (B0). It does NOT fire on Step B0a (`plan --from-spec=<path>`, `parts/step-b.md:150-163`) — that flow `cd`s into an existing bundle by definition.

- [ ] **Step 2: Author the Guard B AUQ.**

  Persist `pending_gate.id: guard_b_slug_collision` BEFORE the surface call, matching the persist-then-surface pattern used by `id: spec_approval` at `parts/step-b.md:311`. Then surface `AskUserQuestion` with options assembled from the `check-slug-collision` JSON:

  ```
  question="Slug `<slug>` is in-progress in <N> other worktree(s):
    <one line per collision with path, branch, last_activity>
  What now?"
  options=[
    "Resume the peer in `<path-1>` (Recommended)"   # D1: silent cd, no second prompt
    "Auto-suffix to `<suggested_suffix>`"
    "Abort kickoff"
    # When ANY collision has stale: true (D2):
    "Peer worktree at `<stale-path>` no longer exists — treat as orphaned and proceed with original slug"
  ]
  ```

  The 4th option is rendered ONLY when at least one collision has `stale: true` (D2). Per CD-9, total options stay within 2–4 — the AUQ degrades to 3 options when no peers are stale and to 4 only when at least one is.

- [ ] **Step 3: Wire the option routing.**

  - **"Resume the peer in `<path-1>`"** → per **D1**, `cd` to `<path-1>` silently (mirror Step A's silent-`cd` precedent at `parts/step-a.md:29`). Update in-session state so the subsequent Step B flow runs against that worktree. Do NOT surface a second "are you sure?" confirmation. Append `{"event":"guard_b_peer_resumed","peer":"<path-1>"}` to the peer bundle's `events.jsonl`.
  - **"Auto-suffix to `<suggested_suffix>`"** → replace the candidate slug with `<suggested_suffix>`. Continue to step 2 (worktree-recommendation compute) unchanged. Append `{"event":"guard_b_auto_suffixed","original":"<slug>","new":"<suggested_suffix>"}` to the NEW bundle's `events.jsonl` (written at step 6).
  - **"Abort kickoff"** → clear `pending_gate`, append `{"event":"guard_b_aborted"}`, → CLOSE-TURN.
  - **"Peer worktree … treat as orphaned"** (D2) → ignore the stale collision in subsequent decisioning, proceed to step 2 with the ORIGINAL slug. Append `{"event":"guard_b_orphan_peer_acknowledged","peer":"<stale-path>"}`. CD-2: do NOT invoke `git worktree prune` from the orchestrator.

- [ ] **Step 4: Document the silent-cd precedent inline.**

  Add a one-line cross-reference inside the new sub-step: `(silent cd per parts/step-a.md:29 / D1)` so the next reader doesn't relitigate D1.

---

### Task 3: Integrate Guard B into Step I3 (import path)

**Files:**
- Modify: `parts/import.md` (between L46 and L62, augmenting the existing pre-flight collision section)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L136-L142](spec.md#L136-L142) [spec.md#L29-L58](spec.md#L29-L58)
**Verify:**
```bash
grep -nE 'Guard B|check-slug-collision' parts/import.md
```

- [ ] **Step 1: Augment Step I3 pre-flight to call `check-slug-collision`.**

  The existing **Slug-collision pass** (L48) handles *within-batch* collisions; the existing **Path-existence pass** (L52) handles *current-worktree on-disk* collisions. Neither covers the *cross-worktree* collision Guard B closes.

  Insert a new sub-section between the two existing passes:

  > **Cross-worktree slug pass (Guard B; per spec D6).** For each candidate's finalized slug, run `bin/masterplan-state.sh check-slug-collision <slug>`. When the response has `collisions != []`, surface the same Guard B AUQ described in `parts/step-b.md` Step B0 sub-step 1d (options + routing). Resume-peer skips the candidate (peer is authoritative). Auto-suffix rewrites the candidate's full `(slug, run_dir, spec_path, plan_path, state_path, events_path)` tuple — same shape as the within-batch collision rewrite at L48. Orphan-peer acknowledge proceeds with original. Abort removes the candidate from `candidates[]`.

- [ ] **Step 2: Preserve ordering.**

  Run order MUST be: (1) within-batch slug collision pass (existing), (2) cross-worktree slug pass (new — Guard B), (3) path-existence pass (existing). Order rationale: collapse *batch-internal* duplication first (one user-decision-per-slug rather than per-candidate); then close the cross-worktree gap; finally the existing defense-in-depth on-disk path check.

- [ ] **Step 3: Confirm Step B0a (`plan --from-spec=<path>`) is untouched.**

  Per **D6**, the import flow fires Guard B but `--from-spec` does not. Do NOT add a Guard B call inside the B0a sub-step at `parts/step-b.md:150-163`. Verify by grep:

  ```bash
  grep -nE 'check-slug-collision' parts/step-b.md
  ```

  Expected: a hit in the new Step B0 sub-step 1d only, NOT in B0a.

---

### Task 4: Wave-1 negative-test smoke (CD-3 verification gate)

**Files:**
- Create: `bin/masterplan-guard-b-smoke.sh`
- Modify: `docs/masterplan/concurrency-guards/events.jsonl` (append smoke evidence)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L52-L58](spec.md#L52-L58) [spec.md#L142](spec.md#L142) [spec.md#L144-L152](spec.md#L144-L152)
**Verify:**
```bash
bash -n bin/masterplan-guard-b-smoke.sh
bin/masterplan-guard-b-smoke.sh
test "$(jq -r 'select(.event=="guard_b_smoke_pass") | .ts' \
  docs/masterplan/concurrency-guards/events.jsonl | tail -1)" != ""
```

- [ ] **Step 1: Author `bin/masterplan-guard-b-smoke.sh`.**

  Self-contained bash; no execution of `/masterplan` required. Drives `bin/masterplan-state.sh check-slug-collision` directly against a synthetic two-worktree fixture in `$TMPDIR`.

  Algorithm:
  1. `tmp=$(mktemp -d -t guard-b-smoke-XXXXXX); cd "$tmp"`.
  2. `git init -q wt-primary; cd wt-primary; git commit --allow-empty -q -m init`.
  3. `git worktree add -q ../wt-secondary -b secondary`.
  4. In `wt-primary`, create a fake in-progress bundle: `mkdir -p docs/masterplan/deploy-x; printf 'status: in-progress\nslug: deploy-x\n' > docs/masterplan/deploy-x/state.yml`.
  5. From `wt-secondary`, invoke `<repo-root>/bin/masterplan-state.sh check-slug-collision deploy-x` and capture stdout.
  6. Assertions (exit 1 on any failure with a `FAIL:` message):
     - `jq -e '.collisions | length > 0'` non-empty.
     - `jq -e '.collisions[0].worktree | endswith("wt-primary")'`.
     - `jq -e '.suggested_suffix == "deploy-x-2"'`.
     - `[ -d wt-secondary/docs/masterplan/deploy-x ]` returns FALSE (we never created the secondary bundle silently).
  7. Append one success event to the smoke evidence file:

     ```
     {"ts":"<iso>","event":"guard_b_smoke_pass",
      "fixture":"<tmp>","detected_collisions":<N>,
      "suggested_suffix":"deploy-x-2"}
     ```

     into `docs/masterplan/concurrency-guards/events.jsonl` (this is the in-bundle artifact CD-3 cites).
  8. `rm -rf "$tmp"`.

  Stale-peer variant (extends step 6 with a second pass): delete `wt-secondary` (`git worktree remove --force wt-secondary` then `rm -rf wt-secondary`), re-run `check-slug-collision deploy-x` from `wt-primary`, assert `.collisions[0].stale == true`.

- [ ] **Step 2: Run the smoke; capture the trailing event.**

  ```bash
  bin/masterplan-guard-b-smoke.sh
  tail -n2 docs/masterplan/concurrency-guards/events.jsonl
  ```

  CD-3: cite the trailing `guard_b_smoke_pass` event line in the wave-completion digest. Without that line, Wave 1 is NOT complete regardless of code-edit completeness.

- [ ] **Step 3: Bash-syntax-check every Wave-1-modified file.**

  ```bash
  bash -n bin/masterplan-state.sh
  bash -n bin/masterplan-guard-b-smoke.sh
  ```

  Both must exit 0. Markdown edits to `parts/step-b.md` and `parts/import.md` are content-only — no syntax check applies.

---

### Task 5: Wave-1 sync'd-locations + README updates

**Files:**
- Modify: `README.md` (Behavior / Concurrency subsection)
- Modify: `docs/internals.md` (concurrency-guards section + suffix scheme documentation per spec L50)
- Modify: `CHANGELOG.md` (Wave-1 entry — held to next release boundary; do NOT bump version in this wave)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L50](spec.md#L50) [spec.md#L92-L101](spec.md#L92-L101)
**Verify:**
```bash
grep -nE 'Guard B|slug-uniqueness|cross-worktree' README.md docs/internals.md
grep -nE 'concurrency-guards' CHANGELOG.md
```

- [ ] **Step 1: README behavior note.**

  One short subsection describing the Guard B AUQ surface and the auto-suffix scheme. Cite that suffix is global across worktrees (D3) and that import fires Guard B but `--from-spec` does not (D6).

- [ ] **Step 2: `docs/internals.md` suffix-scheme documentation.**

  Spec L50 requires this: "Suffix scheme: monotonic -2, -3, … picked by globbing `<all-worktrees>/docs/masterplan/<slug>-*/` and taking `max(N)+1`. Document in `docs/internals.md`."

  Add as a subsection of whichever internals chapter covers run-bundle creation. Note explicitly: scope is *global across worktrees*, not per-worktree (D3); this prevents a future merge collision between `worktree-A/...-2/` and `worktree-B/...-2/`.

- [ ] **Step 3: CHANGELOG entry held to release time.**

  Add a Wave-1 line under an "Unreleased" header. Do NOT bump manifest versions in this wave — version coordination is release-time work and is out of scope here per CLAUDE.md "sync'd locations" rule context.

---

### Wave 1 success criterion (CD-3)

A successful Wave 1 close-out digest cites:

1. `bash -n` clean for `bin/masterplan-state.sh` and `bin/masterplan-guard-b-smoke.sh`.
2. Output of `bin/masterplan-guard-b-smoke.sh` showing the collision AND the stale-peer second pass.
3. The trailing `guard_b_smoke_pass` event line from `docs/masterplan/concurrency-guards/events.jsonl`.
4. Grep results from Task 2 / 3 / 5's verify blocks.

Without (2) and (3), Wave 1 is NOT marked complete — "should work" is not evidence (CD-3).

### Wave 1 rollback

Guard B is a pre-check; reverting it returns the framework to current behavior. To roll back: `git revert` the Wave-1 commit; no schema migration, no state-file rewrite, no data loss. The new `check-slug-collision` subcommand is additive (no removal of existing subcommands), so rollback never breaks an in-flight masterplan run.

---

## Wave 2 — Guard C (`flock -w 5` + macOS fallback + stale-`.lock` doctor check)

**Independently shippable.** Wave 2 is independent of Wave 1 — no Wave-1 artifact is required. The negative-test gate is the 100-concurrent-append smoke from `spec.md#L89`.

### Task 6: Add the `with_bundle_lock` helper to `bin/masterplan-state.sh`

**Files:**
- Modify: `bin/masterplan-state.sh` (new helper function placed before the early-dispatch block at L48)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L60-L87](spec.md#L60-L87) [spec.md#L122-L124](spec.md#L122-L124)
**Verify:**
```bash
bash -n bin/masterplan-state.sh
grep -nE 'with_bundle_lock|MASTERPLAN_FLOCK_WARNED' bin/masterplan-state.sh
```

- [ ] **Step 1: Add the helper.**

  Insert near the top of `bin/masterplan-state.sh`, after the initial comment block and `set -u` at L41 and BEFORE the positional dispatch:

  ```bash
  # Guard C — wrap a write command in flock -w 5. Bundle owns the lockfile.
  # On macOS / non-Linux installs without util-linux flock(1), degrade to
  # the existing unguarded write with a one-time WARN per process. See
  # docs/masterplan/concurrency-guards/spec.md L60-L87.
  with_bundle_lock() {
    local bundle="$1"; shift
    local lockfile="${bundle}/.lock"
    mkdir -p "$bundle" 2>/dev/null || true
    if command -v flock >/dev/null 2>&1; then
      flock -w 5 "$lockfile" "$@"
      local rc=$?
      if [[ $rc -ne 0 ]]; then
        echo "ERROR: flock -w 5 on $lockfile failed (rc=$rc); writer wedged?" >&2
        return $rc
      fi
    else
      if [[ -z "${MASTERPLAN_FLOCK_WARNED:-}" ]]; then
        echo "WARN: flock(1) not found; concurrent writes to ${bundle} are unguarded" >&2
        export MASTERPLAN_FLOCK_WARNED=1
      fi
      "$@"
    fi
  }
  ```

  Notes for the implementer:
  - `flock -w 5` is *blocking* with 5 s timeout per **D4** — NOT `-n` (which would silently drop events on contention).
  - Non-zero `flock` exit must surface as a clear ERROR so the orchestrator's CD-4 read-error ladder fires (spec L85).
  - Lockfile `<bundle>/.lock` is the only new file. It lives inside the bundle, owned by masterplan — CD-2 compliant.

- [ ] **Step 2: Sanity-check existence of helper.**

  ```bash
  bash -c 'source bin/masterplan-state.sh 2>/dev/null; type with_bundle_lock'
  ```

  Note: `bin/masterplan-state.sh` is a script, not a library. This sourcing trick is for the type-check only; if the file exits on source (it likely does via early-dispatch on a missing subcommand), then either (a) the type-check exits cleanly *before* the dispatch with `set -u` warning, or (b) the implementer wraps the helper in a `if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then return 0; fi` early-return at the bottom of the helper-definition section. Pick whichever is least invasive.

---

### Task 7: Wrap the state.yml + events.jsonl write sites in `bin/masterplan-state.sh`

**Files:**
- Modify: `bin/masterplan-state.sh` (rename sites at L361, L416 + any other `mv "$tmp" "$target"` / append `>>` paths the implementer surfaces in a full audit)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L62-L66](spec.md#L62-L66) [spec.md#L122-L124](spec.md#L122-L124)
**Verify:**
```bash
bash -n bin/masterplan-state.sh
grep -nE 'with_bundle_lock' bin/masterplan-state.sh
# Every rename site should be inside or preceded by a with_bundle_lock call
grep -nE 'mv "\$tmp_?[a-z_]*" "\$[a-z_]+"' bin/masterplan-state.sh
```

- [ ] **Step 1: Audit and enumerate every write site.**

  Run this enumeration in the implementer's first step (paste results into the wave digest):

  ```bash
  grep -nE 'mv "\$tmp[^"]*" "\$[a-z_]+"|>> "\$[a-z_]+"' bin/masterplan-state.sh
  ```

  At time of plan-write, known sites are:
  - L361 (`os.replace(tmp_path, state_path)` inside `migrate-state`'s python heredoc — this is an *atomic single-write* by the python subprocess; the surrounding bash invocation is what `with_bundle_lock` wraps).
  - L416 (`mv "$tmp" "$plan"` in `migrate-plan`).
  - L487 (`mv "$tmp_out" "$out"` in `build-index`).

  Spec at L62-L66 refers to these as "L380, L439 + any add'l rename sites" (1-based, pre-edit). The implementer MUST re-enumerate post-merge in case line numbers drift.

- [ ] **Step 2: Wrap each rename block in `with_bundle_lock`.**

  Factor the rename + temp-cleanup into a small inner function called via `with_bundle_lock "$bundle" my_inner_rename_fn args...`. The hard constraint is that the temp-write and the `mv` BOTH execute while the bundle lock is held — splitting them across the lock re-introduces the race.

- [ ] **Step 3: Wrap any `>> "$events_path"` append sites.**

  Search for `>> .*events` patterns. At plan-write time the script doesn't append directly to `events.jsonl` from the bash layer (the python in `legacy_line_event` / `write_events` at L965-L988 writes the file via python `open(..., "w")` ONCE, atomically, so no lock is needed there). If the implementer's audit surfaces a `>>` append site that *does* bypass the atomic-write path, wrap it.

- [ ] **Step 4: Confirm CD-7 unchanged.**

  Guard C MUST NOT change what's written, only the serialization guarantee. Diff the pre- and post-edit output of `migrate-plan` and `build-index` against a fixture bundle; they must produce byte-identical output.

---

### Task 8: Wrap the per-turn `events.jsonl` append in `hooks/masterplan-telemetry.sh`

**Files:**
- Modify: `hooks/masterplan-telemetry.sh` (the per-turn append at L283 + the two `subagents_file` appends at L306 / L449 + the `anomalies_file` append at L606)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L60-L87](spec.md#L60-L87) [spec.md#L122-L124](spec.md#L122-L124)
**Verify:**
```bash
bash -n hooks/masterplan-telemetry.sh
grep -nE 'flock -w 5|MASTERPLAN_FLOCK_WARNED' hooks/masterplan-telemetry.sh
```

- [ ] **Step 1: Source-or-inline the helper.**

  The telemetry hook is independently invoked by Claude Code at Stop — it does NOT source `bin/masterplan-state.sh`. Two acceptable approaches:

  - **(A) Inline the helper at the top of the hook.** Lower coupling; same body as Task 6's `with_bundle_lock`. The `MASTERPLAN_FLOCK_WARNED` export coordinates across both files within a process tree (subprocesses inherit the env var).
  - **(B) Source `bin/masterplan-state.sh` and exit-on-source early.** Higher coupling; risks `set -u` halting the hook on unset vars from the script's dispatch path.

  **Recommended: (A).** Hook is bail-silent by contract (`hooks/masterplan-telemetry.sh` already follows this pattern at L199's `ensure_telemetry_excluded || bail`); inline keeps the bail-silent invariant intact and avoids cross-file failure modes.

- [ ] **Step 2: Wrap the Stop-hook `out_file` append at L283.**

  The current site is:

  ```bash
  jq -nc ... '{ ... }' >> "$out_file" 2>/dev/null
  ```

  Rewrite using the `with_bundle_lock` wrapper around a small inner function that performs the jq+append. `$plans_dir` resolves to the bundle directory when `is_bundle == 1`; the `out_file` is inside it. When `is_bundle == 0` (legacy status-file mode), Guard C is *skipped* — pass-through unchanged. Wrap accordingly:

  ```bash
  if [[ "$is_bundle" -eq 1 ]]; then
    with_bundle_lock "$plans_dir" _append_event_jsonl  # inner fn closes over out_file etc.
  else
    jq -nc ... >> "$out_file" 2>/dev/null
  fi
  ```

- [ ] **Step 3: Wrap the `subagents_file` appends at L306 and L449.**

  Same pattern. `subagents_file` lives in the bundle when `is_bundle == 1`; only wrap in that branch.

- [ ] **Step 4: Wrap the `anomalies_file` append at L606.**

  Same pattern. The anomaly-record write is single-line JSONL and is the highest-frequency append; lock contention is the most likely *here* if any.

- [ ] **Step 5: Preserve bail-silent contract.**

  `flock` non-zero exit MUST NOT escape the hook (would break Claude Code's Stop-hook integration). Wrap each `with_bundle_lock` call in `2>/dev/null` at the hook invocation level OR have the hook's own `bail` function catch the non-zero exit (matches the existing `bail` pattern at L199). Either way: a wedged write degrades to silent drop at the *hook*, NOT to a hung session.

---

### Task 9: Add the stale-`.lock` doctor check (D5 — WARN severity)

**Files:**
- Modify: `parts/doctor.md` (Severity table at L67 + per-check section + complexity-aware lists at L57-L60)
- Modify: `commands/masterplan-contracts.md` (if the new check joins the per-worktree Haiku brief — verify by reading the contract file first)
- Modify: `README.md` (command/check table — implementer should grep first)
- Modify: `docs/internals.md` (doctor routing table — implementer should grep first)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L100](spec.md#L100) [spec.md#L126-L134](spec.md#L126-L134)
**Verify:**
```bash
# Doctor check count should match the parallelization brief's claim
grep -cE '^\| [0-9]+ \|' parts/doctor.md     # row count
grep -nE 'currently #1-24, #26' parts/doctor.md  # update if implementer added the check to the brief list
grep -nE 'stale[-_ ]?\.?lock|stale_lock' parts/doctor.md
```

- [ ] **Step 1: Assign the next check number.**

  Last check in the table is **#41**. The implementer assigns the next available number — almost certainly **#42** unless another concurrent change has landed first. The implementer MUST grep the table at edit-time:

  ```bash
  grep -oE '^\| [0-9]+ ' parts/doctor.md | sort -n | tail -5
  ```

  Use the next integer after `max()`.

- [ ] **Step 2: Add the row to the severity table at L67.**

  Following the existing row format. Severity column: `Warning`. `--fix` column: `Report only` (no auto-remediation — operator must judge whether a long-running write is legitimate before `rm`-ing the lock).

  Inline description (paraphrase per house style):

  > **Stale `.lock` file in bundle.** For each run bundle, stat `<bundle>/.lock` if present; WARN when mtime is older than 1 hour. Indicates a writer crashed or wedged before releasing `flock`. WARN (not ERROR): the framework still functions — the next write blocks 5 s, then proceeds when `flock` reaps the abandoned lock. False-positive risk is non-zero (a legitimate long-running write during the stat window). Cost is one `stat(2)` per bundle. Recommended fix: `rm <bundle>/.lock` after confirming no live writer.

- [ ] **Step 3: Add the per-check section.**

  Follow the existing `## Check #N — <name>` pattern (see L111-L117 for #1's shape). Include severity, prose body, and fix-action. Place in numerical order at the end of the file.

- [ ] **Step 4: Update the complexity-aware check lists at L57-L60.**

  The new check applies to `low`, `medium`, AND `high` plans (it's a cheap structural check on a single file per bundle). Update the three bullets accordingly to include the new number. Per CLAUDE.md: "Doctor checks: the parallelization brief's count must match the table size."

- [ ] **Step 5: Update sync'd locations.**

  Per CLAUDE.md anti-pattern #4: "Don't introduce a new verb or doctor check without updating all sync'd locations." Grep before editing:

  ```bash
  grep -rnE 'check ?#?[0-9]+' README.md docs/internals.md commands/masterplan-contracts.md
  ```

  Update any check-count references the implementer finds. At plan-write time the suspect locations are:
  - `parts/doctor.md` L3 — version-history sentence ("Checks #32-#36 added in Wave C. … Checks #39-#41 added in v5.1.1"). Append the new check number.
  - `parts/doctor.md` L21 — per-worktree Haiku brief check-list (`currently #1-24, #26, #28, #29, #32, #34, #35, #40, #41`). Add the new number.
  - The doctor.schema_v2 / doctor.repo_scoped.schema_v1 contracts in `commands/masterplan-contracts.md` — verify by grep whether the new check is plan-scoped (the spec says "for each run bundle" — plan-scoped) and which Haiku contract should own it.
  - `README.md` and `docs/internals.md` doctor sections — only if they reference a check-count or per-check list. Grep first.

- [ ] **Step 6: Implement the actual check.**

  Plan-scoped — runs per bundle. Implementation goes into the per-worktree Haiku brief at `parts/doctor.md` L38-49 OR inline at the orchestrator's parent re-verify step at L51 (the spec calls out `stat(2)` per bundle as the work, which is trivially cheap). Recommended: inline in the parent re-verify Bash batch at L51 — it's already one parallel batch per bundle; add the `stat` to the same backgrounded job. That keeps the new check in a deterministic-bash code path (no LLM judgment surface).

  Output shape (one finding per stale lock):

  ```json
  {"check_id": <N>, "severity": "WARN",
   "file": "<bundle>/.lock",
   "message": "lockfile age <H>h <M>m exceeds 1h threshold; possible wedged writer"}
  ```

---

### Task 10: Wave-2 negative-test smoke (CD-3 verification gate)

**Files:**
- Create: `bin/masterplan-guard-c-smoke.sh`
- Modify: `docs/masterplan/concurrency-guards/events.jsonl` (append smoke evidence)

**Parallel-group:** none
**Codex:** no
**Spec:** [spec.md#L89](spec.md#L89) [spec.md#L144-L152](spec.md#L144-L152)
**Verify:**
```bash
bash -n bin/masterplan-guard-c-smoke.sh
bin/masterplan-guard-c-smoke.sh
test "$(jq -r 'select(.event=="guard_c_smoke_pass") | .ts' \
  docs/masterplan/concurrency-guards/events.jsonl | tail -1)" != ""
```

- [ ] **Step 1: Author `bin/masterplan-guard-c-smoke.sh`.**

  Self-contained; runs against a synthetic bundle in `$TMPDIR`.

  Algorithm:
  1. `tmp=$(mktemp -d -t guard-c-smoke-XXXXXX)`.
  2. `mkdir -p "$tmp/bundle"`.
  3. **100-concurrent-append test** (spec L89):

     ```bash
     for i in $(seq 1 100); do
       (
         with_bundle_lock "$tmp/bundle" bash -c \
           "printf '{\"ts\":\"%s\",\"event\":\"smoke_%03d\"}\n' \
             \"\$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)\" $i \
             >> \"$tmp/bundle/events.jsonl\""
       ) &
     done
     wait
     ```

     Source `bin/masterplan-state.sh` to expose `with_bundle_lock` OR inline a copy in the smoke script to avoid the source-side-effect issue.

  4. Assertions:
     - `wc -l "$tmp/bundle/events.jsonl"` exactly 100.
     - Every line parses as JSON: `jq empty < "$tmp/bundle/events.jsonl"` exit 0.
     - Every line is on its own line (no missing newline): `awk 'END{ exit !(NR==100) }' "$tmp/bundle/events.jsonl"`.

  5. **macOS-fallback case** (per spec L74-L83):

     Force the `command -v flock` check to fail by running the loop with `PATH=/nonexistent` AND verify:
     - The 100 writes still succeed (no error exit).
     - Exactly ONE `WARN: flock(1) not found` line appears on stderr (the once-per-process WARN). Capture the loop's combined stderr; `grep -c 'WARN: flock(1) not found'` must equal 1.

  6. **state.yml race case** (CD-3 explicit per spec L89 — "zero overwrites in `state.yml.recent_events`"):

     ```bash
     printf 'recent_events:\n  - existing entry\n' > "$tmp/bundle/state.yml"
     for i in $(seq 1 20); do
       (
         with_bundle_lock "$tmp/bundle" bash -c \
           "printf '  - new entry %03d\n' $i \
             >> \"$tmp/bundle/state.yml\""
       ) &
     done
     wait
     ```

     Assert: post-loop, `grep -c '^  - ' "$tmp/bundle/state.yml"` equals 21 (1 existing + 20 new). Zero lost writes.

  7. Append the success event to `docs/masterplan/concurrency-guards/events.jsonl`:

     ```
     {"ts":"<iso>","event":"guard_c_smoke_pass",
      "fixture":"<tmp>","appends":100,
      "macos_fallback_warn_count":1,"state_yml_lines":21}
     ```

  8. `rm -rf "$tmp"`.

- [ ] **Step 2: Run the smoke; capture the trailing event.**

  ```bash
  bin/masterplan-guard-c-smoke.sh
  tail -n2 docs/masterplan/concurrency-guards/events.jsonl
  ```

  CD-3: cite the `guard_c_smoke_pass` event line in the wave digest.

- [ ] **Step 3: Bash-syntax-check every Wave-2-modified file.**

  ```bash
  bash -n bin/masterplan-state.sh
  bash -n hooks/masterplan-telemetry.sh
  bash -n bin/masterplan-guard-c-smoke.sh
  ```

  All three must exit 0.

- [ ] **Step 4: Stale-lock doctor check smoke.**

  Create a `.lock` with old mtime and confirm the new doctor check flags it:

  ```bash
  tmp=$(mktemp -d -t guard-c-lock-smoke-XXXXXX)
  mkdir -p "$tmp/bundle"
  touch -d '2 hours ago' "$tmp/bundle/.lock"
  # Implementer adds the bash one-liner doctor uses inline to verify
  # mtime > 1h, then asserts WARN is emitted.
  rm -rf "$tmp"
  ```

  Append a `guard_c_doctor_check_smoke_pass` event with the result.

---

### Wave 2 success criterion (CD-3)

A successful Wave 2 close-out digest cites:

1. `bash -n` clean for `bin/masterplan-state.sh`, `hooks/masterplan-telemetry.sh`, and `bin/masterplan-guard-c-smoke.sh`.
2. Output of `bin/masterplan-guard-c-smoke.sh` showing all four assertions (100-append, JSON-validity, macOS-fallback WARN count, state.yml line count).
3. The trailing `guard_c_smoke_pass` event line from `docs/masterplan/concurrency-guards/events.jsonl`.
4. The trailing `guard_c_doctor_check_smoke_pass` event line.
5. Grep results showing `with_bundle_lock` is invoked at every write site enumerated in Task 7's audit.

### Wave 2 rollback

Guard C is a wrapper around existing writes; removing `with_bundle_lock` calls and the helper definition returns the framework to current behavior. To roll back: `git revert` the Wave-2 commit; the `.lock` files on disk are inert (no reader consults them outside the doctor check) — they can be left or swept with a one-shot `find docs/masterplan -name .lock -delete`. The new doctor check is additive; reverting it does not break existing doctor runs.

---

## D1–D6 traceability

A maintainer should be able to grep "D1" through "D6" in this plan and land at the implementing task. Map:

- **D1** — Resume-peer silent `cd`. **Task 2 Step 3** (first option's routing) + **Task 2 Step 4** (precedent cross-reference inline in `parts/step-b.md`).
- **D2** — Stale peer worktree 4th AUQ option. **Task 1 Step 2** (`stale: true` JSON flag) + **Task 2 Step 2** (4th option rendered only when any collision is stale).
- **D3** — Auto-suffix increment global across worktrees. **Task 1 Step 1 (4)** (glob `<all-worktrees>/docs/masterplan/<slug>-*/` for `max(N)+1`).
- **D4** — Telemetry hook uses blocking `flock -w 5`. **Task 6 Step 1** (helper hardcodes `-w 5`, never `-n`) + **Task 8** (telemetry hook calls the same helper).
- **D5** — Stale-`.lock` doctor check at WARN severity. **Task 9** (entire task).
- **D6** — Guard B fires on `import`, NOT on `--from-spec`. **Task 3 Step 3** (explicit grep-verifier that B0a is untouched) + the `parts/step-b.md` insert site at sub-step 1d is BEFORE step 2's recommendation compute and therefore runs for kickoff/full but B0a (which skips B0 entirely per `parts/step-b.md:150-152`) bypasses it by design.

---

## Build sequence (checklist)

Wave 1 (deliver before Wave 2):

- [ ] Task 1 — `check-slug-collision` subcommand
- [ ] Task 2 — Step B0 sub-step 1d + AUQ + routing
- [ ] Task 3 — Step I3 cross-worktree slug pass
- [ ] Task 4 — Guard B smoke + bundle evidence event
- [ ] Task 5 — README + internals + CHANGELOG-unreleased

Wave 2 (after Wave 1 ships):

- [ ] Task 6 — `with_bundle_lock` helper
- [ ] Task 7 — Wrap state/event writes in `bin/masterplan-state.sh`
- [ ] Task 8 — Wrap telemetry hook writes
- [ ] Task 9 — Stale-`.lock` doctor check + sync'd-locations updates
- [ ] Task 10 — Guard C smoke + bundle evidence events

---

## Out-of-scope reminders (binding)

- **Schema stays at v5.0.** Do not edit `parts/contracts/run-bundle.md`. Guard D's schema bump is deferred.
- **No worktree-scoped paths.** Do not introduce `docs/masterplan/<worktree-id>/<slug>/`. Guard A is rejected outright (spec L22).
- **No cross-worktree lock surface.** Do not create `.git/masterplan.lock` or any shared-state lock outside the bundle. CD-7 binds.
- **No new dependency.** `flock`, `jq`, `git`, `python3`, `mktemp`, `stat` are the toolset; nothing else.
- **No CI.** Verification ceiling is repo-local: `bash -n` + `grep` + the two smoke scripts. No PR-blocker rigging.
- **No version bump in either wave.** Version coordination is release-time work outside this plan. CHANGELOG gets an Unreleased entry per Task 5; manifests stay at current pin.
- **No "while we're here" cleanup.** If the implementer surfaces unrelated drift during the L361/L416/L487 audit, flag it as a follow-up — do not fix it in this plan's scope.

---

## Risk + rollback summary

Both guards are reversible by `git revert` with no data migration. Guard B is a pre-check on bundle creation — disabling it returns Step B0 / Step I3 to current "silently create on collision" behavior. Guard C is a wrapper around existing atomic writes — disabling it returns to current "atomic single write, no inter-write mutex" behavior. The `.lock` files left behind on rollback are inert (the doctor check is the only consumer, and it's reverted in the same revert).

The macOS-fallback path is the failure-mode boundary: a non-Linux install with no `util-linux flock(1)` runs Wave 2 with a one-line WARN per process and otherwise behaves as today. This is the desired degrade-loudly behavior (spec L74-L87 + D4 rationale).
