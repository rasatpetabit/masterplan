// test/watch-integrity.test.mjs — focused UNIT tests for lib/watch-integrity.mjs.
//
// Complements test/wave-integrity.test.mjs (23 integration tests using real git repos)
// with focused unit tests for the pure utility functions and edge cases that are
// currently only exercised as side-effects of the integration tests.
//
// Coverage:
//   - runGit: _exec injection, error formatting, output trimming
//   - gitLines: empty/multiline output, filter behavior
//   - parsePorcelainV2Entry: all record kinds + malformed/edge cases
//   - watchBaselinePath: path composition
//   - writeWatchBaseline/readWatchBaseline: round-trip + missing file
//   - MAIN_TRANSACTION_FILES / CONTROLLER_STATE_KEYS: membership

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runGit,
  gitLines,
  parsePorcelainV2Entry,
  watchBaselinePath,
  writeWatchBaseline,
  readWatchBaseline,
  MAIN_TRANSACTION_FILES,
  CONTROLLER_STATE_KEYS,
} from '../lib/watch-integrity.mjs';

// ── runGit ──────────────────────────────────────────────────────────────────

test('runGit: injects _exec and trims output', () => {
  const fakeExec = (cmd, args, opts) => {
    assert.equal(cmd, 'git');
    assert.deepEqual(args.slice(0, 2), ['-C', '/repo']);
    assert.deepEqual(args.slice(2), ['rev-parse', 'HEAD']);
    return '  abc123\n';
  };
  const result = runGit('/repo', ['rev-parse', 'HEAD'], fakeExec);
  assert.equal(result, 'abc123');
});

test('runGit: formats error with stderr when available', () => {
  const fakeExec = () => {
    const err = new Error('Command failed');
    err.stderr = 'fatal: not a git repository';
    throw err;
  };
  assert.throws(
    () => runGit('/nope', ['status'], fakeExec),
    /git -C \/nope status failed: fatal: not a git repository/,
  );
});

test('runGit: formats error with message when no stderr', () => {
  const fakeExec = () => { throw new Error('spawn ENOENT'); };
  assert.throws(
    () => runGit('/repo', ['log'], fakeExec),
    /git -C \/repo log failed: spawn ENOENT/,
  );
});

// ── gitLines ────────────────────────────────────────────────────────────────

test('gitLines: splits multiline output into array', () => {
  const fakeExec = () => 'line1\nline2\nline3\n';
  const result = gitLines('/repo', ['ls-files'], fakeExec);
  assert.deepEqual(result, ['line1', 'line2', 'line3']);
});

test('gitLines: empty output yields empty array', () => {
  const fakeExec = () => '';
  assert.deepEqual(gitLines('/repo', ['status'], fakeExec), []);
});

test('gitLines: filters blank lines', () => {
  const fakeExec = () => 'keep\n\nkeep2\n\n';
  assert.deepEqual(gitLines('/repo', ['ls-files'], fakeExec), ['keep', 'keep2']);
});

test('gitLines: passes _exec through to runGit', () => {
  const fakeExec = (cmd, args) => {
    assert.equal(cmd, 'git');
    return 'only\n';
  };
  assert.deepEqual(gitLines('/repo', ['diff', '--name-only'], fakeExec), ['only']);
});

// ── parsePorcelainV2Entry ───────────────────────────────────────────────────

test('parsePorcelainV2Entry: untracked entry (kind ?)', () => {
  const e = parsePorcelainV2Entry('? new-file.txt');
  assert.deepEqual(e, { xy: '?', path: 'new-file.txt' });
});

test('parsePorcelainV2Entry: ignored entry (kind !)', () => {
  const e = parsePorcelainV2Entry('! ignored.log');
  assert.deepEqual(e, { xy: '!', path: 'ignored.log' });
});

test('parsePorcelainV2Entry: changed entry (kind 1)', () => {
  const line = '1 .M N... 100644 100644 100644 abc123 def456 src/index.ts';
  const e = parsePorcelainV2Entry(line);
  assert.equal(e.xy, '.M');
  assert.equal(e.path, 'src/index.ts');
});

test('parsePorcelainV2Entry: rename entry (kind 2)', () => {
  const line = '2 RM N... 100644 100644 100644 abc123 def456 R100 new.txt\told.txt';
  const e = parsePorcelainV2Entry(line);
  assert.equal(e.xy, 'RM');
  assert.equal(e.path, 'new.txt');
});

test('parsePorcelainV2Entry: unmerged entry (kind u)', () => {
  const line = 'u AA N... 100644 100644 100644 100644 abc123 def456 ghi789 conflicted.ts';
  const e = parsePorcelainV2Entry(line);
  assert.equal(e.xy, 'AA');
  assert.equal(e.path, 'conflicted.ts');
});

test('parsePorcelainV2Entry: path with spaces preserved', () => {
  const e = parsePorcelainV2Entry('? my file with spaces.txt');
  assert.equal(e.path, 'my file with spaces.txt');
});

test('parsePorcelainV2Entry: null for empty input', () => {
  assert.equal(parsePorcelainV2Entry(''), null);
  assert.equal(parsePorcelainV2Entry(null), null);
});

test('parsePorcelainV2Entry: null for unrecognized kind', () => {
  assert.equal(parsePorcelainV2Entry('# header'), null);
});

test('parsePorcelainV2Entry: kind 1 with too few fields returns null', () => {
  // Truncated entry — missing path
  assert.equal(parsePorcelainV2Entry('1 .M N... 100644 100644 100644 abc123 def456'), null);
});

// ── watchBaselinePath ───────────────────────────────────────────────────────

test('watchBaselinePath: composes .wave-N.watch.json', () => {
  const p = watchBaselinePath('/bundle', 3);
  assert.equal(p, path.join('/bundle', '.wave-3.watch.json'));
});

test('watchBaselinePath: wave 0', () => {
  const p = watchBaselinePath('/bundle', 0);
  assert.ok(p.endsWith('.wave-0.watch.json'));
});

// ── writeWatchBaseline / readWatchBaseline ──────────────────────────────────

test('writeWatchBaseline + readWatchBaseline: round-trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-bl-'));
  const baseline = {
    snapshots: [{ repo: '/repo', head: 'abc123', dirty: new Map([['file.ts', 'hash']]) }],
    bundle: { bundleDir: dir, eventsBytes: 42, eventsSha: 'deadbeef', stateText: 'key: val' },
  };
  const written = writeWatchBaseline(dir, 2, baseline);
  assert.ok(fs.existsSync(written));
  const read = readWatchBaseline(dir, 2);
  assert.deepEqual(read.snapshots[0].head, 'abc123');
  assert.deepEqual(read.bundle.eventsSha, 'deadbeef');
  fs.rmSync(dir, { recursive: true });
});

test('readWatchBaseline: returns null for missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-bl-'));
  assert.equal(readWatchBaseline(dir, 99), null);
  fs.rmSync(dir, { recursive: true });
});

test('writeWatchBaseline: uses atomic tmp+rename', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-bl-'));
  writeWatchBaseline(dir, 1, { snapshots: [], bundle: {} });
  // No leftover .tmp file
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.equal(files.length, 0);
  fs.rmSync(dir, { recursive: true });
});

// ── MAIN_TRANSACTION_FILES ──────────────────────────────────────────────────

test('MAIN_TRANSACTION_FILES: matches state.yml', () => {
  assert.ok(MAIN_TRANSACTION_FILES.some((re) => re.test('state.yml')));
});

test('MAIN_TRANSACTION_FILES: matches events.jsonl', () => {
  assert.ok(MAIN_TRANSACTION_FILES.some((re) => re.test('events.jsonl')));
});

test('MAIN_TRANSACTION_FILES: matches wave watch baseline', () => {
  assert.ok(MAIN_TRANSACTION_FILES.some((re) => re.test('.wave-5.watch.json')));
});

test('MAIN_TRANSACTION_FILES: matches plan.index.json', () => {
  assert.ok(MAIN_TRANSACTION_FILES.some((re) => re.test('plan.index.json')));
});

test('MAIN_TRANSACTION_FILES: excludes arbitrary files', () => {
  assert.ok(!MAIN_TRANSACTION_FILES.some((re) => re.test('random.md')));
  assert.ok(!MAIN_TRANSACTION_FILES.some((re) => re.test('src/index.ts')));
});

test('MAIN_TRANSACTION_FILES: includes owner sentinels (Guard D owns them)', () => {
  // Owner lock + heartbeat files ARE allowed MAIN writes — the commit pathspec
  // excludes them from shipping, and Guard D validates their presence. Content
  // validation is skipped (a child forging a sentinel is Guard D's problem).
  assert.ok(MAIN_TRANSACTION_FILES.some((re) => re.test('.owner.lock')));
  assert.ok(MAIN_TRANSACTION_FILES.some((re) => re.test('.owner.hb.session-1')));
});

// ── CONTROLLER_STATE_KEYS ───────────────────────────────────────────────────

test('CONTROLLER_STATE_KEYS: includes wave transaction keys', () => {
  for (const key of ['active_run', 'tasks', 'updated_at', 'worktree', 'status', 'phase']) {
    assert.ok(CONTROLLER_STATE_KEYS.has(key), `should include ${key}`);
  }
});

test('CONTROLLER_STATE_KEYS: excludes non-transaction keys', () => {
  assert.ok(!CONTROLLER_STATE_KEYS.has('goals'));
  assert.ok(!CONTROLLER_STATE_KEYS.has('slug'));
  assert.ok(!CONTROLLER_STATE_KEYS.has('refs'));
  assert.ok(!CONTROLLER_STATE_KEYS.has('plan_index_path'));
});
