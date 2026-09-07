// test/design-intent-host-contract.test.mjs — Task 49: the pinned /intent skill carries
// the masterplan host contract (spec.md §5, §5.5; docs/internals/design-intent-integration.md).
// The pin in policy/design-intent-skill.json names the exact behavior-skills revision this
// integration is verified against, so a skill edit that changes behavior — with or without a
// version bump — changes the recomputed identity and fails this suite rather than silently
// testing whatever a checkout happens to hold. Tests 52/53 implement the same identity
// computation masterplan-side (lib-side, from a bundle snapshot) and must stay byte-identical
// in algorithm to the recomputation here.
import { test as rawTest } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PIN_PATH = path.join(ROOT, 'policy', 'design-intent-skill.json');
const pin = JSON.parse(readFileSync(PIN_PATH, 'utf8'));
// HOST-LOCAL PIN EVIDENCE: the pin's repo is an absolute host path. On a machine without it
// (the CI runner), the pinned bytes cannot be read — this suite is pinned-skill host-contract
// evidence, so it SKIPS (never fails): CI is the product-surface contract, not the pin-
// provenance witness. The verification runs on the dev host and in the rehearsal.
const PINNED_REPO_AVAILABLE = existsSync(path.join(pin.repo, '.git')); // a bare dir is not a repo
const test = PINNED_REPO_AVAILABLE ? rawTest : Object.assign(
  (name, opts, fn) => rawTest.skip(name, typeof opts === 'function' ? opts : fn),
  { after: () => {}, before: () => {}, beforeEach: () => {}, afterEach: () => {} },
);

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args]);

const skillManifest = () =>
  JSON.parse(git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/manifest.json`).toString('utf8'));

// Recompute the skill identity over the closed manifest-declared file set exactly as the
// manifest's identity.canonicalization specifies: entries sorted in ascending byte order of
// the manifest-relative POSIX path; each entry contributes path + newline + the lowercase hex
// sha256 of its exact bytes + newline; the identity is the final digest. Bytes come from the
// pinned commit's tree, so a dirty worktree cannot pass as the pinned skill.
const computeSkillIdentity = (manifest) => {
  const set = manifest.identity.closed_file_set;
  assert.ok(Array.isArray(set) && set.length > 0, 'closed_file_set must be a non-empty array');
  const seen = new Set();
  const h = createHash('sha256');
  for (const rel of [...set].sort()) {
    assert.ok(!seen.has(rel), `duplicate closed_file_set entry: ${rel}`);
    seen.add(rel);
    assert.ok(!path.isAbsolute(rel) && !rel.split('/').includes('..'), `path escapes the skill root: ${rel}`);
    const bytes = git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/${rel}`);
    h.update(rel, 'utf8');
    h.update('\n', 'utf8');
    h.update(createHash('sha256').update(bytes).digest('hex'), 'utf8');
    h.update('\n', 'utf8');
  }
  return h.digest('hex');
};

test('the pin has the shape every dependent task verifies against', () => {
  assert.ok(/^[0-9a-f]{40}$/.test(pin.commit), 'commit must be a 40-hex sha');
  assert.ok(/^[0-9a-f]{64}$/.test(pin.manifest_digest), 'manifest_digest must be a 64-hex sha256');
  assert.ok(Number.isInteger(pin.host_contract_version) && pin.host_contract_version > 0);
  assert.ok(Number.isInteger(pin.schema_format_version) && pin.schema_format_version > 0);
  assert.ok(path.isAbsolute(pin.repo), 'repo must be an absolute path');
  assert.ok(!path.isAbsolute(pin.skill_path) && pin.skill_path.length > 0, 'skill_path must be repo-relative');
});

test('the pinned commit exists in the pinned repo', () => {
  assert.equal(git(pin.repo, 'cat-file', '-t', pin.commit).toString().trim(), 'commit');
});

test('the pinned skill path is clean in its repo', () => {
  const dirty = git(pin.repo, 'status', '--porcelain', '--', pin.skill_path).toString();
  assert.equal(dirty.trim(), '', `pinned skill path is dirty:\n${dirty}`);
});

test('the manifest at the pinned commit declares the pinned versions', () => {
  const m = skillManifest();
  assert.equal(m.host_contract_version, pin.host_contract_version, 'host_contract_version drift');
  assert.equal(m.schema_format_version, pin.schema_format_version, 'schema_format_version drift');
  assert.equal(m.skill, 'intent');
});

test('the pinned manifest digest recomputes over the closed file set at the pinned commit', () => {
  const m = skillManifest();
  const identity = computeSkillIdentity(m);
  assert.equal(identity, pin.manifest_digest, 'skill identity changed — repin through the recorded skill-identity amendment flow');
});

test('the manifest closes over SKILL.md, schema.json, itself, and the validator', () => {
  const set = new Set(skillManifest().identity.closed_file_set);
  for (const required of ['SKILL.md', 'schema.json', 'manifest.json', 'validate-intent.mjs']) {
    assert.ok(set.has(required), `closed_file_set must include ${required}`);
  }
  // The set must cover every file the skill consists of — no undeclared behavior-affecting asset.
  // Enumerate the PINNED COMMIT'S TREE, not the current index: the checkout may sit at any
  // revision, and only the pinned tree is the pinned skill (an index enumeration would let a
  // later revision's file list pass against the pin's manifest).
  const tracked = git(pin.repo, 'ls-tree', '-r', '--name-only', pin.commit, '--', pin.skill_path).toString().trim().split('\n').filter(Boolean);
  const trackedRel = new Set(tracked.map((f) => f.slice(pin.skill_path.length + 1)));
  for (const rel of trackedRel) {
    assert.ok(set.has(rel), `skill file ${rel} is not declared in the manifest's closed_file_set`);
  }
});

test('the pinned skill teaches the host contract and stops refusing goal blocks', () => {
  const skill = git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/SKILL.md`).toString('utf8');
  // SKILL.md is hard-wrapped prose; normalize whitespace so assertions match across line breaks.
  const flat = skill.replace(/\s+/g, ' ');
  // The masterplan host contract MOVED out of SKILL.md into verbs/plan.md: SKILL.md's
  // masterplan-host-contract section routes to it and restates nothing.
  assert.ok(flat.includes('That contract lives in `verbs/plan.md` and is not restated here'),
    'SKILL.md must route the host contract to its verbs/plan.md home');
  // Host contract, both directions (spec §5): what the host provides, what the skill returns.
  const plan = git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/verbs/plan.md`).toString('utf8');
  const flatPlan = plan.replace(/\s+/g, ' ');
  for (const expected of [
    'host_contract_version',
    'existing anchor and evidence',
    'current draft',
    'ledger status',
    'permitted recorder operations',
    'never writes `state.yml` or `events.jsonl`',
    'presents **only the intent projection** to `validate-intent.mjs`',
    // The plan-mode draft lifecycle is the HOST's — no confirm-the-restatement gate in plan
    // mode (spec §5.1 step 6: intent review lands at the spec gate).
    'Plan mode: the host owns the draft lifecycle',
  ]) {
    assert.ok(flatPlan.includes(expected), `verbs/plan.md must teach: ${expected}`);
  }
  // The refusal ground is gone (plan mode never refuses a goals.md for carrying goal blocks).
  assert.ok(/A `goals\.md` carrying goal blocks is the normal, expected plan-mode input, not a refusal ground/.test(flatPlan), 'plan mode must state it never refuses a goals.md over goal blocks');
  assert.ok(!/refuses when the bundle already carries/.test(flatPlan), 'the old goal-block refusal must be gone');
  assert.ok(!/pending reconciliation/i.test(flatPlan), 'the pending-reconciliation marker must be resolved');
});

test('the public repo-mode contracts survive in the pinned skill', () => {
  // The /intent skill's public surface (create/refine/audit/judge/align) keeps the repo
  // contract: the consultation-rule check that gates an existing INTENT.md and the repo
  // validator invocation (SKILL.md § The fights judgment / § Confirm, then write).
  const skill = git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/SKILL.md`).toString('utf8');
  const flat = skill.replace(/\s+/g, ' ');
  for (const expected of [
    'node <skill-dir>/validate-intent.mjs <file> --mode repo` is the test',
    'Confirm, then write',
    'The consultation rule',
  ]) {
    assert.ok(flat.includes(expected), `the repo-mode public contract must survive: ${expected}`);
  }
});

test('the shared validator accepts an intent projection while goal blocks are host-owned input', () => {
  // The plan-mode projection the skill presents to validate-intent.mjs validates clean. The
  // host's goals.md may carry ## G<n>: blocks beside it — they never reach the validator.
  // The validator EXECUTED is the PINNED revision's: the closed file set is extracted from
  // pin.commit's tree into a temp dir and run from there, so behavioral verification can
  // never slide to whatever the working tree happens to hold.
  const pinnedSkillDir = mkdtempSync(path.join(os.tmpdir(), 'design-intent-pinned-skill-'));
  for (const rel of skillManifest().identity.closed_file_set) {
    const dest = path.join(pinnedSkillDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/${rel}`));
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'design-intent-pin-'));
  const projection = path.join(tmp, 'projection.md');
  writeFileSync(
    projection,
    `topic: |
  Build the design-intent integration.

## Purpose
Delegate the intent interview to the skill under a host contract.

## Top invariant
An interrupted run can always be resumed.

## Non-goals
- A second native questioning implementation.

## Audience
not applicable

## Core bet
One interview implementation, two consumers.

## Direction
Routine mechanical, structure human-gated.

## Posture
skipped (low complexity)

## Reconciliation
repo_intent: none
`,
    'utf8',
  );
  const out = execFileSync(
    process.execPath,
    [path.join(pinnedSkillDir, 'validate-intent.mjs'), projection, '--mode', 'plan', '--complexity', 'low'],
    { encoding: 'utf8' },
  );
  assert.match(out, /^ok: /);
  rmSync(tmp, { recursive: true, force: true });
  rmSync(pinnedSkillDir, { recursive: true, force: true });
});