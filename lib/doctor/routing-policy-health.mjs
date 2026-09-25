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
// Injectable seams (tests): opts.policyPath (the document masterplan reads; default
// defaultRoutingPolicyPath), opts.livePath (the delivered map; default under
// opts.homeDir), opts.homeDir.
import fs from 'node:fs';
import path from 'node:path';
import { loadRoutingPolicy, resolvePanel, defaultRoutingPolicyPath, deliveredPolicyPath } from '../dispatch/routing-policy.mjs';
import { readEnv } from '../config.mjs';

const ID = 'routing-policy-health';
const FIX = 'redeliver the routing policy from the inference SOT (inference reconfigure), or fix MP_ROUTING_POLICY if it points at a stale copy';

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
  const homeDir = opts.homeDir ?? readEnv('HOME') ?? '';
  // The document masterplan actually resolves against, and the one the fleet
  // delivered (what Pi's spawn guard authorizes against).
  const policyPath = opts.policyPath ?? defaultRoutingPolicyPath({ homeDir });
  const livePath = opts.livePath ?? deliveredPolicyPath(homeDir);

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

  // 4. Drift between what masterplan reads and what the fleet delivered (WARN only).
  //    None when it reads the delivered map; absence of a delivered map is fine.
  let liveText = null;
  if (path.resolve(policyPath) !== path.resolve(livePath)) {
    try { liveText = fs.readFileSync(livePath, 'utf8'); } catch { /* absent → no drift check */ }
  }
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
        summary: `routing policy drift: masterplan reads ${policyPath}, which differs from the delivered ${livePath} — Pi's spawn guard authorizes against the delivered one`,
        fix: 'unset MP_ROUTING_POLICY (or point it at the delivered map) so masterplan reads what the fleet delivered',
      });
    }
  }

  if (findings.length) return findings;
  return [{ id: ID, severity: 'PASS', summary: `routing policy healthy at ${policyPath} (${Object.keys(policy.classes).length} classes, ${Object.keys(policy.lanes).length} lanes, adversarial panel cross-vendor)`, fix: null }];
}
