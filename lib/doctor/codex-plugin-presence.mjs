// lib/doctor/codex-plugin-presence.mjs — v8 doctor check (ports v7 #18, codex plugin presence).
//
// Hybrid check: plan-scoped (reads bundle state to find codex config) + user-scoped (reads
// host path to probe plugin presence). SKIP when no bundle requests codex. If any bundle
// wants codex but the plugin is absent → WARN.
//
// "Wants codex" detection (defensive, handles both v8 flat and legacy-ish codex object shapes):
//   routing = state.codex?.routing ?? state.codex_routing   (not missing + not 'off')
//   review  = state.codex?.review  ?? state.codex_review    (=== true or === 'on')
//
// Plugin presence probe (opts.homeDir):
//   PRESENT if: <homeDir>/.codex/ dir exists, OR
//               <homeDir>/.claude/plugins/installed_plugins.json has an entry starting 'codex'
//
// Returns ≥1 finding. SKIP when no bundles exist, or no bundle requests codex. WARN when
// bundles want codex but plugin is absent. PASS when plugin present and bundles want it.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';

const ID = 'codex-plugin-presence';

function wantsCodex(state) {
  // Handle both inline codex object and flat keys.
  const codexObj = (state.codex && typeof state.codex === 'object') ? state.codex : null;
  const routing = codexObj?.routing ?? state.codex_routing;
  const review = codexObj?.review ?? state.codex_review;
  const routingOn = routing !== undefined && routing !== null && routing !== 'off';
  const reviewOn = review === true || review === 'on';
  return routingOn || reviewOn;
}

function probePlugin(homeDir) {
  // Check ~/.codex/ dir
  try {
    if (fs.statSync(path.join(homeDir, '.codex')).isDirectory()) return true;
  } catch { /* absent */ }
  // Check installed_plugins.json for a codex entry
  try {
    const installed = JSON.parse(
      fs.readFileSync(path.join(homeDir, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')
    );
    const plugins = installed?.plugins ?? {};
    for (const key of Object.keys(plugins)) {
      if (key.toLowerCase().startsWith('codex')) return true;
    }
  } catch { /* absent */ }
  return false;
}

export function check(repoRoot, opts = {}) {
  const homeDir = opts.homeDir ?? os.homedir();
  const runsDir = resolveRunsDir(repoRoot, {});

  let slugs;
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }
  if (slugs.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }

  const wantingCodex = [];
  for (const slug of slugs) {
    let state;
    try {
      state = parseState(fs.readFileSync(bundleArtifacts(repoRoot, slug, {}).state, 'utf8'));
    } catch {
      continue;
    }
    if (wantsCodex(state)) wantingCodex.push(slug);
  }

  if (wantingCodex.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no bundle uses codex (routing off / review off)', fix: null }];
  }

  const present = probePlugin(homeDir);
  if (!present) {
    return [{
      id: ID, severity: 'WARN',
      summary: `codex plugin absent but bundle(s) request it: ${wantingCodex.join(', ')} — codex dispatch will fail`,
      fix: 'install codex: `/plugin marketplace add openai/codex-plugin-cc` then `/plugin install codex@openai-codex`, OR set codex_routing: off and codex_review: false in affected bundles',
    }];
  }

  return [{ id: ID, severity: 'PASS', summary: `codex plugin present; ${wantingCodex.length} bundle(s) use it`, fix: null }];
}
