// lib/paths.mjs — single source of truth for filesystem locations (build step 1).
//
// Replaces the scattered hardcoded `~/.claude` and `docs/masterplan` path sites in v7.
// Pure and env-driven: every function takes its environment (`env`, `home`) as optional
// injected args so it is unit-testable with no real filesystem or process state.
import os from 'node:os';
import path from 'node:path';

// The marketplace plugin-name this package ships under (constant across install accounts).
const MARKETPLACE_NAME = 'rasatpetabit-masterplan';
const MASTERPLAN_BIN = 'bin/masterplan.mjs';

// Expand a leading `~` / `~/` to the home directory; leave everything else untouched.
export function expandTilde(p, home = os.homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

// Claude config root: $CLAUDE_CONFIG_DIR if set (and non-blank), else ~/.claude.
export function resolveConfigDir(env = process.env, home = os.homedir()) {
  const override = (env.CLAUDE_CONFIG_DIR ?? '').trim();
  const raw = override !== '' ? override : path.join(home, '.claude');
  return expandTilde(raw, home);
}

// Resolve the installed masterplan.mjs CLI path — the marketplace install under
// <claudeConfigDir>/plugins/marketplaces/<MARKETPLACE_NAME>/bin/masterplan.mjs. Portable across
// accounts (uses resolveConfigDir so $CLAUDE_CONFIG_DIR is honored; homeDir injectable for tests).
// Override via $MP_BIN (absolute path to the bin) or $MP_MARKETPLACE_DIR (the marketplace dir).
// Returns the resolved path string (no disk probe — the caller's spawn() surfaces ENOENT loudly
// if the install is absent, which is the right failure mode for an unwired escalation seam).
export function resolveMasterplanBin(env = process.env, home = os.homedir()) {
  const mpBin = (env.MP_BIN ?? '').trim();
  if (mpBin !== '') return path.isAbsolute(mpBin) ? mpBin : path.join(home, mpBin);
  const mpMarketplaceDir = (env.MP_MARKETPLACE_DIR ?? '').trim();
  const dir = mpMarketplaceDir !== ''
    ? (path.isAbsolute(mpMarketplaceDir) ? mpMarketplaceDir : path.join(home, mpMarketplaceDir))
    : path.join(resolveConfigDir(env, home), 'plugins', 'marketplaces', MARKETPLACE_NAME);
  return path.join(dir, MASTERPLAN_BIN);
}

// Run-bundle root: $MASTERPLAN_RUNS_DIR if set (absolute kept as-is, relative joined to
// the repo root), else <repoRoot>/docs/masterplan.
export function resolveRunsDir(repoRoot, env = process.env) {
  const override = (env.MASTERPLAN_RUNS_DIR ?? '').trim();
  const raw = override !== '' ? override : 'docs/masterplan';
  return path.isAbsolute(raw) ? raw : path.join(repoRoot, raw);
}

export function resolveBundleDir(repoRoot, slug, env = process.env) {
  return path.join(resolveRunsDir(repoRoot, env), slug);
}

export function resolveStatePath(repoRoot, slug, env = process.env) {
  return path.join(resolveBundleDir(repoRoot, slug, env), 'state.yml');
}

// Compute the path for an ephemeral (out-of-tree) bundle dir so followers can work in a
// temporary location without touching the tracked docs/masterplan/ tree.  The `tmpBase`
// defaults to os.tmpdir() but is injectable for unit-testing (so no real filesystem access
// occurs in tests).  Delegates to resolveBundleDir with an empty env so that a caller's
// MASTERPLAN_RUNS_DIR — which is meaningful only for the lead's canonical bundle — never
// overrides an ephemeral path.
export function resolveEphemeralBundleDir(slug, tmpBase = os.tmpdir()) {
  return resolveBundleDir(tmpBase, slug, {});
}

// All files that may live inside a run bundle, resolved under its dir.
export function bundleArtifacts(repoRoot, slug, env = process.env) {
  const dir = resolveBundleDir(repoRoot, slug, env);
  const at = (name) => path.join(dir, name);
  return {
    dir,
    state: at('state.yml'),
    spec: at('spec.md'),
    plan: at('plan.md'),
    planIndex: at('plan.index.json'),
    planHtml: at('plan.html'),
    retro: at('retro.md'),
    events: at('events.jsonl'),
    handoff: at('handoff.md'),
  };
}
