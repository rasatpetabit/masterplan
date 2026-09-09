// test/coord-client-config.test.mjs — isolated client CONFIG seam tests.
//
// Covers the first config seam only (no transaction/journal design):
//   - Path autodiscovery under XDG_CONFIG_HOME / home/.config/coord-service, explicit
//     env (including intentional empty) always wins over discovery, env never mutated.
//   - Fail-closed validation: unreadable/malformed/incomplete creds, non-HTTPS baseUrl,
//     unreadable/empty CA — all throw, never a silent local fallback.
//   - Injected client factory receives the validated scoped CA; missing factory with
//     network config present throws coord_client_factory_unresolved (never success).
//   - Secrets never appear in errors or results.
//
// All paths are injected temp dirs — no real host config, no live service writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyCoordPathAutodiscover,
  resolveCoordClientConfig,
  buildCoordClient,
} from '../lib/coord-client-config.mjs';

function tmpdir(prefix = 'mp-coord-config-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const VALID_CREDS = JSON.stringify({ baseUrl: 'https://coord.example', tokenId: 'tok-1', secret: 's3cr3t-value' });
test('malformed credentials and read errors cannot leak credential contents', () => {
  const sentinel = 'malformed-credential-secret-sentinel';
  for (const readFile of [
    () => `${sentinel} invalid JSON`,
    () => { throw new Error(sentinel); },
  ]) {
    assert.throws(() => resolveCoordClientConfig({
      env: { COORD_CREDS_FILE: '/test/creds.json', COORD_TLS_CA: '' },
      home: '/nonexistent-home', pathExists: () => false, readFile,
    }), error => {
      assert.equal(error.code, 'coord_creds_unreadable');
      assert.equal(String(error.stack).includes(sentinel), false);
      return true;
    });
  }
});

const CA_PEM = '-----BEGIN CERTIFICATE-----\nZm9vYmFy\n-----END CERTIFICATE-----\n';

// makeDir helper returning a coord-service dir inside an XDG_CONFIG_HOME temp root.
function coordConfigRoot() {
  const root = tmpdir();
  const coordDir = path.join(root, 'coord-service');
  fs.mkdirSync(coordDir, { recursive: true });
  return { root, coordDir };
}

test('coord-config: discovers creds + CA from XDG_CONFIG_HOME/coord-service when env unset', () => {
  const { root, coordDir } = coordConfigRoot();
  writeFile(coordDir, 'creds.json', VALID_CREDS);
  writeFile(coordDir, 'ca.pem', CA_PEM);

  const env = applyCoordPathAutodiscover({ XDG_CONFIG_HOME: root }, { pathExists: fs.existsSync, home: '/nonexistent-home' });
  assert.equal(env.COORD_CREDS_FILE, path.join(coordDir, 'creds.json'));
  assert.equal(env.COORD_TLS_CA, path.join(coordDir, 'ca.pem'));

  const cfg = resolveCoordClientConfig({
    env: { XDG_CONFIG_HOME: root },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    pathExists: fs.existsSync,
    home: '/nonexistent-home',
  });
  assert.equal(cfg.baseUrl, 'https://coord.example');
  assert.equal(cfg.tokenId, 'tok-1');
  assert.equal(cfg.secret, 's3cr3t-value');
  assert.equal(cfg.ca, CA_PEM);
  assert.equal(cfg.caPath, path.join(coordDir, 'ca.pem'));
});

test('coord-config: discovers from home/.config/coord-service when XDG_CONFIG_HOME unset', () => {
  const home = tmpdir('mp-home-');
  const coordDir = path.join(home, '.config', 'coord-service');
  writeFile(coordDir, 'creds.json', VALID_CREDS);

  const env = applyCoordPathAutodiscover({}, { pathExists: fs.existsSync, home });
  assert.equal(env.COORD_CREDS_FILE, path.join(coordDir, 'creds.json'));
  // No CA on disk → COORD_TLS_CA stays unset (ambient trust allowed only when NOT requested).
  assert.equal(env.COORD_TLS_CA, undefined);
});

test('coord-config: explicit env wins over discovery; explicit empty stays explicit (no silent discovery)', () => {
  const { root } = coordConfigRoot();
  const explicitCreds = path.join(root, 'creds.json');
  writeFile(path.dirname(explicitCreds), 'creds.json', VALID_CREDS);

  // Explicit non-empty wins over a discovery-eligible file.
  let env = applyCoordPathAutodiscover({ XDG_CONFIG_HOME: root, COORD_CREDS_FILE: explicitCreds });
  assert.equal(env.COORD_CREDS_FILE, explicitCreds);

  // Explicit empty string is authoritative: discovery must NOT silently fill it.
  const emptyEnv = { XDG_CONFIG_HOME: root, COORD_CREDS_FILE: '', COORD_TLS_CA: '' };
  env = applyCoordPathAutodiscover(emptyEnv, { pathExists: fs.existsSync, home: '/nonexistent-home' });
  assert.equal(env.COORD_CREDS_FILE, '');
  assert.equal(env.COORD_TLS_CA, '');

  // And resolve treats an explicit-empty creds key as unconfigured (network mode off) —
  // it does not reach into the discovery-eligible file.
  const cfg = resolveCoordClientConfig({
    env: emptyEnv,
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    pathExists: fs.existsSync,
    home: '/nonexistent-home',
  });
  assert.equal(cfg, null);
});

test('coord-config: never mutates the caller env (autodiscover returns a copy)', () => {
  const original = {};
  const result = applyCoordPathAutodiscover(original, { pathExists: () => true, home: '/nonexistent-home' });
  assert.notEqual(result, original);
  assert.deepEqual(original, {});
});

test('coord-config: unconfigured (no creds) resolves null', () => {
  const cfg = resolveCoordClientConfig({ env: {}, pathExists: () => false, home: '/nonexistent-home' });
  assert.equal(cfg, null);
});

test('coord-config: explicit creds path that is unreadable throws coord_creds_unreadable', () => {
  const missing = path.join(tmpdir(), 'missing.json');
  assert.throws(
    () => resolveCoordClientConfig({
      env: { COORD_CREDS_FILE: missing },
      readFile: (p) => fs.readFileSync(p, 'utf8'),
      pathExists: () => true,
      home: '/nonexistent-home',
    }),
    (e) => e.code === 'coord_creds_unreadable',
  );
});

test('coord-config: malformed creds JSON throws coord_creds_unreadable', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  fs.writeFileSync(creds, '{not json');
  assert.throws(
    () => resolveCoordClientConfig({ env: { COORD_CREDS_FILE: creds }, readFile: (p) => fs.readFileSync(p, 'utf8'), pathExists: () => false, home: '/nonexistent-home' }),
    (e) => e.code === 'coord_creds_unreadable',
  );
});

test('coord-config: non-HTTPS baseUrl fails closed with coord_creds_invalid', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  fs.writeFileSync(creds, JSON.stringify({ baseUrl: 'http://coord.example', tokenId: 'tok-1', secret: 's' }));
  assert.throws(
    () => resolveCoordClientConfig({ env: { COORD_CREDS_FILE: creds }, readFile: (p) => fs.readFileSync(p, 'utf8'), pathExists: () => false, home: '/nonexistent-home' }),
    (e) => e.code === 'coord_creds_invalid' && /https:/.test(e.message),
  );
});

test('coord-config: missing/invalid tokenId or secret throws coord_creds_invalid', () => {
  const dir = tmpdir();
  for (const credsObj of [
    { baseUrl: 'https://coord.example', tokenId: '', secret: 's' },
    { baseUrl: 'https://coord.example', secret: 's' },
    { baseUrl: 'https://coord.example', tokenId: 'tok-1', secret: '   ' },
    { baseUrl: 'https://coord.example', tokenId: 'tok-1' },
  ]) {
    const creds = path.join(dir, `creds-${Math.random()}.json`);
    fs.writeFileSync(creds, JSON.stringify(credsObj));
    assert.throws(
      () => resolveCoordClientConfig({ env: { COORD_CREDS_FILE: creds }, readFile: (p) => fs.readFileSync(p, 'utf8'), pathExists: () => false, home: '/nonexistent-home' }),
      (e) => e.code === 'coord_creds_invalid',
      `expected coord_creds_invalid for ${JSON.stringify(credsObj)}`,
    );
  }
});

test('coord-config: unreadable CA throws coord_ca_unreadable', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  const ca = path.join(dir, 'missing-ca.pem');
  fs.writeFileSync(creds, VALID_CREDS);
  assert.throws(
    () => resolveCoordClientConfig({ env: { COORD_CREDS_FILE: creds, COORD_TLS_CA: ca }, readFile: (p) => fs.readFileSync(p, 'utf8'), pathExists: () => false, home: '/nonexistent-home' }),
    (e) => e.code === 'coord_ca_unreadable',
  );
});

test('coord-config: empty CA file throws coord_ca_empty (no silent fallthrough)', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  const ca = path.join(dir, 'ca.pem');
  fs.writeFileSync(creds, VALID_CREDS);
  fs.writeFileSync(ca, '   \n  ');
  assert.throws(
    () => resolveCoordClientConfig({ env: { COORD_CREDS_FILE: creds, COORD_TLS_CA: ca }, readFile: (p) => fs.readFileSync(p, 'utf8'), pathExists: () => false, home: '/nonexistent-home' }),
    (e) => e.code === 'coord_ca_empty',
  );
});

test('coord-config: errors never leak the secret value', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  const ca = path.join(dir, 'ca.pem');
  const badCreds = path.join(dir, 'bad-creds.json');
  fs.writeFileSync(creds, VALID_CREDS);
  fs.writeFileSync(ca, CA_PEM);
  // Force a validation failure AFTER a valid creds parse (invalid baseUrl) in a SEPARATE
  // file, then assert the secret string never appears in the error message.
  fs.writeFileSync(badCreds, JSON.stringify({ baseUrl: 'not a url', tokenId: 'tok-1', secret: 's3cr3t-value' }));
  let thrown;
  try {
    resolveCoordClientConfig({ env: { COORD_CREDS_FILE: badCreds, COORD_TLS_CA: ca }, readFile: (p) => fs.readFileSync(p, 'utf8'), pathExists: () => false, home: '/nonexistent-home' });
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown, 'expected a throw');
  assert.ok(!thrown.message.includes('s3cr3t-value'), `secret leaked in error: ${thrown.message}`);

  // The valid creds file is untouched: the resolved result carries the secret (needed by
  // the client), but error paths above never echo the secret value.
  const cfg = resolveCoordClientConfig({
    env: { COORD_CREDS_FILE: creds, COORD_TLS_CA: ca },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    pathExists: () => false,
    home: '/nonexistent-home',
  });
  assert.equal(cfg.secret, 's3cr3t-value');
});

test('coord-config: buildCoordClient injects validated config (incl. scoped CA) into factory', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  const ca = path.join(dir, 'ca.pem');
  fs.writeFileSync(creds, VALID_CREDS);
  fs.writeFileSync(ca, CA_PEM);

  let received;
  const client = buildCoordClient({
    env: { COORD_CREDS_FILE: creds, COORD_TLS_CA: ca },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    pathExists: () => false,
    home: '/nonexistent-home',
    createClient: (cfg) => {
      received = cfg;
      return { ok: true };
    },
  });
  assert.deepEqual(client, { ok: true });
  assert.equal(received.baseUrl, 'https://coord.example');
  assert.equal(received.tokenId, 'tok-1');
  assert.equal(received.secret, 's3cr3t-value');
  assert.equal(received.ca, CA_PEM);
  assert.equal(received.caPath, ca);
});

test('coord-config: no CA configured → factory receives ca/caPath null', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  fs.writeFileSync(creds, VALID_CREDS);

  // Hermetic: pathExists=false + nonexistent home so the autodiscover seam never reaches
  // the real host ~/.config/coord-service (this host has a live fabric CA there).
  let received;
  buildCoordClient({
    env: { COORD_CREDS_FILE: creds },
    readFile: (p) => fs.readFileSync(p, 'utf8'),
    pathExists: () => false,
    home: '/nonexistent-home',
    createClient: (cfg) => {
      received = cfg;
      return { ok: true };
    },
  });
  assert.equal(received.ca, null);
  assert.equal(received.caPath, null);
});

test('coord-config: unconfigured buildCoordClient returns null (non-network path)', () => {
  const result = buildCoordClient({ env: {}, pathExists: () => false, home: '/nonexistent-home', createClient: () => ({ ok: true }) });
  assert.equal(result, null);
});

test('coord-config: network config present without injected factory throws coord_client_factory_unresolved', () => {
  const dir = tmpdir();
  const creds = path.join(dir, 'creds.json');
  fs.writeFileSync(creds, VALID_CREDS);
  assert.throws(
    () => buildCoordClient({ env: { COORD_CREDS_FILE: creds }, readFile: (p) => fs.readFileSync(p, 'utf8'), pathExists: () => false, home: '/nonexistent-home' }),
    (e) => e.code === 'coord_client_factory_unresolved',
  );
});
