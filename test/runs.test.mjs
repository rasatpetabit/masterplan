// test/runs.test.mjs — focused unit tests for lib/runs.mjs.
//
// runs.mjs is the F5 shared multi-run discovery engine: it scans discovery
// roots, builds per-bundle records, classifies dangling runs, and manages the
// .discovery.yml config format. All functions accept an injectable _fs, making
// them unit-testable without touching disk.
//
// Coverage gaps this file closes:
//   - parseDiscoveryConfig: inline + block + malformed
//   - serializeDiscoveryConfig: round-trip
//   - readDiscoveryConfig: absent / unreadable / parsable / unparsable
//   - addDiscoveryRoot / removeDiscoveryRoot: immutable set ops
//   - parseRootsArg: comma-separated CLI parsing
//   - mergeRoots: flatten + de-dupe + trim
//   - classifyDangling: archived / stale-activity / stale-owner / fresh
//   - deriveLastActivity: events / heartbeat / state-mtime / none
//   - discoveryConfigPath: path composition

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DANGLING_DEFAULT_DAYS,
  deriveLastActivity,
  discoveryConfigPath,
  parseDiscoveryConfig,
  serializeDiscoveryConfig,
  readDiscoveryConfig,
  addDiscoveryRoot,
  removeDiscoveryRoot,
  parseRootsArg,
  mergeRoots,
  classifyDangling,
} from '../lib/runs.mjs';

// ── discoveryConfigPath ─────────────────────────────────────────────────────

test('discoveryConfigPath: joins runs dir + .discovery.yml', () => {
  const p = discoveryConfigPath('/srv/dev/ras/myrepo', { MASTERPLAN_RUNS_DIR: '/custom/runs' });
  assert.equal(p, path.join('/custom/runs', '.discovery.yml'));
});

test('discoveryConfigPath: defaults to docs/masterplan when no env override', () => {
  const p = discoveryConfigPath('/repo', {});
  assert.ok(p.endsWith(path.join('docs', 'masterplan', '.discovery.yml')));
});

// ── parseDiscoveryConfig ────────────────────────────────────────────────────

test('parseDiscoveryConfig: block form with quoted entries', () => {
  const cfg = parseDiscoveryConfig('roots:\n  - "/a/b"\n  - \'/c/d\'\n');
  assert.deepEqual(cfg.roots, ['/a/b', '/c/d']);
});

test('parseDiscoveryConfig: inline form [JSON array]', () => {
  const cfg = parseDiscoveryConfig('roots: ["/x", "/y"]');
  assert.deepEqual(cfg.roots, ['/x', '/y']);
});

test('parseDiscoveryConfig: skips comments and blank lines', () => {
  const cfg = parseDiscoveryConfig('# comment\n\ndiscovery:\nroots:\n  - /keep\n');
  assert.deepEqual(cfg.roots, ['/keep']);
});

test('parseDiscoveryConfig: empty text yields empty roots', () => {
  assert.deepEqual(parseDiscoveryConfig('').roots, []);
  assert.deepEqual(parseDiscoveryConfig('# only comments\n').roots, []);
});

test('parseDiscoveryConfig: malformed inline array is silently skipped', () => {
  const cfg = parseDiscoveryConfig('roots: [bad json');
  assert.deepEqual(cfg.roots, []);
});

test('parseDiscoveryConfig: unquoted entries in block form', () => {
  const cfg = parseDiscoveryConfig('roots:\n  - /plain/path\n');
  assert.deepEqual(cfg.roots, ['/plain/path']);
});

// ── serializeDiscoveryConfig ───────────────────────────────────────────────

test('serializeDiscoveryConfig: produces parseable block form', () => {
  const text = serializeDiscoveryConfig(['/a', '/b']);
  const { roots } = parseDiscoveryConfig(text);
  assert.deepEqual(roots, ['/a', '/b']);
});

test('serializeDiscoveryConfig: header comment + roots key', () => {
  const text = serializeDiscoveryConfig([]);
  assert.match(text, /^# masterplan discovery roots/);
  assert.match(text, /^roots:$/m);
});

// ── readDiscoveryConfig (mocked _fs) ───────────────────────────────────────

function mockFs({ files = {}, errors = {} } = {}) {
  return {
    readFileSync(p) {
      if (errors[p]) throw errors[p];
      if (files[p] != null) return files[p];
      const err = new Error('not found');
      err.code = 'ENOENT';
      throw err;
    },
  };
}

test('readDiscoveryConfig: absent file returns empty roots, no warnings', () => {
  const fs = mockFs();
  const result = readDiscoveryConfig('/repo', { _fs: fs });
  assert.deepEqual(result.roots, []);
  assert.deepEqual(result.warnings, []);
});

test('readDiscoveryConfig: unreadable file returns warning', () => {
  const cfgPath = discoveryConfigPath('/repo', {});
  const fs = mockFs({ errors: { [cfgPath]: new Error('permission denied') } });
  const result = readDiscoveryConfig('/repo', { _fs: fs });
  assert.deepEqual(result.roots, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /unreadable/);
});

test('readDiscoveryConfig: valid file returns parsed roots', () => {
  const cfgPath = discoveryConfigPath('/repo', {});
  const fs = mockFs({ files: { [cfgPath]: 'roots:\n  - /path\n' } });
  const result = readDiscoveryConfig('/repo', { _fs: fs });
  assert.deepEqual(result.roots, ['/path']);
  assert.deepEqual(result.warnings, []);
});

// ── addDiscoveryRoot / removeDiscoveryRoot ─────────────────────────────────

test('addDiscoveryRoot: appends new root, returns new array', () => {
  const before = ['/a'];
  const after = addDiscoveryRoot(before, '/b');
  assert.deepEqual(after, ['/a', '/b']);
  assert.notEqual(after, before); // immutable
});

test('addDiscoveryRoot: dedupes existing root', () => {
  const before = ['/a', '/b'];
  const after = addDiscoveryRoot(before, '/a');
  assert.deepEqual(after, ['/a', '/b']);
});

test('removeDiscoveryRoot: removes all matching entries', () => {
  const before = ['/a', '/b', '/a'];
  const after = removeDiscoveryRoot(before, '/a');
  assert.deepEqual(after, ['/b']);
});

// ── parseRootsArg ──────────────────────────────────────────────────────────

test('parseRootsArg: comma-separated with whitespace', () => {
  assert.deepEqual(parseRootsArg(' /a , /b , /c '), ['/a', '/b', '/c']);
});

test('parseRootsArg: empty/null/undefined yields []', () => {
  assert.deepEqual(parseRootsArg(''), []);
  assert.deepEqual(parseRootsArg(null), []);
  assert.deepEqual(parseRootsArg(undefined), []);
});

test('parseRootsArg: single value', () => {
  assert.deepEqual(parseRootsArg('/only'), ['/only']);
});

// ── mergeRoots ─────────────────────────────────────────────────────────────

test('mergeRoots: flattens + trims + de-dupes (first-seen wins)', () => {
  const merged = mergeRoots(['/a', '/b'], ['/b', ' /c '], []);
  assert.deepEqual(merged, ['/a', '/b', '/c']);
});

test('mergeRoots: drops empty/whitespace entries', () => {
  const merged = mergeRoots(['/a', '', '  '], ['/b']);
  assert.deepEqual(merged, ['/a', '/b']);
});

test('mergeRoots: no groups yields []', () => {
  assert.deepEqual(mergeRoots(), []);
  assert.deepEqual(mergeRoots([]), []);
});

// ── classifyDangling ───────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

test('classifyDangling: archived runs are never dangling', () => {
  const result = classifyDangling({ archived: true, last_activity: 0 }, { now: 10 * DAY_MS });
  assert.equal(result.dangling, false);
  assert.equal(result.reason, null);
});

test('classifyDangling: stale activity triggers dangling', () => {
  const now = 30 * DAY_MS;
  const result = classifyDangling(
    { archived: false, last_activity: 0, owner: null, status: 'done' },
    { now },
  );
  assert.equal(result.dangling, true);
  assert.equal(result.staleActivity, true);
  assert.match(result.reason, /stale-activity/);
});

test('classifyDangling: stale in-progress owner triggers dangling', () => {
  const result = classifyDangling(
    {
      archived: false,
      last_activity: Date.now(), // fresh activity
      owner: { present: true, stale: true },
      status: 'in-progress',
    },
    { now: Date.now() },
  );
  assert.equal(result.dangling, true);
  assert.equal(result.staleOwner, true);
  assert.match(result.reason, /stale.*owner/);
});

test('classifyDangling: fresh run with live owner is not dangling', () => {
  const now = Date.now();
  const result = classifyDangling(
    {
      archived: false,
      last_activity: now - 1000,
      owner: { present: true, stale: false },
      status: 'in-progress',
    },
    { now },
  );
  assert.equal(result.dangling, false);
});

test('classifyDangling: respects custom thresholdDays', () => {
  const now = 10 * DAY_MS;
  const result = classifyDangling(
    { archived: false, last_activity: 8 * DAY_MS, owner: null, status: 'done' },
    { now, thresholdDays: DANGLING_DEFAULT_DAYS }, // default 7 days
  );
  assert.equal(result.staleActivity, false); // only 2 days old
});

test('classifyDangling: thresholdDays override works', () => {
  const now = 10 * DAY_MS;
  const result = classifyDangling(
    { archived: false, last_activity: 0, owner: null, status: 'done' },
    { now, thresholdDays: 1 },
  );
  assert.equal(result.staleActivity, true); // 10 days > 1 day threshold
});

// ── deriveLastActivity ─────────────────────────────────────────────────────

function mockFsForActivity({ eventsText = null, heartbeatMtime = null, stateMtime = null } = {}) {
  return {
    existsSync(p) {
      if (p.endsWith('events.jsonl')) return eventsText != null;
      if (p.includes('.owner.hb.')) return heartbeatMtime != null;
      return true;
    },
    readFileSync(p) {
      if (p.endsWith('events.jsonl')) {
        if (eventsText == null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return eventsText;
      }
      throw new Error('unexpected read: ' + p);
    },
    readdirSync(p) {
      // newestHeartbeatMtime scans bundleDir for '.owner.hb.*' files
      if (heartbeatMtime != null && !p.endsWith('events.jsonl')) {
        return ['.owner.hb.session-1'];
      }
      return [];
    },
    statSync(p) {
      if (p.endsWith('events.jsonl')) return { mtimeMs: 0, isDirectory: () => false };
      if (p.endsWith('state.yml')) {
        if (stateMtime == null) throw new Error('ENOENT');
        return { mtimeMs: stateMtime, isDirectory: () => false };
      }
      // Heartbeat files: return the configured mtime
      if (p.includes('.owner.hb.')) {
        if (heartbeatMtime == null) throw new Error('ENOENT');
        return { mtimeMs: heartbeatMtime, isDirectory: () => false };
      }
      return { mtimeMs: 0, isDirectory: () => false };
    },
  };
}

test('deriveLastActivity: events ts wins over heartbeat when newer', () => {
  const eventTs = Date.parse('2026-01-15T10:00:00Z');
  const fs = mockFsForActivity({
    eventsText: '{"ts":"2026-01-15T10:00:00Z"}\n',
    heartbeatMtime: eventTs - 1000, // heartbeat is older
  });
  const result = deriveLastActivity('/bundle', '/bundle/state.yml', fs);
  assert.equal(result.source, 'events');
  assert.equal(result.last_activity, eventTs);
});

test('deriveLastActivity: heartbeat wins over events when newer', () => {
  const eventTs = Date.parse('2026-01-15T10:00:00Z');
  const heartbeatMtime = eventTs + 60000; // heartbeat is newer (1 min ahead)
  const fs = mockFsForActivity({
    eventsText: '{"ts":"2026-01-15T10:00:00Z"}\n',
    heartbeatMtime,
  });
  const result = deriveLastActivity('/bundle', '/bundle/state.yml', fs);
  assert.equal(result.source, 'heartbeat');
  assert.equal(result.last_activity, heartbeatMtime);
});

test('deriveLastActivity: heartbeat-only (no events)', () => {
  const heartbeatMtime = 99999;
  const fs = mockFsForActivity({ heartbeatMtime });
  const result = deriveLastActivity('/bundle', '/bundle/state.yml', fs);
  assert.equal(result.source, 'heartbeat');
  assert.equal(result.last_activity, heartbeatMtime);
});

test('deriveLastActivity: falls back to state-mtime when no events or heartbeat', () => {
  const fs = mockFsForActivity({ stateMtime: 12345 });
  const result = deriveLastActivity('/bundle', '/bundle/state.yml', fs);
  assert.equal(result.source, 'state-mtime');
  assert.equal(result.last_activity, 12345);
});

test('deriveLastActivity: returns source none + ts 0 when nothing exists', () => {
  const fs = mockFsForActivity();
  const result = deriveLastActivity('/bundle', '/bundle/state.yml', fs);
  assert.equal(result.source, 'none');
  assert.equal(result.last_activity, 0);
});
