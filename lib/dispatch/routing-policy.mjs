// lib/dispatch/routing-policy.mjs — the fleet routing policy masterplan resolves against.
//
// Which document (defaultRoutingPolicyPath): MP_ROUTING_POLICY when set; otherwise the
// policy the fleet delivers to this host, `~/.pi/workflows/workflow-map.json` (rendered
// from the inference SOT by `inference reconfigure`); otherwise the checked-in copy
// `policy/workflow-map.json`, which exists only so masterplan runs on a host with no
// delivered policy. Reading the delivered map matters: Pi's spawn guard authorizes a
// model against that map's class chains, so a chain derived from any other copy (the
// finish gate's fallback reviewers, above all) is refused (R5-6). The routing-policy
// doctor check names the document it read and WARNs when an override diverges from
// the delivered map.
//
// Everything here is fail-closed: an unreadable/invalid policy or an unknown class
// (after the policy's own defaultClass) throws — a wave never launches on a guess.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../config.mjs';

// C1 is a distinct, model-free discovery surface. Legacy exports below remain for
// existing callers until the consumer cutover; they are never its fallback.
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (record, key) => Object.hasOwn(record, key);
function mapError(code, mapPath, message, cause) {
  return Object.assign(new Error(`dispatch map at ${mapPath}: ${message}`, { cause }), { code, path: mapPath });
}

/** Read C1 afresh at every call; marketplace hosts can be unconfigured. */
export function discoverDispatchMap({ host, env, homeDir = os.homedir(), readFile = fs.readFileSync } = {}) {
  const explicit = env ? owns(env, 'MP_DISPATCH_MAP') : readEnv('MP_DISPATCH_MAP') !== undefined;
  const override = env ? readEnv('MP_DISPATCH_MAP', env) : readEnv('MP_DISPATCH_MAP');
  const defaultPath = path.join(homeDir, '.pi', 'workflows', 'dispatch-map.json');
  if (explicit && (typeof override !== 'string' || !override.trim())) {
    throw mapError('MAP_PATH', override, 'explicit path must be a nonempty string');
  }
  const mapPath = explicit ? override : defaultPath;
  let raw;
  try { raw = readFile(mapPath, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT' && !explicit && host !== 'pi') {
      return { status: 'unconfigured', path: null, schema: null, policy: null };
    }
    throw mapError(error.code === 'ENOENT' ? (explicit ? 'EXPLICIT_MAP_MISSING' : 'PI_MAP_MISSING') : 'MAP_UNREADABLE', mapPath, error.message, error);
  }
  let source;
  try { source = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch (error) { throw mapError('MAP_JSON', mapPath, 'invalid JSON', error); }
  if (!isRecord(source) || source.schema !== 1) throw mapError('MAP_SCHEMA', mapPath, 'expected schema 1');
  // Do not spread the source: a spread would inspect its lists/model getter.
  const { defaultUsecase, usecases, agents, phases } = source;
  const invalid = (detail) => { throw mapError('MAP_INVALID', mapPath, detail); };
  if (!isRecord(usecases) || !isRecord(agents) || !isRecord(phases) ||
      typeof defaultUsecase !== 'string' || !owns(usecases, defaultUsecase)) invalid('missing default use case');
  const projected = Object.create(null);
  for (const [name, entry] of Object.entries(usecases)) {
    if (!isRecord(entry) || typeof entry.agent !== 'string' || !owns(agents, entry.agent) ||
        !['low', 'medium', 'high', 'xhigh'].includes(entry.effort) || !isRecord(entry.vocabulary)) {
      invalid(`invalid use case "${name}"`);
    }
    projected[name] = { agent: entry.agent, effort: entry.effort, vocabulary: { ...entry.vocabulary } };
  }
  if (!owns(agents, 'builder') || !owns(projected, 'bounded-edit') || projected['bounded-edit'].agent !== 'builder') invalid('bounded-edit must belong to builder');
  for (const [name, entry] of Object.entries(agents)) {
    if (!isRecord(entry) || typeof entry.defaultUsecase !== 'string' || !owns(projected, entry.defaultUsecase) ||
        projected[entry.defaultUsecase].agent !== name) invalid(`invalid agent "${name}" default use case`);
  }
  for (const [name, usecase] of Object.entries(phases)) {
    if (typeof usecase !== 'string' || !owns(projected, usecase)) invalid(`invalid phase "${name}"`);
  }
  return { status: 'configured', path: mapPath, schema: 1,
    policy: { schema: 1, defaultUsecase, usecases: projected, agents: Object.fromEntries(Object.entries(agents).map(([name, entry]) => [name, { defaultUsecase: entry.defaultUsecase }])), phases: { ...phases } } };
}

export function resolveUsecase(name, { policy }) {
  const key = name ?? policy.defaultUsecase;
  if (!Object.hasOwn(policy.usecases, key)) throw new Error(`dispatch map: unknown use case "${key}"`);
  const u = policy.usecases[key];
  return { usecase: key, agent: u.agent, requestedEffort: u.effort, vocabulary: { ...u.vocabulary } };
}

export function resolvePhase(name, { policy }) {
  if (!Object.hasOwn(policy.phases, name)) throw new Error(`dispatch map: unknown phase "${name}"`);
  return { phase: name, ...resolveUsecase(policy.phases[name], { policy }) };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const REPO_POLICY_PATH = path.join(REPO_ROOT, 'policy', 'workflow-map.json');

/** Where the fleet delivers the routing policy on a host. */
export function deliveredPolicyPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.pi', 'workflows', 'workflow-map.json');
}

/**
 * The policy document masterplan reads by default: MP_ROUTING_POLICY, else the
 * delivered map when it exists, else the checked-in copy.
 */
export function defaultRoutingPolicyPath({ env, homeDir = os.homedir(), exists = fs.existsSync } = {}) {
  const override = env ? readEnv('MP_ROUTING_POLICY', env) : readEnv('MP_ROUTING_POLICY');
  if (override) return override;
  const delivered = deliveredPolicyPath(homeDir);
  return exists(delivered) ? delivered : REPO_POLICY_PATH;
}

/**
 * Load + structurally validate a routing policy document.
 * @param {{ policyPath?: string }} [opts] override path (defaults to defaultRoutingPolicyPath())
 * @returns {object} parsed policy with lanes/classes/agents present
 */
export function loadRoutingPolicy({ policyPath = defaultRoutingPolicyPath() } = {}) {
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
  // Legacy injected policies may omit version/servedEquivalents, but a declared
  // version we cannot interpret or malformed new section must fail closed.
  if (policy.version !== undefined && policy.version !== 1) {
    throw new Error(`routing policy at ${policyPath} has unsupported version ${policy.version}`);
  }
  if (policy.servedEquivalents !== undefined &&
      (!policy.servedEquivalents || typeof policy.servedEquivalents !== 'object' || Array.isArray(policy.servedEquivalents))) {
    throw new Error(`routing policy at ${policyPath} has invalid servedEquivalents`);
  }
  // `tiers` is not required: the SOT retired it and nothing here reads it.
  for (const section of ['lanes', 'classes', 'agents']) {
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
 * The class primary may differ from its lane head; class.chain authorizes that primary.
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
    if (c.model !== undefined) {
      if (typeof c.model !== 'string' || c.model === '') {
        throw new Error(`routing policy: class "${name}" has an invalid model`);
      }
      if (!Array.isArray(c.chain) || c.chain[0] !== c.model) {
        throw new Error(`routing policy: class "${name}" model is not in its chain as the primary`);
      }
    }
    return {
      class: name,
      agent: c.agent,
      lane: c.lane,
      model: c.model ?? lane.model,
      chain: Array.isArray(c.chain) ? c.chain : [c.model ?? lane.model],
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
 * The finish-gate FALLBACK reviewer list (review-fallback).
 *
 * Derived from the SAME policy that resolves the primary, so no model id is ever
 * hardcoded here: the adversary class's `chain` in order, de-duplicated preserving
 * first occurrence, with the class's primary `model` excluded — a fallback must never
 * re-run the reviewer that just failed (or was refused by the fleet review circuit
 * breaker).
 *
 * The class's PANEL is deliberately NOT consulted. The fallback reviewer is dispatched
 * under the adversary class with its entry as an explicit model override, and Pi's spawn
 * guard authorizes an override only when it sits in the dispatched class's chain — so a
 * panel member outside the chain would be a guaranteed refusal, not a fallback. The list
 * is therefore exactly the chain minus the primary.
 *
 * Deliberately fail-SOFT at this seam, unlike resolveWorkClass: the finish gate must
 * never wedge on a routing-policy outage, so an unreadable/invalid policy or an
 * unresolvable adversary class returns an EMPTY list plus the recorded reason, and
 * the gate behaves exactly as it did before the fallback existed (skip-on-failure).
 * A `.masterplan.yaml` `adversary_review_fallback` list override replaces this list
 * entirely; `adversary_review_fallback: off` never calls this at all (lib/config.mjs).
 *
 * @param {{ policy?: object, policyPath?: string }} [opts] inject policy (tests) or override path
 * @returns {{ reviewers: string[], chain: string[], reason: string|null, primary: string|null }}
 */
export function adversaryFallbackReviewers({ policy, policyPath } = {}) {
  const unavailable = (e) => ({
    reviewers: [],
    chain: [],
    reason: `routing policy unavailable: ${e.message}`,
    primary: null,
  });
  let cls;
  try {
    const p = policy ?? loadRoutingPolicy(policyPath === undefined ? {} : { policyPath });
    cls = resolveWorkClass('adversary', { policy: p });
  } catch (e) {
    return unavailable(e);
  }
  const seen = new Set([cls.model]);
  const out = [];
  const push = (m) => {
    if (typeof m !== 'string' || m === '' || seen.has(m)) return;
    seen.add(m);
    out.push(m);
  };
  for (const m of (Array.isArray(cls.chain) ? cls.chain : [])) push(m);
  return {
    reviewers: out,
    // The authorization set an override must stay inside: the adversary class chain in
    // policy order, the primary INCLUDED (it is chain-authorized even though it is never
    // a derived fallback). Empty when the class declares no chain.
    chain: Array.isArray(cls.chain) ? [...cls.chain] : [],
    reason: out.length === 0
      ? `no fallback reviewers in the routing policy beyond the primary (${cls.model})`
      : null,
    primary: cls.model,
  };
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
