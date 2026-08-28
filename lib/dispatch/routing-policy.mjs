// lib/dispatch/routing-policy.mjs — repo-local routing policy + optional host override.
//
// The fleet's retired dispatch control plane used to resolve work classes by
// shelling out to its CLI. That system is gone fleet-wide. Masterplan now resolves
// work classes against the CHECKED-IN canonical copy of the fleet workflow routing
// policy (`policy/workflow-map.json` — generated from the fleet routing.yaml by
// /srv/workflows/config/generate.mjs), so the suite is hermetic and masterplan runs
// on hosts with no fleet policy at all.
//
// Host override (optional, never required): MP_ROUTING_POLICY=<path> — e.g. the live
// generated `~/.pi/workflows/workflow-map.json`. Drift between repo copy and live
// policy is a doctor WARN (routing-policy-health), never a test failure.
//
// Everything here is fail-closed: an unreadable/invalid policy or an unknown class
// (after the policy's own defaultClass) throws — a wave never launches on a guess.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_POLICY_PATH = path.join(REPO_ROOT, 'policy', 'workflow-map.json');

/**
 * Load + structurally validate a routing policy document.
 * @param {{ policyPath?: string }} [opts] override path (defaults to MP_ROUTING_POLICY, then repo copy)
 * @returns {object} parsed policy with lanes/classes/agents/tiers present
 */
export function loadRoutingPolicy({ policyPath = process.env.MP_ROUTING_POLICY || REPO_POLICY_PATH } = {}) {
  let text;
  try {
    text = fs.readFileSync(policyPath, 'utf8');
  } catch (e) {
    throw new Error(`routing policy unreadable at ${policyPath}: ${e.message}`);
  }
  let policy;
  try {
    policy = JSON.parse(text);
  } catch (e) {
    throw new Error(`routing policy at ${policyPath} is not valid JSON: ${e.message}`);
  }
  for (const section of ['lanes', 'classes', 'agents', 'tiers']) {
    if (!policy[section] || typeof policy[section] !== 'object' || Array.isArray(policy[section])) {
      throw new Error(`routing policy at ${policyPath} is missing the ${section} section`);
    }
  }
  return policy;
}

/**
 * Resolve a work class to its governed routing record.
 * Falls back to the policy's workflow.defaultClass for unknown names, then fails closed.
 *
 * @param {string} taskClass
 * @param {{ policy?: object, policyPath?: string }} [opts] inject policy (tests) or override path
 * @returns {{ class, agent, lane, model, chain, cap, effort, writes, tier, intent, panel?, fallback? }}
 */
export function resolveWorkClass(taskClass, { policy, policyPath } = {}) {
  const p = policy ?? loadRoutingPolicy(policyPath === undefined ? {} : { policyPath });
  const resolve = (name) => {
    const c = p.classes?.[name];
    if (!c) return null;
    const agent = p.agents?.[c.agent];
    if (!agent) throw new Error(`routing policy: class "${name}" references unknown agent "${c.agent}"`);
    const lane = p.lanes?.[c.lane];
    if (!lane || !lane.model) throw new Error(`routing policy: class "${name}" references lane "${c.lane}" with no model`);
    return {
      class: name,
      agent: c.agent,
      lane: c.lane,
      model: lane.model,
      chain: Array.isArray(c.chain) ? c.chain : [lane.model],
      cap: c.cap ?? 'chat',
      effort: c.effort ?? 'high',
      writes: agent.writes === true,
      tier: agent.tier ?? 'medium',
      intent: c.intent ?? '',
      ...(c.panel ? { panel: c.panel } : {}),
      ...(c.fallback ? { fallback: c.fallback } : {}),
    };
  };
  const direct = resolve(taskClass);
  if (direct) return direct;
  const defaultClass = p.workflow?.defaultClass;
  if (defaultClass && defaultClass !== taskClass) {
    const viaDefault = resolve(defaultClass);
    if (viaDefault) return viaDefault;
  }
  throw new Error(`routing policy: unknown work class "${taskClass}" (and no resolvable defaultClass)`);
}

/**
 * Resolve a lane name to its model record ({model, ctx, cost, fallback, chain}).
 */
export function resolveLane(lane, { policy, policyPath } = {}) {
  const p = policy ?? loadRoutingPolicy(policyPath === undefined ? {} : { policyPath });
  const l = p.lanes?.[lane];
  if (!l || !l.model) throw new Error(`routing policy: unknown lane "${lane}"`);
  return l;
}

/**
 * Resolve a panel name to its member records ({members:[{lane,model}], quorum, intent}).
 */
export function resolvePanel(name, { policy, policyPath } = {}) {
  const p = policy ?? loadRoutingPolicy(policyPath === undefined ? {} : { policyPath });
  const panel = p.panels?.[name];
  if (!panel || !Array.isArray(panel.members) || panel.members.length === 0) {
    throw new Error(`routing policy: unknown or empty panel "${name}"`);
  }
  return panel;
}

/**
 * Alias → model map for every lane (used by register-pi-agents to derive the
 * live-alias map instead of hard-coding model ids).
 */
export function laneAliasMap({ policy, policyPath } = {}) {
  const p = policy ?? loadRoutingPolicy(policyPath === undefined ? {} : { policyPath });
  const out = {};
  for (const [name, lane] of Object.entries(p.lanes)) {
    if (lane && lane.model) out[name] = lane.model;
  }
  return out;
}
