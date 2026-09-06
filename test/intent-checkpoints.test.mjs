// test/intent-checkpoints.test.mjs — task 56: §5.5's receipt identity tuples bound at the
// four checkpoints (spec review, the end-of-planning alignment audit, per-task
// adversarial review, the finish assessment).
//
// intent_identity carries {goals_hash, schema_snapshot_digest, skill_identity,
// reconciliation_digest} so evidence cannot cross an identity boundary; the finish tuple
// names {deploy_base_sha, deploy_chain_hash, live_check_digest} outright. Every
// checkpoint rejects missing / partial / unreadable / stale / mismatched evidence and an
// unresolved reviewer identity as UNAVAILABLE — never approval — and a LEGACY bundle
// (no schema capture) reports its absence EXPLICITLY, never as a schema-backed pass.
//
// The checked-section set is DATA-DRIVEN (from the frozen snapshot's checked_sections,
// proven with alternate snapshot content), and artifact identity (exact bytes, what
// approval binds) stays distinct from evidence identity (canonical) everywhere both
// appear.
//
// Producer + consumer seams: the task-review checkpoint runs through lib/task-review.mjs's
// real entry (reviewCompletedTasks — the same engine the wave dispatcher's native review
// seam drives), and the finish checkpoint through lib/finish.mjs's own tuple producers
// (deployChainHash / liveCheckDigest — the same outputs the deploy stage records), driven
// to a real run_final_check op by the finish-step machine. The MUTATION tests bypass the
// verifiers and forge evidence directly into the ledger — the CONSUMERS must catch it.

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
  buildReconciliationRows,
  recordReconciliation,
  RECONCILIATION_FILENAME,
} from '../lib/reconcile-intent.mjs';
import {
  buildIntentIdentity,
  buildFinishTuple,
  verifyCheckpointEvidence,
  resolveReviewerIdentity,
  checkedSectionsOf,
  artifactDigest,
  reconciliationDigest,
  REJECTION_STATUSES,
  INTENT_IDENTITY_MEMBERS,
  FINISH_TUPLE_MEMBERS,
} from '../lib/checkpoint-evidence.mjs';
import { reviewCompletedTasks, taskReviewBlocksWave } from '../lib/task-review.mjs';
import {
  deployChainHash,
  liveCheckDigest,
  finishCheckpointEvidence,
  verifyFinishReceipt,
} from '../lib/finish.mjs';
import { finishStep } from '../lib/finish-step.mjs';
import { goalsHash, encodeIntentBlock, INTENT_CODEC_VERSION } from '../lib/goals.mjs';

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

// ---- the intent schema fixture (the frozen snapshot the checkpoints read) --------

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

// An alternate snapshot — DIFFERENT checked sections, so the data-driven proof shows the
// checkpoint's required set following the snapshot, not a copied list of today's
// headings.
const ALTERNATE_SCHEMA = {
  ...SCHEMA,
  checked_sections: ['Mission statement', 'Operating principles', 'Success criteria'],
};

const LEGACY_GOALS_MD = [
  'topic: |',
  '  Prove the checkpoint bindings.',
  '',
  '## G1: The tuple binds',
  '## G2: The rejections fire',
  '## G3: The legacy absence is explicit',
  '',
].join('\n');

// A versioned (schema-backed) goals document: the codec block plus the goal list.
function versionedGoalsMd() {
  const authoritative = {
    version: INTENT_CODEC_VERSION,
    schema: { identity: 'design-intent@fixture', format_version: 1 },
    sections: {
      purpose: { body: 'The checkpoints bind their evidence.\n' },
      non_goals: { items: ['no second resolver'] },
      top_invariant: { body: 'Evidence never crosses an identity boundary.' },
      direction: { body: 'One tuple, every checkpoint.' },
      posture: { body: 'Refuse downgrades loudly.' },
    },
    context: { outcome: { body: 'The richer hash covers everything.' }, done_means: { body: 'release' } },
    evidence: [{ section: 'purpose', source: 'operator interview 2026-09-06' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified' }],
  };
  const enc = encodeIntentBlock(authoritative);
  assert.ok(enc.ok, JSON.stringify(enc));
  return `topic: |\n  Versioned checkpoint fixture.\n${enc.block}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
}

// ---- bundle fixtures --------------------------------------------------------------

// A schema-backed bundle: state.yml, a captured schema snapshot (the frozen read every
// checkpoint resolves), goals.md, and a recorded §6.3 reconciliation against a real
// target pair. `schema` selects the snapshot's content (the data-driven axis).
function mkBundle({ schema = SCHEMA, goalsMd = versionedGoalsMd(), reconcile = true, capture = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ckpt-'));
  TMPDIRS.push(dir);
  const statePath = path.join(dir, 'state.yml');
  writeState(statePath, buildSeedState({ slug: 'ckpt', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' }));
  if (goalsMd !== null) fs.writeFileSync(path.join(dir, 'goals.md'), goalsMd);
  if (!capture) return { dir, statePath };
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
  if (reconcile) mkRecordedReconciliation(statePath);
  return { dir, statePath, skillRoot };
}

// A real integration-target pair (target remote + consumer checkout) and a RECORDED
// reconciliation on the bundle — §6.3's durable record, which reconciliation_digest
// digests the authorization half of.
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

function mkTargetPair() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ckpt-t-'));
  TMPDIRS.push(tmp);
  const target = initRepo(path.join(tmp, 'target'));
  fs.writeFileSync(path.join(target, 'INTENT.md'), INTENT_MD);
  fs.writeFileSync(path.join(target, 'README.md'), 'fixture\n');
  commitAll(target, 'init');
  execFileSync('git', ['clone', '-q', target, path.join(tmp, 'consumer')], { encoding: 'utf8' });
  const consumer = path.join(tmp, 'consumer');
  return { tmp, target, consumer };
}

function mkRecordedReconciliation(statePath) {
  const { consumer } = mkTargetPair();
  const r = resolveReconciliationTarget({ repository: consumer, remote: 'origin', ref: 'main', now: 1757112000000 });
  assert.equal(r.ok, true);
  const rows = buildReconciliationRows({
    identity: r.identity,
    statePath,
    verdictBySection: { Purpose: 'serves', 'Top invariant': 'serves', 'Non-goals': 'serves' },
  });
  assert.equal(rows.ok, true, JSON.stringify(rows));
  return recordReconciliation({ statePath, record: rows.record, at: 1757112000001 });
}

// A bundle whose intent identity cannot be established — the checkpoint's named failure.
function readEventsOf(bundleDir) {
  try {
    return fs.readFileSync(path.join(bundleDir, 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

const healthyHarness = () => ({
  degraded: false, timed_out: false, stalled: false,
  deadline_exceeded: false, regions_unreviewed: 0, extraction_degraded: false,
});

const approveRecord = (over = {}) => ({
  final_verdict: 'approve',
  findings: [],
  blocking_findings: [],
  summary: 'clean',
  harness: healthyHarness(),
  reviewer_identity: { dispatch_id: 'disp-1', model: 'adversary-lane', output_tokens: 512 },
  ...over,
});

// ---------------------------------------------------------------------------
// buildIntentIdentity — the tuple itself
// ---------------------------------------------------------------------------

test('buildIntentIdentity: the schema-backed tuple carries all four members', () => {
  const { statePath } = mkBundle();
  const id = buildIntentIdentity({ statePath });
  assert.equal(id.ok, true, JSON.stringify(id));
  assert.equal(id.family, 'schema_backed');
  assert.deepEqual(Object.keys(id.identity).sort(), INTENT_IDENTITY_MEMBERS.slice().sort());
  // goals_hash is the CANONICAL family (goalsHash under the durable pin), and the pin
  // was repaired from the capture history (§6.1) — never parsed as legacy.
  assert.equal(id.identity.goals_hash, goalsHash(fs.readFileSync(path.join(path.dirname(statePath), 'goals.md'), 'utf8'), { formatPin: 'schema_backed' }));
  assert.match(id.identity.schema_snapshot_digest, /^[0-9a-f]{64}$/);
  assert.match(id.identity.skill_identity, /^[0-9a-f]{64}$/);
  assert.match(id.identity.reconciliation_digest, /^sha256:[0-9a-f]{64}$/);
});

test('buildIntentIdentity: a LEGACY bundle carries goals_hash only and reports the absence explicitly', () => {
  const { statePath } = mkBundle({ capture: false, goalsMd: LEGACY_GOALS_MD });
  const id = buildIntentIdentity({ statePath });
  assert.equal(id.ok, true, JSON.stringify(id));
  assert.equal(id.family, 'legacy');
  assert.equal(id.identity.legacy, true);
  assert.equal(id.identity.goals_hash, goalsHash(LEGACY_GOALS_MD));
  assert.equal('schema_snapshot_digest' in id.identity, false, 'the schema-backed members are absent, not fabricated');
  assert.match(id.note, /legacy bundle/);
  assert.match(id.note, /never a schema-backed pass/);
});

test('buildIntentIdentity: a schema-backed bundle with NO recorded reconciliation is a missing-member refusal', () => {
  const { statePath } = mkBundle({ reconcile: false });
  const id = buildIntentIdentity({ statePath });
  assert.equal(id.ok, false);
  assert.equal(id.status, 'missing');
  assert.match(id.reason, /reconciliation/);
});

test('buildIntentIdentity: an unreadable (malformed) reconciliation record is refused as unreadable', () => {
  const { dir, statePath } = mkBundle();
  fs.writeFileSync(path.join(dir, RECONCILIATION_FILENAME), '{ not json');
  const id = buildIntentIdentity({ statePath });
  assert.equal(id.ok, false);
  assert.equal(id.status, 'unreadable');
  assert.match(id.reason, /unreadable/);
});

test('reconciliationDigest digests the AUTHORIZATION half only — a moved target is not drift', () => {
  const { statePath } = mkBundle();
  const rec = JSON.parse(fs.readFileSync(path.join(path.dirname(statePath), RECONCILIATION_FILENAME), 'utf8'));
  const before = reconciliationDigest(rec);
  // The observation moves (a benign re-resolution); the authorization does not.
  const moved = {
    ...rec,
    identity: { ...rec.identity, resolved_commit: 'f'.repeat(40), resolved_at: '2026-09-09T00:00:00.000Z' },
  };
  assert.equal(reconciliationDigest(moved), before, 'a moved target with unchanged bytes never invalidates');
  // Drift (changed authorization bytes) DOES move the digest.
  const drifted = { ...rec, artifact_digest: `sha256:${'a'.repeat(64)}` };
  assert.notEqual(reconciliationDigest(drifted), before);
});

test('artifactDigest is the exact-bytes family, distinct from the canonical goalsHash family', () => {
  const bytes = Buffer.from(LEGACY_GOALS_MD, 'utf8');
  const artifact = artifactDigest(bytes);
  const canonical = goalsHash(LEGACY_GOALS_MD);
  assert.notEqual(artifact, canonical, 'the two identity families are never the same value');
  // A cosmetic difference moves neither family's claim about identity... and a real
  // edit moves the canonical one (the hash families stay distinct everywhere).
  assert.equal(artifact, artifactDigest(Buffer.from(LEGACY_GOALS_MD, 'utf8')));
});

// ---------------------------------------------------------------------------
// buildFinishTuple — named outright, fail-closed
// ---------------------------------------------------------------------------

test('buildFinishTuple names the three members outright and accepts them', () => {
  const t = buildFinishTuple({
    deployBaseSha: 'a'.repeat(40),
    deployChainHash: 'b'.repeat(64),
    liveCheckDigest: `sha256:${'c'.repeat(64)}`,
  });
  assert.equal(t.ok, true);
  assert.deepEqual(Object.keys(t.tuple), FINISH_TUPLE_MEMBERS);
});

test('buildFinishTuple refuses missing, partial and malformed tuples with the shared vocabulary', () => {
  assert.equal(buildFinishTuple({}).status, 'missing');
  const partial = buildFinishTuple({ deployBaseSha: 'a'.repeat(40), deployChainHash: 'b'.repeat(64) });
  assert.equal(partial.status, 'partial');
  assert.match(partial.reason, /live_check_digest/);
  const malformed = buildFinishTuple({ deployBaseSha: `sha256:${'b'.repeat(64)}`, deployChainHash: 'b'.repeat(64), liveCheckDigest: `sha256:${'c'.repeat(64)}` });
  assert.equal(malformed.status, 'unreadable');
  assert.match(malformed.reason, /not a commit id/);
  const malformedChain = buildFinishTuple({ deployBaseSha: 'a'.repeat(40), deployChainHash: 'short', liveCheckDigest: `sha256:${'c'.repeat(64)}` });
  assert.equal(malformedChain.status, 'unreadable');
  assert.match(malformedChain.reason, /not a chain digest/);
});

test('the finish tuple members come from finish.mjs and its own producers — the real outputs the deploy stage records', () => {
  // deployChainHash / liveCheckDigest are the SAME functions the deploy stage and
  // `mp record-goal-check --final` feed; the tuple is built from their real outputs.
  const chain = [
    { group: 'release', index: 0, status: 'done', exit: 0 },
    { group: 'live_check', index: 0, status: 'done', exit: 0, digest: `sha256:${'d'.repeat(64)}` },
  ];
  const digestFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mp-live-')), 'live.txt');
  fs.writeFileSync(digestFile, 'the live check observed the deployed surface\n');
  const t = buildFinishTuple({
    deployBaseSha: 'a'.repeat(40),
    deployChainHash: deployChainHash(chain),
    liveCheckDigest: liveCheckDigest(digestFile),
  });
  assert.equal(t.ok, true, JSON.stringify(t));
});

// ---------------------------------------------------------------------------
// verifyCheckpointEvidence — the four checkpoints × the rejection vocabulary
// ---------------------------------------------------------------------------

// The current identity of a schema-backed fixture, plus a valid reviewer.
function schemaBackedCurrent(statePath) {
  const current = buildIntentIdentity({ statePath });
  assert.equal(current.ok, true, JSON.stringify(current));
  return current;
}

const VALID_REVIEWER = { dispatch_id: 'disp-1', model: 'adversary-lane', output_tokens: 512 };

function schemaReceipt(over = {}) {
  return {
    intent_identity: {
      goals_hash: 'CURRENT',
      schema_snapshot_digest: 'CURRENT',
      skill_identity: 'CURRENT',
      reconciliation_digest: 'CURRENT',
    },
    reviewer_identity: VALID_REVIEWER,
    ...over,
  };
}

// Drives one rejection term through verifyCheckpointEvidence at one checkpoint and
// asserts the status — the shared vocabulary every checkpoint speaks.
function expectStatus(result, status) {
  assert.equal(result.ok, false, `expected refusal, got ${JSON.stringify(result)}`);
  assert.equal(result.status, status, `expected status ${status}, got ${JSON.stringify(result.status)}: ${result.reason}`);
  assert.ok(REJECTION_STATUSES.includes(status), 'the status is from the shared vocabulary');
  return result;
}

test('the rejection vocabulary is exactly G8\'s mirrored set — the statuses are the contract', () => {
  assert.deepEqual(REJECTION_STATUSES, ['missing', 'partial', 'unreadable', 'stale', 'mismatched', 'reviewer_unavailable']);
  assert.deepEqual(INTENT_IDENTITY_MEMBERS, ['goals_hash', 'schema_snapshot_digest', 'skill_identity', 'reconciliation_digest']);
  assert.deepEqual(FINISH_TUPLE_MEMBERS, ['deploy_base_sha', 'deploy_chain_hash', 'live_check_digest']);
});

test('per-checkpoint rejection matrix: every vocabulary term refuses, never approves', () => {
  const { statePath } = mkBundle();
  const current = schemaBackedCurrent(statePath);
  const good = {
    goals_hash: current.identity.goals_hash,
    schema_snapshot_digest: current.identity.schema_snapshot_digest,
    skill_identity: current.identity.skill_identity,
    reconciliation_digest: current.identity.reconciliation_digest,
  };
  const finishTuple = buildFinishTuple({
    deployBaseSha: 'a'.repeat(40),
    deployChainHash: 'b'.repeat(64),
    liveCheckDigest: `sha256:${'c'.repeat(64)}`,
  });

  for (const checkpoint of ['spec_review', 'alignment_audit', 'task_review', 'finish']) {
    const finishMembers = checkpoint === 'finish'
      ? {
          deploy_base_sha: finishTuple.tuple.deploy_base_sha,
          deploy_chain_hash: finishTuple.tuple.deploy_chain_hash,
          live_check_digest: finishTuple.tuple.live_check_digest,
        }
      : {};
    const ctx = {
      checkpoint,
      current,
      finishTuple: checkpoint === 'finish' ? finishTuple : undefined,
    };
    const receiptFor = (over) => schemaReceipt({
      intent_identity: { ...good },
      ...finishMembers,
      ...over,
    });
    // MISSING: no tuple on the receipt at all.
    expectStatus(verifyCheckpointEvidence({ ...ctx, receipt: { ...finishMembers, reviewer_identity: VALID_REVIEWER } }), 'missing');
    // PARTIAL: a tuple member that should exist is absent.
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: receiptFor({ intent_identity: { ...good, skill_identity: undefined } }),
    }), 'partial');
    // STALE: the tuple is well-formed but differs from the current one (any member).
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: receiptFor({ intent_identity: { ...good, reconciliation_digest: `sha256:${'e'.repeat(64)}` } }),
    }), 'stale');
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: receiptFor({ intent_identity: { ...good, goals_hash: `sha256:${'e'.repeat(64)}` } }),
    }), 'stale');
    // MISMATCHED (family): a legacy tuple offered to a schema-backed checkpoint is the
    // explicit absence — never a pass.
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: receiptFor({ intent_identity: { legacy: true, goals_hash: good.goals_hash } }),
    }), 'missing');
    // MISMATCHED (artifact-vs-evidence): the exact-bytes digest of goals.md offered in
    // the canonical goals_hash slot.
    const artifactGoals = artifactDigest(fs.readFileSync(path.join(path.dirname(statePath), 'goals.md')));
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      goalsArtifactDigest: artifactGoals,
      receipt: receiptFor({ intent_identity: { ...good, goals_hash: artifactGoals } }),
    }), 'mismatched');
    // REVIEWER UNAVAILABLE: the identity cannot be resolved — never approval.
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: receiptFor({ reviewer_identity: { dispatch_id: '', model: 'x', output_tokens: 5 } }),
    }), 'reviewer_unavailable');
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: receiptFor({ reviewer_identity: { dispatch_id: 'd', model: 'm', output_tokens: 0 } }),
    }), 'reviewer_unavailable');
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: { ...finishMembers, intent_identity: { ...good } },
    }), 'reviewer_unavailable');
    // UNREADABLE: the current tuple cannot be established at all.
    expectStatus(verifyCheckpointEvidence({
      ...ctx,
      receipt: receiptFor(),
      current: { ok: false, status: 'unreadable', reason: 'the frozen snapshot is gone' },
    }), 'unreadable');
    // And the matching receipt verifies.
    const ok = verifyCheckpointEvidence({ ...ctx, receipt: receiptFor() });
    assert.equal(ok.ok, true, `${checkpoint}: ${JSON.stringify(ok)}`);
    assert.equal(ok.legacy, undefined, 'a schema-backed pass is never reported as legacy');
  }
});

test('the finish tuple is part of the finish checkpoint\'s rejection matrix — flat and nested member shapes', () => {
  const { statePath } = mkBundle();
  const current = schemaBackedCurrent(statePath);
  const finishTuple = buildFinishTuple({
    deployBaseSha: 'a'.repeat(40),
    deployChainHash: 'b'.repeat(64),
    liveCheckDigest: `sha256:${'c'.repeat(64)}`,
  });
  const identity = {
    goals_hash: current.identity.goals_hash,
    schema_snapshot_digest: current.identity.schema_snapshot_digest,
    skill_identity: current.identity.skill_identity,
    reconciliation_digest: current.identity.reconciliation_digest,
  };
  const base = { checkpoint: 'finish', current, finishTuple };
  // No deploy members at all: missing.
  expectStatus(verifyCheckpointEvidence({ ...base, receipt: schemaReceipt({ intent_identity: identity }) }), 'missing');
  // One member absent: partial.
  expectStatus(verifyCheckpointEvidence({
    ...base,
    receipt: schemaReceipt({
      intent_identity: identity,
      deploy_base_sha: finishTuple.tuple.deploy_base_sha,
      deploy_chain_hash: finishTuple.tuple.deploy_chain_hash,
    }),
  }), 'partial');
  // A member that names a DIFFERENT deployment: stale — the tuple is the whole authorization.
  expectStatus(verifyCheckpointEvidence({
    ...base,
    receipt: schemaReceipt({
      intent_identity: identity,
      deploy_base_sha: 'f'.repeat(40),
      deploy_chain_hash: finishTuple.tuple.deploy_chain_hash,
      live_check_digest: finishTuple.tuple.live_check_digest,
    }),
  }), 'stale');
  expectStatus(verifyCheckpointEvidence({
    ...base,
    receipt: schemaReceipt({
      intent_identity: identity,
      deploy_base_sha: finishTuple.tuple.deploy_base_sha,
      deploy_chain_hash: 'e'.repeat(64),
      live_check_digest: finishTuple.tuple.live_check_digest,
    }),
  }), 'stale');
  expectStatus(verifyCheckpointEvidence({
    ...base,
    receipt: schemaReceipt({
      intent_identity: identity,
      deploy_base_sha: finishTuple.tuple.deploy_base_sha,
      deploy_chain_hash: finishTuple.tuple.deploy_chain_hash,
      live_check_digest: `sha256:${'e'.repeat(64)}`,
    }),
  }), 'stale');
  // The nested finish_tuple shape verifies the same (both name the members outright).
  const nested = verifyCheckpointEvidence({
    ...base,
    receipt: schemaReceipt({
      intent_identity: identity,
      finish_tuple: finishTuple.tuple,
    }),
  });
  assert.equal(nested.ok, true, JSON.stringify(nested));
});

test('LEGACY: a tuple-less receipt on a legacy bundle reports the absence explicitly, never as a schema-backed pass', () => {
  const { statePath } = mkBundle({ capture: false, goalsMd: LEGACY_GOALS_MD });
  const current = buildIntentIdentity({ statePath });
  assert.equal(current.ok, true);
  // A pre-binding receipt (the historical event shapes) satisfies a legacy checkpoint
  // AS legacy — the absence is explicit, the verdict never claims the schema-backed contract.
  const v = verifyCheckpointEvidence({ checkpoint: 'task_review', receipt: {}, current });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.legacy, true, 'the legacy absence is reported explicitly');
  assert.match(v.note, /never a schema-backed pass|not a schema-backed pass|explicit/);
  // And the reverse never happens: a schema-backed tuple offered to a legacy bundle is
  // fabricated evidence, refused as mismatched.
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'task_review',
    current,
    receipt: schemaReceipt({ intent_identity: { goals_hash: 'x', schema_snapshot_digest: 'y', skill_identity: 'z', reconciliation_digest: 'w' } }),
  }), 'mismatched');
});

test('LEGACY: a legacy receipt with the CURRENT goals_hash verifies; an amended goal set makes it stale', () => {
  const { statePath, dir } = mkBundle({ capture: false, goalsMd: LEGACY_GOALS_MD });
  const current = buildIntentIdentity({ statePath });
  const good = verifyCheckpointEvidence({
    checkpoint: 'task_review',
    current,
    receipt: { intent_identity: { legacy: true, goals_hash: current.identity.goals_hash }, reviewer_identity: VALID_REVIEWER },
  });
  assert.equal(good.ok, true, JSON.stringify(good));
  assert.equal(good.legacy, true);
  // Amend the goal set: the same receipt is now STALE — evidence cannot cross the boundary.
  fs.writeFileSync(path.join(dir, 'goals.md'), LEGACY_GOALS_MD + '## G4: A new goal\n');
  const amended = buildIntentIdentity({ statePath });
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'task_review',
    current: amended,
    receipt: { intent_identity: { legacy: true, goals_hash: current.identity.goals_hash }, reviewer_identity: VALID_REVIEWER },
  }), 'stale');
});

test('artifact-vs-evidence: a receipt offering the ARTIFACT digest of goals.md as goals_hash is refused as mismatched', () => {
  const { statePath, dir } = mkBundle();
  const current = schemaBackedCurrent(statePath);
  const artifact = artifactDigest(fs.readFileSync(path.join(dir, 'goals.md')));
  assert.notEqual(artifact, current.identity.goals_hash, 'sanity: the two families differ for the same file');
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'task_review',
    current,
    goalsArtifactDigest: artifact,
    receipt: schemaReceipt({
      intent_identity: {
        goals_hash: artifact, // the exact-bytes digest in the canonical slot: the confusion
        schema_snapshot_digest: current.identity.schema_snapshot_digest,
        skill_identity: current.identity.skill_identity,
        reconciliation_digest: current.identity.reconciliation_digest,
      },
    }),
  }), 'mismatched');
  // The same value in the CANONICAL slot of a DIFFERENT file's artifact digest is
  // indistinguishable from a foreign hash — stale, the boundary still holds.
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'task_review',
    current,
    goalsArtifactDigest: artifact,
    receipt: schemaReceipt({
      intent_identity: {
        goals_hash: `sha256:${'9'.repeat(64)}`,
        schema_snapshot_digest: current.identity.schema_snapshot_digest,
        skill_identity: current.identity.skill_identity,
        reconciliation_digest: current.identity.reconciliation_digest,
      },
    }),
  }), 'stale');
});

test('resolveReviewerIdentity reads the provenance shapes the real receipts use, strictly', () => {
  const gate = resolveReviewerIdentity({ dispatch_id: 'd', provider: 'p', model: 'm', output_tokens: 12 });
  assert.equal(gate.ok, true);
  assert.deepEqual(gate.identity, { dispatch_id: 'd', model: 'm', output_tokens: 12 });
  assert.equal(resolveReviewerIdentity({ provenance: { dispatch_id: 'd', model: 'm', completion_tokens: 7 } }).ok, true);
  assert.equal(resolveReviewerIdentity(null).status, 'reviewer_unavailable');
  assert.equal(resolveReviewerIdentity({ dispatch_id: 'd', model: 'm', output_tokens: -1 }).status, 'reviewer_unavailable');
  assert.equal(resolveReviewerIdentity({ reviewer_identity: { dispatch_id: 'd', model: '', output_tokens: 3 } }).status, 'reviewer_unavailable');
});

// ---------------------------------------------------------------------------
// DATA-DRIVEN checked sections: alternate snapshot content changes the required set
// ---------------------------------------------------------------------------

test('the checked-section set comes from the FROZEN SNAPSHOT — alternate content drives different checkpoint behavior', () => {
  // Today's fixture snapshot requires these five; the ALTERNATE snapshot declares a
  // different set, and the checkpoint follows the snapshot — never a copied list.
  const standard = checkedSectionsOf(SCHEMA);
  const alternate = checkedSectionsOf(ALTERNATE_SCHEMA);
  assert.deepEqual(standard, SCHEMA.checked_sections);
  assert.deepEqual(alternate, ['Mission statement', 'Operating principles', 'Success criteria']);
  assert.notDeepEqual(standard, alternate, 'the sets genuinely differ');

  const { statePath } = mkBundle();
  const current = schemaBackedCurrent(statePath);
  const identity = {
    goals_hash: current.identity.goals_hash,
    schema_snapshot_digest: current.identity.schema_snapshot_digest,
    skill_identity: current.identity.skill_identity,
    reconciliation_digest: current.identity.reconciliation_digest,
  };
  const receiptCovering = (sections) => schemaReceipt({
    intent_identity: identity,
    sections,
  });
  // Under the bundle's own snapshot, full coverage verifies.
  const full = {};
  for (const s of standard) full[s] = 'serves';
  const ok = verifyCheckpointEvidence({ checkpoint: 'spec_review', current, receipt: receiptCovering(full), checkedSections: checkedSectionsOf(SCHEMA) });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  // The SAME receipt under the ALTERNATE snapshot's set carries evidence for sections
  // that snapshot does not declare — evidence for a different schema never satisfies
  // this one. The required set moved WITH the snapshot content.
  expectStatus(verifyCheckpointEvidence({ checkpoint: 'spec_review', current, receipt: receiptCovering(full), checkedSections: alternate }), 'mismatched');
  // And a receipt that covers ONE declared section but not the rest is partial — a
  // tuple member (here: section evidence) that should exist is absent. The mixed shape
  // keeps the two failures distinct: all-foreign evidence is mismatched; incomplete
  // coverage of THIS schema's sections is partial.
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'spec_review', current, checkedSections: standard,
    receipt: receiptCovering({ [standard[0]]: 'serves' }),
  }), 'partial');
  // And all-foreign coverage (the alternate set's sections only) is mismatched.
  const altCov = {};
  for (const s of alternate) altCov[s] = 'serves';
  expectStatus(verifyCheckpointEvidence({ checkpoint: 'spec_review', current, receipt: receiptCovering(altCov), checkedSections: standard }), 'mismatched');
  // The alignment-audit checkpoint consumes the same data-driven set: the alternate
  // snapshot's own coverage verifies under the alternate snapshot.
  const altOk = verifyCheckpointEvidence({ checkpoint: 'alignment_audit', current, receipt: receiptCovering(altCov), checkedSections: alternate });
  assert.equal(altOk.ok, true, JSON.stringify(altOk));
  // and the standard coverage does not satisfy it.
  expectStatus(verifyCheckpointEvidence({ checkpoint: 'alignment_audit', current, receipt: receiptCovering(full), checkedSections: alternate }), 'mismatched');
  // No section evidence at all: missing.
  expectStatus(verifyCheckpointEvidence({ checkpoint: 'alignment_audit', current, receipt: schemaReceipt({ intent_identity: identity }), checkedSections: standard }), 'missing');
  // A declared section with a BLANK verdict: unreadable (present, says nothing).
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'spec_review', current, checkedSections: standard,
    receipt: receiptCovering({ ...full, 'Top invariant': '  ' }),
  }), 'unreadable');
});

// ---------------------------------------------------------------------------
// The task-review checkpoint through its REAL seam (reviewCompletedTasks)
// ---------------------------------------------------------------------------

const reviewInput = (sha = 'a'.repeat(64)) => ({
  repo: '/tmp/repo', diff: 'diff --git a/a b/a\n+change', sha,
  description: 'change a', class: 'bounded-edit',
});

function legacyTaskFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ckpt-tr-'));
  TMPDIRS.push(dir);
  const statePath = path.join(dir, 'state.yml');
  fs.writeFileSync(statePath, 'schema_version: 9.0.0\n');
  fs.writeFileSync(path.join(dir, 'goals.md'), LEGACY_GOALS_MD);
  return { dir, statePath };
}

test('the task-review checkpoint records the identity tuple on its events and accepts the matching receipt', async () => {
  const { dir, statePath } = mkBundle();
  let calls = 0;
  const items = await reviewCompletedTasks({
    statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: 1000,
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => { calls += 1; return approveRecord(); },
  });
  assert.equal(calls, 1);
  assert.equal(items[0].review.verdict, 'approve');
  const [ev] = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review');
  const current = buildIntentIdentity({ statePath });
  assert.deepEqual(ev.data.intent_identity, {
    goals_hash: current.identity.goals_hash,
    schema_snapshot_digest: current.identity.schema_snapshot_digest,
    skill_identity: current.identity.skill_identity,
    reconciliation_digest: current.identity.reconciliation_digest,
  });
  // Re-entry at the SAME tuple does not re-review.
  const again = await reviewCompletedTasks({
    statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: 1001,
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => { calls += 1; return approveRecord(); },
  });
  assert.equal(calls, 1, 'the matching tuple satisfies re-entry');
  assert.equal(again[0].review.verdict, 'approve');
});

test('the task-review checkpoint re-reviews a STALE receipt: an amended goal set invalidates the prior review', async () => {
  const { dir, statePath } = mkBundle();
  let calls = 0;
  const run = () => reviewCompletedTasks({
    statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: Date.now(),
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => { calls += 1; return approveRecord(); },
  });
  await run();
  assert.equal(calls, 1);
  // Amend the goal set — the tuple member moves, the prior receipt is STALE, and the
  // review is unavailable rather than approval: a fresh review is owed.
  const goalsPath = path.join(dir, 'goals.md');
  const doc = fs.readFileSync(goalsPath, 'utf8');
  fs.writeFileSync(goalsPath, doc.replace('## G1: Works', '## G1: Works differently'));
  await run();
  assert.equal(calls, 2, 'the stale review never suppresses a fresh one');
  const events = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(events.length, 2);
  const current = buildIntentIdentity({ statePath });
  assert.deepEqual(events[1].data.intent_identity, {
    goals_hash: current.identity.goals_hash,
    schema_snapshot_digest: current.identity.schema_snapshot_digest,
    skill_identity: current.identity.skill_identity,
    reconciliation_digest: current.identity.reconciliation_digest,
  });
});

test('MUTATION: a receipt forged straight into the ledger with a mismatched tuple is caught by the consumer', async () => {
  // Bypass the checkpoint's own recording path entirely: hand-write a
  // task_adversary_review event whose tuple does NOT match the current one. The
  // CONSUMER (the re-entry staleness check) must catch it — the forged approve never
  // suppresses the real review.
  const { dir, statePath } = mkBundle();
  const current = buildIntentIdentity({ statePath });
  const forged = {
    type: 'task_adversary_review',
    summary: 'task 1 adversary review complete — 0 findings (run ckpt-run)',
    data: {
      run: 'ckpt-run', task: 1, sha: 'a'.repeat(64), count: 0, base: 'base',
      // A FOREIGN tuple — the forgery bypasses the checkpoint's producer, so the only
      // thing that can catch it is the consumer comparing it against the CURRENT one.
      intent_identity: {
        goals_hash: `sha256:${'0'.repeat(64)}`,
        schema_snapshot_digest: current.identity.schema_snapshot_digest,
        skill_identity: current.identity.skill_identity,
        reconciliation_digest: current.identity.reconciliation_digest,
      },
      review: {
        verdict: 'approve', findings: [], blocking_findings: [], summary: 'forged',
        harness: healthyHarness(),
      },
    },
  };
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(forged)}\n`);
  let calls = 0;
  const items = await reviewCompletedTasks({
    statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: 1000,
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => { calls += 1; return approveRecord(); },
  });
  assert.equal(calls, 1, 'the forged event never satisfies re-entry');
  assert.equal(items[0].review.verdict, 'approve');
  const events = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(events.length, 2, 'a real review landed beside the forgery');
});

test('MUTATION: editing the recorded reconciliation to a stale digest is caught by the consumer', async () => {
  const { dir, statePath } = mkBundle();
  let calls = 0;
  const run = () => reviewCompletedTasks({
    statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: Date.now(),
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => { calls += 1; return approveRecord(); },
  });
  await run();
  assert.equal(calls, 1);
  // Edit the recorded reconciliation's authorization bytes directly on disk — the
  // reconciliation_digest member moves, and the prior review is stale.
  const recPath = path.join(dir, RECONCILIATION_FILENAME);
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  rec.artifact_digest = `sha256:${'a'.repeat(64)}`; // forged drift
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  await run();
  assert.equal(calls, 2, 'the reconciliation edit invalidates the bound review');
});

test('the task-review checkpoint refuses an unresolved reviewer identity — unavailable, never approval', async () => {
  const { dir, statePath } = mkBundle();
  const items = await reviewCompletedTasks({
    statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: 1000,
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => approveRecord({ reviewer_identity: { dispatch_id: '', model: 'm', output_tokens: 4 } }),
  });
  assert.equal(items[0].review.verdict, 'approve');
  assert.equal(items[0].review.reviewer_unavailable, true, 'the unresolved identity is marked on the review');
  assert.equal(taskReviewBlocksWave(items[0].review), true, 'an unavailable review never clears a wave');
  const [ev] = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review_skipped');
  assert.ok(ev, 'the event is recorded non-satisfying (skipped)');
  assert.match(ev.data.review.summary, /reviewer identity unresolved/);
  // The skipped event never satisfies re-entry: the next attempt re-reviews.
  let calls = 0;
  await reviewCompletedTasks({
    statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: 1001,
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => { calls += 1; return approveRecord(); },
  });
  assert.equal(calls, 1);
});

test('the task-review checkpoint stops on a bundle whose identity cannot be established', async () => {
  const { dir, statePath } = mkBundle();
  fs.writeFileSync(path.join(dir, RECONCILIATION_FILENAME), '{ torn');
  await assert.rejects(
    () => reviewCompletedTasks({
      statePath, runId: 'ckpt-run', wave: 1, baseSha: 'base', now: 1000,
      items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
      callReview: async () => approveRecord(),
    }),
    /cannot establish the run's intent identity/,
  );
});

test('LEGACY task review: pre-binding events keep satisfying re-entry, and the identity is the legacy tuple', async () => {
  const { dir, statePath } = legacyTaskFixture();
  // A pre-task-56 event (no identity): explicit legacy, still satisfying.
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({
    type: 'task_adversary_review',
    summary: 'task 1 adversary review complete — 0 findings (run legacy-run)',
    data: {
      run: 'legacy-run', task: 1, sha: 'a'.repeat(64), count: 0, base: 'base',
      review: { verdict: 'approve', findings: [], blocking_findings: [], summary: 'old', harness: healthyHarness() },
    },
  })}\n`);
  let calls = 0;
  const items = await reviewCompletedTasks({
    statePath, runId: 'legacy-run', wave: 1, baseSha: 'base', now: 1000,
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async () => { calls += 1; return approveRecord(); },
  });
  assert.equal(calls, 0, 'a pre-binding legacy event satisfies re-entry');
  assert.equal(items[0].review.verdict, 'approve');
  // A NEW review on the legacy bundle records the LEGACY tuple (goals_hash only)...
  const fresh = await reviewCompletedTasks({
    statePath, runId: 'legacy-run', wave: 1, baseSha: 'base', now: 1000,
    items: [{ task_id: 2, digest: { task_id: 2, status: 'done' }, review_input: reviewInput('b'.repeat(64)) }],
    callReview: async () => approveRecord(),
  });
  assert.equal(fresh[0].review.verdict, 'approve');
  const [ev] = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review' && e.data.task === 2);
  assert.deepEqual(ev.data.intent_identity, { legacy: true, goals_hash: goalsHash(LEGACY_GOALS_MD) });
  // ...and a goals amendment makes it stale, exactly as on the schema-backed family.
  fs.writeFileSync(path.join(dir, 'goals.md'), LEGACY_GOALS_MD + '## G4: New\n');
  let reCalls = 0;
  await reviewCompletedTasks({
    statePath, runId: 'legacy-run', wave: 1, baseSha: 'base', now: 1001,
    items: [{ task_id: 2, digest: { task_id: 2, status: 'done' }, review_input: reviewInput('b'.repeat(64)) }],
    callReview: async () => { reCalls += 1; return approveRecord(); },
  });
  assert.equal(reCalls, 1, 'the legacy tuple is real: a goals amendment re-arms the review');
});

// ---------------------------------------------------------------------------
// The finish checkpoint through its REAL seam (finish-step's deploy stage +
// finish.mjs's own tuple producers)
// ---------------------------------------------------------------------------

// A real MAIN repo + worktree + goals-enabled bundle, walked to a live deployment.
const DONE_WITH_LIVE = [
  'done:',
  '  release:',
  '    - run: /bin/true',
  '  live_check:',
  '    - run: /bin/true',
  '      check: /bin/true',
  '',
].join('\n');

function mkFinishFixture({ capture = false, goalsMd = LEGACY_GOALS_MD, seedSpecGate = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ckpt-fin-'));
  TMPDIRS.push(tmp);
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(MAIN, 'src-seed.txt'), 'seed\n');
  fs.writeFileSync(path.join(MAIN, '.gitignore'), '.worktrees/\n');
  fs.writeFileSync(path.join(MAIN, '.masterplan.yaml'), DONE_WITH_LIVE);
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  const WT = path.join(MAIN, '.worktrees', 'ckfin');
  git(MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/ckfin', WT);
  fs.mkdirSync(path.join(WT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(WT, 'src/a.txt'), 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'ckfin');
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8, slug: 'ckfin', status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, goals_enabled: true, autonomy: 'loose',
    review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  fs.writeFileSync(path.join(bundleDir, 'goals.md'), goalsMd);
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# spec\nbuild it\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  // The goals-capture gate precedes the spec gate on a goals_enabled bundle: freeze the
  // goal set so the REAL CLI path exercises the spec gate itself.
  appendEvent(statePath, {
    type: 'goals_frozen', ts: '2026-01-01T00:00:00Z',
    data: { goals_hash: goalsHash(goalsMd) },
    summary: 'fixture goals frozen',
  });
  // Satisfy the spec gate at the CURRENT spec+goals bytes (the §5.6 promotion family:
  // the gate binds BOTH artifacts' exact bytes). The real-CLI test opts out so it can
  // drive the gate itself.
  if (seedSpecGate) {
    const h = crypto.createHash('sha256');
    for (const rel of ['spec.md', 'goals.md']) {
      h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
    }
    appendEvent(statePath, {
      type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
      data: { hash: `sha256:${h.digest('hex')}`, count: 0, base: 'main' },
    });
  }
  const gHash = goalsHash(goalsMd);
  const headAtBuild = git(WT, 'rev-parse', 'HEAD');
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });
  const recordImplementationCheck = () => appendEvent(statePath, {
    type: 'goal_check', ts: '2026-01-01T00:00:01Z',
    data: {
      goals_hash: gHash, head_sha: headAtBuild, base: 'main',
      diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo', provenance_kind: 'assessor',
      verdicts: { G1: { verdict: 'achieved' }, G2: { verdict: 'achieved' }, G3: { verdict: 'achieved' } },
    },
  });
  return { tmp, MAIN, WT, bundleDir, statePath, step, gHash, headAtBuild, recordImplementationCheck };
}

// verify → retro → branch_finish → merge → release → live_check (with its digest file).
function walkToFinalCheck(fx, { capture = false } = {}) {
  if (capture) {
    // The schema-backed finish bundle: capture the snapshot before the worktree is
    // torn down, then earn + record the reconciliation (the identity the final
    // assessment's intent_identity carries).
    const skillRoot = path.join(fx.tmp, 'skill');
    const manifest = {
      manifest_version: 1, skill: 'fixture-intent', host_contract_version: 1, schema_format_version: 1,
      identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] },
    };
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture design-intent\n');
    fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify(SCHEMA, null, 2)}\n`);
    fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
    captureSchema({ statePath: fx.statePath, skillRoot });
    mkRecordedReconciliation(fx.statePath);
    // The capture moved the format pin; re-derive the goals hash under it.
    fx.gHash = goalsHash(fs.readFileSync(path.join(fx.bundleDir, 'goals.md'), 'utf8'), { formatPin: 'schema_backed' });
  }
  fx.recordImplementationCheck();
  let op = fx.step();
  assert.equal(op.op, 'run_verify', JSON.stringify(op));
  op = fx.step({ verify: 'pass' });
  if (op.op === 'write_retro') {
    fs.writeFileSync(op.path, '# retro\n');
    op = fx.step();
  }
  assert.equal(op.gate, 'branch_finish', JSON.stringify(op));
  op = fx.step({ choice: 'merge' });
  assert.equal(op.op, 'run_deploy_step', JSON.stringify(op));
  op = fx.step({ deployStepDone: { group: 'release', index: 0, exit: 0 } });
  assert.equal(op.group, 'live_check', JSON.stringify(op));
  const digestFile = path.join(fx.tmp, 'live-digest.txt');
  fs.writeFileSync(digestFile, 'the live check observed the deployed surface\n');
  op = fx.step({ deployStepDone: { group: 'live_check', index: 0, exit: 0, digestFile } });
  assert.equal(op.op, 'run_final_check', JSON.stringify(op));
  return { op, digestFile };
}

test('the finish checkpoint composes its tuple from finish.mjs\'s own producers, driven by the real deploy stage', () => {
  const fx = mkFinishFixture();
  const { op } = walkToFinalCheck(fx);
  // The op's values ARE the deploy stage's own records: the base the stage ran on, the
  // chain's hash, the live check's digest.
  const current = finishCheckpointEvidence({
    statePath: fx.statePath,
    deployBaseSha: op.deploy_base_sha,
    chain: op.deploy_chain,
    liveDigest: op.live_digest,
  });
  assert.equal(current.ok, true, JSON.stringify(current));
  assert.equal(current.checkpoint, 'finish');
  assert.equal(current.family, 'legacy');
  assert.equal(current.legacy, true, 'the legacy absence is reported explicitly at the finish too');
  assert.equal(current.finish_tuple.deploy_base_sha, op.deploy_base_sha);
  assert.equal(current.finish_tuple.deploy_chain_hash, deployChainHash(op.deploy_chain));
  assert.equal(current.finish_tuple.live_check_digest, liveCheckDigest(path.join(fx.tmp, 'live-digest.txt')));
  // A receipt echoing the CURRENT tuple + identity + reviewer verifies.
  const receipt = {
    intent_identity: current.intent_identity,
    deploy_base_sha: current.finish_tuple.deploy_base_sha,
    deploy_chain_hash: current.finish_tuple.deploy_chain_hash,
    live_check_digest: current.finish_tuple.live_check_digest,
    reviewer_identity: VALID_REVIEWER,
  };
  const v = verifyFinishReceipt(receipt, current);
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.legacy, true, 'the legacy finish is explicit, never a schema-backed pass');
});

test('the finish checkpoint on a SCHEMA-BACKED bundle carries the full tuple and the recorded authorization', () => {
  const fx = mkFinishFixture({ goalsMd: versionedGoalsMd() });
  const { op } = walkToFinalCheck(fx, { capture: true });
  const current = finishCheckpointEvidence({
    statePath: fx.statePath,
    deployBaseSha: op.deploy_base_sha,
    chain: op.deploy_chain,
    liveDigest: op.live_digest,
  });
  assert.equal(current.ok, true, JSON.stringify(current));
  assert.equal(current.family, 'schema_backed');
  assert.deepEqual(Object.keys(current.intent_identity).sort(), INTENT_IDENTITY_MEMBERS.slice().sort());
  assert.match(current.repo_intent_digest, /^sha256:|absent/);
  assert.deepEqual(Object.keys(current.target_identity).sort(), ['ref', 'remote', 'repository']);
  const receipt = {
    intent_identity: current.intent_identity,
    deploy_base_sha: current.finish_tuple.deploy_base_sha,
    deploy_chain_hash: current.finish_tuple.deploy_chain_hash,
    live_check_digest: current.finish_tuple.live_check_digest,
    reviewer_identity: VALID_REVIEWER,
  };
  const v = verifyFinishReceipt(receipt, current);
  assert.equal(v.ok, true, JSON.stringify(v));
  // A receipt under the OTHER family's tuple is mismatched — never a pass.
  expectStatus(verifyFinishReceipt({ ...receipt, intent_identity: { legacy: true, goals_hash: 'x' } }, current), 'missing');
  expectStatus(verifyFinishReceipt({}, current), 'missing');
});

test('MUTATION: a finish receipt forged against a different deployment is refused by the finish consumer', () => {
  const fx = mkFinishFixture({ goalsMd: versionedGoalsMd() });
  const { op } = walkToFinalCheck(fx, { capture: true });
  const current = finishCheckpointEvidence({
    statePath: fx.statePath,
    deployBaseSha: op.deploy_base_sha,
    chain: op.deploy_chain,
    liveDigest: op.live_digest,
  });
  // The forgery: every member present and well-formed, but bound to ANOTHER deployment.
  const forged = {
    intent_identity: current.intent_identity,
    deploy_base_sha: 'f'.repeat(40),
    deploy_chain_hash: current.finish_tuple.deploy_chain_hash,
    live_check_digest: current.finish_tuple.live_check_digest,
    reviewer_identity: VALID_REVIEWER,
  };
  expectStatus(verifyFinishReceipt(forged, current), 'stale');
  // And the partial forgery: a tuple member that never arrived.
  expectStatus(verifyFinishReceipt({
    intent_identity: current.intent_identity,
    deploy_base_sha: current.finish_tuple.deploy_base_sha,
    deploy_chain_hash: current.finish_tuple.deploy_chain_hash,
    reviewer_identity: VALID_REVIEWER,
  }, current), 'partial');
  // The identity forgery: an amended goals.md moves goals_hash, and the receipt bound
  // before it is stale.
  const goalsPath = path.join(fx.bundleDir, 'goals.md');
  fs.writeFileSync(goalsPath, fs.readFileSync(goalsPath, 'utf8').replace('## G1: Works', '## G1: Works now'));
  const moved = finishCheckpointEvidence({
    statePath: fx.statePath,
    deployBaseSha: op.deploy_base_sha,
    chain: op.deploy_chain,
    liveDigest: op.live_digest,
  });
  assert.equal(moved.ok, true);
  const staleReceipt = {
    intent_identity: current.intent_identity,
    deploy_base_sha: current.finish_tuple.deploy_base_sha,
    deploy_chain_hash: current.finish_tuple.deploy_chain_hash,
    live_check_digest: current.finish_tuple.live_check_digest,
    reviewer_identity: VALID_REVIEWER,
  };
  expectStatus(verifyFinishReceipt(staleReceipt, moved), 'stale');
});

test('MUTATION: editing the recorded reconciliation to a stale digest makes a bound finish receipt stale', () => {
  const fx = mkFinishFixture({ goalsMd: versionedGoalsMd() });
  const { op } = walkToFinalCheck(fx, { capture: true });
  const current = finishCheckpointEvidence({
    statePath: fx.statePath,
    deployBaseSha: op.deploy_base_sha,
    chain: op.deploy_chain,
    liveDigest: op.live_digest,
  });
  const receipt = {
    intent_identity: current.intent_identity,
    deploy_base_sha: current.finish_tuple.deploy_base_sha,
    deploy_chain_hash: current.finish_tuple.deploy_chain_hash,
    live_check_digest: current.finish_tuple.live_check_digest,
    reviewer_identity: VALID_REVIEWER,
  };
  assert.equal(verifyFinishReceipt(receipt, current).ok, true);
  // Edit the recorded reconciliation's authorization bytes on disk — the
  // reconciliation_digest member moves and the bound receipt is stale.
  const recPath = path.join(fx.bundleDir, RECONCILIATION_FILENAME);
  const rec = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  rec.artifact_digest = `sha256:${'7'.repeat(64)}`;
  fs.writeFileSync(recPath, JSON.stringify(rec, null, 2) + '\n');
  const mutated = finishCheckpointEvidence({
    statePath: fx.statePath,
    deployBaseSha: op.deploy_base_sha,
    chain: op.deploy_chain,
    liveDigest: op.live_digest,
  });
  assert.equal(mutated.ok, true);
  expectStatus(verifyFinishReceipt(receipt, mutated), 'stale');
});

// ---------------------------------------------------------------------------
// The spec-review and alignment-audit checkpoints over the REAL recorded event shapes
// ---------------------------------------------------------------------------

test('the spec-review checkpoint binds the artifact gate hash (spec.md AND goals.md bytes) beside the identity', () => {
  // §5.6's promotion precedent: the spec gate's hash spans BOTH artifacts' exact bytes —
  // artifact identity — while the checkpoint's tuple member is the canonical identity.
  // The two are carried in DISTINCT fields and never confused.
  const fx = mkFinishFixture();
  const bundleDir = fx.bundleDir;
  const h = crypto.createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  const gateHash = `sha256:${h.digest('hex')}`;
  const current = buildIntentIdentity({ statePath: fx.statePath });
  assert.equal(current.family, 'legacy');
  const receipt = {
    hash: gateHash, // the ARTIFACT binding (exact bytes, the §5.6 family)
    intent_identity: current.identity, // the EVIDENCE binding (canonical)
    reviewer_identity: VALID_REVIEWER,
    sections: { Purpose: 'serves' }, // a legacy bundle carries no snapshot: coverage is the legacy absence, not demanded here
  };
  const v = verifyCheckpointEvidence({ checkpoint: 'spec_review', receipt, current });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.equal(v.legacy, true);
  // An artifact edit re-arms the gate (the existing, enforced consumer) AND moves the
  // artifact member while the canonical goals_hash may or may not move — the two
  // families stay distinct.
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# spec\nedited\n');
  const h2 = crypto.createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h2.update(rel); h2.update('\0'); h2.update(fs.readFileSync(path.join(bundleDir, rel))); h2.update('\0');
  }
  assert.notEqual(`sha256:${h2.digest('hex')}`, gateHash, 'an artifact edit moves the artifact identity');
  const after = buildIntentIdentity({ statePath: fx.statePath });
  assert.equal(after.identity.goals_hash, current.identity.goals_hash, 'a spec edit does not move the canonical goals identity — distinct families, both present');
});

test('the spec-review gate through its REAL orchestration path: record-gate-review binds the artifact bytes, and the recorded receipt verifies', () => {
  // The REAL bin path: `mp record-gate-review` writes the event the guard reads, and
  // `mp set-phase --phase=plan` enforces the gate on the CURRENT artifact bytes — the
  // §5.6 promotion precedent (the gate spans spec.md AND goals.md) exercised end to end.
  const fx = mkFinishFixture({ seedSpecGate: false });
  const bundleDir = fx.bundleDir;
  const statePath = fx.statePath;
  const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
  const run = (args) => {
    try {
      return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
  // No review recorded: the gate demands one (exit 3 with the op).
  const blocked = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(blocked.status, 3, JSON.stringify(blocked));
  assert.match(blocked.stdout, /run_gate_review/);
  const movedIdentityGoalsHashBeforeEdit = buildIntentIdentity({ statePath }).identity.goals_hash;
  // A degraded-lane skip with evidence satisfies the gate (fail-soft, the existing seam).
  const notes = path.join(bundleDir, 'lane-notes.txt');
  fs.writeFileSync(notes, 'gateway 503 — recorded for the fixture\n');
  const rec = run(['record-gate-review', `--state=${statePath}`, '--gate=spec', '--status=skipped', '--reason=fixture degraded lane', `--digest-file=${notes}`]);
  assert.equal(rec.status, 0, rec.stderr);
  const passed = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(passed.status, 0, `${passed.stderr}${passed.stdout}`);
  // The recorded event IS the checkpoint's receipt source: it names the artifact hash
  // (exact bytes — artifact identity), and the checkpoint verifies against the bundle's
  // current identity with the legacy absence explicit.
  const [event] = readEventsOf(bundleDir).filter((e) => e.type === 'spec_adversary_review_skipped');
  assert.ok(event, 'the real CLI recorded the event');
  const h = crypto.createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  assert.equal(event.data.hash, `sha256:${h.digest('hex')}`, 'the recorded artifact binding is the CURRENT spec+goals bytes');
  // An artifact edit re-arms the REAL gate (the enforced consumer of the artifact
  // binding) — the spec half here, so the split-brain goals guard does not intercept
  // the fixture first. The prior receipt no longer covers the CURRENT bytes.
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# spec\nedited after the review\n');
  const again = run(['set-phase', `--state=${statePath}`, '--phase=plan']);
  assert.equal(again.status, 3, 'an artifact edit re-arms the gate: the prior receipt no longer covers the CURRENT bytes');
  assert.match(again.stdout, /run_gate_review/);
  // And the checkpoint tuple stays distinct from the artifact binding: a spec edit
  // moves the artifact hash the gate enforces while the canonical goals identity
  // (evidence identity) is untouched — the two families, both present, never confused.
  const identityAfter = buildIntentIdentity({ statePath: fx.statePath });
  assert.equal(identityAfter.identity.goals_hash, movedIdentityGoalsHashBeforeEdit, 'the canonical identity did not move on a spec edit');
});

test('the alignment-audit checkpoint binds anchor_hash + plan_hash beside the identity tuple', () => {
  const { statePath } = mkBundle();
  const current = schemaBackedCurrent(statePath);
  const receipt = {
    anchor_hash: `sha256:${sha256Hex(Buffer.from('anchor bytes', 'utf8'))}`,
    plan_hash: `sha256:${sha256Hex(Buffer.from('plan bytes', 'utf8'))}`,
    intent_identity: current.identity,
    reviewer_identity: VALID_REVIEWER,
  };
  const v = verifyCheckpointEvidence({ checkpoint: 'alignment_audit', receipt, current, checkedSections: checkedSectionsOf(SCHEMA) });
  assert.equal(v.ok, false, 'coverage is demanded on the schema-backed family');
  assert.equal(v.status, 'missing', 'no section evidence at all is missing, not partial');
  const full = {};
  for (const s of checkedSectionsOf(SCHEMA)) full[s] = 'covered';
  const ok = verifyCheckpointEvidence({
    checkpoint: 'alignment_audit',
    receipt: { ...receipt, sections: full },
    current,
    checkedSections: checkedSectionsOf(SCHEMA),
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

// ---------------------------------------------------------------------------
// The agent contracts (the three dispatched prompts carry the tuple binding)
// ---------------------------------------------------------------------------

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readAgent = (name) => fs.readFileSync(path.join(REPO, 'agents', name), 'utf8');
const flat = (t) => String(t ?? '').replace(/\s+/g, ' ');

test('the three dispatched agent docs bind the identity tuple additively (contract sections)', () => {
  for (const name of ['mp-adversarial-reviewer.md', 'mp-alignment-auditor.md', 'mp-goal-assessor.md']) {
    const doc = readAgent(name);
    // The binding lives in its own section on the reviewer and auditor docs, and inside
    // the assessor's final-receipt bindings section (the assessor's contract already
    // names the deploy tuple; the identity binding extends it).
    const section = /##+ The (?:identity binding|final receipt's bindings)/.exec(doc);
    assert.ok(section, `${name} must carry the identity-binding contract`);
    const body = flat(doc.slice(doc.indexOf(section[0])));
    // The tuple members and the boundary rule, in their own words:
    for (const member of INTENT_IDENTITY_MEMBERS) {
      assert.ok(body.includes(member), `${name} must name ${member}`);
    }
    assert.match(body, /cannot cross an identity boundary/, name);
    assert.match(body, /verbatim from the brief/i, name);
    assert.match(body, /legacy/i, name);
    assert.match(body, /unavailable/i, name);
  }
  // The reviewer's own record fields are named, so the projection's inputs are the contract:
  const reviewer = flat(readAgent('mp-adversarial-reviewer.md'));
  assert.match(reviewer, /`intent_identity`/);
  assert.match(reviewer, /`reviewer_identity`/);
  assert.match(reviewer, /dispatch_id/);
  // The assessor's final receipt binds the finish tuple members by name (the existing
  // section, extended):
  const assessor = flat(readAgent('mp-goal-assessor.md'));
  for (const m of FINISH_TUPLE_MEMBERS) {
    assert.match(assessor, new RegExp(`"${m}"`));
  }
});

test('the agent docs keep their existing structure and roles (additive sections only)', () => {
  const reviewer = readAgent('mp-adversarial-reviewer.md');
  // The pre-existing sections survive verbatim in role: the output shape, the v1 mode,
  // the fail rule.
  assert.match(reviewer, /## Output shape \(CD-10 severity-first\)/);
  assert.match(reviewer, /## v1 mode \(compatibility\)/);
  assert.match(reviewer, /## Fail rule \(never hang, never fabricate\)/);
  const auditor = readAgent('mp-alignment-auditor.md');
  assert.match(auditor, /## Phase 0 — anchor quality/);
  assert.match(auditor, /## The verdict contract/);
  const assessor = readAgent('mp-goal-assessor.md');
  assert.match(assessor, /## The missing-evidence rule/);
  assert.match(assessor, /## Phase 1 — verify the evidence yourself/);
  // Frontmatter untouched: name/model lanes still parse.
  for (const name of ['mp-alignment-auditor.md', 'mp-adversarial-reviewer.md', 'mp-goal-assessor.md']) {
    const fm = /^---\n([\s\S]*?)\n---/.exec(readAgent(name));
    assert.ok(fm, `${name} frontmatter`);
    assert.match(fm[1], /^name: mp-/m, name);
  }
});