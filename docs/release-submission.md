# Claude Plugin Directory Submission

Release target: `superpowers-masterplan` v3.2.0.

## Official submission path

Anthropic's current plugin directory submission docs say:

- The repository must be public.
- Run `claude plugin validate` before submitting.
- Submit either a GitHub link or a zip file through one of the in-app forms:
  - Claude.ai: <https://claude.ai/settings/plugins/submit>
  - Console: <https://platform.claude.com/plugins/submit>
- Anthropic Verified is an additional quality and safety review. Submission to
  the directory does not guarantee the badge.

## Current package state

- Public repo: <https://github.com/rasatpetabit/superpowers-masterplan>
- Claude plugin manifest: `.claude-plugin/plugin.json`
- Claude marketplace catalog: `.claude-plugin/marketplace.json`
- Codex plugin manifest: `.codex-plugin/plugin.json`
- Codex marketplace catalog: `.agents/plugins/marketplace.json`
- Codex marketplace plugin path: `plugins/superpowers-masterplan -> ..`
- Independent install path:

```text
/plugin marketplace add rasatpetabit/superpowers-masterplan
/plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan
/reload-plugins
```

Codex install path:

```bash
codex plugin marketplace add rasatpetabit/superpowers-masterplan
```

Portable Codex invocation:

```text
/superpowers-masterplan:masterplan
```

Codex host behavior: when invoked inside Codex, the orchestrator suppresses the
separate Claude Code `codex:codex-rescue` companion routing/review path for that
invocation to avoid recursive Codex dispatch. Persisted routing/review config is
unchanged for future Claude Code runs.

## Submission form copy

Plugin name: `superpowers-masterplan`

Short description:

> Brainstorm, plan, execute, resume, import, lint, and retrospect long-running
> Claude Code work with durable run bundles and strict context control.

Long description:

> superpowers-masterplan adds a `/masterplan` workflow on top of the official
> Superpowers plugin. It turns large coding efforts into durable specs, plans,
> run bundles, worktrees, activity logs, resume points, doctor checks,
> automatic retrospectives, and safe legacy-state cleanup so long-running work
> survives compaction, restarts, and agent handoff. It also supports optional
> Codex routing/review from Claude Code, Codex-native marketplace packaging with
> recursion-safe host behavior, read-only parallel verification waves, legacy
> plan import, model-dispatch guardrails, and an opt-in telemetry hook with
> per-subagent cost records.

Why it should be considered for Anthropic Verified:

> The plugin is source-visible, validates with `claude plugin validate`, has no
> bundled MCP servers or secret-handling code, declares its dependency on the
> official `superpowers` plugin, keeps optional integrations explicit, and is
> designed around conservative status persistence, user-owned worktree
> protection, and verification-before-completion guardrails.

Repository URL: <https://github.com/rasatpetabit/superpowers-masterplan>

Homepage URL: <https://github.com/rasatpetabit/superpowers-masterplan#readme>

Category suggestion: development workflow / coding.

## Pre-submit verification

Run from the repository root after committing the current release changes:

```bash
claude plugin validate .
claude plugin validate .claude-plugin/plugin.json
jq empty .claude-plugin/plugin.json .claude-plugin/marketplace.json .codex-plugin/plugin.json .agents/plugins/marketplace.json .claude/settings.local.json
bash -n hooks/masterplan-telemetry.sh
git diff --check
claude plugin tag --dry-run .
```

Clean install smoke, isolated from the real Claude plugin cache:

```bash
tmp_home=$(mktemp -d)
HOME="$tmp_home" CLAUDE_CODE_PLUGIN_CACHE_DIR="$tmp_home/plugin-cache" \
  claude plugin marketplace add https://github.com/anthropics/claude-plugins-official.git --scope user
HOME="$tmp_home" CLAUDE_CODE_PLUGIN_CACHE_DIR="$tmp_home/plugin-cache" \
  claude plugin marketplace add ./ --scope user
HOME="$tmp_home" CLAUDE_CODE_PLUGIN_CACHE_DIR="$tmp_home/plugin-cache" \
  claude plugin install superpowers-masterplan@rasatpetabit-superpowers-masterplan --scope user
```

The official submission form is an authenticated external action; submit it from
the account that should own future directory updates.
