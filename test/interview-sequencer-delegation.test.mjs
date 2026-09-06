// test/interview-sequencer-delegation.test.mjs — task 54: sequencer/critic integration (WIRING ONLY).
//
// The delegation contract the spec states (§5) and the plan's task 54 pins, proven as a
// CONTRACT, because task 59 owns the actual cutover: until then the duplicate questioning
// implementation stays the working path, and this suite proves the pieces the cutover will
// connect — never a second questioner of its own.
//
//   1. DELEGATION: questioning is delegated to /design-intent PLAN MODE over the task-49 host
//      contract — policy/design-intent-skill.json (the pin: commit + manifest digest + the
//      declared host_contract_version) and lib/goals.mjs decodeIntent (the native adapter) —
//      never an ad-hoc prompt. Proven against the PINNED skill bytes (extracted from the pinned
//      commit's tree, not the working checkout): the skill teaches the host contract both
//      directions, presents only the intent projection to the shared validator while goal
//      blocks stay host-owned, and names `mp interview` as the only recorder.
//   2. SAME DRAFT: the critic is passed the SAME schema-backed draft the operator sees — the
//      readSchemaSnapshot-backed bundle's recorded draft — never a divergent rendering. Proven
//      mechanically: recordCritic's intent_sha256 binds the receipt to the recorded draft
//      (the honesty bound §5.3), and the draft the operator's versioned goals.md carries
//      (decodeIntent -> projectLegacyIntent) equals the recorded draft. A divergent rendering
//      is refused by the existing receipt binding, not by prompt discipline.
//   3. ONLY RECORDER: `mp interview` stays the only recorder — every event in this suite lands
//      through the verbs, and the skill-side contract (pinned SKILL.md) names only the
//      permitted recorder operations, never state.yml/events.jsonl writes of its own.
//   4. CRITIC PAYLOAD: the critic payload gains `eligible_question_set` (ids of asked
//      questions judged eligible — intent-kind, answered, not withdrawn, not design-kind; the
//      same eligibility vocabulary task 53's recorder enforces) and `forks_remaining` (the
//      boolean verdict: whether genuine forks remain whose answers could change the design).
//      Proven against agents/mp-intent-critic.md: the output schema block parses, carries
//      both keys with the right types, and the fail rule rejects an id outside the asked set
//      or a non-boolean verdict.
//   5. §11 RECONCILED READING: the test plan's legacy-only assertions (the three floors, the
//      intent-round minimum) are stated here as LEGACY-PATH assertions: they hold on a
//      legacy (no schema capture) bundle exactly as §11 says, and the schema-backed
//      substitution (spec §5.4's "a schema-backed interview reads 'coverage and the probing
//      minimum'") — landed by task 53's matrix — is what the same statements mean for a
//      schema-captured bundle. The suite asserts the substitution reading directly on a
//      schema-captured bundle (the floors are not the schema-backed gate) so the plan text
//      never again reads as an unqualified claim that the floors gate both paths.
//
// Fixture bundles and skill trees land under os.tmpdir() and are removed once at teardown
// (the mkdtempTracked style of test/interview-ledger-resume.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildSeedState, writeState, resolveFormatPin, repairFormatPin } from '../lib/bundle.mjs';
import {
  askQuestion,
  answerQuestion,
  endInterview,
  recordDraft,
  recordCritic,
  intentSha,
  interviewStatus,
  replayInterview,
  replayLedger,
  captureSchema,
  readSchemaSnapshot,
  replaySchemaCapture,
  registerSchemaSnapshotModule,
  SCHEMA_SNAPSHOT_FILENAME,
} from '../lib/interview.mjs';
import { captureSchemaSnapshot, computeSkillIdentity } from '../lib/schema-snapshot.mjs';
import { parseGoals, encodeIntentBlock, decodeIntent, projectLegacyIntent } from '../lib/goals.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PIN_PATH = path.join(ROOT, 'policy', 'design-intent-skill.json');
const AGENT_PATH = path.join(ROOT, 'agents', 'mp-intent-critic.md');
const pin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));
const agentDoc = fs.readFileSync(AGENT_PATH, 'utf8');

const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

// Every fixture tree lands under os.tmpdir() and is removed once at teardown.
const TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  TMPDIRS.push(dir);
  return dir;
}
test.after(() => {
  registerSchemaSnapshotModule(null); // never leak the real module registration into another suite
  for (const d of TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args]);

// A complete, closed fixture skill (the test/schema-snapshot-identity.test.mjs shape): a
// manifest declaring the closed file set plus every behavior-affecting file in the tree.
function mkskill() {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'iv-del-skill-'));
  const skillRoot = path.join(dir, 'skill');
  const manifest = {
    manifest_version: 1,
    skill: 'fixture-intent',
    host_contract_version: 1,
    schema_format_version: 1,
    identity: {
      algorithm: 'sha256',
      closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'],
    },
  };
  const files = {
    'SKILL.md': '# fixture design-intent plan mode\n',
    'schema.json': '{"version": 1, "core": ["Purpose"]}\n',
    'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
  fs.mkdirSync(skillRoot, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(skillRoot, rel), content);
  }
  return { dir, skillRoot };
}

function mkbundle(complexity = 'medium') {
  const dir = mkdtempTracked(path.join(os.tmpdir(), 'iv-del-'));
  const statePath = path.join(dir, 'state.yml');
  writeState(
    statePath,
    buildSeedState({ slug: 'iv-del', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity }),
  );
  return { dir, statePath };
}

// A schema-captured bundle: the real module behind the seam, an approved capture, the §6.1
// format pin repaired from the capture history — the state a schema-backed interview runs in.
function mkCapturedBundle(complexity = 'medium') {
  registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  const { skillRoot } = mkskill();
  const { dir, statePath } = mkbundle(complexity);
  captureSchema({ statePath, skillRoot });
  repairFormatPin(statePath); // §6.1: the pin is repaired from the capture history, once
  return { dir, statePath, skillRoot };
}

// ---- 1. DELEGATION: the pinned plan-mode host contract, not an ad-hoc prompt ------------

// Extract the pinned skill's exact bytes from the pinned commit's tree (the
// design-intent-host-contract style): the delegation contract is verified against what the
// pin names, never against whatever the checkout happens to hold.
const pinnedBytes = (rel) => git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/${rel}`);
const pinnedSkill = pinnedBytes('SKILL.md').toString('utf8');
const pinnedManifest = JSON.parse(pinnedBytes('manifest.json').toString('utf8'));
const flatSkill = pinnedSkill.replace(/\s+/g, ' ');

test('the delegation target is the pinned plan mode, not an ad-hoc prompt', () => {
  // The pin is the authority the host hands plan mode over: an exact revision, an identity
  // digest, and the declared contract versions (task 49's host contract).
  assert.ok(/^[0-9a-f]{40}$/.test(pin.commit), 'the pin names an exact 40-hex commit');
  assert.ok(/^[0-9a-f]{64}$/.test(pin.manifest_digest), 'the pin names the skill identity digest');
  // CORRESPONDENCE, not shape (wave-13 review finding): the pinned tree's recomputed
  // identity — the real algorithm over the pinned commit's exact bytes — EQUALS the pin's
  // digest. A fabricated hex string must fail here.
  const pinnedTree = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-tree-'));
  TMPDIRS.push(pinnedTree);
  const pinnedSkillRoot = path.join(pinnedTree, 'skill');
  fs.mkdirSync(pinnedSkillRoot, { recursive: true });
  for (const rel of pinnedManifest.identity.closed_file_set) {
    const dest = path.join(pinnedSkillRoot, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, pinnedBytes(rel));
  }
  assert.equal(
    computeSkillIdentity({ skillRoot: pinnedSkillRoot }),
    pin.manifest_digest,
    'the pinned bytes recomputed through the REAL identity algorithm must equal the pin digest',
  );
  assert.equal(pin.host_contract_version, pinnedManifest.host_contract_version);
  assert.equal(pin.schema_format_version, pinnedManifest.schema_format_version);
  assert.equal(pinnedManifest.skill, 'design-intent');
  // The pinned skill's plan mode IS the delegated questioner and says so under the contract:
  assert.ok(flatSkill.includes('plan mode, run against a masterplan bundle under the **masterplan host contract**'), 'plan mode is invoked by a masterplan host');
  assert.ok(flatSkill.includes('The host (masterplan) owns the bundle, the ledger'), 'the skill teaches host ownership of the ledger');
  assert.ok(flatSkill.includes('never refuses a `goals.md` merely because it carries `## G<n>:` goal blocks'), 'plan mode accepts the native artifact');
});

test('the pinned skill is dispatched as a questioner that returns, never as a recorder', () => {
  // What the skill returns each round (questions/answers/draft back through the recorder):
  for (const expected of [
    '**What the skill returns** each round',
    'asked through the host\'s recorder so they are durable',
    'sent back through the host\'s `mp interview draft` verb',
  ]) {
    assert.ok(flatSkill.includes(expected), `the pinned skill must teach: ${expected}`);
  }
  // The permitted recorder operations are the mp interview verbs, and the lifecycle is not
  // the skill's to run:
  assert.ok(flatSkill.includes('(`ask`, `answer`, `withdraw`, `draft`, and critic/critic-unavailable recording)'), 'the permitted recorder operations are exactly the interview verbs');
  assert.ok(flatSkill.includes('may not `set-phase`, `end`, `waive`, or reopen an interview'), 'the lifecycle verbs stay the host\'s');
});

test('the native adapter over the host artifact is decodeIntent — the projection the validator sees', () => {
  // The critic-side and skill-side read of the SAME host artifact is the native adapter:
  // goal blocks stay owned and validated by masterplan; only the intent projection travels.
  const authoritative = {
    version: 1,
    schema: { identity: 'design-intent@fixture', format_version: 1 },
    sections: {
      purpose: { body: 'The delegation lands over the host contract.' },
      non_goals: { items: ['no ad-hoc prompt'] },
      top_invariant: { body: 'The ledger is the only recorder.' },
      direction: { body: 'One interview implementation, two consumers.' },
      posture: { body: 'Fail closed on contract skew.' },
    },
    context: {
      outcome: { body: 'Plan mode owns the questions.' },
      done_means: { body: 'the pinned suite passes' },
      audience: { body: 'masterplan maintainers' },
    },
    evidence: [{ section: 'purpose', source: 'operator interview' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified' }],
  };
  const enc = encodeIntentBlock(authoritative);
  assert.ok(enc.ok, JSON.stringify(enc));
  const goalsMd = `topic: |\n  Fixture.\n${enc.block}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  const dec = decodeIntent(goalsMd);
  assert.ok(!dec.error, dec.error || '');
  assert.equal(dec.versioned, true);
  // The native parser reads the persisted legacy view beside the authoritative copy; the
  // binding check (the two never disagree) is the adapter's own guard:
  const parsed = parseGoals(goalsMd);
  const proj = projectLegacyIntent(dec.authoritative);
  assert.equal(parsed.intent.why, proj.why);
  assert.deepEqual(parsed.intent.anti_goals, proj.anti_goals);
  assert.equal(dec.legacyView.outcome, proj.outcome);
  assert.equal(dec.legacyView.done_means, proj.done_means);
  // And goal blocks are still the host's artifact — parsed and owned by the same document:
  assert.deepEqual(parsed.goals.map((g) => g.id), ['G1', 'G2', 'G3']);
});

test('the pinned validator accepts the intent projection while goal blocks never reach it', () => {
  // The shared validator is executed from the PINNED tree (the host-contract suite's
  // technique): the plan-mode projection — topic anchor + sections, NO goal blocks — is
  // exactly what the host presents on the skill's behalf.
  const pinnedSkillDir = mkdtempTracked(path.join(os.tmpdir(), 'iv-del-pinned-'));
  for (const rel of pinnedManifest.identity.closed_file_set) {
    const dest = path.join(pinnedSkillDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, pinnedBytes(rel));
  }
  const projection = path.join(pinnedSkillDir, 'projection.md');
  fs.writeFileSync(
    projection,
    `topic: |
  Delegate the questioning over the host contract.

## Purpose
The sequencer hands questioning to plan mode.

## Top invariant
The ledger stays the only recorder.

## Non-goals
- A second native questioner.

## Direction
Wiring now, cutover in task 59.

## Posture
skipped (low complexity)

## Audience
not applicable

## Core bet
not applicable

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
  // And the same validator, handed a projection with goal blocks, refuses them — proving the
  // boundary: the host presents ONLY the intent projection, and goal blocks are not input.
  const withGoals = path.join(pinnedSkillDir, 'with-goals.md');
  fs.writeFileSync(
    withGoals,
    `topic: |
  Delegate the questioning over the host contract.

## Purpose
The sequencer hands questioning to plan mode.

## Top invariant
The ledger stays the only recorder.

## Non-goals
- A second native questioner.

## Direction
Wiring now, cutover in task 59.

## Posture
skipped (low complexity)

## Audience
not applicable

## Core bet
not applicable

## Reconciliation
repo_intent: none

## G1: Works
`,
    'utf8',
  );
  const refused = spawnSync(
    process.execPath,
    [path.join(pinnedSkillDir, 'validate-intent.mjs'), withGoals, '--mode', 'plan', '--complexity', 'low'],
    { encoding: 'utf8' },
  );
  assert.notEqual(refused.status, 0, 'goal blocks must never reach the validator');
  assert.match(refused.stderr, /goal blocks present/);
});

// ---- 2. SAME DRAFT: the critic is handed the schema-backed draft the operator sees ------

test('the critic receipt binds the recorded draft, so a divergent rendering is refused', () => {
  const { statePath, skillRoot, dir } = mkCapturedBundle('medium');
  // The interview that produced a schema-backed draft (every recording through the verbs):
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'What is the outcome in the world?' });
  answerQuestion({ statePath, id: 'Q1', text: 'The delegation lands over the host contract.' });
  askQuestion({ statePath, id: 'Q2', round: 2, kind: 'design', text: 'Pick the projection path: A or B?' });
  answerQuestion({ statePath, id: 'Q2', text: 'A' });
  const draft = {
    why: 'The problem behind the ask.',
    outcome: 'The outcome in the world.',
    anti_goals: ['a second native questioner'],
    done_means: 'the pinned suite passes',
  };
  recordDraft({ statePath, intent: draft });
  const status = interviewStatus(statePath);
  // The draft the OPERATOR sees in the bundle's versioned goals.md is the same recorded
  // draft: the authoritative projection equals the recorded draft, byte for byte.
  const authoritative = {
    version: 1,
    schema: { identity: 'design-intent@fixture', format_version: 1 },
    sections: {
      purpose: { body: `${draft.why}\nSecond line the projection keeps.` },
      non_goals: { items: draft.anti_goals },
      top_invariant: { body: 'An interrupted run can always be resumed.' },
      direction: { body: 'One interview implementation, two consumers.' },
      posture: { body: 'Fail closed on contract skew.' },
    },
    context: {
      outcome: { body: draft.outcome },
      done_means: { body: draft.done_means },
    },
    evidence: [{ section: 'purpose', source: 'operator interview' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified' }],
  };
  const proj = projectLegacyIntent(authoritative);
  assert.equal(proj.why, draft.why, 'the operator-facing legacy view projects the same why');
  assert.deepEqual(proj.anti_goals, draft.anti_goals);
  assert.equal(proj.outcome, draft.outcome);
  assert.equal(proj.done_means, draft.done_means);
  // OPERATOR-ARTIFACT BINDING (wave-13 review finding): the proof above must run against
  // the ACTUAL operator-facing artifact — a versioned goals.md written through the host
  // adapter — not a locally fabricated projection. Write it, decode it with the native
  // adapter, and assert the ARTIFACT's authoritative projection equals the recorded draft.
  const operatorGoalsPath = path.join(dir, 'goals.md');
  const enc = encodeIntentBlock(authoritative);
  assert.ok(enc.ok, 'the encoder accepts the authoritative representation');
  fs.writeFileSync(operatorGoalsPath, `topic: delegated draft\n\n${enc.block}\n\n## G1: Works\n`);
  const dec = decodeIntent(fs.readFileSync(operatorGoalsPath, 'utf8'));
  assert.equal(dec.error, undefined, 'the operator artifact decodes clean');
  const artifactProj = projectLegacyIntent(dec.authoritative);
  assert.equal(artifactProj.why, draft.why, 'the artifact the operator sees projects the recorded why');
  assert.equal(artifactProj.done_means, draft.done_means, 'the artifact the operator sees projects the recorded done_means');
  // The NEGATIVE CONTROL on the artifact: a divergent operator rendering (someone rewrote
  // the artifact's done_means) decodes to a projection that NO LONGER equals the recorded
  // draft, and the receipt naming it is refused — the same-draft bound is on the artifact,
  // not on the local object.
  const divergentArtifact = {
    ...authoritative,
    context: { ...authoritative.context, done_means: { body: 'a divergent rendering' } },
  };
  const encDiv = encodeIntentBlock(divergentArtifact);
  assert.ok(encDiv.ok);
  fs.writeFileSync(operatorGoalsPath, `topic: delegated draft\n\n${encDiv.block}\n\n## G1: Works\n`);
  const decDiv = decodeIntent(fs.readFileSync(operatorGoalsPath, 'utf8'));
  assert.equal(decDiv.error, undefined);
  const divergentProj = projectLegacyIntent(decDiv.authoritative);
  assert.notEqual(divergentProj.done_means, draft.done_means, 'a rewritten artifact visibly diverges');
  fs.writeFileSync(operatorGoalsPath, `topic: delegated draft\n\n${enc.block}\n\n## G1: Works\n`); // restore the honest artifact
  // The critic is dispatched with the SAME recorded draft: the receipt must name the
  // recorded draft's digest. A divergent rendering (someone re-projected the draft with a
  // different done_means) is refused by the honesty bound:
  const divergent = { ...draft, done_means: 'a divergent rendering' };
  assert.notEqual(intentSha(divergent), intentSha(draft));
  const payloadPath = path.join(path.dirname(statePath), 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    unknowns: [], contradictions: [], misclassified: [],
    intent_draft: draft,
    eligible_question_set: ['Q1'],
    forks_remaining: false,
  }));
  assert.throws(
    () => recordCritic({
      statePath,
      receipt: {
        dispatch_id: 'd1', model: 'm', output_tokens: 10,
        content_head: status.content_head,
        intent_sha256: intentSha(divergent),
      },
      payloadPath,
    }),
    /stale receipt/,
  );
  // The SAME schema-backed draft the operator sees is accepted:
  recordCritic({
    statePath,
    receipt: {
      dispatch_id: 'd1', model: 'm', output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(draft),
    },
    payloadPath,
  });
  assert.equal(interviewStatus(statePath).critic.receipts, 1);
  // The snapshot the operator's bundle reads is the captured one (never the live file):
  const snap = readSchemaSnapshot({ statePath });
  assert.equal(snap.schema_sha256, sha256Hex(fs.readFileSync(path.join(skillRoot, 'schema.json'))));
  assert.equal(snap.skill_identity, computeSkillIdentity({ skillRoot }));
});

test('a captured bundle resolves the schema_backed pin — the operator reads under the new policy', () => {
  const { statePath } = mkCapturedBundle('medium');
  assert.deepEqual(resolveFormatPin(statePath), { pin: 'schema_backed' });
  // The recorded capture is the §5.5 history: snapshot + identity, readable without the live skill.
  const snap = readSchemaSnapshot({ statePath });
  assert.equal(snap.format_pin, 'schema_backed');
  assert.ok(fs.existsSync(path.join(path.dirname(statePath), SCHEMA_SNAPSHOT_FILENAME)));
});

// ---- 3. ONLY RECORDER: mp interview is the sole writer of interview state --------------

test('every interview event in this suite landed through the mp interview verbs', () => {
  const { statePath } = mkCapturedBundle('medium');
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const draft = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent: draft });
  const status = interviewStatus(statePath);
  const payloadPath = path.join(path.dirname(statePath), 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    unknowns: [], contradictions: [], misclassified: [],
    intent_draft: draft,
    eligible_question_set: ['Q1'],
    forks_remaining: false,
  }));
  recordCritic({
    statePath,
    receipt: {
      dispatch_id: 'd1', model: 'm', output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(draft),
    },
    payloadPath,
  });
  // The ledger is exactly the verbs' appends — no skill-side writes, no synthetic events:
  const ledger = replayLedger(statePath);
  assert.deepEqual(ledger.map((e) => e.type), ['question', 'answer', 'draft', 'critic']);
  // And every critic payload artifact is a recorder copy (the digest-bound receipt is the
  // only path to a payload on disk):
  const copied = path.join(path.dirname(statePath), 'interview-critic-1.json');
  assert.ok(fs.existsSync(copied));
  assert.equal(
    sha256Hex(fs.readFileSync(copied)),
    sha256Hex(fs.readFileSync(payloadPath)),
  );
});

test('the pinned skill contract names no ledger write of its own', () => {
  // The skill returns questions/answers/drafts; the recorder verbs are the host's. The
  // pinned plan-mode contract must not teach a write path for state.yml/events.jsonl:
  assert.ok(flatSkill.includes('the host is the sole writer of bundle state'), 'the host is the sole writer');
  // The critic-side contract (this repo's agent doc) also stays read-only:
  assert.match(agentDoc, /You are read-only and fresh-context/);
  assert.match(agentDoc, /tools: read, bash/);
});

// ---- 4. CRITIC PAYLOAD: the extension shape, proven against the agent doc --------------

// Parse the agent doc's Output schema the way test/intent-critic-prompt.test.mjs does: the
// first four-space-indented block after the '## Output schema' heading.
function outputSchemaBlock() {
  const heading = '## Output schema';
  const start = agentDoc.indexOf(heading);
  assert.ok(start !== -1, 'the critic agent doc must have an Output schema heading');
  const lines = agentDoc.slice(start + heading.length).split('\n');
  const blockLines = [];
  let started = false;
  for (const line of lines) {
    if (line.startsWith('    ')) {
      started = true;
      blockLines.push(line.slice(4));
    } else if (!started) {
      if (line.startsWith('## ')) break;
      continue;
    } else if (line.trim() === '') {
      blockLines.push('');
    } else {
      break;
    }
  }
  return JSON.parse(blockLines.join('\n'));
}

test('the critic payload schema carries the eligible question set and the forks_remaining verdict', () => {
  const schema = outputSchemaBlock();
  // The extension, in the agent doc's own schema terms:
  assert.deepEqual(
    Object.keys(schema).sort(),
    ['contradictions', 'eligible_question_set', 'forks_remaining', 'intent_draft', 'misclassified', 'unknowns'],
  );
  assert.ok(Array.isArray(schema.eligible_question_set), 'eligible_question_set is an array of question ids');
  assert.equal(typeof schema.forks_remaining, 'boolean', 'forks_remaining is a boolean verdict');
  // The vocabulary is the recorder's (task 53's rejection set, spec §5.3): intent-kind,
  // answered, not withdrawn, never design-kind:
  assert.match(agentDoc, /intent-kind \(a design-kind pick is never\s+eligible\), answered \(an unanswered question never counts\), not withdrawn/);
  assert.match(agentDoc, /never design-kind/);
  // The verdict semantics: false only when no remaining fork could change the design.
  assert.match(agentDoc, /whether\s+genuine forks remain whose answers could still change the design/);
});

test('the critic input sections carry the same schema-backed draft and the eligibility record', () => {
  // The dispatch hands the critic the SAME draft the operator sees (never a divergent copy):
  assert.match(agentDoc, /SAME schema-backed draft the operator sees/);
  assert.match(agentDoc, /never a\s+   re-rendered or divergent copy/);
  // And the ledger is named the eligibility record's only source:
  assert.match(agentDoc, /the eligibility record you adjudicate against/);
  assert.match(agentDoc, /the\s+   ledger is the only source for them/);
});

test('the fail rule rejects an eligible id outside the asked set and a non-boolean verdict', () => {
  // The fail-closed contract for the extension:
  assert.match(agentDoc, /an `eligible_question_set` entry that is not the id of a question asked in this\s+interview/);
  assert.match(agentDoc, /a `forks_remaining` that is not a boolean/);
  // And the payload's persisted shape accepts the extension (the recorder copies what the
  // critic returned; the extension rides the artifact the §5.3 event binds):
  const { statePath } = mkbundle('medium');
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  const draft = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };
  recordDraft({ statePath, intent: draft });
  const status = interviewStatus(statePath);
  const payloadPath = path.join(path.dirname(statePath), 'payload.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    unknowns: [], contradictions: [], misclassified: [],
    intent_draft: draft,
    eligible_question_set: ['Q1'],
    forks_remaining: false,
  }));
  recordCritic({
    statePath,
    receipt: {
      dispatch_id: 'd1', model: 'm', output_tokens: 10,
      content_head: status.content_head,
      intent_sha256: intentSha(draft),
    },
    payloadPath,
  });
  const replay = replayInterview(statePath);
  const receipt = replay.criticReceipts[0];
  assert.ok(receipt.valid);
  assert.deepEqual(receipt.payload.eligible_question_set, ['Q1']);
  assert.equal(receipt.payload.forks_remaining, false);
});

// ---- 5. §11 RECONCILED: the legacy-only assertions, stated as legacy-path assertions ----

test('the three floors gate a LEGACY interview exactly as §11 says — the legacy path is not removed here', () => {
  // §11's `interview-ledger-resume` row: "both floors met but the intent-round minimum unmet
  // (eight intent answers in two rounds at `high`) → every non-waived exit refused". This is
  // the LEGACY path's assertion — the duplicate questioning implementation stays in place
  // (task 59 removes it) and its ledger still applies the three floors verbatim:
  const { statePath } = mkbundle('high'); // NO schema capture: a legacy interview
  assert.deepEqual(resolveFormatPin(statePath), { pin: 'legacy' });
  // §11's exact case: EIGHT intent answers in TWO rounds at high (4 per round, each round
  // carrying its own critic receipt per the high cadence), both floors met, the
  // intent-round minimum (4) unmet.
  const rounds = [[1, ['Q1', 'Q2', 'Q3', 'Q4']], [2, ['Q5', 'Q6', 'Q7', 'Q8']]];
  const draftAndCritic = (round, ids) => {
    const draft = { why: `w${round}`, outcome: `o${round}`, anti_goals: ['x'], done_means: 'd' };
    recordDraft({ statePath, intent: draft });
    const status = interviewStatus(statePath);
    const payloadPath = path.join(path.dirname(statePath), `payload-${round}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify({
      unknowns: [], contradictions: [], misclassified: [],
      intent_draft: draft,
      eligible_question_set: ids,
      forks_remaining: false,
    }));
    recordCritic({
      statePath,
      receipt: {
        dispatch_id: `d${round}`, model: 'm', output_tokens: 10,
        content_head: status.content_head,
        intent_sha256: intentSha(draft),
      },
      payloadPath,
    });
  };
  // Rounds 1 and 2 (four intent answers): the high cadence gives each round its critic.
  for (const [round, ids] of rounds.slice(0, 2)) {
    for (const id of ids) askQuestion({ statePath, id, round, kind: 'intent', text: `q-${id}` });
    for (const id of ids) answerQuestion({ statePath, id, text: `a-${id}` });
    draftAndCritic(round, ids);
  }
  // Two rounds in, draft at the head, receipt fresh: the floors are met and the
  // intent-round minimum is NOT (2 < 4) — §11's "eight intent answers in two rounds at
  // high → every non-waived exit refused" holds on the legacy path exactly as written.
  assert.throws(() => endInterview({ statePath, reason: 'converged' }), /intent-round minimum/);
  assert.throws(() => endInterview({ statePath, reason: 'exhausted' }), /intent-round minimum/);
  assert.throws(() => endInterview({ statePath, reason: 'critic_off' }), /intent-round minimum/);
  // ...and completing rounds 3 and 4 (the cadence continues) still refuses nothing here:
  // the duplicate path stays the working path, so its ledger keeps recording normally.
  const finalStatus = interviewStatus(statePath);
  assert.equal(finalStatus.state, null, 'the interview is still open — wiring only, no terminal claim');
  assert.equal(finalStatus.asked, 8);
});

test('a schema-captured bundle reads §5.4\'s substitution — the floors are not the schema-backed gate', () => {
  // The QUALIFIED reading §11 now needs: the same §11 statements, read on a schema-captured
  // bundle, are governed by spec §5.4's rule — "a schema-backed interview reads 'coverage
  // and the probing minimum'; a legacy interview reads it as written". Task 53's matrix
  // delivers the substitution; this pins that the captured bundle's POLICY identity is the
  // schema-backed one (the pin + the capture history are the persisted policy identity §5.3
  // names), so the §11 floor assertions can no longer be read as gating both paths.
  const { statePath } = mkCapturedBundle('high');
  assert.deepEqual(resolveFormatPin(statePath), { pin: 'schema_backed' });
  // The capture history is durable and re-readable without the live skill — the evidence
  // the substituted policy judged under:
  const snap = readSchemaSnapshot({ statePath });
  assert.equal(snap.format_pin, 'schema_backed');
  assert.equal(snap.host_contract_version, replaySchemaCapture(statePath).captured.host_contract_version, 'the host contract version is the one the capture recorded');
  // The legacy vocabulary still names what a LEGACY interview means, so the plan text
  // carries both readings without contradiction — and §11 ITSELF is reconciled
  // (wave-13 review finding: a whole-spec regex could find §5.4's qualification while
  // §11 stayed unqualified; the check is now pinned to §11's own lines):
  const specLegacy = fs.readFileSync(
    path.join(ROOT, 'docs', 'masterplan', 'intent-to-completion', 'spec.md'),
    'utf8',
  );
  const section11 = (() => {
    const m = /## 11[^]*?(?=\n## \d|\n\Z|$)/.exec(specLegacy.replace(/\r/g, ''));
    return m ? m[0] : '';
  })();
  assert.ok(section11.length > 0, 'the spec carries a §11 test plan');
  const flat11 = section11.replace(/\s+/g, ' ');
  assert.match(
    flat11,
    /eight intent answers in two rounds at `high`\) → every non-waived exit refused — a LEGACY-path assertion: a schema-backed interview/i,
    '§11 itself must state the floor assertion as the legacy path, qualified',
  );
  assert.match(flat11, /interview-design-intent.*substitution.*matrix/i, '§11 points at the matrix suite that proves the substitution');
  assert.match(specLegacy, /a legacy interview reads it as written/);
  const flatSpec = specLegacy.replace(/\s+/g, ' ');
  assert.match(flatSpec, /a schema-backed interview reads "coverage and the probing minimum"/);
});

test('the recorder keeps refusing what the legacy path refused — the duplicate path stays the working path', () => {
  // Wiring-only, stated as a test: the duplicate questioning implementation stays in place
  // (the sequencer's native path still records through the same verbs) and is removed by
  // task 59 after the replacement is proven capability-complete. Nothing here gates or
  // removes the native path; the suite only proves the two paths share ONE recorder.
  const { statePath } = mkbundle('low');
  // §11's own legacy rows, still the working path:
  // (a) "asks of one round recorded before their answers accepted" —
  askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'q1' });
  askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'q2' });
  // (b) "ask with an unanswered question [from an earlier round] → refused" —
  assert.throws(() => askQuestion({ statePath, id: 'Q3', round: 2, kind: 'intent', text: 'q3' }), /unanswered/);
  answerQuestion({ statePath, id: 'Q1', text: 'a1' });
  answerQuestion({ statePath, id: 'Q2', text: 'a2' });
  recordDraft({ statePath, intent: { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' } });
  // The low-complexity path still ends critic_off with the floor met (§11's legacy row):
  assert.doesNotThrow(() => endInterview({ statePath, reason: 'critic_off' }));
  assert.equal(interviewStatus(statePath).state, 'critic_off');
});
