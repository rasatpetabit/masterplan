---
description: Lazy-loading orchestrator router for /masterplan. Dispatches verbs to parts/step-{0,a,b,c}.md and parts/{doctor,import}.md.
---

# /masterplan Router (v5.0)

> v5.0 router. Phase content lives in parts/. Doctor lives in parts/doctor.md. Contracts in parts/contracts/.

## CC-1 — Arg-lock guard

**Verb tokens are reserved.** Any topic literally named `full`, `brainstorm`, `plan`, `execute`, `retro`, `import`, `doctor`, `status`, `stats`, `clean`, or `next` requires another word in front via the catch-all (for example, `/masterplan add brainstorm session timer`).

**Argument-parse precedence (in step-0.md, after config + git_state cache):**
0. If invoked with no args (zero tokens after the command name): route to the resume-first controller in `parts/step-0.md`.
1. Match the first token against `{start, resume, status, doctor, import, archive, validate, retry}`. On match: set `requested_verb = <matched-verb>`, consume the verb, and pass remaining args to the route in the dispatch table below.
2. If unmatched and the first arg starts with `--`: load `parts/step-0.md` and let bootstrap resolve flag-only resume/start behavior.
3. If unmatched and the first arg is a non-flag word: treat the full arg string as the topic and route as `start`.
4. If the first token is a legacy reserved verb from v4 (`full`, `brainstorm`, `plan`, `execute`, `retro`, `stats`, `clean`, or `next`), reject it as reserved unless `parts/import.md` is explicitly running a legacy migration path.

## CC-2 — Boot banner

Before doing anything else, before config load, before git_state cache, before verb routing, emit ONE plain-text line so the user can confirm `/masterplan` is alive. This is the FIRST output of every `/masterplan` turn.

Resolve the version by reading `.claude-plugin/plugin.json` from the first readable candidate path:

1. `~/.claude/plugins/marketplaces/rasatpetabit-superpowers-masterplan/.claude-plugin/plugin.json`
2. `<cwd>/.claude-plugin/plugin.json`
3. `~/.claude/plugins/cache/rasatpetabit-superpowers-masterplan/superpowers-masterplan/<latest-version>/.claude-plugin/plugin.json`

Render exactly one line in this shape, prefixed with `v` plus the parsed semver:

```
-> /masterplan v3.3.0 args: 'doctor --fix' cwd: /home/grojas/dev/optoe-ng
```

The shape is `-> /masterplan v<parsed-semver> args: '<truncated-args-or-(empty)>' cwd: <repo-root-or-pwd>`. If every read attempt fails, render the literal version slot `vUNKNOWN`. Do not emit `v?`, `v??`, `v???`, `vTBD`, `vXXX`, `v-`, `v<unknown>`, or the angle-bracket template token itself. Truncate `args` at 120 chars; total sentinel length <= 200 chars. The sentinel is plain stdout, not an `AskUserQuestion`, not inside a tool call, and not part of CC-3-trampoline.

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
| start | parts/step-0.md -> step-a.md -> step-b.md -> step-c.md | full flow |
| resume | parts/step-0.md -> parts/step-{state.current_phase}.md | re-entry |
| status | parts/step-0.md (status subroutine) | no mutation |
| doctor | parts/step-0.md -> parts/doctor.md | all 36 checks |
| import | parts/step-0.md -> parts/import.md | legacy migration |
| archive | parts/step-0.md -> parts/step-c.md (archive subroutine) | |
| validate | parts/step-0.md -> docs/config-schema.md | config-only |
| retry | parts/step-0.md -> parts/step-c.md (wave-dispatch subroutine) | |

## Codex host detection

If invoked via `/superpowers-masterplan:masterplan` (Codex host), set `codex.host=true` and load `parts/codex-host.md` before phase dispatch. Suppresses `codex:codex-rescue` companion dispatch to prevent recursion.

## Phase-prompt loader

After step-0.md completes bootstrap, route by verb. For start/resume/retry, load `parts/step-{state.yml.current_phase}.md`. The phase file is self-contained; it loads contracts on demand.

## Doctor entry point

For doctor verb: after step-0.md bootstrap, load `parts/doctor.md` and run all checks. Check #36 verifies this router stays <=20KB.

## Config reference

Schema documented in `docs/config-schema.md`. Loaded only on validate verb.

## Reserved verbs warning

The following verbs are reserved and will be rejected: full, brainstorm, plan, execute, retro, import, doctor, status, stats, clean, next.
