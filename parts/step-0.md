# Step 0 — Bootstrap + Status + Validate

> **Loads on demand:** `parts/contracts/run-bundle.md` (state.yml v5 schema + resume controller), `parts/contracts/cd-rules.md` (CD-1..CD-10 verbatim; load on first CD-rule reference per turn), `parts/codex-host.md` (Codex host suppression — load only when `codex_host_suppressed == true`), `docs/config-schema.md` (full .masterplan.yaml schema — load on `validate` verb only).

<!-- CC-3-trampoline anchor: this phase file is the entry point for all verb routing and resume flows. Every turn-close in this orchestrator routes through the CC-3-TRAMPOLINE sequence defined in Operational rules. See the canonical sequence at the bottom of this file. -->

---

## Step 0 — Parse args + load config

### Invocation sentinel (always emit first)

Before doing anything else — before config load, before git_state cache, before verb routing — emit ONE plain-text line so the user can confirm `/masterplan` is alive. This is the FIRST output of every `/masterplan` turn.

**Step 1 — Resolve the version.** Use the **Read tool** to load `.claude-plugin/plugin.json` from the FIRST readable candidate path below, then parse the JSON and extract the `version` field. The Read tool call is mandatory — do not skip it, do not paraphrase its result, do not infer a version from session memory:

1. `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/.claude-plugin/plugin.json` — canonical installed location
2. `<cwd>/.claude-plugin/plugin.json` — dev checkout (works when CWD is the plugin source repo)
3. `~/.claude/plugins/cache/rasatpetabit-superpowers-masterplan/superpowers-masterplan/<latest-version>/.claude-plugin/plugin.json` — last resort; glob `~/.claude/plugins/cache/rasatpetabit-superpowers-masterplan/superpowers-masterplan/*/` and pick the highest semver

**Step 2 — Render the sentinel.** Emit exactly one line in this shape, prefixed with `v` plus the parsed semver (no angle brackets, no placeholder tokens):

```
→ /masterplan v3.3.0 args: 'doctor --fix' cwd: /home/grojas/dev/optoe-ng
```

The shape is `→ /masterplan v<parsed-semver> args: '<truncated-args-or-(empty)>' cwd: <repo-root-or-pwd>`. Substitute the actual parsed semver (e.g. `v3.3.0`, `v3.2.9`), the actual `$ARGUMENTS` string (or the literal text `(empty)` when no arguments), and the actual cwd.

**Fallback (ONLY when ALL three Read attempts fail).** Render the exact six-character literal string `vUNKNOWN`. No other fallback value is permitted.

**Strict prohibitions on the version slot.** The version slot in the rendered sentinel must be either a parsed semver from `plugin.json` or the literal `vUNKNOWN`. You MUST NOT emit:
- `v?`, `v??`, `v???`, `vTBD`, `vXXX`, `v-`, `v<unknown>`, or any other abbreviated/handwaved fallback.
- The angle-bracket template token `v<version-from-plugin.json>` itself — that token is a shape-description in this prompt, not output. If you find yourself about to emit angle brackets in the sentinel, stop: you skipped the Read tool call.
- A semver from an older message, the conversation history, or a previous turn. Always Read fresh on every `/masterplan` invocation.

Truncate `args` at 120 chars with `…`; total sentinel length ≤ 200 chars. The sentinel is plain stdout, NOT inside an `AskUserQuestion`, NOT inside a tool call — it must appear in the user-visible turn output.

**Why:** when `/masterplan` is invoked after `/reload-plugins` and the harness has not re-registered the slash command, the orchestrator's turn produces zero output (observed: optoe-ng 2026-05-07 23:19, sequence `/compact` → `/plugin` → `/reload-plugins` → `/masterplan` → empty turn). The sentinel makes "did `/masterplan` run?" trivially observable. If the user sees no `→ /masterplan` line, they know the harness ate the invocation — re-register via `/plugin` (uninstall + reinstall) and re-invoke. CC-3-TRAMPOLINE does not apply to the sentinel; it's an unconditional first-line render.

### Breadcrumb emission contract (always-on; failure-instrumentation framework)

Every step part (Step 0, A, B0/B1/B2/B3, C, I1..I4, D, R, S, M, N, CL, T) MUST emit structured `<masterplan-trace …>` markers at well-defined control points. These markers feed the failure-detection hook (`hooks/masterplan-telemetry.sh` Section 9) and the over-time analyzer (`bin/masterplan-failure-analyze.sh`). The full taxonomy + signature semantics + auto-filing logic live in `parts/failure-classes.md`.

**Required emission points and shapes:**

| Marker | When |
|---|---|
| `<masterplan-trace step=<id> phase=in verb=<verb> halt_mode=<halt> autonomy=<aut>>` | First line of any step part entry — emit BEFORE any other tool call or prose for that step |
| `<masterplan-trace step=<id> phase=out next=<next-step-or-CLOSE-TURN> reason=<one-word-reason>>` | Last line before dispatching to next step OR before `→ CLOSE-TURN` |
| `<masterplan-trace skill-invoke name=<skill> args=<short-arg-summary>>` | Just before invoking `Skill` for `writing-plans` / `brainstorming` / `subagent-driven-development` / `executing-plans` |
| `<masterplan-trace skill-return name=<skill> expected-next-step=<id>>` | First line after the skill returns (the orchestrator's resume point) |
| `<masterplan-trace gate=fire id=<gate-id> auq-options=<count>>` | Just before any AskUserQuestion that constitutes a planning/execution gate (B1 close-out, B2 re-engagement, B3 close-out, completion gate, blocker re-engagement) |
| `<masterplan-trace state-write field=<field> from=<old> to=<new>>` | Immediately before any state.yml mutation that changes `phase`, `current_task`, `pending_gate`, or `status` |

**Conventions:**

- `<id>` values: `step-0`, `step-a`, `step-b0`, `step-b1`, `step-b2`, `step-b3`, `step-c`, `step-i1`..`step-i4`, `step-d`, `step-r`, `step-s`, `step-m`, `step-n`, `step-cl`, `step-t`.
- `<verb>` values: `plan`, `next`, `resume`, `status`, `import`, `doctor`, `retro`, `clean`, `validate`, `stats`, `full`, `brainstorm`, `execute`, or `unknown`.
- `<halt>` values: `none`, `post-brainstorm`, `post-plan`.
- `<aut>` values: `gated`, `loose`, `full`.
- `<reason>` values: `success`, `gate`, `error`, `halt`, `compaction`, `degraded`, `routed`, `cd-violation`.
- Markers are **plain stdout** — NOT inside tool calls, NOT inside code fences for display, NOT inside AskUserQuestion previews. They appear in the user-visible turn output, one per line.
- Markers are **additive**: they never change orchestrator behavior, only make it observable.

**Why:** the framework auto-files GitHub issues against `rasatpetabit/superpowers-masterplan` whenever the Stop hook detects an anomaly (silent stop after skill return, unexpected halt, dropped state mutation, orphan pending gate, step-trace gap, uncited verification failure). Issues are deduped by stable SHA1 signatures derived from these markers' content. Without the markers, the detector cannot reconstruct what the orchestrator was doing when a turn ended — failures become invisible.

Step parts below contain the specific Emit lines at each required point. Where this prompt says **Emit:** followed by a `<masterplan-trace …>` shape, that's an instruction to render the substituted marker verbatim in the turn output.

**Step 0 entry breadcrumb.** Emit immediately after the invocation sentinel (and the compaction notice, if rendered):

```
<masterplan-trace step=step-0 phase=in verb={resolved-verb} halt_mode={halt_mode} autonomy={autonomy}>
```

If `resolved-verb` is not yet known (i.e., before verb routing), use `unknown` as a placeholder. `halt_mode` and `autonomy` come from config + flag merge (already complete by this point).

### Config loading (always runs first)

1. Read `~/.masterplan.yaml` if it exists.
2. `git rev-parse --show-toplevel` — if inside a repo, read `<repo-root>/.masterplan.yaml` if it exists.
3. Shallow-merge in precedence order: **built-in defaults < user-global < repo-local < CLI flags**. The merged config is available to every downstream step (referenced as `config.X` in this prompt).
4. Invalid YAML → abort with the file path and parser message. Missing files → skip that tier silently.
5. **Flag-conflict warnings.** After merge, surface a one-line warning (do not abort) when:
   - `codex_routing == off` AND `codex_review == on` — review will not fire; the flag is ignored for this run.
   - `auto_compact.enabled == true` AND `auto_compact.interval` is empty/null/missing — the substituted command would degrade to dynamic-mode `/loop` (no interval) which routes through `ScheduleWakeup` and cannot fire built-in `/compact`. Set in-memory `auto_compact_nudge_suppressed: true` (read by the Step B3 / Step C step 1 nudge logic to skip rendering this run) and emit: *"⚠️ auto_compact.enabled is true but auto_compact.interval is empty — auto-compact nudge skipped. Set a non-empty interval (e.g. `\"30m\"`) to re-enable."*
   - `--no-loop` is set AND `loop_enabled: true` is in config — the CLI flag wins; scheduling is disabled for this run.

See `docs/config-schema.md` for the full schema and built-in defaults (loaded on demand; always load on the `validate` verb).

### Codex host detection (v3.1.0+)

> **Detailed suppression rules:** load `parts/codex-host.md` when `codex_host_suppressed == true`. That file contains the full 11-point suppression spec (Codex routing off, events.jsonl marker, performance guard, native goal pursuit, shell-trap recovery, summary-first loading, sensitive live-auth stop). The detection logic below is the only part that always runs.

Before running any Codex availability detection, determine whether this orchestrator is already running inside Codex. Treat the active system/developer prompt and tool contracts as the host signal: if the session identifies the agent as Codex, exposes Codex-native tools such as `apply_patch` / `update_plan` / `request_user_input`, or uses an `AGENTS.md` compatibility map rather than Claude Code's native tool names, set in-memory `codex_host_suppressed = true`.

When `codex_host_suppressed == true`: load `parts/codex-host.md` immediately and follow the full suppression spec there. Then continue to the Codex availability detection section below (which will be short-circuited by `codex_host_suppressed`).

### Codex availability detection (v2.0.0+)

After config loading completes, if `codex_host_suppressed != true` and the merged config has `codex.routing != off` OR `codex.review == on` (the v2.0.0 defaults are `routing: auto` + `review: on` — both trigger this check), verify the codex plugin is available. Detection mode is governed by `config.codex.detection_mode` (default `scan-then-ping`; v5.3.0+ — see `docs/config-schema.md`):

- **`scan-then-ping` (default, v5.3.0+)** — two-tier deterministic-first detection. **Stage A (scan):** if the literal substring `codex:` appears anywhere in the system-reminder skills list received this turn, set `codex_ping_result = "ok"` with `detection_source = "scan"` and short-circuit. No further judgment applies; no ping dispatched. This rule has zero judgment surface — it is a literal substring test against context the orchestrator already has, modeled on the `codex_host_suppressed` precedent above (line 94). The `codex:` prefix is structural (enforced by Anthropic plugin namespacing), so this signal is robust as long as that namespace convention holds. **Stage B (ping fallback):** only when Stage A returns zero matches, dispatch a 5-token bounded ping to `codex:codex-rescue` with brief `Goal=health-check`, `Inputs=none`, `Scope=read-only`, `Constraints=return only "ok"`, `Return shape={status:"ok"}`. On dispatch error (subagent_type not found, plugin uninstalled, API error) → codex unavailable; preserve the error string for the activity-log marker. On successful return → codex available with `detection_source = "ping"`. Cache result on per-invocation state as `codex_ping_result`. Ping cost (only when Stage A misses): ~5 tokens; runs at most once per `/masterplan` invocation. This mode is the default because the legacy `ping`-only mode is non-deterministic — the orchestrator (an LLM) was asked to dispatch and judge, and observed false-positives where Codex was demonstrably installed but the orchestrator emitted "not detected" without proof of dispatch.
- **`ping` (legacy default pre-v5.3.0)** — dispatch the 5-token ping unconditionally; never scan. Retained for users who explicitly opt in (e.g., to test plugin-present-but-broken corner cases). The same false-positive failure mode that motivated v5.3.0 applies under this mode; pair with Doctor Check #41 ERROR escalation to catch confabulation post-hoc.
- **`scan`** — scan-only: literal substring `codex:` test against the system-reminder skills list. Never dispatches a ping. Faster than `scan-then-ping` (skips the rare Stage B fallback), but cannot distinguish "plugin truly absent" from "skills list temporarily empty" if Claude Code ever changes the skills-reminder format. The structural namespace prefix makes that risk small; the `scan-then-ping` default exists precisely to cover the corner case.
- **`trust`** — assume codex is available; skip detection entirely. For users on locked-down accounts where the ping itself fails for unrelated infrastructure reasons (sandbox-blocked subagent dispatch, etc.) and any per-task failure is acceptable as the loudly-degraded signal.

**Mid-session `/reload-plugins` is uncovered.** `codex_ping_result` is per-invocation; if the user installs/uninstalls Codex mid-session, Step 0's cache will be stale until the next `/masterplan` invocation. Acceptable trade-off — re-running `/masterplan` rebuilds the cache.

**Always log the detection outcome to `events.jsonl` (v5.1.1+, I-5 of cosmic-cuddling-dusk).** Regardless of result, record one event so the per-run codex-availability decision is auditable. The success-path event piggybacks on the next natural state write of the run (no force-flush — failure-path events still force-flush per the degrade-loudly contract below). Event formats:

- On `scan-then-ping` Stage A hit (`detection_source == "scan"`) or `scan` mode finding a `codex:` entry: `<ISO-ts> codex_ping ok — detection_mode=<scan-then-ping|scan>, detection_source=scan`.
- On `scan-then-ping` Stage B hit (`detection_source == "ping"`) or `ping` mode success (`codex_ping_result == "ok"`): `<ISO-ts> codex_ping ok — detection_mode=<scan-then-ping|ping>, detection_source=ping`.
- On `trust` mode (detection skipped intentionally): `<ISO-ts> codex_ping skipped — detection_mode=trust`.
- On `codex_host_suppressed == true` (Codex is hosting this orchestrator; no detection runs): `<ISO-ts> codex_ping skipped — codex_host_suppressed`.
- On failure: the existing `codex degraded — …` event in the degradation path below already covers this case (no duplicate event).

Doctor check #41 reads these events to distinguish "ping never ran" from "ping returned ok but no Codex dispatches happened" from "ping returned error" — the symptomatic case where `codex_routing: auto` was persisted but no `routing→.*\[codex\]` events ever follow.

If detection concludes codex is **absent**, behavior depends on `config.codex.unavailable_policy` (default `degrade-loudly`; v2.4.0+):

**`unavailable_policy: block`** — orchestrator does NOT degrade silently OR loudly. Instead: emit the same visible stdout warning (step 1 below), then HALT. Do not enter Step B/C/I — there's no plan execution to skip-codex through. For this halt, set: in-memory `halt_reason = "codex unavailable; unavailable_policy=block"`. If invoked via /loop, reschedule the next wakeup so resume can retry with codex installed; otherwise → CLOSE-TURN. The halting message includes: `⚠ HALT — codex plugin not detected and config.codex.unavailable_policy=block. Install codex (per the warning above) OR set codex.unavailable_policy: degrade-loudly in .masterplan.yaml to allow inline fallthrough.`. NO further steps from below run.

**`unavailable_policy: degrade-loudly`** (default) — execute the full degradation path below:

0. **Self-doubt cross-check (v5.3.0+, deterministic).** Before emitting the visible stdout warning, run two on-disk probes:
   - **Auth-healthy probe:** reuse Doctor Check #39's predicate against `~/.codex/auth.json` — file exists, JWT not expired more than 24h, AND (under `auth_mode == "chatgpt"`) `tokens.refresh_token` non-empty + `last_refresh` within 7 days.
   - **Plugin-on-disk probe:** `ls ~/.claude/plugins/*/codex* 2>/dev/null | head -1` — non-empty match means the codex plugin's files are present on disk regardless of what runtime detection concluded.

   If **both probes pass** but Step 0 is about to emit "plugin not detected", append one INFO event to `events.jsonl` on the same forced state write below:

   ```
   <ISO-ts> degradation_self_doubt — about to emit codex-degraded warning, but auth_mode=<chatgpt|apikey> healthy AND plugin manifest present on disk; detection_mode=<scan-then-ping|ping|scan>, detection_source=<scan|ping|none>, ping_result=<ok|error-msg|null>
   ```

   The warning still fires (Step 0 cannot ground-truth that codex's runtime path actually works), but the breadcrumb makes the false-positive *visible to Doctor Check #41*, which escalates to ERROR when this event is present.

1. **Emit visible stdout warning** (do not abort) — must be a top-level user-facing line, not buried inside a tool call:

   > ⚠ Codex plugin not detected — `codex_routing` and `codex_review` are degraded to `off` for this run. Install via `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex`, then `/reload-plugins`, to restore configured Codex routing + cross-model review. Persisted config is unchanged.

2. In-memory only: treat `codex_routing` as `off` and `codex_review` as `off` for the run. The persisted defaults (in `.masterplan.yaml`) and run fields (in `state.yml`) are **not** rewritten to `off` — re-installing codex restores configured behavior on the next invocation.
3. **Record the degradation in `state.yml` immediately, on the very next state write of the run** (not "whenever the status updates next" — explicitly: at the close of Step B3 for kickoff flows, at Step C step 1's first state write for resume flows (auto-compact nudge / gated→loose offer / current_task refresh — whichever fires first), or at Step I3 for import flows; whichever lands first).
   - **`events.jsonl`** entry (one of):
     - `<ISO-ts> codex degraded — plugin not detected; codex_routing+codex_review forced to off for this run (configured: routing=<configured>, review=<configured>). Re-install codex plugin to restore.` *(detection_mode=`scan-then-ping`/`scan`/`ping` reporting plugin-missing)*
     - `<ISO-ts> codex degraded — ping returned error: <error-message-from-codex_ping_result>; codex_routing+codex_review forced to off for this run (configured: routing=<configured>, review=<configured>). Re-install or repair codex plugin to restore.` *(detection_mode=`scan-then-ping` Stage B or `ping`, dispatch returned an error — distinguishes "plugin missing" from "plugin present but dispatch broken")*
   - **If step 0 above appended a `degradation_self_doubt` event**, write it on the same forced state write as the `codex degraded` event (one immediately before the other, same `<ISO-ts>` granularity).
   - **No other state write happens this turn?** Force one anyway: append the degradation event, update `last_activity`, and set `last_warning: codex degraded this run — install codex plugin to restore configured routing/review` so the user's next `cat <state.yml>` shows the warning. Rationale: the user's optoe-ng pattern was a session that did codex-eligible work but never wrote degradation evidence.

4. Per-task safety net during Step C: at task-routing time (Step 3a), if the orchestrator finds itself routing inline because of Step 0 degradation rather than per-task ineligibility, the pre-dispatch banner (Fix 5 step 1) MUST suffix `(codex degraded — plugin missing)` so each task carries the degradation context, not just the kickoff write.

This detection is the FM-4-class graceful-degrade path. It complements doctor check #18 (the persistent-misconfiguration warning at lint time), check #20 (catches the missing-eligibility-cache *file* footprint when Step 0 degrades silently between sessions), and check #21 (catches the missing activity-log *evidence* footprint of the same root cause from a different angle — the two checks are designed to fire together on the same degraded plan).

### Git state cache (per invocation)

Several downstream steps consult the same git facts. Cache them once in Step 0 to avoid repeated subprocess overhead and keep latency predictable across A/B0/D fan-outs:

- `git_state.worktrees` — `git worktree list --porcelain`, parsed into `[{path, branch}]`.
- `git_state.branches` — `git branch --list` (local) and `git branch -r` (remote) names.

Steps A, B0, D consult the cache instead of re-running these. **Invalidate** the cache after any orchestrator-initiated `git worktree add`/`git worktree remove`/`git branch` operation (typically inside Step B0's "Create new" branch).

**Never cache `git status --porcelain`.** Working-tree dirty state must always be live; CD-2 depends on accurate dirty detection. A stale value here could let the orchestrator overwrite user-owned uncommitted changes.

### Run bundle state model

> **Full schema:** load `parts/contracts/run-bundle.md` for the complete state.yml v5 schema, plan.index.json schema, overflow rules, resume controller, lazy migration path, legacy migration, pending-retro recovery, and `bin/masterplan-state.sh` invocation contract. This section summarizes the key entry-time contract only.

The canonical runtime state is a per-plan run bundle at `docs/masterplan/<slug>/`. The `state.yml` file is the resumption contract and must exist as soon as Step B0 has selected a worktree and derived a slug.

**Resume controller.** At the start of bare `/masterplan`, Codex `Use masterplan`, `execute`, `next`, and `--resume` flows, after Step 0 config parsing and before any broad menu or fresh-start routing, run this controller against live `state.yml` (full logic in `parts/contracts/run-bundle.md`):

1. If `pending_gate` is non-null, re-render that exact gate and do not infer a default answer.
2. Else if `critical_error` is non-null or `status: blocked`, render the recorded recovery gate; do not auto-resume unsafe work.
3. Else if `background` is non-null, poll or review the recorded background continuation before dispatching any new work.
4. Else if `status: complete` OR `status: pending_retro` (or its synonym `retro_pending` — `bin/masterplan-state.sh` auto-heals the latter on read):
   - **Auto-retro backfill (v5.2.3+).** If `retro.md` is missing on disk AND `retro_policy.waived != true` AND `retro_policy.exempt != true` AND `schema_version >= 3`, invoke Step R inline as a backfill **before any other routing**. This catches Step C 6 bypasses — manual state edits flipping `status: complete`, brainstorm-only completions (`halt_mode=post-brainstorm` + force-complete), or first-attempt retro failures that left `status: pending_retro`. Step R writes `retro.md`; Step R3.5 archives state per `config.retro.auto_archive_after_retro`. On success, append `retro_backfill_succeeded` to `events.jsonl` and continue routing. On failure, persist `status: pending_retro`, increment `pending_retro_attempts`, append `retro_generation_failed`, and fall through to Step C step 6b's existing recovery (per `pending_retro_attempts` rules — second failure surfaces the regenerate/waive `AskUserQuestion`). **Schema_version < 3 bundles are NOT auto-backfilled** — they predate this contract; Doctor #28's `--fix` AskUserQuestion is the canonical path for those. **Smoke-fixture exemption:** to mark a bundle exempt from this backfill (e.g., a hand-crafted test state for the suppression smoke fixture), set `retro_policy.exempt: true` in `state.yml`.
   - After backfill (or if `retro.md` already exists), route only to completion follow-up, retro, archive, or status flows.
5. Else if one active `status: in-progress` plan is unambiguous, resume it automatically from `phase`, `current_task`, and `next_action`.
6. Else if multiple active plans are present, show a structured picker; never fall back to a broad feature menu while active work exists.

**Legacy migration.** Previous versions wrote state under `docs/superpowers/{plans,specs,retros,archived-*}` with `<slug>-status.md` plus sibling sidecars. Step 0 treats legacy status paths as resolvable inputs. Before listing, doctoring, cleaning, status reporting, or executing a legacy plan, run the legacy-state inventory logic described in Step I1 (Discover). If a legacy record has no matching `docs/masterplan/<slug>/state.yml`, surface an `AskUserQuestion` with options:

1. `Migrate to docs/masterplan/<slug>/state.yml now (Recommended)` — copy legacy plan/spec/retro/sidecars into the bundle, convert the legacy activity log into `events.jsonl`, preserve old paths under `legacy:`, then continue against the new `state.yml`.
2. `Use the legacy status path for this invocation only` — read legacy state but do not write new architecture fields except when explicitly requested by the user.
3. `Abort` — close without modifying files.

The migration is copy-only. Never delete legacy artifacts during migration; Step CL owns archive/delete after the new bundle is verified.

### Compaction-recent notice (per invocation)

A `/masterplan` invocation that follows a `/compact` within the same session can re-derive state from the filesystem only and inadvertently discard workflow position from the compaction summary (observed: petabit-os-mgmt 2026-05-07 00:46→00:54, where the compaction summary said *"interrupted before Step B1"* but the orchestrator routed to fresh start because no durable run state existed yet). To make this visible:

1. **Detect.** If any of these signals are present, set in-memory `compaction_recent = true`:
   - The current turn's first system reminder mentions `"session was compacted"` or `"post-compaction"` (case-insensitive substring match).
   - The user's preceding message (immediately before this `/masterplan` invocation) contains `<command-name>/compact</command-name>` or the literal token `/compact` as command output.
   - (Best-effort, opt-in) The session jsonl exists at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` AND a `type: "summary"` message was written within the last 30 minutes. If the jsonl path is not resolvable from inside the orchestrator (no session-id in scope), skip — this signal is informational, not load-bearing.

2. **Render.** When `compaction_recent == true`, emit a single non-blocking line AFTER the invocation sentinel (above) and BEFORE the verb routing table fires:

   ```
   ↻ Compaction detected this session — verifying plan state from filesystem.
    If you intended to resume specific work: /masterplan --resume=<state-path> (or paste the slug).
     Otherwise this run will route per the args you typed.
   ```

   This is plain stdout, NOT an `AskUserQuestion`. The user can ignore it; CC-3-TRAMPOLINE does not apply. The notice exists so the user can self-correct with `--resume=<path>` if the filesystem-derived routing differs from their intent.

3. **Pair with verb-explicit routing (Bug B).** When `compaction_recent == true` AND `requested_verb in {execute, full, plan}` AND no `state.yml` or legacy status matches `topic_hint`: Step A's verb-explicit override (step 7 of Step A) becomes the gate that catches the case where the user expected to resume but the filesystem disagrees. The compaction notice + the AskUserQuestion together cover the transition.

This is conservative by design — no JSONL parsing in the hot path, no pre-routing prompts.

### Complexity resolution (per invocation)

After config + flag merge completes, resolve the active `complexity` once and stash it on per-invocation state. Precedence (highest first):

1. `--complexity=<level>` CLI flag (when present in this turn's args).
2. Status frontmatter `complexity:` field (Step C resume only — empty during kickoff).
3. Repo-local `<repo-root>/.masterplan.yaml`'s `complexity:`.
4. User-global `~/.masterplan.yaml`'s `complexity:`.
5. Built-in default: `medium`.

Stash:
- `resolved_complexity` — one of `low`, `medium`, `high`.
- `complexity_source` — one of `flag`, `frontmatter`, `repo_config`, `user_config`, `default`.

These two values are read by every downstream step that varies behavior on complexity. Use `resolved_complexity` for behavioral branching and `complexity_source` for attribution. The activity-log audit line written at Step C step 1's first entry uses both values, e.g.:

```
- 2026-05-05T19:32 complexity=low (source: repo_config); codex_review=on (source: cli_flag, overrides complexity-derived default)
```

This single line is the audit trail for "why did the orchestrator behave this way." Step C step 1 emits it once on kickoff entry and once per cross-session resume.

### Temp-dir sweep (startup, once per invocation)

After complexity resolution, before verb routing, run a one-pass prune of stale masterplan import staging directories:

1. **Enumerate candidates.** List all directories matching `/tmp/masterplan-import-*` using Bash glob. If none exist, skip silently.
2. **Liveness filter.** For each directory whose name contains a PID component (format: `masterplan-import-<slug>-<pid>`), extract the PID. Run `ps -p <pid> -o pid=` (or `kill -0 <pid> 2>/dev/null` as fallback). If the process is alive, leave the directory untouched.
3. **Age filter.** For each remaining directory (no live owner), check mtime via `stat -c %Y <dir>` (Linux) or `stat -f %m <dir>` (macOS). If mtime is within the last 24 hours, leave it untouched (may belong to a recently-killed run that the user may wish to inspect).
4. **Prune.** For each directory that passes both filters (no live owner AND mtime > 24h ago), run `rm -rf <dir>`. Append one `{"event":"tempdir_swept","path":"<dir>","ts":"..."}` event to the active bundle's `events.jsonl` if a bundle is already loaded; otherwise buffer the event for the first state write that creates or loads a bundle.
5. **Never block.** If the glob, stat, or rm fails for any reason (permission denied, concurrent deletion), emit a one-line warning to stdout but continue. The sweep is best-effort.

### Verb routing (first token of `$ARGUMENTS`)

| First token | Branch | `halt_mode` |
|---|---|---|
| _(empty)_ | **Step M0 → resume-first routing** — inline status orientation + tripwire check, then auto-resume the current/only in-progress plan, list+pick if ambiguous, or show the two-tier menu only when no active plan exists | `none` |
| `full` (no topic) | Prompt for topic via `AskUserQuestion` (free-text Other), then **Step B** — full kickoff (B0→B1→B2→B3→C) | `none` |
| `full <topic>` | **Step B** — full kickoff (B0→B1→B2→B3→C) | `none` |
| `brainstorm` (no topic) | Prompt for topic via `AskUserQuestion` (free-text Other), then Step B0+B1; halt at B1 close-out gate | `post-brainstorm` |
| `brainstorm <topic>` | Step B0+B1; halt at B1 close-out gate | `post-brainstorm` |
| `plan` (no args) | **Step A's spec-without-plan variant** — pick spec-without-plan; treat pick as `plan --from-spec=<picked>` | `post-plan` |
| `plan <topic>` | Step B0+B1+B2+B3; halt at B3 close-out gate | `post-plan` |
| `plan --from-spec=<path>` | cd into spec's worktree, run B2+B3 only; halt at B3 close-out gate | `post-plan` |
| `execute` (no args) | **Step A** — list+pick across worktrees; set `requested_verb=execute` | `none` |
| `execute <state-path>` | **Step C** — resume that plan | `none` |
| `execute <topic-or-fuzzy-slug>` | **Step A** — list+pick with topic-match preference; set `requested_verb=execute`, `topic_hint=<remaining args>` | `none` |
| `import` (alone or with args) | **Step I** — legacy import | `none` |
| `doctor` (alone or with `--fix`) | **Step D** — lint state | `none` |
| `status` (alone or with `--plan=<slug>`) | **Step S** — situation report (read-only); see §Status verb below | `none` |
| `validate` (alone or with `--plan=<slug>`) | **inline** — validate config schema; see §Validate verb below | `none` |
| `retro` (alone or with `<slug>`) | **Step R** — generate retrospective for a completed plan | `none` |
| `stats` (alone or with `--plan=<slug>` / `--format=table\|json\|md` / `--all-repos` / `--since=<ISO-date>`) | **Step T** — codex-vs-inline routing distribution + inline model breakdown + token totals across plans | `none` |
| `clean` (alone or with `--dry-run` / `--delete` / `--category=<name>` / `--worktree=<path>`) | **Step CL** — archive completed plans + sidecars; prune orphan sidecars, stale plans, dead crons + worktrees | `none` |
| `next` | **Step N** — "what's next?" router: scan state files inline, present AUQ with resume/new-plan/status options. Never starts a new brainstorm cycle around the topic "next". | `none` |
| `--resume=<path>` or `--resume <path>` | **Step C** — alias for `execute <path>` | `none` |
| anything else | treat as a topic, **Step B** — kickoff (back-compat catch-all) | `none` |

### `halt_mode` and flag interactions

`halt_mode` is an internal orchestrator variable set in Step 0 from the verb match. Steps B1, B2, B3, and C consult it to choose between the existing gate behavior and a halt-aware variant.

**Verb tokens are reserved.** Any topic literally named `full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`, `stats`, `clean`, `validate`, or `next` requires another word in front via the catch-all (e.g., `/masterplan add brainstorm session timer`).

**Argument-parse precedence (in Step 0, after config + git_state cache):**
0. If invoked with no args (zero tokens after the command name): route directly to **Step M** — resume-first routing (see § Step M).
1. Match the first token against `{full, brainstorm, plan, execute, retro, import, doctor, status, stats, clean, validate, next}`. On match: set `halt_mode` per the table; **stash `requested_verb = <matched-verb>` for downstream steps to consult** (Step A's verb-explicit override reads it; Step B/C ignore it); consume the verb; pass remaining args to the matched step. **`execute <topic>` special case:** when `requested_verb == 'execute'` AND remaining args is non-empty AND remaining args does NOT resolve to an existing file path (`test -e <remaining>`), set `topic_hint = <remaining args>` and route to Step A (the table's third `execute` row). This carries the explicit verb intent into Step A so a missing state file does not silently route to brainstorm.
2. If unmatched and the first arg starts with `--`: route to **Step A** (flag-only invocation).
3. If unmatched and the first arg is a non-flag word: catch-all → **Step B** with the full arg string as the topic (existing behavior).

**`--resume=<path>` worktree-aware path resolution (v2.17.0+).** When `--resume=<path>` (or `--resume <path>` / `execute <path>`) is given AND `<path>` is relative AND `test -e <path>` is false against the current working directory, do NOT fall through to the catch-all or fail silently. Instead, search worktree subdirectories for the file before erroring:

1. **Build the candidate set.** Collect paths that match either of these globs (using shell globbing, no shell-out for find):
   - `<cwd>/.worktrees/*/<path>`
   - `<repo-root>/.worktrees/*/<path>` (when `<repo-root>` differs from `<cwd>`; resolve via `git rev-parse --show-toplevel` from `git_state` cache).
   Filter to existing files (`test -e <candidate>` per match).
2. **Resolve.**
   - **Exactly one match** → before entering Step C, `cd` to that match's worktree (the directory containing the matched path's nearest ancestor that is itself a registered worktree per `git_state.worktrees`). Re-resolve the relative path against the new cwd (it now exists). Emit one stdout line: `↻ --resume path resolved into worktree <worktree-path>; cd'd before Step C config load.` Then proceed to Step C step 1's batched re-read with the resolved path. The repo-local `<worktree>/.masterplan.yaml` is now picked up by Step 0's config-loading reload (re-run the repo-local config read post-cd; user-global + CLI flags merged on top, unchanged).
   - **Zero matches** → surface `AskUserQuestion("--resume path '<path>' not found at cwd or in any .worktrees/*/ subdirectory of <cwd> or <repo-root>. What now?", options=["Abort and let me re-run with a correct path (Recommended)", "Search the entire repo for matching state files (slower; uses find . -path '*/<path>')", "Treat <path> as a topic and route to Step A"])`. The third option preserves the existing `execute <topic>` fallback semantics for paths that look like topics rather than relative paths.
   - **Multiple matches** → surface `AskUserQuestion("--resume path '<path>' matches multiple candidates. Which one?", options=[<one option per candidate, label = '<worktree-path>/<path>', up to 4>, ...])`. If more than 4 candidates, show the first 3 ordered by `last_activity` from each matching `state.yml` or legacy status adapter (descending) plus a fourth "List all in stdout and abort" option.

This rule applies ONLY to relative paths. Absolute paths (`<path>` starts with `/`) bypass the search and use the existing direct-load behavior — if absolute paths don't exist, Step C step 1's parse guard catches them at file-read time.

**Why:** a user re-resuming work in a parent directory of a worktree (typical `optoe-ng` / `xcvr-tools-fresh` layout) would otherwise get a silent fall-through to Step A or a confusing parse error. The auto-cd resolves the common single-match case immediately; the AUQ branches handle ambiguity instead of guessing.

**Flag-interaction rules** (warnings emitted at Step 0, not later):
- `halt_mode == post-brainstorm` → `--autonomy=`, `--codex=`, `--codex-review=`, `--no-loop` are **ignored**. Emit one-line warning: `flags <list> ignored: brainstorm halts before execution`.
- `halt_mode == post-plan` → those same flags are **persisted** to `state.yml` (Step B3 records them) but do not fire this run. No warning.
- `halt_mode == none` → flags fire as today.

**`/loop /masterplan <verb> ...` foot-gun.** When `halt_mode != none` AND `ScheduleWakeup` is available (i.e. invoked via `/loop`), emit one-line warning: `note: <verb> halts before execution; --no-loop recommended for this verb`. Do NOT auto-disable the loop; the user may have a reason.

### Recognized flags

| Flag | Used by | Effect |
|---|---|---|
| `--autonomy=gated\|loose\|full` | B/C | Override `config.autonomy`. Default from config, fallback `gated` |
| `--resume=<state-path>` | 0 | Resume a specific plan; skip Step A/B |
| `--no-loop` | C | Disable cross-session ScheduleWakeup self-pacing |
| `--no-subagents` | C | Use `superpowers:executing-plans` instead of `superpowers:subagent-driven-development` |
| `--no-retro` | C | Disable the default completion retro for this run; leaves `status: complete` unless a manual `/masterplan retro` runs later |
| `--no-cleanup` | C | Disable the default completion cleanup pass for this run; legacy/orphan state remains for a later `/masterplan clean` |
| `--archive` | I | Override `config.cruft_policy` to `archive` for this import |
| `--keep-legacy` | I | Override `config.cruft_policy` to `leave` for this import |
| `--fix` | D | Auto-fix safe issues found by doctor (otherwise lint-only) |
| `--pr=<num>` | I | Direct import of one PR — skip discovery |
| `--issue=<num>` | I | Direct import of one issue — skip discovery |
| `--file=<path>` | I | Direct import of one local file — skip discovery |
| `--branch=<name>` | I | Direct reverse-engineer from one branch — skip discovery |
| `--codex=off\|auto\|manual` | C | Override `config.codex.routing` for this run. Persisted to `state.yml` |
| `--no-codex` | C | Shorthand for `--codex=off` (also disables review) |
| `--codex-review=on\|off` | C | Override `config.codex.review` for this run. When on, Codex reviews diffs from inline-completed tasks before they're marked done. Persisted to `state.yml` |
| `--codex-review` | C | Shorthand for `--codex-review=on` |
| `--complexity=low\|medium\|high` | 0/B/C | Override `config.complexity` for this run. Persisted to `state.yml` at Step B3 (kickoff) or updated at Step C step 1 (resume override, with an events audit entry). |
| `--no-codex-review` | C | Shorthand for `--codex-review=off` |
| `--parallelism=on\|off` | C | Override `config.parallelism.enabled` for this run. When `off`, wave dispatch in Step C step 2 is suppressed globally — every task runs serially regardless of `**parallel-group:**` annotations. Not persisted to `state.yml`; use `.masterplan.yaml` for durable defaults. |
| `--no-parallelism` | C | Shorthand for `--parallelism=off`. |
| `--keep-worktree` | B (brainstorm/plan/full) | Sets `worktree_disposition: kept_by_user` in initial state.yml at Step B0 step 6, overriding `worktree.default_disposition`. |
| `--dry-run` | CL | Print the cleanup plan + per-action `<src> → <dst>` lines without executing. Skip the confirmation gate. Does not affect any other step. |
| `--delete` | CL | For archival categories (completed plans, orphan sidecars, stale plans), `git rm` instead of archiving to `<config.archive_path>/<date>/`. OS-level categories (dead crons, dead worktrees) always delete regardless of this flag. Default off. |
| `--category=<name>` | CL | Limit Step CL to one category: `completed` / `legacy` / `orphans` / `stale` / `crons` / `worktrees` (or comma-separated subset). Default = all six. |
| `--worktree=<path>` | CL | Limit Step CL's per-worktree scan to one absolute path. Default = all worktrees in `git_state.worktrees`. |
| `--no-archive` | R | For manual `/masterplan retro`, write `retro.md` but skip Step R3.5's archive-state update |

---

## Status verb

`/masterplan status` (or `/masterplan status --plan=<slug>`) routes to **Step S** (situation report, read-only). Step S logic lives in `commands/masterplan.md` (monolith) in the `## Step S — Situation report` section; in v5.0+ it will be extracted to a dedicated phase file. The route from Step 0 is a direct handoff with no additional setup beyond what Step 0 already built (`git_state` cache, `config` object).

Flags accepted by `status`: `--plan=<slug>` narrows the report to one plan bundle. When absent, Step S reports across all worktrees.

`halt_mode` for `status` is `none`. Step S does not modify `state.yml`.

---

## Validate verb

`/masterplan validate` (or `/masterplan validate --plan=<slug>`) runs a read-only config and state schema validation. This verb is handled inline in Step 0 without dispatching to a separate phase file.

**What validate does:**

1. **Load config schema.** Read `docs/config-schema.md` (deferred; only loaded on this verb).
2. **Validate `~/.masterplan.yaml`.** Parse YAML. Check every key against the schema. Surface violations as severity-ordered findings:
   - **Error** — unknown key, wrong type, invalid enum value (e.g., `autonomy: aggressive`). Emit as `ERROR: <file>: <key>: <reason>`.
   - **Warning** — deprecated key, redundant flag, known-noisy combination (e.g., `codex.routing: off` + `codex.review: on`). Emit as `WARN: <file>: <key>: <reason>`.
3. **Validate repo-local `.masterplan.yaml`** (if present) — same checks.
4. **When `--plan=<slug>` is given:** also validate that plan's `state.yml` against the run-bundle schema in `parts/contracts/run-bundle.md`. Surface any required-field violations or schema_version mismatches.
5. **Summary line.** Emit `validate: <N> errors, <M> warnings` (or `validate: OK` when both are zero).
6. **Exit contract.** If any errors were found, append `{"event":"validate_failed","errors":<N>,"warnings":<M>,"ts":"..."}` to the active bundle's `events.jsonl` (or to a transient log if no active bundle). If warnings only, append `validate_warned`. If clean, no event.
7. **No state mutation.** Validate never writes `state.yml`, never modifies `.masterplan.yaml`. Read-only throughout.

`halt_mode` for `validate` is `none`. After the summary line, → CLOSE-TURN.

---

## CC-3-trampoline anchor

<!-- CC-3-trampoline: canonical turn-close sequence entry point -->

Every turn-close in this orchestrator MUST route through the following sequence. This is the single enforcement point for CC-3 (and the documented exclusion point for CC-1 / Step CL5 timer-disclosure, which have narrower scope). Replace any bare "end the turn" or "end the turn cleanly" directive in the Steps below with "→ CLOSE-TURN" to signal that this sequence runs before yielding.

**Sequence (execute in order, skip silently if condition not met):**
1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per §Per-turn dispatch tracking and summary (in `parts/contracts/agent-dispatch.md`). Emit BEFORE any AskUserQuestion or terminal render. Zero-dispatch turns: skip silently.
2. **Exit breadcrumb** — emit `<masterplan-trace step=<current-step-id> phase=out next=<next-step-or-CLOSE-TURN> reason=<one-word-reason>>` per the Breadcrumb emission contract (§Breadcrumb emission contract). Always required; never skipped. The marker is plain stdout, one line, BEFORE any AskUserQuestion or terminal render.
3. **Pre-close action** (site-specific) — any commit, state write, or ledger append that the calling site mandates BEFORE yielding (e.g., Step C step 5's ledger append, Step B3 "Discard"'s git-rm commit). These are documented at the call site.
4. **Closer** — fire the AskUserQuestion, ScheduleWakeup, or terminal render that ends the turn.

**Scope note:** CC-1 (compact-suggest) fires only before Step C step 5's ScheduleWakeup and is NOT part of this trampoline — it has its own inline position in Step C step 5. The CL5 timer-disclosure render is scoped to Step CL only and is NOT part of this trampoline. Adding new end-of-turn obligations: add them to this sequence, not to individual close sites.

**Authoring rule:** when adding a new turn-close site to the spec, write `→ CLOSE-TURN` as the close directive. The string `end the turn` should appear ONLY in negation contexts ("never end the turn waiting on..."), AskUserQuestion option labels, or YAML/comment blocks. `bin/masterplan-self-host-audit.sh` should grep for non-negated "end the turn" occurrences as a CD-style violation check.

**Exclusions:** CC-3-TRAMPOLINE does not apply to:
- The invocation sentinel (Step 0 §Invocation sentinel) — unconditional first-line render, not a turn-close.
- The compaction-recent notice (Step 0 §Compaction-recent notice) — emitted before verb routing, not a turn-close.
