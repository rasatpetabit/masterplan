// lib/dispatch-wave.mjs — the `dispatch_fabric` op consumer (`mp dispatch-wave`).
//
// Chunk B of the wave-dispatch outage fix: lib/dispatch/ops.mjs has emitted the
// `dispatch_fabric` op since the strangler flag landed, but NOTHING consumed it —
// the L1 op table had no consumer entry for it, so masterplan waves never
// reached the agent-dispatch broker. This module is the missing consumer: a
// deterministic, zero-LLM-token wave dispatcher that drives a bounded
// concurrent pool of per-task dispatch_task calls for the active wave (the
// broker fan-out tool was retired 2026-07-17) and feeds the digests into the
// SAME record-result transaction every other dispatch vehicle uses.
//
// Flow (dispatchWaveViaFabric) — thin orchestrator over named stage helpers:
//   gateAndValidate   — fabric flag + active_run launching marker + wave key;
//                       redrive 'dispatched' records; reuse pending/recorded.
//                       WAVE-DISPATCH IDEMPOTENCY (review-mandated): stable key
//                       (run_id, wave, 'dispatch_fabric') with atomic create-or-
//                       return-existing over wave-<N>.dispatch.json (O_EXCL create
//                       + tmp/rename). Statuses: pending (never re-dispatch;
//                       `--takeover` supersedes), dispatched (re-drive record-
//                       result only), recorded (attempt N+1 when work remains).
//                       Attempt N+1 / takeover also claim wave-<N>.dispatch.attempt-<K>.
//   resolveWaveContext — prepareWave (same seam as `mp continue`; routing not
//                       forked here) + fingerprint; routing_inputs frozen at
//                       attempt-1 create and reused on retries.
//   buildDescriptors  — one adsp work item per routed task (buildWorkItem) with
//                       handoff key from the launch-time input fingerprint over
//                       the run's EXISTING worktree; packages gateway verify.
//   acquireAndWatch   — Guard D ownership (acquireOwner/heartbeatOwner; owner_lock=off
//                       escape hatch); attempt/token; watch baseline + precheck;
//                       pending record + review_context freeze BEFORE broker call.
//                       Blocked/lost ownership THROWS.
//   buildNativePlan   — native-spawn launch-path branch AFTER acquire/watch and
//                       BEFORE broker: return descriptors (plan) for harness spawn;
//                       crash recovery via probeWaveToken, not re-dispatch.
//   runBrokerDispatch — ONE broker client for the wave: bounded concurrent pool of
//                       per-task dispatch_task (isolated fail mode); translateBrokerResult
//                       digests (adsp-v1.1 provenance); config-gated adversary review
//                       (state.review.adversary / legacy state.codex.review) on full
//                       working diffs; openWaveCoord/closeWaveCoord paired in finally
//                       (incl. residual marker coordJobId best-effort close).
//   finalizeRecord    — digests → dispatched record; recordWaveResult (same mark →
//                       D6 verify-scope → revert → split commit → provenance → decide
//                       transaction as other dispatch vehicles); recorded finalize.
//
// Boundary notes: same git-in-bin seam as continue/record-result (LOCAL git only,
// via captureInputFingerprint / recordWaveResult); the broker process is a LOCAL
// child (MCP over stdio) — network stays broker-side. Guard D: the caller resolves
// owner identity (bin); acquireAndWatch acquires + heartbeat-confirms before any
// dispatching transition, and recordWaveResult heartbeats it again.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseJsonc } from './jsonc.mjs';

import { readState, appendEvent } from './bundle.mjs';
import { buildWaveLaunchContext, captureInputFingerprint } from './wave.mjs';
import { normalizeReviewMode } from './dispatch/ops.mjs';
import { reviewCompletedTasks } from './task-review.mjs';
import {
  recordWaveResult,
  captureWatchBaseline,
  writeWatchBaseline,
  precheckWatchList,
} from './wave-commit.mjs';
import { acquireOwner, heartbeatOwner } from './owner-fs.mjs';
import {
  CONTRACT_VERSION,
  buildWorkItem,
  createBrokerClient,
  runLocalVerifyCommands,
  DEFAULT_VERIFY_TIMEOUT_S,
  DEFAULT_SKYNET_VERIFY_ALLOWLIST,
  packageGatewayVerify,
  translateBrokerResult,
  brokerErrorDigest,
} from './dispatch/adsp-adapter.mjs';
import { openWaveCoord, closeWaveCoord } from './dispatch/adsp-coord.mjs';
import {
  buildFabricLocus,
  canonicalizeScopePaths,
  rewriteVerifyForSibling,
} from './dispatch/multi-repo.mjs';

/** Pinned key-scheme version for the wave-dispatch idempotency record. */
export const WAVE_DISPATCH_KEY_VERSION = 'mp-wave-dispatch-v1';

/** The op this record substrate serves (the third key component, fixed). */
const WAVE_DISPATCH_OP = 'dispatch_fabric';

// ---------------------------------------------------------------------------
// Native spawn path (spec §3)
// ---------------------------------------------------------------------------
//
// The MCP pool below drives every wave task through one `agent-dispatch serve-mcp`
// child. That is the right shape on a Claude Code host, where the harness has no
// in-process parallel subagent API for this module to reach. On a Pi host it is pure
// overhead AND a fidelity loss: the gateway executes the work, so the harness never
// sees a child job, the per-agent dispatch badge has nothing to render, and a crashed
// orchestrator cannot re-attach to work that is still running.
//
// The native path returns a SPAWN PLAN instead: per-task descriptors the host executes
// with its own parallel subagent API, each pinned to the same governed lane the broker
// would have chosen. Routing is not forked — every lane/effort/agent value comes from
// `agent-dispatch resolve` and the compiled agent_mapping, never from a table copied
// into masterplan.
//
// TWO-PHASE LAUNCH MARKER. The failure this guards is a crash in the window between
// "children are running" and "their handles are durable", which otherwise looks
// identical to "nothing was dispatched" and invites a double-dispatch over live
// workers. Phase 1 persists a unique wave token BEFORE any child starts; every child
// carries it in its label and prompt. Phase 2 appends the handles as they come back.
// Recovery queries the harness job list for the token FIRST — any live match means
// children exist, so re-dispatch is refused regardless of what the handles say.

/** Prefix for the per-attempt wave token embedded in child labels/prompts. */
export const WAVE_TOKEN_PREFIX = 'mp-wave';

/**
 * Compose the unique per-attempt wave token. Attempt is part of the token so a
 * recover_wave retry's children are distinguishable from the attempt they replaced.
 */
export function composeWaveToken(runId, wave, attempt) {
  const slug = String(runId).replace(/[^A-Za-z0-9._-]/g, '-');
  return `${WAVE_TOKEN_PREFIX}-${slug}-w${wave}-a${attempt}`;
}

const CLASS_ROUTING_CACHE = new Map();

/**
 * Resolve one task class to its governed lane facts via the agent-dispatch CLI.
 *
 * Deliberately a CLI call and not a copied table: the routing source of truth is
 * agent-dispatch policy/routing.yaml, and masterplan holding its own copy is the exact
 * duplication this bundle removes. Cached per process — a wave's tasks share few classes.
 *
 * KNOWN GAP: `resolve` attaches `agent` only for pi-subagent backends (packages/core/
 * resolve.mjs "Phase 2"), so a gateway-routed class returns no agent role. Rather than
 * copy agent_mapping here, the role is read from the compiled agent_mapping block in the
 * policy file agent-dispatch itself generates. Still one source; just a second read.
 *
 * @returns {{lane: string|null, effort: string|null, capability: string|null,
 *            provider: string|null, backend: string|null, agent: string|null,
 *            resolved: boolean, reason: string|null}}
 */
export function resolveClassRouting(taskClass, { bin = 'agent-dispatch', _exec = execFileSync, _cache = CLASS_ROUTING_CACHE } = {}) {
  if (!taskClass) return { lane: null, effort: null, capability: null, provider: null, backend: null, agent: null, resolved: false, reason: 'no class' };
  if (_cache?.has(taskClass)) return _cache.get(taskClass);
  let out = { lane: null, effort: null, capability: null, provider: null, backend: null, agent: null, resolved: false, reason: null };
  try {
    const raw = String(_exec(bin, ['resolve', '--class', taskClass], { encoding: 'utf8' }));
    const d = JSON.parse(raw);
    out = {
      lane: d.route ?? d.model ?? null,
      effort: d.effort ?? null,
      capability: d.capability ?? null,
      provider: d.provider ?? null,
      backend: d.backend ?? null,
      agent: d.agent ?? null,
      resolved: d.decision === 'route',
      reason: d.reason ?? null,
    };
  } catch (err) {
    out.reason = `agent-dispatch resolve failed: ${err?.message ?? err}`;
  }
  if (!out.agent) {
    out.agent = readAgentRole(taskClass, { bin, _exec });
  }
  _cache?.set(taskClass, out);
  return out;
}

let AGENT_MAPPING_CACHE = null;

/** Read the compiled agent_mapping block from the agent-dispatch policy file. */
function readAgentRole(taskClass, { bin = 'agent-dispatch', _exec = execFileSync } = {}) {
  if (AGENT_MAPPING_CACHE === null) {
    AGENT_MAPPING_CACHE = {};
    try {
      const root = String(_exec(bin, ['where'], { encoding: 'utf8' })).trim();
      const text = fs.readFileSync(path.join(root, 'policy', 'dispatch-policy.jsonc'), 'utf8');
      // Was a whole-line-only comment strip: a trailing `// comment` in the policy
      // made JSON.parse throw, the catch below swallowed it, and every task silently
      // got agent:null. Use the string-aware parser (lib/jsonc.mjs).
      AGENT_MAPPING_CACHE = parseJsonc(text).agent_mapping ?? {};
    } catch {
      AGENT_MAPPING_CACHE = {}; // unreadable → descriptors carry agent:null, never a guess
    }
  }
  const entry = AGENT_MAPPING_CACHE[taskClass];
  return typeof entry?.agent === 'string' ? entry.agent : null;
}

/**
 * Build the native spawn plan for a wave: one descriptor per routed task.
 *
 * Each descriptor is everything the host needs to spawn a child with the SAME routing
 * the broker would have applied — the lane pinned as `litellm/<lane>`, the effort, the
 * agent role, the edit locus, the file scope, the prompt, and the DispatchBadgeDescriptor
 * the TUI renders. The wave token rides in both the label and the prompt so a recovery
 * pass can find the children by string match against the harness job list.
 *
 * @returns {{token: string, concurrency: number, tasks: object[]}}
 */
export function buildNativeSpawnPlan({
  tasks,
  descriptors,
  token,
  concurrency,
  bin = 'agent-dispatch',
  _resolve = resolveClassRouting,
} = {}) {
  const spawns = (tasks ?? []).map((t, i) => {
    const desc = descriptors?.[i] ?? {};
    const routing = _resolve(t.class, { bin });
    const lane = routing.lane ?? (t.class ? `dispatch-${t.class}` : null);
    const model = lane ? `litellm/${lane}` : null;
    return {
      task_id: t.id,
      label: `${token}/t${t.id}`,
      token,
      agent: routing.agent,
      class: t.class ?? null,
      model,
      effort: routing.effort,
      capability: routing.capability,
      // `repo` is what buildWorkItem names the run's existing worktree path; reading only
      // `cwd` here left every native descriptor with cwd:null, so the harness had to be told
      // the worktree path out of band at the spawn boundary (e2e finding 2). Accept both, so
      // the harness spawns children IN the wave's locus without being told twice.
      cwd: desc.cwd ?? desc.repo ?? null,
      branch: desc.branch ?? null,
      files: desc.files ?? t.files ?? [],
      verify_commands: desc.verify_commands ?? t.verify_commands ?? [],
      handoff_key: desc.handoff_key ?? null,
      create_files: desc.create_files ?? true,
      review: desc.review ?? null,
      prompt: renderSpawnPrompt(t, desc, token),
      // The badge the TUI renders for this child (agent-dispatch pi-extension
      // DispatchBadgeDescriptor). `model` is the SERVED model behind the lane, which
      // is what a reader wants to see; the lane itself is the class segment.
      badge: {
        class: t.class ?? null,
        backend: routing.backend === 'dispatch-gateway' ? 'gateway' : (routing.backend ?? 'gateway'),
        model: routing.provider ?? '',
        ...(routing.effort ? { effort: routing.effort } : {}),
      },
      routing_resolved: routing.resolved,
      ...(routing.resolved ? {} : { routing_reason: routing.reason }),
    };
  });
  return { token, concurrency: normalizeWaveConcurrency(concurrency, spawns.length), tasks: spawns };
}

/** The child's brief. The token is embedded so recovery can find it by job-list match. */
function renderSpawnPrompt(task, desc, token) {
  const files = (desc.files ?? task.files ?? []).map((f) => `  - ${f}`).join('\n');
  const verify = (desc.verify_commands ?? task.verify_commands ?? []).map((c) => `  - ${c}`).join('\n');
  return [
    `[${token}] masterplan wave task ${task.id}`,
    '',
    task.description ?? '',
    '',
    'Files in scope (edit NOTHING else):',
    files || '  (none declared)',
    '',
    'Verification (must pass before you report done):',
    verify || '  (none declared)',
    '',
    // NOT "commit locally": the wave transaction owns the code-side commit (record-result's
    // split commit, code→worktree / state→MAIN), and the cross-locus watch fails the wave
    // on ANY child HEAD move — a child that committed made its work invisible to the
    // after-capture while moving the repo out from under the transaction. The old wording
    // told children to do the one thing integrity rejects, so an obedient child broke the
    // wave: `commits.code:null` with a HEAD-move violation (e2e finding 3, A3).
    'Report concrete evidence. Leave your work uncommitted — the wave commits it. Never commit or push.',
  ].join('\n');
}

/**
 * Bounded concurrency, shared by both paths. MP_DISPATCH_WAVE_CONCURRENCY overrides the
 * default of 8 (policy fanout max_concurrency). Never exceeds the task count.
 */
export function normalizeWaveConcurrency(requested, taskCount) {
  const envRaw = Number(process.env.MP_DISPATCH_WAVE_CONCURRENCY);
  const base = Number.isFinite(requested) && requested > 0
    ? requested
    : (Number.isFinite(envRaw) && envRaw > 0 ? envRaw : 8);
  return Math.max(1, Math.min(Math.floor(base), Math.max(taskCount || 1, 1)));
}

/**
 * Does this host expose a native parallel spawn API?
 *
 * This is a DIFFERENT question from `shouldSuppressWorkflow` (bin/masterplan.mjs), which
 * answers "does this host have Claude Code's Workflow launch/promote handle?". Pi answers
 * no to that and yes to this one — it has subagents but not Workflow. Keeping the two
 * propositions in one variable is what made the native branch unreachable; see
 * selectLaunchPath.
 */
export function hostHasNativeSpawnApi(env = process.env) {
  return env.PI_CODING_AGENT === 'true';
}

/**
 * Which launch path this host uses.
 *
 * Claude Code keeps the MCP pool: this module runs inside `mp`, a plain node process
 * with no handle on the CC harness's Agent tool, so there is no in-process parallel
 * spawn API to call. Pi hosts expose one, so they take the native path. The branch is
 * explicit (not a capability sniff) because a wrong guess here silently changes which
 * process executes every wave task.
 *
 * @returns {'mcp-pool'|'native-spawn'}
 */
export function selectLaunchPath({ codexSuppressed = false, nativeSpawn = null, env = process.env } = {}) {
  if (nativeSpawn === true) return 'native-spawn';
  if (nativeSpawn === false) return 'mcp-pool';
  // `codexSuppressed` carries the no-Workflow fact, and Pi sets it (PI_CODING_AGENT) —
  // so vetoing on it alone routed Pi, the ONE host with a native parallel API, to the MCP
  // pool unconditionally. The native branch was dead code on the only host that can run
  // it, and MP_DISPATCH_NATIVE_SPAWN could not reach it (e2e finding 1,
  // test/e2e-native-wave-report.md). A genuine Codex host has no native API and still
  // vetoes here; a Pi host falls through to the explicit env flag below.
  if (codexSuppressed && !hostHasNativeSpawnApi(env)) return 'mcp-pool';
  const flag = String(env.MP_DISPATCH_NATIVE_SPAWN ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'on') return 'native-spawn';
  return 'mcp-pool';
}

/**
 * Recovery probe: do children from `token` still exist in the harness job list?
 * Called BEFORE any re-dispatch decision — a live match means the two-phase window
 * was survived by real workers, and re-dispatching would double them.
 *
 * The job list is supplied by the caller (the harness owns it); a null/failed listing
 * is treated as UNKNOWN and blocks re-dispatch, never as "no children".
 *
 * @returns {{state: 'live'|'none'|'unknown', matches: object[], reason: string|null}}
 */
export function probeWaveToken(token, jobs) {
  if (!token) return { state: 'unknown', matches: [], reason: 'no wave token recorded' };
  if (!Array.isArray(jobs)) return { state: 'unknown', matches: [], reason: 'harness job list unavailable' };
  const matches = jobs.filter((j) => {
    const hay = `${j?.label ?? ''} ${j?.name ?? ''} ${j?.prompt ?? ''} ${j?.id ?? ''}`;
    return hay.includes(token);
  });
  const live = matches.filter((j) => {
    const s = String(j?.status ?? '').toLowerCase();
    return s === '' || s === 'running' || s === 'pending' || s === 'in_progress';
  });
  if (live.length) return { state: 'live', matches: live, reason: null };
  return { state: 'none', matches, reason: null };
}

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
// Per-task adversary review (config-gated; the fabric parity of L2's review())
// ---------------------------------------------------------------------------

/**
 * Capture a repo's FULL working diff: tracked changes vs HEAD plus every
 * untracked file rendered via `git diff --no-index /dev/null <f>` (exit 1 is
 * the "differs" success case). Deliberately NOT filtered to any declared
 * scope — an out-of-scope write must be IN the review payload; scope
 * enforcement stays with recordWaveResult's D6 verify-scope, never the review.
 * Review engine ownership lives in agent-dispatch; masterplan only captures
 * the payload and routes it through dispatch_review.
 */
export function captureFullWorkingDiff(repo, _exec = execFileSync) {
  const git = (args, allowExit1 = false) => {
    try {
      return String(_exec('git', ['-C', repo, '-c', 'core.quotePath=false', ...args], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (err) {
      if (allowExit1 && err.status === 1 && err.stdout != null) return String(err.stdout);
      const stderr = String(err?.stderr ?? '').trim();
      throw new Error(`captureFullWorkingDiff: git -C ${repo} ${args.join(' ')} failed: ${stderr || err.message}`);
    }
  };
  let out = git(['diff', 'HEAD']);
  // -z + NUL split: newline-split output C-quotes paths carrying quotes/tabs/
  // newlines (even under core.quotePath=false), and a quoted literal handed to
  // `diff --no-index` ENOENTs. NUL termination disables quoting entirely.
  const untracked = git(['ls-files', '-z', '-o', '--exclude-standard']).split('\0').filter(Boolean);
  for (const f of untracked) {
    out += git(['diff', '--no-index', '--', '/dev/null', f], true);
  }
  return out;
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
 * @property {Function}[_callReview]        — injectable dispatch_review seam (tests; default: client.callTool('dispatch_review', args))
 */

/**
 * Dispatch the active wave through the agent-dispatch broker (a bounded pool
 * of per-task dispatch_task calls) and record the digests via the standard
 * record-result transaction.
 *
 * Idempotent on the wave-dispatch key (run_id, wave, 'dispatch_fabric'): the
 * record is persisted BEFORE the broker call; a retry after an
 * accepted-but-unobserved dispatch returns the existing record and never
 * double-dispatches. See the module header for the full status lifecycle.
 *
 * @param {DispatchWaveOptions} opts
 * @returns {Promise<object>} one result JSON the shell prints (outcome-first)
 */
/**
 * Native-path review ingestion. Runs the same centralized reviewCompletedTasks
 * flow the MCP pool uses, using review_context frozen into the wave-dispatch
 * record at plan time. Returns a NEW result object; never mutates the caller's.
 * Old records without review_context (or with enabled:false) are a pure no-op.
 */
export async function reviewNativeResult({
  statePath, result, brokerBin, _brokerClient = null, now = Date.now(),
} = {}) {
  if (!statePath || result == null) return result;
  const absState = path.resolve(statePath);
  const state = readState(absState);
  const wave = Number.isInteger(result?.wave)
    ? result.wave
    : (Number.isInteger(state.active_run?.wave) ? state.active_run.wave : null);
  if (!Number.isInteger(wave)) return result;
  const bundleDir = path.dirname(absState);
  const record = readWaveDispatchRecord(bundleDir, wave);
  const ctx = record?.review_context;
  if (!ctx?.enabled) return result;

  const usingInjected = _brokerClient != null;
  const client = usingInjected
    ? _brokerClient
    : createBrokerClient({ bin: brokerBin });
  try {
    if (!usingInjected) await client.initialize();
    const diffCache = new Map();
    const items = (result.tasks ?? []).map((item) => {
      const taskId = item?.task_id ?? item?.digest?.task_id;
      const task = (ctx.tasks ?? []).find((t) => String(t.task_id) === String(taskId));
      if (!task) return { ...item, task_id: taskId };
      let payload = diffCache.get(task.repo);
      if (!payload) {
        const diff = captureFullWorkingDiff(task.repo);
        payload = {
          diff,
          sha: createHash('sha256').update(diff, 'utf8').digest('hex'),
        };
        diffCache.set(task.repo, payload);
      }
      return {
        ...item,
        task_id: task.task_id,
        review_input: {
          repo: task.repo,
          description: task.description,
          class: task.class,
          diff: payload.diff,
          sha: payload.sha,
        },
      };
    });
    const reviewed = await reviewCompletedTasks({
      statePath: absState,
      runId: String(state.slug ?? record?.run_id ?? ''),
      wave,
      baseSha: ctx.base_sha,
      items,
      callReview: (args) => client.callTool('dispatch_review', args),
      now,
    });
    return {
      ...result,
      tasks: reviewed.map(({ review_input, ...item }) => item),
    };
  } finally {
    if (!usingInjected) {
      try { client.close(); } catch { /* teardown is best-effort */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Prepare stages extracted from dispatchWaveViaFabric (gate → context → descriptors).
// Behavior-preserving: the orchestrator sequences these and then the execute
// stages (acquire → native fork / broker → finalize).
// ---------------------------------------------------------------------------

/**
 * Flag gate + wave marker + idempotency record (pending/dispatched/recorded).
 * Early exits: flag-off, reused/pending, reused/dispatched (redrive).
 * Fall-through returns the validated context for the rest of the wave path.
 */
export function gateAndValidate({
  statePath,
  self = null,
  now,
  ttlMs,
  wave: waveFlag = null,
  takeover = false,
  _record = recordWaveResult,
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
      reason: 'state.dispatch.fabric is not true — the fabric wave path is gated per run; the legacy dispatch_fabric/dispatch_fabric ops apply',
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
  // new attempt is a legitimate OBSERVED retry (recover_wave), not a
  // double-dispatch. Zero pending tasks → nothing to do (checked below).
  return { absState, bundleDir, state, run, wave, runId, key, existing, markerWave };
}

/**
 * Shared launch context (buildWaveLaunchContext) + worktree/fingerprint.
 * Early exit: no-pending-tasks. Throws when a fresh dispatch lacks the launching marker.
 */
export function resolveWaveContext({
  absState,
  state,
  run,
  wave,
  runId,
  key,
  existing,
  codexSuppressed = false,
  markerWave = null,
  _captureFingerprint = captureInputFingerprint,
} = {}) {
  // 4. Routed tasks — shared launch-context seam (buildWaveLaunchContext):
  //    plan-index read, config/env from injected routingInputs, prepareWave,
  //    MAIN from bundleDir. Fabric path omits reposAllowlist (broker routing).
  const bundleDir = path.dirname(absState);
  const planIndexPath = state.plan_index_path ?? path.join(bundleDir, 'plan.index.json');
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
  let prepared;
  let MAIN;
  try {
    ({ prepared, MAIN } = buildWaveLaunchContext({
      state,
      planIndexPath,
      wave,
      routingInputs,
      // fabric path: reposAllowlist intentionally omitted (broker-side routing)
    }));
  } catch (e) {
    // Preserve the dispatch-wave-prefixed error surface for missing/unreadable
    // plan.index so existing callers and tests keep matching the prior messages.
    const msg = String(e?.message ?? e);
    if (/plan\.index\.json not found/.test(msg)) {
      throw new Error(`dispatch-wave: plan.index.json not found at ${planIndexPath} — cannot resolve descriptions/verify_commands`);
    }
    if (/plan\.index\.json unreadable/.test(msg)) {
      throw new Error(`dispatch-wave: ${msg}`);
    }
    throw e;
  }
  const tasks = prepared.tasks;
  if (tasks.length === 0) {
    return { outcome: 'no-pending-tasks', dispatched: false, wave, key, record: existing ?? null };
  }
  const effectiveMarkerWave = markerWave ?? (Number.isInteger(run?.wave) ? run.wave : null);
  if (effectiveMarkerWave === null) {
    // Fresh dispatch needs the launching marker (frozen scope/baseline + the
    // record transaction's anchor); --wave alone only serves record queries.
    throw new Error('dispatch-wave: no phase-1 launching marker for a fresh dispatch — run `mp continue` first');
  }

  // 5. The run's EXISTING worktree + the launch-time input fingerprint.
  const WT = path.resolve(String(state.worktree ?? ''));
  if (!state.worktree || !fs.existsSync(WT)) {
    throw new Error(`dispatch-wave: worktree ${state.worktree ?? '(unset)'} missing — \`mp continue\` creates/records it before emitting dispatch_fabric`);
  }
  const inputs = _captureFingerprint(WT);

  return { prepared, tasks, WT, MAIN, inputs, routingInputs };
}

/**
 * Per-task locus resolution + buildWorkItem + branch/create_files packaging.
 * No early exit — returns descriptors and the parallel local-verify command list.
 */
export function buildDescriptors({
  tasks,
  WT,
  MAIN,
  runId,
  inputs,
  reviewOn,
  verifyTimeoutS,
  effectiveAllowlist,
} = {}) {
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
  const workItemOpts = {
    verify_timeout_s: verifyTimeoutS,
    skynetVerifyAllowlist: effectiveAllowlist,
  };
  const localVerifyCommands = [];
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
    const verify = rewriteVerifyForSibling(t.verify_commands, locus.siblingName, {
      mainRoot: MAIN,
      repo: locus.repo,
    });
    localVerifyCommands.push(verify);
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
        review: reviewOn ? { adversary: true } : null,
      }, workItemOpts),
    };
    // Branch: prefer the locus's masterplan branch (sibling worktree); fall back
    // to the umbrella worktree branch for in-repo tasks.
    const branch = locus.branch || wtBranch;
    if (branch) desc.branch = branch;
    // create_files: existence-aware edit routing (missing paths → write loop).
    // agent-dispatch dispatch_task gateway edit defaults create_files:true when
    // omitted (task 49 S-B); set explicitly so wave descriptors advertise intent
    // in logs/leases and cannot inherit a stale create_files:false template.
    desc.create_files = true;
    return desc;
  });
  return { descriptors, localVerifyCommands, wtBranch };
}

// ---------------------------------------------------------------------------
// Execute stages extracted from dispatchWaveViaFabric (acquire → launch/broker → finalize).
// Behavior-preserving: the orchestrator sequences these after the prepare stages.
// ---------------------------------------------------------------------------

/**
 * Guard D ownership + attempt token + watch precheck + pending record persistence.
 * Early exits: precheck-failed, reused (attempt-claim / create race).
 * Fall-through returns { attempt, waveToken, record, watchBaseline }.
 */
export function acquireAndWatch({
  absState,
  bundleDir,
  state,
  run,
  self = null,
  now,
  ttlMs,
  wave,
  runId,
  key,
  existing,
  tasks,
  descriptors,
  WT,
  MAIN,
  inputs,
  routingInputs,
  reviewOn,
  effectiveAllowlist,
  takeover = false,
} = {}) {
  // 7. GUARD D FIRST (review finding 1), then persist the wave-dispatch record
  //    BEFORE the broker call (the whole point: a crash after the broker accepts
  //    leaves 'pending' on disk, and the retry above returns it instead of
  //    double-dispatching). Ownership is acquired + heartbeat-confirmed with the
  //    same helpers continue/record-result use — a blocked/lost lock throws and
  //    NOTHING is written or dispatched.
  assertDispatchOwnership(state, bundleDir, self, { now, ttlMs });
  const attempt = existing ? (existing.attempt ?? 0) + 1 : 1;

  // 7b. TWO-PHASE LAUNCH — phase 1. The token is durable BEFORE any child starts, so a
  //     crash in the launch window is recoverable by job-list match instead of guessing.
  const waveToken = composeWaveToken(runId, wave, attempt);

  // 7c. CROSS-LOCUS WATCH-LIST PRECHECK (CD-2). Snapshot MAIN + every scoped repo and
  //     refuse the launch if any task-scoped file is already dirty — a child would
  //     overwrite uncommitted user work, and the after-capture could not attribute it.
  //     The baseline doubles as the completion-side integrity comparison in record-result.
  const scopePaths = canonicalizeScopePaths(
    run?.scope ?? tasks.flatMap((t) => t.files ?? []),
    { worktree: WT, mainRoot: MAIN, slug: runId },
  );
  const watchBaseline = captureWatchBaseline({
    mainRoot: MAIN, bundleDir, worktree: WT, slug: runId, scopePaths,
  });
  const pre = precheckWatchList(watchBaseline.snapshots, scopePaths, {
    // The frozen D6 baseline `mp continue` captured before this run's first launch.
    // Task-scoped dirt present there is the user's; dirt that appeared later is a prior
    // attempt's residue that a recover_wave retry is entitled to overwrite.
    baseline: Array.isArray(run?.baseline) ? run.baseline : null,
  });
  if (!pre.ok) {
    appendEvent(absState, {
      type: 'watch_list_precheck_failed',
      wave,
      attempt,
      violations: pre.violations,
      at: new Date(now ?? Date.now()).toISOString(),
    });
    return {
      outcome: 'precheck-failed',
      dispatched: false,
      wave,
      key,
      violations: pre.violations,
      reason: 'watch-list precheck failed — a task-scoped file is dirty in a watched repo, or a watched repo could not be read. Dispatching would overwrite uncommitted work (CD-2). Commit or stash it, then retry.',
    };
  }
  writeWatchBaseline(bundleDir, wave, watchBaseline);

  const record = {
    key,
    run_id: runId,
    wave,
    op: WAVE_DISPATCH_OP,
    contract_version: CONTRACT_VERSION,
    status: 'pending',
    attempt,
    wave_token: waveToken,
    handles: [],
    dispatched_at: new Date(now ?? Date.now()).toISOString(),
    // Finding 2: freeze the prepare inputs + the prepared lean payload so retries
    // provably re-prepare from the SAME inputs (and audits can diff the payload).
    routing_inputs: routingInputs,
    payload: tasks,
    tasks: descriptors.map((d) => ({ task_id: d.task_id, class: d.class, handoff_key: d.handoff_key })),
    // D3/R6: effective SKYNET_VERIFY_ALLOWLIST once per wave (default 'bash -c';
    // caller override preserved). Surfaces in the dispatch record for audit.
    gateway_verify_allowlist: effectiveAllowlist,
    // Native result-ingestion parity: task review context is durable BEFORE spawn so
    // `mp record-result` can run the same centralized review without re-deriving
    // task description/class/repo from a live marker that may already be gone.
    // Absent/disabled on old records → reviewNativeResult is a pure no-op.
    review_context: {
      enabled: reviewOn,
      base_sha: inputs.head,
      tasks: tasks.map((task, i) => ({
        task_id: task.id,
        description: task.description,
        class: task.class,
        repo: descriptors[i]?.repo ?? WT,
      })),
    },
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

  return { attempt, waveToken, record, watchBaseline };
}

/**
 * Per-task routing resolution + native spawn plan construction.
 * Early exits: routing-unresolved, native-spawn-plan (always returns an outcome).
 */
export function buildNativePlan({
  tasks,
  descriptors,
  waveToken,
  wave,
  runId,
  key,
  record,
  bin,
} = {}) {
  const plan = buildNativeSpawnPlan({ tasks, descriptors, token: waveToken, bin });
  const unrouted = plan.tasks.filter((s) => !s.routing_resolved);
  if (unrouted.length) {
    // Fail closed: an unresolvable class means we would spawn a child on a guessed
    // lane. That is exactly the silent-degradation this bundle exists to remove.
    return {
      outcome: 'routing-unresolved',
      dispatched: false,
      wave,
      key,
      wave_token: waveToken,
      unresolved: unrouted.map((s) => ({ task_id: s.task_id, class: s.class, reason: s.routing_reason })),
      reason: 'agent-dispatch resolve did not return a route for every wave task class — refusing to spawn children on a guessed lane',
    };
  }
  return {
    outcome: 'native-spawn-plan',
    dispatched: false,
    awaiting_launch: true,
    wave,
    key,
    wave_token: waveToken,
    plan,
    record,
    reason: 'native-spawn host: spawn these descriptors with the harness parallel subagent API (bounded by plan.concurrency), then record handles and feed results to `mp record-result`',
  };
}

/**
 * Coord open/close + broker pool dispatch + local verify + per-task review.
 * Keeps one broker client for dispatch + review, closed in finally.
 * Returns { digests }.
 */
export async function runBrokerDispatch({
  tasks,
  descriptors,
  WT,
  localVerifyCommands,
  verifyTimeoutS,
  reviewOn,
  absState,
  runId,
  wave,
  inputs,
  now,
  brokerBin,
  effectiveAllowlist,
  run = null,
  _brokerClient = null,
  _openCoord = openWaveCoord,
  _closeCoord = closeWaveCoord,
  _callReview = null,
  _localVerifyExec = null,
} = {}) {
  // 8. Coord (fail-open) + broker pool + local verify + task review + paired close.
  // SKYNET_VERIFY_ALLOWLIST is injected into the serve-mcp child env (unless the
  // caller already set it) so the gateway accepts bash -c-wrapped verify[0].
  // The broker client stays open through writer dispatch, local verify, and
  // per-task dispatch_review so the same MCP session owns both tools.
  const usingInjected = _brokerClient != null;
  const client = usingInjected
    ? _brokerClient
    : createBrokerClient({
      bin: brokerBin,
      env: { SKYNET_VERIFY_ALLOWLIST: effectiveAllowlist },
    });
  let coordHandle = null;
  let digests;
  const closeCoordHandles = () => {
    if (coordHandle) {
      try { coordHandle.close(); } catch { /* fail-open */ }
      coordHandle = null;
    }
    if (run?.coordJobId) {
      try { _closeCoord({ jobId: run.coordJobId }); } catch { /* fail-open */ }
    }
  };
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
      // The MCP broker fan-out tool is RETIRED (2026-07-17 cutover). Drive the wave as a
      // bounded concurrent pool of dispatch_task calls — same translate path as
      // single-task dispatchTask. Isolated fail mode: one task's error never
      // cancels siblings. Concurrency defaults to 8 (policy fanout max_concurrency).
      const concurrency = normalizeWaveConcurrency(null, wireDescriptors.length);
      const results = new Array(wireDescriptors.length);
      let nextIdx = 0;
      async function worker() {
        for (;;) {
          const i = nextIdx++;
          if (i >= wireDescriptors.length) return;
          try {
            results[i] = await client.callTool('dispatch_task', {
              descriptor: wireDescriptors[i],
            });
          } catch (err) {
            // Per-task isolation: broker_error digest (same as whole-wave catch),
            // so a single RPC failure never cancels siblings and still emits
            // dispatch_degraded via record-result.
            results[i] = { __broker_error: err?.message ?? String(err) };
          }
        }
      }
      const pool = Array.from(
        { length: Math.min(concurrency, Math.max(wireDescriptors.length, 1)) },
        () => worker(),
      );
      await Promise.all(pool);
      digests = tasks.map((t, i) => {
        const r = results[i];
        if (r && typeof r === 'object' && r.__broker_error) {
          return brokerErrorDigest(t.id, r.__broker_error, 'dispatch_task');
        }
        return translateBrokerResult(t.id, r ?? null).digest;
      });
    } catch (err) {
      // Client/spawn/RPC failure → every task blocked with outcome:'broker_error'
      // (record-result turns these into dispatch_degraded events — fail-VISIBLE).
      digests = tasks.map((t) => brokerErrorDigest(t.id, err.message, 'dispatch_task'));
    }

    // Coord closes immediately after writer dispatch — never held open for review.
    closeCoordHandles();

    // 8a. ORCHESTRATOR FULL-LIST LOCAL VERIFY (D2) — gateway only runs verify[0];
    //     the FULL list is enforced HERE under a real shell (bash -c) before
    //     record-result. Fail-closed: broker-done + local-verify fail → failed.
    for (let i = 0; i < digests.length; i++) {
      const digest = digests[i];
      if (!digest || digest.status !== 'done') continue;
      const rawCmds = Array.isArray(localVerifyCommands[i]) ? localVerifyCommands[i] : [];
      if (rawCmds.length === 0) {
        if (!Array.isArray(digest.verify)) digest.verify = [];
        continue;
      }
      const repo = descriptors[i]?.repo ?? WT;
      const local = runLocalVerifyCommands(rawCmds, {
        cwd: repo,
        timeoutS: verifyTimeoutS,
        ...(typeof _localVerifyExec === 'function' ? { _exec: _localVerifyExec } : {}),
      });
      digest.verify = local;
      if (local.some((v) => !v.passed)) {
        digest.status = 'failed';
        digest.summary = `local verify failed: ${local.filter((v) => !v.passed).map((v) => v.command).join('; ')}`;
        digest.blockers = digest.summary;
      }
    }

    // 8b. PER-TASK ADVERSARY REVIEW — config-gated. Explicit dispatch_review via
    //     the open broker client; lifecycle/persistence owned by reviewCompletedTasks.
    //     Full edit-locus working diff (not scope-filtered). D6 remains independent.
    if (reviewOn) {
      const diffCache = new Map();
      const reviewItems = digests.map((digest, i) => {
        const repo = descriptors[i]?.repo ?? WT;
        let payload = diffCache.get(repo);
        if (!payload) {
          const diff = captureFullWorkingDiff(repo);
          payload = { diff, sha: createHash('sha256').update(diff, 'utf8').digest('hex') };
          diffCache.set(repo, payload);
        }
        return {
          task_id: tasks[i].id,
          digest,
          review_input: {
            repo,
            diff: payload.diff,
            sha: payload.sha,
            description: tasks[i].description,
            class: tasks[i].class,
          },
        };
      });
      const reviewed = await reviewCompletedTasks({
        statePath: absState,
        runId,
        wave,
        baseSha: inputs.head,
        items: reviewItems,
        callReview: (args) => (_callReview
          ? _callReview(args)
          : client.callTool('dispatch_review', args)),
        now: now ?? Date.now(),
      });
      digests = reviewed.map((item) => item.digest);
    }
  } finally {
    closeCoordHandles();
    if (!usingInjected) {
      try { client.close(); } catch { /* teardown is best-effort */ }
    }
  }

  return { digests };
}

/**
 * Persist digests, run recordWaveResult, finalize record status.
 * Returns the final dispatched outcome object.
 */
export function finalizeRecord({
  absState,
  bundleDir,
  wave,
  key,
  attempt,
  record,
  digests,
  run,
  self = null,
  now,
  WT,
  _record = recordWaveResult,
} = {}) {
  // 9. Digests durable BEFORE the record transaction: a crash between here and
  //    record completion re-drives record-result from THIS result — the broker
  //    is never called again for this attempt.
  const result = {
    wave,
    tasks: digests.map((d) => ({ task_id: d.task_id, digest: d, ...(d.review ? { review: d.review } : {}) })),
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
      ...(d.review ? { review: d.review.verdict } : {}),
    })),
    record_status: current.status,
    record: recordResult,
  };
}

export async function dispatchWaveViaFabric({
  statePath,
  self = null,
  now,
  ttlMs,
  wave: waveFlag = null,
  takeover = false,
  codexSuppressed = false,
  nativeSpawn = null,
  brokerBin,
  _brokerClient = null,
  _openCoord = openWaveCoord,
  _closeCoord = closeWaveCoord,
  _record = recordWaveResult,
  _captureFingerprint = captureInputFingerprint,
  _callReview = null,
  _localVerifyExec = null, // injectable runLocalVerifyCommands._exec (tests)
} = {}) {
  const gate = gateAndValidate({ statePath, self, now, ttlMs, wave: waveFlag, takeover, _record });
  if (gate.outcome) return gate;
  const { absState, bundleDir, state, run, wave, runId, key, existing, markerWave } = gate;

  const ctx = resolveWaveContext({
    absState, state, run, wave, runId, key, existing, codexSuppressed, markerWave,
    _captureFingerprint,
  });
  if (ctx.outcome) return ctx;
  const { prepared, tasks, WT, MAIN, inputs, routingInputs } = ctx;

  // Per-bundle adversary-review switch — the SAME gate L2's execute workflow
  // consumes (continue.mjs reviewMode parity, incl. the legacy
  // state.codex.review fallback). Computed HERE so the work-item descriptors
  // can advertise the review requirement (descriptor-only; never hashed).
  const reviewOn = normalizeReviewMode(state.review?.adversary ?? state.codex?.review) === 'on';
  // D3: verify timeout + allowlist — orchestrator-side packaging for the gateway seam.
  const verifyTimeoutS = Number.isFinite(state.dispatch?.verify_timeout_s)
    ? state.dispatch.verify_timeout_s
    : DEFAULT_VERIFY_TIMEOUT_S;
  // Effective allowlist for this wave (caller env wins; default 'bash -c').
  const callerAllowlist = process.env.SKYNET_VERIFY_ALLOWLIST;
  const effectiveAllowlist = (callerAllowlist != null && String(callerAllowlist).trim() !== '')
    ? String(callerAllowlist)
    : DEFAULT_SKYNET_VERIFY_ALLOWLIST;

  const { descriptors, localVerifyCommands, wtBranch } = buildDescriptors({
    tasks, WT, MAIN, runId, inputs, reviewOn, verifyTimeoutS, effectiveAllowlist,
  });

  const acq = acquireAndWatch({
    absState, bundleDir, state, run, self, now, ttlMs, wave, runId, key, existing,
    tasks, descriptors, WT, MAIN, inputs, routingInputs, reviewOn, effectiveAllowlist,
    takeover,
  });
  if (acq.outcome) return acq;
  const { attempt, waveToken, record } = acq;

  // Launch-path branch (native-spawn): after acquire/watch, before broker.
  // Harness owns child spawn; crash recovery is probeWaveToken, not re-dispatch.
  if (selectLaunchPath({ codexSuppressed, nativeSpawn }) === 'native-spawn') {
    return buildNativePlan({
      tasks, descriptors, waveToken, wave, runId, key, record, bin: brokerBin,
    });
  }

  const { digests } = await runBrokerDispatch({
    tasks, descriptors, WT, localVerifyCommands, verifyTimeoutS, reviewOn,
    absState, runId, wave, inputs, now, brokerBin, effectiveAllowlist, run,
    _brokerClient, _openCoord, _closeCoord, _callReview, _localVerifyExec,
  });
  return finalizeRecord({
    absState, bundleDir, wave, key, attempt, record, digests, run, self, now, WT, _record,
  });
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
