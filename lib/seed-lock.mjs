// lib/seed-lock.mjs — repo-wide seed lock: atomic exclusive creation of
// docs/masterplan/.seed.lock with PID/ownership metadata, live-lock refusal,
// and owner-safe release. Mirrors the atomic-create idiom of lib/owner-fs.mjs
// (link/rename there; open 'wx' here — the seed lock is a plain file, not a
// hard-link dance, because it is held only across validate-then-create and is
// broken by `mp sweep` when its recorded pid is dead).

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const SEED_LOCK_RELPATH = 'docs/masterplan/.seed.lock';

function lockPath(repoRoot) {
  return path.join(repoRoot, SEED_LOCK_RELPATH);
}

function isValidOwner({ pid, host, session }) {
  return Number.isInteger(pid) && pid > 0 &&
    typeof host === 'string' && host.length > 0 &&
    typeof session === 'string' && session.length > 0;
}

// The release token is a capability: only the acquirer's own handle carries it. Every view handed
// to another party (a refused acquirer, inspection) strips it so nobody else can release the lock.
function publicOwner(owner) {
  if (!owner) return null;
  const { token, ...rest } = owner;
  return rest;
}

function readOwner(repoRoot) {
  let raw;
  try {
    raw = fs.readFileSync(lockPath(repoRoot), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const obj = JSON.parse(raw);
    if (obj && isValidOwner(obj) && Number.isFinite(obj.acquired_at) && typeof obj.token === 'string' && obj.token.length > 0) {
      return { pid: obj.pid, host: obj.host, session: obj.session, acquired_at: obj.acquired_at, token: obj.token };
    }
    return null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // exists but not ours; ESRCH means dead
  }
}

export function acquireSeedLock(repoRoot, { pid, host, session, now } = {}) {
  if (!isValidOwner({ pid, host, session })) {
    return { ok: false, reason: 'invalid-owner' };
  }
  const acquired_at = Number.isFinite(now) ? Number(now) : Date.now();
  // token: a per-acquisition identity, so a stale handle from an earlier acquisition by the same
  // pid/host/session (even at the same millisecond) can never release a newer lock.
  const owner = { pid, host, session, acquired_at, token: randomBytes(8).toString('hex') };
  const payload = JSON.stringify(owner);
  const target = lockPath(repoRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Publish-after-write: the metadata is written (and fsynced) to a private temp file first, then
  // hard-linked into place atomically. The lock path therefore never exists without valid
  // metadata — a crash at any point leaves either no lock or a complete one (mirrors owner-fs).
  const tmp = `${target}.${pid}.${owner.token}.tmp`;
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } catch (err) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.linkSync(tmp, target);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    if (err.code === 'EEXIST') {
      return { ok: false, reason: 'locked', owner: publicOwner(readOwner(repoRoot)) };
    }
    throw err;
  }
  try { fs.unlinkSync(tmp); } catch { /* the link is what matters */ }
  return { ok: true, owner };
}

export function releaseSeedLock(repoRoot, self) {
  const owner = readOwner(repoRoot);
  if (owner === undefined) return { ok: false, reason: 'not-locked' };
  if (owner === null) return { ok: false, reason: 'malformed' };
  if (!(owner.pid === self.pid && owner.host === self.host && owner.session === self.session)) {
    return { ok: false, reason: 'not-owner' };
  }
  // Release is handle-based: only the object returned by acquireSeedLock (carrying the
  // per-acquisition token) may release, so a stale or tuple-only handle can never unlink a
  // newer lock held by the same pid/host/session. Dead-owner locks are broken by `mp sweep`.
  if (typeof self.token !== 'string' || self.token !== owner.token) {
    return { ok: false, reason: 'stale-handle' };
  }
  try {
    fs.unlinkSync(lockPath(repoRoot));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { ok: true, reason: 'released' };
}

export function inspectSeedLock(repoRoot, { isAlive } = {}) {
  const owner = readOwner(repoRoot);
  if (owner === undefined) return { present: false, owner: null, alive: false };
  if (owner === null) return { present: true, owner: null, alive: false, malformed: true };
  const alive = isAlive ? Boolean(isAlive(owner.pid)) : isPidAlive(owner.pid);
  return { present: true, owner: publicOwner(owner), alive };
}
