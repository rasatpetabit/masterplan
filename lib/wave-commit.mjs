// lib/wave-commit.mjs — the durable transactions (T2.2 §2a recordWaveResult + §5.6
// promoteAmendment — the promotion entry path, git-in-bin seam).
//
// recordWaveResult is the single durable transaction that used to live as prose in
// commands/masterplan.md — §2a Completion steps 0-4, the §2 finalize_run crash-reconcile
// row, and the §2e¶6 split-commit trace. The LLM stops being the transaction engine: it
// hands the L2 workflow result to `mp record-result` and gets back a digest + the next
// decide action. CD-7 strengthens here — `mp` is the sole writer of state AND the sole
// executor of the LOCAL git bracketing it (network ops stay shell-side).
//
// promoteAmendment (§5.6, task 55) is the same move for amendment promotion: the
// by-hand procedure the amendment itself required — the Intent artifact patched by
// hand, identities verified by hand — is replaced by one durable
// transaction over BOTH artifacts. The mechanics (diff proof, base pinning, the
// decision table, exactly-once recording) live in lib/promote.mjs; THIS entry path
// owns the Guard D lock across begin+commit, the MAIN derivation, and the crash-
// recovery routing: a begun-but-incomplete transaction converges through
// recoverPromotion rather than a second begin.
//
// Validate the whole transaction, publish a local write-ahead record, then
// apply its effects. Reconcile resumes that record before interpreting the
// launch marker, even when task marks (or the marker clear) did not land.
// Legacy null-result reconciliation without a journal retains its old tail.
// See docs/internals/wave-dispatch.md for the crash prefixes.

import fs from 'node:fs';
import path from 'node:path';

import { verifyScope, declaredScope, waveSummary } from './wave.mjs';
import { pathWithinDeclaredScope } from './declared-scope.mjs';
import { readState, writeState, appendEvent, prepareEventLine, markTask, clearActiveRun,
  waveDispatchRecordPath, writeWaveDispatchRecord } from './bundle.mjs';
import {
  RECORDING_FILE, readWaveRecording, saveWaveRecording, finishWaveRecording, recordingKey,
  recordingEventStart, recordingEventSuffix, appendRecordingSuffix, preflightRecordingCommit,
  captureRecordingLoci, checkRecordingLoci, recordingCommitAtHead,
} from './wave-recording.mjs';
import { heartbeatOwner, acquireOwner } from './owner-fs.mjs';
import { decideNextAction } from './resume.mjs';
import {
  canonicalizeScopePaths,
  captureMultiRepoFiles,
  partitionPathsByRepo,
  mapUmbrellaPathsToRepos,
  resolveFileLocus,
} from './dispatch/multi-repo.mjs';
import { taskReviewBlocksWave, readEligibleTaskReviewEvent, taskReviewEvidenceEligibility } from './task-review.mjs';
import { buildIntentIdentity } from './checkpoint-evidence.mjs';
import { captureWorkingReview, rebuildFullWorkingDiff } from './working-diff.mjs';
import { sha256hex } from './canonical.mjs';
import { captureCommittedDiff, captureStableCommittedDiff, buildRecoveryIdentity, fingerprintReviewContext, resolveCommitOid } from './recovery-controller.mjs';
import { assertPrimaryBundle, reviewEpisodeIntent, assertEpisodeReviewBinding,
  restartedEpisodeSubject, resolveTaskReviewAttempt } from './review-episode.mjs';
import { preflightRecovery, committedDeltaPaths } from './recovery-preflight.mjs';
import { amendedScopeFiles, amendedScopeReason } from './scope-authorization.mjs';
import { retryPathFingerprint, retryStatus, retryTaskScopes } from './retry-scope.mjs';
import {
  runGit,
  gitLines,
  readWatchBaseline,
  snapshotWatchList,
  stripControllerTransactionFiles,
  verifyWatchListDelta,
  workspaceRootFor,
} from './watch-integrity.mjs';
import {
  beginPromotion,
  commitPromotion,
  recoverPromotion,
  promotionDocPath,
} from './promote.mjs';

// The workspace root baseline: non-hidden entries at the workspace root level.
// Used to detect agent-created loose files (AUDIT-*.md, progress.md, etc.) after a wave.
// `wsRoot` is the workspace root directory (the repo root's parent, e.g. the fleet root
// holding every repo).
export function captureWorkspaceRoot(wsRoot) {
  try {
    return fs.readdirSync(wsRoot).filter((e) => !e.startsWith('.'));
  } catch {
    return [];
  }
}

// The D6 capture: tracked changes vs HEAD ∪ untracked (same two commands the prose
// specified for `before`/`after`, quotePath off so non-ASCII paths compare stably).
export function captureWtFiles(wt) {
  const tracked = gitLines(wt, ['-c', 'core.quotePath=false', 'diff', '--name-only', 'HEAD']);
  const untracked = gitLines(wt, ['-c', 'core.quotePath=false', 'ls-files', '-o', '--exclude-standard']);
  return [...new Set([...tracked, ...untracked])];
}

// Canonical task-review shape is owned by task-review.mjs.
// normalizeStoredReview is local compatibility only: re-drive of legacy stored
// results (clean/advisory/blocking/inconclusive) maps into the canonical
// vocabulary. New writes never use the legacy vocabulary.
function normalizeStoredReview(review) {
  if (review == null || typeof review !== 'object' || Array.isArray(review)) return null;
  if (['approve', 'rework', 'reject', 'error'].includes(review.verdict)) return review;
  const verdict = ({
    clean: 'approve', advisory: 'rework', blocking: 'reject', inconclusive: 'error',
  })[review.verdict];
  if (!verdict) return null;
  // Legacy reviews had a single findings field that represented blocking content.
  // Put it only in blocking_findings so the consumer's
  // [...blocking_findings, ...findings] concatenation does not double it.
  // Canonical records keep separate findings vs blocking_findings lists.
  const findings = Array.isArray(review.findings)
    ? review.findings
    : review.findings == null ? [] : [{ summary: String(review.findings), severity: 'blocking' }];
  return {
    verdict,
    findings: [],
    blocking_findings: verdict === 'approve' ? [] : findings,
    summary: `legacy ${review.verdict} task review`,
    harness: {
      degraded: verdict === 'error', timed_out: false, stalled: false,
      deadline_exceeded: false, regions_unreviewed: verdict === 'error' ? 1 : 0,
      extraction_degraded: false,
    },
  };
}

const coerceId = (v) => (/^-?\d+$/.test(String(v)) ? Number(v) : v);

export const COMMITTED_REVIEW_REWORK = 'committed recovery still needs review; keep the frozen base and use only explicit recovery (--recovery-repo and --recovery-head). Inspect preservation first: even the recorder’s own MAIN state commit can move a watched HEAD and cause refusal. Do not blindly retry or refresh the baseline.';

export function reviewReworkFiles(state) {
  const run = state.active_run;
  return (state.tasks ?? []).filter((t) => t.wave === run?.wave && run?.review_rework?.includes(t.id))
    .flatMap((t) => t.files ?? []);
}

// A legacy outcome has no stored code commit. Its durable episode-bound review
// can prove ONE direct child of its frozen base, but only at its review locus.
// Candidate discovery and artifact reconstruction are object-only and read-only.
function legacyRecordedBaseline(repo, id, owner, record, data) {
  try {
    const frozen = owner.review_context.tasks?.find((t) => String(t.task_id) === String(id));
    if (!frozen?.repo || fs.realpathSync(frozen.repo) !== fs.realpathSync(repo)) return null;
    const base = resolveCommitOid(repo, frozen.base_sha ?? owner.review_context.base_sha);
    if (data.base !== base || !/^[0-9a-f]{64}$/.test(data.sha)) return null;
    const head = resolveCommitOid(repo, 'HEAD');
    const candidates = new Set();
    const directChild = (oid) => {
      const parents = runGit(repo, ['rev-list', '--parents', '-n', '1', oid]).split(' ');
      return parents.length === 2 && parents[1] === base;
    };
    // Prefer the new attempt's frozen base, not today's HEAD. Still enumerate
    // ancestry below: two direct children reachable through a merge are ambiguous.
    const current = record.review_context?.tasks?.find((t) => t.repo &&
      fs.realpathSync(t.repo) === fs.realpathSync(repo));
    const preferred = current?.base_sha ?? (current ? record.review_context.base_sha : null);
    if (preferred && directChild(preferred)) {
      runGit(repo, ['merge-base', '--is-ancestor', preferred, head]);
      candidates.add(resolveCommitOid(repo, preferred));
    }
    for (const line of gitLines(repo, ['rev-list', '--ancestry-path', '--parents', `${base}..${head}`])) {
      const [oid, ...parents] = line.split(' ');
      if (parents.length === 1 && parents[0] === base) candidates.add(oid);
    }
    if (candidates.size !== 1) return null;
    const [candidate] = candidates;
    if (sha256hex(rebuildFullWorkingDiff(repo, base, candidate)) !== data.sha) return null;
    return candidate;
  } catch {
    return null; // Missing objects, ambiguous/unreproducible artifacts: refuse as before.
  }
}

// Historical approval covers committed work, never new bytes. Inspect the same
// per-repo loci staging/cleanup use, including declarations outside run.scope.
// Status sees BOTH index and WT changes vs HEAD (even when WT masks the index).
export function assertEarlierTaskFilesUnchanged(state, record, exempt, reviewIds, opts) {
  if (!exempt.size) return;
  const waveTasks = (state.tasks ?? []).filter((t) => t.wave === state.active_run.wave);
  const members = record.tasks ?? record.payload ?? [];
  // Only tasks undergoing artifact authorization can cover a shared file;
  // a blocked current task has no review and must not exempt fresh A bytes.
  const currentIds = new Set(members.map((t) => String(record.tasks != null ? t.task_id : t.id))
    .filter((id) => reviewIds.has(id)));
  const scopes = (files) => canonicalizeScopePaths(files, opts);
  const retryFiles = opts.retryTasks ? [...opts.retryTasks.values()].flat() : [];
  const preserved = opts.retryTasks ? record.retry_launch.preserved : [];
  const coverage = (record.review_context?.tasks ?? []).filter((t) => currentIds.has(String(t.task_id)))
    .map((frozen) => ({
      repo: fs.realpathSync(frozen.repo),
      base: frozen.base_sha ?? record.review_context.base_sha,
      files: opts.retryTasks ? opts.retryTasks.get(String(frozen.task_id)) ?? []
        : scopes(waveTasks.find((t) => String(t.id) === String(frozen.task_id))?.files ?? []),
    }));
  const reviewsAt = (repo) => coverage.filter((review) => review.repo === fs.realpathSync(repo));
  const covered = (repo, file) => reviewsAt(repo).some((review) => pathWithinDeclaredScope(file, review.files));
  const earlierFiles = new Map(waveTasks.filter((t) => exempt.has(String(t.id)))
    .map((t) => [t.id, scopes(t.files ?? [])]));
  const priorFiles = [...earlierFiles.values()].flat();
  const allTaskFiles = scopes(waveTasks.flatMap((t) => t.files ?? []));
  const transactionScope = scopes(state.active_run.scope ?? declaredScope(state, state.active_run.wave));
  const loci = partitionPathsByRepo([...priorFiles, ...transactionScope], opts);
  const changed = [];
  for (const { repo, prefix } of loci) {
    // NUL termination preserves unusual path bytes; no-renames exposes BOTH
    // endpoints so moving a prior file into B's scope cannot hide its deletion.
    for (const entry of retryStatus(repo)) {
      const file = prefix ? `${prefix}/${entry.path}` : entry.path;
      const saved = preserved.find((p) => p.repo === repo && p.rel === entry.path);
      if (saved?.fingerprint && !pathWithinDeclaredScope(file, retryFiles) &&
          saved.fingerprint === retryPathFingerprint(repo, entry)) continue;
      changed.push({ repo, file });
    }
  }
  const uncovered = changed.filter(({ repo, file }) => !covered(repo, file));
  for (const [id, files] of earlierFiles) {
    const { owner, data } = exempt.get(String(id));
    // Every locus needs A's accepted baseline, even when a current review covers
    // its entire declaration. A directory may contain both covered and uncovered paths.
    for (const { repo, prefix, rels } of partitionPathsByRepo(files, opts)) {
      const refuse = (reason) => {
        throw new Error(`review episode task ${id}: repository ${repo}, ${reason}; fresh review of this task's episode is required (or redispatch)`);
      };
      const stored = owner.record_outcome?.commits?.code_by_repo?.[path.resolve(repo)];
      const baseline = stored === undefined ? legacyRecordedBaseline(repo, id, owner, record, data) : stored;
      if (typeof baseline !== 'string' || !/^[0-9a-f]{40}$/.test(baseline))
        refuse(`paths ${rels.join(', ')}: missing trusted recorded code baseline`);
      const diffTo = (tip) => runGit(repo, ['--literal-pathspecs', 'diff', '--name-only', '-z', '--no-renames',
        baseline, tip, '--', ...rels]).split('\0').filter(Boolean)
        .map((rel) => prefix ? `${prefix}/${rel}` : rel);
      let committed, beforeReview;
      try {
        resolveCommitOid(repo, baseline);
        committed = diffTo('HEAD');
        // A current artifact starts at its frozen base, not A's recording. No
        // covering review can excuse drift already present at that boundary.
        // Test each review separately: overlapping reviews can have different bases.
        beforeReview = reviewsAt(repo).flatMap((review) =>
          diffTo(resolveCommitOid(repo, review.base)).filter((f) => pathWithinDeclaredScope(f, review.files)));
      } catch {
        refuse(`paths ${rels.join(', ')}: trusted recorded code baseline or frozen review base unavailable`);
      }
      const drift = [...new Set([
        ...uncovered.filter((entry) => entry.repo === repo).map(({ file }) => file), ...committed,
      ].filter((f) => pathWithinDeclaredScope(f, files) && !covered(repo, f)).concat(beforeReview))];
      if (drift.length) refuse(`changed files ${drift.join(', ')}`);
    }
  }
  // Whole-wave staging admits uncommitted scope-only paths with no task declaration.
  // Those cannot inherit A's exemption or B's review from run.scope alone. Changes
  // committed before the current frozen base remain part of that trusted base.
  const unassigned = uncovered.map(({ file }) => file).filter((f) => pathWithinDeclaredScope(f, transactionScope) &&
    !pathWithinDeclaredScope(f, allTaskFiles));
  if (unassigned.length) throw new Error(`record-result: changed in-scope files outside task declarations ${unassigned.join(', ')}; fresh review of the owning task's episode is required`);
}

/**
 * The recorder's sole evidence authorization boundary. Pure/read-only: no HEAD,
 * state, events or heartbeat writes. Caller snapshots/receipts are evidence only;
 * expected artifacts always come from the canonical frozen context and live repo.
 * Native ingestion uses embeddedOnly to validate existing judgments before its
 * heartbeat, without demanding evidence for tasks still awaiting Phase A/B.
 * Recorder calls keep the default complete submitted/durable/deferred union.
 */
export function authorizeRecording({ statePath, state, result, deferredEvents = [], worktree,
  recovery = false, recoverySelector = null, skillRoot, embeddedOnly = false } = {}) {
  const wave = state.active_run.wave;
  const bundleDir = path.dirname(path.resolve(statePath));
  const reconciledReviews = new Map();
  const episodeRecord = readRecordingDispatch(bundleDir, wave);
  const ctx = episodeRecord?.review_context;
  if (![episodeRecord, ...(episodeRecord?.history ?? [])].some((attempt) => attempt?.review_context?.enabled)) {
    return { recovery, recoverySelector, reconciledReviews, episodeRecord };
  }
  const slot = { ...assertPrimaryBundle(statePath, state), wave };
  // Bind the transaction's resolver (including sibling worktrees) to the frozen
  // review loci. A shared Git common directory does not identify a checkout.
  // Check the whole wave: cleanup can touch pending tasks as well as done ones.
  const MAIN = path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const slug = String(state.slug ?? '').trim();
  const WT = path.resolve(worktree ?? state.worktree ?? path.join(MAIN, '.worktrees', slug));
  const physical = (repo) => fs.realpathSync(repo);
  const locusMismatch = (id) => {
    throw new Error(`record-result: mutation locus mismatch for ${id}; refusing a checkout not bound to the frozen review loci`);
  };
  if (state.worktree && physical(WT) !== physical(state.worktree)) locusMismatch('run worktree');
  for (const frozen of ctx?.tasks ?? []) {
    const task = state.tasks?.find((t) => String(t.id) === String(frozen.task_id) && t.wave === wave);
    if (!task || !frozen.repo) locusMismatch(`task ${frozen.task_id}`);
    const loci = partitionPathsByRepo(task.files ?? [], { worktree: WT, mainRoot: MAIN, slug });
    if (!loci.length) loci.push({ repo: WT });
    if (loci.some(({ repo }) => physical(repo) !== physical(frozen.repo))) locusMismatch(`task ${frozen.task_id}`);
  }
  const current = buildIntentIdentity({ statePath, skillRoot, readOnly: true });
  if (!current.ok) throw new Error(`record-result: cannot establish current intent evidence — ${current.reason}`);
  let eventsText = '';
  try { eventsText = fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8'); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }
  // Select exactly as re-entry will after the deferred append. Submitted
  // projections cannot override a canonical rejection for the same artifact.
  const selectionText = `${eventsText}\n${deferredEvents.map(({ event }) => JSON.stringify(event)).join('\n')}`;
  const submitted = new Map((result?.tasks ?? []).filter((it) =>
    (it?.digest ?? it)?.status === 'done' && (!embeddedOnly || it.review || it.digest?.review))
    .map((it) => [String((it?.digest ?? it)?.task_id ?? it?.task_id), it]));
  const ids = embeddedOnly ? new Set(submitted.keys()) : new Set([...submitted.keys(),
    ...(state.tasks ?? []).filter((t) => t.wave === wave && t.status === 'done').map((t) => String(t.id)),
    ...deferredEvents.map(({ event }) => String(event?.data?.task))]);
  const assertEligible = (review, intentIdentity, identity, expectedIdentity) => {
    const check = taskReviewEvidenceEligibility({ review, intentIdentity, current,
      requireIdentity: expectedIdentity != null, identity, expectedIdentity });
    if (!check.ok) throw new Error(`record-result: checkpoint evidence unavailable — ${check.reason}; fresh review required`);
  };
  const mismatch = (id) => { throw new Error(`review episode task ${id}: artifact episode evidence mismatch; fresh review required`); };
  // Check the whole episode set first; a different invalid artifact must not
  // obscure a retired/HOLD slot in a partial batch. Submitted/deferred tasks
  // remain current-attempt transactions; only already-recorded, state-done work
  // owned by an earlier attempt can be exempt from this transaction's artifact.
  const exempt = new Map();
  for (const rawId of ids) {
    const id = coerceId(rawId);
    if (submitted.has(rawId) || deferredEvents.some(({ event }) => String(event?.data?.task) === rawId)) {
      reviewEpisodeIntent(episodeRecord, id, {}, slot);
      continue;
    }
    const { record: owner } = resolveTaskReviewAttempt(episodeRecord, id, slot);
    if (owner === episodeRecord) continue;
    const frozen = owner.review_context.tasks?.find((task) => String(task.task_id) === rawId);
    const base = frozen?.base_sha ?? owner.review_context.base_sha;
    const key = { run: state.slug, task: id, episode_subject: restartedEpisodeSubject(owner, id) };
    // The historical artifact is no longer the live working diff. Require the
    // recorded outcome AND its durable checkpoint at the owning frozen base and
    // episode, using the existing review/intent/recovery evidence selectors.
    const event = eventsText.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter((ev) => ev?.type === 'task_adversary_review' && ev.data?.run === state.slug &&
      String(ev.data?.task) === rawId && ev.data?.base === base &&
      (ev.data?.episode_subject ?? null) === key.episode_subject).at(-1);
    const data = event?.data;
    let prior = { present: false };
    if (owner.status === 'recorded' && owner.record_outcome?.recorded?.some((taskId) => String(taskId) === rawId) &&
        frozen?.repo && base && data?.sha) {
      const expectedIdentity = data.identity == null ? null : buildRecoveryIdentity({
        bundle: state.slug, runId: state.slug, wave, attempt: owner.attempt,
        contextFingerprint: fingerprintReviewContext(owner.review_context), taskId: id,
        repo: path.resolve(frozen.repo), base, head: data.identity.head, diffSha: data.sha,
      });
      assertEpisodeReviewBinding(owner, id, data);
      assertEpisodeReviewBinding(owner, id, data.review);
      prior = readEligibleTaskReviewEvent(eventsText, { ...key, sha: data.sha }, {
        current, requireIdentity: data.identity != null, expectedIdentity,
      });
    }
    if (!prior.present || taskReviewBlocksWave(prior.review))
      throw new Error(`review episode task ${id}: owning attempt lacks recorded durable completion evidence; refusing recording`);
    exempt.set(rawId, { owner, data });
  }
  const loci = { worktree: WT, mainRoot: MAIN, slug };
  const retryTasks = recovery ? null : retryTaskScopes(statePath, state, episodeRecord, loci);
  assertEarlierTaskFilesUnchanged(state, episodeRecord, exempt, ids, { ...loci, retryTasks });
  const workingArtifacts = new Map();
  for (const rawId of ids) {
    if (exempt.has(rawId)) continue;
    const id = coerceId(rawId);
    const task = ctx.tasks?.find((t) => String(t.task_id) === rawId);
    if (!task?.repo) mismatch(id);
    const item = submitted.get(rawId);
    const digest = item?.digest ?? item;
    const review = digest?.review ?? item?.review;
    const deferred = deferredEvents.filter(({ event }) => String(event?.data?.task) === rawId);
    const key = { run: state.slug, task: id, episode_subject: restartedEpisodeSubject(episodeRecord, id) };
    const base = task.base_sha ?? ctx.base_sha;
    let sha = recovery ? null : captureWorkingReview(task, ctx, workingArtifacts).sha;
    let prior = recovery ? null : readEligibleTaskReviewEvent(eventsText, { ...key, sha }, { current });
    if (prior?.identity) prior = { present: false, review: null };
    let expectedIdentity = null;
    // Reconciliation may discover an identity-bearing committed receipt. Probe
    // read-only, then require the SAME clean/stable capture used for submitted recovery.
    if (!item && !recovery && !prior.present && base) {
      const head = resolveCommitOid(task.repo, 'HEAD');
      const diffSha = sha256hex(captureCommittedDiff(task.repo, base, head));
      const expected = buildRecoveryIdentity({ bundle: state.slug, runId: state.slug, wave,
        attempt: episodeRecord.attempt, contextFingerprint: fingerprintReviewContext(ctx),
        taskId: id, repo: path.resolve(task.repo), base, head, diffSha });
      const recovered = readEligibleTaskReviewEvent(eventsText, { ...key, sha: diffSha }, {
        current, requireIdentity: true, expectedIdentity: expected });
      if (recovered.present) {
        recovery = true;
        recoverySelector ??= { repo: task.repo, head };
      }
    }
    if (recovery) {
      const head = resolveCommitOid(task.repo, 'HEAD');
      if (!base || !recoverySelector || path.resolve(recoverySelector.repo) !== path.resolve(task.repo) ||
          recoverySelector.head !== head) mismatch(id);
      sha = sha256hex(captureStableCommittedDiff(task.repo, base, head));
      expectedIdentity = buildRecoveryIdentity({ bundle: state.slug, runId: state.slug, wave,
        attempt: episodeRecord.attempt, contextFingerprint: fingerprintReviewContext(ctx),
        taskId: id, repo: path.resolve(task.repo), base, head, diffSha: sha });
      prior = readEligibleTaskReviewEvent(eventsText, { ...key, sha }, {
        current, requireIdentity: true, expectedIdentity });
    }
    const validateEvent = (event) => {
      const data = event?.data;
      if (!['task_adversary_review', 'task_adversary_review_skipped'].includes(event?.type) || data?.run !== state.slug ||
          String(data?.task) !== rawId || data?.sha !== sha ||
          (data?.episode_subject ?? null) !== key.episode_subject ||
          (!recovery && data?.identity != null)) mismatch(id);
      // A failed-call diagnostic can block recording, never authorize success.
      if (event.type === 'task_adversary_review_skipped' && !taskReviewBlocksWave(review ?? data.review)) mismatch(id);
      assertEpisodeReviewBinding(episodeRecord, id, data);
      assertEpisodeReviewBinding(episodeRecord, id, data.review);
      assertEligible(data.review, data.intent_identity ?? null, data.identity, expectedIdentity);
    };
    // Every deferred review is checked independently, even when another receipt
    // already satisfies the task. A valid item cannot launder a stale append.
    for (const { event } of deferred) validateEvent(event);
    const selected = readEligibleTaskReviewEvent(selectionText, { ...key, sha }, {
      current, requireIdentity: recovery, expectedIdentity });
    if (selected.eligibility || (!recovery && selected.identity != null)) mismatch(id);
    if (item) {
      assertEpisodeReviewBinding(episodeRecord, id, review);
      assertEligible(review, review?.intent_identity ?? null, null, null);
      const input = item.review_input;
      if (input) {
        if (input.sha !== sha || path.resolve(input.repo) !== path.resolve(task.repo) ||
            (!recovery && input.identity != null)) mismatch(id);
        assertEligible(review, review?.intent_identity ?? null, input.identity, expectedIdentity);
      } else {
        // Phase B strips review_input. Its canonical event (durable or deferred)
        // is the artifact carrier, never the submitted verdict by itself.
        const candidates = [...eventsText.split('\n').filter(Boolean).map((line) => {
          try { return JSON.parse(line); } catch { return null; }
        }), ...deferred.map(({ event }) => event)].filter((ev) =>
          ['task_adversary_review', 'task_adversary_review_skipped'].includes(ev?.type) && ev.data?.run === state.slug &&
          String(ev.data?.task) === rawId && ev.data?.sha === sha &&
          (ev.data?.episode_subject ?? null) === key.episode_subject);
        if (!candidates.length) mismatch(id);
        validateEvent(candidates.at(-1));
      }
      // Explicit input-bound evidence is still supported when no durable event
      // exists. Canonical blocking evidence cannot be cleared by a submitted
      // approval; likewise an input-bound blocking judgment stays blocking.
      reconciledReviews.set(id, selected.present && taskReviewBlocksWave(selected.review)
        ? selected.review : taskReviewBlocksWave(review) ? review : selected.present ? selected.review : review);
    } else if (state.tasks?.some((t) => String(t.id) === rawId && t.wave === wave && t.status === 'done')) {
      if (!selected.present) mismatch(id);
      reconciledReviews.set(id, selected.review);
    }
  }
  return { recovery, recoverySelector, reconciledReviews, episodeRecord };
}

function readRecordingDispatch(bundleDir, wave) {
  try {
    return JSON.parse(fs.readFileSync(waveDispatchRecordPath(bundleDir, wave), 'utf8'));
  } catch (err) { if (err.code !== 'ENOENT') throw err; return null; }
}

// Shared read-only guard: the CLI runs it before native review ingestion can
// append receipts or update the dispatch record. The transaction repeats it at
// its own write boundary, covering direct callers and reconciliation as well.
function inspectRecordingScope({ statePath, state, run, wave, before, bundleDir, WT, MAIN, slug, recovery = false, allowMissingLoci = false }) {
  const loci = { worktree: WT, mainRoot: MAIN, slug };
  const record = recovery ? null : readRecordingDispatch(bundleDir, wave);
  const retryTasks = retryTaskScopes(statePath, state, record, loci);
  const preserved = retryTasks ? record.retry_launch.preserved : [];
  const retryFiles = retryTasks ? [...retryTasks.values()].flat() : [];
  if (retryTasks) {
    if (!Array.isArray(run.scope)) throw new Error('record-result: missing original launch scope for retry');
    before = [...new Set([...before, ...(run.baseline ?? []),
      ...preserved.map((p) => p.file).filter((file) => !pathWithinDeclaredScope(file, retryFiles))])];
  }
  // Validate and capture every declared locus BEFORE the first state/heartbeat write.
  // A missing dispatched sibling/external worktree must not record a done digest.
  const declared = canonicalizeScopePaths(
    run.scope ?? declaredScope(state, wave),
    { worktree: WT, mainRoot: MAIN, slug },
  );
  const currentDeclared = canonicalizeScopePaths(declaredScope(state, wave), { worktree: WT, mainRoot: MAIN, slug });
  // The controller's WT-resident bookkeeping is not a worker scope breach.
  const after = stripControllerTransactionFiles(
    captureMultiRepoFiles([...declared, ...currentDeclared], {
      worktree: WT, mainRoot: MAIN, slug, captureWtFiles, allowMissingLoci,
    }),
    { bundleDir, worktree: WT },
  );

  // Read watch integrity BEFORE the first write, not after task marking. A stale
  // launch scope must never turn current-plan work into checkout/clean targets.
  const watchBaseline = readWatchBaseline(bundleDir, wave);
  let watch = { ok: true, violations: [], checked: false };
  const committedChanges = [];
  if (!recovery && watchBaseline?.snapshots) {
    const afterSnaps = snapshotWatchList(Object.values(watchBaseline.snapshots));
    // A worker commit disappears from the dirty set. Preserve the same amended
    // paths if a watched edit-locus HEAD moved; this is detection, not permission
    // for that commit or a refreshed baseline.
    for (const [key, snap] of Object.entries(watchBaseline.snapshots)) {
      const live = afterSnaps[key];
      if (snap?.isMain === false && snap.head && live?.head && snap.head !== live.head) {
        committedChanges.push(...canonicalizeScopePaths(
          committedDeltaPaths(snap.repo, snap.head, live.head).map(p => path.join(snap.repo, p)),
          { worktree: WT, mainRoot: MAIN, slug }));
      }
    }
    watch = { ...verifyWatchListDelta(watchBaseline.snapshots, afterSnaps, declared, {
      bundle: watchBaseline.bundle ?? null,
      bundleRel: (rel) => path.relative(bundleDir, path.join(MAIN, rel)),
    }), checked: true };
  }
  const changed = [...verifyScope(declared, before, after).outOfScope, ...committedChanges,
    ...canonicalizeScopePaths(watch.violations.filter(v => v.rel).map(v => path.join(v.repo, v.rel)),
      { worktree: WT, mainRoot: MAIN, slug })];
  const amendedFiles = recovery ? [] : amendedScopeFiles(statePath, state, changed, loci);
  if (!amendedFiles.length && retryTasks) {
    const conflict = preserved.find(({ file }) => pathWithinDeclaredScope(file, declared) && pathWithinDeclaredScope(file, retryFiles));
    if (conflict) throw new Error(`record-result: ${conflict.file} was already dirty outside the retry tasks at launch; resolve its ownership before recording`);
  }
  return { declared, before, after, watch, amendedFiles, retryTasks };
}

function preflightResult(state, result, recovery) {
  const run = state.active_run;
  if (!run) throw new Error('record-result: no active_run marker — nothing to record (already finalized?)');
  if (run.review_recovery && !recovery) throw new Error(COMMITTED_REVIEW_REWORK);
  if (run.kind === 'plan') {
    throw new Error('record-result: active_run is a plan run — plan results merge via merge-plan-fragments, not record-result');
  }
  if (!Number.isInteger(run.wave)) {
    throw new Error(`record-result: active_run.wave is not an integer (${JSON.stringify(run.wave)})`);
  }
  const wave = run.wave;
  if (result && Number.isInteger(result.wave) && result.wave !== wave) {
    throw new Error(`record-result: result is for wave ${result.wave} but active_run is wave ${wave} — refusing foreign result`);
  }

  // Stale-epoch (fencing-token) fence: a result carrying an epoch older than the marker's
  // current per-claim monotonic epoch is a reaped worker resuming late. Reject it BEFORE any
  // state byte is written (before the all-or-nothing markTask pass) so two harness workers can
  // never both mutate the same worktree across a stale reap. Extends the foreign-result guard.
  // Only fires on epoch-fenced markers (run.epoch finite); pre-epoch bundles keep prior behavior.
  if (result && Number.isFinite(run.epoch)) {
    const resultEpoch = Number.isFinite(result.epoch) ? result.epoch : null;
    if (resultEpoch === null || resultEpoch < run.epoch) {
      return {
        outcome: 'stale-epoch',
        wave,
        resultEpoch,
        currentEpoch: run.epoch,
        reason: `result epoch ${resultEpoch === null ? '(missing)' : resultEpoch} is stale (current claim epoch is ${run.epoch})`,
      };
    }
  }

  return null;
}

// Run result and amended-scope fences before requesting any native reviews.
// The recorder repeats them on the live transaction, including direct callers.
export function preflightNativeRecording({ statePath, result, worktree, recovery = false } = {}) {
  const state = readState(statePath);
  const refused = preflightResult(state, result, recovery);
  if (refused || recovery) return refused;
  const run = state.active_run;
  const bundleDir = path.dirname(path.resolve(statePath));
  const MAIN = path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const slug = String(state.slug ?? '').trim();
  const WT = path.resolve(worktree ?? state.worktree ?? path.join(MAIN, '.worktrees', slug));
  const { amendedFiles } = inspectRecordingScope({ statePath, state, run, wave: run.wave,
    before: result?.baseline ?? run.baseline ?? [], bundleDir, WT, MAIN, slug, allowMissingLoci: true });
  return amendedFiles.length ? { outcome: 'scope-amended-after-launch', wave: run.wave, files: amendedFiles,
    reason: amendedScopeReason(amendedFiles, run.wave) } : null;
}

export function recordWaveResult({ statePath, result = null, self, now, worktree, deferredEvents = [], recovery = false,
  recoverySelector = null, skillRoot, requestKey = result == null ? null : recordingKey({ result, recoverySelector }), finalizeDispatch = false } = {}) {
  if (!statePath) throw new Error('record-result: statePath is required');
  const state = readState(statePath);
  const interrupted = readWaveRecording(statePath);
  if (interrupted) return resumeWaveRecording({ statePath, state, self, now, worktree, requestKey, pending: interrupted });
  if (state.status === 'archived') throw new Error('record-result: bundle is archived');
  const rejectedResult = preflightResult(state, result, recovery);
  if (rejectedResult) return rejectedResult;
  const run = state.active_run;
  const wave = run.wave;

  // Strict heartbeat (acquire must precede) is the last gate before publishing
  // the journal. Owner-lock=off is the existing single-agent escape hatch.
  const bundleDir = path.dirname(path.resolve(statePath));
  // All entry paths share the same read-only authorization, including the CLI.
  // The first pass selects preservation mode for crash reconciliation; the final
  // pass below rereads authoritative context and live bytes immediately before writes.
  let authorization = authorizeRecording({ statePath, state, result, deferredEvents, worktree,
    recovery, recoverySelector, skillRoot });
  ({ recovery, recoverySelector } = authorization);
  const refuseIfNotOwner = () => {
    if (state.concurrency?.owner_lock === 'off') return null;
    const hb = heartbeatOwner(bundleDir, self, { now });
    if (hb.outcome !== 'held-by-self') {
      return { outcome: 'lost-to-other', reason: hb.reason, incumbent: hb.incumbent ?? null };
    }
    return null;
  };

  // Loci (§2e): MAIN derived from the bundle's repo, WT from state (or the conventional path).
  const MAIN = path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  const slug = String(state.slug ?? '').trim();
  const wtCandidate = worktree ?? state.worktree ?? (slug ? path.join(MAIN, '.worktrees', slug) : null);
  if (!wtCandidate) {
    throw new Error('record-result: cannot derive the worktree locus — pass --worktree, or set state.worktree/slug');
  }
  const WT = path.resolve(wtCandidate);
  if (!fs.existsSync(WT)) {
    throw new Error(`record-result: worktree ${WT} does not exist — run reconcile against the surviving locus or re-create it`);
  }

  const inspection = inspectRecordingScope({ statePath, state, run, wave, before: result?.baseline ?? run.baseline ?? [],
    bundleDir, WT, MAIN, slug, recovery });
  const { declared, before, after, amendedFiles, retryTasks } = inspection;
  let { watch } = inspection;
  if (!recovery && amendedFiles.length) {
    return { outcome: 'scope-amended-after-launch', wave, files: amendedFiles,
      reason: amendedScopeReason(amendedFiles, wave) };
  }

  // RECOVERY PRESERVATION GATE (contract item 7): in committed-recovery mode the work is
  // already committed at the pinned HEAD — the normal transaction's verify → revert → clean
  // → commit steps are meaningless and dangerous. Run the SAME scope/watch/baseline checks
  // READ-ONLY and reject on any violation BEFORE marking tasks or touching the worktree.
  // Never enters reset/clean/revert; preserves baseline authority (no refreshed baseline
  // that hides recovered changes).
  let recoveryPreflight = null;
  if (recovery) {
    const preflight = preflightRecovery({
      statePath, state, run, wave, WT, MAIN, slug,
      recoverySelector,
      baseline: Array.isArray(result?.baseline) ? result.baseline : null,
      captureWtFiles,
      captureWorkspaceRoot,
    });
    recoveryPreflight = preflight;
    if (!preflight.ok) {
      return {
        outcome: 'recovery-preservation-violation',
        wave,
        violations: preflight.violations,
        reason: 'committed recovery refused: original preservation checks failed — inspect the violations; do not reset, clean, revert, refresh the baseline, or retry blindly',
      };
    }
    // Recovery skips edit-locus mutations but still records evidence and state.
  }

  // Derive every task mark in memory. Unknown IDs must refuse before any write.
  const recorded = [];
  const reviewRework = [];
  const failed = [];
  const qctl = [];
  const blocking_reviews = [];
  const collectBlockingReview = (id, authoritative) => {
    if (!authoritative || !taskReviewBlocksWave(authoritative)) return false;
    blocking_reviews.push({ id, verdict: authoritative.verdict === 'approve' ? 'error' : authoritative.verdict,
      findings: [...(authoritative.blocking_findings ?? []), ...(authoritative.findings ?? [])] });
    return true;
  };
  const dispatchEvents = [];
  // Select at the final authorization boundary, BEFORE deriving completion, so
  // status, blocking_reviews and staging cannot disagree about the same receipt.
  authorization = authorizeRecording({ statePath, state, result, deferredEvents, worktree,
    recovery, recoverySelector, skillRoot });
  const { reconciledReviews, episodeRecord } = authorization;
  const reviewedDigests = new Set();
  let nextState = state;
  for (const item of result?.tasks ?? []) {
    const digest = item?.digest ?? item;
    const id = coerceId(digest?.task_id ?? item?.task_id);
    const status = digest?.status;
    const storedReview = normalizeStoredReview(digest?.review) ?? normalizeStoredReview(item?.review);
    const authoritative = status === 'done' && reconciledReviews.has(id) ? reconciledReviews.get(id) : storedReview;
    if (status === 'done') reviewedDigests.add(id);
    const blocks = collectBlockingReview(id, authoritative);
    if (status === 'done') {
      nextState = markTask(nextState, id, blocks ? 'pending' : 'done');
      (blocks ? reviewRework : recorded).push(id);
    } else if (status === 'qctl') {
      // Synthetic: stays pending for the L1 qctl path; NOT a failure.
      qctl.push({ id, backend: item?.backend ?? null });
    } else {
      // failed / blocked / anything else: leave pending, surface for recover_wave.
      failed.push({ id, status: status ?? 'unknown', summary: digest?.summary ?? '', blockers: digest?.blockers ?? [] });
    }
    // dispatch provenance → degradation-visibility events (fail-VISIBLE,
    // never fail-blocked: recording proceeds regardless). Digests without the
    // optional field (v1 / non-fabric paths) emit nothing.
    const disp = digest?.dispatch;
    if (disp != null && typeof disp === 'object' && !Array.isArray(disp)) {
      const degraded = disp.outcome === 'escalate' || disp.outcome === 'error' || disp.degraded_fallback != null;
      const evBody = {
        task_id: id,
        outcome: disp.outcome ?? null,
        reason: disp.reason ?? null,
        decision_id: disp.decision_id ?? null,
        ...(disp.degraded_fallback != null ? { degraded_fallback: disp.degraded_fallback } : {}),
      };
      if (degraded) {
        dispatchEvents.push({ type: 'dispatch_degraded', ...evBody });
      } else if (disp.outcome === 'inline_designed') {
        // Designed Claude-tier inline routing gets its OWN durable tag so it is
        // queryable — and distinguishable from an execution outage — in events.jsonl.
        dispatchEvents.push({ type: 'dispatch_inline_designed', ...evBody });
      }
    }
  }
  for (const [id, review] of reconciledReviews) {
    if (!reviewedDigests.has(id)) collectBlockingReview(id, review);
  }
  const retained = [...new Set([...(run.review_rework ?? []), ...reviewRework])].filter((id) => !recorded.includes(id));
  if (retained.length || run.review_rework) {
    const { review_rework, review_recovery, ...marker } = run;
    nextState = { ...nextState, active_run: { ...marker, ...(retained.length ? {
      review_rework: retained, ...(recovery ? { review_recovery: true } : {}),
    } : {}) } };
  }

  // Scope verification uses the immutable launch allow-set and pre-write
  // capture. A changed file cannot be both accepted now and held for rework.
  const scope = verifyScope(declared, before, after);
  const inScope = scope.touched.filter((f) => !scope.outOfScope.includes(f));
  const lociOptions = { worktree: WT, mainRoot: MAIN, slug };
  const reworkFiles = canonicalizeScopePaths(reviewReworkFiles(nextState), lociOptions);
  const waveTasks = (nextState.tasks ?? []).filter((t) => t.wave === wave);
  const allDone = waveTasks.length > 0 && waveTasks.every((t) => t.status === 'done');
  let stage = inScope;
  if (!recovery && (retryTasks || !allDone)) {
    const done = waveTasks.filter((t) => t.status === 'done');
    const doneFiles = retryTasks ? done.flatMap((t) => retryTasks.get(String(t.id)) ?? [])
      : canonicalizeScopePaths(done.flatMap((t) => t.files ?? []), lociOptions);
    stage = inScope.filter((f) => pathWithinDeclaredScope(f, doneFiles) && !pathWithinDeclaredScope(f, reworkFiles));
  }
  if (retryTasks) {
    // Git treats even a literal directory pathspec recursively. A formerly
    // tracked file replaced by a directory is not a safe concrete mutation.
    for (const file of new Set([...stage, ...scope.outOfScope, ...watch.violations.filter((v) => v.restore).map((v) => v.path)])) {
      try {
        if (!fs.lstatSync(resolveFileLocus(file, lociOptions).abs).isDirectory()) continue;
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
        throw err;
      }
      throw new Error(`record-result: ${file} resolves to a directory; cannot establish retry path ownership`);
    }
  }
  if (!recovery && reworkFiles.length && recorded.length) {
    const acceptedFiles = canonicalizeScopePaths((nextState.tasks ?? [])
      .filter((t) => recorded.includes(t.id)).flatMap((t) => t.files ?? []), lociOptions);
    const conflict = inScope.find((f) => pathWithinDeclaredScope(f, reworkFiles) && pathWithinDeclaredScope(f, acceptedFiles));
    if (conflict) throw new Error(`record-result: ${conflict} is shared by accepted and review-blocked tasks; resolve their scope before recording`);
  }
  // Ordinary watch breaches are audit/cleanup outcomes, not refusals. The
  // explicit recovery preservation gate above does refuse on such a breach.
  if (recoveryPreflight) watch = recoveryPreflight.watch;
  const ts = new Date(now ?? Date.now()).toISOString();
  const codeMessage = `masterplan(${nextState.slug}): wave ${wave} code`;
  const mode = result ? 'record' : 'reconcile';
  const stateMessage = `masterplan(${nextState.slug}): wave ${wave} state (${mode})`;
  const bundleRel = path.relative(MAIN, bundleDir) || '.';
  const statePathspec = [bundleRel, `:(exclude)${bundleRel}/.owner*`,
    `:(exclude,literal)${bundleRel}/${RECORDING_FILE}`, `:(exclude,literal)${bundleRel}/${RECORDING_FILE}.tmp`];
  const stageLoci = recovery ? [] : partitionPathsByRepo(stage, lociOptions);
  const stagePlan = recovery || !stage.length ? [] :
    [...mapUmbrellaPathsToRepos(stage, stageLoci.length ? stageLoci : [{ repo: WT, prefix: null, rels: stage }])]
      .filter(([, rels]) => rels.length);
  const doneFiles = canonicalizeScopePaths(
    waveTasks.filter((t) => t.status === 'done' && (!retained.length || recorded.includes(t.id)))
      .flatMap((t) => t.files ?? []), lociOptions,
  );
  const doneRepos = recovery ? [] : partitionPathsByRepo(doneFiles, lociOptions).map(({ repo }) => repo);
  for (const [repo, rels] of stagePlan) preflightRecordingCommit(repo, rels, { literal: true });
  // A legacy bundle rooted in a linked WT is not part of MAIN's pathspec.
  if (runGit(bundleDir, ['rev-parse', '--show-toplevel']) === MAIN) preflightRecordingCommit(MAIN, statePathspec);
  const watchEvents = [];
  if (!recovery && watch.checked && !watch.ok) {
    watchEvents.push({ type: 'watch_list_breach', wave, violations: watch.violations, at: ts });
  }
  const cleanup = [];

  // 3. Out-of-scope revert, split by trackedness AND by owning repo (umbrella + siblings).
  //    Plain `checkout --` ERRORS on untracked paths, so tracked offenders revert via
  //    checkout and the remainder via clean — per locus, never a single worktree-rooted
  //    git that rejects external absolute/sibling paths.
  //    RECOVERY: the preservation gate already rejected out-of-scope files in the preflight,
  //    so this destructive revert is NEVER entered in recovery mode.
  const reverted = recovery ? [] : scope.outOfScope;
  if (reverted.length) {
    const oosLoci = partitionPathsByRepo(scope.outOfScope, {
      worktree: WT, mainRoot: MAIN, slug,
    });
    // Also handle pure-worktree paths that partition might miss if resolution fails.
    const mapped = mapUmbrellaPathsToRepos(
      scope.outOfScope,
      oosLoci.length
        ? oosLoci
        : [{ repo: WT, prefix: null }],
    );
    for (const [repo, rels] of mapped) {
      if (!rels.length) continue;
      const tracked = gitLines(repo, ['--literal-pathspecs', 'ls-files', '--', ...rels]);
      // Resolve index conflicts before publishing the cleanup plan. The
      // commands themselves are idempotent and still subject to runtime I/O.
      if (gitLines(repo, ['--literal-pathspecs', 'ls-files', '--unmerged', '--', ...rels]).length)
        throw new Error(`record-result: cannot revert unmerged paths in ${repo}`);
      cleanup.push({ repo, checkout: tracked, clean: rels, watch: false });
    }
  }

  // 3b. Workspace root drift check: agents must not create loose files in the workspace root.
  //     If the wave was launched with a wsBaseline, compare current workspace root entries
  //     against it and remove any new non-hidden entries (agent artifacts like AUDIT-*.md).
  //     RECOVERY: never unlink — the preflight reported drift as a violation instead.
  let workspace = null;
  if (!recovery && run.wsBaseline && Array.isArray(run.wsBaseline) && run.wsBaseline.length > 0) {
    // A8: same git-toplevel derivation the launch capture used (workspaceRootFor on MAIN),
    // so the completion check reads the SAME root the baseline was captured from — never a
    // different depth/parent that silently disables the drift check.
    const wsRoot = workspaceRootFor(MAIN);
    const baselineSet = new Set(run.wsBaseline);
    if (wsRoot) workspace = { root: wsRoot, entries: captureWorkspaceRoot(wsRoot)
      .filter((entry) => !baselineSet.has(entry)).map((name) => {
        const entry = path.join(wsRoot, name);
        const directory = fs.statSync(entry, { throwIfNoEntry: false })?.isDirectory() ?? false;
        return { name, directory, fingerprint: directory ? null : retryPathFingerprint(wsRoot, { path: name, line: '' }) };
      }) };
  }

  // 3c. Watch-list breach revert — the sibling-repo half of step 3.
  //     Step 3 reverts what verifyScope saw, which is worktree-relative only: a child that
  //     wrote into a WATCHED SIBLING repo was detected by 2b and then left dirty, so the
  //     breach had to be cleaned up by hand. Undo it here, on the same evidence that found
  //     it. Restores only what the wave itself introduced: `restore` is null for a path that
  //     was already dirty at launch (the user's work — CD-2) and for one whose launch state
  //     could not be established, so a destructive revert is never a guess. MAIN is excluded
  //     (its transaction files are the controller's own) and a moved HEAD is never "reverted"
  //     — that stays a loud violation for a human.
  const watchUnrestored = [];
  if (!recovery && watch.checked && !watch.ok) {
    const byRepo = new Map();
    for (const v of watch.violations) {
      if (!v.rel || v.repo === MAIN) continue;
      if (!v.restore || (retryTasks && before.includes(v.path))) {
        watchUnrestored.push({ repo: v.repo, path: v.path, reason: v.reason });
        continue;
      }
      if (!byRepo.has(v.repo)) byRepo.set(v.repo, { checkout: [], clean: [] });
      byRepo.get(v.repo)[v.restore].push(v.rel);
    }
    for (const [repo, ops] of byRepo) cleanup.push({ repo, ...ops, watch: true });
  }

  const cleared = allDone && (!episodeRecord?.review_context?.enabled || blocking_reviews.length === 0);
  const finalState = cleared ? clearActiveRun(nextState) : nextState;
  const boundRecovery = recovery ? { repo: path.resolve(recoverySelector?.repo ?? WT),
    head: resolveCommitOid(recoverySelector?.repo ?? WT, 'HEAD'),
    accepted: Boolean(recorded.length || (allDone && blocking_reviews.length === 0)) } : null;
  const provenanceLines = dispatchEvents.map((ev) => prepareEventLine({
      type: ev.type,
      ts,
      phase: nextState.phase,
      task_id: ev.task_id,
      outcome: ev.outcome,
      reason: ev.reason,
      decision_id: ev.decision_id,
      ...(ev.degraded_fallback != null ? { degraded_fallback: ev.degraded_fallback } : {}),
      note: `task ${ev.task_id} dispatch ${ev.outcome ?? 'unknown'}${ev.reason ? `: ${ev.reason}` : ''}`,
  })).join('');
  const summaryEvent = { type: 'wave_recorded', ts, phase: finalState.phase,
    note: `wave ${wave} ${mode}: ${recorded.length} done, ${failed.length} failed/blocked, ${qctl.length} qctl` +
      (reverted.length ? `; reverted ${reverted.length} out-of-scope` : '') };
  const reviewLines = deferredEvents.map(({ event }) => prepareEventLine(event)).join('');
  const eventStart = recordingEventStart(statePath);
  const editLoci = partitionPathsByRepo([...declared, ...declaredScope(state, wave)], lociOptions);
  const snapshots = captureRecordingLoci([MAIN, WT, ...editLoci.map(({ repo }) => repo),
    ...stagePlan.map(([repo]) => repo), ...doneRepos, ...cleanup.map(({ repo }) => repo),
    ...(boundRecovery ? [boundRecovery.repo] : [])], bundleDir);
  const dispatch = readRecordingDispatch(bundleDir, wave);
  const pending = { schema: 1, requestKey, originalState: recordingKey(state), dispatch,
    finalizeDispatch: finalizeDispatch && dispatch?.status === 'pending', eventStart, reviewLines,
    markedState: nextState, finalState, MAIN, WT, wave, ts, codeMessage, stateMessage, statePathspec,
    stagePlan, doneRepos, boundRecovery, cleanup, workspace, snapshots, summaryEvent, provenanceLines,
    watchLines: watchEvents.map(prepareEventLine).join(''), watchUnrestored,
    outcome: { outcome: 'recorded', mode, wave, recorded, failed, qctl, blocking_reviews,
      ...(reviewRework.length ? { review_rework: reviewRework } : {}), scope, watch, reverted, cleared } };
  const refused = refuseIfNotOwner();
  if (refused) return refused;
  saveWaveRecording(statePath, pending);
  return applyPublishedRecording(statePath, pending, state, Buffer.from(reviewLines));
}

function dispatchAfterRecording(pending, commits) {
  const { outcome: res, dispatch, ts } = pending;
  if (!pending.finalizeDispatch) return dispatch;
  if (!res.recorded.length && !res.review_rework?.length) return { ...dispatch,
    record_error: { outcome: res.outcome, reason: 'record-result recorded no tasks', recorded: [] } };
  return { ...dispatch, status: 'recorded', completed_at: ts, record_outcome: {
    recorded: res.recorded, failed: res.failed, cleared: res.cleared, commits,
    ...(res.blocking_reviews.length ? { blocking_reviews: res.blocking_reviews } : {}),
  } };
}

function resumeWaveRecording({ statePath, state, self, now, worktree, requestKey, pending }) {
  const { MAIN, WT, originalState, markedState, finalState, tail, wave } = pending;
  const bundleDir = path.dirname(path.resolve(statePath));
  if ((requestKey != null && requestKey !== pending.requestKey) || (worktree && path.resolve(worktree) !== WT)) {
    throw new Error('record-result: interrupted recording does not match this request; use --reconcile');
  }
  if (MAIN !== path.dirname(runGit(bundleDir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) ||
      ![originalState, recordingKey(markedState), ...(tail ? [recordingKey(finalState)] : [])].includes(recordingKey(state))) {
    throw new Error('record-result: state changed across the interrupted recording');
  }
  const dispatch = readRecordingDispatch(bundleDir, wave);
  const stateSha = tail ? recordingStateCommit(pending, bundleDir) : null;
  if (recordingKey(dispatch) !== recordingKey(pending.dispatch) && (!tail ||
      recordingKey(dispatch) !== recordingKey(dispatchAfterRecording(pending, { ...tail.commits, state: stateSha })))) {
    throw new Error('record-result: dispatch changed across the interrupted recording');
  }
  const missing = recordingEventSuffix(statePath, pending);
  checkRecordingLoci(pending, bundleDir);
  if (state.concurrency?.owner_lock !== 'off') {
    const hb = heartbeatOwner(bundleDir, self, { now });
    if (hb.outcome !== 'held-by-self') return { outcome: 'lost-to-other', reason: hb.reason, incumbent: hb.incumbent ?? null };
  }
  return applyPublishedRecording(statePath, pending, state, missing, stateSha, dispatch);
}

function applyPublishedRecording(...args) {
  try { return applyWaveRecording(...args); }
  catch (err) {
    throw new Error(`record-result: recording interrupted; resume with mp record-result --reconcile or mp continue: ${err.message}`, { cause: err });
  }
}

function recordingStateCommit(pending, bundleDir) {
  const { MAIN, tail, stateMessage } = pending;
  const head = runGit(MAIN, ['rev-parse', 'HEAD']);
  const rel = path.relative(MAIN, bundleDir);
  return recordingCommitAtHead(MAIN, head, tail.mainHead, stateMessage, (f) => !rel || f.startsWith(`${rel}/`)) ? head : null;
}

function applyWaveRecording(statePath, pending, state, missing, stateSha = null, dispatch = pending.dispatch) {
  const { WT, MAIN, boundRecovery, markedState, finalState, statePathspec, stateMessage, codeMessage, ts, wave,
    cleanup, stagePlan, workspace, snapshots, doneRepos, outcome } = pending;
  const bundleDir = path.dirname(path.resolve(statePath));
  let { tail } = pending;
  if (!tail) {
    appendRecordingSuffix(statePath, missing);
    if (recordingKey(state) !== recordingKey(markedState)) writeState(statePath, markedState);
    const watchReverted = [];
    const watchUnrestored = [...pending.watchUnrestored];
    for (const { repo, checkout, clean, watch } of cleanup) {
      try {
        if (checkout.length) runGit(repo, ['--literal-pathspecs', 'checkout', '--', ...checkout]);
        if (clean.length) runGit(repo, ['--literal-pathspecs', 'clean', '-fd', '--', ...clean]);
        if (watch) watchReverted.push(...[...checkout, ...clean].map((rel) => ({ repo, path: rel })));
      } catch (err) {
        if (!watch) throw err;
        watchUnrestored.push({ repo, path: '(revert)', reason: `revert failed: ${err.message}` });
      }
    }
    const wsLoose = (workspace?.entries ?? []).map(({ name, directory, fingerprint }) => {
      if (directory) return `${name}/`;
      try {
        const entry = path.join(workspace.root, name);
        if (!fs.lstatSync(entry, { throwIfNoEntry: false })) return name; // already removed
        if (fingerprint == null || retryPathFingerprint(workspace.root, { path: name, line: '' }) !== fingerprint) return `${name}?`;
        fs.unlinkSync(entry);
        return name;
      } catch { return `${name}?`; }
    });
    const code_by_repo = {};
    let code = boundRecovery?.head ?? null;
    if (boundRecovery?.accepted) code_by_repo[boundRecovery.repo] = code;
    for (const [repo, rels] of stagePlan) {
      const original = snapshots.find((snap) => snap.repo === repo).head;
      let head = resolveCommitOid(repo, 'HEAD');
      if (head === original && runGit(repo, ['--literal-pathspecs', 'status', '--porcelain', '--', ...rels])) {
        runGit(repo, ['--literal-pathspecs', 'add', '--', ...rels]);
        runGit(repo, ['--literal-pathspecs', 'commit', '-q', '-m', codeMessage, '--', ...rels]);
        head = resolveCommitOid(repo, 'HEAD');
      }
      if (head !== original) code_by_repo[repo] = head;
    }
    if (Object.keys(code_by_repo).length && !boundRecovery)
      code = stagePlan.some(([repo]) => repo === WT) ? resolveCommitOid(WT, 'HEAD') : Object.values(code_by_repo).at(-1);
    for (const repo of doneRepos) code_by_repo[repo] ??= resolveCommitOid(repo, 'HEAD');
    const { summaryEvent } = pending;
    const watchRevertLine = watchReverted.length || watchUnrestored.length ? prepareEventLine({
      type: 'watch_list_revert', wave, reverted: watchReverted, unrestored: watchUnrestored, at: ts,
    }) : '';
    const lines = pending.watchLines + watchRevertLine + pending.provenanceLines + prepareEventLine({ ...summaryEvent,
      note: summaryEvent.note + (wsLoose.length ? `; removed ${wsLoose.length} workspace-root loose file${wsLoose.length > 1 ? 's' : ''} (${wsLoose.join(', ')})` : '') });
    tail = { lines, mainHead: resolveCommitOid(MAIN, 'HEAD'), commits: { code, code_by_repo }, wsLoose,
      watch: { ...outcome.watch, reverted: watchReverted, unrestored: watchUnrestored } };
    saveWaveRecording(statePath, { ...pending, tail });
    missing = Buffer.from(lines);
    state = markedState;
  }
  appendRecordingSuffix(statePath, missing);
  if (recordingKey(state) !== recordingKey(finalState)) writeState(statePath, finalState);
  if (!stateSha && runGit(MAIN, ['status', '--porcelain', '--', ...statePathspec])) {
    runGit(MAIN, ['add', '--', ...statePathspec]);
    runGit(MAIN, ['commit', '-q', '-m', stateMessage, '--', ...statePathspec]);
    stateSha = resolveCommitOid(MAIN, 'HEAD');
  }
  const commits = { ...tail.commits, state: stateSha };
  const finalDispatch = dispatchAfterRecording(pending, commits);
  if (pending.finalizeDispatch && recordingKey(dispatch) !== recordingKey(finalDispatch))
    writeWaveDispatchRecord(bundleDir, wave, finalDispatch);
  finishWaveRecording(statePath);

  // Pure/advisory narration cannot turn a durable recording into a refusal.
  let next, summary;
  try { next = decideNextAction(finalState, { alive: false }); }
  catch (err) { next = { action: 'error', error: err.message }; }
  try { summary = waveSummary({ wave, recorded: outcome.recorded, failed: outcome.failed, next: next?.action ?? null, bundleDir }); }
  catch (err) { summary = { lines: [`wave ${wave} recorded (summary unavailable: ${err.message})`], reminder: null }; }
  return { ...outcome, watch: tail.watch, wsLoose: tail.wsLoose, commits, next,
    summary: summary.lines, goals_reminder: summary.reminder };
}

// ---------------------------------------------------------------------------
// §5.6 promoteAmendment — the promotion entry path (task 55)
// ---------------------------------------------------------------------------
//
// The single durable transaction an approved amendment promotes through, replacing the
// historical by-hand procedure (a hand-patched spec.md + a hand-appended spec_amended
// event) this amendment itself required. The transaction mechanics are
// lib/promote.mjs's; this entry path owns:
//
//   - Guard D on the bundle, acquired FIRST and held across begin + commit + record —
//     the same single-writer rule recordWaveResult's heartbeat enforces, so a competing
//     writer is serialized (or refused with zero writes), never interleaved between
//     the two artifact writes.
//   - the crash routing: an existing prepared/written doc for this transaction_id
//     converges through recoverPromotion (the decision table), never a second begin.
//
// The caller (mp's amendment flow) supplies the approval-bound artifacts: the exact
// resulting bytes of BOTH halves (spec.md and goals.md), the unified diff between the
// current bases and those results, and the operator approval receipt binding every
// hash. Nothing is written before the diff is proven to reproduce both approved result
// hashes in memory.
export function promoteAmendment({
  statePath, transactionId, diff, resultSpec, resultGoals, approval, reason,
  self, now, exec,
} = {}) {
  if (!statePath) throw new Error('promoteAmendment: statePath is required');
  const bundleDir = path.dirname(path.resolve(statePath));

  // An existing transaction for this id: converge it (the decision table), never a
  // second begin. Idempotent: a recorded one replays as a no-op.
  const existingPath = promotionDocPath(statePath, transactionId);
  if (fs.existsSync(existingPath)) {
    return recoverPromotion({ statePath, transactionId, self, now, exec });
  }

  // Guard D first: the bundle write lock is held across begin (the proof + pin + doc
  // write), commit (both artifact writes), and the record. A live foreign owner
  // refuses with ZERO writes.
  if (self) {
    const acq = acquireOwner(bundleDir, self, { now: Number.isFinite(Number(now)) ? Number(now) : Date.now() });
    if (acq.outcome !== 'acquire' && acq.outcome !== 'held-by-self' && acq.outcome !== 'steal' && acq.outcome !== 'force') {
      return {
        outcome: 'lock_refused',
        reason: acq.reason,
        incumbent: acq.incumbent ?? null,
        writes: [],
        note: `the bundle write lock is held across both writes and the record — ${acq.outcome}`,
      };
    }
  }

  // Begin: validate the approval against the on-disk bases, prove the diff reproduces
  // both approved result hashes in memory, pin the bases by ref against gc, and write
  // the durable transaction document (state 'prepared'). Throws (nothing written on
  // any validation failure).
  const begun = beginPromotion({
    statePath, transactionId, diff, resultSpec, resultGoals, approval, reason, now, exec,
  });
  // Commit: the expected-revision check immediately before mutation, both writes, the
  // goals-cache convergence, and the exactly-once records — all under the held lock.
  return commitPromotion({ statePath, transactionId, self, now, exec });
}
