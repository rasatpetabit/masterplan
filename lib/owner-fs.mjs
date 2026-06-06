// lib/owner-fs.mjs — Guard D fs execution layer: the NFS-safe link/stat/rename/unlink protocol.
//
// The DECISION is pure (lib/owner.mjs decideOwnership); THIS module executes the filesystem side of an
// acquire/heartbeat/release and is composed by bin/masterplan.mjs's owner subcommands. It mirrors the
// lib/worktree-fs.mjs precedent (bin's fs helpers live in lib so they're unit-testable against a tmpdir).
// These files are an INTERNAL sentinel, NOT CD-7 state.yml — writing them is not a single-writer
// violation (no YAML contract, no bundle.mjs).
//
// NFS-safety rests on two POSIX atoms that survive a flaky NFS client:
//   - link(2)   — atomic create. We write a unique temp then hard-link it onto `.owner.lock`. Some NFS
//                 clients mis-report a transparently-retried link() as failed, so we DON'T trust link()'s
//                 return — we confirm via stat().nlink === 2 on our temp (lock + temp share the inode iff
//                 the link took). That nlink check is the authoritative "did I win the create" signal.
//   - rename(2) — atomic move/replace: a stale STEAL renames the dead lock AWAY (to a `.dead.*`
//                 graveyard) so the now-empty path can be re-created through the exclusive link() path; a
//                 --force takeover renames our identity OVER the lock; every heartbeat write is a
//                 temp→final rename. Last-writer-wins; a racing breaker re-reads and, on seeing a foreign
//                 identity, backs off.
//
// The owner refreshes ONLY its own per-owner heartbeat file (`.owner.hb.<host>.<session>`) and NEVER
// rewrites `.owner.lock` after creation — that separation is what makes a stalled owner's late heartbeat
// unable to clobber a successor's lock (the double-ownership guard).

import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  ownerLockPath,
  ownerHeartbeatPath,
  serializeOwnerLock,
  parseOwnerLock,
  isSelf,
  decideOwnership,
  OWNER_TTL_DEFAULT_MS,
} from './owner.mjs';

function rand() {
  return randomBytes(6).toString('hex');
}

function safeUnlink(p, _fs) {
  try {
    _fs.unlinkSync(p);
  } catch {
    /* already gone — fine */
  }
}

// ---- reads -------------------------------------------------------------------

// readIncumbent → the parsed `.owner.lock`, or null when absent/corrupt (callers treat corrupt as "no
// usable incumbent"; the doctor check surfaces a corrupt lock separately).
export function readIncumbent(bundleDir, _fs = fs) {
  try {
    return parseOwnerLock(_fs.readFileSync(ownerLockPath(bundleDir), 'utf8'));
  } catch {
    return null;
  }
}

// readLastHeartbeat → the incumbent's recorded heartbeat ts. Prefer the in-file `lastHeartbeat` (the
// writer's clock); fall back to the hb file's mtime; null when there's no hb file at all (decideOwnership
// then ages off incumbent.acquiredAt). Cross-host clock skew between epyc1/epyc2 is « the 30m TTL.
export function readLastHeartbeat(bundleDir, incumbent, _fs = fs) {
  if (!incumbent) return null;
  const hb = ownerHeartbeatPath(bundleDir, incumbent);
  try {
    const obj = JSON.parse(_fs.readFileSync(hb, 'utf8'));
    if (obj && Number.isFinite(Number(obj.lastHeartbeat))) return Number(obj.lastHeartbeat);
  } catch {
    /* unparseable / absent — try mtime next */
  }
  try {
    return _fs.statSync(hb).mtimeMs;
  } catch {
    return null;
  }
}

// ---- writes (the atomic primitives) ------------------------------------------

// atomicLinkCreate: write a unique temp, hard-link it onto lockPath, confirm via nlink===2 (NOT link()'s
// return — see header), then verify the lock content is OURS (defends against a racing breaker's rename).
// Returns true iff we now hold the lock. Always cleans up the temp.
function atomicLinkCreate(bundleDir, self, _fs) {
  const lockPath = ownerLockPath(bundleDir);
  const payload = serializeOwnerLock(self);
  const tmp = `${lockPath}.acq.${self.host}.${process.pid}.${rand()}`;
  _fs.writeFileSync(tmp, payload);
  let linked = false;
  try {
    _fs.linkSync(tmp, lockPath);
    linked = true;
  } catch {
    // EEXIST (lock already held by a different inode) OR a spurious NFS error after a transparent retry.
    // The authoritative check: did our temp's inode gain a second name?
    try {
      linked = _fs.statSync(tmp).nlink === 2;
    } catch {
      linked = false;
    }
  }
  if (!linked) {
    safeUnlink(tmp, _fs);
    return false;
  }
  // We hold the link. Read the lock back and confirm it's still our identity (a simultaneous stale-break
  // could have rename()d a foreign lock over it — last-writer-wins; we then back off).
  let back = null;
  try {
    back = parseOwnerLock(_fs.readFileSync(lockPath, 'utf8'));
  } catch {
    /* unreadable → treat as lost */
  }
  safeUnlink(tmp, _fs);
  return !!(back && isSelf(back, self));
}

// forceBreak: the HUMAN takeover (--force). rename our identity over whatever is there, then re-read to
// confirm WE won (last-writer-wins; an operator owns the consequence, and a human force is never run at
// scale). Returns true iff the lock is ours after the rename.
function forceBreak(bundleDir, self, _fs) {
  const lockPath = ownerLockPath(bundleDir);
  const tmp = `${lockPath}.brk.${self.host}.${process.pid}.${rand()}`;
  _fs.writeFileSync(tmp, serializeOwnerLock(self));
  _fs.renameSync(tmp, lockPath);
  let back = null;
  try {
    back = parseOwnerLock(_fs.readFileSync(lockPath, 'utf8'));
  } catch {
    /* unreadable → treat as lost */
  }
  return !!(back && isSelf(back, self));
}

// stealBreak: remove a STALE owner lock so a new acquirer can take the now-empty path. This is a
// PROVISIONAL coordination step, NOT an exactly-once mutual-exclusion primitive — see the module header.
//
// There is no atomic "remove path P iff it still resolves to the stale inode" on NFS (or POSIX), so the
// removal is unavoidably path-based: under a concurrent stale-break storm a late breaker's rename can
// evict a fresh successor and let more than one acquirer transiently believe it won. That is harmless
// CHURN, not a safety bug: the heartbeat re-check (heartbeatOwner → held-by-self for exactly the on-disk
// owner), run by the shell immediately after acquire and at the top of every turn, RESOLVES the transient
// multi-winner churn — exactly one proceeds and the rest get lost-to-other and STOP. This stale path is the
// home of the documented benign residual (a >TTL-abandoned owner resurrecting at the instant of reclaim —
// see lib/owner.mjs header); it is NOT live double-writes (a fresh contended lock is atomic). We keep a
// cheap "same generation + still past-TTL" re-check purely to REDUCE churn (don't evict an obviously-
// different fresh successor in the common case); it is a heuristic, not a correctness mechanism. Returns
// true iff THIS call removed a lock (so acquireOwner can report 'steal' vs 'acquire').
function stealBreak(bundleDir, self, observedStale, now, ttlMs, _fs) {
  const lockPath = ownerLockPath(bundleDir);
  const cur = readIncumbent(bundleDir, _fs);
  if (!cur || isSelf(cur, self)) return false; // already gone / became ours → re-decide
  // A different generation already replaced the stale lock we meant to break → leave it (churn reducer).
  if (
    cur.host !== observedStale.host ||
    cur.session !== observedStale.session ||
    cur.acquiredAt !== observedStale.acquiredAt
  ) {
    return false;
  }
  // Re-confirm it is STILL past-TTL (a heartbeat may have landed since we decided to steal).
  const last = readLastHeartbeat(bundleDir, cur, _fs);
  const ref = Number.isFinite(last) ? last : cur.acquiredAt;
  if (now - ref <= ttlMs) return false; // got heartbeated → no longer stale → re-decide (→ blocked)
  // Remove the stale lock so the empty path can be re-acquired through the exclusive link() create path.
  try {
    _fs.renameSync(lockPath, `${lockPath}.dead.${self.host}.${process.pid}.${rand()}`);
    return true;
  } catch {
    return false; // someone else already moved it — fine; the lock is gone either way
  }
}

// writeHeartbeat: refresh OUR OWN per-owner hb file via temp→rename (atomic). Records the writer's clock.
// Never touches `.owner.lock` (the double-ownership guard).
export function writeHeartbeat(bundleDir, self, now, _fs = fs) {
  const hb = ownerHeartbeatPath(bundleDir, self);
  const tmp = `${hb}.hb.${process.pid}.${rand()}`;
  _fs.writeFileSync(tmp, JSON.stringify({ lastHeartbeat: Number(now), host: self.host, session: self.session }));
  _fs.renameSync(tmp, hb);
}

// ---- the three operations ----------------------------------------------------

// acquireOwner — the kickoff/resume gate. Decides via the pure core, then executes the fs side, with a
// bounded retry to absorb the read→link race (a peer that acquired between our read and our link). The
// shell passes sameHostPidAlive:null (a session is not a probeable process) → TTL governs liveness.
export function acquireOwner(bundleDir, self, { now = 0, force = false, ttlMs } = {}, _fs = fs) {
  const ttlEff = Number.isFinite(ttlMs) ? ttlMs : OWNER_TTL_DEFAULT_MS;
  const MAX = 6; // a steal needs two passes (rename-away, then exclusive create) + race headroom.
  let incumbent = null;
  let stoleThisCall = false;
  for (let attempt = 0; attempt < MAX; attempt++) {
    incumbent = readIncumbent(bundleDir, _fs);
    const lastHeartbeat = readLastHeartbeat(bundleDir, incumbent, _fs);
    const decision = decideOwnership(incumbent, self, { lastHeartbeat, sameHostPidAlive: null }, now, { force, ttlMs });
    switch (decision.outcome) {
      case 'blocked':
        return { outcome: 'blocked', reason: decision.reason, incumbent };
      case 'held-by-self':
        writeHeartbeat(bundleDir, self, now, _fs);
        // Report 'steal' if we won the lock by breaking a stale one earlier in THIS call (the create
        // path lands on held-by-self/acquire); the caller cares that a takeover happened.
        return { outcome: stoleThisCall ? 'steal' : 'held-by-self', reason: decision.reason, identity: self };
      case 'acquire':
        if (atomicLinkCreate(bundleDir, self, _fs)) {
          writeHeartbeat(bundleDir, self, now, _fs);
          return { outcome: stoleThisCall ? 'steal' : 'acquire', reason: decision.reason, identity: self };
        }
        continue; // lost the create race → re-read + re-decide
      case 'steal':
        // Provisionally remove the stale lock (a path-based rename-away — see stealBreak; NOT exactly-once
        // on NFS), then re-loop into the exclusive link() create path. Mark stoleThisCall only when THIS
        // call actually removed a lock, so the reported outcome ('steal' vs 'acquire') reflects whether a
        // takeover happened — but note that report is PROVISIONAL until the heartbeat re-check confirms it.
        if (stealBreak(bundleDir, self, incumbent, now, ttlEff, _fs)) stoleThisCall = true;
        continue;
      case 'force':
        if (forceBreak(bundleDir, self, _fs)) {
          writeHeartbeat(bundleDir, self, now, _fs);
          return { outcome: 'force', reason: decision.reason, identity: self };
        }
        continue; // a simultaneous breaker won → re-read + re-decide
      default:
        return { outcome: decision.outcome, reason: decision.reason, incumbent };
    }
  }
  // Exhausted retries — someone else is actively contending; surface as blocked so the shell gates.
  return { outcome: 'blocked', reason: 'contention: exhausted acquire retries', incumbent };
}

// heartbeatOwner — the per-turn refresh + lost-ownership re-check (the held-by-self vs lost-to-other split).
// On lost-to-other the shell STOPS writing state and re-engages. This is a WRITE-CONFIRM, not a bare read:
// the initial read→decide is racy (a reclaimer can break our STALE lock between our read and our state
// write — decideOwnership intent:'heartbeat' deliberately does NOT age off self, so a slow-but-live owner
// keeps its lock). So we refresh our hb FIRST (which makes any concurrent stale-break re-confirm see us
// fresh and bail), then RE-READ `.owner.lock` and only claim held-by-self if it is STILL ours. This closes
// the common read→write race; a delayed-NFS-rename can still land after the re-read — the bounded, benign
// stale-takeover residual (see the lib/owner.mjs header: live contention is perfect; only a >TTL-abandoned
// owner resurrecting at the instant of reclaim can double-write).
export function heartbeatOwner(bundleDir, self, { now = 0 } = {}, _fs = fs) {
  const incumbent = readIncumbent(bundleDir, _fs);
  const decision = decideOwnership(incumbent, self, {}, now, { intent: 'heartbeat' });
  if (decision.outcome !== 'held-by-self') {
    return { outcome: 'lost-to-other', reason: decision.reason, incumbent };
  }
  writeHeartbeat(bundleDir, self, now, _fs);
  const after = readIncumbent(bundleDir, _fs);
  if (isSelf(after, self)) {
    return { outcome: 'held-by-self', reason: decision.reason };
  }
  // Stolen from in the read→write window. Don't strand the hb we just refreshed (the doctor WARNs on an
  // orphan hb), and tell the shell to STOP.
  safeUnlink(ownerHeartbeatPath(bundleDir, self), _fs);
  return { outcome: 'lost-to-other', reason: 'lock stolen during heartbeat (post-write re-read is foreign)', incumbent: after };
}

// releaseOwner — drop our lock + our hb at finish. Removes `.owner.lock` only when it is STILL ours AND
// still within TTL (the freshness gate); a foreign lock is left intact (never released on someone else's
// behalf) unless forced.
//
// THE FRESHNESS GATE (Codex round-3 fix). The old "re-read then path-unlink if isSelf" still raced: a
// successor that steals our STALE lock and recreates it in the window AFTER our re-read but BEFORE our
// unlink would have its fresh lock clobbered — stranding a live successor and opening a double-write. The
// fix plugs releaseOwner back into the SAME staleness predicate every other lock-op consults: a successor
// can ONLY steal a lock that is past-TTL. So a path-unlink is provably safe iff our lock is still WITHIN
// TTL — then no successor can exist to clobber. If our lock has gone stale we REFUSE to path-unlink and
// leave it for reclaim (a stale lock is exactly what a reclaimer is entitled to break). With all four
// lock-ops (acquire / heartbeat / stealBreak / release) now gated on staleness, there is no remaining op
// that path-mutates a lock it hasn't proven fresh-and-self.
//
// ORDERING (advisor catch): our own hb is LOAD-BEARING through the critical window — a concurrent breaker
// re-checks readLastHeartbeat and bails when it sees us fresh. So we sample freshness BEFORE deleting our
// hb, and on the release path unlink the LOCK first (hb still pins us fresh) and our hb LAST. Deleting the
// hb early would make readLastHeartbeat fall back to acquiredAt → a false "stale" → A refuses to release
// its own fresh lock → strands the bundle.
//
// The freshness gate engages whenever `now` is known (bin always defaults --now to Date.now(), so it is
// engaged in every production release), and uses the SAME staleness TTL a successor's acquire uses —
// ttlMs when threaded, else OWNER_TTL_DEFAULT_MS, mirroring acquireOwner's ttlEff so release and acquire
// can never disagree on what "stale" means. A caller that passes no `now` (legacy/test) degrades to the
// re-read-then-unlink check — correct for the uncontended release that is the overwhelmingly common case.
export function releaseOwner(bundleDir, self, { force = false, now, ttlMs } = {}, _fs = fs) {
  const incumbent = readIncumbent(bundleDir, _fs);
  const owned = isSelf(incumbent, self);
  if (force) {
    safeUnlink(ownerHeartbeatPath(bundleDir, self), _fs);
    safeUnlink(ownerLockPath(bundleDir), _fs);
    sweepGraveyard(bundleDir, _fs); // clear any .owner.lock.dead.* stale-break artifacts
    return { outcome: 'released', reason: owned ? 'released our lock' : 'forced release of a foreign lock' };
  }
  if (!owned) {
    safeUnlink(ownerHeartbeatPath(bundleDir, self), _fs);
    return { outcome: 'not-owner', reason: 'lock not held by us; left intact', incumbent };
  }
  // Owned at first read. Re-read immediately; keep our hb ON DISK (load-bearing — a concurrent breaker
  // re-checks readLastHeartbeat, sees us fresh, and bails).
  const before = readIncumbent(bundleDir, _fs);
  if (!isSelf(before, self)) {
    safeUnlink(ownerHeartbeatPath(bundleDir, self), _fs);
    return { outcome: 'not-owner', reason: 'lock reclaimed by another session before release; left intact', incumbent: before };
  }
  // Freshness gate. A path-unlink is safe ONLY if our lock is still WITHIN TTL: a successor can only steal a
  // STALE lock, so fresh ⟹ no successor exists to clobber. Sample BEFORE deleting our hb (see ORDERING).
  // ttlEff mirrors acquireOwner so release and acquire share one staleness predicate.
  if (Number.isFinite(now)) {
    const ttlEff = Number.isFinite(ttlMs) ? ttlMs : OWNER_TTL_DEFAULT_MS;
    const last = readLastHeartbeat(bundleDir, before, _fs);
    const ref = Number.isFinite(last) ? last : before.acquiredAt;
    if (now - ref > ttlEff) {
      safeUnlink(ownerHeartbeatPath(bundleDir, self), _fs);
      return { outcome: 'stale-not-released', reason: 'our lock is past TTL; a successor may be taking over — left for reclaim', incumbent: before };
    }
  }
  // Fresh + still ours → unlink the LOCK first (hb still pins us fresh), THEN our hb.
  safeUnlink(ownerLockPath(bundleDir), _fs);
  safeUnlink(ownerHeartbeatPath(bundleDir, self), _fs);
  sweepGraveyard(bundleDir, _fs); // clear any .owner.lock.dead.* stale-break artifacts
  return { outcome: 'released', reason: 'released our lock' };
}

// sweepGraveyard removes the stale-break artifacts — `.owner.lock.dead.*` (the rename-away graveyard) and
// any leaked `.owner.lock.brk*` temps (a --force takeover's temp survives only if its rename failed mid-op;
// harmless clutter, cleared by whoever finishes/forces the bundle so they don't accrete).
function sweepGraveyard(bundleDir, _fs) {
  try {
    for (const f of _fs.readdirSync(bundleDir)) {
      if (f.startsWith('.owner.lock.dead.') || f.startsWith('.owner.lock.brk')) {
        safeUnlink(`${stripSlash(bundleDir)}/${f}`, _fs);
      }
    }
  } catch {
    /* dir unreadable — nothing to sweep */
  }
}

function stripSlash(p) {
  const s = String(p ?? '');
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}
