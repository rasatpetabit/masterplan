// lib/dispatch-wave.mjs — the `dispatch_fabric` op consumer (`mp dispatch-wave`).
//
// Chunk B of the wave-dispatch outage fix: lib/dispatch/ops.mjs has emitted the
// `dispatch_fabric` op since the strangler flag landed, but NOTHING consumed it —
// the L1 op table listed only launch_workflow / dispatch_foreground, so masterplan
// waves never reached the agent-dispatch broker. This module is the missing
// consumer: a deterministic, zero-LLM-token wave dispatcher that drives the
// broker's dispatch_fanout for the active wave and feeds the digests into the
// SAME record-result transaction every other dispatch vehicle uses.
//
// Flow (dispatchWaveViaFabric):
//   1. Flag gate — state.dispatch.fabric must be true (the same per-run strangler
//      flag lib/continue.mjs reads when it emits the op); off → no-op, never dispatch.
//   2. Wave — the phase-1 `active_run` launching marker `mp continue` wrote
//      (dispatchWave in lib/continue.mjs) names the wave and carries the frozen
//      baseline/scope; a promoted (task_id) or plan marker is refused loudly.
//   3. WAVE-DISPATCH IDEMPOTENCY (review-mandated): a stable key
//      (run_id, wave, 'dispatch_fabric') with atomic create-or-return-existing
//      semantics over a per-wave record file INSIDE the run bundle
//      (wave-<N>.dispatch.json, O_EXCL create + tmp/rename update — the same
//      atomicity idiom as bundle.mjs writeState). The record is persisted BEFORE
//      the broker call; an L1 retry or masterplan restart after an
//      accepted-but-unobserved dispatch finds status:'pending' and returns the
//      existing record WITHOUT re-dispatching. Statuses:
//        pending    — broker call in flight / accepted-but-unobserved (never re-dispatch;
//                     `--takeover` supersedes an operator-confirmed-dead attempt)
//        dispatched — digests durable in the record, record-result transaction not yet
//                     durable (re-invoke RE-DRIVES record-result from the stored result;
//                     the broker is never called again)
//        recorded   — the record transaction completed; a re-invoke with pending tasks
//                     remaining starts attempt N+1 (a recover_and_redispatch retry is
//                     an OBSERVED outcome, not a double-dispatch)
//      Attempt N+1 (and --takeover) transitions rewrite the record via tmp/rename,
//      so they are additionally serialized by an O_EXCL ATTEMPT MARKER
//      (wave-<N>.dispatch.attempt-<K>): exactly one concurrent retry claims the
//      attempt; the loser re-reads the record and returns without dispatching.
//      Like `mp continue`'s own writes, record-file updates are swept into the
//      next bundle state commit (record-result's MAIN commit) — never committed here.
//   3b. GUARD D — before ANY dispatching transition (fresh create, attempt N+1,
//      takeover, and the redrive path) run ownership is acquired + heartbeat-
//      confirmed with the SAME owner-fs helpers continue/record-result use
//      (acquireOwner/heartbeatOwner; honored escape hatch: owner_lock=off). A
//      blocked/lost ownership THROWS — dispatch never proceeds under a lock some
//      other live session holds.
//   4. Routed tasks — prepareWave (lib/wave.mjs) with the fabric flag: the same
//      seam `mp continue` uses; routing is NOT forked here. Fabric payloads carry
//      only the dispatch class — the broker's resolve/guard is the routing brain.
//      ROUTING-INPUT PARITY: the prepare inputs (routing mode, codexHostSuppressed,
//      linkedWorktree) mirror continue.mjs's dispatchWave byte-for-byte and are
//      PERSISTED in the record as `routing_inputs` at attempt-1 create; retries
//      reuse the persisted inputs, so descriptors can never drift from what the
//      launch marker promised (the prepared lean payload is persisted too).
//   5. Descriptors — one adsp work item per routed task via the existing adapter
//      surface (lib/dispatch/adsp-adapter.mjs buildWorkItem): per-task
//      handoff-idempotency key composed from the launch-time input fingerprint
//      (captureInputFingerprint over the run's EXISTING worktree — never a second one).
//   6. Broker — ONE broker process for the whole wave: a single createBrokerClient
//      (agent-dispatch serve-mcp) call to the `dispatch_fanout` MCP tool with ALL
//      descriptors (fail_mode:'isolated'), instead of N per-task spawns. Each
//      per-descriptor result maps through translateBrokerResult — the SAME
//      broker-result → digest translation dispatchTask applies, so digests carry
//      the adsp-v1.1 `dispatch` provenance field (outcome:'worker' on success;
//      escalate/broker_error surface as dispatch_degraded events in record-result).
//   7. Coord — openWaveCoord (fail-open, unchanged) attaches per-descriptor coord
//      context; the job is CLOSED in a finally, paired even on dispatch failure
//      (the leaked-open-jobs fix — the legacy paths opened in `continue` and only
//      closed in `record-result`, so a failed dispatch leaked the job). A residual
//      marker coordJobId from an older `continue` is also best-effort closed.
//   8. Record — recordWaveResult (lib/wave-commit.mjs), the SAME transaction as
//      the launch_workflow / dispatch_foreground paths: mark digests → D6
//      verify-scope → revert → split commit → dispatch-provenance events → decide.
//
// Boundary notes: same git-in-bin seam as continue/record-result (LOCAL git only,
// via captureInputFingerprint / recordWaveResult); the broker process is a LOCAL
// child (MCP over stdio) — network stays broker-side. Guard D: the caller resolves
// owner identity (bin); THIS module acquires + heartbeat-confirms it before any
// dispatching transition (§3b above), and recordWaveResult heartbeats it again.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { readState } from './bundle.mjs';
import { prepareWave, captureInputFingerprint } from './wave.mjs';
import { recordWaveResult } from './wave-commit.mjs';
import { acquireOwner, heartbeatOwner } from './owner-fs.mjs';
import {
  CONTRACT_VERSION,
  buildWorkItem,
  createBrokerClient,
  translateBrokerResult,
  brokerErrorDigest,
} from './dispatch/adsp-adapter.mjs';
import { openWaveCoord, closeWaveCoord } from './dispatch/adsp-coord.mjs';
import {
  buildFabricLocus,
  rewriteVerifyForSibling,
} from './dispatch/multi-repo.mjs';

/** Pinned key-scheme version for the wave-dispatch idempotency record. */
export const WAVE_DISPATCH_KEY_VERSION = 'mp-wave-dispatch-v1';

/** The op this record substrate serves (the third key component, fixed). */
const WAVE_DISPATCH_OP = 'dispatch_fabric';

// ---------------------------------------------------------------------------
// Wave-dispatch key + record substrate (single-writer, inside the run bundle)
// ---------------------------------------------------------------------------

/**
 * Compose the stable wave-dispatch idempotency key: (run_id, wave, 'dispatch_fabric').
 * Same ':'-encoding as lib/adsp-idempotency.mjs composeHandoffKey so the key is
 * unambiguous under simple string splitting.
 *
 * @param {string|number} runId — bundle/run slug
 * @param {number} wave         — integer wave id
 * @returns {string} 'mp-wave-dispatch-v1:<run>:<wave>:dispatch_fabric'
 */
export function composeWaveDispatchKey(runId, wave) {
  if (runId == null || String(runId).length === 0) {
    throw new TypeError('composeWaveDispatchKey: runId is required');
  }
  if (!Number.isInteger(wave)) {
    throw new TypeError(`composeWaveDispatchKey: wave must be an integer (got ${JSON.stringify(wave)})`);
  }
  const enc = (s) => String(s).replaceAll('%', '%25').replaceAll(':', '%3A');
  return `${WAVE_DISPATCH_KEY_VERSION}:${enc(runId)}:${wave}:${WAVE_DISPATCH_OP}`;
}

/** Per-wave record file path inside the run bundle (committed with bundle state). */
export function waveDispatchRecordPath(bundleDir, wave) {
  return path.join(bundleDir, `wave-${wave}.dispatch.json`);
}

/**
 * Read the wave-dispatch record. Returns null when absent; a corrupt record
 * throws loudly (the idempotency substrate must never be silently ignored —
 * that is exactly the double-dispatch this record exists to prevent).
 */
export function readWaveDispatchRecord(bundleDir, wave) {
  const p = waveDispatchRecordPath(bundleDir, wave);
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`dispatch-wave: wave-dispatch record ${p} is unreadable (${err.message}) — refusing to dispatch over a corrupt idempotency record; inspect/move it manually`);
  }
}

/**
 * ATOMIC create-or-return-existing: O_EXCL ('wx') create so exactly one caller
 * ever creates the record for a key — the loser reads the winner's record back.
 *
 * @returns {{ created: boolean, record: object }}
 */
export function createWaveDispatchRecord(bundleDir, record) {
  const p = waveDispatchRecordPath(bundleDir, record.wave);
  try {
    fs.writeFileSync(p, JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { created: true, record };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { created: false, record: readWaveDispatchRecord(bundleDir, record.wave) };
  }
}

/** Atomic overwrite (tmp + rename — the bundle.mjs writeState idiom). Single-writer: Guard D serializes callers. */
export function writeWaveDispatchRecord(bundleDir, wave, record) {
  const p = waveDispatchRecordPath(bundleDir, wave);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p); // atomic on POSIX
  return record;
}

/** Archive the current attempt into a history entry (a stuck 'pending' taken over is marked superseded). */
function archiveAttempt(record, superseded) {
  const { history, ...current } = record;
  return superseded && current.status === 'pending'
    ? { ...current, status: 'superseded' }
    : current;
}

/** Attempt-marker path: the O_EXCL claim that serializes attempt-N+1 retries. */
export function waveDispatchAttemptMarkerPath(bundleDir, wave, attempt) {
  return path.join(bundleDir, `wave-${wave}.dispatch.attempt-${attempt}`);
}

/**
 * ATOMIC attempt claim (review finding 1): attempt-N+1 / takeover transitions
 * rewrite the record via tmp+rename, which is atomic but NOT exclusive — two
 * concurrent retries that both read attempt N could both transition and both
 * dispatch. This O_EXCL marker makes the transition exclusive: exactly one
 * caller claims `wave-<N>.dispatch.attempt-<K>`; the loser re-reads the record
 * and returns WITHOUT dispatching. Markers are append-only audit residue inside
 * the bundle (committed with the next state commit), never deleted — a deleted
 * marker would re-open the race it closed.
 *
 * @returns {{ claimed: boolean }}
 */
export function claimAttemptMarker(bundleDir, wave, attempt, meta = {}) {
  const p = waveDispatchAttemptMarkerPath(bundleDir, wave, attempt);
  try {
    fs.writeFileSync(
      p,
      JSON.stringify({ wave, attempt, claimed_at: new Date(meta.now ?? Date.now()).toISOString(), key: meta.key ?? null, session: meta.session ?? null }) + '\n',
      { encoding: 'utf8', flag: 'wx' },
    );
    return { claimed: true };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { claimed: false };
  }
}

// ---------------------------------------------------------------------------
// Guard D — ownership before any dispatching transition (review finding 1)
// ---------------------------------------------------------------------------

/**
 * Acquire + heartbeat-confirm run ownership with the SAME owner-fs helpers
 * continue.mjs (acquire/confirm pair) and recordWaveResult (strict heartbeat)
 * use. Honors the seeded escape hatch (owner_lock=off). THROWS on blocked/lost —
 * "exits loudly": a dispatch must never proceed under another session's lock,
 * and there is no auto-steal here (ownership conflicts resolve at `mp continue`'s
 * owner-blocked gate, where --force is the explicit user-approved takeover).
 */
function assertDispatchOwnership(state, bundleDir, self, { now, ttlMs } = {}) {
  if (state.concurrency?.owner_lock === 'off') return;
  if (!self) {
    throw new Error('dispatch-wave: owner identity required (Guard D is on) — pass --session / set CLAUDE_CODE_SESSION_ID, or seed with --owner-lock=off');
  }
  const acq = acquireOwner(bundleDir, self, { now, ttlMs });
  if (acq.outcome === 'blocked') {
    throw new Error(`dispatch-wave: bundle is owned by another live session (${acq.incumbent?.session ?? 'unknown'}@${acq.incumbent?.host ?? '?'}) — refusing to dispatch; resolve ownership at \`mp continue\`'s owner-blocked gate (its --force is the explicit takeover) first`);
  }
  const hb = heartbeatOwner(bundleDir, self, { now });
  if (hb.outcome !== 'held-by-self') {
    throw new Error(`dispatch-wave: run ownership lost mid-turn (${hb.reason ?? hb.outcome}) — refusing to dispatch`);
  }
}

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} DispatchWaveOptions
 * @property {string}  statePath      — bundle state.yml path (required)
 * @property {object}  [self]         — Guard D owner identity (acquired/heartbeated before any dispatching transition)
 * @property {number}  [now]          — clock override (ms)
 * @property {number}  [ttlMs]        — Guard D ownership TTL override
 * @property {number}  [wave]         — wave override for record queries when the marker is gone
 * @property {boolean} [takeover]     — supersede a stuck 'pending' attempt (operator-confirmed dead)
 * @property {boolean} [codexSuppressed] — §0 host-detect fact, threaded for routing-input parity with `mp continue`
 * @property {string}  [brokerBin]    — override agent-dispatch binary path
 * @property {object}  [_brokerClient]     — injectable MCP client (tests; close() is NOT called on it)
 * @property {Function}[_openCoord]        — injectable openWaveCoord seam (tests)
 * @property {Function}[_closeCoord]       — injectable closeWaveCoord seam (tests)
 * @property {Function}[_record]           — injectable recordWaveResult seam (tests)
 * @property {Function}[_captureFingerprint] — injectable captureInputFingerprint seam (tests)
 */

/**
 * Dispatch the active wave through the agent-dispatch broker (dispatch_fanout)
 * and record the digests via the standard record-result transaction.
 *
 * Idempotent on the wave-dispatch key (run_id, wave, 'dispatch_fabric'): the
 * record is persisted BEFORE the broker call; a retry after an
 * accepted-but-unobserved dispatch returns the existing record and never
 * double-dispatches. See the module header for the full status lifecycle.
 *
 * @param {DispatchWaveOptions} opts
 * @returns {Promise<object>} one result JSON the shell prints (outcome-first)
 */
export async function dispatchWaveViaFabric({
  statePath,
  self = null,
  now,
  ttlMs,
  wave: waveFlag = null,
  takeover = false,
  codexSuppressed = false,
  brokerBin,
  _brokerClient = null,
  _openCoord = openWaveCoord,
  _closeCoord = closeWaveCoord,
  _record = recordWaveResult,
  _captureFingerprint = captureInputFingerprint,
} = {}) {
  if (!statePath) throw new Error('dispatch-wave: statePath is required');
  const absState = path.resolve(statePath);
  const bundleDir = path.dirname(absState);
  const state = readState(absState);

  // 1. Flag gate — the SAME per-run strangler flag continue.mjs reads when it
  //    emits the dispatch_fabric op. Off → no-op (never dispatch, never write).
  if (state.dispatch?.fabric !== true) {
    return {
      outcome: 'flag-off',
      dispatched: false,
      reason: 'state.dispatch.fabric is not true — the fabric wave path is gated per run; the legacy launch_workflow/dispatch_foreground ops apply',
    };
  }

  // 2. Wave from the phase-1 launching marker (mp continue wrote it before
  //    emitting the op). --wave only serves record QUERIES when the marker is gone.
  const run = state.active_run ?? null;
  if (run?.kind === 'plan') {
    throw new Error('dispatch-wave: active_run is a plan run — dispatch_fabric consumes execute waves only');
  }
  if (run?.task_id != null) {
    throw new Error(`dispatch-wave: active_run is promoted to a background task (task_id=${run.task_id}) — an L2 run owns this wave; probe/record it instead`);
  }
  const markerWave = Number.isInteger(run?.wave) ? run.wave : null;
  const wave = markerWave ?? (Number.isInteger(waveFlag) ? waveFlag : null);
  if (!Number.isInteger(wave)) {
    throw new Error('dispatch-wave: no active wave — run `mp continue` first (it writes the phase-1 launching marker this command consumes), or pass --wave=N to query a prior wave-dispatch record');
  }

  const runId = String(state.slug ?? '').trim();
  if (!runId) throw new Error('dispatch-wave: state has no slug — cannot compose the wave-dispatch key');
  const key = composeWaveDispatchKey(runId, wave);

  // 3. IDEMPOTENCY GATE — consult the existing record BEFORE any dispatch work.
  const existing = readWaveDispatchRecord(bundleDir, wave);
  if (existing != null && existing.key !== key) {
    throw new Error(`dispatch-wave: wave-dispatch record key mismatch — record ${waveDispatchRecordPath(bundleDir, wave)} carries ${JSON.stringify(existing.key)}, expected ${JSON.stringify(key)}; refusing to dispatch over a foreign record`);
  }
  if (existing?.status === 'pending' && !takeover) {
    // Accepted-but-unobserved window: an earlier invocation persisted the record
    // and may have reached the broker before dying. NEVER re-dispatch here.
    return {
      outcome: 'reused',
      dispatched: false,
      reused: true,
      wave,
      key,
      status: existing.status,
      record: existing,
      reason: "wave-dispatch record exists with status 'pending' — an accepted-but-unobserved dispatch may be in flight; NOT re-dispatching (pass --takeover only after confirming the prior attempt is dead)",
    };
  }
  if (existing?.status === 'dispatched') {
    // Digests are durable in the record but the record-result transaction never
    // completed (crash between broker return and record). Re-drive record-result
    // from the STORED result — the broker is never called again. Ownership first:
    // the re-drive writes state/record, so it is a dispatching-transition too.
    assertDispatchOwnership(state, bundleDir, self, { now, ttlMs });
    const rec = redriveRecordTransaction({ absState, bundleDir, wave, existing, self, now, _record, state });
    return {
      outcome: 'reused',
      dispatched: false,
      reused: true,
      redrove_record: true,
      wave,
      key,
      status: rec.record.status,
      record: rec.record,
      record_result: rec.recordResult,
    };
  }
  // existing 'recorded' (or absent) falls through: with pending tasks remaining a
  // new attempt is a legitimate OBSERVED retry (recover_and_redispatch), not a
  // double-dispatch. Zero pending tasks → nothing to do (checked below).

  // 4. Routed tasks — the SAME seam continue.mjs uses (prepareWave + fabric flag;
  //    routing is deferred to the broker's resolve/guard — class-only payloads).
  const planIndexPath = state.plan_index_path ?? path.join(bundleDir, 'plan.index.json');
  if (!fs.existsSync(planIndexPath)) {
    throw new Error(`dispatch-wave: plan.index.json not found at ${planIndexPath} — cannot resolve descriptions/verify_commands`);
  }
  let planIndex;
  try {
    planIndex = JSON.parse(fs.readFileSync(planIndexPath, 'utf8'));
  } catch (e) {
    throw new Error(`dispatch-wave: plan.index.json unreadable: ${e.message}`);
  }
  // ROUTING-INPUT PARITY (review finding 2): mirror continue.mjs's dispatchWave
  // inputs byte-for-byte — config {routing, implementer} with NO fabric key (the
  // state snapshot verified at step 1 turns the fabric branch on inside
  // prepareWave, exactly as it does for `mp continue`) and the same env facts
  // ({codexHostSuppressed, linkedWorktree: true}). On a retry the attempt-1
  // record's PERSISTED routing_inputs win over the current invocation's flags,
  // so a retry from a different host/flag-set can never prepare a divergent
  // payload for the same wave.
  const currentRoutingInputs = {
    routing: state.codex?.routing ?? 'auto',
    codex_host_suppressed: !!codexSuppressed,
    linked_worktree: true,
  };
  const routingInputs = existing?.routing_inputs ?? currentRoutingInputs;
  const config = {
    routing: routingInputs.routing,
    implementer: state.implementer ?? {},
  };
  const env = {
    codexHostSuppressed: !!routingInputs.codex_host_suppressed,
    linkedWorktree: routingInputs.linked_worktree !== false,
  };
  const prepared = prepareWave(state, planIndex, wave, config, env); // throws loud on drift/collision
  const tasks = prepared.tasks;
  if (tasks.length === 0) {
    return { outcome: 'no-pending-tasks', dispatched: false, wave, key, record: existing ?? null };
  }
  if (markerWave === null) {
    // Fresh dispatch needs the launching marker (frozen scope/baseline + the
    // record transaction's anchor); --wave alone only serves record queries.
    throw new Error('dispatch-wave: no phase-1 launching marker for a fresh dispatch — run `mp continue` first');
  }

  // 5. The run's EXISTING worktree + the launch-time input fingerprint.
  const WT = path.resolve(String(state.worktree ?? ''));
  if (!state.worktree || !fs.existsSync(WT)) {
    throw new Error(`dispatch-wave: worktree ${state.worktree ?? '(unset)'} missing — \`mp continue\` creates/records it before emitting dispatch_fabric`);
  }
  // MAIN = primary checkout of the umbrella (or single) repo. Sibling git
  // checkouts live under MAIN/<name> and are invisible inside the worktree
  // (gitignored). Multi-repo locus resolution needs MAIN, not WT.
  let MAIN;
  try {
    MAIN = path.dirname(String(execFileSync(
      'git', ['-C', bundleDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' },
    )).trim());
  } catch {
    MAIN = path.resolve(WT, '..', '..'); // conventional .worktrees/<slug> layout
  }
  const inputs = _captureFingerprint(WT);

  // 6. One adsp work item per routed task via the existing adapter surface —
  //    the per-task handoff key (run_id, task_id, task_spec_hash, input_fingerprint)
  //    is composed inside buildWorkItem; descriptors are dispatch_task-shaped.
  //    `branch` rides on each descriptor because the broker's writer-lease
  //    scope (deriveDispatchScope -> coord file-scope lease) requires
  //    repo+branch, and the coord service 400s on an empty branch (found live
  //    in the 2026-07-09 fabric drill). Descriptor-only: excluded from the
  //    task-spec hash, so handoff keys are unchanged.
  //
  //    MULTI-REPO LOCUS (yanos-project umbrella): plan files may be under a
  //    sibling git checkout (yanos-os/..., yanos-builder/...). buildFabricLocus
  //    maps those to sibling worktrees (create-or-reuse), strips the sibling
  //    prefix from files, and auto-opts create_files when targets are missing.
  //    Mixed-repo tasks throw loud — one task = one edit locus.
  const wtBranch = (() => {
    try {
      return String(execFileSync('git', ['-C', WT, 'branch', '--show-current'], { encoding: 'utf8' })).trim() || null;
    } catch {
      return null; // detached HEAD / non-git: lease derivation falls back as before
    }
  })();
  const descriptors = tasks.map((t) => {
    let locus;
    try {
      locus = buildFabricLocus(t.files, {
        worktree: WT,
        mainRoot: MAIN,
        slug: runId,
        ensureSiblings: true,
      });
    } catch (e) {
      throw new Error(`dispatch-wave: task ${t.id} locus resolution failed: ${e.message}`);
    }
    const verify = rewriteVerifyForSibling(t.verify_commands, locus.siblingName);
    const desc = {
      ...buildWorkItem({
        task_id: t.id,
        description: t.description,
        files: locus.files,
        verify_commands: verify,
        cwd: locus.repo,
        class: t.class,
        run_id: runId,
        inputs,
      }),
    };
    // Branch: prefer the locus's masterplan branch (sibling worktree); fall back
    // to the umbrella worktree branch for in-repo tasks.
    const branch = locus.branch || wtBranch;
    if (branch) desc.branch = branch;
    // create_files: gateway refuses skynet_edit on missing paths; opt in when
    // any declared target is absent so the write loop can create it.
    if (locus.create_files) desc.create_files = true;
    return desc;
  });

  // 7. GUARD D FIRST (review finding 1), then persist the wave-dispatch record
  //    BEFORE the broker call (the whole point: a crash after the broker accepts
  //    leaves 'pending' on disk, and the retry above returns it instead of
  //    double-dispatching). Ownership is acquired + heartbeat-confirmed with the
  //    same helpers continue/record-result use — a blocked/lost lock throws and
  //    NOTHING is written or dispatched.
  assertDispatchOwnership(state, bundleDir, self, { now, ttlMs });
  const attempt = existing ? (existing.attempt ?? 0) + 1 : 1;
  const record = {
    key,
    run_id: runId,
    wave,
    op: WAVE_DISPATCH_OP,
    contract_version: CONTRACT_VERSION,
    status: 'pending',
    attempt,
    dispatched_at: new Date(now ?? Date.now()).toISOString(),
    // Finding 2: freeze the prepare inputs + the prepared lean payload so retries
    // provably re-prepare from the SAME inputs (and audits can diff the payload).
    routing_inputs: routingInputs,
    payload: tasks,
    tasks: descriptors.map((d) => ({ task_id: d.task_id, class: d.class, handoff_key: d.handoff_key })),
    ...(existing ? { history: [...(existing.history ?? []), archiveAttempt(existing, takeover)] } : {}),
  };
  if (existing) {
    // Attempt-N+1 / takeover transition: the record rewrite (tmp+rename) is
    // atomic but not EXCLUSIVE — the O_EXCL attempt marker is. Exactly one
    // concurrent retry claims attempt K; the loser returns without dispatching.
    const claim = claimAttemptMarker(bundleDir, wave, attempt, { key, session: self?.session ?? null, now });
    if (!claim.claimed) {
      const latest = readWaveDispatchRecord(bundleDir, wave);
      return {
        outcome: 'reused',
        dispatched: false,
        reused: true,
        wave,
        key,
        status: latest?.status ?? null,
        record: latest,
        reason: `lost the attempt-${attempt} claim race — a concurrent invocation owns this retry; NOT re-dispatching`,
      };
    }
    writeWaveDispatchRecord(bundleDir, wave, record);
  } else {
    const created = createWaveDispatchRecord(bundleDir, record);
    if (!created.created) {
      // Lost the atomic-create race to a concurrent invocation — its record wins.
      return {
        outcome: 'reused',
        dispatched: false,
        reused: true,
        wave,
        key,
        status: created.record?.status ?? null,
        record: created.record,
        reason: 'lost the wave-dispatch record create race — another invocation owns this dispatch',
      };
    }
  }

  // 8. Coord (fail-open) + ONE broker fanout for the whole wave + paired close.
  const usingInjected = _brokerClient != null;
  const client = usingInjected ? _brokerClient : createBrokerClient({ bin: brokerBin });
  let coordHandle = null;
  let digests;
  try {
    try {
      coordHandle = _openCoord({ wave, tasks, goal: `wave ${wave}` });
    } catch {
      coordHandle = null; // fail-open: coord never blocks wave dispatch
    }
    const wireDescriptors = coordHandle?.enabled
      ? descriptors.map((d, i) => coordHandle.attachToTask(d, i))
      : descriptors;
    try {
      if (!usingInjected) await client.initialize();
      const fanout = await client.callTool('dispatch_fanout', {
        descriptors: wireDescriptors,
        fail_mode: 'isolated',
      });
      const results = Array.isArray(fanout?.results) ? fanout.results : null;
      if (results === null) {
        // No results array (e.g. { error: 'fanout disabled by policy' }) — every
        // task maps through the escalate branch with the broker's reason.
        const reason = typeof fanout?.error === 'string' ? fanout.error : 'dispatch_fanout returned no results array';
        digests = tasks.map((t) => translateBrokerResult(t.id, { reason }).digest);
      } else {
        // results are in input order, one per descriptor — the SAME translation
        // dispatchTask applies (worker digests get dispatch.outcome:'worker').
        digests = tasks.map((t, i) => translateBrokerResult(t.id, results[i] ?? null).digest);
      }
    } catch (err) {
      // Client/spawn/RPC failure → every task blocked with outcome:'broker_error'
      // (record-result turns these into dispatch_degraded events — fail-VISIBLE).
      digests = tasks.map((t) => brokerErrorDigest(t.id, err.message, 'dispatch_fanout'));
    }
  } finally {
    if (!usingInjected) {
      try { client.close(); } catch { /* teardown is best-effort */ }
    }
    // THE leaked-open-jobs fix: the coord job closes here, paired with the open,
    // even when the dispatch failed — never deferred to a record step that may not run.
    if (coordHandle) {
      try { coordHandle.close(); } catch { /* fail-open */ }
    }
    // A residual marker coordJobId (opened by an older `continue` on this wave)
    // is also closed best-effort so it can't leak either.
    if (run?.coordJobId) {
      try { _closeCoord({ jobId: run.coordJobId }); } catch { /* fail-open */ }
    }
  }

  // 9. Digests durable BEFORE the record transaction: a crash between here and
  //    record completion re-drives record-result from THIS result — the broker
  //    is never called again for this attempt.
  const result = {
    wave,
    tasks: digests.map((d) => ({ task_id: d.task_id, digest: d })),
    ...(Number.isFinite(run?.epoch) ? { epoch: run.epoch } : {}),
  };
  let current = writeWaveDispatchRecord(bundleDir, wave, { ...record, status: 'dispatched', result });

  // 10. The SAME record transaction as every other dispatch vehicle — digests →
  //     mark → D6 verify-scope → revert → split commit → dispatch-provenance
  //     events (dispatch_degraded / dispatch_inline_designed) → decide.
  const recordResult = _record({ statePath: absState, result, self, now, worktree: WT });
  if (recordResult?.outcome === 'recorded') {
    // COMMIT-WINDOW NOTE (cross-vendor review finding, DOCUMENTED BY DESIGN — do
    // not "fix" this into a double-record): this 'recorded' finalize lands AFTER
    // recordWaveResult's MAIN state commit, so the committed HEAD briefly carries
    // this file at status 'dispatched' until the next bundle commit sweeps it
    // (the same sweep discipline as `mp continue`'s own uncommitted writes). The
    // window is SAFE by construction: a crash/reset that resurrects the
    // 'dispatched' state re-enters through the idempotency gate above, which
    // NEVER re-dispatches — it re-drives recordWaveResult from the stored result
    // (redriveRecordTransaction, itself idempotent: markTask re-marks are no-ops
    // and a marker already cleared finalizes the file without re-recording).
    // Folding this write INTO the record transaction (e.g. committing the file
    // pre-finalize as 'recorded') would break exactly those crash semantics: the
    // record would claim completion before the transaction that completes it.
    current = writeWaveDispatchRecord(bundleDir, wave, {
      ...current,
      status: 'recorded',
      completed_at: new Date(now ?? Date.now()).toISOString(),
      record_outcome: {
        recorded: recordResult.recorded,
        failed: recordResult.failed,
        cleared: recordResult.cleared,
        commits: recordResult.commits,
      },
    });
  } else {
    // lost-to-other / stale-epoch: the dispatch happened but recording didn't —
    // keep 'dispatched' (with the error) so a retry re-drives record, not the broker.
    current = writeWaveDispatchRecord(bundleDir, wave, {
      ...current,
      record_error: { outcome: recordResult?.outcome ?? null, reason: recordResult?.reason ?? null },
    });
  }

  return {
    outcome: 'dispatched',
    dispatched: true,
    wave,
    key,
    attempt,
    tasks: digests.map((d) => ({
      task_id: d.task_id,
      status: d.status,
      dispatch: d.dispatch?.outcome ?? null,
    })),
    record_status: current.status,
    record: recordResult,
  };
}

// Re-drive the record-result transaction from a 'dispatched' record's stored
// result. A marker already cleared means a prior record run actually completed
// (record-result clears it when the wave is all-done) and only the record-file
// update was lost — finalize the record instead of failing.
function redriveRecordTransaction({ absState, bundleDir, wave, existing, self, now, _record, state }) {
  let recordResult;
  try {
    recordResult = _record({
      statePath: absState,
      result: existing.result,
      self,
      now,
      worktree: state.worktree ?? undefined,
    });
  } catch (err) {
    if (/no active_run marker/.test(err.message)) {
      const record = writeWaveDispatchRecord(bundleDir, wave, {
        ...existing,
        status: 'recorded',
        completed_at: new Date(now ?? Date.now()).toISOString(),
        record_outcome: { note: 'marker already cleared — prior record transaction had completed; record file finalized on re-drive' },
      });
      return { record, recordResult: { outcome: 'already-finalized' } };
    }
    throw err;
  }
  if (recordResult?.outcome === 'recorded') {
    const record = writeWaveDispatchRecord(bundleDir, wave, {
      ...existing,
      status: 'recorded',
      completed_at: new Date(now ?? Date.now()).toISOString(),
      record_outcome: {
        recorded: recordResult.recorded,
        failed: recordResult.failed,
        cleared: recordResult.cleared,
        commits: recordResult.commits,
      },
    });
    return { record, recordResult };
  }
  const record = writeWaveDispatchRecord(bundleDir, wave, {
    ...existing,
    record_error: { outcome: recordResult?.outcome ?? null, reason: recordResult?.reason ?? null },
  });
  return { record, recordResult };
}
