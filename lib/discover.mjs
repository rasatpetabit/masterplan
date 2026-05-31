import { readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveRunsDir } from './paths.mjs';

// Returns absolute paths to every <runsDir>/<slug>/state.yml.
export function discoverBundles(repoRoot, env = process.env) {
  const runsDir = resolveRunsDir(repoRoot, env);
  if (!existsSync(runsDir)) return [];
  const out = [];
  for (const entry of readdirSync(runsDir)) {
    const candidate = path.join(runsDir, entry, 'state.yml');
    if (existsSync(candidate) && statSync(candidate).isFile()) out.push(candidate);
  }
  return out.sort();
}
