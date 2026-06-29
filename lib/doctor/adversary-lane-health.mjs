// lib/doctor/adversary-lane-health.mjs — host-scoped doctor check for the adversary review lane.
//
// The finish-time + per-task adversary review routes through the agent-dispatch control plane
// (`agent-dispatch review --class adversary`). This check verifies that lane is usable on THIS host:
//   1. `agent-dispatch` resolves on PATH,
//   2. `agent-dispatch resolve --class adversary` exits 0 and names a route, and
//   3. that route's backend reports healthy.
//
// When `resolve` itself fails (e.g. the gateway backend is DOWN so the chain exhausts with a
// non-zero exit), the route+backend never materialize, and a bare "resolve failed" WARN loses the
// actionable signal (which backend is down?). In that case we fall back to the configured class
// chain — read via `agent-dispatch where` -> `policy/dispatch-policy.jsonc` — and probe each backend's
// health directly so the WARN can name the sick backend ("dispatch-gateway reports unhealthy").
//
// Severity is WARN-not-FAIL across the board: adversary review is ADVISORY (a missing/unhealthy lane
// degrades to a logged "inconclusive" verdict, it never wedges a run), so the doctor must never turn
// the whole run RED over it. Host-scoped: it ignores repoRoot and does NOT scan run bundles (the old
// per-bundle codex-plugin-presence wantsCodex scan is gone — review is host-config, not per-bundle).
//
// PROBE SEAM (opts.probe): the live probe shells `agent-dispatch`; tests inject a canned probe (the
// same injectable-seam pattern as opts.homeDir / opts.now elsewhere) so the check is deterministic
// without the real binary. A probe returns:
//   { onPath: bool, resolves: bool, route: string|null, healthy: bool|null, detail: string|null,
//     // optional, only surfaced when resolves:false but a backend was still identifiable
//     unhealthyBackends?: string[] | null }
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ID = 'adversary-lane-health';

// `agent-dispatch where` prints the agent-dispatch repo root (holds policy/dispatch-policy.jsonc).
// Returns null if the CLI is absent or the lookup fails (the onPath/resolves probes will surface
// the broader WARN; the fallback just becomes a no-op).
function agentDispatchRoot() {
  try {
    return String(execFileSync('agent-dispatch', ['where'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim() || null;
  } catch {
    return null;
  }
}

// Read the configured backends for the `adversary` class from dispatch-policy.jsonc in the
// agent-dispatch repo root. Thin fs wrapper around the pure `parseConfiguredBackends`. Returns []
// on any fs/lookup failure (the doctor's primary `resolve`-based path is the authoritative probe;
// this is only the fallback naming path).
function readConfiguredBackends(repoRoot) {
  if (!repoRoot) return [];
  const policyPath = path.join(repoRoot, 'policy', 'dispatch-policy.jsonc');
  let text;
  try { text = fs.readFileSync(policyPath, 'utf8'); } catch { return []; }
  return parseConfiguredBackends(text);
}

// Pure: parse `agent-dispatch resolve --class adversary` stdout into
//   { ok: bool, backend: string|null, route: string|null, reason: 'chain_exhausted'|'escalate'|'budget_breach'|'no_route'|'unresolved'|'no_backend'|'empty'|'non_json'|null }
// Treats EVERY failure shape as unresolved: thrown-exit (caller handles), bare failure token on
// stdout (chain_exhausted/etc), JSON with no backend, JSON whose decision/status/reason is a known
// failure. Only a JSON record carrying a `backend` is a real resolved route. Exported for unit tests.
export function parseResolveOutput(rawOut) {
  const out = (rawOut ?? '').trim();
  if (!out) return { ok: false, backend: null, route: null, reason: 'empty' };
  // Try JSON first — the modern CLI prints a decision record.
  try {
    const d = JSON.parse(out);
    if (d && typeof d === 'object') {
      const backend = d.backend ?? null;
      const route = d.route || d.provider || d.backend || null;
      const decision = String(d.decision ?? d.status ?? d.reason ?? '').toLowerCase();
      if (/^(chain_exhausted|escalate|budget_breach|no_route|unresolved)$/i.test(decision)) {
        return { ok: false, backend, route: null, reason: decision };
      }
      if (!backend) return { ok: false, backend: null, route: null, reason: 'no_backend' };
      return { ok: true, backend, route: route || backend, reason: null };
    }
  } catch { /* not JSON — fall through */ }
  // Non-JSON. A bare failure token (chain_exhausted, …) means unresolved; anything else is a legacy
  // bare-string route label, which we treat as unresolved-without-backend so the fallback can fire
  // (the old behavior of treating it as a PASS-with-unknown-route was the silent no-op the audit
  // found).
  if (/^(chain_exhausted|escalate|budget_breach|no_route|unresolved)$/i.test(out)) {
    return { ok: false, backend: null, route: null, reason: out.toLowerCase() };
  }
  return { ok: false, backend: null, route: out, reason: 'non_json' };
}

// Pure: parse dispatch-policy.jsonc (JSONC — strip line/block comments + trailing commas) and
// return the configured backend chain for the `adversary` class (deduped, order-preserving).
// Exported for unit tests. Returns [] on any parse failure.
export function parseConfiguredBackends(policyText) {
  if (!policyText) return [];
  const stripped = String(policyText)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([\}\]])/g, '$1');
  let policy;
  try { policy = JSON.parse(stripped); } catch { return []; }
  const classes = policy?.classes ?? policy?.classChains ?? {};
  const adv = classes?.adversary;
  if (!adv) return [];
  const chain = Array.isArray(adv) ? adv : (adv?.chain ?? []);
  const backends = [];
  for (const step of chain) {
    if (step && typeof step === 'object' && typeof step.backend === 'string') {
      backends.push(step.backend);
    }
  }
  return [...new Set(backends)];
}

// Probe one backend's health via `agent-dispatch health <backend>` (POSITIONAL backend; NOT --class).
// `health <backend>` prints {backend,healthy:bool,…} with exit 0 regardless of healthy state (the
// signal lives in the JSON body); a non-JSON or throwing probe is treated as unknown (healthy:true,
// detail:null — the advisory lane must never false-alarm on a probe hiccup).
function probeBackendHealth(backend) {
  try {
    const out = String(execFileSync('agent-dispatch', ['health', backend], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    let h = null;
    try { h = JSON.parse(out); } catch { /* non-JSON health output */ }
    if (h && typeof h === 'object') {
      if (h.healthy === false) return { healthy: false, detail: `${backend} reports unhealthy` };
      return { healthy: true, detail: null };
    }
    if (/\b(unhealthy|down|unavailable|error)\b/i.test(out)) {
      return { healthy: false, detail: out };
    }
    return { healthy: true, detail: null };
  } catch {
    return { healthy: true, detail: null }; // probe failure → advisory (don't false-alarm)
  }
}

function liveProbe() {
  // 1. on PATH?
  try {
    execFileSync('agent-dispatch', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) {
    if (e && e.code === 'ENOENT') return { onPath: false, resolves: false, route: null, healthy: null, detail: null };
    // present but errored on --version — treat as on-PATH-but-broken (resolves will catch specifics)
  }
  // 2. resolve the adversary lane. `resolve` prints a JSON decision record
  //    ({decision,backend,capability,provider,route,…}); when the backend chain is DOWN, `resolve`
  //    is flaky — it may THROW (non-zero exit) OR emit a bare failure token (chain_exhausted,
  //    escalate, …) on stdout with exit 0 OR JSON with no backend. parseResolveOutput unifies all
  //    failure shapes; on any of them we fall through to the configured-backend fallback so the
  //    WARN can name the sick backend instead of a generic "resolve failed".
  let route = null;
  let backend = null;
  let resolveFailed = false;
  let resolveReason = null;
  try {
    const out = String(execFileSync('agent-dispatch', ['resolve', '--class', 'adversary'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })).trim();
    const parsed = parseResolveOutput(out);
    if (parsed.ok) {
      backend = parsed.backend;
      route = parsed.route;
    } else {
      resolveFailed = true;
      resolveReason = parsed.reason;
      route = parsed.route; // may hold a legacy label; backend stays null
    }
  } catch {
    // resolve threw (non-zero exit; e.g. the gateway backend is DOWN so the chain exhausts).
    resolveFailed = true;
    resolveReason = 'threw';
  }
  // 3. backend health — best-effort; an unknown health is treated as healthy (advisory lane).
  //    `health` takes a POSITIONAL backend name (NOT --class), so probe the backend that
  //    resolve named. `health <backend>` prints {backend,healthy:bool,…}; a `healthy:false`
  //    is the real unhealthy signal the old `--class` invocation could never reach.
  let healthy = true;
  let detail = null;
  if (backend) {
    const h = probeBackendHealth(backend);
    healthy = h.healthy;
    detail = h.detail;
  }
  if (resolveFailed) {
    // resolve threw OR returned a failure token → we don't have a usable route/backend from it.
    // Probe the *configured* backends (via the policy file) to surface a specific
    // "<backend> reports unhealthy" WARN. The detail carries the resolve failure reason so the
    // operator knows why resolve didn't already name the backend.
    const backends = readConfiguredBackends(agentDispatchRoot());
    const unhealthy = [];
    for (const b of backends) {
      const h = probeBackendHealth(b);
      if (h.healthy === false) unhealthy.push(b);
    }
    const reasonTag = resolveReason && resolveReason !== 'threw' ? `resolve ${resolveReason}` : 'resolve --class adversary exhausted';
    return {
      onPath: true, resolves: false,
      route: backends.length ? backends.join('|') : route,
      healthy: unhealthy.length ? false : null, // null (unknown) — don't false-alarm
      detail: unhealthy.length ? `${unhealthy.join(', ')} reports unhealthy (${reasonTag})` : null,
      unhealthyBackends: unhealthy.length ? unhealthy : null,
    };
  }
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
    // When the probe named a sick backend (resolve threw → fallback path probed configured
    // backends), surface the specific "<backend> reports unhealthy" WARN the audit claimed; only
    // fall back to the generic "resolve failed" WARN when no backend could be identified.
    if (r.unhealthyBackends && r.unhealthyBackends.length) {
      const reasonTag = (r.detail && /\((.+?)\)$/.test(r.detail))
        ? r.detail.match(/\((.+?)\)$/)[1]
        : '`resolve --class adversary` exhausted';
      return [{
        id: ID, severity: 'WARN',
        summary: `adversary lane backend unhealthy: ${r.unhealthyBackends.join(', ')} reports unhealthy (${reasonTag}) — review may degrade to inconclusive`,
        fix: `proceed (advisory — review logs inconclusive and continues); to restore the lane: \`agent-dispatch health ${r.unhealthyBackends[0]}\` to inspect, restart the backend, then \`agent-dispatch resolve --class adversary\` should exit 0 with a route`,
      }];
    }
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
      fix: 'check the adversary backend health (`agent-dispatch health <backend>`, e.g. `agent-dispatch health dispatch-gateway`); review is advisory, so this never blocks a run',
    }];
  }
  return [{ id: ID, severity: 'PASS', summary: `adversary lane healthy (route: ${r.route})`, fix: null }];
}
