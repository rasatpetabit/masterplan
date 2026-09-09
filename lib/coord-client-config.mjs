// lib/coord-client-config.mjs — isolated client CONFIG seam for the recovery controller.
//
// SCOPE (first seam, deliberately narrow): resolve + validate the network coord client's
// credentials/CA configuration WITHOUT constructing any transport. There is NO
// transaction/journal design here and NO wiring into the controller yet — this module is
// the config half of the future network-client integration, and the injected factory is
// the deliberate seam where the transport will be attached.
//
// Design (names/contracts derived from the established coord-service client
// config reference, read-only):
//   1. Creds come from a FILE, not the process env: env COORD_CREDS_FILE points at a JSON
//      { baseUrl, tokenId, secret }. The HMAC secret never lands in process env / `ps`.
//   2. Discovery is a convenience for long-lived sessions: when the env keys are UNSET,
//      look under XDG_CONFIG_HOME (or home/.config) / coord-service / creds.json and
//      ca.pem. EXPLICIT env entries — including an intentional empty string — always win;
//      no silent discovery over an explicit override.
//   3. Scoped CA trust: env COORD_TLS_CA (a PEM path) is passed THROUGH to the injected
//      transport/client factory so only the coord client trusts the private fabric CA.
//      This module NEVER mutates process.env and NEVER disables global TLS trust.
//   4. FAIL CLOSED: network mode is explicit opt-in. A creds file that is set-but-unreadable,
//      malformed, or missing/invalid baseUrl/tokenId/secret, a non-HTTPS baseUrl, or an
//      unreadable/empty CA file THROWS — never a silent local fallback.
//   5. No production default factory in this isolated seam: buildCoordClient requires an
//      injected createClient when network config is present. A caller that requests network
//      mode without injecting one gets an explicit throw (coord_client_factory_unresolved),
//      never a fabricated "success". Secrets are never echoed into error messages.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEnv } from './config.mjs';

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

/** HTTPS baseUrl validation. Returns an error string, or null when valid. */
function validateHttpsBaseUrl(value) {
  if (!nonEmptyString(value)) return 'must be a non-empty string';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return 'is not a valid URL';
  }
  if (parsed.protocol !== 'https:') return 'must use the https: protocol';
  return null;
}

/**
 * Discover provisioned coord client path env without reading secret contents.
 * Explicit env entries (including intentional empty string) always win; discovery only
 * fills UNSET keys. Never mutates the caller's env — returns a shallow copy.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {{ home?: string, pathExists?: (p:string)=>boolean }} [seams]
 * @returns {NodeJS.ProcessEnv}
 */
export function applyCoordPathAutodiscover(baseEnv = process.env, seams = {}) {
  const env = { ...baseEnv };
  const pathExists = seams.pathExists ?? existsSync;
  const home = seams.home ?? homedir();
  const configHome = readEnv('XDG_CONFIG_HOME', env) || join(home, '.config');
  const coordDir = join(configHome, 'coord-service');

  // Presence (including an intentional empty string) is authoritative; readEnv is
  // used so the env names stay on the documented seam. Discovery fills only UNSET keys.
  if (readEnv('COORD_CREDS_FILE', env) === undefined && !Object.prototype.hasOwnProperty.call(env, 'COORD_CREDS_FILE')) {
    const creds = join(coordDir, 'creds.json');
    if (pathExists(creds)) env.COORD_CREDS_FILE = creds;
  }
  if (readEnv('COORD_TLS_CA', env) === undefined && !Object.prototype.hasOwnProperty.call(env, 'COORD_TLS_CA')) {
    const ca = join(coordDir, 'ca.pem');
    if (pathExists(ca)) env.COORD_TLS_CA = ca;
  }
  return env;
}

/**
 * Resolve the coord client configuration from the environment, or null when unconfigured.
 * Applies path autodiscovery (explicit env wins over discovery). Pure apart from the
 * injected readFile/pathExists seams.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]          — defaults to process.env
 * @param {(p:string)=>string} [opts.readFile]    — defaults to readFileSync utf8
 * @param {(p:string)=>boolean} [opts.pathExists] — defaults to existsSync
 * @param {string} [opts.home]         — defaults to homedir()
 * @returns {null | { baseUrl:string, tokenId:string, secret:string, ca:string|null, caPath:string|null }}
 * @throws coord_creds_unreadable / coord_creds_invalid / coord_ca_unreadable / coord_ca_empty
 */
export function resolveCoordClientConfig({
  env = process.env,
  readFile = (p) => readFileSync(p, 'utf8'),
  pathExists = existsSync,
  home = homedir(),
} = {}) {
  const resolved = applyCoordPathAutodiscover(env, { pathExists, home });
  const credsFile = readEnv('COORD_CREDS_FILE', resolved);
  if (!credsFile) return null; // unconfigured → network mode not requested

  let creds;
  try {
    creds = JSON.parse(readFile(credsFile));
  } catch {
    const e = new Error(`COORD_CREDS_FILE is set (${credsFile}) but the creds file is unreadable/invalid`);
    e.code = 'coord_creds_unreadable';
    throw e;
  }

  const baseUrl = creds?.baseUrl;
  const tokenId = creds?.tokenId;
  const secret = creds?.secret;
  const problems = [];
  const baseUrlErr = validateHttpsBaseUrl(baseUrl);
  if (baseUrlErr) problems.push(`baseUrl ${baseUrlErr}`);
  if (!nonEmptyString(tokenId)) problems.push('tokenId must be a non-empty string');
  if (!nonEmptyString(secret)) problems.push('secret must be a non-empty string');
  if (problems.length) {
    // Field names only — never values (the secret must not surface in an error).
    const e = new Error(`COORD_CREDS_FILE ${credsFile} is invalid — ${problems.join('; ')}`);
    e.code = 'coord_creds_invalid';
    throw e;
  }

  const caPath = readEnv('COORD_TLS_CA', resolved) || null;
  let ca = null;
  if (caPath) {
    try {
      ca = readFile(caPath);
    } catch (err) {
      const e = new Error(`COORD_TLS_CA is set (${caPath}) but unreadable: ${err.message}`);
      e.code = 'coord_ca_unreadable';
      throw e;
    }
    // caPath presence is authoritative: the operator asked for scoped CA trust, so a
    // readable-but-empty PEM is a misconfigured mount, NOT a silent fall-through to
    // ambient trust. Fail loud rather than hand a transport an empty CA.
    if (!ca || !ca.trim()) {
      const e = new Error(`COORD_TLS_CA is set (${caPath}) but the file is empty`);
      e.code = 'coord_ca_empty';
      throw e;
    }
  }

  return { baseUrl, tokenId, secret, ca, caPath };
}

/**
 * Build the network coord client from configuration via the injected factory seam, or
 * null when unconfigured. The transport/client factory receives the validated config
 * (including the scoped CA PEM + path) and is responsible for constructing its own
 * scoped transport — this module never mutates process.env and never disables global TLS.
 *
 * FAIL CLOSED on the unresolved default: network config present but no createClient
 * injected → explicit throw (coord_client_factory_unresolved), never a success/null that
 * the caller could mistake for a configured client.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]
 * @param {(p:string)=>string} [opts.readFile]
 * @param {(p:string)=>boolean} [opts.pathExists]
 * @param {string} [opts.home]
 * @param {(cfg:{baseUrl:string,tokenId:string,secret:string,ca:string|null,caPath:string|null})=>object} [opts.createClient]
 * @returns {null | object}
 */
export function buildCoordClient({
  env = process.env,
  readFile = (p) => readFileSync(p, 'utf8'),
  pathExists = existsSync,
  home = homedir(),
  createClient,
} = {}) {
  const cfg = resolveCoordClientConfig({ env, readFile, pathExists, home });
  if (!cfg) return null; // network mode not requested → caller keeps its non-network path

  if (typeof createClient !== 'function') {
    const e = new Error('network coord config is present but no client factory was injected — refusing to fabricate a client; wire the transport seam first');
    e.code = 'coord_client_factory_unresolved';
    throw e;
  }

  return createClient({
    baseUrl: cfg.baseUrl,
    tokenId: cfg.tokenId,
    secret: cfg.secret,
    ca: cfg.ca,
    caPath: cfg.caPath,
  });
}
