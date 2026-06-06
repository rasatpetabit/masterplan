// test/owner.test.mjs — Guard D pure decision core (lib/owner.mjs).
//
// Identity is a SESSION (CLAUDE_CODE_SESSION_ID), not a process: stable across a session's turns, unique
// across sessions/hosts. `isSelf` is host+session equality; liveness is heartbeat-age TTL (the shell
// passes sameHostPidAlive:null because a session is not a probeable process).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ownerLockPath,
  ownerHeartbeatPath,
  buildOwnerIdentity,
  serializeOwnerLock,
  parseOwnerLock,
  isSelf,
  decideOwnership,
  OWNER_TTL_DEFAULT_MS,
} from '../lib/owner.mjs';

const SELF = { host: 'epyc1', session: 'sess-A', slug: 's', acquiredAt: 0 };
const OTHER = { host: 'epyc1', session: 'sess-B', slug: 's', acquiredAt: 0 };
const OTHER_HOST = { host: 'epyc2', session: 'sess-B', slug: 's', acquiredAt: 0 };

// ---- paths -------------------------------------------------------------------

test('ownerLockPath: appends .owner.lock; tolerates a trailing slash', () => {
  assert.equal(ownerLockPath('/r/docs/masterplan/s'), '/r/docs/masterplan/s/.owner.lock');
  assert.equal(ownerLockPath('/r/docs/masterplan/s/'), '/r/docs/masterplan/s/.owner.lock');
});

test('ownerHeartbeatPath: per-owner file, host/session in name, sanitized', () => {
  assert.equal(
    ownerHeartbeatPath('/b', { host: 'epyc1', session: 'abc123' }),
    '/b/.owner.hb.epyc1.abc123'
  );
  // An NFS host alias with dots/slashes (and a UUID with hyphens) is flattened so the filename stays flat.
  assert.equal(
    ownerHeartbeatPath('/b', { host: 'epyc1.nfs/zone', session: 'a1b2-c3d4' }),
    '/b/.owner.hb.epyc1-nfs-zone.a1b2-c3d4'
  );
});

test('ownerHeartbeatPath of two different owners never collides (the double-ownership guard)', () => {
  const a = ownerHeartbeatPath('/b', { host: 'epyc1', session: 'sess-A' });
  const b = ownerHeartbeatPath('/b', { host: 'epyc2', session: 'sess-A' });
  const c = ownerHeartbeatPath('/b', { host: 'epyc1', session: 'sess-B' });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});

// ---- identity / serialize / parse --------------------------------------------

test('buildOwnerIdentity: assembles the token; stamps acquiredAt from now', () => {
  const id = buildOwnerIdentity({ host: 'epyc1', session: 'sess-A', slug: 's', now: 1234 });
  assert.deepEqual(id, { host: 'epyc1', session: 'sess-A', slug: 's', acquiredAt: 1234 });
});

test('buildOwnerIdentity: fails loud on missing host/session', () => {
  assert.throws(() => buildOwnerIdentity({ session: 'x' }), /host is required/);
  assert.throws(() => buildOwnerIdentity({ host: 'h' }), /session is required/);
});

test('serialize → parse round-trips the identity', () => {
  const id = buildOwnerIdentity({ host: 'epyc1', session: 'sess-A', slug: 's', now: 42 });
  assert.deepEqual(parseOwnerLock(serializeOwnerLock(id)), id);
});

test('parseOwnerLock: null on absent / empty / corrupt / incomplete input', () => {
  assert.equal(parseOwnerLock(null), null);
  assert.equal(parseOwnerLock(''), null);
  assert.equal(parseOwnerLock('   '), null);
  assert.equal(parseOwnerLock('{not json'), null);
  assert.equal(parseOwnerLock('"a string"'), null);
  assert.equal(parseOwnerLock('{"host":"h"}'), null); // missing session
  assert.equal(parseOwnerLock('{"session":"s"}'), null); // missing host
});

test('isSelf: requires host + session to match (session id is the identity)', () => {
  assert.equal(isSelf(SELF, SELF), true);
  assert.equal(isSelf({ ...SELF, session: 'sess-Z' }, SELF), false); // same host, different session
  assert.equal(isSelf({ ...SELF, host: 'epyc2' }, SELF), false); // same session, different host (copied lock)
  assert.equal(isSelf(null, SELF), false);
});

// ---- decideOwnership: acquire intent -----------------------------------------

test('acquire: no incumbent → acquire', () => {
  assert.equal(decideOwnership(null, SELF, {}, 0).outcome, 'acquire');
});

test('acquire: incumbent is us → held-by-self (idempotent re-acquire across turns)', () => {
  assert.equal(decideOwnership({ ...SELF }, SELF, {}, 0).outcome, 'held-by-self');
});

test('acquire: same-host incumbent ALIVE (caller-supplied) → blocked (even past TTL)', () => {
  const now = OWNER_TTL_DEFAULT_MS * 10; // way past TTL
  const d = decideOwnership(OTHER, SELF, { sameHostPidAlive: true, lastHeartbeat: 0 }, now);
  assert.equal(d.outcome, 'blocked');
});

test('acquire: same-host incumbent DEAD (caller-supplied) → steal immediately (do not wait out the TTL)', () => {
  const d = decideOwnership(OTHER, SELF, { sameHostPidAlive: false, lastHeartbeat: 0 }, 1);
  assert.equal(d.outcome, 'steal');
});

test('acquire: same-host incumbent, NO liveness probe (the masterplan default) → TTL path, fresh → blocked', () => {
  const now = 1000;
  const d = decideOwnership(OTHER, SELF, { sameHostPidAlive: null, lastHeartbeat: now - 10 }, now, { ttlMs: 1000 });
  assert.equal(d.outcome, 'blocked');
});

test('acquire: same-host incumbent, NO liveness probe, heartbeat STALE → steal (TTL governs)', () => {
  const now = 10_000;
  const d = decideOwnership(OTHER, SELF, { sameHostPidAlive: null, lastHeartbeat: 0 }, now, { ttlMs: 1000 });
  assert.equal(d.outcome, 'steal');
});

test('acquire: cross-host incumbent, heartbeat FRESH → blocked (TTL not exceeded)', () => {
  const now = 1000;
  const d = decideOwnership(
    OTHER_HOST,
    SELF,
    { sameHostPidAlive: null, lastHeartbeat: now - 10 },
    now,
    { ttlMs: 1000 }
  );
  assert.equal(d.outcome, 'blocked');
});

test('acquire: cross-host incumbent, heartbeat STALE → steal (TTL-only, no probe possible)', () => {
  const now = 10_000;
  const d = decideOwnership(
    OTHER_HOST,
    SELF,
    { sameHostPidAlive: null, lastHeartbeat: 0 },
    now,
    { ttlMs: 1000 }
  );
  assert.equal(d.outcome, 'steal');
});

test('acquire: cross-host with NO heartbeat falls back to incumbent.acquiredAt for the age', () => {
  const incumbent = { ...OTHER_HOST, acquiredAt: 0 };
  const now = 10_000;
  // lastHeartbeat null → age = now - acquiredAt = 10_000 > ttl → steal.
  const d = decideOwnership(incumbent, SELF, { sameHostPidAlive: null, lastHeartbeat: null }, now, { ttlMs: 1000 });
  assert.equal(d.outcome, 'steal');
});

test('acquire: --force → force, regardless of a live incumbent', () => {
  const d = decideOwnership(OTHER, SELF, { sameHostPidAlive: true, lastHeartbeat: 0 }, 0, { force: true });
  assert.equal(d.outcome, 'force');
});

// ---- decideOwnership: heartbeat intent (the pre-write re-check) ---------------

test('heartbeat: still ours → held-by-self', () => {
  const d = decideOwnership({ ...SELF }, SELF, {}, 0, { intent: 'heartbeat' });
  assert.equal(d.outcome, 'held-by-self');
});

test('heartbeat: lock now owned by another → lost-to-other (stop writing state)', () => {
  const d = decideOwnership(OTHER, SELF, {}, 0, { intent: 'heartbeat' });
  assert.equal(d.outcome, 'lost-to-other');
});

test('heartbeat: lock vanished entirely → lost-to-other', () => {
  const d = decideOwnership(null, SELF, {}, 0, { intent: 'heartbeat' });
  assert.equal(d.outcome, 'lost-to-other');
});

test('heartbeat: a same-host lock from a DIFFERENT session is NOT self → lost-to-other', () => {
  const d = decideOwnership({ ...SELF, session: 'sess-Z' }, SELF, {}, 0, { intent: 'heartbeat' });
  assert.equal(d.outcome, 'lost-to-other');
});
