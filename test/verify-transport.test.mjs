// test/verify-transport.test.mjs — handoff contract + verify allowlist record.
//
// Covers the pinned contract version and the per-wave verify-allowlist record
// evidence surfaced by the native spawn flow. The local full-list runner was
// removed with the retired dispatch-era transport; wave children verify
// through the harness and report worker digests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SKYNET_VERIFY_ALLOWLIST,
  CONTRACT_VERSION,
} from '../lib/dispatch/verify-transport.mjs';
import { dispatchWaveViaFabric, readWaveDispatchRecord } from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { writeState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';

test('CONTRACT_VERSION is the native fabric seam version', () => {
  assert.equal(CONTRACT_VERSION, 'fabric-native-v1');
});

// ---------------------------------------------------------------------------
// Allowlist record evidence (surfaced once per wave by the native spawn flow)
// ---------------------------------------------------------------------------

import { execFileSync } from 'node:child_process';
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
const write = (base, rel, content) => {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

function makeFabricFixture({ verify_commands = [] } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-vtrans-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 't@t');
  git(MAIN, 'config', 'user.name', 't');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'init');
  const slug = 'vtrans';
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  const tasks = [{ id: 1, status: 'pending', wave: 0, files: ['src/seed.txt'] }];
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    tasks,
    active_run: null,
    dispatch: { fabric: true, verify_timeout_s: 30 },
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{ id: 1, wave: 0, files: ['src/seed.txt'], description: 't1', verify_commands }],
  }));
  const self = buildOwnerIdentity({ host: 'h', session: 's', slug, now: 1000 });
  return { tmp, MAIN, bundleDir, statePath, self };
}

test('allowlist record: default injection surfaces SKYNET_VERIFY_ALLOWLIST once per wave', async () => {
  const prev = process.env.SKYNET_VERIFY_ALLOWLIST;
  delete process.env.SKYNET_VERIFY_ALLOWLIST;
  try {
    const fx = makeFabricFixture({ verify_commands: [] });
    continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
    const res = await dispatchWaveViaFabric({
      statePath: fx.statePath,
      self: fx.self,
      now: 3000,
    });
    assert.equal(res.outcome, 'native-spawn-plan');
    const rec = readWaveDispatchRecord(fx.bundleDir, 0);
    assert.equal(rec.gateway_verify_allowlist, DEFAULT_SKYNET_VERIFY_ALLOWLIST);
  } finally {
    if (prev === undefined) delete process.env.SKYNET_VERIFY_ALLOWLIST;
    else process.env.SKYNET_VERIFY_ALLOWLIST = prev;
  }
});

test('allowlist record: caller override is preserved and recorded once per wave', async () => {
  const prev = process.env.SKYNET_VERIFY_ALLOWLIST;
  process.env.SKYNET_VERIFY_ALLOWLIST = 'bash -c, node --check';
  try {
    const fx = makeFabricFixture({ verify_commands: [] });
    continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
    const res = await dispatchWaveViaFabric({
      statePath: fx.statePath,
      self: fx.self,
      now: 3000,
    });
    assert.equal(res.outcome, 'native-spawn-plan');
    const rec = readWaveDispatchRecord(fx.bundleDir, 0);
    assert.equal(rec.gateway_verify_allowlist, 'bash -c, node --check');
  } finally {
    if (prev === undefined) delete process.env.SKYNET_VERIFY_ALLOWLIST;
    else process.env.SKYNET_VERIFY_ALLOWLIST = prev;
  }
});
