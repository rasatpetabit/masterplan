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
// Same-version stale cache (Codex #1): when the version strings MATCH, we additionally compare
// the installed entry's gitCommitSha against the marketplace clone's git HEAD. A patch committed
// to the marketplace without a version bump leaves the runtime cache stale while version-compare
// still reads PASS — the exact deploy-pipeline failure mode (dev clone != marketplace clone !=
// runtime cache). When the recorded commit differs from marketplace HEAD → WARN.
//
// This REVERSES the original "version-string only" scoping decision. It is now in scope because
// (a) installed_plugins.json reliably records gitCommitSha and (b) the marketplace dir is a real
// git clone, so the compare is cheap and degrades gracefully. The git read is guarded: the default
// gitExec runs `git rev-parse HEAD` ONLY when a `.git` lives directly in the marketplace dir (so
// it never walks up into an unrelated ancestor repo — e.g. when homeDir is a test fixture nested
// inside this repo). Any git failure, a missing `.git`, or a missing gitCommitSha falls through to
// the version-only result. opts.gitExec is injectable for tests; the auto-discovery fixture
// harness passes no gitExec, so committed fixtures exercise the version-only path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ID = 'plugin-registry-drift';
const PLUGIN_KEY = 'masterplan@rasatpetabit-masterplan';

// Default git reader: returns marketplace HEAD sha, but ONLY when a `.git` lives directly in the
// marketplace dir (prevents git from resolving an ancestor repo). Any failure → null → the caller
// degrades gracefully to version-only comparison.
function defaultGitExec(marketplaceDir) {
  if (!fs.existsSync(path.join(marketplaceDir, '.git'))) return null;
  try {
    return execFileSync('git', ['-C', marketplaceDir, 'rev-parse', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

const shortSha = (s) => (s.length > 9 ? s.slice(0, 9) : s);

// Prefix-tolerant, case-insensitive: a recorded sha may be short (e.g. 7-char) vs a full 40-char HEAD.
function shaMatch(a, b) {
  const x = a.toLowerCase(), y = b.toLowerCase();
  if (Math.min(x.length, y.length) < 7) return x === y;
  return x === y || x.startsWith(y) || y.startsWith(x);
}

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

  // Versions match — guard against a same-version stale cache (Codex #1). Compare the commit the
  // runtime was installed from (entry.gitCommitSha) against the marketplace clone's current HEAD.
  const gitExec = opts.gitExec ?? defaultGitExec;
  const recordedSha = typeof entry.gitCommitSha === 'string' ? entry.gitCommitSha.trim() : '';
  const marketplaceDir = path.dirname(path.dirname(marketplacePath));
  let headSha = '';
  try {
    headSha = (gitExec(marketplaceDir) ?? '').trim();
  } catch {
    headSha = '';
  }
  if (recordedSha && headSha && !shaMatch(recordedSha, headSha)) {
    return [{
      id: ID, severity: 'WARN',
      summary: `installed masterplan v${installedVersion} matches marketplace version but was installed from commit ${shortSha(recordedSha)} while marketplace HEAD is ${shortSha(headSha)} — runtime cache is stale`,
      fix: 'run `/plugin update masterplan` then `/reload-plugins` to rebuild the runtime cache from marketplace HEAD',
    }];
  }

  return [{ id: ID, severity: 'PASS', summary: `installed masterplan v${installedVersion} matches marketplace`, fix: null }];
}
