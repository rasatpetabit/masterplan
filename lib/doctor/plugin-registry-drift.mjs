// lib/doctor/plugin-registry-drift.mjs — v8 doctor check (ports v7 #50, plugin registry drift).
//
// User-scoped: compares the installed masterplan plugin version against the marketplace-cached
// version. Version mismatch means Claude Code is silently running an older build — new features
// (doctor checks, breadcrumbs, telemetry fixes) are invisible at runtime.
//
// Installed: <homeDir>/.claude/plugins/installed_plugins.json
//   key: plugins["masterplan@rasatpetabit-masterplan"][0].version
// Marketplace: <homeDir>/.claude/plugins/marketplaces/rasatpetabit-masterplan/.claude-plugin/plugin.json
//   key: version
//
// Version mismatch → WARN. SKIP if either file is absent or the masterplan entry is not found.
// opts.homeDir is injectable for tests.
//
// Decision: version-string comparison only (no gitCommitSha vs git rev-parse check). The sha
// comparison needs gitExec against the marketplace clone, which is out of scope for a pure
// homeDir-file check. The version-string catch covers the primary regression case (v7 #50's
// primary symptom: running v5.8.3 while marketplace shipped v6.x).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ID = 'plugin-registry-drift';
const PLUGIN_KEY = 'masterplan@rasatpetabit-masterplan';

export function check(repoRoot, opts = {}) {
  const homeDir = opts.homeDir ?? os.homedir();
  const installedPath = path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json');
  const marketplacePath = path.join(
    homeDir, '.claude', 'plugins', 'marketplaces', 'rasatpetabit-masterplan', '.claude-plugin', 'plugin.json'
  );

  let installed;
  try {
    installed = JSON.parse(fs.readFileSync(installedPath, 'utf8'));
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'installed_plugins.json absent — skipping plugin registry drift check', fix: null }];
  }

  const entry = installed?.plugins?.[PLUGIN_KEY]?.[0];
  if (!entry) {
    return [{ id: ID, severity: 'SKIP', summary: `masterplan not found in installed_plugins.json (key: ${PLUGIN_KEY})`, fix: null }];
  }

  let marketplace;
  try {
    marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'marketplace plugin.json absent — skipping registry drift check', fix: null }];
  }

  const installedVersion = entry.version ?? '';
  const marketplaceVersion = marketplace.version ?? '';

  if (!installedVersion || !marketplaceVersion) {
    return [{ id: ID, severity: 'SKIP', summary: 'one or both version fields are empty — cannot compare', fix: null }];
  }

  if (installedVersion !== marketplaceVersion) {
    return [{
      id: ID, severity: 'WARN',
      summary: `installed masterplan v${installedVersion} != marketplace v${marketplaceVersion} — run /plugin update`,
      fix: 'run `/plugin update masterplan` then `/reload-plugins` to sync the runtime cache with the marketplace version',
    }];
  }

  return [{ id: ID, severity: 'PASS', summary: `installed masterplan v${installedVersion} matches marketplace`, fix: null }];
}
