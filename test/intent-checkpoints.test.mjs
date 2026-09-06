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

import { writeState, buildSeedState, appendEvent, resolveFormatPin, repairFormatPin } from '../lib/bundle.mjs';
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
  requiredCoverageSections,
  specGateArtifactHash,
  anchorArtifactHash,
  planArtifactHash,
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

// The ECHOING reviewer: the brief now carries the run's intent_identity (task 56, the
// fresh-path binding), and a record that wants to COUNT echoes it back verbatim — the
// agent contract's own rule. Non-echoing / foreign-echo variants are the refusal
// regressions below, so the echoing shape stays honest here.
const echoingApprove = (brief, over = {}) => {
  assert.ok(brief?.intent_identity, 'the review brief must carry the intent identity');
  return approveRecord({ intent_identity: brief.intent_identity, ...over });
};

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
  // The bundle's own gate artifacts: the spec checkpoint's `hash` binding and the
  // alignment checkpoint's anchor/plan bindings are INDEPENDENTLY computed by the
  // checkpoint from these bytes, so a matching receipt echoes exactly these values.
  const bundleDir = path.dirname(statePath);
  fs.writeFileSync(path.join(bundleDir, 'spec.md'), '# spec\nthe fixture gate artifact\n');
  fs.writeFileSync(path.join(bundleDir, 'plan.md'), '# plan\nthe fixture plan artifact\n');
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
    // Coverage + artifact bindings, as the checkpoint derives them from the bundle's
    // own snapshot and artifacts (data-driven: the set follows the frozen snapshot,
    // the artifact hashes follow the bytes on disk).
    const fullCoverage = {};
    for (const s of requiredCoverageSections(statePath)) fullCoverage[s] = 'serves';
    const artifactBindings = checkpoint === 'spec_review'
      ? { hash: specGateArtifactHash({ statePath }) }
      : checkpoint === 'alignment_audit'
        ? { anchor_hash: anchorArtifactHash({ statePath }), plan_hash: planArtifactHash({ statePath }) }
        : {};
    const requiredEvidence = (checkpoint === 'spec_review' || checkpoint === 'alignment_audit')
      ? { sections: fullCoverage, ...artifactBindings }
      : {};
    const receiptFor = (over) => schemaReceipt({
      intent_identity: { ...good },
      ...finishMembers,
      ...requiredEvidence,
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
      receipt: { ...finishMembers, ...requiredEvidence, intent_identity: { ...good } },
    }), 'reviewer_unavailable');
    // The ARTIFACT-BINDING refusals (schema-backed spec/alignment only): a receipt
    // missing the checkpoint's independently computed binding is partial; one naming
    // different bytes is stale. The checkpoint computes the binding from the bundle —
    // the receipt's value is compared against it, never adopted.
    if (checkpoint === 'spec_review' || checkpoint === 'alignment_audit') {
      const bindingField = checkpoint === 'spec_review' ? 'hash' : 'anchor_hash';
      const stripBinding = checkpoint === 'spec_review'
        ? { hash: undefined }
        : { anchor_hash: undefined };
      expectStatus(verifyCheckpointEvidence({
        ...ctx,
        receipt: receiptFor(stripBinding),
      }), 'partial');
      expectStatus(verifyCheckpointEvidence({
        ...ctx,
        receipt: receiptFor({ [bindingField]: `sha256:${'f'.repeat(64)}` }),
      }), 'stale');
      // COVERAGE refusals: no section evidence at all is missing (the coverage
      // requirement follows the bundle's frozen snapshot — never the caller's choice).
      expectStatus(verifyCheckpointEvidence({
        ...ctx,
        checkedSections: undefined,
        receipt: receiptFor({ sections: undefined }),
      }), 'missing');
    }
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
  // The bundle's own gate artifact: the spec checkpoint's `hash` binding is computed
  // from these bytes, so the matching receipt echoes exactly this value.
  fs.writeFileSync(path.join(path.dirname(statePath), 'spec.md'), '# spec\nthe fixture gate artifact\n');
  const current = schemaBackedCurrent(statePath);
  const identity = {
    goals_hash: current.identity.goals_hash,
    schema_snapshot_digest: current.identity.schema_snapshot_digest,
    skill_identity: current.identity.skill_identity,
    reconciliation_digest: current.identity.reconciliation_digest,
  };
  const gateHash = specGateArtifactHash({ statePath });
  const receiptCovering = (sections) => schemaReceipt({
    intent_identity: identity,
    sections,
    hash: gateHash,
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
  // snapshot's own coverage verifies under the alternate snapshot. Its artifact
  // bindings (anchor + plan) are computed from the bundle's own bytes — goals.md's
  // `topic:` anchor and plan.md — so the matching receipt echoes exactly those.
  fs.writeFileSync(path.join(path.dirname(statePath), 'plan.md'), '# plan\nthe fixture plan artifact\n');
  const alignmentEvidence = {
    anchor_hash: anchorArtifactHash({ statePath }),
    plan_hash: planArtifactHash({ statePath }),
  };
  const altOk = verifyCheckpointEvidence({ checkpoint: 'alignment_audit', current, receipt: schemaReceipt({ intent_identity: identity, sections: altCov, ...alignmentEvidence }), checkedSections: alternate });
  assert.equal(altOk.ok, true, JSON.stringify(altOk));
  // and the standard coverage does not satisfy it.
  expectStatus(verifyCheckpointEvidence({ checkpoint: 'alignment_audit', current, receipt: schemaReceipt({ intent_identity: identity, sections: full, ...alignmentEvidence }), checkedSections: alternate }), 'mismatched');
  // No section evidence at all: missing.
  expectStatus(verifyCheckpointEvidence({ checkpoint: 'alignment_audit', current, receipt: schemaReceipt({ intent_identity: identity, ...alignmentEvidence }), checkedSections: standard }), 'missing');
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
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
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
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
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
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
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
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
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
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
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
    callReview: async (brief) => echoingApprove(brief, { reviewer_identity: { dispatch_id: '', model: 'm', output_tokens: 4 } }),
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
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
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
      callReview: async (brief) => echoingApprove(brief),
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
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
  });
  assert.equal(calls, 0, 'a pre-binding legacy event satisfies re-entry');
  assert.equal(items[0].review.verdict, 'approve');
  // A NEW review on the legacy bundle records the LEGACY tuple (goals_hash only)...
  const fresh = await reviewCompletedTasks({
    statePath, runId: 'legacy-run', wave: 1, baseSha: 'base', now: 1000,
    items: [{ task_id: 2, digest: { task_id: 2, status: 'done' }, review_input: reviewInput('b'.repeat(64)) }],
    callReview: async (brief) => echoingApprove(brief),
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
    callReview: async (brief) => { reCalls += 1; return echoingApprove(brief); },
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
  // The goals hash under the durable pin, read fresh at call time: capture-schema (which
  // walkToFinalCheck performs AFTER this fixture is built) repairs the pin, and the
  // implementation check must key on whatever the CURRENT pin canonicalizes.
  const fxGoalsHash = () => {
    let pin = resolveFormatPin(statePath);
    if (!pin.pin && pin.repairable) { try { repairFormatPin(statePath); } catch {} pin = resolveFormatPin(statePath); }
    const pinName = pin.pin ?? 'legacy';
    return goalsHash(fs.readFileSync(path.join(bundleDir, 'goals.md'), 'utf8'), { formatPin: pinName });
  };
  const recordImplementationCheck = () => appendEvent(statePath, {
    type: 'goal_check', ts: '2026-01-01T00:00:01Z',
    data: {
      goals_hash: fxGoalsHash(), head_sha: headAtBuild, base: 'main',
      diff_hash: 'sha256:diff', verify_output_hash: 'sha256:vo', provenance_kind: 'assessor',
      verdicts: { G1: { verdict: 'achieved' }, G2: { verdict: 'achieved' }, G3: { verdict: 'achieved' } },
    },
  });
  return { tmp, MAIN, WT, bundleDir, statePath, step, gHash, headAtBuild, recordImplementationCheck,
    // The goals hash under the CURRENT durable pin (§6.1) — re-derived at call time so a
    // fixture that captured its schema after construction (walkToFinalCheck) records its
    // implementation check under the hash the goal gate actually keys on.
    fxGoalsHash };
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

test('the alignment-audit checkpoint binds anchor_hash + plan_hash beside the identity tuple — computed at the checkpoint, never caller-asserted', () => {
  const { statePath } = mkBundle();
  // The bundle's own audit artifacts: the anchor is goals.md's `topic:` seed (the
  // verbatim ask), the plan is the exact bytes the audit judged.
  fs.writeFileSync(path.join(path.dirname(statePath), 'plan.md'), '# plan\nthe fixture plan artifact\n');
  const current = schemaBackedCurrent(statePath);
  const full = {};
  for (const s of checkedSectionsOf(SCHEMA)) full[s] = 'covered';
  const receipt = {
    anchor_hash: anchorArtifactHash({ statePath }),
    plan_hash: planArtifactHash({ statePath }),
    intent_identity: current.identity,
    reviewer_identity: VALID_REVIEWER,
    sections: full,
  };
  const ok = verifyCheckpointEvidence({ checkpoint: 'alignment_audit', receipt, current, checkedSections: checkedSectionsOf(SCHEMA) });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  // The reviewer's reproduction (F4): an IDENTITY-ONLY receipt — the tuple and
  // reviewer provenance present, no anchor_hash, no plan_hash, no coverage — is
  // PARTIAL on a schema-backed bundle, never ok.
  const identityOnly = verifyCheckpointEvidence({
    checkpoint: 'alignment_audit',
    receipt: { intent_identity: current.identity, reviewer_identity: VALID_REVIEWER },
    current,
    checkedSections: checkedSectionsOf(SCHEMA),
  });
  assert.equal(identityOnly.ok, false, 'an identity-only receipt never passes the alignment checkpoint');
  assert.equal(identityOnly.status, 'missing', JSON.stringify(identityOnly));
  // And even WITH coverage, a missing artifact binding is partial...
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'alignment_audit',
    receipt: { ...receipt, anchor_hash: undefined },
    current,
    checkedSections: checkedSectionsOf(SCHEMA),
  }), 'partial');
  // ...a WRONG anchor_hash is stale (the artifact the receipt names is not the
  // artifact the checkpoint reads)...
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'alignment_audit',
    receipt: { ...receipt, anchor_hash: `sha256:${'f'.repeat(64)}` },
    current,
    checkedSections: checkedSectionsOf(SCHEMA),
  }), 'stale');
  // ...and an edit to the plan under the audit re-arms the binding: the SAME receipt
  // is stale against the CURRENT plan bytes without any caller asserting anything.
  fs.writeFileSync(path.join(path.dirname(statePath), 'plan.md'), '# plan\nedited after the audit\n');
  expectStatus(verifyCheckpointEvidence({
    checkpoint: 'alignment_audit',
    receipt,
    current,
    checkedSections: checkedSectionsOf(SCHEMA),
  }), 'stale');
  fs.writeFileSync(path.join(path.dirname(statePath), 'plan.md'), '# plan\nthe fixture plan artifact\n');
  // The anchor binding is the verbatim ask itself: an amendment that rewords the
  // topic anchor moves it even when the goal list is untouched.
  const anchorBefore = anchorArtifactHash({ statePath });
  fs.writeFileSync(path.join(path.dirname(statePath), 'goals.md'),
    fs.readFileSync(path.join(path.dirname(statePath), 'goals.md'), 'utf8').replace('Versioned checkpoint fixture.', 'A reworded anchor.'));
  assert.notEqual(anchorArtifactHash({ statePath }), anchorBefore, 'an anchor edit moves the artifact binding');
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
// ---------------------------------------------------------------------------
// The WAVE-14 review-fix regressions (four reproduced findings, task 56)
// ---------------------------------------------------------------------------

// F1 [rework]: a reviewer returning a foreign/absent identity echo on a schema-backed
// bundle is REFUSED at the checkpoint — the projection's relabeling is not the
// reviewer's voice, and the orchestrator's own tuple is never stamped over a foreign
// one to make the review count.
test('F1 regression: a fresh review with a FOREIGN or ABSENT identity echo is refused, never recorded as satisfying', async () => {
  const { dir, statePath } = mkBundle();
  const current = buildIntentIdentity({ statePath });
  assert.equal(current.family, 'schema_backed');
  const foreignEcho = async (brief) => echoingApprove(brief, {
    intent_identity: {
      // The reviewer's reproduction: a foreign LEGACY tuple on a schema-backed bundle.
      legacy: true,
      goals_hash: `sha256:${'0'.repeat(64)}`,
    },
  });
  const run = async (callReview) => reviewCompletedTasks({
    statePath, runId: 'w14-run', wave: 1, baseSha: 'base', now: 1000,
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview,
  });
  // ABSENT echo: the record carries no intent_identity at all.
  const absent = await run(async (brief) => approveRecord());
  assert.equal(absent[0].review.verdict, 'approve');
  assert.equal(absent[0].review.reviewer_unavailable, true, 'an absent echo never counts as satisfying');
  assert.equal(taskReviewBlocksWave(absent[0].review), true, 'the wave is not cleared');
  const [absentEv] = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review_skipped');
  assert.ok(absentEv, 'the refusal is recorded as a non-satisfying (skipped) event');
  assert.match(absentEv.data.review.summary, /echo/);
  // FOREIGN echo: a LEGACY tuple on a schema-backed bundle.
  const foreign = await run(foreignEcho);
  assert.equal(foreign[0].review.reviewer_unavailable, true, 'a foreign echo never counts as satisfying');
  const skipped = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review_skipped');
  assert.equal(skipped.length, 2, 'both refusals landed as skipped events');
  // And NEITHER skipped event satisfies re-entry: the next attempt re-reviews.
  let calls = 0;
  const reentered = await run(async (brief) => { calls += 1; return echoingApprove(brief); });
  assert.equal(calls, 1, 'the refused reviews never satisfy re-entry');
  assert.equal(reentered[0].review.verdict, 'approve');
  assert.equal(reentered[0].review.reviewer_unavailable, undefined);
  // The satisfying event carries the reviewer's OWN echo (which matches the CURRENT
  // tuple — the only echo that can count), not a projection.
  const [done] = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review' && e.data.task === 1);
  assert.deepEqual(done.data.intent_identity, {
    goals_hash: current.identity.goals_hash,
    schema_snapshot_digest: current.identity.schema_snapshot_digest,
    skill_identity: current.identity.skill_identity,
    reconciliation_digest: current.identity.reconciliation_digest,
  });
});

// F2 [rework]: re-entry validates the prior event's reviewer PROVENANCE before it
// satisfies — a recorded review whose reviewer_identity was stripped is
// reviewer_unavailable and the review is re-run, exactly like the fresh path.
test('F2 regression: a recorded review with its reviewer_identity STRIPPED never satisfies re-entry', async () => {
  const { dir, statePath } = mkBundle();
  let calls = 0;
  const run = () => reviewCompletedTasks({
    statePath, runId: 'w14-run', wave: 1, baseSha: 'base', now: Date.now(),
    items: [{ task_id: 1, digest: { task_id: 1, status: 'done' }, review_input: reviewInput() }],
    callReview: async (brief) => { calls += 1; return echoingApprove(brief); },
  });
  await run();
  assert.equal(calls, 1);
  // The reviewer's reproduction: record a review, then strip ONLY the
  // reviewer_identity from the recorded event (a torn/edited ledger entry whose tuple
  // still matches). The identity check alone would pass — the provenance check must
  // not.
  const eventsPath = path.join(dir, 'events.jsonl');
  const lines = fs.readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const rewritten = lines.map((l) => {
    const rec = JSON.parse(l);
    if (rec.type !== 'task_adversary_review') return l;
    const stripped = structuredClone(rec);
    delete stripped.data.review.reviewer_identity;
    return JSON.stringify(stripped);
  });
  fs.writeFileSync(eventsPath, `${rewritten.join('\n')}\n`);
  // Re-entry: the provenance-stripped review is REVIEWER_UNAVAILABLE and never
  // satisfies — a fresh review is owed and run.
  const items = await run();
  assert.equal(calls, 2, 'the provenance-stripped receipt never satisfies re-entry');
  assert.equal(items[0].review.verdict, 'approve');
  assert.equal(items[0].review.reviewer_unavailable, undefined);
  const events = readEventsOf(dir).filter((e) => e.type === 'task_adversary_review');
  assert.equal(events.length, 2, 'a real review landed beside the stripped one');
});

// F3 [rework]: the finish identity binding is wired into the PRODUCTION finish
// consumers — final receipt RECORDING (record-goal-check --final refuses a
// foreign/missing intent_identity at record time), replay SELECTION (finalReceiptFor
// re-validates the recorded binding), and the confirmation gate (intent_confirm opens
// only over a receipt whose tuple matches the current finish identity). The reviewer's
// reproduction — a foreign LEGACY receipt on a captured bundle reaching intent_confirm —
// must now fail closed.
test('F3 regression: a foreign-LEGACY final receipt fails closed at every finish consumer', () => {
  const fx = mkFinishFixture({ goalsMd: versionedGoalsMd() });
  const { op } = walkToFinalCheck(fx, { capture: true });
  const current = finishCheckpointEvidence({
    statePath: fx.statePath,
    deployBaseSha: op.deploy_base_sha,
    chain: op.deploy_chain,
    liveDigest: op.live_digest,
  });
  assert.equal(current.family, 'schema_backed');
  // The reviewer's reproduction: an otherwise-accepted final receipt whose
  // intent_identity is a FOREIGN LEGACY tuple.
  const receipt = {
    final: true,
    goals_hash: fx.gHash,
    head_sha: fx.headAtBuild,
    base_diff_hash: 'sha256:diff',
    verify_output_hash: 'sha256:vo',
    clean: true,
    deploy_base_sha: op.deploy_base_sha,
    deploy_chain_hash: op.deploy_chain_hash,
    live_check_digest: op.live_digest,
    provenance_kind: 'assessor',
    dispatch_id: 'disp-final-1', model: 'assessor', output_tokens: 256,
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'e' },
      G2: { verdict: 'achieved', evidence: 'e' },
      G3: { verdict: 'achieved', evidence: 'e' },
    },
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    ts: '2026-01-01T00:00:08Z',
    intent_identity: { legacy: true, goals_hash: fx.gHash }, // the FOREIGN tuple
  };
  // The RECORDED event shape (what the ledger append bypassing the recorder writes):
  // provenance rides under `provenance`, exactly as record-goal-check persists it.
  const recordedForeign = {
    ...receipt,
    provenance: { dispatch_id: receipt.dispatch_id, model: receipt.model, output_tokens: receipt.output_tokens },
    dispatch_id: undefined,
  };
  // CONSUMER 1 — record time: `mp record-goal-check --final` refuses the receipt
  // before it reaches the ledger.
  const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
  const runCli = (args) => {
    try {
      return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
  const refused = (() => {
    const receiptFile = path.join(fx.tmp, 'foreign-receipt.json');
    fs.writeFileSync(receiptFile, JSON.stringify(receipt));
    try {
      return { status: 0, stdout: execFileSync('node', [BIN,
        'record-goal-check', `--state=${fx.statePath}`, `--head-sha=${fx.headAtBuild}`, '--base=main',
        '--diff-hash=sha256:diff', '--verify-output-hash=sha256:vo', '--final',
        `--base-sha=${op.deploy_base_sha}`, `--deploy-chain-hash=${op.deploy_chain_hash}`,
        `--digest-file=${path.join(fx.tmp, 'live-digest.txt')}`,
        `--receipt=${receiptFile}`,
      ], { encoding: 'utf8' }) };
    } catch (e) {
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  })();
  assert.notEqual(refused.status, 0, 'the recorder must refuse a foreign identity at record time');
  assert.match(`${refused.stderr}${refused.stdout}`, /finish checkpoint/);
  assert.equal(
    readEventsOf(fx.bundleDir).some((e) => e.type === 'goal_check' && e.data?.final === true),
    false,
    'the refused receipt never reached the ledger',
  );
  // CONSUMERS 2 + 3 — replay selection and the confirmation gate: with the receipt
  // appended straight into the ledger (bypassing the recorder — the mutation the
  // reviewer performed), the machine must fail closed at final_check_invalid, never
  // open intent_confirm over it.
  appendEvent(fx.statePath, { type: 'goal_check', ts: '2026-01-01T00:00:09Z', data: { ...recordedForeign } });
  const gate = fx.step();
  assert.equal(gate.gate, 'final_check_invalid', `the foreign receipt must not reach intent_confirm: ${JSON.stringify(gate).slice(0, 200)}`);
  assert.match(gate.error, /finish checkpoint identity/);
  assert.match(gate.error, /missing|stale|mismatched|partial|unreadable/);
  // And the matching-tuple receipt DOES open intent_confirm through the same path —
  // the binding refuses the foreign one, not the gate itself.
  const fx2 = mkFinishFixture({ goalsMd: versionedGoalsMd() });
  const op2 = walkToFinalCheck(fx2, { capture: true });
  const okReceipt = {
    final: true,
    goals_hash: fx2.gHash,
    head_sha: fx2.headAtBuild,
    base_diff_hash: 'sha256:diff',
    verify_output_hash: 'sha256:vo',
    clean: true,
    deploy_base_sha: op2.op.deploy_base_sha,
    deploy_chain_hash: op2.op.deploy_chain_hash,
    live_check_digest: op2.op.live_digest,
    provenance_kind: 'assessor',
    provenance: { dispatch_id: 'disp-final-1', model: 'assessor', output_tokens: 256 },
    verdicts: {
      G1: { verdict: 'achieved', evidence: 'e' },
      G2: { verdict: 'achieved', evidence: 'e' },
      G3: { verdict: 'achieved', evidence: 'e' },
    },
    intent_verdict: { verdict: 'met', evidence: 'the deployed surface answers as intended' },
    ts: '2026-01-01T00:00:08Z',
    // The CURRENT finish identity — the echo the recorder itself would have written.
    intent_identity: finishCheckpointEvidence({
      statePath: fx2.statePath,
      deployBaseSha: op2.op.deploy_base_sha,
      chain: op2.op.deploy_chain,
      liveDigest: op2.op.live_digest,
    }).intent_identity,
  };
  appendEvent(fx2.statePath, { type: 'goal_check', ts: '2026-01-01T00:00:09Z', data: { ...okReceipt } });
  const gate2 = fx2.step();
  if (gate2.gate !== 'intent_confirm') {
  }
  assert.equal(gate2.gate, 'intent_confirm', `the matching receipt opens the confirmation gate: ${JSON.stringify(gate2).slice(0, 200)}`);
});

// F4 [rework], real-path half: the schema-backed SPEC gate's own verbs bind the
// checkpoint — `record-gate-review` refuses an identity-only receipt at record time
// (coverage + the artifact binding are the checkpoint's own derivations), and the
// recorded event carries the binding so `set-phase` (the guard) re-verifies it.
test('F4 regression: the spec gate verbs demand coverage + artifact binding on a schema-backed bundle', () => {
  const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
  const run = (args) => {
    try {
      return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8' }) };
    } catch (e) {
      return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  };
  const fx = mkFinishFixture({ goalsMd: versionedGoalsMd(), seedSpecGate: false });
  // Capture the schema on the fixture bundle: the spec gate is now schema-backed.
  const skillRoot = path.join(fx.tmp, 'skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify(SCHEMA, null, 2)}\n`);
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify({
    manifest_version: 1, skill: 'fixture-intent', host_contract_version: 1, schema_format_version: 1,
    identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] },
  }, null, 2)}\n`);
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  captureSchema({ statePath: fx.statePath, skillRoot });
  mkRecordedReconciliation(fx.statePath);
  // The capture repairs the durable pin to schema_backed, and the goals gates hash
  // under it (§6.1) — so the frozen event must carry the PINNED hash, exactly as
  // goals-load would re-freeze on a captured bundle.
  fs.writeFileSync(path.join(fx.bundleDir, 'goals.md'), versionedGoalsMd());
  const pinnedFrozenHash = goalsHash(versionedGoalsMd(), { formatPin: 'schema_backed' });
  const evText = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8');
  const reFrozen = evText.split('\n').filter(Boolean).map((l) => {
    const rec = JSON.parse(l);
    if (rec.type === 'goals_frozen') rec.data.goals_hash = pinnedFrozenHash;
    return JSON.stringify(rec);
  });
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), `${reFrozen.join('\n')}\n`);

  // The reviewer's F4 reproduction, at the real verb: an IDENTITY-ONLY receipt —
  // the receipt validates against the gate's own hash/artifacts/provenance, but
  // carries no per-section coverage. The record verb must refuse it.
  const hashInfo = JSON.parse(run(['gate-hash', `--state=${fx.statePath}`, '--gate=spec']).stdout);
  const identityOnlyReceipt = {
    status: 'done', gate: 'spec', hash: hashInfo.hash, artifacts: hashInfo.artifacts,
    dispatch_id: 'disp-gate-1', provider: 'openai', model: 'gpt-x', output_tokens: 512,
    ts: '2026-09-06T00:00:00Z', digest: 'reviewed the artifacts',
  };
  const refused = run(['record-gate-review', `--state=${fx.statePath}`, '--gate=spec',
    '--status=done', `--receipt=${JSON.stringify(identityOnlyReceipt)}`]);
  assert.notEqual(refused.status, 0, 'an identity-only receipt is refused at the spec gate record verb');
  assert.match(`${refused.stderr}${refused.stdout}`, /spec-review checkpoint/);

  // The MATCHING receipt — coverage over the frozen snapshot's checked set, the
  // identity tuple, and the artifact binding the verb itself derives — records.
  const identity = buildIntentIdentity({ statePath: fx.statePath });
  assert.equal(identity.family, 'schema_backed');
  const sections = {};
  for (const s of requiredCoverageSections(fx.statePath)) sections[s] = 'serves';
  const goodReceipt = {
    ...identityOnlyReceipt,
    intent_identity: identity.identity,
    sections,
  };
  const recorded = run(['record-gate-review', `--state=${fx.statePath}`, '--gate=spec',
    '--status=done', `--receipt=${JSON.stringify(goodReceipt)}`]);
  assert.equal(recorded.status, 0, `${recorded.stderr}${recorded.stdout}`);
  const [ev] = readEventsOf(fx.bundleDir).filter((e) => e.type === 'spec_adversary_review');
  assert.ok(ev, 'the record verb wrote the spec review event');
  assert.deepEqual(ev.data.intent_identity, identity.identity, 'the recorded event carries the identity binding');
  // And the transition the guard owns now passes with the bound event on disk.
  const advanced = run(['set-phase', `--state=${fx.statePath}`, '--phase=plan']);
  assert.equal(advanced.status, 0, `the bound spec review satisfies the gate: ${advanced.stderr}${advanced.stdout}`);

  // The guard's re-verification across an identity boundary: a hand-amended
  // goals.md moves the tuple AND the artifact hash, and a review recorded at the
  // NEW artifact hash but still carrying the OLD identity binding (the replay shape
  // this re-check exists for) is refused by the record verb at the checkpoint — and,
  // hand-appended to the ledger, refused by the GUARD at the transition, never allowed
  // through on the artifact hash alone.
  const goalsPath = path.join(fx.bundleDir, 'goals.md');
  fs.writeFileSync(goalsPath, fs.readFileSync(goalsPath, 'utf8').replace('## G1: Works', '## G1: Works differently'));
  const amendedHashInfo = JSON.parse(run(['gate-hash', `--state=${fx.statePath}`, '--gate=spec']).stdout);
  // Keep the goals-capture gate satisfied at the amended bytes (the spec gate is the
  // surface under test; the goals gate re-hash follows the same durable pin seam).
  const amendedGoalsHash = goalsHash(fs.readFileSync(goalsPath, 'utf8'), { formatPin: 'schema_backed' });
  const eventsText = fs.readFileSync(path.join(fx.bundleDir, 'events.jsonl'), 'utf8');
  const rewritten = eventsText.split('\n').filter(Boolean).map((l) => {
    const rec = JSON.parse(l);
    if (rec.type === 'goals_frozen') rec.data.goals_hash = amendedGoalsHash;
    return JSON.stringify(rec);
  });
  fs.writeFileSync(path.join(fx.bundleDir, 'events.jsonl'), `${rewritten.join('\n')}\n`);
  // A receipt at the NEW artifact hash (so the gate's own artifact check passes)
  // whose identity binding is the OLD tuple — the record verb refuses it.
  const staleTupleReceipt = {
    ...goodReceipt,
    hash: amendedHashInfo.hash,
    artifacts: amendedHashInfo.artifacts,
  };
  const staleRecorded = run(['record-gate-review', `--state=${fx.statePath}`, '--gate=spec',
    '--status=done', `--receipt=${JSON.stringify(staleTupleReceipt)}`]);
  assert.notEqual(staleRecorded.status, 0, 'the record verb refuses the stale tuple at the checkpoint');
  assert.match(`${staleRecorded.stderr}${staleRecorded.stdout}`, /spec-review checkpoint/);
  // And even hand-appended to the ledger (bypassing the record verb), the GUARD at
  // the transition refuses it: identity evidence cannot cross the boundary.
  appendEvent(fx.statePath, {
    type: 'spec_adversary_review', ts: '2026-09-06T00:00:01Z',
    data: {
      hash: amendedHashInfo.hash,
      count: 0,
      receipt: {
        dispatch_id: 'disp-gate-1', provider: 'openai', model: 'gpt-x',
        output_tokens: 512, ts: '2026-09-06T00:00:00Z',
      },
      base: 'main',
      // The OLD identity binding — recorded at the NEW artifact hash.
      intent_identity: identity.identity,
      sections,
    },
    summary: 'spec adversary review complete',
  });
  const reArmed = run(['set-phase', `--state=${fx.statePath}`, '--phase=plan']);
  assert.equal(reArmed.status, 3, 'the guard re-arms on a foreign identity even at a matching artifact hash');
  assert.match(`${reArmed.stdout}${reArmed.stderr}`, /no longer verifies against the current intent identity/);
});
