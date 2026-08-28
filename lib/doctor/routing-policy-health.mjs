// lib/doctor/routing-policy-health.mjs — doctor check for the routing policy masterplan
// resolves wave, planning-fanout, and review work against.
//
// The retired dispatch control plane used to be probed here (CLI on PATH, class
// resolution, backend health). That system is gone fleet-wide. Masterplan now
// resolves work classes against the repo-local routing policy
// (policy/workflow-map.json), so this check verifies THAT surface:
//   1. the repo copy loads and is structurally complete;
//   2. every class masterplan dispatches resolves to an agent role + lane model;
//   3. the adversarial panel resolves to >= 2 distinct lane models (cross-vendor review);
//   4. when a host-level generated policy exists (MP_ROUTING_POLICY or
//      ~/.pi/workflows/workflow-map.json), drift vs the repo copy is a WARN.
//
// Severity is WARN-not-FAIL across the board: adversary review is ADVISORY (a
// degraded policy degrades to a logged "inconclusive" verdict, it never wedges a
// run), so the doctor must never turn the whole run RED over it.
//
// Injectable seams (tests): opts.policyPath (repo copy override), opts.livePath
// (host artifact override), opts.homeDir.
import fs from 'node:fs';
import path from 'node:path';
import { loadRoutingPolicy, resolvePanel, REPO_POLICY_PATH } from '../dispatch/routing-policy.mjs';

const ID = 'routing-policy-health';
const FIX = 'regenerate the routing policy (node /srv/workflows/config/generate.mjs on a fleet host) and refresh policy/workflow-map.json';

/** The classes masterplan actually dispatches — each must resolve. */
const REQUIRED_CLASSES = [
  'adversary',          // per-task + finish-time adversarial review
  'critic',             // alignment-audit judgment
  'planned-execution',  // planning-fanout drafters (writes:false role)
  'bounded-edit',       // default implementation class
  'agentic-loop',       // iterate-until-green implementation
  'deep-investigation', // multi-hop investigation
];

export function check(repoRoot, opts = {}) {
  const policyPath = opts.policyPath ?? REPO_POLICY_PATH;
  const homeDir = opts.homeDir ?? process.env.HOME ?? '';
  const livePath = opts.livePath
    ?? process.env.MP_ROUTING_POLICY
    ?? path.join(homeDir, '.pi', 'workflows', 'workflow-map.json');

  // 1. Repo copy loads + is structurally complete.
  let policy;
  try {
    policy = loadRoutingPolicy({ policyPath });
  } catch (err) {
    return [{ id: ID, severity: 'WARN', summary: `routing policy unusable: ${err.message}`, fix: FIX }];
  }

  const findings = [];

  // 2. Every required class is present and resolves to a role + lane model.
  //    Deliberately NO defaultClass fallback here: a missing required class is
  //    exactly the drift this check exists to surface.
  for (const cls of REQUIRED_CLASSES) {
    const c = policy.classes?.[cls];
    if (!c) {
      findings.push({ id: ID, severity: 'WARN', summary: `routing policy: required class "${cls}" is missing`, fix: FIX });
      continue;
    }
    const agent = policy.agents?.[c.agent];
    const lane = policy.lanes?.[c.lane];
    if (!agent || !lane?.model) {
      findings.push({ id: ID, severity: 'WARN', summary: `routing policy: class "${cls}" references an unknown agent/lane`, fix: FIX });
    }
  }

  // 3. The adversarial panel is genuinely cross-vendor (>= 2 distinct models).
  try {
    const panel = resolvePanel('adversarial', { policy });
    const models = new Set(panel.members.map((m) => m.model));
    if (models.size < 2) {
      findings.push({ id: ID, severity: 'WARN', summary: 'routing policy: adversarial panel has < 2 distinct models — review would not be cross-vendor', fix: FIX });
    }
  } catch (err) {
    findings.push({ id: ID, severity: 'WARN', summary: `routing policy: adversarial panel unresolvable (${err.message})`, fix: FIX });
  }

  // 4. Host artifact drift (WARN only; absence is fine — the repo copy is authoritative).
  let liveText = null;
  try { liveText = fs.readFileSync(livePath, 'utf8'); } catch { /* absent → no drift check */ }
  if (liveText != null) {
    let drifted = true;
    try {
      drifted = JSON.stringify(JSON.parse(liveText)) !== JSON.stringify(policy);
    } catch {
      drifted = true; // unparseable host artifact counts as drift
    }
    if (drifted) {
      findings.push({
        id: ID,
        severity: 'WARN',
        summary: `routing policy drift: ${livePath} differs from the repo copy (${policyPath}) — masterplan still runs on the repo copy`,
        fix: 'refresh the repo copy from the fleet policy (or unset MP_ROUTING_POLICY if it points at a stale artifact)',
      });
    }
  }

  if (findings.length) return findings;
  return [{ id: ID, severity: 'PASS', summary: `routing policy healthy (${Object.keys(policy.classes).length} classes, ${Object.keys(policy.lanes).length} lanes, adversarial panel cross-vendor)`, fix: null }];
}
