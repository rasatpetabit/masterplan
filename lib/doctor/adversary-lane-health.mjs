// lib/doctor/adversary-lane-health.mjs — host-scoped doctor check for the adversary review lane.
//
// The finish-time + per-task adversary review routes through the agent-dispatch control plane
// (`agent-dispatch review --class adversary`). This check verifies that lane is usable on THIS host:
//   1. `agent-dispatch` resolves on PATH,
//   2. `agent-dispatch resolve --class adversary` exits 0 and names a route, and
//   3. that route's backend reports healthy.
//
// Severity is WARN-not-FAIL across the board: adversary review is ADVISORY (a missing/unhealthy lane
// degrades to a logged "inconclusive" verdict, it never wedges a run), so the doctor must never turn
// the whole run RED over it. Host-scoped: it ignores repoRoot and does NOT scan run bundles (the old
// per-bundle codex-plugin-presence wantsCodex scan is gone — review is host-config, not per-bundle).
//
// PROBE SEAM (opts.probe): the live probe shells `agent-dispatch`; tests inject a canned probe (the
// same injectable-seam pattern as opts.homeDir / opts.now elsewhere) so the check is deterministic
// without the real binary. A probe returns:
//   { onPath: bool, resolves: bool, route: string|null, healthy: bool|null, detail: string|null }
import { execFileSync } from 'node:child_process';

const ID = 'adversary-lane-health';

function liveProbe() {
  // 1. on PATH?
  try {
    execFileSync('agent-dispatch', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { onPath: false, resolves: false, route: null, healthy: null, detail: null };
    // present but errored on --version — treat as on-PATH-but-broken (resolves will catch specifics)
  }
  // 2. resolve the adversary lane
  let route = null;
  try {
    const out = String(execFileSync('agent-dispatch', ['resolve', '--class', 'adversary'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    route = out || null;
  } catch {
    return { onPath: true, resolves: false, route: null, healthy: null, detail: null };
  }
  if (!route) return { onPath: true, resolves: false, route: null, healthy: null, detail: 'empty resolve output' };
  // 3. backend health — best-effort; an unknown health is treated as healthy (advisory lane).
  let healthy = true;
  let detail = null;
  try {
    const h = String(execFileSync('agent-dispatch', ['health', '--class', 'adversary'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    if (/\b(unhealthy|down|unavailable|error)\b/i.test(h)) { healthy = false; detail = h; }
  } catch { /* no health subcommand / probe failure → leave healthy:true (advisory) */ }
  return { onPath: true, resolves: true, route, healthy, detail };
}

export function check(repoRoot, opts = {}) {
  const probe = typeof opts.probe === 'function' ? opts.probe : liveProbe;
  const r = probe() ?? {};

  if (!r.onPath) {
    return [{
      id: ID, severity: 'WARN',
      summary: 'agent-dispatch not on PATH — adversary review will degrade to "inconclusive" (advisory)',
      fix: 'install/expose the `agent-dispatch` CLI so `agent-dispatch review --class adversary` can run; until then finish-time and per-task reviews log an inconclusive verdict and proceed',
    }];
  }
  if (!r.resolves) {
    return [{
      id: ID, severity: 'WARN',
      summary: `agent-dispatch present but \`resolve --class adversary\` failed${r.detail ? ` (${r.detail})` : ''} — no adversary route`,
      fix: 'check the dispatch policy: `agent-dispatch resolve --class adversary` must exit 0 with a route; review degrades to inconclusive until it does',
    }];
  }
  if (r.healthy === false) {
    return [{
      id: ID, severity: 'WARN',
      summary: `adversary lane resolves (${r.route}) but its backend is unhealthy${r.detail ? `: ${r.detail}` : ''} — review may degrade to inconclusive`,
      fix: 'check the adversary backend health (`agent-dispatch health --class adversary`); review is advisory, so this never blocks a run',
    }];
  }
  return [{ id: ID, severity: 'PASS', summary: `adversary lane healthy (route: ${r.route})`, fix: null }];
}
