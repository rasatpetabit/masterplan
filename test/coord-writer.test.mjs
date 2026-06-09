// test/coord-writer.test.mjs — coord-writer bin glue (G1/G2/G3).
//
// Covers:
//   A1 — set-coord: field pins, base_sha_by_wave merge, --mark-published dedup, missing-wave error
//   A2 — update-issue-map: create + shallow-merge + numeric coercion + missing-flag error
//   A3 — load-plan plan_hash parity: stamps when absent + plan.md present; idempotent; skips when plan.md absent
//   A4 — coord-status flag exit codes: --fail-if-unconfigured + --fail-if-unpublishable
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeState, parseState } from '../lib/bundle.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function tmpBundle(stateObj) {
  const p = path.join(tmpDir('mp-coord-'), 'state.yml');
  fs.writeFileSync(p, serializeState(stateObj));
  return p;
}
const read = (p) => parseState(fs.readFileSync(p, 'utf8'));
const v8 = (over = {}) => ({
  schema_version: '6.0', slug: 'demo', pending_gate: null, active_run: null,
  phase: 'execute',
  tasks: [
    { id: 1, status: 'pending', wave: 0, files: ['a.txt'] },
    { id: 2, status: 'pending', wave: 1, files: ['b.txt'] },
  ],
  ...over,
});

// ===========================================================================
// A1 — set-coord
// ===========================================================================

test('set-coord: sets scalar fields (contract-ref, integration-branch, local-run-branch, mode)', () => {
  const p = tmpBundle(v8());
  const r = run([
    'set-coord', `--state=${p}`,
    '--contract-ref=mp-coord/demo/abc123',
    '--integration-branch=mp-int/demo',
    '--local-run-branch=mp-lead/demo',
    '--mode=github',
  ]);
  assert.equal(r.status, 0);
  const { coordination } = JSON.parse(r.stdout);
  assert.equal(coordination.contract_ref, 'mp-coord/demo/abc123');
  assert.equal(coordination.integration_branch, 'mp-int/demo');
  assert.equal(coordination.local_run_branch, 'mp-lead/demo');
  assert.equal(coordination.mode, 'github');

  // persisted to disk
  const s = read(p);
  assert.equal(s.coordination.contract_ref, 'mp-coord/demo/abc123');
  assert.equal(s.coordination.integration_branch, 'mp-int/demo');
});

test('set-coord: base_sha_by_wave merges per-wave (does not overwrite other waves)', () => {
  // Pre-seed state with wave 0 already recorded
  const p = tmpBundle(v8({
    coordination: { base_sha_by_wave: { 0: 'sha-wave0' }, published_waves: [0] },
  }));
  const r = run(['set-coord', `--state=${p}`, '--wave=1', '--base-sha=sha-wave1']);
  assert.equal(r.status, 0);
  const { coordination } = JSON.parse(r.stdout);
  // Both waves preserved
  assert.equal(coordination.base_sha_by_wave['0'], 'sha-wave0');
  assert.equal(coordination.base_sha_by_wave['1'], 'sha-wave1');
});

test('set-coord: --mark-published deduplicates (idempotent re-publish of same wave)', () => {
  // Already has wave 0 published
  const p = tmpBundle(v8({
    coordination: { published_waves: [0] },
  }));
  // Re-publish wave 0 — should stay [0], not [0, 0]
  const r1 = run(['set-coord', `--state=${p}`, '--wave=0', '--mark-published']);
  assert.equal(r1.status, 0);
  assert.deepEqual(JSON.parse(r1.stdout).coordination.published_waves, [0]);

  // Publish wave 1 — should add it
  const r2 = run(['set-coord', `--state=${p}`, '--wave=1', '--mark-published']);
  assert.equal(r2.status, 0);
  const waves = JSON.parse(r2.stdout).coordination.published_waves;
  assert.ok(waves.includes(0));
  assert.ok(waves.includes(1));
  assert.equal(waves.length, 2);
});

test('set-coord: --base-sha without --wave exits non-zero', () => {
  const p = tmpBundle(v8());
  const r = run(['set-coord', `--state=${p}`, '--base-sha=sha-abc']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--wave/);
});

test('set-coord: --mark-published without --wave exits non-zero', () => {
  const p = tmpBundle(v8());
  const r = run(['set-coord', `--state=${p}`, '--mark-published']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--wave/);
});

test('set-coord: merges onto existing coordination (does not wipe unmentioned fields)', () => {
  const p = tmpBundle(v8({
    coordination: {
      mode: 'github',
      contract_ref: 'mp-coord/demo/xyz',
      integration_branch: 'mp-int/demo',
    },
  }));
  // Only update local_run_branch — other fields must survive
  const r = run(['set-coord', `--state=${p}`, '--local-run-branch=mp-lead/demo']);
  assert.equal(r.status, 0);
  const { coordination } = JSON.parse(r.stdout);
  assert.equal(coordination.mode, 'github');
  assert.equal(coordination.contract_ref, 'mp-coord/demo/xyz');
  assert.equal(coordination.local_run_branch, 'mp-lead/demo');
});

// ===========================================================================
// A2 — update-issue-map
// ===========================================================================

test('update-issue-map: creates a new entry for a task', () => {
  const p = tmpBundle(v8());
  const r = run(['update-issue-map', `--state=${p}`, '--task-id=1', '--issue=101', '--status=open']);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.task_id, '1');
  assert.equal(out.entry.issue, 101);       // numeric coercion
  assert.equal(out.entry.status, 'open');

  const s = read(p);
  assert.equal(s.coordination.issue_map['1'].issue, 101);
  assert.equal(s.coordination.issue_map['1'].status, 'open');
});

test('update-issue-map: shallow-merges into an existing entry (does not wipe unmentioned fields)', () => {
  const p = tmpBundle(v8({
    coordination: { issue_map: { '1': { issue: 101, status: 'open', pr: null, merge_sha: null } } },
  }));
  // Add a PR number and advance status
  const r = run(['update-issue-map', `--state=${p}`, '--task-id=1', '--pr=201', '--status=pr-open']);
  assert.equal(r.status, 0);
  const entry = JSON.parse(r.stdout).entry;
  assert.equal(entry.issue, 101);       // preserved from prior state
  assert.equal(entry.pr, 201);          // new field added
  assert.equal(entry.status, 'pr-open'); // updated
  assert.equal(entry.merge_sha, null);   // preserved from prior state
});

test('update-issue-map: numeric coercion for --issue and --pr', () => {
  const p = tmpBundle(v8());
  const r = run(['update-issue-map', `--state=${p}`, '--task-id=2', '--issue=999', '--pr=888']);
  assert.equal(r.status, 0);
  const { entry } = JSON.parse(r.stdout);
  assert.equal(typeof entry.issue, 'number');
  assert.equal(typeof entry.pr, 'number');
  assert.equal(entry.issue, 999);
  assert.equal(entry.pr, 888);
});

test('update-issue-map: --wave stored on entry', () => {
  const p = tmpBundle(v8());
  const r = run(['update-issue-map', `--state=${p}`, '--task-id=1', '--wave=0', '--status=open']);
  assert.equal(r.status, 0);
  const { entry } = JSON.parse(r.stdout);
  assert.equal(entry.wave, 0);
});

test('update-issue-map: no mutating flag exits non-zero', () => {
  const p = tmpBundle(v8());
  const r = run(['update-issue-map', `--state=${p}`, '--task-id=1']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--issue|--pr|--merge-sha|--status|--wave/);
});

test('update-issue-map: missing --task-id exits non-zero', () => {
  const p = tmpBundle(v8());
  const r = run(['update-issue-map', `--state=${p}`, '--status=open']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /task-id/);
});

test('update-issue-map: invalid --status (typo) exits non-zero and writes nothing', () => {
  // Guards the publish↔follow deadlock: a misspelled status (e.g. `merge`) would otherwise
  // write a never-terminal value that blocks the next publish forever.
  const p = tmpBundle(v8());
  const r = run(['update-issue-map', `--state=${p}`, '--task-id=1', '--status=merge']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid --status/);
  assert.match(r.stderr, /merged/, 'error lists the valid vocabulary including merged');
  // No write occurred — coordination stays unset.
  assert.equal(read(p).coordination ?? null, null);
});

// ===========================================================================
// A3 — load-plan plan_hash parity
// ===========================================================================

function planIndexNoHash(dir) {
  return {
    schema_version: '6.0',
    tasks: [
      { id: 1, wave: 0, description: 'greet', files: ['src/greet.mjs'], verify_commands: ['true'], codex: null },
    ],
  };
}

test('load-plan: stamps plan_hash when absent AND plan.md is readable', () => {
  const dir = tmpDir('mp-lp-hash-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));

  const planMd = 'This is the plan.md content for hashing.';
  fs.writeFileSync(path.join(dir, 'plan.md'), planMd);

  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexNoHash(dir)));

  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0);

  // The index file should now have plan_hash stamped
  const stamped = JSON.parse(fs.readFileSync(planIdx, 'utf8'));
  assert.ok(stamped.plan_hash, 'plan_hash should be stamped');
  assert.match(stamped.plan_hash, /^sha256:[0-9a-f]{64}$/);
  assert.ok(stamped.generated_at, 'generated_at should be stamped');
});

test('load-plan: idempotent — does not re-stamp when plan_hash already present', () => {
  const dir = tmpDir('mp-lp-idem-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));

  const planMd = 'Some plan content.';
  fs.writeFileSync(path.join(dir, 'plan.md'), planMd);

  const existingHash = 'sha256:' + 'a'.repeat(64);
  const indexWithHash = { ...planIndexNoHash(dir), plan_hash: existingHash, generated_at: '2024-01-01T00:00:00Z' };
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(indexWithHash));

  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0);

  // plan_hash should remain unchanged
  const after = JSON.parse(fs.readFileSync(planIdx, 'utf8'));
  assert.equal(after.plan_hash, existingHash, 'existing plan_hash must not be overwritten');
  assert.equal(after.generated_at, '2024-01-01T00:00:00Z');
});

test('load-plan: gracefully skips stamping when plan.md is absent (no die)', () => {
  const dir = tmpDir('mp-lp-nomd-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));

  // No plan.md in the dir
  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexNoHash(dir)));

  // Should succeed despite no plan.md
  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`]);
  assert.equal(r.status, 0);

  // plan_hash remains absent
  const after = JSON.parse(fs.readFileSync(planIdx, 'utf8'));
  assert.ok(!after.plan_hash, 'plan_hash should remain absent when plan.md is not readable');
});

test('load-plan: --plan-md flag overrides the default plan.md sibling path', () => {
  const dir = tmpDir('mp-lp-planmd-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8({ phase: 'plan', tasks: [] })));

  // Write plan.md at a custom location
  const customPlanMd = path.join(dir, 'custom-plan.md');
  fs.writeFileSync(customPlanMd, 'Custom plan content here.');

  const planIdx = path.join(dir, 'plan.index.json');
  fs.writeFileSync(planIdx, JSON.stringify(planIndexNoHash(dir)));

  const r = run(['load-plan', `--state=${p}`, `--plan-index=${planIdx}`, `--plan-md=${customPlanMd}`]);
  assert.equal(r.status, 0);

  const stamped = JSON.parse(fs.readFileSync(planIdx, 'utf8'));
  assert.ok(stamped.plan_hash, 'plan_hash should be stamped from custom path');
  assert.match(stamped.plan_hash, /^sha256:[0-9a-f]{64}$/);
});

// ===========================================================================
// A4 — coord-status flag exit codes
// ===========================================================================

test('coord-status: --fail-if-unconfigured exits 0 when fully configured', () => {
  const p = tmpBundle(v8({
    coordination: {
      mode: 'github',
      contract_ref: 'mp-coord/demo/abc',
      integration_branch: 'mp-int/demo',
    },
  }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unconfigured']);
  assert.equal(r.status, 0);
  assert.ok(JSON.parse(r.stdout).coordination.contract_ref);
});

test('coord-status: --fail-if-unconfigured exits 1 when coordination is null', () => {
  const p = tmpBundle(v8());  // no coordination
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unconfigured']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not configured/);
});

test('coord-status: --fail-if-unconfigured exits 1 when contract_ref is missing', () => {
  const p = tmpBundle(v8({
    coordination: { mode: 'github', integration_branch: 'mp-int/demo' },  // no contract_ref
  }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unconfigured']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not configured/);
});

test('coord-status: --fail-if-unconfigured exits 1 when integration_branch is missing', () => {
  const p = tmpBundle(v8({
    coordination: { mode: 'github', contract_ref: 'mp-coord/demo/abc' },  // no integration_branch
  }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unconfigured']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not configured/);
});

test('coord-status: --fail-if-unpublishable exits 0 when publishable (execute phase, tasks, last wave all closed)', () => {
  const p = tmpBundle(v8({
    phase: 'execute',
    tasks: [{ id: 1, status: 'done', wave: 0, files: ['a.txt'] }],
    coordination: {
      published_waves: [0],
      issue_map: { '1': { issue: 101, status: 'closed', wave: 0 } },
    },
  }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unpublishable']);
  assert.equal(r.status, 0);
});

test("coord-status: --fail-if-unpublishable exits 0 when last wave's entries are 'merged' (G9 write-back is terminal)", () => {
  // After follow → reconcile-integration, the G9 write-back sets issue_map entries to 'merged'
  // (NOT 'closed'). A fully-followed prior wave MUST be publishable, else the publish↔follow
  // hand-off deadlocks and wave N+1 can never be published. Regression for the closed-only bug.
  const p = tmpBundle(v8({
    phase: 'execute',
    tasks: [{ id: 1, status: 'done', wave: 0, files: ['a.txt'] }],
    coordination: {
      published_waves: [0],
      issue_map: { '1': { issue: 101, pr: 7, merge_sha: 'abc123', status: 'merged', wave: 0 } },
    },
  }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unpublishable']);
  assert.equal(r.status, 0);
});

test('coord-status: --fail-if-unpublishable exits 0 when no waves published yet', () => {
  // No published waves → no last-wave check needed
  const p = tmpBundle(v8({
    phase: 'execute',
    tasks: [{ id: 1, status: 'pending', wave: 0, files: ['a.txt'] }],
    coordination: { published_waves: [] },
  }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unpublishable']);
  assert.equal(r.status, 0);
});

// ===========================================================================
// A5 — set-coord --bootstrap (publish default-enable, §7.1)
// ===========================================================================

// Build a bundle dir with state.yml + a sibling plan.index.json.
//   planHash === NO_INDEX  → write NO index file at all (not bootstrappable).
//   planHash === null      → write an index WITHOUT plan_hash (present but unbootstrappable).
//   planHash === 'sha256:..'→ write an index carrying that plan_hash.
// (A Symbol sentinel, not `undefined`, marks "no index" — passing `undefined`
//  positionally would trigger the default-parameter hash instead.)
const NO_INDEX = Symbol('no-index');
function bootstrapBundle(stateOver = {}, planHash = 'sha256:' + 'a'.repeat(64)) {
  const dir = tmpDir('mp-boot-');
  const p = path.join(dir, 'state.yml');
  fs.writeFileSync(p, serializeState(v8(stateOver)));
  if (planHash !== NO_INDEX) {
    const idx = {
      schema_version: '6.0',
      tasks: [{ id: 1, wave: 0, description: 'x', files: ['a.txt'], verify_commands: ['true'], codex: null }],
    };
    if (planHash !== null) idx.plan_hash = planHash;
    fs.writeFileSync(path.join(dir, 'plan.index.json'), JSON.stringify(idx));
  }
  return p;
}

test('set-coord --bootstrap: derives contract_ref + integration_branch (sha256: prefix stripped → git-valid ref)', () => {
  const hex = 'b'.repeat(64);
  const p = bootstrapBundle({}, 'sha256:' + hex);
  const r = run(['set-coord', `--state=${p}`, '--bootstrap']);
  assert.equal(r.status, 0);
  const { coordination } = JSON.parse(r.stdout);
  assert.equal(coordination.contract_ref, `mp-coord/demo/${hex}`); // NO sha256: prefix
  assert.equal(coordination.integration_branch, 'mp-int/demo');
  // A git ref component cannot contain ':' — this is the whole point of refSafePlanHash.
  assert.ok(!coordination.contract_ref.includes(':'), 'contract_ref must be a valid git ref (no colon)');
  // persisted to disk
  assert.equal(read(p).coordination.contract_ref, `mp-coord/demo/${hex}`);
});

test('set-coord --bootstrap: idempotent — re-run leaves pinned refs unchanged', () => {
  const hex = 'c'.repeat(64);
  const p = bootstrapBundle({}, 'sha256:' + hex);
  run(['set-coord', `--state=${p}`, '--bootstrap']);
  const r2 = run(['set-coord', `--state=${p}`, '--bootstrap']);
  assert.equal(r2.status, 0);
  const { coordination } = JSON.parse(r2.stdout);
  assert.equal(coordination.contract_ref, `mp-coord/demo/${hex}`);
  assert.equal(coordination.integration_branch, 'mp-int/demo');
});

test('set-coord --bootstrap: does NOT clobber already-set refs (both-set no-op)', () => {
  const p = bootstrapBundle(
    { coordination: { contract_ref: 'mp-coord/demo/preexisting', integration_branch: 'mp-int/custom' } },
    'sha256:' + 'd'.repeat(64)
  );
  const r = run(['set-coord', `--state=${p}`, '--bootstrap']);
  assert.equal(r.status, 0);
  const { coordination } = JSON.parse(r.stdout);
  assert.equal(coordination.contract_ref, 'mp-coord/demo/preexisting');
  assert.equal(coordination.integration_branch, 'mp-int/custom');
});

test('set-coord --bootstrap: all-or-nothing — pins NEITHER ref when plan_hash is absent', () => {
  const p = bootstrapBundle({}, null); // index present but no plan_hash
  const r = run(['set-coord', `--state=${p}`, '--bootstrap']);
  assert.equal(r.status, 0);
  const coord = JSON.parse(r.stdout).coordination;
  assert.ok(!coord || !coord.contract_ref, 'contract_ref must be absent when plan_hash missing');
  assert.ok(!coord || !coord.integration_branch, 'integration_branch must not be partially pinned');
  // The publish early-fail gate then trips loud (the design intent):
  const g = run(['coord-status', `--state=${p}`, '--fail-if-unconfigured']);
  assert.equal(g.status, 1);
  assert.match(g.stderr, /not configured/);
});

test('set-coord --bootstrap: does NOT materialize an empty coordination object (resume-hijack regression)', () => {
  // A no-op bootstrap must leave state UNCOORDINATED. decideNextAction (resume.mjs §4) treats ANY
  // non-null coordination as a coordinated run, so an empty {} would hijack later resumes into
  // publish_needed/coordinate while coord-status --fail-if-unconfigured still fails — stranding normal
  // local dispatch behind the publish flow. Both the index-absent and the hash-absent cases must NOT write.
  for (const planHash of [NO_INDEX, null]) {
    const p = bootstrapBundle({}, planHash);
    const r = run(['set-coord', `--state=${p}`, '--bootstrap']);
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).coordination, null, 'stdout coordination must be null, not {}');
    // The decisive check: nothing materialized on disk → run stays on the uncoordinated dispatch path.
    assert.ok(!read(p).coordination, 'must NOT write an empty coordination object to state.yml');
  }
});

test('set-coord --bootstrap: no-op when plan.index.json is absent (not bootstrappable yet)', () => {
  const p = bootstrapBundle({}, NO_INDEX); // no index file at all
  const r = run(['set-coord', `--state=${p}`, '--bootstrap']);
  assert.equal(r.status, 0);
  const coord = JSON.parse(r.stdout).coordination;
  assert.ok(!coord || !coord.contract_ref, 'no contract_ref without a plan index');
});

test('set-coord --bootstrap: explicit --contract-ref wins over the derived default', () => {
  const p = bootstrapBundle({}, 'sha256:' + 'f'.repeat(64));
  const r = run(['set-coord', `--state=${p}`, '--bootstrap', '--contract-ref=mp-coord/demo/explicit']);
  assert.equal(r.status, 0);
  const { coordination } = JSON.parse(r.stdout);
  assert.equal(coordination.contract_ref, 'mp-coord/demo/explicit');
  // integration_branch still derived (caller didn't set it)
  assert.equal(coordination.integration_branch, 'mp-int/demo');
});

test('set-coord --bootstrap: end-to-end — coord-status --fail-if-unconfigured passes after bootstrap', () => {
  const p = bootstrapBundle({}, 'sha256:' + 'e'.repeat(64));
  run(['set-coord', `--state=${p}`, '--bootstrap']);
  const g = run(['coord-status', `--state=${p}`, '--fail-if-unconfigured']);
  assert.equal(g.status, 0);
});

test('coord-status: --fail-if-unpublishable exits 1 when phase is not execute', () => {
  const p = tmpBundle(v8({ phase: 'plan' }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unpublishable']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /phase/);
});

test('coord-status: --fail-if-unpublishable exits 1 when tasks is empty', () => {
  const p = tmpBundle(v8({ phase: 'execute', tasks: [] }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unpublishable']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no tasks/);
});

test('coord-status: --fail-if-unpublishable exits 1 when most-recent published wave has non-terminal entry', () => {
  const p = tmpBundle(v8({
    phase: 'execute',
    tasks: [{ id: 1, status: 'pending', wave: 0, files: ['a.txt'] }],
    coordination: {
      published_waves: [0],
      issue_map: {
        '1': { issue: 101, status: 'pr-open', wave: 0 },  // 'pr-open' is neither 'merged' nor 'closed'
      },
    },
  }));
  const r = run(['coord-status', `--state=${p}`, '--fail-if-unpublishable']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non-terminal/);
});

test('coord-status: no flags emits coordination and exits 0 (backward-compatible)', () => {
  const p = tmpBundle(v8({ coordination: { mode: 'github' } }));
  const r = run(['coord-status', `--state=${p}`]);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.coordination.mode, 'github');
});
