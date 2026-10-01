// Model-free C1 discovery; no packaged policy, model projection or cache.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from '../config.mjs';

// C1 discovery projects intent only. Model selection belongs to the host.
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const owns = (record, key) => Object.hasOwn(record, key);
function mapError(code, mapPath, message, cause) {
  return Object.assign(new Error(`dispatch map at ${mapPath}: ${message}`, { cause }), { code, path: mapPath });
}

/** Read C1 afresh at every call; marketplace hosts can be unconfigured. */
export function discoverDispatchMap({ host, env, homeDir = os.homedir(), readFile = fs.readFileSync } = {}) {
  const retired = env ? readEnv('MP_ROUTING_POLICY', env) : readEnv('MP_ROUTING_POLICY');
  if (retired !== undefined) throw Object.assign(new Error('MP_ROUTING_POLICY retired; unset it and use MP_DISPATCH_MAP for C1 discovery; migrate model choices to inference routing'), { code: 'RETIRED_ROUTING_POLICY' });
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
