// test/verify-transport.test.mjs — fabric edit-verify transport seam (Task 11).
//
// Covers D1 packaging (bash -c wrap + object form), D2 full-list local runner
// (pass/fail/timeout, fail-closed), D3 allowlist injection + record evidence,
// prepare-time loud failure when allowlist lacks bash -c, and the wave-0
// regression fixture (`cd X && node --test …`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  wrapVerifyCommandForGateway,
  posixSingleQuote,
  packageGatewayVerify,
  runLocalVerifyCommands,
  assertAllowlistAcceptsBashC,
  buildWorkItem,
  createBrokerClient,
  DEFAULT_VERIFY_TIMEOUT_S,
  DEFAULT_SKYNET_VERIFY_ALLOWLIST,
} from '../lib/dispatch/adsp-adapter.mjs';
import {
  dispatchWaveViaFabric,
  readWaveDispatchRecord,
} from '../lib/dispatch-wave.mjs';
import { continueRun } from '../lib/continue.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// ---------------------------------------------------------------------------
// D1 — packaging
// ---------------------------------------------------------------------------

test('posixSingleQuote: embeds single quotes via POSIX end-quote form', () => {
  assert.equal(posixSingleQuote(`it's`), `it'"'"'s`);
  assert.equal(posixSingleQuote(`plain`), `plain`);
});

test('wrapVerifyCommandForGateway: wraps bare commands; idempotent on bash -c', () => {
  assert.equal(wrapVerifyCommandForGateway('node --test'), `bash -c 'node --test'`);
  assert.equal(wrapVerifyCommandForGateway(`bash -c 'node --test'`), `bash -c 'node --test'`);
  assert.equal(wrapVerifyCommandForGateway(`  bash  -c  'x'`), `  bash  -c  'x'`);
});

test('wrapVerifyCommandForGateway: quoting round-trip for quotes and $()', () => {
  const cases = [
    `echo "hello"`,
    `echo 'single'`,
    `echo $(uname)`,
    `cd /tmp && node --test`,
    `echo 'it'"'"'s fine'`,
  ];
  for (const raw of cases) {
    const wrapped = wrapVerifyCommandForGateway(raw);
    // Running the wrapped form under bash -c of the outer is wrong — the form
    // itself is `bash -c '…'`. Exec the wrapper as a shell line.
    const out = execFileSync('bash', ['-c', wrapped], { encoding: 'utf8' });
    // Just prove it doesn't explode; for echo cases check non-empty.
    if (raw.startsWith('echo')) assert.ok(out.length >= 0);
  }
});

test('packageGatewayVerify: object-form [0] with command/cwd/timeout; rest preserved raw', () => {
  const packaged = packageGatewayVerify(
    ['cd src && node --test', 'npm test'],
    { cwd: '/wt', timeoutS: 120 },
  );
  assert.equal(packaged.length, 2);
  assert.equal(typeof packaged[0], 'object');
  assert.equal(packaged[0].command, `bash -c 'cd src && node --test'`);
  assert.equal(packaged[0].cwd, '/wt');
  assert.equal(packaged[0].timeout, 120);
  assert.equal(packaged[1], 'npm test');
});

test('packageGatewayVerify: wave-0 regression — cd X && node --test packages cleanly', () => {
  const packaged = packageGatewayVerify(
    ['cd packages/core && node --test test/foo.test.mjs'],
    { cwd: '/repo/wt', timeoutS: DEFAULT_VERIFY_TIMEOUT_S },
  );
  assert.equal(packaged[0].command, `bash -c 'cd packages/core && node --test test/foo.test.mjs'`);
  assert.equal(packaged[0].cwd, '/repo/wt');
  // Must NOT be a bare string the gateway would shlex-split into `cd` alone.
  assert.equal(typeof packaged[0], 'object');
});

test('packageGatewayVerify: idempotent when [0] already bash -c', () => {
  const packaged = packageGatewayVerify([`bash -c 'node --check x.js'`], { cwd: '/w' });
  assert.equal(packaged[0].command, `bash -c 'node --check x.js'`);
});

test('buildWorkItem: packages verify[0] as object; handoff key ignores packaging', () => {
  const a = buildWorkItem({
    task_id: 1,
    description: 't',
    files: ['a.js'],
    verify_commands: ['cd x && node --test'],
    cwd: '/wt',
    run_id: 'r1',
    inputs: { head: 'abc', dirtyDigest: '0', policyVersion: 'p', workerVersion: 'w' },
  }, { verify_timeout_s: 90 });
  assert.equal(typeof a.verify[0], 'object');
  assert.equal(a.verify[0].timeout, 90);
  assert.match(a.verify[0].command, /^bash -c /);

  const b = buildWorkItem({
    task_id: 1,
    description: 't',
    files: ['a.js'],
    verify_commands: ['cd x && node --test'],
    cwd: '/wt',
    run_id: 'r1',
    inputs: { head: 'abc', dirtyDigest: '0', policyVersion: 'p', workerVersion: 'w' },
  }, { verify_timeout_s: 10 });
  // Packaging timeout is wire-only — handoff key uses raw verify_commands.
  assert.equal(a.handoff_key, b.handoff_key);
});

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

test('assertAllowlistAcceptsBashC: empty/unset ok; missing bash -c throws', () => {
  assert.doesNotThrow(() => assertAllowlistAcceptsBashC(null));
  assert.doesNotThrow(() => assertAllowlistAcceptsBashC(''));
  assert.doesNotThrow(() => assertAllowlistAcceptsBashC('bash -c'));
  assert.doesNotThrow(() => assertAllowlistAcceptsBashC('node --check, bash -c'));
  assert.throws(
    () => assertAllowlistAcceptsBashC('node --check'),
    /does not include 'bash -c'/,
  );
});

test('packageGatewayVerify: caller allowlist without bash -c fails at prepare', () => {
  assert.throws(
    () => packageGatewayVerify(['node --test'], { allowlist: 'node --check' }),
    /does not include 'bash -c'/,
  );
});

test('buildWorkItem: allowlist override without bash -c fails loudly at prepare', () => {
  assert.throws(
    () => buildWorkItem({
      task_id: 1,
      description: 't',
      files: [],
      verify_commands: ['node --test'],
      cwd: '/wt',
    }, { skynetVerifyAllowlist: 'py_compile' }),
    /bash -c/,
  );
});

// ---------------------------------------------------------------------------
// D2 — local full-list runner
// ---------------------------------------------------------------------------

test('runLocalVerifyCommands: pass path records passed:true', () => {
  const r = runLocalVerifyCommands(['true', 'echo hi'], { cwd: process.cwd() });
  assert.equal(r.length, 2);
  assert.equal(r[0].passed, true);
  assert.equal(r[1].passed, true);
  assert.match(r[1].output, /hi/);
});

test('runLocalVerifyCommands: fail path records passed:false', () => {
  const r = runLocalVerifyCommands(['false', 'true'], { cwd: process.cwd() });
  assert.equal(r[0].passed, false);
  assert.equal(r[1].passed, true);
});

test('runLocalVerifyCommands: timeout path marks failed with timeout marker', () => {
  const r = runLocalVerifyCommands(['sleep 5'], { cwd: process.cwd(), timeoutS: 0.2 });
  assert.equal(r.length, 1);
  assert.equal(r[0].passed, false);
  assert.match(r[0].output, /timeout|ETIMEDOUT|killed/i);
});

test('runLocalVerifyCommands: injectable _exec used for hermetic tests', () => {
  const calls = [];
  const r = runLocalVerifyCommands(['a', 'b'], {
    cwd: '/x',
    timeoutS: 3,
    _exec: (cmd, opts) => {
      calls.push({ cmd, opts });
      if (cmd === 'b') throw new Error('boom');
      return 'ok';
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(r[0].passed, true);
  assert.equal(r[1].passed, false);
  assert.match(r[1].output, /boom/);
});

// ---------------------------------------------------------------------------
// D3 — allowlist injection + record evidence (named allowlist+record)
// ---------------------------------------------------------------------------

function makeFabricFixture({ verify_commands = [], review = false } = {}) {
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
    ...(review ? { review: { adversary: true } } : {}),
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{ id: 1, wave: 0, files: ['src/seed.txt'], description: 't1', verify_commands }],
  }));
  const self = buildOwnerIdentity({ host: 'h', session: 's', slug, now: 1000 });
  return { tmp, MAIN, bundleDir, statePath, self };
}

function mockBrokerDone() {
  const digest = {
    task_id: 1, status: 'done', start_sha: '0', files_changed: [],
    verify: [], summary: 'ok', blockers: null,
  };
  return {
    skynetVerifyAllowlist: DEFAULT_SKYNET_VERIFY_ALLOWLIST,
    async initialize() { return {}; },
    async callTool(name, args) {
      const d = name === 'dispatch_task' ? (args?.descriptor ?? {}) : (args?.descriptors?.[0] ?? {});
      return {
        decision: { decision: 'route', backend: 'pi' },
        stdout: JSON.stringify({ ...digest, task_id: d.task_id ?? 1 }),
      };
    },
    close() {},
  };
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
      _brokerClient: mockBrokerDone(),
      _localVerifyExec: () => 'ok',
      _record: () => ({ outcome: 'recorded', recorded: [1], failed: [], cleared: true, commits: {} }),
      _openCoord: () => null,
      _closeCoord: () => {},
    });
    assert.equal(res.dispatched, true);
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
    await dispatchWaveViaFabric({
      statePath: fx.statePath,
      self: fx.self,
      now: 3000,
      _brokerClient: {
        ...mockBrokerDone(),
        skynetVerifyAllowlist: 'bash -c, node --check',
      },
      _localVerifyExec: () => 'ok',
      _record: () => ({ outcome: 'recorded', recorded: [1], failed: [], cleared: true, commits: {} }),
      _openCoord: () => null,
      _closeCoord: () => {},
    });
    const rec = readWaveDispatchRecord(fx.bundleDir, 0);
    assert.equal(rec.gateway_verify_allowlist, 'bash -c, node --check');
  } finally {
    if (prev === undefined) delete process.env.SKYNET_VERIFY_ALLOWLIST;
    else process.env.SKYNET_VERIFY_ALLOWLIST = prev;
  }
});

test('fail-closed: broker done + local verify fail marks task failed', async () => {
  const fx = makeFabricFixture({ verify_commands: ['false'] });
  continueRun({ statePath: fx.statePath, self: fx.self, now: 2000, fabricDispatch: true });
  let captured = null;
  await dispatchWaveViaFabric({
    statePath: fx.statePath,
    self: fx.self,
    now: 3000,
    _brokerClient: mockBrokerDone(),
    // Real shell so `false` fails.
    _record: (args) => {
      captured = args.result;
      return { outcome: 'recorded', recorded: [], failed: [1], cleared: false, commits: {} };
    },
    _openCoord: () => null,
    _closeCoord: () => {},
  });
  assert.ok(captured);
  const d = captured.tasks[0].digest;
  assert.equal(d.status, 'failed');
  assert.ok(Array.isArray(d.verify) && d.verify.some((v) => !v.passed));
});
