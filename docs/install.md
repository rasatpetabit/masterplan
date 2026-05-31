# Install — manual, desktop, and advanced paths

The default path is the three-line slash-command incantation in [`README.md`](../README.md#install). This file covers the cases where that doesn't fit: Claude Desktop, manual filesystem install, the Codex CLI chat-mode invocation surface, and the optional telemetry Stop hook.

## Claude Desktop (Code tab)

This is a Claude Code plugin, so use the **Code** tab in the desktop app, not regular Chat. Start a Local or SSH coding session against the repository you want `/masterplan` to manage, then:

1. Click the **+** button next to the prompt box.
2. Choose **Plugins** → **Add plugin**.
3. If `rasatpetabit-masterplan` is not listed yet, add this repository as a marketplace from the plugin manager's **Marketplaces** tab, or paste the marketplace command into the prompt.
4. Install `masterplan`. Use **User scope** to enable it across all projects, **Project scope** to share it via this repository's `.claude/settings.json`, or **Local scope** for the current repo only.
5. Run `/reload-plugins` or restart the session.
6. Verify: type `/` or open **+** → **Slash commands** and look for `/masterplan`. If another command shares the name, use the namespaced form `/masterplan:masterplan`.

The desktop plugin browser only shows plugins from configured marketplaces, so the marketplace-add step is required even when the install command itself runs from the chat UI.

## Claude manual install (no marketplace)

If the marketplace path is unavailable (offline host, locked-down account, custom packaging), install a thin shim that delegates to the plugin once it's loaded by other means:

```bash
mkdir -p ~/.claude/commands ~/.claude/skills
printf '%s\n' \
  '---' \
  'description: "Delegate to the installed masterplan plugin."' \
  '---' \
  '<!-- masterplan-shim: v3 -->' \
  '/masterplan:masterplan $ARGUMENTS' \
  > ~/.claude/commands/masterplan.md
cp -r skills/masterplan-detect ~/.claude/skills/
```

The shim makes `/masterplan` resolve to the namespaced plugin command once the plugin itself is available; the `masterplan-detect` skill auto-suggests `/masterplan import` when legacy planning artifacts are found.

## Codex CLI invocation

The marketplace add command installs the plugin and registers a `masterplan` skill that new Codex sessions see in their available-skills list. That skill is the portable Codex entrypoint: it loads `commands/masterplan.md` and recognizes run bundles created by any host under `docs/masterplan/<slug>/`.

Invoke masterplan in Codex with a normal chat message — **do not use Codex shell-command mode** for these examples:

```text
Use masterplan status for this repo
Use masterplan next
Use masterplan full Stripe webhook handler
Use masterplan execute docs/masterplan/auth-refactor/state.yml
```

Slash-style text (`/masterplan` or `/masterplan:masterplan`) is accepted when the host passes it to the model, but the chat-message form is the portable resume instruction. `$masterplan ...` is **not** portable — Codex shell-command mode sends it to Bash where `$masterplan` is an environment-variable expansion.

If your Codex build registers the marketplace but a fresh prompt does not list `masterplan`, enable `masterplan@rasatpetabit-masterplan` in Codex's plugin UI/config, or install a user-level bridge at `~/.codex/skills/masterplan/SKILL.md` from this repo's `skills/masterplan/` directory.

When running inside Codex, masterplan disables the separate Claude Code `codex:codex-rescue` companion path for that invocation to avoid recursive Codex-on-Codex dispatch; persisted `codex.routing` / `codex.review` settings remain unchanged for future Claude Code runs.

Full Codex-host behavior differences and suppression rules live in the Codex entrypoint skill ([`skills/masterplan/SKILL.md`](../skills/masterplan/SKILL.md)) and the orchestrator's §0 host-detect + Codex tool-adaptation rules in [`commands/masterplan.md`](../commands/masterplan.md).

## Dependencies

- **Required:** [`superpowers`](https://github.com/obra/superpowers) — auto-resolved when installed via the marketplace catalog.
- **Optional:** `codex` plugin for `codex:codex-rescue` execution and `codex:review` cross-model review.
- **Optional:** `context7` MCP for library-doc lookups during CD-4 recovery ladders.
- **Optional:** `gh` CLI for GitHub issue/PR import (`/masterplan import --pr=...`) and retro PR lookup.

If dependency resolution reports `superpowers@claude-plugins-official` missing, refresh the official marketplace with `/plugin marketplace update claude-plugins-official`, or add it with `/plugin marketplace add anthropics/claude-plugins-official`, then retry the install.

## Optional telemetry Stop hook

`/masterplan` can append per-turn telemetry to `docs/masterplan/<slug>/telemetry.jsonl` and per-subagent cost records to `docs/masterplan/<slug>/subagents.jsonl`. These sidecars are local-only: the hook and command add ignore patterns to `.git/info/exclude` before writing, and this repository's `.gitignore` ignores its own generated telemetry.

Install the Stop hook:

```bash
mkdir -p ~/.claude/hooks
cp hooks/masterplan-telemetry.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/masterplan-telemetry.sh
```

Wire it into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash \"$HOME/.claude/hooks/masterplan-telemetry.sh\"",
            "timeout": 3,
            "async": true
          }
        ]
      }
    ]
  }
}
```

The hook bails silently outside `/masterplan`-managed plans. Per-plan opt-out: add `telemetry: off` to `state.yml`. Field-by-field signal definitions and `jq` queries: [`docs/design/telemetry-signals.md`](./design/telemetry-signals.md).

## Verifying the install

After install:

```text
/masterplan
```

With no arguments, this opens the intake picker: it lists any in-progress run bundles, or — when none exist — prompts for a new topic. If the command isn't found, run `/plugin` and confirm `masterplan` appears under **Installed**; if it doesn't, the marketplace add and install steps need to be re-run in order.
