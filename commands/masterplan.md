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

Before doing anything else — before config load, before git_state cache, before verb routing — emit ONE plain-text line so the user can confirm `/masterplan` is alive. This is the FIRST output of every `/masterplan` turn.

**Step 1 — Resolve the version.** Use the **Read tool** to load `.claude-plugin/plugin.json` from the FIRST readable candidate path below, then parse the JSON and extract the `version` field. The Read tool call is mandatory — do not skip it, do not paraphrase its result, do not infer a version from session memory:

1. `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/.claude-plugin/plugin.json` — canonical installed location
2. `<cwd>/.claude-plugin/plugin.json` — dev checkout (works when CWD is the plugin source repo)
3. `~/.claude/plugins/cache/rasatpetabit-superpowers-masterplan/superpowers-masterplan/<latest-version>/.claude-plugin/plugin.json` — last resort; glob and pick the highest semver

**Step 2 — Render the sentinel.** Emit exactly one line in this shape, prefixed with `v` plus the parsed semver (no angle brackets, no placeholder tokens):

```
-> /masterplan v5.0.0 args: 'doctor --fix' cwd: <repo-root-or-pwd>
```

The shape is `-> /masterplan v<parsed-semver> args: '<truncated-args-or-(empty)>' cwd: <repo-root-or-pwd>`. Substitute the actual parsed semver, the actual `$ARGUMENTS` string (or the literal text `(empty)` when no arguments), and the actual cwd.

**Fallback (ONLY when ALL three Read attempts fail).** Render the literal version slot `vUNKNOWN`. No other fallback value is permitted.

**Strict prohibitions on the version slot.** The version slot must be either a parsed semver from `plugin.json` or the literal `vUNKNOWN`. You MUST NOT emit:
- `v?`, `v??`, `v???`, `vTBD`, `vXXX`, `v-`, `v<unknown>`, or any other abbreviated/handwaved fallback.
- The angle-bracket template token `v<version-from-plugin.json>` itself — that token is a shape-description in this prompt, not output. If you find yourself about to emit angle brackets in the sentinel, stop: you skipped the Read tool call.
- A semver from an older message, the conversation history, or a previous turn. **Always Read fresh on every `/masterplan` invocation.**

Truncate `args` at 120 chars; total sentinel length <= 200 chars. The sentinel is plain stdout, NOT inside an `AskUserQuestion`, NOT inside a tool call, and NOT part of CC-3-trampoline.

**Step 3 — Codex health indicator (v5.1.1+, I-4 of cosmic-cuddling-dusk).** Conditional second sentinel line, emitted ONLY when Codex routing/review is configured on AND `~/.codex/auth.json` shows an expired JWT. Steps:

1. **Skip gate.** If merged `codex.routing == off` AND `codex.review == off` (resolved from `~/.masterplan.yaml` + `.masterplan.yaml`), emit nothing — silent.
2. **Read auth file.** Use the **Read tool** to load `~/.codex/auth.json`. If the read fails (file absent — codex not installed for this user), emit nothing — silent.
3. **Decode JWT exp claims.** For each of `id_token` and `access_token` in the parsed JSON, split the JWT on `.`, base64-url-decode the middle segment, parse JSON, extract `exp` (Unix seconds). Run via Bash: `for f in id_token access_token; do token="$(jq -r ".$f" ~/.codex/auth.json)"; echo "${token}" | cut -d. -f2 | base64 -d 2>/dev/null | jq -r .exp; done` — the two output lines are the two `exp` values. On any decode error, treat that token as unknown (do not emit a warning sentinel for that token).
4. **Compare to now.** `now="$(date +%s)"`. For each `exp`, compute `age_days = (now - exp) / 86400`. If `now > exp` for either token, the auth is expired.
5. **Emit conditional line.** When at least one token is expired, emit one additional plain-stdout line directly under the version sentinel:

   ```
   ↳ Codex: degraded (id_token expired Nd ago, access_token expired Md ago) — run `codex login` to refresh
   ```

   Substitute `N` and `M` with the integer day age of each token (omit a token from the parenthetical when its decode failed or exp ≥ now — e.g. `(id_token expired 13d ago)` when only id_token is expired). When BOTH tokens decode cleanly AND are NOT expired but `last_refresh` (read from `~/.codex/auth.json`) is older than 30 days, emit a softer line: `↳ Codex: stale (last_refresh Nd ago — consider running `codex login`)`. When both decode cleanly AND not expired AND last_refresh < 30d, emit nothing — silent.

This Step 3 line is plain stdout, sibling of the Step 2 sentinel, NOT part of CC-3-trampoline. It runs unconditionally on every `/masterplan` invocation (cost: 1 Read + 2 base64-decodes ≈ 50ms). The skip gate in step 1 keeps the cost zero for users who have intentionally disabled codex. Doctor check #39 surfaces the same expiry condition at lint time with more detail.

## CC-3-trampoline

Every turn-close in this orchestrator MUST route through the following sequence. This is the single enforcement point for CC-3 and the documented exclusion point for narrower close-site duties. Replace any bare "end the turn" directive in loaded parts with `-> CLOSE-TURN` to signal that this sequence runs before yielding.

**Sequence (execute in order, skip silently if condition not met):**

1. **CC-3 check** — if `subagents_this_turn` is non-empty, emit the plain-text summary block per the per-turn dispatch tracking contract. Emit before any `AskUserQuestion` or terminal render. Zero-dispatch turns: skip silently.
2. **Pre-close action** — perform any commit, state write, ledger append, or timer disclosure that the calling part mandates before yielding. These obligations stay documented at the call site.
3. **Closer** — fire the `AskUserQuestion`, `ScheduleWakeup`, or terminal render that ends the turn.

**Scope note:** CC-1 compact-suggest remains positioned by the execution part and is not part of this trampoline. Timer-disclosure renders remain scoped to the archive/cleanup part. Adding a new end-of-turn obligation means adding it to this sequence, not spreading it across individual close sites.

**Authoring rule:** when adding a new turn-close site to the spec, write `-> CLOSE-TURN` as the close directive. The phrase "end the turn" should appear only in negation contexts, option labels, or YAML/comment examples.

## Verb dispatch table

| Verb | Routes to | Notes |
|---|---|---|
| _(empty)_ | parts/step-0.md (Step M0 resume-first) | inline status orientation + auto-resume |
| `full` | parts/step-0.md → parts/step-b.md → parts/step-c.md | full kickoff (B0→B1→B2→B3→C) |
| `brainstorm` | parts/step-0.md → parts/step-b.md | halts at B1 close-out gate (halt_mode=post-brainstorm) |
| `plan` | parts/step-0.md → parts/step-a.md (spec-pick) or parts/step-b.md | halts at B3 close-out gate (halt_mode=post-plan) |
| `execute` | parts/step-0.md → parts/step-c.md (resume) or parts/step-a.md (picker) | state-path resumes; topic/no-args picks |
| `retro` | parts/step-0.md → parts/step-c.md (Step R subroutine) | generate retrospective |
| `import` | parts/step-0.md → parts/import.md | legacy migration (Step I) |
| `doctor` | parts/step-0.md → parts/doctor.md | all 36 checks (Step D) |
| `status` | parts/step-0.md (Step S subroutine) | read-only situation report |
| `validate` | parts/step-0.md (reads docs/config-schema.md inline) | config + state schema check |
| `stats` | parts/step-0.md (Step T subroutine) | telemetry roll-up |
| `clean` | parts/step-0.md (Step CL subroutine) | archive + prune |
| `next` | parts/step-0.md (Step N subroutine) | what's-next router |
| `--resume=<path>` | parts/step-0.md → parts/step-c.md | alias for `execute <path>` |

## Codex host detection

If invoked via `/superpowers-masterplan:masterplan` (Codex host), set `codex.host=true` and load `parts/codex-host.md` before phase dispatch. Suppresses `codex:codex-rescue` companion dispatch to prevent recursion.

## Phase-prompt loader

After step-0.md completes bootstrap, route by verb. For `full`, `brainstorm`, `plan`, `execute`, `retro`, and `--resume=<path>`, load `parts/step-{state.yml.current_phase}.md`. The phase file is self-contained; it loads contracts on demand. Subroutine verbs (`status`, `stats`, `clean`, `next`, `validate`) execute inline within step-0.md and do not load additional phase files.

## Doctor entry point

For doctor verb: after step-0.md bootstrap, load `parts/doctor.md` and run all checks. Check #36 verifies this router stays ≤20480 bytes.

## Config reference

Schema documented in `docs/config-schema.md`. Loaded only on validate verb.

## Reserved verbs warning

The following verbs are reserved and require another word in front when used as topics (e.g., `/masterplan add brainstorm session timer`): `full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`, `stats`, `clean`, `validate`, `next`.
