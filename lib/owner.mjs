// lib/owner.mjs — Guard D: NFS-safe cross-session owner sentinel (PURE decision core).
//
// Two sessions (possibly on different NFS clients — epyc1/epyc2) must not operate the SAME run bundle
// concurrently. `writeState` is an atomic WRITE, not a test-and-set, so a `state.yml` owner *field*
// cannot provide mutual exclusion. This module is the pure decision core; the fs primitives (link /
// stat / rename / unlink) live in `lib/owner-fs.mjs` (the NFS-safe execution layer, composed by
// bin/masterplan.mjs's owner subcommands). The acceptance gate is a real shared-FS stress test on
// epyc1/epyc2 — keep the fs layer thin and the decision here.
//
// IDENTITY IS A SESSION, NOT A PROCESS.
//   The masterplan "owner" is an LLM session spanning many turns. Each `mp` invocation is an EPHEMERAL
//   OS process that exits immediately — its pid/start-time change every call and `kill(pid,0)` on the
//   acquiring process always reports dead. The session-stable, re-derivable anchor is the Claude Code
//   session id (`CLAUDE_CODE_SESSION_ID`, a UUID): identical across every turn of one session, distinct
//   across sessions and hosts. So identity = { host, session } and `isSelf` is session-id equality. A
//   UUID needs no PID-reuse guard, so there is no `startTime` field.
//
// TWO FILES, deliberately separate (the advisor's double-ownership fix):
//   `.owner.lock`                — the IMMUTABLE ownership token. Created by an atomic link() (NFS-safe),
//                                  changed ONLY by a release (unlink) or a stale-break (a new acquirer
//                                  replacing it). Holds the owner identity payload. The owner NEVER
//                                  rewrites it after creation.
//   `.owner.hb.<host>.<session>` — the per-owner LIVENESS file. The owner refreshes ITS OWN heartbeat
//                                  file and NEVER rewrites `.owner.lock`. A separate file per owner is
//                                  what prevents the double-ownership race: a stalled owner's late
//                                  heartbeat can never clobber a successor's `.owner.lock` (it only
//                                  touches its own hb).
//
// WHAT THIS GUARANTEES — AND WHAT IT HONESTLY DOES NOT (read before "hardening" the race away).
//   Perfect single-writer mutual exclusion is IMPOSSIBLE on NFS without a real lock manager, so do not chase
//   it — this module makes a narrower, honest promise:
//
//   • PERFECT mutual exclusion for LIVE contention. The fresh-lock path (link() onto an absent lock,
//     confirmed by nlink===2) is a true atomic create — when two live sessions race for an UNheld bundle,
//     exactly one wins the link and the other cleanly resolves to `blocked`. No live double-write is possible.
//
//   • A BOUNDED, BENIGN residual ONLY in the stale-takeover path. `acquire`/`steal` are OPTIMISTIC outcomes:
//     a STALE-break must first remove the dead lock, and there is no atomic "remove path P iff it still
//     resolves to inode I" on NFS, so the removal is path-based. The ONLY way to a durable double-write is:
//     an owner goes silent past the full TTL (default 30m) → a reclaimer breaks its abandoned lock → and the
//     abandoned owner RESURRECTS and writes at the exact instant of reclaim. That window is narrow, requires
//     a >TTL-dead session to come back from the dead, and is the documented limitation — not a bug to add an
//     iteration-N mechanism for. The break-token / mutex variants we tried each just moved this same residual.
//
//   The `intent:'heartbeat'` re-check (held-by-self vs lost-to-other) is the boundary that RESOLVES transient
//   multi-winner churn into a single proceeding writer: the shell runs it immediately after a provisional
//   acquire AND at the top of every turn, and under live contention exactly one contender resolves to
//   held-by-self while the rest get lost-to-other and STOP. The UNIT OF PROTECTION is the TURN, not the
//   individual write — a turn re-heartbeats at its entry (step 1.6 / §2a step 0). Treat a returned
//   `acquire`/`steal` as "proceed to the confirm step", not "won".
//
// Staleness has two independent signals, combined by decideOwnership:
//   1. Heartbeat age  — `now - lastHeartbeat > ttlMs`. TTL MUST exceed the max single WAVE, because the
//      orchestrator is an LLM that only regains control (to heartbeat) at turn/wave boundaries; during a
//      long background wave there is no opportunity to heartbeat. Default 30m, configurable. This is the
//      PRIMARY (and, for a session with no persistent process, the only realistic) liveness signal.
//   2. Same-host PID liveness — `sameHostPidAlive` (a tri-state). It is retained as a general OVERRIDE
//      for callers who CAN cheaply probe a same-host owner process, but the masterplan shell has no such
//      probe (a session is not a single process), so it passes `null` and the TTL path governs. When a
//      caller does supply it for a same-host incumbent:
//        same-host + alive  → NEVER steal (a slow-but-alive owner is not stale, even past TTL).
//        same-host + dead   → steal IMMEDIATELY (don't wait out the TTL on a provably-dead local owner).
//        cross-host / null  → fall back to the heartbeat-age TTL (we cannot probe a remote owner).

const DEFAULT_TTL_MS = 1_800_000; // 30 minutes — must exceed the max single wave (see header).

// ---- paths -------------------------------------------------------------------

export function ownerLockPath(bundleDir) {
  return `${stripTrailingSlash(bundleDir)}/.owner.lock`;
}

// The per-owner heartbeat file. Host/session in the name → each owner gets its OWN file; refreshing it
// can never touch another owner's lock or hb. Both components are sanitized (an NFS host alias could
// contain a dot or slash) so the filename stays flat.
export function ownerHeartbeatPath(bundleDir, identity) {
  const host = sanitizeComponent(identity?.host ?? 'unknown');
  const session = sanitizeComponent(String(identity?.session ?? 'nosession'));
  return `${stripTrailingSlash(bundleDir)}/.owner.hb.${host}.${session}`;
}

function stripTrailingSlash(p) {
  const s = String(p ?? '');
  return s.length > 1 && s.endsWith('/') ? s.slice(0, -1) : s;
}

function sanitizeComponent(s) {
  // Keep the filename flat + safe: collapse anything outside [A-Za-z0-9_-] to '-'.
  return String(s).replace(/[^A-Za-z0-9_-]+/g, '-');
}

// ---- identity ----------------------------------------------------------------

// buildOwnerIdentity assembles the immutable token payload. `session` (the Claude Code session id) is
// the identity: stable across a session's turns, unique across sessions/hosts. The shell supplies
// host/session/now (env + clock primitives belong to bin); this stays pure.
export function buildOwnerIdentity({ host, session, slug, now } = {}) {
  if (!host) throw new Error('buildOwnerIdentity: host is required');
  if (!session) throw new Error('buildOwnerIdentity: session is required');
  return {
    host: String(host),
    session: String(session),
    slug: slug != null ? String(slug) : null,
    acquiredAt: Number(now ?? 0),
  };
}

// serialize/parse use JSON (this is an internal sentinel, NOT CD-7 state.yml — no YAML contract here).
export function serializeOwnerLock(identity) {
  return JSON.stringify(identity);
}

// parseOwnerLock returns the identity object, or null on absent/malformed input (a corrupt lock is
// treated as "no usable incumbent" by callers, and surfaced by the doctor check).
export function parseOwnerLock(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  if (!obj.host || !obj.session) return null;
  return {
    host: String(obj.host),
    session: String(obj.session),
    slug: obj.slug != null ? String(obj.slug) : null,
    acquiredAt: Number(obj.acquiredAt ?? 0),
  };
}

// isSelf — session id equality (the UUID is the identity; host must also match as a defensive guard
// against a lock copied across hosts, since a session is pinned to the host it runs on).
export function isSelf(incumbent, self) {
  if (!incumbent || !self) return false;
  return incumbent.host === self.host && incumbent.session === self.session;
}

// ---- the decision ------------------------------------------------------------
//
// decideOwnership(incumbent, self, liveness, now, opts) → { outcome, reason }
//
//   incumbent : parsed `.owner.lock` (or null when the file is absent/corrupt).
//   self      : our buildOwnerIdentity().
//   liveness  : { lastHeartbeat:<ts|null>, sameHostPidAlive:true|false|null } — about the INCUMBENT.
//               lastHeartbeat is the recorded ts of the incumbent's `.owner.hb.*` (or its acquiredAt
//               when no hb exists yet). sameHostPidAlive is null for the masterplan shell (a session is
//               not a probeable process) and for any cross-host incumbent — the TTL path governs both.
//   opts      : { ttlMs?, force?, intent?: 'acquire'|'heartbeat' }.
//
// Outcomes:
//   acquire        — no incumbent → take the lock (link()).
//   held-by-self   — the incumbent IS us → refresh our heartbeat and proceed.
//   steal          — the incumbent is a stale/dead OTHER → break its lock and acquire.
//   blocked        — the incumbent is a live OTHER → cannot proceed (shell surfaces force/abort/RO AUQ).
//   lost-to-other  — intent:'heartbeat' but the lock is gone or now owned by someone else → we were
//                    stolen from; STOP writing state, re-acquire or abort. (The advisor's explicit
//                    held-by-self vs lost-to-other split — the owner re-checks before every state write.)
//   force          — opts.force human takeover → break + acquire regardless of incumbent liveness.
export function decideOwnership(incumbent, self, liveness = {}, now = 0, opts = {}) {
  const intent = opts.intent ?? 'acquire';
  const ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;

  // Human force-takeover short-circuits everything (the operator owns the consequence).
  if (opts.force) {
    return { outcome: 'force', reason: 'human --force takeover' };
  }

  // A heartbeat/refresh re-check by someone who believes they hold the lock.
  if (intent === 'heartbeat') {
    if (!incumbent) return { outcome: 'lost-to-other', reason: 'lock vanished (no .owner.lock)' };
    if (isSelf(incumbent, self)) return { outcome: 'held-by-self', reason: 'we still hold the lock' };
    return { outcome: 'lost-to-other', reason: 'lock now held by another owner' };
  }

  // Acquire intent.
  if (!incumbent) return { outcome: 'acquire', reason: 'no incumbent lock' };
  if (isSelf(incumbent, self)) return { outcome: 'held-by-self', reason: 're-acquire of our own lock' };

  // The incumbent is some OTHER owner. Decide live vs stale.
  const sameHost = incumbent.host === self.host;
  if (sameHost) {
    if (liveness.sameHostPidAlive === true) {
      return { outcome: 'blocked', reason: 'incumbent session alive on this host' };
    }
    if (liveness.sameHostPidAlive === false) {
      return { outcome: 'steal', reason: 'incumbent session dead on this host' };
    }
    // null/undefined on the same host (the masterplan default): fall through to the TTL path.
  }

  // Cross-host (or same-host indeterminate): heartbeat-age TTL is the only available signal.
  const last = Number.isFinite(liveness.lastHeartbeat) ? liveness.lastHeartbeat : incumbent.acquiredAt;
  const age = now - last;
  if (age > ttlMs) {
    return { outcome: 'steal', reason: `incumbent heartbeat stale (age ${age}ms > ttl ${ttlMs}ms)` };
  }
  return { outcome: 'blocked', reason: `incumbent heartbeat fresh (age ${age}ms <= ttl ${ttlMs}ms)` };
}

export const OWNER_TTL_DEFAULT_MS = DEFAULT_TTL_MS;
