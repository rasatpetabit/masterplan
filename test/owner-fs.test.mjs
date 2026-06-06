// test/owner-fs.test.mjs — Guard D fs execution layer (lib/owner-fs.mjs) against a real tmpdir.
// Exercises the real link/stat/rename/unlink protocol (a local tmpdir; the epyc1/epyc2 shared-FS
// stress test is the separate acceptance gate). Identity is the session model (host + session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireOwner,
  heartbeatOwner,
  releaseOwner,
  readIncumbent,
  readLastHeartbeat,
  writeHeartbeat,
} from '../lib/owner-fs.mjs';
import { ownerLockPath, ownerHeartbeatPath, buildOwnerIdentity, parseOwnerLock, serializeOwnerLock } from '../lib/owner.mjs';

function tmpBundle() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mp-owner-'));
}
const A = (now = 0) => buildOwnerIdentity({ host: 'epyc1', session: 'sess-A', slug: 's', now });
const B = (now = 0) => buildOwnerIdentity({ host: 'epyc2', session: 'sess-B', slug: 's', now });

test('acquire on a fresh bundle → acquire; lock + hb files land with our identity', () => {
  const dir = tmpBundle();
  const r = acquireOwner(dir, A(1000), { now: 1000 });
  assert.equal(r.outcome, 'acquire');
  const lock = parseOwnerLock(fs.readFileSync(ownerLockPath(dir), 'utf8'));
  assert.equal(lock.session, 'sess-A');
  assert.equal(lock.host, 'epyc1');
  // The lock inode is back to a single link after the temp is cleaned up.
  assert.equal(fs.statSync(ownerLockPath(dir)).nlink, 1);
  // Our heartbeat file exists and records the acquire-time clock.
  const hb = JSON.parse(fs.readFileSync(ownerHeartbeatPath(dir, A()), 'utf8'));
  assert.equal(hb.lastHeartbeat, 1000);
});

test('re-acquire by the same session → held-by-self (idempotent across turns), refreshes hb', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(1000), { now: 1000 });
  const r = acquireOwner(dir, A(2000), { now: 2000 });
  assert.equal(r.outcome, 'held-by-self');
  assert.equal(readLastHeartbeat(dir, readIncumbent(dir), fs), 2000);
});

test('acquire while a FRESH foreign lock is held → blocked (no fs mutation)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, B(1000), { now: 1000 }); // peer holds it, just heartbeated
  const before = fs.readFileSync(ownerLockPath(dir), 'utf8');
  const r = acquireOwner(dir, A(1500), { now: 1500, ttlMs: 1000 });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.incumbent.session, 'sess-B');
  assert.equal(fs.readFileSync(ownerLockPath(dir), 'utf8'), before); // untouched
});

test('acquire while a STALE foreign lock is held → steal (rename replaces it with us)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, B(0), { now: 0 }); // peer acquired at t=0, hb=0
  const r = acquireOwner(dir, A(5000), { now: 5000, ttlMs: 1000 }); // 5000 > ttl → stale
  assert.equal(r.outcome, 'steal');
  assert.equal(readIncumbent(dir).session, 'sess-A');
});

test('--force steals a fresh live foreign lock (human takeover)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, B(1000), { now: 1000 });
  const r = acquireOwner(dir, A(1100), { now: 1100, force: true });
  assert.equal(r.outcome, 'force');
  assert.equal(readIncumbent(dir).session, 'sess-A');
});

test('heartbeat while we hold the lock → held-by-self; updates the recorded ts', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(1000), { now: 1000 });
  const r = heartbeatOwner(dir, A(4000), { now: 4000 });
  assert.equal(r.outcome, 'held-by-self');
  assert.equal(readLastHeartbeat(dir, readIncumbent(dir), fs), 4000);
});

test('heartbeat after being stolen from → lost-to-other (do NOT rewrite the lock or a foreign hb)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(0), { now: 0 });
  acquireOwner(dir, B(5000), { now: 5000, ttlMs: 1000 }); // B steals the stale lock
  const r = heartbeatOwner(dir, A(6000), { now: 6000 });
  assert.equal(r.outcome, 'lost-to-other');
  assert.equal(readIncumbent(dir).session, 'sess-B'); // lock still B's — A did not clobber it
});

test('release by the owner removes both the lock and our hb', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(1000), { now: 1000 });
  const r = releaseOwner(dir, A(1000), {});
  assert.equal(r.outcome, 'released');
  assert.equal(fs.existsSync(ownerLockPath(dir)), false);
  assert.equal(fs.existsSync(ownerHeartbeatPath(dir, A())), false);
});

test('release by a NON-owner leaves the foreign lock intact (not-owner)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, B(1000), { now: 1000 });
  const r = releaseOwner(dir, A(1000), {});
  assert.equal(r.outcome, 'not-owner');
  assert.equal(fs.existsSync(ownerLockPath(dir)), true);
  assert.equal(readIncumbent(dir).session, 'sess-B');
});

test('release --force drops even a foreign lock (human takeover cleanup)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, B(1000), { now: 1000 });
  const r = releaseOwner(dir, A(1000), { force: true });
  assert.equal(r.outcome, 'released');
  assert.equal(fs.existsSync(ownerLockPath(dir)), false);
});

test('a spurious-link-failure-but-nlink-2 NFS retry is treated as a WIN (the authoritative nlink check)', () => {
  const dir = tmpBundle();
  // Wrap fs so linkSync throws AFTER actually creating the link — the exact NFS misreport we guard against.
  const wrapped = {
    ...fs,
    linkSync: (src, dest) => {
      fs.linkSync(src, dest); // the link really happens
      throw Object.assign(new Error('spurious NFS EIO after a transparent retry'), { code: 'EIO' });
    },
  };
  const r = acquireOwner(dir, A(1000), { now: 1000 }, wrapped);
  assert.equal(r.outcome, 'acquire'); // nlink===2 confirmed the win despite link() throwing
  assert.equal(readIncumbent(dir).session, 'sess-A');
});

test('heartbeat: a steal landing between the read and the post-write re-read → lost-to-other (Fix 1: write-confirm)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(0), { now: 0 }); // A holds the lock (real fs)
  let stole = false;
  // writeHeartbeat refreshes A's OWN hb via a temp→hb rename — that rename is the exact moment AFTER the
  // initial read/decide and BEFORE heartbeatOwner's post-write re-read. Inject a concurrent steal by B there
  // so the post-write re-read of .owner.lock sees a foreign owner. Without Fix 1 (bare read→decide→write,
  // no re-read) heartbeatOwner would have returned held-by-self off the stale read and A would have written.
  const wrapped = {
    ...fs,
    renameSync: (src, dest) => {
      fs.renameSync(src, dest);
      if (String(dest).includes('.owner.hb.') && !stole) {
        stole = true;
        fs.writeFileSync(ownerLockPath(dir), serializeOwnerLock(B(9000)));
      }
    },
  };
  const r = heartbeatOwner(dir, A(8000), { now: 8000 }, wrapped);
  assert.equal(r.outcome, 'lost-to-other'); // the post-write re-read caught the steal
  assert.equal(r.incumbent.session, 'sess-B');
  // Fix 1 also unlinks the hb we just refreshed, so the doctor doesn't WARN on an orphan hb under B's lock.
  assert.equal(fs.existsSync(ownerHeartbeatPath(dir, A())), false);
});

test('release: a STALE owned lock is NOT path-unlinked (freshness gate — a successor may be mid-takeover)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(0), { now: 0 }); // A acquires + heartbeats at t=0
  // Release at t=5000 with a 1000ms TTL → A's lock is 5000ms old, far past TTL. A successor can only have
  // stolen a STALE lock, so a path-unlink here would risk clobbering that successor's fresh recreate. The
  // freshness gate must REFUSE: leave the lock for the reclaim path, return stale-not-released.
  const r = releaseOwner(dir, A(0), { now: 5000, ttlMs: 1000 });
  assert.equal(r.outcome, 'stale-not-released');
  assert.equal(readIncumbent(dir).session, 'sess-A'); // lock left intact for the reclaimer
  // Our own hb IS dropped (we're leaving — we just don't yank the lock out from under a possible successor).
  assert.equal(fs.existsSync(ownerHeartbeatPath(dir, A())), false);
});

test('release: a FRESH owned lock with the gate engaged → released (within-TTL ⟹ no successor can exist)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(0), { now: 0 });
  // Release at t=900 with a 1000ms TTL → 900 <= 1000, still fresh. No successor could have stolen a fresh
  // lock, so the path-unlink is provably safe. Both lock and our hb come off.
  const r = releaseOwner(dir, A(900), { now: 900, ttlMs: 1000 });
  assert.equal(r.outcome, 'released');
  assert.equal(fs.existsSync(ownerLockPath(dir)), false);
  assert.equal(fs.existsSync(ownerHeartbeatPath(dir, A())), false);
});

test('readLastHeartbeat falls back to mtime when the hb file is unparseable', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(1000), { now: 1000 });
  fs.writeFileSync(ownerHeartbeatPath(dir, A()), 'corrupt-not-json');
  const ts = readLastHeartbeat(dir, readIncumbent(dir), fs);
  assert.ok(Number.isFinite(ts)); // mtimeMs, not null
});

test('writeHeartbeat never touches .owner.lock (the double-ownership guard)', () => {
  const dir = tmpBundle();
  acquireOwner(dir, A(1000), { now: 1000 });
  const lockBefore = fs.readFileSync(ownerLockPath(dir), 'utf8');
  writeHeartbeat(dir, A(), 9999, fs);
  assert.equal(fs.readFileSync(ownerLockPath(dir), 'utf8'), lockBefore);
});
