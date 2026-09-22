// `mp reconcile-intent` — the §6.3 CLI entry path for recording the bundle's
// reconciliation with its integration target's INTENT.md.
//
// WHY THIS FILE EXISTS. lib/reconcile-intent.mjs implemented and tested the record from
// the intent work onward, and lib/checkpoint-evidence.mjs makes it MANDATORY for a
// schema-backed bundle (buildIntentIdentity cannot earn a reconciliation_digest without
// it, so the spec gate refuses and the run cannot leave brainstorm). Nothing in bin ever
// reached the module, so the feature was unreachable from the CLI. These tests cover the
// seam that was missing — the verb, its flag contract, and the three outcomes an operator
// can hit: recorded, verified-absent, and refused-pending-a-decision.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeState, buildSeedState } from '../lib/bundle.mjs';
import { captureSchema, registerSchemaSnapshotModule } from '../lib/interview.mjs';
import { captureSchemaSnapshot, computeSkillIdentity } from '../lib/schema-snapshot.mjs';
import { RECONCILIATION_FILENAME } from '../lib/reconcile-intent.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));
const TMPDIRS = [];
test.after(() => {
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  TMPDIRS.push(d);
  return d;
}

function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
  }
}

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '--initial-branch=main');
  git(dir, 'config', 'user.email', 'test@test');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  return dir;
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

// A schema capture is what supplies the verdict VOCABULARY. Without one the verb must
// refuse loudly rather than judge against a built-in list, so the fixture mirrors the
// mkbundle style of test/intent-reconciliation.test.mjs.
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

/**
 * Build a real repo holding a bundle with a pinned schema snapshot, plus a separate
 * "target" repo whose remote is wired into the bundle repo's origin. The integration
 * target resolves THROUGH the remote, so a plain same-repo ref would not exercise it.
 */
function mkFixture({ intentMd = INTENT_MD } = {}) {
  const tmp = tmpDir('mp-recon-verb-');
  const target = initRepo(path.join(tmp, 'target'));
  if (intentMd !== null) fs.writeFileSync(path.join(target, 'INTENT.md'), intentMd);
  fs.writeFileSync(path.join(target, 'README.md'), 'fixture\n');
  commitAll(target, 'init');

  const repo = initRepo(path.join(tmp, 'consumer'));
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  commitAll(repo, 'seed');
  git(repo, 'remote', 'add', 'origin', target);

  const bundleDir = path.join(repo, 'docs', 'masterplan', 'demo');
  fs.mkdirSync(bundleDir, { recursive: true });
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, buildSeedState({ slug: 'demo', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' }));

  const skillRoot = path.join(bundleDir, 'skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# fixture design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify(SCHEMA, null, 2)}\n`);
  fs.writeFileSync(
    path.join(skillRoot, 'manifest.json'),
    `${JSON.stringify({
      manifest_version: 1,
      skill: 'fixture-intent',
      host_contract_version: 1,
      schema_format_version: 1,
      identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] },
    }, null, 2)}\n`
  );
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  captureSchema({ statePath, skillRoot });

  return { tmp, repo, target, statePath, bundleDir, reconPath: path.join(bundleDir, RECONCILIATION_FILENAME) };
}

const ALL_SERVES = 'Purpose=serves,Top invariant=serves,Non-goals=serves';

test('reconcile-intent records a valid reconciliation for a schema-backed bundle', () => {
  const f = mkFixture();
  const r = run([
    'reconcile-intent',
    `--state=${f.statePath}`,
    `--repository=${f.repo}`,
    '--remote=origin',
    '--ref=main',
    `--verdict=${ALL_SERVES}`,
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verb, 'reconcile-intent');
  assert.equal(out.file, RECONCILIATION_FILENAME);
  assert.equal(out.status, 'resolved');
  assert.match(out.identity.resolved_commit, /^[0-9a-f]{40}$/);
  assert.match(out.artifact_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(out.rows, [
    { section: 'Purpose', verdict: 'serves' },
    { section: 'Top invariant', verdict: 'serves' },
    { section: 'Non-goals', verdict: 'serves' },
  ]);
  // The durable artifact is what the spec gate reads.
  assert.ok(fs.existsSync(f.reconPath), 'the reconciliation record was written beside state.yml');
  const doc = JSON.parse(fs.readFileSync(f.reconPath, 'utf8'));
  assert.equal(doc.identity.repository, f.repo);
  assert.equal(doc.identity.ref, 'main');
  assert.equal(doc.rows.length, 3);
  assert.ok(doc.recorded_at, 'recorded_at is stamped');
});

test('reconcile-intent defaults repository to the bundle repo and ref to the current branch', () => {
  const f = mkFixture();
  const r = run(['reconcile-intent', `--state=${f.statePath}`, `--verdict=${ALL_SERVES}`]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.identity.repository, f.repo);
  assert.equal(out.identity.remote, 'origin');
  assert.equal(out.identity.ref, 'main');
});

test('a target with no INTENT.md records the explicit verified absence, not an error', () => {
  const f = mkFixture({ intentMd: null });
  const r = run([
    'reconcile-intent',
    `--state=${f.statePath}`,
    `--repository=${f.repo}`,
    '--remote=origin',
    '--ref=main',
    `--verdict=${ALL_SERVES}`,
  ]);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 'absent_source');
  // REPO_INTENT_DIGEST_ABSENT — a VERIFIED absence is recorded, never an unresolved error
  // and never a fabricated digest.
  assert.equal(out.artifact_digest, 'absent');
  assert.deepEqual(out.rows, []);
  const doc = JSON.parse(fs.readFileSync(f.reconPath, 'utf8'));
  assert.equal(doc.artifact_digest, 'absent');
});

test('a second recording of DRIFTED bytes is refused without --accepted, and accepted with it', () => {
  const f = mkFixture();
  const first = run([
    'reconcile-intent', `--state=${f.statePath}`, `--repository=${f.repo}`,
    '--remote=origin', '--ref=main', `--verdict=${ALL_SERVES}`,
  ]);
  assert.equal(first.status, 0, first.stderr);

  // Move the target's INTENT.md — same target, changed bytes: drift.
  fs.writeFileSync(path.join(f.target, 'INTENT.md'), INTENT_MD.replace('Keep work resumable.', 'Keep work resumable, always.'));
  commitAll(f.target, 'drift');

  const refused = run([
    'reconcile-intent', `--state=${f.statePath}`, `--repository=${f.repo}`,
    '--remote=origin', '--ref=main', `--verdict=${ALL_SERVES}`,
  ]);
  assert.notEqual(refused.status, 0, 'drift is refused without the operator accepting it');
  assert.match(refused.stderr, /drift/);
  assert.match(refused.stderr, /accepted/i);

  // The prior record is UNTOUCHED by the refusal — a refused write must not half-apply.
  const afterRefusal = JSON.parse(fs.readFileSync(f.reconPath, 'utf8'));
  assert.equal(afterRefusal.artifact_digest, JSON.parse(first.stdout).artifact_digest);

  const accepted = run([
    'reconcile-intent', `--state=${f.statePath}`, `--repository=${f.repo}`,
    '--remote=origin', '--ref=main', `--verdict=${ALL_SERVES}`, '--accepted',
  ]);
  assert.equal(accepted.status, 0, accepted.stderr);
  const out = JSON.parse(accepted.stdout);
  assert.equal(out.comparison.outcome, 'drift');
  assert.equal(out.comparison.prior_invalidated, true);
});

test('a section with no verdict is refused — never silently defaulted', () => {
  const f = mkFixture();
  const r = run([
    'reconcile-intent', `--state=${f.statePath}`, `--repository=${f.repo}`,
    '--remote=origin', '--ref=main', '--verdict=Purpose=serves',
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /carries no verdict/);
});

test('a verdict outside the pinned vocabulary is refused', () => {
  const f = mkFixture();
  const r = run([
    'reconcile-intent', `--state=${f.statePath}`, `--repository=${f.repo}`,
    '--remote=origin', '--ref=main',
    '--verdict=Purpose=fights,Top invariant=serves,Non-goals=serves',
  ]);
  assert.notEqual(r.status, 0);
  // 'fights' is a CHECK verdict, not a reconciliation verdict — the vocabulary is the
  // pinned snapshot's plan_level.reconciliation_verdicts, not a built-in union.
  assert.match(r.stderr, /not in the pinned schema snapshot's reconciliation_verdicts/);
});

test('a bundle with no pinned schema snapshot has no verdict vocabulary and refuses loudly', () => {
  const f = mkFixture();
  fs.rmSync(path.join(f.bundleDir, 'schema-snapshot.json'), { force: true });
  const r = run([
    'reconcile-intent', `--state=${f.statePath}`, `--repository=${f.repo}`,
    '--remote=origin', '--ref=main', `--verdict=${ALL_SERVES}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /schema snapshot/i);
});

test('an unresolvable ref is unknown/unavailable, never recorded as an absence', () => {
  const f = mkFixture();
  const r = run([
    'reconcile-intent', `--state=${f.statePath}`, `--repository=${f.repo}`,
    '--remote=origin', '--ref=no-such-ref', `--verdict=${ALL_SERVES}`,
  ]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /zero candidates/);
  assert.ok(!fs.existsSync(f.reconPath), 'a failed resolution writes no record');
});

test('--state is required', () => {
  const r = run(['reconcile-intent']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /missing required --state/);
});
