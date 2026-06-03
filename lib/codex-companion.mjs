// lib/codex-companion.mjs — version-agnostic resolver for the codex-companion script.
//
// The codex plugin ships `scripts/codex-companion.mjs` inside its versioned cache dir
// (`<configDir>/plugins/cache/<marketplace>/codex/<version>/scripts/codex-companion.mjs`). The
// `<version>` segment moves with every plugin update, so the §2c finish-gate review must NOT
// hardcode it. The authoritative source for the *active* install is
// `<configDir>/plugins/installed_plugins.json`, whose `installPath` already encodes the live
// version as a real path segment — so we read that install record rather than scanning cache
// dirs by mtime or picking the highest version across them (both resolve a stale/inactive copy
// and break unit-test determinism).
//
// These two functions are PURE (object/string in, object/string out — no fs, no process): the
// file read + existence probe live in the `codex-companion-path` subcommand (bin is the sole
// fs/io boundary), mirroring how lib/finish.mjs stays pure behind `mp finish-status`.
import path from 'node:path';

// Select the active codex install record from a parsed installed_plugins.json object.
// Shape: { version, plugins: { "<name>@<marketplace>": [ {scope, installPath, version, ...} ] } }.
// Returns { key, installPath, version, scope } for the entry whose plugin name (the part before
// '@') is exactly 'codex' (case-insensitive) — stricter than the doctor's presence probe, which
// uses startsWith('codex'); here we want the literal codex plugin, not a 'codex-foo' sibling.
// Returns null when absent/malformed. Among multiple records (a multi-scope install) prefers
// scope 'user', else the first — deterministic, no fs.
export function selectCodexInstall(installedPlugins) {
  const plugins = installedPlugins?.plugins;
  if (!plugins || typeof plugins !== 'object') return null;
  let entryKey = null;
  for (const key of Object.keys(plugins)) {
    const name = String(key).split('@', 1)[0].toLowerCase();
    if (name === 'codex') { entryKey = key; break; }
  }
  if (!entryKey) return null;
  const recs = plugins[entryKey];
  if (!Array.isArray(recs) || recs.length === 0) return null;
  const pick = recs.find((r) => r && r.scope === 'user') ?? recs[0];
  if (!pick || typeof pick.installPath !== 'string' || pick.installPath === '') return null;
  return {
    key: entryKey,
    installPath: pick.installPath,
    version: typeof pick.version === 'string' && pick.version ? pick.version : null,
    scope: typeof pick.scope === 'string' && pick.scope ? pick.scope : null,
  };
}

// Derive the codex-companion script path from an install's installPath. Returns null for a
// missing/empty installPath. (Existence is the caller's concern — see the subcommand.)
export function companionScriptPath(installPath) {
  if (typeof installPath !== 'string' || installPath === '') return null;
  return path.join(installPath, 'scripts', 'codex-companion.mjs');
}
