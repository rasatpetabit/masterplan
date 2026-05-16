# E2E tests for `/masterplan`

These tests invoke `claude --print` against fixture inputs and assert on output
substrings. They are the only layer of the test suite that exercises the full
orchestrator (commands/masterplan.md + plugin loading + Claude Code routing) as
a black box.

## Opt-in: these cost real money

```
make test-e2e        # runs the suite (requires CLAUDE_E2E=1)
CLAUDE_E2E=1 bash tests/e2e/run.sh
```

`make test` and `make test-static` do NOT run these — they're held back to keep
the regular pre-commit loop free of API spend.

Per-test cost is typically $0.20–$1.00 under Sonnet (the default). The runner
caps each invocation with `--max-budget-usd` (default 3.00) and timeouts at 8
minutes.

**Why Sonnet, not Haiku.** Haiku 4.5 trips autocompact thrash on the
orchestrator's initial context load (commands/masterplan.md is ~2150 lines and
fans out into the `parts/` tree). Sonnet handles it cleanly. The runner
default is `sonnet`; you can override via `CLAUDE_E2E_MODEL=opus` if a test
needs deeper reasoning.

## Tuning knobs

| Env var              | Default | Purpose                              |
|----------------------|---------|--------------------------------------|
| `CLAUDE_E2E`         | `0`     | Set to `1` to actually run.          |
| `CLAUDE_E2E_MODEL`   | `haiku` | Model for the test invocation.       |
| `CLAUDE_E2E_BUDGET`  | `3.00`  | Per-test max USD.                    |
| `CLAUDE_E2E_TIMEOUT` | `300`   | Per-test timeout in seconds.         |

## Per-fixture layout

```
tests/e2e/<name>/
  prompt.txt   — input passed to `claude --print` (the slash command + args)
  golden.grep  — newline-separated substrings that MUST appear in output
                 (lines starting with `#` are comments)
  cwd/         — (optional) isolated working dir; runner cd's into it before
                 invoking claude. Prevents the orchestrator's resume-first
                 controller from picking up unrelated run bundles in the
                 outer repo.
  setup.sh     — (optional) executed in cwd/ before the run
```

The runner asserts that every non-blank, non-comment line in `golden.grep`
appears as a substring (fixed-string match) somewhere in the invocation's
combined stdout+stderr.

## Why substring matching, not equality

Model output is non-deterministic — the orchestrator may add reasoning, narrate
intermediate steps, or word things differently across runs. Substring matching
keeps tests resilient to cosmetic drift while still catching real regressions
(missing sentinels, wrong routing, broken markdown).

The trade-off: tests can pass even when the orchestrator does extra unintended
work. Mitigate by writing _negative_ assertions too — see the (planned) future
`golden.deny` mechanism.

## Current fixtures

| Fixture            | What it asserts                                      |
|--------------------|------------------------------------------------------|
| `version-sentinel` | `/masterplan` (no verb) emits the version sentinel  |
|                    | as the first line. Catches plugin-load breakage,    |
|                    | Step 0 router breakage, and vUNKNOWN regressions.   |
