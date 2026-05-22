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
→ /masterplan v3.3.0 args: 'doctor --fix' cwd: /path/to/optoe-ng
```

The shape is `→ /masterplan v<parsed-semver> args: '<truncated-args-or-(empty)>' cwd: <repo-root-or-pwd>`. Substitute the actual parsed semver (e.g. `v3.3.0`, `v3.2.9`), the actual `$ARGUMENTS` string (or the literal text `(empty)` when no arguments), and the actual cwd.

**Fallback (ONLY when ALL three Read attempts fail).** Render the exact six-character literal string `vUNKNOWN`. No other fallback value is permitted.

**Strict prohibitions on the version slot.** The version slot in the rendered sentinel must be either a parsed semver from `plugin.json` or the literal `vUNKNOWN`. You MUST NOT emit:
- `v?`, `v??`, `v???`, `vTBD`, `vXXX`, `v-`, `v<unknown>`, or any other abbreviated/handwaved fallback.
- The angle-bracket template token `v<version-from-plugin.json>` itself — that token is a shape-description in this prompt, not output. If you find yourself about to emit angle brackets in the sentinel, stop: you skipped the Read tool call.
- A semver from an older message, the conversation history, or a previous turn. Always Read fresh on every `/masterplan` invocation.

Truncate `args` at 120 chars with `…`; total sentinel length ≤ 200 chars. The sentinel is plain stdout, NOT inside an `AskUserQuestion`, NOT inside a tool call — it must appear in the user-visible turn output.

**Why:** a missing sentinel line signals the harness ate the invocation — re-register via `/plugin` (uninstall + reinstall) and re-invoke. CC-3-TRAMPOLINE does not apply; this is an unconditional first-line render.

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

> See `docs/internals/failure-instrumentation.md` for the auto-filing rationale.

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

- **`scan-then-ping` (default, v5.3.0+)** — two-tier detection. **Stage A (scan):** if `codex:` appears in the system-reminder skills list, set `codex_ping_result = "ok"` (`detection_source = "scan"`) and short-circuit. **Stage B (ping fallback):** only when Stage A misses, dispatch a 5-token bounded ping to `codex:codex-rescue` (`Goal=health-check`, `Return shape={status:"ok"}`). On dispatch error → codex unavailable; cache error string. On success → `detection_source = "ping"`. At most one ping per invocation.
- **`ping` (legacy default pre-v5.3.0)** — dispatch the 5-token ping unconditionally; never scan. Retained for users who explicitly opt in.
- **`scan`** — scan-only: literal substring `codex:` test against the system-reminder skills list. Never dispatches a ping.
- **`trust`** — assume codex is available; skip detection entirely.

**Mid-session `/reload-plugins`:** `codex_ping_result` is per-invocation; re-running `/masterplan` rebuilds the cache.

**Log detection outcome to `events.jsonl`.** Record one event per invocation; success-path events piggyback on the next natural state write; failure-path events force-flush. Event formats and Doctor check #41 audit spec: see `parts/contracts/run-bundle.md §Codex availability events`.

If detection concludes codex is **absent**, behavior depends on `config.codex.unavailable_policy` (default `degrade-loudly`; v2.4.0+):

**`unavailable_policy: block`** — emit the visible stdout warning then HALT; do not enter Step B/C/I. Set `halt_reason = "codex unavailable; unavailable_policy=block"`. If via `/loop`, reschedule for retry; otherwise → CLOSE-TURN. Emit: `⚠ HALT — codex plugin not detected and config.codex.unavailable_policy=block. Install codex OR set unavailable_policy: degrade-loudly to allow inline fallthrough.`

**`unavailable_policy: degrade-loudly`** (default) — execute the full degradation path below:

0. **Self-doubt cross-check (v5.3.0+).** Before emitting the warning, run the auth-healthy and plugin-on-disk probes per `parts/contracts/run-bundle.md §Codex degradation evidence`. If both pass but detection returned absent, append the `degradation_self_doubt` INFO event; the warning still fires.

1. **Emit visible stdout warning** (do not abort) — must be a top-level user-facing line, not buried inside a tool call:

   > ⚠ Codex plugin not detected — `codex_routing` and `codex_review` are degraded to `off` for this run. Install via `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex`, then `/reload-plugins`, to restore configured Codex routing + cross-model review. Persisted config is unchanged.

2. In-memory only: treat `codex_routing` as `off` and `codex_review` as `off` for the run. The persisted defaults (in `.masterplan.yaml`) and run fields (in `state.yml`) are **not** rewritten to `off` — re-installing codex restores configured behavior on the next invocation.
3. **Record the degradation in `state.yml`** on the very next state write (Step B3 close for kickoff; Step C step 1's first write for resume; Step I3 for import; whichever lands first). Event formats and force-flush contract: see `parts/contracts/run-bundle.md §Codex degradation evidence`.

4. Per-task safety net during Step C: at task-routing time (Step 3a), if the orchestrator finds itself routing inline because of Step 0 degradation rather than per-task ineligibility, the pre-dispatch banner (Fix 5 step 1) MUST suffix `(codex degraded — plugin missing)` so each task carries the degradation context, not just the kickoff write.

### Git state cache (per invocation)

Cache once in Step 0 (Steps A, B0, D read these instead of re-running):
- `git_state.worktrees` — `git worktree list --porcelain`, parsed into `[{path, branch}]`.
- `git_state.branches` — `git branch --list` (local) + `git branch -r` (remote).

Invalidate after any orchestrator `git worktree add/remove` or `git branch` call. **Never cache `git status --porcelain`** — dirty state must always be live (CD-2).

### Run bundle state model

> **Full schema:** load `parts/contracts/run-bundle.md` for the complete state.yml v5 schema, plan.index.json schema, overflow rules, resume controller, lazy migration path, legacy migration, pending-retro recovery, and `bin/masterplan-state.sh` invocation contract. This section summarizes the key entry-time contract only.

The canonical runtime state is a per-plan run bundle at `docs/masterplan/<slug>/`. The `state.yml` file is the resumption contract and must exist as soon as Step B0 has selected a worktree and derived a slug.

**Resume controller.** On every `/masterplan` invocation, after Step 0 config parsing and before any routing, run against live `state.yml` (full logic in `parts/contracts/run-bundle.md`):

1. If `pending_gate` is non-null, re-render that exact gate and do not infer a default answer. **Free-text gate response rule:** when the user's response to a gate AUQ does not match any of its named options (i.e., they typed free text via the "Other" field, or their text is a question/comment rather than a selection), treat it as "hold the gate and chat": respond to their text, keep `pending_gate` as-is, and → CLOSE-TURN. Do NOT advance to the next phase or fire a downstream AUQ. This applies to every gate in every phase — spec_approval, plan_closeout, completion_dirty, blocker re-engagement, etc.
2. Else if `critical_error` is non-null or `status: blocked`, render the recorded recovery gate; do not auto-resume unsafe work.
3. Else if `background` is non-null, poll or review the recorded background continuation before dispatching any new work.
4. Else if `status: complete` OR `status: pending_retro`: auto-retro backfill (v5.2.3+) — if `retro.md` is missing, invoke Step R inline before any other routing (full spec in `parts/contracts/run-bundle.md`). Route to completion follow-up, retro, archive, or status flows.
5. Else if one active `status: in-progress` plan is unambiguous, resume it automatically from `phase`, `current_task`, and `next_action`.
6. Else if multiple active plans are present, show a structured picker; never fall back to a broad feature menu while active work exists.

**Legacy migration.** If a legacy `docs/superpowers/...` plan has no matching `docs/masterplan/<slug>/state.yml`, surface an AskUserQuestion: Migrate now (Recommended) / Use legacy path this invocation / Abort. Migration is copy-only; Step CL owns archive/delete.

### Compaction-recent notice (per invocation)

When a `/compact` precedes a `/masterplan` invocation, workflow position may be lost. To make this visible:

1. **Detect.** If any of these signals are present, set in-memory `compaction_recent = true`:
   - The current turn's first system reminder mentions `"session was compacted"` or `"post-compaction"` (case-insensitive substring match).
   - The user's preceding message (immediately before this `/masterplan` invocation) contains `<command-name>/compact</command-name>` or the literal token `/compact` as command output.

2. **Render.** When `compaction_recent == true`, emit a single non-blocking line AFTER the invocation sentinel (above) and BEFORE the verb routing table fires:

   ```
   ↻ Compaction detected this session — verifying plan state from filesystem.
    If you intended to resume specific work: /masterplan --resume=<state-path> (or paste the slug).
     Otherwise this run will route per the args you typed.
   ```

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

These two values are read by every downstream step. Step C step 1 logs both as the complexity attribution entry on kickoff and resume.

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
| `doctor` (alone or with `--fix`) | **Step D** — lint state via coordinator-doctor (see `commands/masterplan.md §Doctor entry point`); on coordinator error, log `coordinator_fallback` and load `parts/doctor.md` inline | `none` |
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
1. Match the first token against `{full, brainstorm, plan, execute, retro, import, doctor, status, stats, clean, validate, next}`. On match: set `halt_mode` per the table; stash `requested_verb = <matched-verb>`; consume the verb; pass remaining args to the matched step. **`execute <topic>` special case:** when `requested_verb == 'execute'` AND remaining args non-empty AND does NOT resolve to an existing file path, set `topic_hint = <remaining args>` and route to Step A.
2. If unmatched and the first arg starts with `--`: route to **Step A** (flag-only invocation).
3. If unmatched and the first arg is a non-flag word: catch-all → **Step B** with the full arg string as the topic (existing behavior).

**`--resume=<path>` worktree-aware path resolution (v2.17.0+).** When `<path>` is relative and `test -e <path>` fails against cwd, search worktree subdirectories before erroring.

> Full candidate-set build, single/zero/multiple-match AskUserQuestion specs: see `parts/contracts/run-bundle.md §--resume path resolution`. Absolute paths bypass the search.

**Flag-interaction rules** (Step 0):
- `halt_mode == post-brainstorm` → `--autonomy=`, `--codex=`, `--codex-review=`, `--no-loop` are **ignored**. Emit: `flags <list> ignored: brainstorm halts before execution`.
- `halt_mode == post-plan` → those same flags are **persisted** to `state.yml` but do not fire this run.
- `halt_mode == none` → flags fire normally.

**`/loop /masterplan <verb> ...` foot-gun.** When `halt_mode != none` AND `ScheduleWakeup` is available, emit: `note: <verb> halts before execution; --no-loop recommended for this verb`. Do not auto-disable the loop.

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

`/masterplan status` (or with `--plan=<slug>`) routes to Step S (situation report, read-only). `--plan=<slug>` narrows to one plan bundle. `halt_mode=none`; Step S does not modify `state.yml`.

---

## Validate verb

`/masterplan validate` (or with `--plan=<slug>`) — read-only config and state schema check, inline in Step 0. Loads `docs/config-schema.md`; validates `~/.masterplan.yaml` + repo-local `.masterplan.yaml` against schema (errors: `ERROR: <file>: <key>: <reason>`; warnings: `WARN: …`). When `--plan=<slug>` given, also validates `state.yml` against run-bundle schema. Emits `validate: <N> errors, <M> warnings` (or `validate: OK`); appends `validate_failed`/`validate_warned` to `events.jsonl`. Read-only; never mutates state. `halt_mode=none`; → CLOSE-TURN.

---

## CC-3-trampoline anchor

<!-- CC-3-trampoline: canonical turn-close sequence entry point -->

Every turn-close in this orchestrator MUST route through the following sequence. This is the single enforcement point for CC-3 (and the documented exclusion point for CC-1 / Step CL5 timer-disclosure, which have narrower scope). Replace any bare "end the turn" or "end the turn cleanly" directive in the Steps below with "→ CLOSE-TURN" to signal that this sequence runs before yielding.

**Sequence (execute in order, skip silently if condition not met):**
1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per §Per-turn dispatch tracking and summary (in `parts/contracts/agent-dispatch.md`). Emit BEFORE any AskUserQuestion or terminal render. Zero-dispatch turns: skip silently.
2. **Exit breadcrumb** — emit `<masterplan-trace step=<current-step-id> phase=out next=<next-step-or-CLOSE-TURN> reason=<one-word-reason>>` per the Breadcrumb emission contract (§Breadcrumb emission contract). Always required; never skipped. The marker is plain stdout, one line, BEFORE any AskUserQuestion or terminal render.
3. **Pre-close action** (site-specific) — any commit, state write, or ledger append that the calling site mandates BEFORE yielding (e.g., Step C step 5's ledger append, Step B3 "Discard"'s git-rm commit). These are documented at the call site.
4. **Closer** — fire the AskUserQuestion, ScheduleWakeup, or terminal render that ends the turn.

**Scope note:** CC-1 compact-suggest and CL5 timer-disclosure are NOT part of this trampoline; they have narrower inline positions. New obligations: add to this sequence, not to individual close sites. Authoring rule: write `→ CLOSE-TURN` at every new turn-close site; `bin/masterplan-self-host-audit.sh` greps for non-negated `end the turn` occurrences.

**Exclusions:** CC-3-TRAMPOLINE does not apply to the invocation sentinel or compaction-recent notice — neither is a turn-close.
