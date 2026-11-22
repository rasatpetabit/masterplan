// Exercise both real writers against disposable bundles and HOME; never migrate host state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
const original = fs.readFileSync(new URL('./fixtures/legacy-bundles/5.0-inflight-sample.yml', import.meta.url));
const namePattern = /^state\.yml\.v(?:\d+(?:\.\d+)?|unknown)\.\d{8}T\d{6}\.\d{3}Z-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/;
const oldName = (day, version = '5.1') =>
  `state.yml.v${version}.2000010${day}T000000.000Z-00000000-0000-4000-8000-000000000000`;

function fixture(t, project = 'project') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-migration-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bundle = path.join(root, project, 'docs', 'masterplan', 'same-slug');
  const state = path.join(bundle, 'state.yml');
  fs.mkdirSync(home);
  fs.mkdirSync(bundle, { recursive: true });
  execFileSync('git', ['init', '-q', path.join(root, project)]);
  fs.writeFileSync(state, original);
  const key = createHash('sha256').update(path.join(fs.realpathSync(bundle), 'state.yml')).digest('hex');
  const store = path.join(home, '.local', 'state', 'masterplan', 'rollback', key);
  return { root, home, bundle, state, store, legacy: `${state}.v5.0.bak` };
}

function run(fx, verb, preload = '') {
  const args = preload ? [`--import=data:text/javascript,${encodeURIComponent(preload)}`] : [];
  return spawnSync(process.execPath, [...args, bin, verb, `--state=${path.relative(fx.root, fx.state)}`], {
    cwd: fx.root,
    encoding: 'utf8',
    env: { ...process.env, HOME: fx.home, MP_DISPATCH_MAP: undefined, PI_CODING_AGENT: undefined,
      CLAUDE_CODE_SESSION_ID: 'mp-migration-snapshot-fixture' },
  });
}

function snapshotNames(store) {
  return fs.readdirSync(store).filter(name => namePattern.test(name)).sort();
}

for (const verb of ['continue', 'migrate-bundle']) {
  test(`${verb}: snapshot is owned, byte-exact, and never overwrites the legacy sibling`, t => {
    const fx = fixture(t);
    fs.writeFileSync(fx.legacy, 'historical bytes\n');
    const result = run(fx, verb);
    assert.equal(result.status, 0, result.stderr);
    const state = fs.readFileSync(fx.state, 'utf8');
    assert.match(state, /^schema_version: 8$/m);
    assert.deepEqual(fs.readdirSync(fx.bundle).filter(name => name.startsWith('state.yml')).sort(),
      ['state.yml', 'state.yml.v5.0.bak']);
    assert.equal(fs.readFileSync(fx.legacy, 'utf8'), 'historical bytes\n');
    const [name, ...others] = snapshotNames(fx.store);
    assert.match(name, /^state\.yml\.v5\.0\./);
    assert.deepEqual(others, []);
    const snapshot = path.join(fx.store, name);
    assert.deepEqual(fs.readFileSync(snapshot), original);
    assert.equal(fs.statSync(fx.store).mode & 0o777, 0o700, 'the slot is private to the user');
    if (verb === 'migrate-bundle') assert.equal(JSON.parse(result.stdout).backup, snapshot);
  });

  test(`${verb}: keeps three snapshots per state file and leaves unrelated entries alone`, t => {
    const fx = fixture(t);
    fs.mkdirSync(fx.store, { recursive: true });
    // Mixed version labels: a state file refused as unparseable, then repaired and migrated,
    // leaves snapshots whose names sort by version before time. Only time may order a prune.
    const planted = [[1, 'unknown'], [2, '3'], [3, '5.1'], [4, 'unknown']]
      .map(([day, version]) => oldName(day, version));
    for (const name of planted) fs.writeFileSync(path.join(fx.store, name), name);
    const unmanaged = path.join(fx.store, 'state.yml.v5.0.bak');
    fs.writeFileSync(unmanaged, 'unrelated');
    const other = fixture(t, 'other-project');
    const otherStore = path.join(path.dirname(fx.store), path.basename(other.store));
    fs.mkdirSync(otherStore);
    fs.writeFileSync(path.join(otherStore, oldName(1)), 'other bundle');

    const result = run(fx, verb);
    assert.equal(result.status, 0, result.stderr);
    const names = snapshotNames(fx.store);
    assert.equal(names.length, 3);
    const fresh = names.filter(name => name.startsWith('state.yml.v5.0.'));
    assert.equal(fresh.length, 1);
    assert.deepEqual(names.filter(name => name !== fresh[0]), [planted[2], planted[3]]);
    assert.deepEqual(fs.readFileSync(path.join(fx.store, fresh[0])), original);
    for (const name of planted.slice(0, 2)) assert.ok(!fs.existsSync(path.join(fx.store, name)), `${name} pruned`);
    assert.equal(fs.readFileSync(unmanaged, 'utf8'), 'unrelated');
    assert.deepEqual(fs.readdirSync(otherStore), [oldName(1)]);
  });

  test(`${verb}: an unlink failure warns but does not stop migration`, t => {
    const fx = fixture(t);
    const blocked = path.join(fx.store, oldName(1));
    fs.mkdirSync(blocked, { recursive: true }); // unlink cannot remove a directory, even as root.
    for (const day of [2, 3, 4]) fs.writeFileSync(path.join(fx.store, oldName(day)), `old ${day}`);

    const result = run(fx, verb);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /warning: .*prune/i);
    assert.ok(result.stderr.includes(blocked));
    assert.match(fs.readFileSync(fx.state, 'utf8'), /^schema_version: 8$/m);
    assert.ok(fs.statSync(blocked).isDirectory());
    assert.ok(!fs.existsSync(path.join(fx.store, oldName(2))), 'prune tried the next excess entry');
  });

  for (const failure of ['listing', 'ordering']) {
    test(`${verb}: prune ${failure} failure warns and deletes nothing`, t => {
      const fx = fixture(t);
      fs.mkdirSync(fx.store, { recursive: true });
      for (const day of [1, 2, 3, 4]) fs.writeFileSync(path.join(fx.store, oldName(day)), `old ${day}`);
      const preload = failure === 'listing' ? `
        import fs from 'node:fs';
        const original = fs.readdirSync;
        fs.readdirSync = function (dir, ...args) {
          if (dir === ${JSON.stringify(fx.store)}) throw new Error('fixture listing failure');
          return original.call(this, dir, ...args);
        };
      ` : `
        const original = Array.prototype.sort;
        Array.prototype.sort = function (...args) {
          if (this.includes(${JSON.stringify(oldName(1))})) throw new Error('fixture ordering failure');
          return original.apply(this, args);
        };
      `;
      const result = run(fx, verb, preload);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /warning: .*prune/i);
      assert.ok(result.stderr.includes(`fixture ${failure} failure`));
      assert.match(fs.readFileSync(fx.state, 'utf8'), /^schema_version: 8$/m);
      assert.equal(snapshotNames(fx.store).length, 5);
    });
  }

  test(`${verb}: a capture failure aborts before touching the original`, t => {
    const fx = fixture(t);
    fs.mkdirSync(path.dirname(fx.store), { recursive: true });
    fs.writeFileSync(fx.store, 'not a directory');

    const result = run(fx, verb);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /snapshot/i);
    assert.deepEqual(fs.readFileSync(fx.state), original);
    assert.deepEqual(fs.readdirSync(fx.bundle), ['state.yml']);
  });

  test(`${verb}: a failed copy aborts before the original is rewritten`, t => {
    const fx = fixture(t);
    const result = run(fx, verb, `
      import fs from 'node:fs';
      import path from 'node:path';
      const copy = fs.copyFileSync;
      fs.copyFileSync = function (src, dst, ...args) {
        if (path.dirname(dst) === ${JSON.stringify(fx.store)}) throw new Error('fixture copy failure');
        return copy.call(this, src, dst, ...args);
      };
    `);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /could not snapshot .*fixture copy failure/);
    assert.deepEqual(fs.readFileSync(fx.state), original);
    assert.deepEqual(fs.readdirSync(fx.bundle), ['state.yml']);
    assert.deepEqual(fs.readdirSync(fx.store), []);
  });
}

test('migrate-bundle: refuses a HOME inside the bundle before creating the snapshot store', t => {
  const fx = fixture(t);
  const home = path.join(fx.bundle, 'home');
  fs.renameSync(fx.home, home);
  fx.home = home;

  const result = run(fx, 'migrate-bundle');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inside the bundle directory/);
  assert.deepEqual(fs.readFileSync(fx.state), original);
  assert.deepEqual(fs.readdirSync(fx.bundle).sort(), ['home', 'state.yml']);
  assert.deepEqual(fs.readdirSync(home), []);
});

test('migrate-bundle: refuses a store linked into the bundle before creating the snapshot slot', t => {
  const fx = fixture(t);
  const target = path.join(fx.bundle, 'linked-store');
  fs.mkdirSync(target);
  const link = path.join(fx.home, '.local', 'state', 'masterplan');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, 'dir');

  const result = run(fx, 'migrate-bundle');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /inside the bundle directory/);
  assert.deepEqual(fs.readFileSync(fx.state), original);
  assert.deepEqual(fs.readdirSync(fx.bundle).sort(), ['linked-store', 'state.yml']);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('continue: refusal points recovery to readable pre-migration bytes without touching the original', t => {
  const fx = fixture(t);
  const unreadableVersion = Buffer.from('slug: ancient\r\n');
  fs.writeFileSync(fx.state, unreadableVersion);
  const result = run(fx, 'continue');
  assert.equal(result.status, 0, result.stderr);
  const op = JSON.parse(result.stdout);
  assert.equal(op.ask, 'legacy-refused');
  assert.equal(path.dirname(op.backup), fx.store);
  assert.match(path.basename(op.backup), /^state\.yml\.vunknown\./);
  assert.deepEqual(fs.readFileSync(op.backup), unreadableVersion);
  assert.deepEqual(fs.readFileSync(fx.state), unreadableVersion);
  assert.deepEqual(fs.readdirSync(fx.bundle), ['state.yml']);
});
