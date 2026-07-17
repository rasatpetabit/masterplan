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
//   6b. Review — config-gated per-task adversary review (state.review.adversary,
//      the SAME gate L2's execute workflow reads): each DONE task's FULL working
//      diff (never scope-filtered) goes through the canonical adversary lane
//      (`agent-dispatch review --class adversary`, injectable via _reviewLane);
//      the verdict rides in digest.review / item.review → blocking_reviews[] in
//      the record protocol; idempotency via the unified keyed re-entry guard
//      (run+task+sha vocabulary, lib/reentry-guard.mjs; sha = sha256 of the
//      review payload, so changed code at the same HEAD re-arms the review).
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
import { createHash } from 'node:crypto';

import { readState, appendEvent } from './bundle.mjs';
import { prepareWave, captureInputFingerprint } from './wave.mjs';
import { normalizeReviewMode } from './dispatch/ops.mjs';
import { selectReentry, buildTaskReviewEvent, TASK_REVIEW_TYPES } from './reentry-guard.mjs';
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
// Per-task adversary review (config-gated; the fabric parity of L2's review())
// ---------------------------------------------------------------------------

/** L2 verdict vocabulary (workflows/execute.workflow.js extractVerdict). */
const REVIEW_VERDICTS = ['blocking', 'advisory', 'clean', 'inconclusive'];

/**
 * argv-safe cap for ONE --diff lane payload, accounted in BYTES
 * (Buffer.byteLength — multibyte safety; Linux MAX_ARG_STRLEN caps a single
 * argv arg at 128KiB). A larger working diff is NEVER truncated: it is
 * segmented (segmentDiffPayload) and reviewed one lane call per segment with
 * worst-wins merging, so the FULL-diff guarantee holds.
 */
const REVIEW_DIFF_MAX_BYTES = 100_000;

/**
 * Capture a repo's FULL working diff: tracked changes vs HEAD plus every
 * untracked file rendered via `git diff --no-index /dev/null <f>` (exit 1 is
 * the "differs" success case). Deliberately NOT filtered to any declared
 * scope — an out-of-scope write must be IN the review payload; scope
 * enforcement stays with recordWaveResult's D6 verify-scope, never the review.
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

// Hard-split one oversized chunk (a single line larger than maxBytes) into
// byte-bounded parts without corrupting multibyte chars: binary-search the
// largest char prefix within the byte budget, backing off a trailing high
// surrogate so a pair is never split.
function splitOversizedChunk(chunk, maxBytes) {
  const parts = [];
  let rest = chunk;
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    let lo = Math.max(1, Math.floor(maxBytes / 4)); // ≤ maxBytes bytes guaranteed (≤4 bytes/char)
    let hi = Math.min(rest.length, maxBytes);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (Buffer.byteLength(rest.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    let cut = lo;
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff && cut > 1) cut -= 1; // don't split a surrogate pair
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

/**
 * Segment a diff payload into argv-safe pieces: each segment ≤ maxBytes BYTES,
 * breaking at line boundaries (an oversized single line is hard-split by
 * bytes). LOSSLESS by construction — segments.join('') === the input — so the
 * lane sees every byte of the FULL working diff, never a truncation. Pure.
 */
export function segmentDiffPayload(diff, maxBytes = REVIEW_DIFF_MAX_BYTES) {
  const text = String(diff ?? '');
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const segments = [];
  let current = '';
  let currentBytes = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] + (i < lines.length - 1 ? '\n' : '');
    if (line === '') continue;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (lineBytes > maxBytes) {
      if (current) { segments.push(current); current = ''; currentBytes = 0; }
      segments.push(...splitOversizedChunk(line, maxBytes));
      continue;
    }
    if (currentBytes + lineBytes > maxBytes && current) {
      segments.push(current);
      current = '';
      currentBytes = 0;
    }
    current += line;
    currentBytes += lineBytes;
  }
  if (current) segments.push(current);
  return segments;
}

/** Worst-wins severity order for merging per-segment verdicts. */
const VERDICT_SEVERITY = { clean: 0, inconclusive: 1, advisory: 2, blocking: 3 };

/**
 * Merge two mapped review results worst-wins (blocking > advisory >
 * inconclusive > clean — the same semantics the lane record itself applies
 * across reviewers): verdict = the worse of the two, findings union, counts
 * summed (null-preserving). null-tolerant so it can fold over segments. Pure.
 */
export function mergeReviewVerdicts(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  const rank = (v) => VERDICT_SEVERITY[v] ?? VERDICT_SEVERITY.inconclusive;
  const verdict = rank(b.verdict) > rank(a.verdict) ? b.verdict : a.verdict;
  const count = a.count == null && b.count == null ? null : (a.count ?? 0) + (b.count ?? 0);
  const findings = [a.findings, b.findings]
    .filter((f) => typeof f === 'string' && f.length)
    .join('\n--- segment ---\n');
  return { verdict, count, findings };
}

/** Char cap for the serialized findings detail carried in a review digest. */
const REVIEW_FINDINGS_MAX_CHARS = 4000;

// Render one canonical finding item to a compact single line:
// [severity] title/note/description (file:line). Strings pass through; an
// unrecognized object falls back to its JSON.
function renderFindingItem(f) {
  if (f == null) return '';
  if (typeof f === 'string') return f;
  const sev = typeof f.severity === 'string' && f.severity ? `[${f.severity}] ` : '';
  const text = f.title ?? f.note ?? f.description ?? f.summary ?? f.message ?? JSON.stringify(f);
  const loc = typeof f.file === 'string' && f.file ? ` (${f.file}${f.line != null ? `:${f.line}` : ''})` : '';
  return `${sev}${String(text)}${loc}`;
}

// Serialize the ACTUAL finding items — blocking first, deduped on rendered
// text, capped with an explicit '(+N more)' tail. A blocking verdict must
// carry actionable content into blocking_reviews[], never just counts.
function serializeFindings(blockingArr, findingsArr, cap = REVIEW_FINDINGS_MAX_CHARS) {
  const seen = new Set();
  const lines = [];
  for (const f of blockingArr) {
    const r = renderFindingItem(f);
    if (!r || seen.has(r)) continue;
    seen.add(r);
    lines.push(`BLOCKING: ${r}`);
  }
  for (const f of findingsArr) {
    const r = renderFindingItem(f);
    if (!r || seen.has(r)) continue;
    seen.add(r);
    lines.push(`- ${r}`);
  }
  const kept = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > cap) {
      if (kept.length === 0) {
        // ALWAYS keep at least an actionable prefix of the first finding —
        // an oversized first item must be truncated to fit (reserving room
        // for the omission marker), never dropped to a bare count (round-4 P2).
        kept.push(l.slice(0, Math.max(1, cap - 32)) + '…');
      }
      break;
    }
    kept.push(l);
    used += l.length + 1;
  }
  const omitted = lines.length - kept.length;
  if (omitted > 0) kept.push(`(+${omitted} more)`);
  return kept.join('\n');
}

// Re-apply the findings cap AFTER merging (round-5 P2): per-segment findings
// concatenate through mergeReviewVerdicts, so a large segmented diff could
// grow an unbounded digest despite the documented cap. Same rule as
// serializeFindings: blocking content first, a truncated first-line prefix
// rather than nothing, explicit '(+N more)' tail. Pure.
function capFindingsText(text, cap = REVIEW_FINDINGS_MAX_CHARS) {
  const s = String(text ?? '');
  if (s.length <= cap) return s;
  const all = s.split('\n');
  const lines = [
    ...all.filter((l) => l.startsWith('BLOCKING: ')),
    ...all.filter((l) => !l.startsWith('BLOCKING: ')),
  ];
  const kept = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > cap) {
      if (kept.length === 0) kept.push(l.slice(0, Math.max(1, cap - 32)) + '…');
      break;
    }
    kept.push(l);
    used += l.length + 1;
  }
  const omitted = lines.length - kept.length;
  if (omitted > 0) kept.push(`(+${omitted} more)`);
  return kept.join('\n');
}

/**
 * Map an `agent-dispatch review` record (final_verdict/findings/
 * blocking_findings) into the L2 verdict vocabulary. Pure + fail-safe: an
 * injected lane may also speak the L2 vocabulary directly ({verdict,findings});
 * anything unparseable is 'inconclusive' so a malformed review never reads clean.
 */
export function mapAdversaryLaneVerdict(lane) {
  if (lane == null || typeof lane !== 'object' || Array.isArray(lane)) {
    return { verdict: 'inconclusive', count: null, findings: 'NOTE — adversary review returned no parseable record. verdict: inconclusive' };
  }
  if (typeof lane.verdict === 'string' && REVIEW_VERDICTS.includes(lane.verdict)) {
    const count = Number.isFinite(lane.count) ? lane.count : null;
    const findings = typeof lane.findings === 'string' && lane.findings.length
      ? lane.findings
      : `verdict: ${lane.verdict}`;
    return { verdict: lane.verdict, count, findings };
  }
  const findingsArr = Array.isArray(lane.findings) ? lane.findings : [];
  const blockingArr = Array.isArray(lane.blocking_findings) ? lane.blocking_findings : [];
  const fv = String(lane.final_verdict ?? '').toLowerCase();
  let verdict;
  if (blockingArr.length > 0 || fv === 'reject' || fv === 'rework') verdict = 'blocking';
  else if (fv === 'approve') verdict = findingsArr.length ? 'advisory' : 'clean';
  else verdict = 'inconclusive';
  const summary = typeof lane.summary === 'string' && lane.summary ? ` — ${lane.summary.slice(0, 300)}` : '';
  const detail = serializeFindings(blockingArr, findingsArr);
  return {
    verdict,
    count: findingsArr.length,
    findings: `adversary review: final_verdict=${fv || '(none)'}; ${findingsArr.length} findings, ${blockingArr.length} blocking${summary}.`
      + (detail ? `\n${detail}` : '')
      + `\nverdict: ${verdict}`,
  };
}

// LEGACY fallback verdict re-extraction from a stored findings digest (events
// written before the structured data.verdict field). Takes the WORST
// recognized verdict across ALL matches — reviewer-controlled findings text
// containing a stray 'verdict: clean' must never spoof past an actual
// blocking marker (round-4 P2). FAIL-CLOSED: nothing recognized → BLOCKING —
// a lost verdict surfaces for attention, never reads clean/inconclusive.
function extractStoredVerdict(text) {
  const re = /verdict:\s*(blocking|advisory|clean|inconclusive)/gi;
  let worst = null;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    const v = m[1].toLowerCase();
    if (worst === null || VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst]) worst = v;
  }
  return worst ?? 'blocking';
}

// Supplemental STRUCTURED read beside selectReentry: the guard's projection
// carries {digest,count,base} but not additive payload fields, so walk the
// same event lines for the LAST matching done event and return its
// data.verdict (validated against the vocabulary; null for legacy events).
// Same key matching as the run+task+sha kind: run/sha strict, task
// type-tolerant.
function selectStoredReviewVerdict(eventsText, key) {
  let verdict = null;
  for (const line of String(eventsText ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let rec;
    try { rec = JSON.parse(t); } catch { continue; }
    if (rec?.type !== TASK_REVIEW_TYPES.done) continue;
    const d = rec.data;
    if (!d || d.run !== key.run || d.sha !== key.sha || d.task == null || String(d.task) !== String(key.task)) continue;
    verdict = typeof d.verdict === 'string' && d.verdict in VERDICT_SEVERITY ? d.verdict : null;
  }
  return verdict;
}

// Default review lane: the SAME canonical CLI surface the repo already uses for
// adversary review (agents/mp-adversarial-reviewer.md / finish-step's
// run_adversary_review op): `agent-dispatch review --class adversary --diff …
// --intensity standard`. Injectable via _reviewLane so tests never spawn it.
// NEVER truncates: callers segment first (segmentDiffPayload); an oversized
// arg here is a caller bug and fails LOUD (it would either silently narrow
// review coverage or blow past MAX_ARG_STRLEN).
function runAdversaryReviewLane({ diff, bin }) {
  const payload = String(diff ?? '');
  if (Buffer.byteLength(payload, 'utf8') > REVIEW_DIFF_MAX_BYTES) {
    throw new Error(`adversary review payload exceeds ${REVIEW_DIFF_MAX_BYTES} bytes — segmentDiffPayload must split it before the lane call`);
  }
  const out = String(execFileSync(bin ?? 'agent-dispatch',
    ['review', '--class', 'adversary', '--diff', payload, '--intensity', 'standard'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }));
  try { return JSON.parse(out); } catch { /* progress lines may precede the JSON */ }
  const i = out.indexOf('{');
  if (i >= 0) {
    try { return JSON.parse(out.slice(i)); } catch { /* fall through */ }
  }
  throw new Error('adversary review lane returned no parseable JSON record');
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
 * @property {Function}[_reviewLane]        — injectable adversary-review lane seam (tests; default: `agent-dispatch review --class adversary`)
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
  _reviewLane = null,
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
  // Per-bundle adversary-review switch — the SAME gate L2's execute workflow
  // consumes (continue.mjs reviewMode parity, incl. the legacy
  // state.codex.review fallback). Computed HERE so the work-item descriptors
  // can advertise the review requirement (descriptor-only; never hashed).
  const reviewOn = normalizeReviewMode(state.review?.adversary ?? state.codex?.review) === 'on';
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
        review: reviewOn ? { adversary: true } : null,
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

  // 8b. PER-TASK ADVERSARY REVIEW — config-gated on the SAME per-bundle switch
  //     L2's execute workflow consumes (continue.mjs reviewMode parity, incl.
  //     the legacy state.codex.review fallback). Each DONE task's FULL working
  //     diff of its edit locus is reviewed (NOT filtered to declared scope —
  //     an undeclared write must be in the payload); the verdict lands in the
  //     task digest (digest.review) and on the result item (item.review), which
  //     recordWaveResult surfaces as blocking_reviews[] in the wave-completion
  //     protocol. Idempotent on the unified keyed re-entry guard's run+task+sha
  //     vocabulary (lib/reentry-guard.mjs: task_adversary_review /
  //     task_adversary_review_skipped, keyed data.{run,task,sha}). The key's
  //     sha is the sha256 of the EXACT review payload (the captured full
  //     working diff) — NOT the branch HEAD: uncommitted code can change
  //     between attempts while HEAD stays identical, and a prior approve must
  //     never suppress review of different code (same payload → skip;
  //     different payload → fresh review). The launch HEAD rides in data.base
  //     for audit. A prior 'done' event for the key short-circuits the lane; a degraded
  //     lane writes a 'skipped' event (which NEVER satisfies re-entry — skip
  //     IGNORED) and yields 'inconclusive' (advisory; L2 parity — never block
  //     the wave on a wedged reviewer). D6 INDEPENDENCE: the verdict is
  //     advisory metadata — verify-scope's revert runs regardless, so an
  //     approve verdict can never bypass scope enforcement.
  if (reviewOn) {
    let eventsText = '';
    try { eventsText = fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8'); } catch { eventsText = ''; }
    const lane = _reviewLane ?? ((args) => runAdversaryReviewLane({ ...args, bin: brokerBin }));
    const diffCache = new Map(); // per edit locus: { diff, sha } (payload + its content hash)
    for (const [i, t] of tasks.entries()) {
      const digest = digests[i];
      if (digest?.status !== 'done') continue; // L2 parity: only review work that got done
      const repo = descriptors[i]?.repo ?? WT;
      let payload = diffCache.get(repo);
      if (payload === undefined) {
        const diff = captureFullWorkingDiff(repo);
        payload = { diff, sha: createHash('sha256').update(diff, 'utf8').digest('hex') };
        diffCache.set(repo, payload);
      }
      const key = { run: runId, task: t.id, sha: payload.sha };
      const prior = selectReentry(eventsText, { kind: 'run+task+sha', key });
      if (prior.present && prior.status === 'done') {
        // STRUCTURED verdict first (data.verdict, written below); the text
        // parse is a legacy fallback that fails CLOSED to 'blocking'.
        const stored = selectStoredReviewVerdict(eventsText, key);
        digest.review = {
          verdict: stored ?? extractStoredVerdict(prior.digest),
          findings: prior.digest ?? '',
        };
        continue;
      }
      // FULL-diff guarantee under the argv byte cap: one lane call per
      // ≤REVIEW_DIFF_MAX_BYTES segment, merged worst-wins — never truncation.
      // The catch is PER SEGMENT (round-3 P1): a degraded segment merges in as
      // 'inconclusive' and reviewing CONTINUES, so an earlier segment's
      // blocking verdict is never discarded by a later segment's failure.
      // The guard event is 'done' ONLY when EVERY segment produced a
      // definitive verdict (round-4 P1): a partially-reviewed payload must
      // never satisfy re-entry — the skipped event (skip IGNORED) re-arms a
      // FULL re-review on the next attempt, while THIS attempt's merged
      // worst-wins verdict still surfaces in digest.review/blocking_reviews.
      let review = null;
      let definitiveSegments = 0;
      const segments = segmentDiffPayload(payload.diff);
      for (let s = 0; s < segments.length; s++) {
        let segReview;
        try {
          const laneOut = await lane({
            diff: segments[s], task_id: t.id, run_id: runId, wave,
            description: t.description, segment: s + 1, segments: segments.length,
          });
          segReview = mapAdversaryLaneVerdict(laneOut);
          definitiveSegments += 1;
        } catch (err) {
          segReview = {
            verdict: 'inconclusive',
            count: null,
            findings: `NOTE — adversary review lane degraded on segment ${s + 1}/${segments.length} (${err.message}). verdict: inconclusive`,
          };
        }
        review = mergeReviewVerdicts(review, segReview);
      }
      const reviewStatus = definitiveSegments === segments.length ? 'done' : 'skipped';
      // Cap ONCE after the final merge — the per-segment caps do not compose.
      review = { ...review, findings: capFindingsText(review.findings) };
      const ev = buildTaskReviewEvent({
        run: runId, task: t.id, sha: payload.sha, status: reviewStatus,
        count: Number.isFinite(review.count) ? review.count : null,
        base: inputs.head, // launch HEAD — audit provenance, never the key
        digest: review.findings,
        ts: new Date(now ?? Date.now()).toISOString(),
      });
      // ADDITIVE structured verdict on the guard event payload: event types
      // and key fields {run,task,sha} stay exactly the checked-in vocabulary;
      // extra payload fields are compatible. Re-entry reads THIS field —
      // never a re-parse of prose — so a verdict can't downgrade in transit.
      ev.data.verdict = review.verdict;
      appendEvent(absState, ev);
      eventsText += JSON.stringify(ev) + '\n';
      digest.review = { verdict: review.verdict, findings: review.findings };
    }
  }

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
