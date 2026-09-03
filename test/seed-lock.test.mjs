// test/seed-lock.test.mjs — unit tests for lib/seed-lock.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SEED_LOCK_RELPATH,
  acquireSeedLock,
  releaseSeedLock,
  inspectSeedLock,
  isPidAlive,
} from '../lib/seed-lock.mjs';

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-lock-'));
  fs.mkdirSync(path.join(dir, 'docs', 'masterplan'), { recursive: true });
  return dir;
}

test('competing acquisitions serialize on the seed lock', () => {
  const repo = makeTempRepo();
  const a = { pid: process.pid, host: 'host-a', session: 'sess-a' };
  const b = { pid: process.pid, host: 'host-b', session: 'sess-b' };
  const now = 1234567890;

  const first = acquireSeedLock(repo, { ...a, now });
  assert.equal(first.ok, true);
  assert.equal(first.owner.acquired_at, now);
  assert.equal(typeof first.owner.token, 'string');

  const second = acquireSeedLock(repo, { ...b, now: now + 1 });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'locked');
  assert.equal(second.owner.session, first.owner.session);
  assert.equal(second.owner.token, undefined); // the release capability is never exposed

  const released = releaseSeedLock(repo, first.owner);
  assert.equal(released.ok, true);

  const third = acquireSeedLock(repo, { ...b, now: now + 2 });
  assert.equal(third.ok, true);
  assert.equal(third.owner.acquired_at, now + 2);
});

test('release after a failed acquisition leaves the lock releasable by its owner', () => {
  const repo = makeTempRepo();
  const a = { pid: process.pid, host: 'host-a', session: 'sess-a' };
  const b = { pid: process.pid, host: 'host-b', session: 'sess-b' };

  const held = acquireSeedLock(repo, a);
  assert.equal(held.ok, true);
  assert.equal(acquireSeedLock(repo, b).ok, false);

  // The failed acquirer cannot release it.
  assert.equal(releaseSeedLock(repo, b).ok, false);
  assert.equal(releaseSeedLock(repo, b).reason, 'not-owner');

  // The owner can still release after the failed attempt (with its acquisition handle).
  assert.equal(releaseSeedLock(repo, held.owner).ok, true);
  assert.equal(acquireSeedLock(repo, b).ok, true);
});

test('a non-owner cannot release the seed lock', () => {
  const repo = makeTempRepo();
  const a = { pid: process.pid, host: 'host-a', session: 'sess-a' };
  const b = { pid: process.pid, host: 'host-b', session: 'sess-b' };

  const held = acquireSeedLock(repo, a);
  assert.equal(held.ok, true);
  const res = releaseSeedLock(repo, b);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'not-owner');

  const insp = inspectSeedLock(repo);
  assert.equal(insp.present, true);
  assert.equal(insp.owner.pid, a.pid);
  assert.equal(insp.owner.session, a.session);

  assert.equal(releaseSeedLock(repo, a).reason, 'stale-handle'); // tuple-only handle never releases
  assert.equal(releaseSeedLock(repo, held.owner).ok, true);
});

test('inspect reports live and dead owners', () => {
  const repo = makeTempRepo();
  const live = { pid: process.pid, host: 'host-live', session: 'sess-live' };
  const dead = { pid: 999999, host: 'host-dead', session: 'sess-dead' };

  // No lock yet.
  assert.deepEqual(inspectSeedLock(repo), { present: false, owner: null, alive: false });

  // Live owner.
  const liveHeld = acquireSeedLock(repo, live);
  assert.equal(liveHeld.ok, true);
  const liveInsp = inspectSeedLock(repo);
  assert.equal(liveInsp.present, true);
  assert.equal(liveInsp.alive, true);
  assert.equal(liveInsp.owner.pid, live.pid);
  assert.equal(releaseSeedLock(repo, liveHeld.owner).ok, true);

  // Dead owner (pid 999999 is not running).
  const deadHeld = acquireSeedLock(repo, dead);
  assert.equal(deadHeld.ok, true);
  const deadInsp = inspectSeedLock(repo);
  assert.equal(deadInsp.present, true);
  assert.equal(deadInsp.alive, false);
  assert.equal(deadInsp.owner.pid, dead.pid);

  // Custom isAlive callback overrides the default.
  const custom = inspectSeedLock(repo, { isAlive: () => true });
  assert.equal(custom.alive, true);
  const customFalse = inspectSeedLock(repo, { isAlive: () => false });
  assert.equal(customFalse.alive, false);

  assert.equal(releaseSeedLock(repo, deadHeld.owner).ok, true);
});

test('isPidAlive distinguishes live and dead pids', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(0), false);
});

test('acquisition creates the parent directory in a fresh repo', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-lock-fresh-'));
  const owner = { pid: process.pid, host: 'host-fresh', session: 'sess-fresh' };
  const res = acquireSeedLock(repo, owner);
  assert.equal(res.ok, true);
  assert.equal(fs.existsSync(path.join(repo, SEED_LOCK_RELPATH)), true);
  assert.equal(releaseSeedLock(repo, res.owner).ok, true);
});

test('an empty seed lock file is malformed and blocks acquisition', () => {
  const repo = makeTempRepo();
  const lockFile = path.join(repo, SEED_LOCK_RELPATH);
  fs.writeFileSync(lockFile, '');
  const insp = inspectSeedLock(repo);
  assert.deepEqual(insp, { present: true, owner: null, alive: false, malformed: true });
  const res = acquireSeedLock(repo, { pid: process.pid, host: 'host-x', session: 'sess-x' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'locked');
  assert.equal(res.owner, null);
  assert.equal(releaseSeedLock(repo, { pid: process.pid, host: 'host-x', session: 'sess-x' }).reason, 'malformed');
});

test('malformed owner metadata is reported and cannot be released', () => {
  const repo = makeTempRepo();
  const lockFile = path.join(repo, SEED_LOCK_RELPATH);

  // acquired_at null
  fs.writeFileSync(lockFile, JSON.stringify({ acquired_at: null }));
  assert.deepEqual(inspectSeedLock(repo), { present: true, owner: null, alive: false, malformed: true });
  const res1 = releaseSeedLock(repo, {});
  assert.equal(res1.ok, false);
  assert.equal(res1.reason, 'malformed');
  assert.equal(fs.existsSync(lockFile), true);

  // pid not an integer
  fs.writeFileSync(lockFile, JSON.stringify({ pid: '12', host: 'h', session: 's', acquired_at: 1 }));
  assert.deepEqual(inspectSeedLock(repo), { present: true, owner: null, alive: false, malformed: true });
  const res2 = releaseSeedLock(repo, {});
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'malformed');
  assert.equal(fs.existsSync(lockFile), true);
});

test('invalid owner metadata is refused', () => {
  const repo = makeTempRepo();
  const bad1 = { pid: 0, host: 'host', session: 'sess' };
  const bad2 = { pid: process.pid, host: 'host', session: '' };
  assert.equal(acquireSeedLock(repo, bad1).ok, false);
  assert.equal(acquireSeedLock(repo, bad1).reason, 'invalid-owner');
  assert.equal(acquireSeedLock(repo, bad2).ok, false);
  assert.equal(acquireSeedLock(repo, bad2).reason, 'invalid-owner');
  assert.equal(fs.existsSync(path.join(repo, SEED_LOCK_RELPATH)), false);
});

test('a failed initialisation does not leave a poisoned lock behind', () => {
  const repo = makeTempRepo();
  const lockFile = path.join(repo, SEED_LOCK_RELPATH);
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (fd, data) => { if (typeof fd === 'number') { const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e; } return realWrite(fd, data); };
  // (the metadata is written through the private temp file's descriptor before the lock is published)
  try {
    assert.throws(() => acquireSeedLock(repo, { pid: process.pid, host: 'h', session: 's' }), /ENOSPC/);
  } finally {
    fs.writeFileSync = realWrite;
  }
  assert.equal(fs.existsSync(lockFile), false);
  assert.deepEqual(fs.readdirSync(path.dirname(lockFile)).filter((f) => f.includes('.seed.lock')), [], 'no temp file left behind');
  assert.equal(acquireSeedLock(repo, { pid: process.pid, host: 'h', session: 's' }).ok, true);
});

test('the lock path is never published without complete metadata', () => {
  const repo = makeTempRepo();
  const lockFile = path.join(repo, SEED_LOCK_RELPATH);
  const realLink = fs.linkSync;
  let sawTmpWithMetadata = false;
  fs.linkSync = (src, dst) => { sawTmpWithMetadata = JSON.parse(fs.readFileSync(src, 'utf8')).token.length > 0 && !fs.existsSync(dst); return realLink(src, dst); };
  try {
    const res = acquireSeedLock(repo, { pid: process.pid, host: 'h', session: 's' });
    assert.equal(res.ok, true);
  } finally {
    fs.linkSync = realLink;
  }
  assert.equal(sawTmpWithMetadata, true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, 'utf8')).host, 'h');
});

test('a stale acquisition handle cannot release a newer lock', () => {
  const repo = makeTempRepo();
  const self = { pid: process.pid, host: 'h', session: 's' };
  const first = acquireSeedLock(repo, { ...self, now: 1 });
  assert.equal(releaseSeedLock(repo, first.owner).ok, true);
  const second = acquireSeedLock(repo, { ...self, now: 2 });
  assert.equal(second.ok, true);
  const stale = releaseSeedLock(repo, first.owner);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale-handle');
  assert.equal(inspectSeedLock(repo).present, true);
  assert.equal(releaseSeedLock(repo, second.owner).ok, true);
});

test('a stale handle with the same timestamp cannot release a newer lock', () => {
  const repo = makeTempRepo();
  const self = { pid: process.pid, host: 'h', session: 's' };
  const first = acquireSeedLock(repo, { ...self, now: 1 });
  assert.equal(releaseSeedLock(repo, first.owner).ok, true);
  const second = acquireSeedLock(repo, { ...self, now: 1 });
  assert.equal(second.ok, true);
  assert.equal(releaseSeedLock(repo, first.owner).reason, 'stale-handle');
  assert.equal(releaseSeedLock(repo, second.owner).ok, true);
});

test('a tuple-only handle cannot release a newer acquisition', () => {
  const repo = makeTempRepo();
  const self = { pid: process.pid, host: 'h', session: 's' };
  const first = acquireSeedLock(repo, { ...self, now: 1 });
  assert.equal(releaseSeedLock(repo, first.owner).ok, true);
  const second = acquireSeedLock(repo, { ...self, now: 1 });
  assert.equal(releaseSeedLock(repo, self).reason, 'stale-handle');
  assert.equal(inspectSeedLock(repo).present, true);
  assert.equal(releaseSeedLock(repo, second.owner).ok, true);
});

test('a refused acquirer never receives the release token and cannot release the live lock', () => {
  const repo = makeTempRepo();
  const held = acquireSeedLock(repo, { pid: process.pid, host: 'a', session: 'a' });
  const failed = acquireSeedLock(repo, { pid: process.pid, host: 'b', session: 'b' });
  assert.equal(failed.ok, false);
  assert.equal(failed.owner.token, undefined);
  assert.equal(inspectSeedLock(repo).owner.token, undefined);
  assert.equal(releaseSeedLock(repo, failed.owner).ok, false);
  assert.equal(releaseSeedLock(repo, { ...failed.owner, token: 'guess' }).reason, 'stale-handle');
  assert.equal(inspectSeedLock(repo).present, true);
  assert.equal(releaseSeedLock(repo, held.owner).ok, true);
});
