---
description: Lazy-loading orchestrator router for /masterplan. Dispatches verbs to parts/step-{0,a,b,c}.md and parts/{doctor,import}.md.
---

# /masterplan Router (v5.0)

> v5.0 router. Phase content lives in parts/. Doctor lives in parts/doctor.md. Contracts in parts/contracts/.

## CC-1 — Arg-lock guard

**Verb tokens are reserved.** Any topic literally named `full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`, `stats`, `clean`, `validate`, or `next` requires another word in front via the catch-all (for example, `/masterplan add brainstorm session timer`).

**Argument-parse precedence (in parts/step-0.md, after config + git_state cache):**
0. If invoked with no args (zero tokens after the command name): route to the resume-first controller in `parts/step-0.md` (Step M0).
1. Match the first token against `{full, brainstorm, plan, execute, retro, import, doctor, status, stats, clean, validate, next}`. On match: set `requested_verb = <matched-verb>`, set `halt_mode` per the routing table in `parts/step-0.md`, consume the verb, and pass remaining args to the route in the dispatch table below.
2. If unmatched and the first arg starts with `--`: load `parts/step-0.md` and let bootstrap resolve flag-only behavior (notably `--resume=<path>` / `--resume <path>`, which alias to `execute <path>`).
3. If unmatched and the first arg is a non-flag word: treat the full arg string as the topic and route to Step B via `parts/step-0.md` (back-compat catch-all).

## CC-2 — Boot banner

Emit ONE plain-text line before anything else (first output of every turn).

**Step 1.** Use the **Read tool** (mandatory — do not skip, paraphrase, or infer from memory) to load `.claude-plugin/plugin.json` from the first readable candidate:

1. `~/.claude/plugins/marketplaces/rasatpetabit-masterplan/.claude-plugin/plugin.json` — canonical installed location
2. `<cwd>/.claude-plugin/plugin.json` — dev checkout
3. `~/.claude/plugins/cache/rasatpetabit-masterplan/masterplan/<latest-version>/.claude-plugin/plugin.json` — last resort; glob highest semver

**Step 2.** Emit: `-> /masterplan v<semver> args: '<args-or-(empty)>' cwd: <repo-root-or-pwd>`. Substitute actual values; `(empty)` when no args. Truncate args at 120 chars; total sentinel ≤200 chars. Plain stdout, NOT inside AskUserQuestion/tool call/CC-3-trampoline.

**Fallback (ALL three Read attempts fail):** render `vUNKNOWN`. No other fallback permitted.

**Strict prohibitions.** Version slot must be parsed semver or literal `vUNKNOWN`. Never emit: any placeholder (`v?`, `vTBD`, etc.); the template token `v<version-from-plugin.json>` itself (angle brackets = you skipped the Read); a semver from session memory — always Read fresh.

**Step 3 — Codex health indicator (v5.1.1+, v5.2.3+).** Conditional second sentinel line, emitted ONLY when Codex routing/review is configured on AND `~/.codex/auth.json` shows actual auth degradation.

1. **Skip gate.** If `codex.routing == off` AND `codex.review == off`, emit nothing.
2. **Read auth file.** Read `~/.codex/auth.json`; if absent, emit nothing.
3. **Cosmetic-shape early-exit.** If `auth_mode == "chatgpt"` AND `tokens.refresh_token` non-empty, emit nothing — skip steps 4 and 5 entirely. ChatGPT auto-refreshes `id_token` on every Codex invocation; neither `id_token.exp` nor `last_refresh` age is a meaningful health signal for this mode. (`schema_v3+`: tokens under `.tokens.*`; jq fallback in step 4 handles both.)
4. **Decode JWT exp claims.** For each of `id_token` and `access_token`: `jq -r ".tokens.$f // .$f // empty" ~/.codex/auth.json | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .exp`. On decode error, treat as unknown.
5. **Compare to now.** `now="$(date +%s)"`. Expired when `now > exp`.
6. **Emit.** When ≥1 token expired: `↳ Codex: degraded (id_token expired Nd ago, access_token expired Md ago) — run \`codex login\` to refresh` (omit tokens where decode failed or exp ≥ now). When both decode cleanly + not expired + `last_refresh` > 30d (non-chatgpt only): `↳ Codex: stale (last_refresh Nd ago — consider running \`codex login\`)`. Both healthy + ≤30d: silent.

Plain stdout, NOT part of CC-3-trampoline. Cost: 1 Read + ≤2 base64-decodes (cosmetic-shape gate skips decodes under healthy ChatGPT auth). Doctor #39 surfaces the same expiry with more detail.

## CC-3-trampoline

Every turn-close in this orchestrator MUST route through the following sequence. This is the single enforcement point for CC-3 and the documented exclusion point for narrower close-site duties. Replace any bare "end the turn" directive in loaded parts with `-> CLOSE-TURN` to signal that this sequence runs before yielding.

**Sequence (execute in order, skip silently if condition not met):**

1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per `parts/contracts/agent-dispatch.md` §Per-turn dispatch tracking. Format, record shape, and reset rules defined there. Emit before any `AskUserQuestion` or terminal render. Immediately after the summary block, emit the marker `<masterplan-trace event=summary_block_emitted dispatch_count=<N>>` on its own line (where `<N>` = `len(subagents_this_turn)`); this is the inert textual signal the Stop hook scans to write the corresponding `events.jsonl` row (D19). Zero-dispatch turns: skip silently — emit neither block nor marker.
2. **Pre-close action** — perform any commit, state write, ledger append, or timer disclosure that the calling part mandates before yielding. These obligations stay documented at the call site.
3. **Breadcrumb render** — emit one plain-text navigation line at **two** sites so the breadcrumb survives manual interruption. After each breadcrumb line, emit `<masterplan-trace event=breadcrumb_emitted site=<tag>>` on its own line as the inert textual signal for the Stop hook (D19; the hook converts this to an `events.jsonl` row used by Check #51).
   - **Step entry** — immediately after each `<masterplan-trace step=X phase=in>` marker (every step that emits a phase-in trace must follow it with the breadcrumb on the next line, then `<masterplan-trace event=breadcrumb_emitted site=step-entry-<phase>>` on the line after that).
   - **AUQ close-site** — before every `AskUserQuestion` Closer. No routing-question exception — every AUQ requires a breadcrumb line, followed by `<masterplan-trace event=breadcrumb_emitted site=auq-close-<gate>>` (or `<masterplan-trace event=breadcrumb_emitted site=auq-close-routing>` for non-gate AUQs like the plan picker). (Skip only for `ScheduleWakeup` and non-interactive terminal renders that never surface to the user.)

   Format:
   ```
   /masterplan {verb} › {phase-label} › {gate-id}  [{slug}]
   ```
   - `{verb}`: the resolved verb for this invocation (`full`, `brainstorm`, `plan`, `execute`, `doctor`, etc.).
   - `{phase-label}`: human-readable current step — derive from the current `<masterplan-trace step=X phase=in>` marker: `step-b1`→`Brainstorm`, `step-b2`→`Plan`, `step-b3`→`Plan-approval`, `step-c-resume`→`Execute`, `step-c-dispatch`→`Execute (dispatch)`, `step-c-verification`→`Execute (verify)`, `step-c-completion`→`Execute (complete)`, `doctor`→`Doctor`, `retro`→`Retro`, `step-a`→`Plan picker`, `step-0`→`Bootstrap`, `step-b0`→`Worktree setup`. When no step trace exists this turn, omit this segment.
   - `{gate-id}`: the `id` field of the gate being surfaced. At step-entry sites (no gate yet), omit. At AUQ close-sites, include when the AUQ is a formal planning gate; omit for routing questions (plan picker, complexity choice).
   - `[{slug}]`: the active run bundle slug if available. Omit when no bundle is loaded.
   - Example (step entry): `/masterplan full › Brainstorm  [my-feature]`
   - Example (AUQ gate): `/masterplan full › Brainstorm › spec_approval  [my-feature]`
   - Example (AUQ routing): `/masterplan plan ›  Plan picker`
4. **Closer** — fire the `AskUserQuestion`, `ScheduleWakeup`, or terminal render that ends the turn. **Before** any `AskUserQuestion` tool call, emit `<masterplan-trace event=auq_render site=<tag>>` on its own line (use the same `<tag>` from the preceding breadcrumb's `site=auq-close-<gate>`, normalized — e.g., `b2-spec-approval`, `b3-plan-approval`, `c4b-failure`, `routing-plan-picker`). This is the hook-side signal that drives Check #51's AUQ-side counter (D19). Skip for `ScheduleWakeup` and non-interactive renders (they never present an AUQ to the user).

> CC-1 compact-suggest and timer-disclosure are not part of this trampoline. New end-of-turn obligations go into this sequence. Authoring rule: write `-> CLOSE-TURN` as the close directive; "end the turn" only in negation contexts or YAML examples.

**Subagent-dispatch marker rule (D19).** Every site that invokes the `Agent`, `Task`, `codex:codex-rescue`, `WebFetch`, or any other dispatch-class tool MUST emit `<masterplan-trace event=subagent_dispatched type=<subagent_type> model=<model> task=<short-label>>` on its own line immediately before the dispatch tool call. `<subagent_type>` matches the tool's `subagent_type` parameter (e.g., `Explore`, `general-purpose`, `Plan`, `feature-dev:code-architect`, `codex:codex-rescue`). `<model>` matches the dispatched tier (`haiku`, `sonnet`, `opus`, or `codex` for codex dispatches). `<short-label>` is a kebab-case identifier ≤32 chars (e.g., `grep-batch`, `B2-spec-review`, `wave-1-task-3`). The Stop hook converts each marker to an `events.jsonl` row that Check #52 cross-references against `subagents.jsonl` for drift detection (D4). This rule is referenced from `parts/contracts/agent-dispatch.md` §Per-turn dispatch tracking; the marker MUST be emitted in addition to (not instead of) the `subagents_this_turn` list append.

## Verb dispatch table

| Verb | Routes to | Notes |
|---|---|---|
| _(empty)_ | parts/step-0.md (Step M0 resume-first) | inline status orientation + auto-resume |
| `full` | parts/step-0.md → parts/step-b.md → parts/step-c-resume.md | full kickoff (B0→B1→B2→B3→C) |
| `brainstorm` | parts/step-0.md → parts/step-b.md | halts at B1 close-out gate (halt_mode=post-brainstorm) |
| `plan` | parts/step-0.md → parts/step-a.md (spec-pick) or parts/step-b.md | halts at B3 close-out gate (halt_mode=post-plan) |
| `execute` | parts/step-0.md → parts/step-c-resume.md (resume) or parts/step-a.md (picker) | state-path resumes; topic/no-args picks |
| `retro` | parts/step-0.md → parts/step-c-resume.md (Step R subroutine) | generate retrospective |
| `import` | parts/step-0.md → parts/import.md | legacy migration (Step I) |
| `doctor` | parts/step-0.md → parts/doctor.md | all 52 checks (Step D) |
| `status` | parts/step-0.md (Step S subroutine) | read-only situation report |
| `validate` | parts/step-0.md (reads docs/config-schema.md inline) | config + state schema check |
| `stats` | parts/step-0.md (Step T subroutine) | telemetry roll-up |
| `clean` | parts/step-0.md (Step CL subroutine) | archive + prune |
| `next` | parts/step-0.md (Step N subroutine) | what's-next router |
| `--resume=<path>` | parts/step-0.md → parts/step-c-resume.md | alias for `execute <path>` |

## Codex host detection

If invoked via `/masterplan:masterplan` (Codex host), set `codex.host=true` and load `parts/codex-host.md` before phase dispatch. Suppresses `codex:codex-rescue` companion dispatch to prevent recursion.

## Phase-prompt loader

After step-0.md completes bootstrap, route by verb. For `full`, `brainstorm`, `plan`, `execute`, `retro`, and `--resume=<path>`, load `parts/step-{state.yml.current_phase}.md`. The phase file is self-contained; it loads contracts on demand. Subroutine verbs (`status`, `stats`, `clean`, `next`, `validate`) execute inline within step-0.md and do not load additional phase files.

**step-c split (v6.0).** `step-c.md` is replaced by 4 load-on-demand sub-files: `step-c-resume.md` (entry + step 1), `step-c-dispatch.md` (wave assembly + routing), `step-c-verification.md` (post-task finalize), `step-c-completion.md` (loop scheduling + completion). Load `step-c-resume.md` as the execution entry point; sub-file headers cross-reference each next sub-file.

## Doctor entry point

For doctor verb: after step-0.md bootstrap, dispatch coordinator-doctor:

```
DISPATCH-SITE: coordinator-doctor
contract_id: "coordinator-doctor-v1"
Tier: sonnet
Goal: Load parts/doctor.md internally; run all checks; apply safe fixes when fix_flag=true.
Inputs: fix_flag=<true|false>, bundle_path=<active-bundle-path or null>
Scope: read parts/doctor.md + all referenced state files; write only when fix_flag=true.
Constraints: CD-7 (orchestrator writes state.yml from coordinator results only).
Return shape: {pass, warn, error, findings: [{id, severity, summary, fix_available}], fix_applied, coordinator_version}
```

**Fallback** (coordinator errors): log `coordinator_fallback` and load `parts/doctor.md` inline (pre-v6 behavior).

Check #36 verifies this router stays ≤20480 bytes. Extended rationale: `docs/internals/doctor.md`.

## Config reference

Schema documented in `docs/config-schema.md`. Loaded only on validate verb.

## Reserved verbs warning

The following verbs are reserved and require another word in front when used as topics (e.g., `/masterplan add brainstorm session timer`): `full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`, `stats`, `clean`, `validate`, `next`.
