// test/intent-reconciliation.test.mjs — task 55: §6.3 repository INTENT.md reconciliation.
//
// The reconciliation resolves the repository artifact from the run's INTEGRATION TARGET
// — resolved as an identity {repository, remote, ref, resolved_commit, resolved_at},
// read at the RECORDED commit through the configured remote, never a worktree path and
// never a moving ref. The named states are distinct and never collapsed:
//
//   resolved            — the target carries INTENT.md at the recorded commit
//   absent_source       — VERIFIED absence (a target with no INTENT.md at all)
//   unknown_unavailable— the target cannot be established (unresolvable ref, unreachable
//                         remote, unreadable commit) — a named failure, never an absence
//
// Freshness: the four comparison outcomes are distinct — stands (a target that moves
// with unchanged bytes is NOT drift; the observation is refreshed and nothing is
// invalidated), drift (changed bytes), retarget (a changed authorization invalidates
// the prior rows outright), unknown_unavailable (a failed resolution stops the
// checkpoint; never a verified absence, never silent reuse).
//
// A detached HEAD with a configured freshly-resolved target resolves normally. A branch
// that lacks an artifact its target carries is drift AGAINST THE TARGET, never an absent
// source. The verdict vocabulary comes from the PINNED SCHEMA SNAPSHOT (§5.5 frozen
// read) — a bundle without a capture refuses, and alternate snapshot content changes
// the accepted vocabulary (data-driven, no copied list of today's headings).
//
// Every fixture is a REAL git repository pair (target remote + consumer checkout) under
// os.tmpdir(), removed once at teardown.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { writeState, buildSeedState, appendEvent } from '../lib/bundle.mjs';
import { captureSchema, registerSchemaSnapshotModule, SCHEMA_SNAPSHOT_FILENAME } from '../lib/interview.mjs';
import { captureSchemaSnapshot, computeSkillIdentity } from '../lib/schema-snapshot.mjs';
import {
  resolveReconciliationTarget,
  readTargetIntent,
  buildReconciliationRows,
  compareReconciliations,
  recordReconciliation,
  readRecordedReconciliation,
  reconciliationPath,
  RECONCILIATION_FILENAME,
  REPO_INTENT_DIGEST_ABSENT,
} from '../lib/reconcile-intent.mjs';

const TMPDIRS = [];
test.after(() => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});
const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- git fixture helpers ---------------------------------------------------------

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}

function initRepo(dir, { initialBranch = 'main' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', `--initial-branch=${initialBranch}`);
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commitAll(dir, message) {
  git(dir, 'add', '--all');
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

// A target repository with INTENT.md at its tip, plus a consumer checkout whose remote
// is the target (the integration-target shape: resolution goes THROUGH the remote).
const INTENT_MD = [
  '# INTENT',
  '',
  '## Purpose',
  'Keep work resumable.',
  '',
  '## Top invariant',
  'Nothing is silently lost.',
  '',
  '## Non-goals',
  'No general framework.',
].join('\n') + '\n';

function mkTargetPair({ intentMd = INTENT_MD, clone = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-recon-'));
  TMPDIRS.push(tmp);
  const target = initRepo(path.join(tmp, 'target'));
  if (intentMd !== null) fs.writeFileSync(path.join(target, 'INTENT.md'), intentMd);
  fs.writeFileSync(path.join(target, 'README.md'), 'fixture\n');
  commitAll(target, 'init');
  if (!clone) return { tmp, target, consumer: null };
  const consumer = String(execFileSync('git', ['clone', '-q', target, path.join(tmp, 'consumer')], { encoding: 'utf8' }));
  return {
    tmp,
    target,
    consumer: path.join(tmp, 'consumer'),
    targetTip: git(path.join(tmp, 'consumer'), 'ls-remote', 'origin', 'main').split('\t')[0],
  };
}

// A bundle carrying a schema capture (the §5.5 pinned snapshot the verdict vocabulary
// resolves from) — the mkbundle/mkskill style of test/interview-design-intent.test.mjs.
const SCHEMA = {
  version: 1,
  core: ['Purpose'],
  standard_extensions: ['Audience', 'Core bet', 'Direction', 'Posture'],
  checked_sections: ['Purpose', 'Top invariant', 'Non-goals', 'Direction', 'Posture'],
  check_verdicts: ['serves', 'neutral', 'fights', 'unavailable'],
  plan_level: {
    anchor_key: 'topic',
    reconciliation: 'Reconciliation',
    reconciliation_unit: 'section',
    reconciliation_verdicts: ['serves', 'neutral', 'conflicts'],
    goal_heading_pattern: '^## G\\d+:',
  },
};

function mkbundle({ schema = SCHEMA } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-recon-b-'));
  TMPDIRS.push(dir);
  const statePath = path.join(dir, 'state.yml');
  writeState(statePath, buildSeedState({ slug: 'recon', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' }));
  const skillRoot = path.join(dir, 'skill');
  const manifest = {
    manifest_version: 1,
    skill: 'fixture-intent',
    host_contract_version: 1,
    schema_format_version: 1,
    identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] },
  };
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  captureSchema({ statePath, skillRoot });
  return { dir, statePath };
}

// The default verdicts: every section of the fixture INTENT.md, judged serves.
const ALL_SERVES = { Purpose: 'serves', 'Top invariant': 'serves', 'Non-goals': 'serves' };

// ---- target resolution -----------------------------------------------------------

test('resolution resolves the ref through the remote as an identity, pinned to a commit', () => {
  const { consumer, target } = mkTargetPair();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main', now: 1757112000000 });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.identity).sort(),
    ['ref', 'remote', 'repository', 'resolved_at', 'resolved_commit']);
  assert.match(r.identity.resolved_commit, /^[0-9a-f]{40}$/);
  assert.equal(r.identity.resolved_commit, git(target, 'rev-parse', 'main'));
  assert.equal(r.identity.resolved_at, new Date(1757112000000).toISOString());
});

test('an unresolvable ref is unknown/unavailable — NEVER a verified absence', () => {
  const { consumer } = mkTargetPair();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'no-such-ref' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unknown_unavailable');
  assert.match(r.reason, /zero candidates/);
});

test('an unreachable remote is unknown/unavailable, never an absence', () => {
  const { consumer } = mkTargetPair();
  const r = resolveReconciliationTarget({ repository: consumer, remote: '/nonexistent-mp-recon-xyz', ref: 'main' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'unknown_unavailable');
});

test('a missing ref/repository argument is unknown/unavailable (none selected)', () => {
  const { consumer } = mkTargetPair();
  for (const args of [{ repository: consumer, remote: 'origin' }, { repository: consumer, ref: 'main' }, { remote: 'origin', ref: 'main' }]) {
    const r = resolveReconciliationTarget(args);
    assert.equal(r.ok, false);
    assert.equal(r.status, 'unknown_unavailable');
  }
});

test('a detached HEAD with a configured freshly-resolved target resolves normally', () => {
  const { consumer, target } = mkTargetPair();
  // Detach the executor's worktree — the target is configured and freshly resolved, so
  // resolution goes through the remote and never notices the worktree at all.
  git(consumer, 'checkout', '-q', '--detach', 'HEAD');
  assert.match(git(consumer, 'status', '--porcelain=v1', '-b'), /^## HEAD \(no branch\)/);
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.identity.resolved_commit, git(target, 'rev-parse', 'main'));
  const read = buildReconciliationRows({
    identity: r.identity,
    statePath: mkbundle().statePath,
    verdictBySection: ALL_SERVES,
  });
  assert.equal(read.ok, true);
  assert.equal(read.record.status, 'resolved');
});

// ---- reading at the recorded commit ----------------------------------------------

test('reads use the RECORDED commit: a moved remote does not move the read', () => {
  const { consumer, target } = mkTargetPair();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  const recorded = r.identity.resolved_commit;
  // Move the target AFTER the resolution.
  fs.writeFileSync(path.join(target, 'INTENT.md'), INTENT_MD.replace('Keep work resumable.', 'CHANGED mid-flight.'));
  commitAll(target, 'change intent');
  const moved = git(target, 'rev-parse', 'main');
  assert.notEqual(recorded, moved);
  // The read is at the recorded commit: the bytes are the ones that resolution pinned.
  const read = readTargetIntent({ repository: consumer, remote: 'origin', ref: 'main', resolvedCommit: recorded });
  assert.equal(read.status, 'resolved');
  assert.equal(sha256Hex(read.bytes), sha256Hex(Buffer.from(INTENT_MD, 'utf8')));
});

test('a target with no INTENT.md at all is a VERIFIED ABSENCE (absent_source)', () => {
  const { consumer } = mkTargetPair({ intentMd: null });
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  assert.equal(r.ok, true);
  const read = readTargetIntent({
    repository: consumer, remote: 'origin', ref: 'main', resolvedCommit: r.identity.resolved_commit,
  });
  assert.equal(read.ok, true);
  assert.equal(read.status, 'absent_source');
  // The absent-source state reaches the record as an explicit digest value, not a null.
  const rows = buildReconciliationRows({ identity: r.identity, statePath: mkbundle().statePath });
  assert.equal(rows.ok, true);
  assert.equal(rows.record.status, 'absent_source');
  assert.equal(rows.record.artifact_digest, REPO_INTENT_DIGEST_ABSENT);
  assert.deepEqual(rows.record.rows, []);
});

test('an unreadable recorded commit is unknown/unavailable, never a verified absence', () => {
  const { consumer } = mkTargetPair();
  // A commit id nothing has: `cat-file blob` reports the MISSING COMMIT class, which the
  // object-presence check separates from the absent-path class.
  const read = readTargetIntent({
    repository: consumer, remote: 'origin', ref: 'main',
    resolvedCommit: '0123456789012345678901234567890123456789',
  });
  assert.equal(read.ok, false);
  assert.equal(read.status, 'unknown_unavailable');
  assert.match(read.reason, /recorded commit .* is not readable/);
});

// ---- rows per section ------------------------------------------------------------

test('one row per repository INTENT.md section, each anchored to the resolved identity', () => {
  const { consumer } = mkTargetPair();
  const { statePath } = mkbundle();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  const rows = buildReconciliationRows({
    identity: r.identity,
    statePath,
    verdictBySection: { Purpose: 'serves', 'Top invariant': 'neutral', 'Non-goals': 'conflicts' },
  });
  assert.equal(rows.ok, true);
  assert.deepEqual(rows.record.rows.map((x) => x.section), ['Purpose', 'Top invariant', 'Non-goals']);
  assert.deepEqual(rows.record.rows.map((x) => x.verdict), ['serves', 'neutral', 'conflicts']);
  for (const row of rows.record.rows) {
    assert.equal(row.artifact_path, 'INTENT.md');
    assert.match(row.artifact_digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(row.resolved_ref.resolved_commit, r.identity.resolved_commit);
    assert.equal(row.resolved_ref.ref, 'main');
  }
  // The whole-file artifact digest is the authorization member (sha256 of the exact
  // bytes at the resolved commit).
  assert.equal(rows.record.artifact_digest, `sha256:${sha256Hex(Buffer.from(INTENT_MD, 'utf8'))}`);
  // A section edit moves its row's digest without touching the others.
  const edited = buildReconciliationRows({
    identity: r.identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  assert.equal(edited.record.rows[0].verdict, 'serves');
});

test('a section edit moves its own row digest (the row is anchored to its section bytes)', () => {
  const { consumer, target } = mkTargetPair();
  const { statePath } = mkbundle();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  const before = buildReconciliationRows({ identity: r.identity, statePath, verdictBySection: ALL_SERVES });
  // Change ONLY the Purpose section; Top invariant and Non-goals keep their bytes.
  const editedText = INTENT_MD.replace('Keep work resumable.', 'Keep work on the owner\u2019s course.');
  fs.writeFileSync(path.join(target, 'INTENT.md'), editedText);
  commitAll(target, 'edit purpose only');
  const r2 = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  const after = buildReconciliationRows({ identity: r2.identity, statePath, verdictBySection: ALL_SERVES });
  assert.notEqual(after.record.rows[0].artifact_digest, before.record.rows[0].artifact_digest);
  assert.equal(after.record.rows[1].artifact_digest, before.record.rows[1].artifact_digest);
  assert.equal(after.record.rows[2].artifact_digest, before.record.rows[2].artifact_digest);
});

test('a missing verdict is a refusal — a missing row is not a neutral outcome', () => {
  const { consumer } = mkTargetPair();
  const { statePath } = mkbundle();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  const rows = buildReconciliationRows({ identity: r.identity, statePath, verdictBySection: { Purpose: 'serves' } });
  assert.equal(rows.ok, false);
  assert.equal(rows.status, 'unknown_unavailable');
  assert.match(rows.reason, /every repository INTENT.md section needs one/);
});

// ---- the verdict vocabulary is the pinned snapshot's ------------------------------

test('the verdict vocabulary comes from the pinned schema snapshot, never a built-in list', () => {
  const { consumer } = mkTargetPair();
  const { statePath } = mkbundle();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  // A verdict OUTSIDE the snapshot's reconciliation_verdicts refuses — even 'fights',
  // which is a check verdict, not a reconciliation verdict.
  const bad = buildReconciliationRows({
    identity: r.identity, statePath, verdictBySection: { Purpose: 'fights', 'Top invariant': 'serves', 'Non-goals': 'serves' },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /reconciliation_verdicts/);
});

test('alternate snapshot content changes the accepted vocabulary (data-driven)', () => {
  const { consumer } = mkTargetPair();
  const alternate = {
    ...SCHEMA,
    plan_level: {
      ...SCHEMA.plan_level,
      reconciliation_verdicts: ['aligned', 'unrelated', 'contradicts'],
    },
  };
  const { statePath } = mkbundle({ schema: alternate });
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  // The snapshot's vocabulary governs: 'aligned' passes where 'serves' would have.
  const good = buildReconciliationRows({
    identity: r.identity,
    statePath,
    verdictBySection: { Purpose: 'aligned', 'Top invariant': 'unrelated', 'Non-goals': 'contradicts' },
  });
  assert.equal(good.ok, true);
  assert.deepEqual(good.record.rows.map((x) => x.verdict), ['aligned', 'unrelated', 'contradicts']);
  const stale = buildReconciliationRows({ identity: r.identity, statePath, verdictBySection: ALL_SERVES });
  assert.equal(stale.ok, false);
  assert.match(stale.reason, /reconciliation_verdicts/);
});

test('a bundle with no schema capture refuses — no vocabulary without the frozen snapshot', () => {
  const { consumer } = mkTargetPair();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-recon-nocap-'));
  TMPDIRS.push(dir);
  const statePath = path.join(dir, 'state.yml');
  writeState(statePath, buildSeedState({ slug: 'recon', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' }));
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  const rows = buildReconciliationRows({ identity: r.identity, statePath, verdictBySection: ALL_SERVES });
  assert.equal(rows.ok, false);
  assert.equal(rows.status, 'unknown_unavailable');
  assert.match(rows.reason, /pinned schema snapshot is unavailable/);
});

// ---- freshness: the four distinct outcomes ---------------------------------------

test('moved target, unchanged bytes: NOT drift — the observation refreshes, nothing invalidates', () => {
  const { consumer, target } = mkTargetPair();
  const { statePath } = mkbundle();
  const first = buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  // Move the target WITHOUT touching INTENT.md.
  fs.writeFileSync(path.join(target, 'README.md'), 'unrelated change\n');
  commitAll(target, 'move tip, intent untouched');
  const second = buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  assert.equal(second.record.identity.resolved_commit, second.record.identity.resolved_commit);
  const cmp = compareReconciliations(first.record, second.record);
  assert.equal(cmp.outcome, 'stands');
  assert.equal(cmp.prior_invalidated, false);
  assert.equal(cmp.refresh_observation, true);
  assert.deepEqual(second.record.rows.map((x) => x.verdict), ['serves', 'serves', 'serves']);
});

test('same target, changed bytes: drift — the prior reconciliation is invalidated', () => {
  const { consumer, target } = mkTargetPair();
  const { statePath } = mkbundle();
  const first = buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  fs.writeFileSync(path.join(target, 'INTENT.md'), INTENT_MD.replace('Nothing is silently lost.', 'Everything may be lost.'));
  commitAll(target, 'change the invariant');
  const second = buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  const cmp = compareReconciliations(first.record, second.record);
  assert.equal(cmp.outcome, 'drift');
  assert.equal(cmp.prior_invalidated, true);
  assert.equal(cmp.prior_authorization.repo_intent_digest, first.record.artifact_digest);
});

test('retarget: the previous target\u2019s reconciliation is invalidated outright', () => {
  const { consumer, target } = mkTargetPair();
  const { statePath } = mkbundle();
  const first = buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  // Retarget to a DIFFERENT ref on the same remote.
  git(target, 'branch', '-q', 'integration/x');
  const second = buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'integration/x' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  const cmp = compareReconciliations(first.record, second.record);
  assert.equal(cmp.outcome, 'retarget');
  assert.equal(cmp.prior_invalidated, true);
  assert.match(cmp.note, /stale rows cannot authorize work/);
});

test('a failed fresh resolution is unknown_unavailable, never silent reuse', () => {
  const { consumer, target } = mkTargetPair();
  const { statePath } = mkbundle();
  const first = buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  const cmp = compareReconciliations(first.record, { status: 'unknown_unavailable', reason: 'target gone' });
  assert.equal(cmp.outcome, 'unknown_unavailable');
  assert.equal(cmp.prior_invalidated, false);
});

test('first comparison: a prior-less record is earned outright', () => {
  const cmp = compareReconciliations(null, { status: 'resolved', identity: { repository: 'r', remote: 'o', ref: 'main' }, artifact_digest: 'sha256:abc' });
  assert.equal(cmp.outcome, 'first');
});

// ---- absent \u2194 present is an authorization change, absent-to-absent is not ----------

test('absent-to-absent stands; absent-to-present and present-to-absent are drift', () => {
  const absent = (repo, ref) => ({
    status: 'absent_source',
    identity: { repository: repo, remote: 'origin', ref, resolved_commit: 'a'.repeat(40), resolved_at: '2026-01-01T00:00:00.000Z' },
    artifact_path: 'INTENT.md',
    artifact_digest: REPO_INTENT_DIGEST_ABSENT,
    rows: [],
  });
  const present = { ...absent('r', 'main'), status: 'resolved', artifact_digest: 'sha256:def', rows: [] };
  assert.equal(compareReconciliations(absent('r', 'main'), absent('r', 'main')).outcome, 'stands');
  assert.equal(compareReconciliations(absent('r', 'main'), present).outcome, 'drift');
  assert.equal(compareReconciliations(present, absent('r', 'main')).outcome, 'drift');
});

// ---- a branch that lacks the artifact is drift against the target ------------------

test('a branch lacking INTENT.md the target carries is DRIFT, not an absent source', () => {
  const { consumer } = mkTargetPair();
  const { statePath } = mkbundle();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  // The executor's worktree deleted its INTENT.md; the target still carries it.
  const rows = buildReconciliationRows({
    identity: r.identity,
    statePath,
    verdictBySection: ALL_SERVES,
    branchIntentBytes: '', // the branch carries nothing
  });
  assert.equal(rows.ok, true);
  assert.equal(rows.record.status, 'resolved'); // the TARGET is present: never absent_source
  assert.equal(rows.record.branch.drift, true);
  assert.equal(rows.record.branch.present, false);
  assert.match(rows.record.branch.note, /drift against the target, not an absent source/);
});

test('a branch carrying the artifact the target does is recorded without drift', () => {
  const { consumer } = mkTargetPair();
  const { statePath } = mkbundle();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' });
  const rows = buildReconciliationRows({
    identity: r.identity,
    statePath,
    verdictBySection: ALL_SERVES,
    branchIntentBytes: INTENT_MD,
  });
  assert.equal(rows.record.branch.drift, false);
  assert.equal(rows.record.branch.present, true);
});

// ---- persistence -----------------------------------------------------------------

test('the durable record persists and a stands refresh records without ceremony', () => {
  const { consumer, target } = mkTargetPair();
  const { statePath } = mkbundle();
  const build = () => buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  const first = build();
  const rec1 = recordReconciliation({ statePath, record: first.record, at: 1757112000000 });
  assert.equal(rec1.comparison.outcome, 'first');
  assert.equal(fs.readFileSync(rec1.path, 'utf8').includes('"Purpose"'), true);
  assert.equal(readRecordedReconciliation(statePath).artifact_digest, first.record.artifact_digest);
  // A moved target with unchanged bytes records as a stands refresh.
  fs.writeFileSync(path.join(target, 'README.md'), 'move again\n');
  commitAll(target, 'move tip again');
  const second = build();
  const rec2 = recordReconciliation({ statePath, record: second.record });
  assert.equal(rec2.comparison.outcome, 'stands');
  assert.equal(readRecordedReconciliation(statePath).identity.resolved_commit, second.record.identity.resolved_commit);
});

test('recording a drift or retarget without the operator\u2019s acceptance refuses', () => {
  const { consumer, target } = mkTargetPair();
  const { statePath } = mkbundle();
  const build = () => buildReconciliationRows({
    identity: resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main' }).identity,
    statePath,
    verdictBySection: ALL_SERVES,
  });
  const first = build();
  recordReconciliation({ statePath, record: first.record });
  fs.writeFileSync(path.join(target, 'INTENT.md'), INTENT_MD.replace('No general framework.', 'Now a general framework.'));
  commitAll(target, 'change non-goals');
  const drifted = build();
  assert.throws(() => recordReconciliation({ statePath, record: drifted.record }), /drift .* the owner/);
  // Accepted drift records, naming the invalidation.
  const rec = recordReconciliation({ statePath, record: drifted.record, accepted: true });
  assert.equal(rec.comparison.outcome, 'drift');
  assert.equal(rec.record.comparison.prior_invalidated, true);
});

test('an unresolved target is never recorded', () => {
  const { statePath } = mkbundle();
  assert.throws(
    () => recordReconciliation({
      statePath,
      record: { status: 'unknown_unavailable', reason: 'gone', identity: {}, artifact_digest: null, rows: [] },
    }),
    /refusing to persist an unresolved target/
  );
  assert.equal(fs.existsSync(reconciliationPath(statePath)), false);
});