// test/interview-cli-surface.test.mjs — task 58: the §5.5 amendment operations' public surface.
//
// The two verbs the design-intent amendment adds — `mp interview capture-schema` and
// `mp interview amend-skill-identity` — with their append-time event schemas
// (`schema_captured`, `skill_identity_amended`), the §6.1 pin stamp, and the §5.5
// guard/refusal paths. The seam contract (spec §12, plan task 58/52):
//
//   - The CLI surface + event schemas + approval/replay guards are THIS task (58).
//   - The snapshot/identity MECHANICS are task 52's lib/schema-snapshot.mjs. Until that
//     module lands, the verbs must FAIL LOUDLY with the named error
//     `schema_snapshot_module_not_implemented` — never fake success.
//   - Acceptance mechanics (event shapes, replay, approval binding) are proven here at
//     the lib seam by registering a stub module with exactly the ops the seam requires
//     (SCHEMA_SNAPSHOT_MODULE_OPS); task 52's suite re-proves them through the real
//     module. CLI acceptance through the real module is therefore task 52's test, while
//     CLI REFUSALS are proven black-box here — they are the contract this surface owns.
//
// The five named §5.5 guard failures (skill_absent, skill_identity_changed,
// host_contract_unsupported, schema_unsupported, undeclared_dependency) have named
// refusal paths on this surface even before task 52 lands full enforcement: SKILL_GUARD_FAILURES
// is the closed list, and a stub raising one propagates verbatim through the verb.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

import {
  buildSeedState,
  writeState,
  appendEvent,
  validateEvent,
  FORMAT_PINS,
} from '../lib/bundle.mjs';
import {
  captureSchema,
  amendSkillIdentity,
  declareSkillIdentityAmendment,
  registerSchemaSnapshotModule,
  registeredSchemaSnapshotModule,
  replaySchemaCapture,
  SKILL_GUARD_FAILURES,
  SCHEMA_SNAPSHOT_MODULE_OPS,
} from '../lib/interview.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin/masterplan.mjs');

// Every fixture tree lands under os.tmpdir() and is removed once at teardown.
const TMPDIRS = [];
function mkbundle() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-schema-'));
  TMPDIRS.push(dir);
  const statePath = path.join(dir, 'state.yml');
  writeState(
    statePath,
    buildSeedState({ slug: 'iv', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'low' })
  );
  const skillRoot = path.join(dir, 'skill');
  fs.mkdirSync(skillRoot);
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), '{"version": 1}\n');
  return { dir, statePath, skillRoot };
}
test.after(() => {
  registerSchemaSnapshotModule(null); // never leak the stub into another suite's import
  for (const d of TMPDIRS) fs.rmSync(d, { recursive: true, force: true });
});

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// The stub standing in for task 52's module: exactly the ops SCHEMA_SNAPSHOT_MODULE_OPS
// names, deterministic over the fixture skill's bytes, and able to raise any named §5.5
// guard failure the test injects. This is the seam contract — task 52 exports these.
function stubModule({ failWith } = {}) {
  return {
    captureSchemaSnapshot({ skillRoot }) {
      if (failWith) throw new Error(`${failWith}: the installed skill is unusable`);
      const schemaBytes = fs.readFileSync(path.join(skillRoot, 'schema.json'));
      return {
        schema_sha256: sha256(schemaBytes),
        skill_identity: stubIdentity(skillRoot),
        host_contract_version: '1',
        schema_format_version: '1',
      };
    },
    computeSkillIdentity({ skillRoot }) {
      if (failWith) throw new Error(`${failWith}: the changed skill is unusable`);
      return stubIdentity(skillRoot);
    },
  };
}
function stubIdentity(skillRoot) {
  const manifestBytes = fs.readFileSync(path.join(skillRoot, 'SKILL.md'));
  return sha256(manifestBytes);
}
function register(failWith) {
  registerSchemaSnapshotModule(stubModule({ failWith }));
}

function runCli(args) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8' }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// ---- the seam: named not-implemented before task 52 lands --------------------

test('SKILL_GUARD_FAILURES is the closed §5.5 named-failure list', () => {
  assert.deepEqual(SKILL_GUARD_FAILURES, [
    'skill_absent',
    'skill_identity_changed',
    'host_contract_unsupported',
    'schema_unsupported',
    'undeclared_dependency',
  ]);
});

test('SCHEMA_SNAPSHOT_MODULE_OPS names the exact ops the seam requires', () => {
  assert.deepEqual(SCHEMA_SNAPSHOT_MODULE_OPS, ['captureSchemaSnapshot', 'computeSkillIdentity']);
});

test('registerSchemaSnapshotModule refuses a module missing the seam ops', () => {
  const before = registeredSchemaSnapshotModule();
  assert.throws(
    () => registerSchemaSnapshotModule({ captureSchemaSnapshot: () => {} }),
    /schema_snapshot_module_incomplete: expected captureSchemaSnapshot and computeSkillIdentity/
  );
  assert.equal(registeredSchemaSnapshotModule(), before);
});

test('capture-schema without task 52 fails loudly with the named error (black-box CLI)', () => {
  const { statePath, skillRoot } = mkbundle();
  const r = runCli(['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
  assert.match(
    r.stderr,
    /schema_snapshot_module_not_implemented/,
    'the named not-yet-implemented failure must surface, never fake success'
  );
  // Nothing was appended — a refusal is not a partial write.
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.captured, null);
});

test('amend-skill-identity without task 52 fails loudly with the named error (black-box CLI)', () => {
  const { statePath, skillRoot } = mkbundle();
  // The refusal ORDER is the contract: an amendment requires a prior capture regardless of
  // task 52, so seed a real capture event first (through the registered seam), then run the
  // CLI subprocess — which has NO registered seam — and expect the named module failure.
  register();
  captureSchema({ statePath, skillRoot });
  const identity = path.join(path.dirname(statePath), 'identity.json');
  fs.writeFileSync(identity, JSON.stringify({ skill_identity: 'abc123' }));
  const r = runCli(['interview', 'amend-skill-identity', `--state=${statePath}`, `--identity-file=${identity}`]);
  assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /schema_snapshot_module_not_implemented/);
});

// ---- CLI refusal matrix (black-box; every refusal must name its reason) -------

test('capture-schema: unknown flag exits 2 (A7 fail-closed)', () => {
  const { statePath } = mkbundle();
  const r = runCli(['interview', 'capture-schema', `--state=${statePath}`, '--no-such-flag']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --no-such-flag/);
});

test('capture-schema: --identity-file is the amendment flag and is refused here', () => {
  const { statePath } = mkbundle();
  const r = runCli(['interview', 'capture-schema', `--state=${statePath}`, '--identity-file=x.json']);
  // The flag IS registered (KNOWN_FLAGS), so the refusal is the verb's own, naming the misuse.
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--identity-file is the amend-skill-identity flag/);
});

test('capture-schema: missing --state is a usage error', () => {
  const r = runCli(['interview', 'capture-schema']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /missing required --state/);
});

test('amend-skill-identity: unreadable --approval fails naming the file', () => {
  const { statePath } = mkbundle();
  const r = runCli([
    'interview', 'amend-skill-identity', `--state=${statePath}`,
    '--approval=/nonexistent-approval.json',
  ]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--approval unreadable or not JSON/);
});

test('unknown interview subcommand lists the two new verbs', () => {
  const r = runCli(['interview', 'no-such-sub', '--state=x']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /capture-schema/);
  assert.match(r.stderr, /amend-skill-identity/);
});

// ---- acceptance matrix (lib seam with the registered stub) -------------------

test('captureSchema appends schema_captured and stamps the schema_backed pin', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  const ev = captureSchema({ statePath, skillRoot });
  assert.equal(ev.type, 'schema_captured');
  assert.equal(ev.format_pin, 'schema_backed');
  assert.equal(ev.schema_sha256, sha256(fs.readFileSync(path.join(skillRoot, 'schema.json'))));
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.captured.skill_identity, ev.skill_identity);
  assert.equal(ledger.recorded_skill_identity, ev.skill_identity);
  assert.equal(ledger.pending_amendment, null);
  // §6.1: the pin is carried in the event history, the repair source.
  assert.equal(ledger.captured.format_pin, 'schema_backed');
});

test('captureSchema refuses a re-capture of an unchanged skill', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  assert.throws(() => captureSchema({ statePath, skillRoot }), /unchanged/);
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.amendments.length, 0);
});

test('captureSchema surfaces the named §5.5 guard failures verbatim', () => {
  for (const failure of SKILL_GUARD_FAILURES) {
    register(failure);
    const { statePath, skillRoot } = mkbundle();
    assert.throws(
      () => captureSchema({ statePath, skillRoot }),
      (e) => e.message.startsWith(`${failure}:`),
      `${failure} must propagate verbatim through the surface`
    );
  }
});

test('captureSchema refuses on a terminal interview (§5.3 absorbing)', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  appendEvent(statePath, { type: 'interview_waived', reason: 'waived for test' });
  assert.throws(() => captureSchema({ statePath, skillRoot }), /interview is waived/);
});

test('FORMAT_PINS is exactly legacy and schema_backed', () => {
  assert.deepEqual(FORMAT_PINS, ['legacy', 'schema_backed']);
});

// ---- amendment acceptance + replay --------------------------------------------

function validApproval(identity) {
  return {
    attested_by: 'user',
    purpose: 'skill_identity_amend',
    skill_identity: identity,
    question: 'approve the replacement skill identity?',
    answer: 'approved',
    ts: '2026-01-02T00:00:00.000Z',
  };
}

test('amendSkillIdentity replaces the identity only under a binding approval', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  const captured = captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  const ev = amendSkillIdentity({
    statePath, newSkillIdentity: changedIdentity, skillRoot, approval: validApproval(changedIdentity),
  });
  assert.equal(ev.type, 'skill_identity_amended');
  assert.equal(ev.old_skill_identity, captured.skill_identity);
  assert.equal(ev.new_skill_identity, changedIdentity);
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.recorded_skill_identity, changedIdentity);
  assert.equal(ledger.pending_amendment, null);
  assert.equal(ledger.amendments.length, 1);
});

test('amendSkillIdentity: no adoption before approval — unbound identity refused', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  assert.throws(
    () => amendSkillIdentity({
      statePath, newSkillIdentity: changedIdentity, skillRoot,
      approval: validApproval('a-different-identity'),
    }),
    /no adoption before the operator's approval/
  );
  // Nothing was adopted: the recorded identity is still the captured one, and no
  // amendment event exists.
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.recorded_skill_identity, ledger.captured.skill_identity);
  assert.equal(ledger.amendments.length, 0);
});

test('amendSkillIdentity: a non-user-attested approval is refused', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  assert.throws(
    () => amendSkillIdentity({
      statePath, newSkillIdentity: changedIdentity, skillRoot,
      approval: { ...validApproval(changedIdentity), attested_by: 'agent' },
    }),
    /must be user-attested/
  );
});

test('amendSkillIdentity: no approval leaves a pending declaration, no adoption', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: changedIdentity, skillRoot }),
    /amendment_pending/
  );
  const mid = replaySchemaCapture(statePath);
  // The declaration is durable (resumable), but the identity is NOT adopted.
  assert.equal(mid.pending_amendment.new_skill_identity, changedIdentity);
  assert.equal(mid.recorded_skill_identity, mid.captured.skill_identity);
  assert.equal(mid.amendments.length, 0);
});

test('interrupted amendment replays to a consistent state without re-declaring', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  // "Interruption": the declaration landed, the approval never did.
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: changedIdentity, skillRoot }),
    /amendment_pending/
  );
  // Replay: only the approval is supplied; the declared identity is replayed from disk.
  const ev = amendSkillIdentity({ statePath, approval: validApproval(changedIdentity) });
  assert.equal(ev.type, 'skill_identity_amended');
  assert.equal(ev.new_skill_identity, changedIdentity);
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.pending_amendment, null);
  assert.equal(ledger.recorded_skill_identity, changedIdentity);
});

test('interrupted amendment refuses an approval bound to a different identity', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: changedIdentity, skillRoot }),
    /amendment_pending/
  );
  assert.throws(
    () => amendSkillIdentity({ statePath, approval: validApproval('not-the-declared-identity') }),
    /no adoption before the operator's approval/
  );
  // Still pending, still unadopted.
  const mid = replaySchemaCapture(statePath);
  assert.equal(mid.pending_amendment.new_skill_identity, changedIdentity);
  assert.equal(mid.recorded_skill_identity, mid.captured.skill_identity);
});

test('a committed amendment is exactly-once: replaying it refuses as nothing to amend', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  amendSkillIdentity({
    statePath, newSkillIdentity: changedIdentity, skillRoot, approval: validApproval(changedIdentity),
  });
  // Re-running with the same identity: the identity is now on record, so the declaration
  // refuses (an amendment replaces a CHANGE), and the replay finds no pending declaration.
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: changedIdentity, skillRoot, approval: validApproval(changedIdentity) }),
    /equals the one on record/
  );
  const ledger = replaySchemaCapture(statePath);
  assert.equal(ledger.amendments.length, 1);
});

test('the amendment records the receipts it strands (invalidated_receipts)', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  const capturedIdentity = replaySchemaCapture(statePath).recorded_skill_identity;
  // A receipt bound to the captured identity (the §5.5 tuple carrier a checkpoint will hold
  // once tasks 52/56 land; any tuple position counts).
  appendEvent(statePath, { type: 'interview_checkpoint', data: { skill_identity: capturedIdentity } });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  const ev = amendSkillIdentity({
    statePath, newSkillIdentity: changedIdentity, skillRoot, approval: validApproval(changedIdentity),
  });
  assert.equal(ev.invalidated_receipts, 1, 'the one old-identity receipt is counted as stranded');
});

test('amendment without a prior capture refuses: nothing recorded to amend', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'changed\n');
  const changedIdentity = stubIdentity(skillRoot);
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: changedIdentity, skillRoot }),
    /no schema_captured event on this bundle/
  );
});

test('amendment with no identity and no pending declaration names the two ways forward', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  assert.throws(
    () => amendSkillIdentity({ statePath }),
    /nothing to amend/
  );
});

test('a declared identity that the changed skill does not recompute to is refused', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  assert.throws(
    () => amendSkillIdentity({
      statePath, newSkillIdentity: 'an-asserted-identity', skillRoot, approval: validApproval('an-asserted-identity'),
    }),
    /does not equal the recomputed identity of the changed skill/
  );
});

// ---- the two append-time event schemas (lib/bundle.mjs) -----------------------

test('schema_captured: validateEvent accepts the capture shape and rejects each missing field', () => {
  const valid = {
    type: 'schema_captured',
    schema_sha256: 'a'.repeat(64),
    skill_identity: 'b'.repeat(64),
    host_contract_version: '1',
    schema_format_version: '1',
    format_pin: 'schema_backed',
  };
  assert.deepEqual(validateEvent(valid), []);
  for (const field of ['schema_sha256', 'skill_identity', 'host_contract_version', 'schema_format_version', 'format_pin']) {
    const bad = { ...valid };
    delete bad[field];
    assert.ok(validateEvent(bad).length > 0, `missing ${field} must fail`);
  }
  assert.ok(validateEvent({ ...valid, format_pin: 'v3-neither' }).length > 0, 'an unknown pin value must fail');
});

test('skill_identity_amended: validateEvent binds the approval to the new identity', () => {
  const valid = {
    type: 'skill_identity_amended',
    old_skill_identity: 'a'.repeat(64),
    new_skill_identity: 'b'.repeat(64),
    approval: {
      attested_by: 'user',
      purpose: 'skill_identity_amend',
      skill_identity: 'b'.repeat(64),
      question: 'approve?',
      answer: 'approved',
      ts: '2026-01-02T00:00:00.000Z',
    },
  };
  assert.deepEqual(validateEvent(valid), []);
  for (const field of ['old_skill_identity', 'new_skill_identity', 'approval']) {
    const bad = { ...valid };
    delete bad[field];
    assert.ok(validateEvent(bad).length > 0, `missing ${field} must fail`);
  }
  // no adoption before approval, at the schema layer too
  const misbound = structuredClone(valid);
  misbound.approval.skill_identity = 'c'.repeat(64);
  assert.ok(validateEvent(misbound).length > 0, 'an approval bound elsewhere must fail');
  // an amendment that replaces nothing
  const same = structuredClone(valid);
  same.old_skill_identity = same.new_skill_identity;
  assert.ok(validateEvent(same).length > 0, 'old and new identities must differ');
  // non-user attestation
  const agent = structuredClone(valid);
  agent.approval.attested_by = 'agent';
  assert.ok(validateEvent(agent).length > 0, 'attestation must be user');
});

test('appendEvent rejects a misbound skill_identity_amended record at write time', () => {
  const { statePath } = mkbundle();
  const record = {
    type: 'skill_identity_amended',
    old_skill_identity: 'a'.repeat(64),
    new_skill_identity: 'b'.repeat(64),
    approval: {
      attested_by: 'user',
      purpose: 'skill_identity_amend',
      skill_identity: 'NOT-the-new-identity',
      question: 'q',
      answer: 'a',
      ts: '2026-01-02T00:00:00.000Z',
    },
  };
  assert.throws(() => appendEvent(statePath, record), /invalid skill_identity_amended event/);
});

// ---- CLI acceptance through the registered seam (the shape task 52 re-proves with the real module) --

test('black-box CLI acceptance once the seam module is importable from bin', async (t) => {
  // The real CLI imports lib/schema-snapshot.mjs (task 52). Prove the WIRING end-to-end by
  // writing the module at its seam path for the duration of this test ONLY inside a copied
  // tree: the CLI subprocess must resolve it, register it, and record the event. This is
  // also the test task 52 inherits for free once the module exists for real.
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'iv-cli-'));
  TMPDIRS.push(tree);
  t.after(() => { fs.rmSync(tree, { recursive: true, force: true }); });

  // A minimal tree: bin + lib, plus a stub schema-snapshot at the exact seam path.
  fs.mkdirSync(path.join(tree, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'bin'), path.join(tree, 'bin'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'lib'), path.join(tree, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'lib', 'schema-snapshot.mjs'), [
    '// test stub standing in for task 52 (auto-generated by test/interview-cli-surface.test.mjs)',
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import crypto from "node:crypto";',
    'const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");',
    'export function computeSkillIdentity({ skillRoot }) {',
    '  return sha(fs.readFileSync(path.join(skillRoot, "SKILL.md")));',
    '}',
    'export function captureSchemaSnapshot({ skillRoot }) {',
    '  const schemaBytes = fs.readFileSync(path.join(skillRoot, "schema.json"));',
    '  return {',
    '    schema_sha256: sha(schemaBytes),',
    '    skill_identity: computeSkillIdentity({ skillRoot }),',
    '    host_contract_version: "1",',
    '    schema_format_version: "1",',
    '  };',
    '}',
    '',
  ].join('\n'));

  const { statePath, skillRoot } = mkbundle();
  const capture = runCliTree(tree, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(capture.status, 0, `capture failed: ${capture.stderr}`);
  const captured = JSON.parse(capture.stdout.trim().split('\n').pop());
  assert.equal(captured.ok, true);
  assert.equal(captured.interview, 'capture-schema');
  assert.equal(captured.event_type, 'schema_captured');
  assert.equal(captured.format_pin, 'schema_backed');

  // The amendment flow through the CLI: declare (interrupt) -> approval -> commit.
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const identityFile = path.join(path.dirname(statePath), 'identity.json');
  const newIdentity = sha256(fs.readFileSync(path.join(skillRoot, 'SKILL.md')));
  fs.writeFileSync(identityFile, JSON.stringify({ skill_identity: newIdentity }));
  const approvalFile = path.join(path.dirname(statePath), 'approval.json');
  fs.writeFileSync(approvalFile, JSON.stringify({
    attested_by: 'user', purpose: 'skill_identity_amend', skill_identity: newIdentity,
    question: 'approve the replacement skill identity?', answer: 'approved', ts: '2026-01-02T00:00:00.000Z',
  }));

  const amend = runCliTree(tree, [
    'interview', 'amend-skill-identity', `--state=${statePath}`, `--skill-root=${skillRoot}`,
    `--identity-file=${identityFile}`,
  ]);
  assert.equal(amend.status, 1, 'without the approval the amendment stays pending (exit 1)');
  assert.match(amend.stderr, /amendment_pending/);
  const mid = replaySchemaCapture(statePath);
  assert.equal(mid.recorded_skill_identity, mid.captured.skill_identity, 'no adoption before approval');

  const resume = runCliTree(tree, [
    'interview', 'amend-skill-identity', `--state=${statePath}`, `--approval=${approvalFile}`,
  ]);
  assert.equal(resume.status, 0, `resume failed: ${resume.stderr}`);
  const amended = JSON.parse(resume.stdout.trim().split('\n').pop());
  assert.equal(amended.event_type, 'skill_identity_amended');
  assert.equal(amended.new_skill_identity, newIdentity);
  const done = replaySchemaCapture(statePath);
  assert.equal(done.recorded_skill_identity, newIdentity);
  assert.equal(done.pending_amendment, null);
});

function runCliTree(tree, args) {
  try {
    return { status: 0, stdout: execFileSync('node', [path.join(tree, 'bin/masterplan.mjs'), ...args], { encoding: 'utf8' }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
// ---- review fix-round regressions (wave-11 adversary findings, 2026-09-06) --------

test('a changed skill identity cannot re-capture: capture records the FIRST state only', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'the skill changed\n');
  assert.throws(
    () => captureSchema({ statePath, skillRoot }),
    /replace it through mp interview amend-skill-identity/
  );
  // And the stranded-declaration deadlock cannot form: capture never adopts B, so an
  // A -> B declaration still amends cleanly afterwards.
  const changed = stubIdentity(skillRoot);
  const ev = amendSkillIdentity({ statePath, newSkillIdentity: changed, skillRoot, approval: validApproval(changed) });
  assert.equal(ev.new_skill_identity, changed);
});

test('approval-only replay with the module absent reports the named seam failure', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  assert.throws(
    () => amendSkillIdentity({ statePath, newSkillIdentity: changedIdentity, skillRoot }),
    /amendment_pending/
  );
  registerSchemaSnapshotModule(null); // the interruption window — the module is gone
  assert.throws(
    () => amendSkillIdentity({ statePath, approval: validApproval(changedIdentity) }),
    /schema_snapshot_module_not_implemented/
  );
  // Nothing was adopted:
  const mid = replaySchemaCapture(statePath);
  assert.equal(mid.recorded_skill_identity, mid.captured.skill_identity);
  assert.equal(mid.amendments.length, 0);
});

test('invalidated_receipts counts identity-bound fields, not textual mentions', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  const capturedIdentity = replaySchemaCapture(statePath).recorded_skill_identity;
  // A prose mention of the digest is NOT a receipt:
  appendEvent(statePath, {
    type: 'interview_checkpoint',
    data: { note: `the old identity was ${capturedIdentity}, quoted in prose` },
  });
  // A nested identity-bound receipt IS one (any §5.5 tuple position):
  appendEvent(statePath, {
    type: 'interview_checkpoint',
    data: { intent_identity: { skill_identity: capturedIdentity, goals_hash: 'h' } },
  });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'routine skill update\n');
  const changedIdentity = stubIdentity(skillRoot);
  const ev = amendSkillIdentity({
    statePath, newSkillIdentity: changedIdentity, skillRoot, approval: validApproval(changedIdentity),
  });
  assert.equal(ev.invalidated_receipts, 1, 'prose mention excluded, nested bound field counted');
});

test('a B->C amendment does not count the B declaration checkpoint as a stranded receipt', () => {
  register();
  const { statePath, skillRoot } = mkbundle();
  captureSchema({ statePath, skillRoot });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'first change\n');
  const b = stubIdentity(skillRoot);
  amendSkillIdentity({ statePath, newSkillIdentity: b, skillRoot, approval: validApproval(b) });
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), 'second change\n');
  const c = stubIdentity(skillRoot);
  const ev = amendSkillIdentity({ statePath, newSkillIdentity: c, skillRoot, approval: validApproval(c) });
  assert.equal(ev.invalidated_receipts, 0, 'the A->B declaration checkpoint names B, not A: not a receipt of A');
});
