# Subagent + Model Execution Failure-Mode Audit

**Audit date:** 2026-05-05
**Plugin version audited:** 2.7.0 (`commands/masterplan.md` @ 1869 lines; `hooks/masterplan-telemetry.sh` @ 358 lines)
**Method:** read-only audit. Three parallel `Explore` subagents (Haiku) mapped dispatch sites, hook conditions, and categorical failure modes; orchestrator validated cited lines against the source; cross-referenced against the existing `internals.md§7` FM-1…FM-6 catalog.

This audit surfaces conditions under which `/masterplan`'s subagent dispatches and their assigned models could execute incorrectly. It is defensive engineering: every finding is cited to `file:line`, paired with the existing mitigation (or `null`), and tagged with the gap that mitigation does NOT close. No code is changed by this document. Follow-up fixes go through their own `/masterplan plan`.

---

## Severity legend

- **high** — silent wrong-answer, data loss, orchestrator stall, or undetected protocol violation under realistic conditions.
- **medium** — degraded but recoverable; misleading telemetry; cost regression; ambiguous-but-attributable behavior.
- **low** — cosmetic, ergonomic, or only triggered by adversarial usage / pathological environments.

---

## Executive summary — top high-severity findings

These are the issues most likely to cause a subagent to execute incorrectly without the orchestrator noticing. Each carries a one-line hardening hook; full detail is in the categorical sections.

1. **C.1 — Recursive model passthrough is prose-only.** `commands/masterplan.md:231,840`. SDD/executing-plans inner Task calls (`implementer`, `spec-reviewer`, `code-quality-reviewer`) inherit the orchestrator's Opus when the override clause is forgotten, mistyped, or silently dropped by an upstream prompt-template change. **Hook:** ship a one-shot lint over `Agent` dispatch sites that asserts `model:` is present and that SDD invocations include the override clause; emit a doctor-warning when missing.

2. **D.1 — Codex availability detection is a fragile string scan.** `commands/masterplan.md:37`. The "scan system-reminder skills list for `codex:` prefix" heuristic silently misclassifies under plugin renames, namespacing changes (`codex-cc:rescue`), or a partial install. Combined with `unavailable_policy: block` this can HALT a run that should have proceeded; combined with `degrade-loudly` it can silently fall through to inline. **Hook:** verify by attempting a 1-token `codex:codex-rescue` ping rather than a name scan; cache result for the run.

3. **D.4 — Mid-plan Codex availability change is not re-detected.** `commands/masterplan.md:1018`. Step 0 runs once at startup. If the codex plugin is uninstalled or restarted between Step 0 and Step C 4b, the gate at `1018` is stale. Review dispatch fails out-of-process; orchestrator silently skips review with no `## Notes` evidence. **Hook:** fold a lightweight availability re-check into the Step 4b precondition; on miss, write a degradation marker per the Step 0 pattern.

4. **E.1 — Wave-completion barrier has no timeout.** `commands/masterplan.md:836`. Orchestrator blocks until all N wave members return. A single hung Sonnet member strands the wave indefinitely; faster members' completions sit in orchestrator memory unwritten until manual kill. **Hook:** spec a per-member timeout (default `config.parallelism.member_timeout_sec: 600`) plus a graceful partial-completion path that flushes the survivors via the Step 4d single-writer funnel.

5. **G.1 — Trust-contract digest is unaudited.** `commands/masterplan.md:996-1003`. Step 4a reads `tests_passed: true` and `commands_run: [...]` from the implementer and skips re-running the listed commands. There is no verifier that the implementer actually executed those commands — fabricated lists pass through. The protocol-violation rule at `1001` only fires if a re-run happens; under the trust-skip path no verification fires at all. **Hook:** require implementer to return verification output (already partly captured) and run a 1-line digest check (e.g., regex match against a `npm test` PASS line) before honoring the skip.

6. **D.2 — Eligibility cache has no schema version.** `commands/masterplan.md:688-702`. Cache file persists across plugin upgrades. If the eligibility checklist or annotation schema changes in a `/masterplan` release, stale caches are loaded silently and their decisions become wrong. Doctor #14 catches orphan caches but not stale ones. **Hook:** add `cache_schema_version: <semver>` to the JSON shape; on load, mismatch → rebuild.

7. **F.4 — Status file rotation has no concurrent-write guard.** `commands/masterplan.md:1098-1106`. Step 4d's atomic write (`temp + fsync + rename`) assumes no concurrent writer. If the user is editing `## Notes` in their editor when Step 4d fires, the editor's save-on-quit can stomp Step 4d's commit or corrupt YAML frontmatter. **Hook:** wrap the rotation+append in `flock` over the status file; on contention, defer the write to the next Step 4d cycle.

---

## A. Model misselection

**Anchor:** §Agent dispatch contract (`commands/masterplan.md:217-235`). STRUCTURAL REQUIREMENT — every `Agent` tool call MUST pass `model:` explicitly; codex sites are the documented exception.

### A.1 — Recursive override is prose-only

- **Cite:** `commands/masterplan.md:231,840,864`
- **Severity:** high
- **Condition:** SDD/executing-plans skill invocations are dispatched without the model-passthrough override clause embedded in the brief (`When you dispatch inner Task/Agent calls, pass model: "sonnet" on every call`). Or the clause is included but garbled in an edit, or the upstream skill template stops parsing it.
- **Impact:** Inner Task calls (`implementer`, `spec-reviewer`, `code-quality-reviewer`) inherit the orchestrator's Opus model. Cost inflates 2–3× per task; quality variance between supposedly-uniform wave members.
- **Existing mitigation:** Line 231 mandates the clause as a STRUCTURAL REQUIREMENT; line 840 supplies exact wording; line 864 specifies re-dispatch handling.
- **Gap:** No programmatic enforcement. Telemetry's per-subagent JSONL captures `model` for top-level Agent calls but does not assert against expected-by-site. An upstream SDD prompt-template refactor could silently regress this without any doctor signal.
- **Recommended action:** Add a doctor check that scans recent `<plan>-subagents.jsonl` for `routing_class: "sdd"` records whose `model` is `opus`; warn unless the user explicitly chose the blocker re-engagement gate's stronger-model option that turn (entry visible in the activity log).

### A.2 — Wave-mode `model: "sonnet"` is per-call discipline

- **Cite:** `commands/masterplan.md:830`
- **Severity:** high
- **Condition:** A wave dispatches N parallel `Agent` calls; one of the calls is missing `model: "sonnet"` due to an edit error or template drift.
- **Impact:** That wave member runs under Opus while siblings run under Sonnet. Asymmetric cost; possibly asymmetric correctness if the Opus member arrives at a different decomposition than its siblings (wave's mutual-independence assumption depends on uniform reasoning).
- **Existing mitigation:** Line 830 mandates `Pass model: "sonnet" on each Agent call`.
- **Gap:** No structural enforcement. The wave is dispatched as N independent Agent tool uses in a single turn; missing parameter on one is invisible until telemetry post-mortem.
- **Recommended action:** Same as A.1's doctor signal — scan recent telemetry for `routing_class: "sdd"` waves with mixed models.

### A.3 — Step C step 1 Haiku must be `model: "haiku"`

- **Cite:** `commands/masterplan.md:661,720`
- **Severity:** medium
- **Condition:** Eligibility-cache builder Haiku dispatched without explicit `model: "haiku"`. The work is a deterministic 5-rule application — Sonnet/Opus on this is pure waste.
- **Impact:** Cost regression (3–5×); no correctness impact.
- **Existing mitigation:** Line 661 specifies `pass model: "haiku"`.
- **Gap:** Same as A.1/A.2 — prose-only.
- **Recommended action:** Same doctor signal scoped to `dispatch_site: "Step C step 1"` records.

### A.4 — I3 source-fetch model split is under-specified

- **Cite:** `commands/masterplan.md:196,1198`
- **Severity:** medium
- **Condition:** Step I3.2 fetch agents use Haiku for local files / issues / PRs but Sonnet for git branches (reverse-engineering "needs judgment"). The boundary between mechanical-extraction and judgment is fuzzy — a contributor adding a new source class (e.g., Linear ticket, Notion page) has no rule to follow.
- **Impact:** New source classes default arbitrarily; cost/quality drift.
- **Existing mitigation:** Lines 195-196 + 1198 cite the exception explicitly.
- **Gap:** No criterion. A future reverse-engineering style task on Linear could fall to Haiku silently.
- **Recommended action:** Document the criterion ("if the source contains free-text inferred-intent material → Sonnet; if it's structured-extraction → Haiku") in the §Model selection guide.

### A.5 — Codex sites must NOT pass `model:`

- **Cite:** `commands/masterplan.md:229,976,1052`
- **Severity:** low
- **Condition:** A contributor refactoring Step C 3a or 4b adds `model: "haiku"` (or any value) to a `codex:codex-rescue` Agent call.
- **Impact:** No runtime effect (codex routes out-of-process), but indicates a contract confusion that will mislead future debugging.
- **Existing mitigation:** Lines 229, 976, 1052 each repeat the exemption.
- **Gap:** Repetition fragility — three cites mean three places to forget.
- **Recommended action:** None beyond what's there. Acceptable.

---

## B. Briefing-contract violations

**Anchor:** §Bounded brief (`commands/masterplan.md:258-272`) — Goal/Inputs/Allowed scope/Constraints/Return shape.

### B.1 — Implementer required-fields contract is duplicated, not centralized

- **Cite:** `commands/masterplan.md:199,840` (orchestrator) + upstream SDD `implementer-prompt.md` (not in this repo)
- **Severity:** high
- **Condition:** Implementer's return digest is required to include `task_start_sha`, `tests_passed`, `commands_run`. The orchestrator brief at line 840 references these obliquely; the canonical schema lives in the dispatch-model table at 199. SDD's upstream `implementer-prompt.md` is the actual enforcer. If SDD's template drifts (a future SDD release renames a field, drops one, changes types), the orchestrator's downstream Step 4a (`996-1003`) and Step 4b (`1025`) break silently.
- **Impact:** `task_start_sha` missing → 4b cannot compute diff → blocker. `tests_passed` missing or wrong type → 4a's skip logic mis-fires. `commands_run` missing → 4a runs full verification (cost waste, no correctness loss).
- **Existing mitigation:** Line 1025 documents the `task_start_sha` blocker behavior. Line 1001 covers `tests_passed: false / missing`.
- **Gap:** No pre-dispatch validation of the implementer's return shape before stepping into 4a/4b. Validation is implicit per consumer.
- **Recommended action:** Add a single post-return validator in Step C step 4 (before 4a fires) that asserts the three required fields are present and well-typed; on failure, surface the protocol-violation gate immediately.

### B.2 — Eligibility cache builder Haiku brief omits the schema

- **Cite:** `commands/masterplan.md:720,688-702`
- **Severity:** high
- **Condition:** Step C step 1's Haiku brief at line 720 says "emit `{task_idx → {eligible, reason, annotated, parallel_group, files, parallel_eligible, parallel_eligibility_reason, dispatched_to: null, dispatched_at: null, decision_source: null}}`. Return=JSON only — no narration." The full cache-file JSON schema (with field types and constraints) lives at lines 688-702 in a separate subsection, not folded into the brief.
- **Impact:** Haiku may return JSON with missing fields, wrong types (string vs bool), or extra fields. Per-task routing decisions silently wrong.
- **Existing mitigation:** Line 720 lists the field names; line 680's "annotation-completeness scan IS the verifier" applies only to the inline path, not the Haiku path.
- **Gap:** No structural schema validation of Haiku's return JSON before storing as `eligibility_cache`.
- **Recommended action:** Inline the field-type schema into the Haiku brief at line 720; orchestrator runs a post-return JSON-schema check; on mismatch, fall back to inline-rebuild from annotations.

### B.3 — Annotation rejection criteria are not in the Haiku brief

- **Cite:** `commands/masterplan.md:680,720`
- **Severity:** medium
- **Condition:** The orchestrator's annotation-completeness scan at line 659-680 enforces strict rules (`**Codex:** ok|no` literal, case-sensitive, no trailing whitespace) before activating the inline fast-path. When the scan fails and falls back to Haiku at line 720, the Haiku does not receive these rejection criteria.
- **Impact:** Haiku may parse `**Codex:** OK` or `**Codex:** ok ` as eligible, classifying tasks the orchestrator's stricter scan rejected. Inconsistent treatment of the same plan between cold-build (Haiku) and warm-rebuild (inline).
- **Existing mitigation:** None — the silent-fallback design (line 680) treats inline and Haiku as equivalent.
- **Gap:** They are NOT equivalent if the parsers disagree.
- **Recommended action:** Pass the rejection criteria explicitly in the Haiku brief, OR have the inline-validator run on Haiku's return as a structural check.

### B.4 — Codex EXEC scope brief depends on user-provided file lists

- **Cite:** `commands/masterplan.md:980-986`
- **Severity:** medium
- **Condition:** Codex EXEC brief includes `Allowed files:` and `Do not touch:` lists. These come from the plan's `**Files:**` block. If the plan was authored at `complexity == low` (where `**Files:**` blocks are OPTIONAL per `commands/masterplan.md:538`), the brief is empty or under-specified.
- **Impact:** Codex creates files outside the intended scope. Step 4c's worktree-integrity check catches this (FM-5 mitigation), but only post-hoc; the wasted Codex tokens and the user's confusion remain.
- **Existing mitigation:** `complexity == low` is opt-in user choice; Step 4c filters porcelain against the union of Files blocks (`commands/masterplan.md:1083`).
- **Gap:** At `complexity == low`, `codex_routing` is also `off` by default (per `commands/masterplan.md:538`+complexity-precedence rule), so this rarely co-occurs. But under explicit `--codex=auto --complexity=low`, the combination is loaded and dangerous.
- **Recommended action:** Make `complexity == low` AND `codex_routing != off` an explicit Step 0 warning ("low complexity does not require Files blocks; Codex routing requires them — recommend --complexity=medium").

### B.5 — Wave-member `task_start_sha` requirement is reiterated without enforcement

- **Cite:** `commands/masterplan.md:832-834`
- **Severity:** medium
- **Condition:** Wave brief explicitly says `Capture git rev-parse HEAD BEFORE any work; return as task_start_sha (required per existing implementer-return contract)`. But wave members are read-only by Slice α design — no commits, so 4b is skipped entirely (`commands/masterplan.md:1113`). `task_start_sha` is therefore unused in the wave path.
- **Impact:** Brief carries a vestigial requirement; wave members may consume tokens capturing it; if a future Slice β/γ committing wave reuses the same brief, the field becomes load-bearing again but the path may have drifted.
- **Existing mitigation:** Line 1113 documents the wave-mode 4b skip.
- **Gap:** Two requirements (read-only + return SHA) interact subtly; the redundancy is not flagged.
- **Recommended action:** Drop `task_start_sha` from the wave-mode brief; reintroduce conditionally if Slice β lands.

### B.6 — Implementer brief omits explicit "do NOT modify status file" on serial path

- **Cite:** `commands/masterplan.md:840-842,1111`
- **Severity:** medium
- **Condition:** Wave-mode brief at line 832 explicitly says `DO NOT update the status file — orchestrator handles batched wave-end updates`. The serial-mode brief at line 840 does NOT include this clause — it relies on SDD's upstream contract.
- **Impact:** A serial-mode implementer that decides to write to the status file mid-task creates the contention FM-3 mitigation was designed to avoid. Single-writer funnel (`commands/masterplan.md:1111`) is enforced only for wave; under serial, only convention prevents it.
- **Existing mitigation:** SDD's `implementer-prompt.md` (upstream) presumably includes this; not verified in this audit.
- **Gap:** The orchestrator's brief does not say it. Drift in the upstream is undetectable.
- **Recommended action:** Add `DO NOT update the status file — orchestrator's Step 4d handles it` to the serial-mode brief at line 840 explicitly. Idempotent insurance.

---

## C. Recursive-dispatch model leakage

This is one issue with three cite anchors. The umbrella finding is A.1; the variants below are scenarios where the override might fail to reach the inner Task calls.

### C.1 — Override absent or malformed in SDD/executing-plans brief

- **Cite:** `commands/masterplan.md:231,840` (see also A.1 above for the full record)
- **Severity:** high
- **Note:** Same root cause as A.1; tracked here under the recursive-leakage class for category completeness. Mitigation and recommended action live with A.1.

### C.2 — Re-dispatch with `model: "opus"` retains inner-call Sonnet override

- **Cite:** `commands/masterplan.md:864`
- **Severity:** medium
- **Condition:** User picks "Re-dispatch with stronger model" at the blocker re-engagement gate. Orchestrator overrides outer Agent call to `model: "opus"`. The override clause in the brief still says `pass model: "sonnet"` for inner Task calls — outer is Opus, inner is Sonnet, creating a half-applied escalation.
- **Impact:** Implementation re-runs at Opus tier, but spec-reviewer / code-quality-reviewer subagents stay on Sonnet. May not unblock if the blocker was in review.
- **Existing mitigation:** Line 864 specifies override applies to ONE re-dispatch attempt; subsequent retries fall back to Sonnet.
- **Gap:** Inner-call override clause is static; it does not conditionally upgrade alongside the outer.
- **Recommended action:** Make the inner-call override clause parameterized: `pass model: "<orchestrator-elected-tier>"`. Orchestrator substitutes `sonnet` (default) or `opus` (under stronger-model re-dispatch).

### C.3 — I3.4 conversion subagents don't carry an inner-call override

- **Cite:** `commands/masterplan.md:1211`
- **Severity:** low
- **Condition:** Conversion subagent at I3.4 dispatched at `model: "sonnet"`. If conversion internally dispatches a sub-subagent (unlikely per current brief but not forbidden), no override propagates.
- **Impact:** Hypothetical only. Current conversion brief is single-shot.
- **Existing mitigation:** None needed if conversion stays single-shot.
- **Gap:** Not an active risk under v2.7.0 design.
- **Recommended action:** None until conversion grows internal dispatches.

---

## D. Codex integration failure modes

### D.1 — Availability detection is a fragile string scan

- **Cite:** `commands/masterplan.md:37`
- **Severity:** high
- **Condition:** `scan the system-reminder skills list for any entry prefixed codex:` — fragile to plugin renames (`openai/codex-plugin-cc` → some other namespace), to partial installs where the skills list shows `codex:` entries but the actual `codex:codex-rescue` invocation fails, and to the inverse (a similarly-prefixed third-party plugin matches the heuristic when codex is actually missing).
- **Impact:** False unavailable → silent fall-through to inline (degrade-loudly) or HALT (block). False available → first Step C 3a / 4b dispatch fails with `subagent_type not found`.
- **Existing mitigation:** Lines 37-55 specify the heuristic + the three policy variants. Doctor #18 catches persistent misconfigurations at lint time.
- **Gap:** No verifier. The presence of the prefix does not equal the dispatch path being functional.
- **Recommended action:** Define a Step 0 "ping" — dispatch a no-op `codex:codex-rescue` call with a 5-token bounded brief; on success, record availability. Cache per-session. Slightly more cost, much higher confidence.

### D.2 — Eligibility cache has no schema_version

- **Cite:** `commands/masterplan.md:688-702`
- **Severity:** high
- **Condition:** Cache file persists to disk, loaded across plugin upgrades. If the eligibility checklist (currently the 5 rules at `internals.md:323-329`) changes — e.g., a new rule added in v2.8.0 — old caches with old decisions are loaded silently and trusted.
- **Impact:** Routing decisions drift from the new rule set without any signal.
- **Existing mitigation:** Doctor #14 catches orphan caches (cache exists, no plan). Mtime invariant catches plan edits but not plugin upgrades.
- **Gap:** No `schema_version` field in the cache JSON.
- **Recommended action:** Add `cache_schema_version: "1.0"` to the cache JSON shape; bump on rule-set changes; on load, mismatch → rebuild path.

### D.3 — Cache parse-error path is undocumented

- **Cite:** `commands/masterplan.md:892-904`
- **Severity:** high
- **Condition:** Cache file exists on disk but is corrupt (truncated mid-write, hand-edited to invalid JSON, encoding issue). Step C step 1's load attempt produces a parse error.
- **Impact:** Orchestrator behavior at parse-error is not specified at line 892. The precondition halt fires only if `eligibility_cache` is `not loaded` in memory; "loaded as undefined due to parse error" is an unhandled state.
- **Existing mitigation:** None. Line 892's `ELSE → HALT` covers `not loaded`.
- **Gap:** Parse-error → load-as-empty-dict is a plausible code path that bypasses HALT.
- **Recommended action:** Treat parse error as `not loaded`; trigger HALT path. Add "or unparseable" to line 892's condition.

### D.4 — Mid-plan availability change is not re-detected

- **Cite:** `commands/masterplan.md:1018`
- **Severity:** high
- **Condition:** Step 0 detects codex available. Mid-plan, the user reinstalls plugins / restarts the session via `/loop`, and codex is no longer in the skills list. Step 4b's gate at line 1018 (`The codex plugin is available`) consults the stale Step 0 result.
- **Impact:** Codex review dispatch fails out-of-process; orchestrator silently skips with no `## Notes` evidence.
- **Existing mitigation:** Line 1015's `otherwise skip silently` says no-op on gate failure, but the silent-skip is the issue.
- **Gap:** No re-check, no degradation marker if the dispatch fails.
- **Recommended action:** Add a lightweight re-check at Step 4b precondition; on miss, write the same degradation marker as Step 0's degrade-loudly path.

### D.5 — `decision_source` not re-stamped after blocker-gate override

- **Cite:** `commands/masterplan.md:850-862,710`
- **Severity:** medium
- **Condition:** Manual routing puts `decision_source: "user-override-manual"` in the cache. Task blocks. User picks "Skip this task and continue" at the blocker gate. Cache is not updated; decision_source still records the *intent*, not the outcome.
- **Impact:** Future `/masterplan stats` and audits misattribute the routing.
- **Existing mitigation:** Line 710's enum is documentation-only; no rule covers post-blocker re-stamp.
- **Gap:** Cache records routing intent, not final outcome.
- **Recommended action:** Add a new enum value `user-override-skipped-after-block`; stamp on the "Skip" branch.

### D.6 — Degradation marker write timing

- **Cite:** `commands/masterplan.md:48,51`
- **Severity:** medium
- **Condition:** Step 0 sets `codex_review = off`. Mandates the marker is written `at the close of Step B3 for kickoff flows, at Step C step 1's first status-file write for resume flows ... or at Step I3 for import flows; whichever lands first`. If none of those paths fires this turn (e.g., orchestrator HALTs in Step A), the marker is never written.
- **Impact:** User cannot see the degradation in their status file until next turn.
- **Existing mitigation:** Line 51's `Force one anyway: write a ## Notes-only update` clause.
- **Gap:** That clause says `No status-file write happens this turn?` — but Step A's halt may not even reach the check.
- **Recommended action:** Write the marker as part of Step 0's degrade-loudly path itself, not deferred to a subsequent step.

---

## E. Wave-dispatch race conditions

### E.1 — Wave-completion barrier has no timeout

- **Cite:** `commands/masterplan.md:836`
- **Severity:** high
- **Condition:** A wave member hangs (Sonnet stuck on a long-running test, Bash command not returning). Barrier at line 836 blocks indefinitely.
- **Impact:** Faster members' digests sit in orchestrator memory; status file is not updated; user must manually kill the session to recover. CD-7 violation.
- **Existing mitigation:** None documented.
- **Gap:** No timeout, no partial-completion path.
- **Recommended action:** Add `config.parallelism.member_timeout_sec` (default 600). On timeout, the timed-out member is reclassified as `blocked` (reason: `wave-member-timeout`); other members complete normally; Step 4d applies surviving completions; blocker re-engagement gate fires for the timed-out member.

### E.2 — Sequential per-member protocol-violation check misattributes commits

- **Cite:** `commands/masterplan.md:872`
- **Severity:** medium
- **Condition:** Post-barrier, orchestrator runs `git status --porcelain` and `git log <task_start_sha>..HEAD` per wave member sequentially. If two wave members both committed (despite "DO NOT commit"), member 1's `git log` includes member 2's commits and vice versa.
- **Impact:** Both attributed as protocol-violators when only one may have introduced the second commit; misleading audit trail.
- **Existing mitigation:** None — the per-member sequential pattern is the documented method.
- **Gap:** Sequential checks don't distinguish concurrent commits.
- **Recommended action:** Take a single pre-barrier `git rev-parse HEAD` snapshot, then post-barrier compute a single `git log <pre>..<post>` and partition the commits by author / commit message / time-window per wave member.

### E.3 — User edits `plan.md` mid-wave

- **Cite:** `commands/masterplan.md:731,339` (FM-1 mitigation)
- **Severity:** high
- **Condition:** `cache_pinned_for_wave: true` snapshots the cache at wave-start so wave members can't invalidate it via in-wave plan edits. But the user (not a wave member) can still edit `plan.md` from outside — the pin only suppresses re-load; nothing prevents external edits.
- **Impact:** Wave dispatches based on stale routing; Step 4d writes activity-log entries that reference task names from the new plan but routing decisions from the old.
- **Existing mitigation:** FM-1's mitigation (`internals.md:339`) declares in-wave plan edits out-of-scope per CD-2 and pins the cache.
- **Gap:** CD-2 is convention; no programmatic check rejects user-initiated edits.
- **Recommended action:** At wave-start, capture `plan.md` mtime and content hash. At Step 4d post-barrier, re-read; if changed, surface `AskUserQuestion` (Continue with old routing / Re-dispatch wave with new routing / Abort). Don't silently apply 4d on top of a changed plan.

### E.4 — Mid-wave crash idempotency only holds for read-only members

- **Cite:** `commands/masterplan.md:884,internals.md:382`
- **Severity:** medium
- **Condition:** Slice α restricts wave members to read-only / gitignored-write tasks. Idempotency on re-dispatch follows. But a wave member with `**non-committing: true**` override that writes scratch files outside gitignored paths leaves residue.
- **Impact:** Re-dispatched wave finds unexpected files; Step 4c's integrity check fires; user must manually clean up.
- **Existing mitigation:** Line 884 says `Idempotent by Slice α design`. Implicit dependence on the read-only invariant.
- **Gap:** The `**non-committing:**` override (`internals.md:327`) widens what counts as "non-committing" beyond strict read-only, weakening the invariant.
- **Recommended action:** On Step C step 1 cache build, when `**non-committing:**` override is set, also set a `cleanup_paths: [...]` field declaring scratch paths the orchestrator can rm on mid-wave restart.

### E.5 — 4c filter ambiguity for read-only members

- **Cite:** `commands/masterplan.md:1083-1085`
- **Severity:** medium
- **Condition:** Step 4c computes the union of all wave members' `**Files:**` declarations and filters porcelain against it. For a read-only member (linter, type-checker), the declared files are the LINT TARGETS, not paths it will modify. Union includes linters' targets — porcelain may show unrelated files modified by serial sibling tasks as "expected" because they happen to be in a linter's target list.
- **Impact:** False negatives on out-of-scope writes when a linter's target overlaps with a sibling's actual write.
- **Existing mitigation:** FM-5 mitigation (`internals.md:365`) — Files-block scope filter + implicit-paths whitelist.
- **Gap:** The filter does not distinguish "expected to be modified" from "expected to be read."
- **Recommended action:** Require parallel-grouped tasks to declare `**Files:**` with read/write distinction (e.g., `Lint: <path>` vs `Modify: <path>`); 4c's expected-modified set uses only the write subset.

---

## F. Status / plan / cache mtime races

### F.1 — `touch` mtime invariant breaks at sub-second resolution

- **Cite:** `commands/masterplan.md:657,662`
- **Severity:** medium
- **Condition:** Step C step 1's load decision depends on `cache.mtime > plan.mtime` (strict greater). Step 4d touches the plan after edits to ensure invariant for next entry. On filesystems with 1-second mtime granularity (FAT32, some NFS) and a fast Step C step 2, both files end up with the same second.
- **Impact:** `>` comparison is false; cache rebuild fires unnecessarily on every Step C entry.
- **Existing mitigation:** None — invariant is the documented mechanism.
- **Gap:** Filesystem precision varies.
- **Recommended action:** Use `cache.mtime >= plan.mtime` (allow equal) AND track an in-memory `cache_built_for_plan_hash`; rebuild only when plan content hash differs.

### F.2 — In-memory cache vs disk drift between Step 1 and Step 2

- **Cite:** `commands/masterplan.md:640,731`
- **Severity:** high
- **Condition:** Eligibility cache loaded into memory at Step C step 1. Wave assembly at Step C step 2 (line 821) reads from memory. User (or another process) edits `<slug>-eligibility-cache.json` on disk between load and use.
- **Impact:** In-memory cache is stale; wave dispatches against unintended routing.
- **Existing mitigation:** Wave-pin (`cache_pinned_for_wave: true`) suppresses re-load; assumes in-memory is correct at load time.
- **Gap:** No re-validation that in-memory matches disk.
- **Recommended action:** At Step C step 2 entry, compute disk content hash; compare to load-time hash; on mismatch, re-load with `AskUserQuestion` confirmation.

### F.3 — Mtime-gated file_cache reads stale spec/plan

- **Cite:** `commands/masterplan.md:640`
- **Severity:** high
- **Condition:** `file_cache: {path → (mtime, content)}` skips re-reading files with unchanged mtime. User edits spec/plan in their editor; editor's atomic-write replaces the file with a new inode + new mtime; orchestrator's cached mtime no longer matches → re-read fires correctly. **But** if the editor uses in-place writes (some configurations of vim's `:set nowritebackup`), and the write completes within the same second the orchestrator last cached, mtime is unchanged.
- **Impact:** Orchestrator processes stale spec/plan content; downstream subagent dispatches reference outdated requirements.
- **Existing mitigation:** Line 640 excludes the status file (`always re-read live`) but includes spec/plan in mtime gating.
- **Gap:** Mtime polling is not a reliable change-detection mechanism on in-place editor writes at sub-second granularity.
- **Recommended action:** Add file size + first-line + last-line hash to the cache key; mismatch → re-read. Or: never mtime-gate spec/plan, treat them like the status file.

### F.4 — Status file rotation has no concurrent-write guard

- **Cite:** `commands/masterplan.md:1098-1106`
- **Severity:** high
- **Condition:** Step 4d's atomic write (`temp + fsync + rename`) assumes no other process writes. User edits `## Notes` in their editor; editor saves; rename races.
- **Impact:** Either the editor's save wins (Step 4d's update is lost) or the orchestrator's atomic-rename wins (user's edit is lost). Both paths are silent data loss.
- **Existing mitigation:** None documented.
- **Gap:** No file lock.
- **Recommended action:** Wrap rotation+append in `flock` over the status file. On contention, write to a `<plan>-status.queue.jsonl` and apply on next Step 4d.

### F.5 — External plan edits not detected between sessions

- **Cite:** `commands/masterplan.md:662`
- **Severity:** low
- **Condition:** Step 4d touches `plan.md` only when the orchestrator itself made plan edits. External edits between Step C step 1 and Step C step 2 (or between sessions) update plan mtime; cache stays older; rebuild fires next entry — desired behavior.
- **Impact:** Acceptable cost for correctness.
- **Existing mitigation:** Mtime invariant catches it.
- **Gap:** None.
- **Recommended action:** None.

---

## G. Trust-contract / verification skips

### G.1 — Trust contract is unaudited

- **Cite:** `commands/masterplan.md:996-1003`
- **Severity:** high
- **Condition:** Implementer returns `tests_passed: true` and `commands_run: ["npm test", "npm run lint"]`. Orchestrator skips re-running those. There is no verifier that the implementer actually executed them.
- **Impact:** False completions propagate; downstream task failures attributed to the wrong cause; debugging cost amplifies.
- **Existing mitigation:** Line 1001's protocol-violation rule fires only when re-run happens and tests fail. Trust-skip path bypasses re-run entirely.
- **Gap:** No structural verification of the digest.
- **Recommended action:** Require implementer's return digest to also include verification output excerpts (1-3 lines per command per CD-8); orchestrator validates excerpts contain a recognizable PASS / OK / 0-error signal before honoring the skip.

### G.2 — Incomplete `commands_run` triggers misleading "complementary" log

- **Cite:** `commands/masterplan.md:1000`
- **Severity:** high
- **Condition:** Implementer returns `commands_run: ["npm test"]` but the plan task lists `["npm test", "npm run lint", "npm run typecheck"]`. Orchestrator runs the complementary commands (lint + typecheck); if typecheck fails, activity log records `(verify: trusted implementer for tests + ran <complement>)` with the failure.
- **Impact:** Future audit reads the entry as "implementer ran tests cleanly, but typecheck found something." If `commands_run` was fabricated, the implementer didn't actually run tests either, and the activity log is misleading.
- **Existing mitigation:** Same as G.1 — none.
- **Gap:** Same.
- **Recommended action:** Same as G.1 — require excerpt evidence.

### G.3 — `tests_passed: false` + truthful `commands_run` flagged as protocol violation

- **Cite:** `commands/masterplan.md:1001`
- **Severity:** medium
- **Condition:** Implementer honestly returns `tests_passed: false` with `commands_run` showing tests were attempted. Orchestrator's full re-run also fails. Line 1001 says `If the implementer claimed done but tests fail on re-run, treat as a protocol violation`. The wording conflates two cases.
- **Impact:** A correct, honest implementer report is mis-flagged as a protocol breach.
- **Existing mitigation:** Wording at line 1001 covers BOTH (a) `tests_passed: true → fail` and (b) `tests_passed: false → fail`. (b) is the false-positive.
- **Gap:** "Claimed done" is ambiguous when the implementer claimed NOT done.
- **Recommended action:** Tighten line 1001 to say: `If tests_passed == true AND tests fail on re-run, treat as protocol violation. If tests_passed == false AND tests fail on re-run, proceed with normal blocker handling per autonomy policy.`

### G.4 — Codex review medium-severity findings auto-accept silently

- **Cite:** `commands/masterplan.md:1072,1081`
- **Severity:** medium
- **Condition:** Default `config.codex.review_prompt_at: "medium"`. Codex returns medium findings. Orchestrator auto-accepts (no `AskUserQuestion`); findings logged to `## Notes`.
- **Impact:** User doesn't read `## Notes` for every task → important findings missed → code merges with unaddressed issues.
- **Existing mitigation:** Line 1072 specifies `auto-accept silently when severity is clean or strictly below review_prompt_at`. User can set `low` to surface all.
- **Gap:** Default trades silence for fewer interrupts; the `## Notes` write is the only signal.
- **Recommended action:** Add a Step 4d activity-log entry summarizing per-task review severity (`[reviewed: medium-3]`) so the routing tag carries the count visibly. Already partly done per line 1036.

### G.5 — Missing `task_start_sha` is documented but pre-validation absent

- **Cite:** `commands/masterplan.md:1025`
- **Severity:** high
- **Condition:** Implementer omits `task_start_sha`. Step 4b detects on use. But Step 4a may have already executed, having seen and trusted other return fields.
- **Impact:** Late blocker surfacing; partial state.
- **Existing mitigation:** Line 1025's blocker gate.
- **Gap:** No pre-Step-4 validation.
- **Recommended action:** See B.1 — add a single post-return shape validator before 4a fires.

### G.6 — Codex review false-positive on high-severity

- **Cite:** `commands/masterplan.md:1072-1080`
- **Severity:** medium
- **Condition:** Codex grounds a finding in `file:line` but misinterprets the surrounding context (e.g., flags an SQL string concatenation that's actually a parameterized prepared statement higher in the file).
- **Impact:** Under `loose` autonomy, status flips to `blocked` on a false finding; user must triage. Friction.
- **Existing mitigation:** "Be adversarial about correctness, not style" guidance to Codex; severity-ordered output.
- **Gap:** Grounding in line numbers does not guarantee semantic correctness.
- **Recommended action:** None high-confidence; this is a class of LLM-review failure not specific to /masterplan. Document as a known limitation.

---

## H. Tool / sandbox / environment dependencies

### H.1 — `git` unavailable or not in a repo

- **Cite:** `commands/masterplan.md:59,64-66`
- **Severity:** high
- **Condition:** `/masterplan` invoked outside a git repo, or `git` binary missing, or git version too old to support `worktree list --porcelain`.
- **Impact:** `git_state.worktrees` cache empty; Steps A/B0/D/4c silently malfunction or crash.
- **Existing mitigation:** None documented.
- **Gap:** No early bail.
- **Recommended action:** Step 0 first action: `git rev-parse --is-inside-work-tree` + `git --version` minimum check. On fail, surface a clear error and exit.

### H.2 — Atomic-rename fails on NFS / restricted FS

- **Cite:** `commands/masterplan.md:718` (cache write timing)
- **Severity:** high
- **Condition:** Cache write is `temp + fsync + rename`. On NFS without proper fsync semantics, or in sandboxes denying temp-file creation in the target dir, the operation partially completes.
- **Impact:** Corrupted cache; D.3's parse-error gap reaches it.
- **Existing mitigation:** None for atomic-write failure handling.
- **Gap:** Silent failure path.
- **Recommended action:** Wrap the write in error-checking; on failure, delete the temp, log a `## Notes` entry, and proceed without persisting (eligibility cache becomes per-session in-memory only for this run).

### H.3 — `git status --porcelain` hangs or errors

- **Cite:** `commands/masterplan.md:1083`
- **Severity:** high
- **Condition:** Worktree contains a subdirectory with restrictive permissions, broken symlink, or stale lock; `git status` hangs or errors.
- **Impact:** Step 4c blocks indefinitely.
- **Existing mitigation:** None documented.
- **Gap:** No timeout.
- **Recommended action:** Wrap `git status` in a 30s timeout; on timeout, surface a blocker question.

### H.4 — `gh` CLI missing or unauthenticated

- **Cite:** `commands/masterplan.md:1198,1361`
- **Severity:** high
- **Condition:** Step I3.2 uses `gh issue view` / `gh pr view` for GitHub sources. Step S uses `gh pr list` for situation reports. If `gh` is missing or auth has expired, fetches fail.
- **Impact:** Import flow blocks; situation report missing PR data silently.
- **Existing mitigation:** Line 1361 says `degrade gracefully if not` for Step S only.
- **Gap:** Step I3.2 fetch agent has no documented degrade.
- **Recommended action:** Step 0 emits a one-line warning when `gh` is missing AND any verb that depends on it is invoked; Step I3 fallback path that disables GitHub source classes.

### H.5 — Haiku/Sonnet model unavailable at API tier

- **Cite:** `commands/masterplan.md:219`
- **Severity:** high
- **Condition:** User's account has model restrictions; Haiku is not in their allowlist; or transient API outage on a specific tier.
- **Impact:** Every Haiku-dispatched site (12 of 18 dispatch sites) fails.
- **Existing mitigation:** None documented.
- **Gap:** No fallback model selection.
- **Recommended action:** On model-unavailable error, fall back one tier up (Haiku → Sonnet) with a `## Notes` entry; cost regresses but plan progresses.

### H.6 — Filesystem mtime unreliable

- **Cite:** `commands/masterplan.md:640`
- **Severity:** high
- **Condition:** Cloud storage (rclone-fuse, certain NFS configurations) reports stale or zero mtime.
- **Impact:** `file_cache` and `cache.mtime > plan.mtime` invariants both fail silently. Orchestrator never sees user edits.
- **Existing mitigation:** None.
- **Gap:** No fallback to content hashing.
- **Recommended action:** Use file size + content hash as primary cache key; mtime is a hint, not the source of truth.

### H.7 — Hook portability: BSD vs GNU `date`

- **Cite:** `hooks/masterplan-telemetry.sh:155-157`
- **Severity:** medium
- **Condition:** Hook tries `date -d ... -u` (GNU) and falls back to `date -v ... -u` (BSD). On stripped containers (musl libc, busybox) both fail.
- **Impact:** `wakeup_count_24h` becomes 0 (sentinel `9999-12-31` cutoff). Telemetry silently misrepresents loop activity.
- **Existing mitigation:** Sentinel cutoff at line 152-157.
- **Gap:** No warning emitted.
- **Recommended action:** Emit a one-line stderr warning when sentinel is taken; user can see why telemetry shows zeros.

### H.8 — Shell environment assumptions in verification commands

- **Cite:** `commands/masterplan.md:1005-1011`
- **Severity:** medium
- **Condition:** Plan task verification commands depend on user-shell-config env vars (`$NODE_ENV`, `$PYTHONPATH`, project venv activation). Orchestrator runs them in its own shell that doesn't source the user's `.bashrc`.
- **Impact:** False failures; user re-runs commands manually and they pass.
- **Existing mitigation:** Implementer subagent typically inherits the orchestrator's environment; CD-1 says "follow the project's established command path."
- **Gap:** The "established path" may itself depend on env that isn't set.
- **Recommended action:** Document a `make` / `npm script` / `Justfile` recipe convention; encourage users to wrap multi-step verification in a single project-local target.

### H.9 — Status file directory not writable

- **Cite:** `commands/masterplan.md:1098`
- **Severity:** high
- **Condition:** Sandbox or restrictive perms on `docs/superpowers/plans/`; Step 4d's atomic write fails.
- **Impact:** Plan progress not persisted; next resume re-runs already-done tasks.
- **Existing mitigation:** None.
- **Gap:** No early permissions check.
- **Recommended action:** Step 0 checks write permission to the plans dir; on fail, surface a clear error.

---

## Appendix 1: Subagent dispatch-site inventory (18 sites)

| # | Step | Line | Subagent type | Model | Parallelism | Brief contract | Return shape |
|---|---|---|---|---|---|---|---|
| 1 | Step A | 451 | `Agent` | haiku | parallel — fan-out per worktree (N≥2) | full | `[{path, frontmatter, parse_error?}]` |
| 2 | Step B0 | 470 | `Agent` | haiku | parallel — fan-out per worktree (N≥2) | full | per-worktree match record |
| 3 | Step C step 1 | 661 | `Agent` (fallback) | haiku | single | full | eligibility-cache JSON |
| 4 | Step C step 2 wave | 830 | `Agent` × N | sonnet | parallel — wave | full | `{task_idx, status, task_start_sha, ...}` |
| 5 | Step C step 2 serial | 840 | `superpowers:subagent-driven-development` | (recursive override → sonnet) | serial | full + recursive-override clause | implementer return digest |
| 6 | Step C step 2 (--no-subagents) | 840 | `superpowers:executing-plans` | (recursive override → sonnet) | serial | full + recursive-override clause | implementer return digest |
| 7 | Step C 3a | 976 | `codex:codex-rescue` (EXEC) | (out-of-process — exempt) | single | full | diff + verification |
| 8 | Step C 4b | 1052 | `codex:codex-rescue` (REVIEW) | (out-of-process — exempt) | single | full | severity-ordered findings |
| 9 | Step I1 | 1167 | `Explore` × 4 | haiku | parallel — wave (per source class) | full | candidate list JSON |
| 10 | Step I3.2 (branches) | 1198 | `Agent` | sonnet | parallel — wave (per candidate) | full | raw source content |
| 11 | Step I3.4 | 1211 | `Agent` × N | sonnet | parallel — wave (per candidate) | full | `{path, summary}` |
| 12 | Step I (completion inference) | 1685 | `Agent` × chunks | haiku | parallel — fan-out per chunk | full | `{task_idx → classification}` |
| 13 | Step S1 | 1245 | `Agent` | haiku | parallel — fan-out per worktree (N≥2) | full | per-worktree digest JSON |
| 14 | Step R2 | 1352 | `Agent` | haiku | single | full | retro-source digest |
| 15 | Step D | 1432 | `Agent` | haiku | parallel — fan-out per worktree (N≥2) | full | findings list `[{check_id, severity, ...}]` |
| 16 | Step CL1 | 1497 | `Agent` | haiku | parallel — fan-out per worktree (N≥2) | full | category detector results |
| — | Step T (stats) | 1297 | (script-only — `bin/masterplan-routing-stats.sh`) | n/a | n/a | n/a | tabular output |
| — | Step M | 365 | (no Agent dispatch — inline) | n/a | n/a | n/a | n/a |

Counts:
- Haiku: 12
- Sonnet (incl. SDD recursive): 4 (sites 4, 10, 11, plus the recursive-override clause delivered via sites 5 + 6)
- Codex (out-of-process): 2
- Total dispatching sites: 16 (plus 2 non-dispatch sites listed for completeness)

Note: site 4 (wave) emits N parallel `Agent` calls in one assistant turn; sites 5-6 are skill invocations whose inner Agent dispatches inherit the recursive model-passthrough discipline.

---

## Appendix 2: Telemetry-hook failure conditions (13 findings)

| # | Line | Severity | Category | Condition | Impact |
|---|---|---|---|---|---|
| H.1 | 26-30 | medium | permission/portability | `mkdir -p` + `touch` on `.git/info/exclude` may fail silently | Telemetry sidecars may not be gitignored; sandbox-permission failures invisible |
| H.2 | 139-143 | medium | context-fragility | Transcript fallback loop reads ALL session jsonls under `~/.claude/projects` (depth 3, no limit) | Multi-year project dirs slow; can exceed Stop-hook 3s budget |
| H.3 | 143 | medium | silent-failure | `cut -d' ' -f2-` on `stat` output assumes exactly one space | Pathological mtime/path combinations corrupt path resolution |
| H.4 | 155-157 | medium | portability | Both GNU `date -d` and BSD `date -v` fail (musl, busybox) → sentinel cutoff `9999-12-31` | `wakeup_count_24h` always 0; misleading loop telemetry |
| H.5 | 199 | medium | silent-failure | `jq -R . \| jq -sc .` on empty input errors silently | `wave_groups_json` malformed; per-turn record at line 217 broken |
| H.6 | 207-220 | high | interference | Per-turn JSONL `>> "$out_file" 2>/dev/null` discards jq errors | Telemetry record lost; orchestrator can't detect; stats and cost-distribution metrics drift |
| H.7 | 262-266 | medium | silent-failure | `seen_ids_json` jq parse error → `[]` fallback; redundant double-fallback | Existing JSONL corruption causes re-processing → duplicate rows |
| H.8 | 268-355 | high | interference | Subagent JSONL append `>> "$subagents_file" 2>/dev/null` on jq parse/write fail | Subagent records lost; `/masterplan stats` missing dispatch data; routing-class distribution drift |
| H.9 | 293 | high | misclassification | `toolUseResult.agentId` may be present but null in the record — dedup key collapses to null | Dedup set degenerates; same dispatch reprocessed repeatedly OR duplicate-key collisions silently overwrite earlier records |
| H.10 | 298-301 | medium | silent-failure | `tool_use_id` from `tool_result` may not match `$idx` dispatch table | Lookup returns `{}`; subagent_type degrades; routing_class becomes `general` (misclassification) |
| H.11 | 303 | medium | misclassification | `subagent_type` missing → empty string → routing_class `general` | Vendor-specific or future routing classes silently absorbed into the catch-all |
| H.12 | 336-344 | low | silent-failure | `.toolStats` missing → all-zeros default | Tool-stats record indistinguishable from "no tools used"; degraded accuracy only |
| H.13 | 358 | high | interference | Unconditional `exit 0` regardless of jq failures | Orchestrator never sees hook failures; assumes telemetry is intact |

The hook is intentionally `2>/dev/null` and `exit 0` throughout (per its "bail silently" design). The trade-off is invisibility of failures. Findings H.6, H.8, H.13 are the same root cause expressed at three append/exit sites: jq failure → silent data loss → no orchestrator-visible signal.

---

## Cross-references with `internals.md§7` (FM-1 to FM-6)

| This audit's finding | Existing FM | Relationship |
|---|---|---|
| E.3 (user edits plan.md mid-wave) | FM-1 | Same root cause; this audit highlights the user-initiated edit case (FM-1 mitigation only declares wave-member edits out-of-scope) |
| F.4 (status file rotation race) | FM-2 / FM-3 | Mitigations applied for wave-vs-orchestrator (single-writer funnel); this audit highlights the orchestrator-vs-user-editor race that FM-2/3 do not cover |
| D.5, D.6, A.1, A.2 | (no existing FM) | New: model-passthrough and decision_source completeness are not in the existing catalog |
| E.5 (4c filter ambiguity for read-only) | FM-5 | FM-5 mitigation handles wave + serial overlap; this audit highlights the read-vs-write-target distinction as a residual gap |
| C.1, C.2, C.3 | (no existing FM) | New: recursive dispatch was added in v2.0.0 with the override clause; no FM-N entry was created for its failure modes |
| H.1-H.9 | (no existing FM) | Tool/sandbox dependencies are an undocumented surface |

---

## Suggested follow-up (out of scope of this audit)

If the user wants to act on these, a `/masterplan plan` covering the high-severity items would naturally split into three slices:

- **Slice 1 — Model contract enforcement.** A.1, A.2, A.3 → telemetry-driven doctor check that flags Opus inheritance on SDD/wave/Step C step 1 sites. New doctor #22.
- **Slice 2 — Codex availability + caching robustness.** D.1, D.2, D.3, D.4 → ping-based availability check, schema_version field, parse-error path, mid-plan re-check.
- **Slice 3 — Concurrency hardening.** E.1, E.3, F.4 → wave timeout, plan-edit detection at wave-end, status-file flock.

G.1/G.2 (trust contract auditing) is design-level and warrants its own brainstorm; the right answer may involve changes upstream in SDD's `implementer-prompt.md`, not just orchestrator-side validation.

H.* (tool / environment) is a heterogeneous bag and benefits less from a single plan — pick the highest-impact items (H.1, H.5) and treat the rest opportunistically.
