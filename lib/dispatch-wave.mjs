// lib/dispatch-wave.mjs — the `dispatch_fabric` op consumer (`mp dispatch-wave`).
//
// Deterministic, zero-LLM-token wave dispatcher. Waves launch as NATIVE SPAWN
// PLANS: per-task descriptors the orchestrating harness executes with its own
// parallel subagent API, each pinned to a governed lane resolved from the
// repo-local routing policy (policy/workflow-map.json — classes -> agent role
// + lane model ref, never a guessed model). Results feed the SAME
// record-result transaction every dispatch vehicle uses.
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
//   buildDescriptors  — one fabric work item per routed task (buildWorkItem)
//                       with handoff key from the launch-time input fingerprint
//                       over the run's EXISTING worktree.
//   acquireAndWatch   — Guard D ownership (acquireOwner/heartbeatOwner; owner_lock=off
//                       escape hatch); attempt/token; watch baseline + precheck;
//                       pending record + review_context freeze BEFORE launch.
//                       Blocked/lost ownership THROWS.
//   buildNativePlan   — returns the spawn-plan descriptors for harness spawn;
//                       crash recovery via probeWaveToken, not re-dispatch.
//
// Boundary notes: same git-in-bin seam as continue/record-result (LOCAL git only,
// via captureInputFingerprint / recordWaveResult). Guard D: the caller resolves
// owner identity (bin); acquireAndWatch acquires + heartbeat-confirms before any
// launch transition, and recordWaveResult heartbeats it again.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { readState, appendEvent } from './bundle.mjs';
import { buildWaveLaunchContext, captureInputFingerprint } from './wave.mjs';
import { normalizeReviewMode } from './dispatch/ops.mjs';
import { reviewCompletedTasks } from './task-review.mjs';
import { recordWaveResult } from './wave-commit.mjs';
import {
  captureWatchBaseline,
  writeWatchBaseline,
  precheckWatchList,
} from './watch-integrity.mjs';
import { acquireOwner, heartbeatOwner } from './owner-fs.mjs';
import { CONTRACT_VERSION, DEFAULT_SKYNET_VERIFY_ALLOWLIST } from './dispatch/verify-transport.mjs';
import { buildWorkItem } from './dispatch/dispatch-digest.mjs';
import { resolveWorkClass } from './dispatch/routing-policy.mjs';
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
// Native spawn path — the ONLY launch path
// ---------------------------------------------------------------------------
//
// Every wave launches as a SPAWN PLAN: per-task descriptors the orchestrating
// harness executes with its own parallel subagent API, each pinned to the
// governed lane the repo-local routing policy resolves for the task class.
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
 * Resolve one task class to its governed lane facts via the repo-local routing
 * policy (policy/workflow-map.json; optional MP_ROUTING_POLICY override).
 *
 * Deliberately a policy lookup and not a copied table: the routing source of
 * truth is the fleet workflow routing map, checked in once and refreshed by a
 * documented step — masterplan never holds hand-written model ids. Cached per
 * process + policy path — a wave's tasks share few classes.
 *
 * @returns {{lane: string|null, model: string|null, effort: string|null,
 *            capability: string|null, agent: string|null, writes: boolean|null,
 *            panel: string|null, resolved: boolean, reason: string|null}}
 */
export function resolveClassRouting(taskClass, { policy = null, _cache = CLASS_ROUTING_CACHE } = {}) {
  if (!taskClass) return { lane: null, model: null, effort: null, capability: null, agent: null, writes: null, panel: null, resolved: false, reason: 'no class' };
  const cacheKey = `${taskClass}\u0000${policy ? 'injected' : (process.env.MP_ROUTING_POLICY || 'repo')}`;
  if (_cache?.has(cacheKey)) return _cache.get(cacheKey);
  let out;
  try {
    const r = resolveWorkClass(taskClass, policy ? { policy } : {});
    out = {
      lane: r.lane,
      model: r.model,
      effort: r.effort,
      capability: r.cap,
      agent: r.agent,
      writes: r.writes,
      panel: r.panel ?? null,
      resolved: true,
      reason: null,
    };
  } catch (err) {
    out = { lane: null, model: null, effort: null, capability: null, agent: null, writes: null, panel: null, resolved: false, reason: `routing policy resolution failed: ${err?.message ?? err}` };
  }
  _cache?.set(cacheKey, out);
  return out;
}

/**
/**
 * Build the native spawn plan for a wave: one descriptor per routed task.
 *
 * Each descriptor is everything the host needs to spawn a child on the governed
 * routing the policy resolves for the task class — the lane model ref, the effort,
 * the agent role, the edit locus, the file scope, the prompt, and the badge the TUI
 * renders. The wave token rides in both the label and the prompt so a recovery pass
 * can find the children by string match against the harness job list.
 *
 * @returns {{token: string, concurrency: number, tasks: object[]}}
 */
export function buildNativeSpawnPlan({
  tasks,
  descriptors,
  token,
  concurrency,
  policy = null,
  _resolve = resolveClassRouting,
} = {}) {
  const spawns = (tasks ?? []).map((t, i) => {
    const desc = descriptors?.[i] ?? {};
    const routing = _resolve(t.class, { policy });
    const lane = routing.lane ?? null;
    const model = routing.model ?? null;
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
      // The badge the TUI renders for this child. `model` is the lane's model ref,
      // which is what a reader wants to see; the lane itself rides on the descriptor.
      badge: {
        class: t.class ?? null,
        backend: 'native',
        model: routing.model ?? '',
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
 * Same ':'-encoding as lib/fabric-idempotency.mjs composeHandoffKey so the key is
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
 * Review execution is harness-native (adversary class descriptors); masterplan
 * captures the payload and records the review through reviewCompletedTasks.
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
 * @property {object}  [policy]        — injected routing policy (tests; default repo copy / MP_ROUTING_POLICY)
 * @property {Function}[_record]           — injectable recordWaveResult seam (tests)
 * @property {Function}[_captureFingerprint] — injectable captureInputFingerprint seam (tests)
 */

/**
 * Dispatch the active wave as a native spawn plan: per-task descriptors the
 * orchestrating harness executes with its parallel subagent API, results
 * recorded via the standard record-result transaction.
 *
 * Idempotent on the wave-dispatch key (run_id, wave, 'dispatch_fabric'): the
 * record is persisted BEFORE launch; a retry after an accepted-but-unobserved
 * launch returns the existing record and never double-dispatches. See the
 * module header for the full status lifecycle.
 *
 * @param {DispatchWaveOptions} opts
 * @returns {Promise<object>} one result JSON the shell prints (outcome-first)
 */
/**
 * Native-path review ingestion. Runs the same centralized reviewCompletedTasks
 * flow the native review seam uses, using review_context frozen into the wave-dispatch
 * record at plan time. Returns a NEW result object; never mutates the caller's.
 * Old records without review_context (or with enabled:false) are a pure no-op.
 */
/**
 * Native adversarial review seam for a wave's completed tasks.
 *
 * Two-phase orchestrator contract (harness-native; no transport in this module):
 *   Phase A (no providedReviews): enrich each done task with review_input
 *     (edit-locus working diff + sha) and return pending_reviews spawn
 *     descriptors — one per unreviewed task, class 'adversary' resolved from
 *     the routing policy — under review_outcome:'native-review-pending'. The
 *     orchestrator runs them with harness-native subagents.
 *   Phase B (providedReviews supplied): ingest the orchestrator-collected
 *     review records through the same reviewCompletedTasks engine. A missing
 *     provided review fails closed as an 'error' review — never a silent
 *     approve.
 *
 * @param {{ statePath: string, result: object, providedReviews?: Object<string,object>|null,
 *           policy?: object|null, now?: number }} opts
 */
export async function reviewNativeResult({
  statePath, result, providedReviews = null, policy = null, now = Date.now(),
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

  const runId = String(state.slug ?? record?.run_id ?? '');
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

  const doneUnreviewed = items.filter((it) => it?.digest?.status === 'done' && !it.review);

  // Phase A — emit native review descriptors for the orchestrator to run.
  if (providedReviews == null) {
    if (doneUnreviewed.length === 0) return { ...result, tasks: items };
    const adversary = resolveWorkClass('adversary', policy ? { policy } : {});
    const pending = doneUnreviewed.map((it) => ({
      task_id: it.task_id,
      class: 'adversary',
      agent: adversary.agent,
      model: adversary.model,
      effort: adversary.effort,
      repo: it.review_input.repo,
      diff_sha: it.review_input.sha,
      job_id: `${runId}-w${wave}-t${it.task_id}-${it.review_input.sha.slice(0, 12)}`,
    }));
    return {
      ...result,
      tasks: items,
      pending_reviews: pending,
      review_outcome: 'native-review-pending',
    };
  }

  // Phase B — ingest orchestrator-collected native review records.
  const provided = new Map(Object.entries(providedReviews).map(([k, v]) => [String(k), v]));
  const jobIdToTask = new Map(doneUnreviewed.map((it) => [
    `${runId}-w${wave}-t${it.task_id}-${it.review_input.sha.slice(0, 12)}`,
    String(it.task_id),
  ]));
  const reviewed = await reviewCompletedTasks({
    statePath: absState,
    runId,
    wave,
    baseSha: ctx.base_sha,
    items,
    callReview: async (args) => {
      const taskId = jobIdToTask.get(args.job_id) ?? String(args.task_id ?? '');
      const rec = provided.get(taskId);
      if (rec == null) {
        throw new Error(`native adversarial review not provided for task ${taskId}`);
      }
      return rec;
    },
    now,
  });
  return {
    ...result,
    tasks: reviewed.map(({ review_input, ...item }) => item),
    review_outcome: 'native-reviews-recorded',
  };
}

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
  //    emits the dispatch_fabric op. The legacy L2 wave path was deleted
  //    (lib/continue.mjs fabricActive = true, 2026-08-29, A3); fabric is the ONLY
  //    wave path, so a bundle without state.dispatch.fabric:true is
  //    UNEXECUTABLE — fail closed rather than silently no-op (the old reason text
  //    claimed "legacy dispatch_fabric/dispatch_fabric ops apply", ops that no
  //    longer exist). A non-fabric bundle surfaces this loudly at dispatch time.
  if (state.dispatch?.fabric !== true) {
    return {
      outcome: 'flag-off',
      dispatched: false,
      reason: 'state.dispatch.fabric is not true — the fabric wave path is the ONLY wave path since the L2 legacy dispatch_fabric/dispatch_fabric ops were deleted (A3); this bundle is unexecutable. Re-seed with --fabric=on (the default) or repair state.dispatch.fabric.'
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
    // and may have launched children before dying. NEVER re-dispatch here.
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
    // Results are durable in the record but the record-result transaction never
    // completed (crash between result ingestion and record). Re-drive record-result
    // from the STORED result — nothing is re-launched. Ownership first:
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
  //    MAIN from bundleDir. Fabric path omits reposAllowlist (routing is policy-resolved).
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
      // fabric path: reposAllowlist intentionally omitted (routing is policy-resolved)
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
} = {}) {
  // 6. One fabric work item per routed task — the per-task handoff key
  //    (run_id, task_id, task_spec_hash, input_fingerprint) is composed inside
  //    buildWorkItem. `branch` rides on each descriptor (descriptor-only:
  //    excluded from the task-spec hash, so handoff keys are unchanged).
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
      }),
    };
    // Branch: prefer the locus's masterplan branch (sibling worktree); fall back
    // to the umbrella worktree branch for in-repo tasks.
    const branch = locus.branch || wtBranch;
    if (branch) desc.branch = branch;
    // create_files: existence-aware edit routing (missing paths → write loop).
    // Set explicitly so wave descriptors advertise intent and cannot inherit a
    // stale create_files:false template.
    desc.create_files = true;
    return desc;
  });
  return { descriptors, localVerifyCommands, wtBranch };
}

// ---------------------------------------------------------------------------
// Execute stages extracted from dispatchWaveViaFabric (acquire → launch plan).
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
  //    BEFORE launch (the whole point: a crash after children are accepted
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
  policy = null,
} = {}) {
  const plan = buildNativeSpawnPlan({ tasks, descriptors, token: waveToken, policy });
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
      reason: 'the routing policy did not resolve every wave task class — refusing to spawn children on a guessed lane',
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


export async function dispatchWaveViaFabric({
  statePath,
  self = null,
  now,
  ttlMs,
  wave: waveFlag = null,
  takeover = false,
  codexSuppressed = false,
  policy = null,
  _record = recordWaveResult,
  _captureFingerprint = captureInputFingerprint,
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
  // Effective allowlist for this wave (caller env wins; default 'bash -c').
  // Surfaced in the wave record for audit continuity.
  const callerAllowlist = process.env.SKYNET_VERIFY_ALLOWLIST;
  const effectiveAllowlist = (callerAllowlist != null && String(callerAllowlist).trim() !== '')
    ? String(callerAllowlist)
    : DEFAULT_SKYNET_VERIFY_ALLOWLIST;

  const { descriptors } = buildDescriptors({
    tasks, WT, MAIN, runId, inputs, reviewOn,
  });

  const acq = acquireAndWatch({
    absState, bundleDir, state, run, self, now, ttlMs, wave, runId, key, existing,
    tasks, descriptors, WT, MAIN, inputs, routingInputs, reviewOn, effectiveAllowlist,
    takeover,
  });
  if (acq.outcome) return acq;
  const { attempt, waveToken, record } = acq;

  // Native spawn plan: the harness owns child spawn; crash recovery is
  // probeWaveToken, not re-dispatch.
  return buildNativePlan({
    tasks, descriptors, waveToken, wave, runId, key, record, policy,
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
