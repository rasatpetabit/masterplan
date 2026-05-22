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

1. `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/.claude-plugin/plugin.json` — canonical installed location
2. `<cwd>/.claude-plugin/plugin.json` — dev checkout
3. `~/.claude/plugins/cache/rasatpetabit-superpowers-masterplan/superpowers-masterplan/<latest-version>/.claude-plugin/plugin.json` — last resort; glob highest semver

**Step 2.** Emit: `-> /masterplan v<semver> args: '<args-or-(empty)>' cwd: <repo-root-or-pwd>`. Substitute actual values; `(empty)` when no args. Truncate args at 120 chars; total sentinel ≤200 chars. Plain stdout, NOT inside AskUserQuestion/tool call/CC-3-trampoline.

**Fallback (ALL three Read attempts fail):** render `vUNKNOWN`. No other fallback permitted.

**Strict prohibitions.** Version slot must be parsed semver or literal `vUNKNOWN`. Never emit: any placeholder (`v?`, `vTBD`, etc.); the template token `v<version-from-plugin.json>` itself (angle brackets = you skipped the Read); a semver from session memory — always Read fresh.

**Step 3 — Codex health indicator (v5.1.1+, v5.2.3+).** Conditional second sentinel line, emitted ONLY when Codex routing/review is configured on AND `~/.codex/auth.json` shows actual auth degradation.

1. **Skip gate.** If `codex.routing == off` AND `codex.review == off`, emit nothing.
2. **Read auth file.** Read `~/.codex/auth.json`; if absent, emit nothing.
3. **Cosmetic-shape early-exit.** If `auth_mode == "chatgpt"` AND `tokens.refresh_token` non-empty AND `last_refresh` within last 7 days, emit nothing. (ChatGPT uses short-lived JWTs that auto-refresh; expired `id_token.exp` is normal steady state. `schema_v3+`: tokens under `.tokens.*`; jq fallback in step 4 handles both.)
4. **Decode JWT exp claims.** For each of `id_token` and `access_token`: `jq -r ".tokens.$f // .$f // empty" ~/.codex/auth.json | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .exp`. On decode error, treat as unknown.
5. **Compare to now.** `now="$(date +%s)"`. Expired when `now > exp`.
6. **Emit.** When ≥1 token expired: `↳ Codex: degraded (id_token expired Nd ago, access_token expired Md ago) — run \`codex login\` to refresh` (omit tokens where decode failed or exp ≥ now). When both decode cleanly + not expired + `last_refresh` > 30d (non-chatgpt only): `↳ Codex: stale (last_refresh Nd ago — consider running \`codex login\`)`. Both healthy + ≤30d: silent.

Plain stdout, NOT part of CC-3-trampoline. Cost: 1 Read + ≤2 base64-decodes (cosmetic-shape gate skips decodes under healthy ChatGPT auth). Doctor #39 surfaces the same expiry with more detail.

## CC-3-trampoline

Every turn-close in this orchestrator MUST route through the following sequence. This is the single enforcement point for CC-3 and the documented exclusion point for narrower close-site duties. Replace any bare "end the turn" directive in loaded parts with `-> CLOSE-TURN` to signal that this sequence runs before yielding.

**Sequence (execute in order, skip silently if condition not met):**

1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per the per-turn dispatch tracking contract. Emit before any `AskUserQuestion` or terminal render. Zero-dispatch turns: skip silently.
2. **Pre-close action** — perform any commit, state write, ledger append, or timer disclosure that the calling part mandates before yielding. These obligations stay documented at the call site.
3. **Breadcrumb render** — before every `AskUserQuestion` Closer (skip for `ScheduleWakeup` and non-interactive terminal renders), emit one plain-text navigation line so the user knows their location in the flow:
   ```
   /masterplan {verb} › {phase-label} › {gate-id}  [{slug}]
   ```
   - `{verb}`: the resolved verb for this invocation (`full`, `brainstorm`, `plan`, `execute`, `doctor`, etc.).
   - `{phase-label}`: human-readable current step — derive from the latest `<masterplan-trace step=X phase=in>` breadcrumb emitted this turn: `step-b1`→`Brainstorm`, `step-b2`→`Plan`, `step-b3`→`Plan-approval`, `step-c-resume`→`Execute`, `step-c-dispatch`→`Execute (dispatch)`, `step-c-verification`→`Execute (verify)`, `step-c-completion`→`Execute (complete)`, `doctor`→`Doctor`, `retro`→`Retro`, `step-a`→`Plan picker`, `step-0`→`Bootstrap`. When no step trace exists this turn, omit this segment.
   - `{gate-id}`: the `id` field of the gate being surfaced, e.g. `spec_approval`, `plan_closeout`, `completion_dirty`. Omit when the AUQ is a routing question without a formal gate (e.g. plan picker, complexity choice).
   - `[{slug}]`: the active run bundle slug if available. Omit when no bundle is loaded.
   - Example: `/masterplan full › Brainstorm › spec_approval  [my-feature]`
   - Example: `/masterplan execute › Execute (verify) › codex_review_gate  [yanos-wifi]`
   - Example: `/masterplan plan ›  Plan picker` (no gate, no slug yet)
4. **Closer** — fire the `AskUserQuestion`, `ScheduleWakeup`, or terminal render that ends the turn.

> CC-1 compact-suggest and timer-disclosure are not part of this trampoline. New end-of-turn obligations go into this sequence. Authoring rule: write `-> CLOSE-TURN` as the close directive; "end the turn" only in negation contexts or YAML examples.

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
| `doctor` | parts/step-0.md → parts/doctor.md | all 36 checks (Step D) |
| `status` | parts/step-0.md (Step S subroutine) | read-only situation report |
| `validate` | parts/step-0.md (reads docs/config-schema.md inline) | config + state schema check |
| `stats` | parts/step-0.md (Step T subroutine) | telemetry roll-up |
| `clean` | parts/step-0.md (Step CL subroutine) | archive + prune |
| `next` | parts/step-0.md (Step N subroutine) | what's-next router |
| `--resume=<path>` | parts/step-0.md → parts/step-c-resume.md | alias for `execute <path>` |

## Codex host detection

If invoked via `/superpowers-masterplan:masterplan` (Codex host), set `codex.host=true` and load `parts/codex-host.md` before phase dispatch. Suppresses `codex:codex-rescue` companion dispatch to prevent recursion.

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
