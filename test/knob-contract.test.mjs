// test/knob-contract.test.mjs — the knob contract harness (spec §4.4).
//
// For every non-metadata control in the DERIVED inventory (discovery.mjs) that resolves to a
// registry entry, prove that two values produce the documented difference in a CONSUMER-side
// observable: an mp op's output, a gate, an event, a rendered protocol line (prompt-only), or
// the registration surface (a registered flag is accepted, an unregistered one dies exit 2).
// A seeded state field echo is NOT an observable.
//
// Single-variable invariant: every pair is built from ONE SHARED IMMUTABLE base input spec
// and differs in EXACTLY the one knob under test. The harness diffs the two derived specs
// (excluding only the explicit nonsemantic identity field) and fails when anything else
// differs. Fixture readiness is built from that same base so untracked differences (repo
// paths, bundle paths, tmp roots, slugs) cannot leak into a consumer.
//
// Guard probes: the harness proves the guard REJECTS a read-but-ignored synthetic knob, a
// seeded-state-only synthetic knob, and a fixture pair that changes two inputs — each THROUGH
// the same validateContract the registry entries run through, so removing a guard rule fails
// its test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY, SYNTHETIC_BAD, TWO_INPUT_DIFF, METADATA_EXEMPTIONS,
} from './fixtures/knobs/contracts.mjs';
import {
  discoverAllControls, discoverFlags, discoverConfigPaths, discoverEnvControls,
  discoverSeedStateFields, discoverPromptMarkers,
} from './fixtures/knobs/discovery.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = path.join(ROOT, 'bin', 'masterplan.mjs');
const FIXTURE_TMPDIRS = [];

// The spec-gate hash over spec.md+goals.md — mirrors lib/finish-step.mjs computeSpecGateHash
// (which is private). The finish machinery re-arms the spec gate on a goals_enabled bundle
// unless a spec review sits at this EXACT hash, so the autonomy walk must record one.
function specGateHashFor(bundleDir) {
  const h = createHash('sha256');
  for (const rel of ['spec.md', 'goals.md']) {
    h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(bundleDir, rel))); h.update('\0');
  }
  return `sha256:${h.digest('hex')}`;
}

test.after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// ---------------------------------------------------------------------------
// Fixture plumbing
// ---------------------------------------------------------------------------
function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}
function tmpdir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  FIXTURE_TMPDIRS.push(d);
  return d;
}

// The design-intent fixture skill (the same shape test/interview-design-intent.test.mjs
// builds): a manifest-declared closed file set whose schema.json carries the checked_sections
// the coverage consumer validates against. `sections` overrides the snapshot's checked set so
// the ALTERNATE-SCHEMA end-to-end proof can drive different content through the same path.
const FIXTURE_SCHEMA_VERDICTS = ['serves', 'neutral', 'fights', 'unavailable'];
function makeKnobSkill({ checkedSections = ['Purpose', 'Top invariant', 'Non-goals', 'Direction', 'Posture'] } = {}) {
  const root = tmpdir('mp-knob-skill-');
  const skillRoot = path.join(root, 'skill');
  fs.mkdirSync(skillRoot, { recursive: true });
  const schema = {
    version: 1,
    core: [checkedSections[0]],
    checked_sections: checkedSections,
    check_verdicts: FIXTURE_SCHEMA_VERDICTS,
  };
  const manifest = {
    manifest_version: 1,
    skill: 'knob-fixture-intent',
    host_contract_version: 1,
    schema_format_version: 1,
    identity: { algorithm: 'sha256', closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'] },
  };
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# knob fixture design-intent\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify(schema, null, 2)}\n`);
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return skillRoot;
}

// A minimal bundle for the interview/snapshot fixtures. `complexity` is the knob the probing
// contracts hold FIXED per level (the ledger is built for that level's budget).
async function makeKnobBundle(complexity = 'medium') {
  const dir = tmpdir('mp-knob-ivb-');
  const statePath = path.join(dir, 'state.yml');
  const { buildSeedState, writeState } = await requireBundle();
  writeState(statePath, buildSeedState({ slug: 'knob', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity }));
  return { dir, statePath };
}

// lib/bundle.mjs and lib/interview.mjs are imported lazily inside the fixture builders (the
// knob-contract harness runs before some suites; a top-level import would couple the two).
let _bundleMod = null;
async function requireBundle() {
  if (!_bundleMod) _bundleMod = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
  return _bundleMod;
}
let _interviewMod = null;
async function requireInterview() {
  if (!_interviewMod) _interviewMod = await import(path.join(ROOT, 'lib', 'interview.mjs'));
  return _interviewMod;
}

// Capture on a fresh knob bundle through the REAL task-52 seam (the same registration the
// CLI verb performs), so the schema_captured event, the bundle snapshot and the format pin's
// repair source all exist exactly as the runtime would create them.
async function knobCapture({ statePath, skillRoot }) {
  const { captureSchemaSnapshot, computeSkillIdentity } = await import(path.join(ROOT, 'lib', 'schema-snapshot.mjs'));
  const iv = await requireInterview();
  iv.registerSchemaSnapshotModule({ captureSchemaSnapshot, computeSkillIdentity });
  return iv.captureSchema({ statePath, skillRoot });
}

const KNOB_INTENT = { why: 'w', outcome: 'o', anti_goals: ['x'], done_means: 'd' };

// Record a critic receipt with an eligible set — the §5.3 adjudication the probing consumer
// counts. Mirrors the interview-design-intent fixture's recordReceipt.
async function knobRecordReceipt({ statePath, intent, eligible, forks, dir, n = 1 }) {
  const iv = await requireInterview();
  const status = iv.interviewStatus(statePath);
  const payloadPath = path.join(dir, `knob-payload-${n}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({
    unknowns: [], contradictions: [], misclassified: [],
    eligible_question_set: eligible, forks_remaining: forks,
  }));
  iv.recordCritic({
    statePath,
    receipt: { dispatch_id: `d${n}`, model: 'm', output_tokens: 10, content_head: status.content_head, intent_sha256: iv.intentSha(intent) },
    payloadPath,
  });
}

// The twin ledger the probing contracts waive at the cap. `complexity` picks the budget; the
// ledger holds exactly `eligibleCount` answered intent questions so the mechanical/critic
// count is FIXED while only the configured minimum varies (single-variable discipline).
async function buildProbingLedger({ statePath, complexity, eligibleCount }) {
  const iv = await requireInterview();
  const { BUDGETS } = iv;
  const cap = BUDGETS[complexity].cap;
  const critic = BUDGETS[complexity].critic;
  // Round 1: the eligible intent questions, asked and answered.
  for (let i = 1; i <= eligibleCount; i += 1) {
    iv.askQuestion({ statePath, id: `Q${i}`, round: 1, kind: 'intent', text: `intent ${i}?` });
  }
  for (let i = 1; i <= eligibleCount; i += 1) {
    iv.answerQuestion({ statePath, id: `Q${i}`, text: `a${i}` });
  }
  // Cap fillers to the SAME ask count on both fixtures: design asks, immediately withdrawn
  // (they never count toward probing and keep the twin ledgers identical apart from the
  // config). Round 1 sealed at the first answer, so the fillers open round 2 onward; a
  // withdraw seals its round too, so each filler advances the round.
  let n = eligibleCount;
  let round = 2;
  while (n < cap) {
    n += 1;
    iv.askQuestion({ statePath, id: `Q${n}`, round, kind: 'design', text: `filler ${n}?` });
    iv.withdrawQuestion({ statePath, id: `Q${n}`, reason: 'cap filler' });
    round += 1;
  }
  // The draft + (where a critic runs) a CURRENT receipt at the draft head.
  iv.recordDraft({ statePath, intent: KNOB_INTENT });
  if (critic === 'on') {
    const eligible = [];
    for (let i = 1; i <= eligibleCount; i += 1) eligible.push(`Q${i}`);
    await knobRecordReceipt({ statePath, intent: KNOB_INTENT, eligible, forks: true, dir: path.dirname(statePath) });
  }
}

// The consumer-side observable of a configured per-level minimum: the RECORDED WAIVER. Both
// fixtures build the IDENTICAL twin ledger (same asks/answers/drafts/receipts); the only
// difference is the repo-local .masterplan.yaml the real resolveRunConfig reads. The waiver
// is driven through the same chain as `mp interview waive` (bin/masterplan.mjs): the resolved
// minimum comes from resolveProbingMinimum(resolveRunConfig(...), complexity).
async function observeProbingContract({ complexity, level, configured }) {
  const { resolveRunConfig, resolveProbingMinimum } = await import(path.join(ROOT, 'lib', 'config.mjs'));
  const iv = await requireInterview();
  // A repo-local .masterplan.yaml carrying ONLY the varied level (per-key defaults merge in
  // validateProbingMinimum, so the unvaried levels keep the shipped defaults on both sides).
  const repoRoot = tmpdir(`mp-knob-pm-${level}-`);
  const yaml = configured !== null
    ? `interview:\n  probing_minimum:\n    ${level}: ${configured}\n`
    : '';
  if (yaml) fs.writeFileSync(path.join(repoRoot, '.masterplan.yaml'), yaml);
  const cfg = resolveRunConfig({ cli: {}, repoRoot, env: {} });
  const resolved = resolveProbingMinimum(cfg, complexity);
  // The fixed eligible count per level — chosen so the CONFIGURED minimum (value A) is unmet
  // and the SHIPPED DEFAULT (value B) is met on the identical ledger:
  //   low:     1 eligible (mechanical test, critic off) — default 1 met, configured 2 unmet.
  //   medium:  2 eligible (critic set) — default 2 met, configured 3 unmet.
  //   high:    4 eligible (critic set) — default 4 met, configured 5 unmet.
  const eligibleCount = complexity === 'low' ? 1 : complexity === 'medium' ? 2 : 4;
  const { dir, statePath } = await makeKnobBundle(complexity);
  const skillRoot = makeKnobSkill();
  await knobCapture({ statePath, skillRoot });
  await buildProbingLedger({ statePath, complexity, eligibleCount });
  iv.waiveInterview({ statePath, reason: 'knob contract', probingMinimum: resolved });
  const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ev = [...events].reverse().find((e) => e.type === 'interview_waived');
  return {
    resolvedMinimum: ev.probing_minimum,
    capCause: ev.cause ?? null,
    policy: ev.policy,
  };
}

// The format-pin consumer observable: the pinned goals hash the real consumers (checkpoint
// identity, finish tuple, split-brain guard, record-goal-check) all bind. Drives the real
// resolveFormatPin -> goalsHash chain on a REAL bundle state carrying the varied pin.
async function observeFormatPin(pin) {
  const { goalsHash, encodeIntentBlock, INTENT_CODEC_VERSION } = await import(path.join(ROOT, 'lib', 'goals.mjs'));
  const { writeState, buildSeedState, resolveFormatPin } = await requireBundle();
  const dir = tmpdir('mp-knob-pin-');
  const statePath = path.join(dir, 'state.yml');
  writeState(statePath, buildSeedState({ slug: 'knob', topic: 't', createdAt: '2026-01-01T00:00:00.000Z', complexity: 'medium' }));
  // The durable pin is exactly what a capture would have stamped (schema_backed) or the
  // pre-capture default (legacy) — written through the same single-writer path repairFormatPin uses.
  const state = (await requireBundle()).readState(statePath);
  writeState(statePath, { ...state, format_pin: pin });
  // A versioned goals document — decodable under both pins (the legacy projection and the
  // authoritative representation coexist; §6.1 keeps both parse results).
  const enc = encodeIntentBlock({
    version: INTENT_CODEC_VERSION,
    schema: { identity: 'design-intent@knob-fixture', format_version: 1 },
    sections: {
      purpose: { body: 'The pin selects the canonicalizer.\n' },
      non_goals: { items: ['no second canonicalizer'] },
      top_invariant: { body: 'Legacy hashes stay byte-stable.' },
      direction: { body: 'One pin, every consumer.' },
      posture: { body: 'Refuse downgrades loudly.' },
    },
    context: { outcome: { body: 'The richer hash covers everything.' }, done_means: { body: 'release' } },
    evidence: [{ section: 'purpose', source: 'operator interview 2026-09-06' }],
    reconciliation: [{ target: 'repository INTENT.md §1', status: 'verified' }],
  });
  if (!enc.ok) throw new Error(`format-pin fixture: the versioned document did not encode (${enc.error})`);
  const doc = `topic: |\n  Knob fixture.\n${enc.block}\n## G1: Works\n## G2: Fast\n## G3: Documented\n`;
  fs.writeFileSync(path.join(dir, 'goals.md'), doc);
  // The REAL consumer chain (bin/masterplan.mjs pinnedGoalsHash / lib/checkpoint-evidence.mjs
  // buildIntentIdentity): resolve the durable pin, hash under it.
  const resolved = resolveFormatPin(statePath);
  if (!resolved.pin) throw new Error(`format-pin fixture: the pin did not resolve (${resolved.error ?? 'unknown'})`);
  return { pin: resolved.pin, goalsHash: goalsHash(doc, { formatPin: resolved.pin }) };
}

// The schema-capture switch consumer observable: the CONVERGENCE POLICY endInterview enforces
// on an IDENTICAL twin ledger. Both fixtures hold the same floor-unmet, coverage-met, probing-met
// ledger; only the capture event differs. Captured -> the §5.3 two conditions govern and
// converged SUCCEEDS (policy schema_backed persisted); uncaptured -> the three legacy floors
// govern and converged REFUSES (the floor error). The matrix suite (interview-design-intent)
// proves the full substitution; this contract proves the SWITCH itself is a two-value control.
async function observeCaptureSwitch(captured) {
  const iv = await requireInterview();
  const { dir, statePath } = await makeKnobBundle('medium');
  if (captured) {
    const skillRoot = makeKnobSkill();
    await knobCapture({ statePath, skillRoot });
  }
  // The twin ledger: 2 intent + 1 design answered (every legacy floor deliberately unmet at
  // medium: floor 4, intent floor 3, rounds-min 2), one active design pick, a draft and a
  // current clean critic receipt with an eligible set of 2 (probing met at default 2).
  iv.askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
  iv.askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' });
  iv.answerQuestion({ statePath, id: 'Q1', text: 'because' });
  iv.answerQuestion({ statePath, id: 'Q2', text: 'ships' });
  iv.askQuestion({ statePath, id: 'Q3', round: 2, kind: 'design', text: 'pick A or B?' });
  iv.answerQuestion({ statePath, id: 'Q3', text: 'A' });
  iv.recordDraft({ statePath, intent: KNOB_INTENT });
  await knobRecordReceipt({ statePath, intent: KNOB_INTENT, eligible: ['Q1', 'Q2'], forks: true, dir });
  // Coverage rows for the SNAPSHOT's checked sections (only consumed under the captured
  // policy; the uncaptured fixture never reaches the coverage read because the floors refuse
  // first — which is itself the observable).
  // The coverage record exists only under the captured policy (the uncaptured fixture is
  // refused by the legacy floors before coverage is ever consulted — which is itself the
  // observable: the two values enforce DIFFERENT policies on identical bytes).
  let coverageFile;
  if (captured) {
    const snap = iv.readSchemaSnapshot({ statePath });
    const rows = snap.schema.checked_sections.map((section) => ({
      section, source: `operator interview, ${section} check`, uncertainty: '', verdict: 'serves',
    }));
    coverageFile = path.join(dir, `knob-coverage-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(coverageFile, `${JSON.stringify({ sections: rows }, null, 2)}\n`);
  }
  let outcome;
  try {
    iv.endInterview({ statePath, reason: 'converged', coverageFile, probingMinimum: 2 });
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ev = [...events].reverse().find((e) => e.type === 'interview_end');
    outcome = { converged: true, policy: ev.policy, refusal: null };
  } catch (e) {
    outcome = { converged: false, policy: null, refusal: String(e.message).split('—')[0].trim() };
  }
  return outcome;
}
// The env a spawned mp needs: session identity for Guard D, and PI_CODING_AGENT cleared so the
// codex-suppressed path doesn't change op shapes. Host must not leak its own session.
function mpEnv(extra = {}) {
  const e = { ...process.env, PI_CODING_AGENT: '', CLAUDE_CODE_SESSION_ID: 'knob-session' };
  delete e.PI_SESSION_ID;
  return { ...e, ...extra };
}
function run(args, opts = {}) {
  try {
    return { status: 0, stdout: execFileSync('node', [BIN, ...args], { encoding: 'utf8', ...opts }), stderr: '' };
  } catch (e) {
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
// Build a repo with a .masterplan.yaml carrying the given config spec, plus a linked worktree
// and a bare origin (for the autonomy walk). Returns ready artifacts.
function buildRepo({ configYaml, slug = 'knob' }) {
  const tmp = tmpdir('mp-knob-');
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'test@test');
  git(MAIN, 'config', 'user.name', 'test');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, '.gitignore', '.worktrees/\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'initial');
  if (configYaml !== undefined && configYaml !== null) {
    write(MAIN, '.masterplan.yaml', configYaml);
    git(MAIN, 'add', '.masterplan.yaml');
    git(MAIN, 'commit', '-q', '-m', 'config');
  }
  const bare = path.join(tmp, 'origin.git');
  git(MAIN, 'init', '--bare', '-q', bare);
  git(MAIN, 'remote', 'add', 'origin', bare);
  git(MAIN, 'push', '-q', 'origin', 'main');
  const WT = path.join(MAIN, '.worktrees', slug);
  git(MAIN, 'worktree', 'add', '-q', '-b', `masterplan/${slug}`, WT);
  write(WT, 'src/a.txt', 'A\n');
  git(WT, 'add', '.');
  git(WT, 'commit', '-q', '-m', 'task 1');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  fs.mkdirSync(bundleDir, { recursive: true });
  const statePath = path.join(bundleDir, 'state.yml');
  return { tmp, MAIN, WT, bundleDir, statePath, slug, bare };
}

// Seed a bundle at the given statePath through the REAL mp binary with a resolved overlap
// review (empty inventory). Returns the seed op output.
function realSeed({ statePath, repoRoot, slug, topic = 't', extra = [] }) {
  const listed = run(['runs', 'list', `--repo-root=${repoRoot}`], { env: mpEnv() });
  let digest = null;
  if (listed.status === 0) {
    try { digest = JSON.parse(listed.stdout).inventory_sha256 ?? null; } catch { digest = null; }
  }
  const review = path.join(path.dirname(statePath), '..', `.overlap-${slug}.json`);
  fs.mkdirSync(path.dirname(review), { recursive: true });
  fs.writeFileSync(review, JSON.stringify({ inventory_sha256: digest, candidates: [], action: 'proceed' }));
  const r = run(['seed', `--state=${statePath}`, `--repo-root=${repoRoot}`, `--slug=${slug}`, `--topic=${topic}`,
    `--overlap-review=${review}`, ...extra], { env: mpEnv() });
  if (r.status !== 0) throw new Error(`seed failed: ${r.stderr || r.stdout}`);
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// A fake session transcript with one usage record (the context-status observer).
function writeTranscript({ home, mainRoot, sessionId, inputTokens = 50000 }) {
  const encoded = mainRoot.replace(/\//g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  fs.mkdirSync(dir, { recursive: true });
  const rec = {
    type: 'assistant',
    message: { role: 'assistant', usage: { input_tokens: inputTokens, output_tokens: 1000 } },
  };
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${JSON.stringify(rec)}\n`);
  return file;
}

// ---------------------------------------------------------------------------
// THE ONE shared immutable base + single-variable pair builder
// ---------------------------------------------------------------------------
// The base input spec is built ONCE per registry entry (one shared immutable fixture base).
// `vary` must produce from it a spec differing in EXACTLY the one knob. buildPair mechanically
// diffs the two specs (excluding the explicit nonsemantic identity field `_id`) and fails on
// any other difference. Fixture readiness is built from the SAME base+spec pair so untracked
// differences (slugs, repo paths, bundle paths, tmp roots) cannot reach a consumer.
const IMMUTABLE_BASE = Object.freeze({});

function singleVariableCheck(entry, specA, specB) {
  // Excluding the explicit nonsemantic identity field, A and B must differ in EXACTLY one key,
  // and both must otherwise equal the shared immutable base (no hidden input invented by vary).
  const { _id: _a, ...aOnly } = specA;
  const { _id: _b, ...bOnly } = specB;
  const keys = new Set([...Object.keys(aOnly), ...Object.keys(bOnly)]);
  const differing = [...keys].filter((k) => JSON.stringify(aOnly[k]) !== JSON.stringify(bOnly[k]));
  assert.equal(differing.length, 1,
    `single-variable invariant: ${entry.id} pair must differ in exactly one input, found ${differing.length} (${differing.join(', ')})`);
  for (const k of keys) {
    if (differing.includes(k)) continue;
    assert.ok(Object.prototype.hasOwnProperty.call(IMMUTABLE_BASE, k) || aOnly[k] === bOnly[k],
      `${entry.id}: non-varying input ${k} must come from the shared immutable base`);
  }
  return differing[0];
}

async function buildPair(entry) {
  const specA = { ...entry.vary(IMMUTABLE_BASE, entry.values[0]), _id: 'A' };
  const specB = { ...entry.vary(IMMUTABLE_BASE, entry.values[1]), _id: 'B' };
  const variedKey = singleVariableCheck(entry, specA, specB);
  const fixtures = {};
  for (const [tag, spec] of [['A', specA], ['B', specB]]) {
    fixtures[tag] = await buildFixture(entry, spec, tag);
  }
  return { specA, specB, fixtures, variedKey };
}

// Build the ready fixtures for one side. Each contract supplies its own needs.
async function buildFixture(entry, spec, tag) {
  const need = { ...spec };
  delete need._id;

  // ---- durable-control contracts (the design-intent amendment's run-machinery state) ----
  if (entry.id === 'format_pin') {
    return { pinnedGoals: await observeFormatPin(need.format_pin) };
  }
  if (entry.id === 'schema_capture') {
    return { captureSwitch: await observeCaptureSwitch(need.schema_capture === 'captured') };
  }
  if (entry.id.startsWith('interview.probing_minimum.')) {
    const level = entry.id.slice('interview.probing_minimum.'.length);
    // values [configured, default]: the FIRST value writes the repo config, the second is the
    // shipped default (no config file — the same absence the shipped state carries).
    const configured = tag === 'A' ? need[entry.id] : null;
    return { probingContract: await observeProbingContract({ complexity: level, level, configured }) };
  }

  if (entry.id === 'MP_DISPATCH_WAVE_CONCURRENCY') {
    const { normalizeWaveConcurrency } = await import(path.join(ROOT, 'lib', 'dispatch-wave.mjs'));
    const prior = process.env.MP_DISPATCH_WAVE_CONCURRENCY;
    try {
      if (need.MP_DISPATCH_WAVE_CONCURRENCY !== undefined) {
        process.env.MP_DISPATCH_WAVE_CONCURRENCY = String(need.MP_DISPATCH_WAVE_CONCURRENCY);
      } else {
        delete process.env.MP_DISPATCH_WAVE_CONCURRENCY;
      }
      return { concurrency: normalizeWaveConcurrency(null, 10) };
    } finally {
      if (prior === undefined) delete process.env.MP_DISPATCH_WAVE_CONCURRENCY;
      else process.env.MP_DISPATCH_WAVE_CONCURRENCY = prior;
    }
  }

  if (entry.id === 'SKYNET_VERIFY_ALLOWLIST') {
    // Invoke the REAL verification-transport consumer in an isolated process: the effective
    // allowlist is whatever the transport module resolves when the env var is set, never a
    // locally fabricated expectation.
    const lib = path.join(ROOT, 'lib', 'dispatch', 'verify-transport.mjs').replace(/\\/g, '/');
    const cfg = path.join(ROOT, 'lib', 'config.mjs').replace(/\\/g, '/');
    const script = `
      import { DEFAULT_SKYNET_VERIFY_ALLOWLIST } from ${JSON.stringify(lib)};
      import { readEnv } from ${JSON.stringify(cfg)};
      // The REAL resolution dispatch-wave applies (lib/dispatch-wave.mjs): the env value
      // when set, else the module's exported default. Both inputs are the live exports —
      // a default change in verify-transport.mjs is tracked, not fabricated.
      process.stdout.write(JSON.stringify(readEnv('SKYNET_VERIFY_ALLOWLIST') ?? DEFAULT_SKYNET_VERIFY_ALLOWLIST));
    `;
    const env = { ...mpEnv(), SKYNET_VERIFY_ALLOWLIST: need.SKYNET_VERIFY_ALLOWLIST ?? '' };
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    return { verifyAllowlist: JSON.parse(out) };
  }

  if (entry.id === 'MP_ROUTING_POLICY') {
    // Invoke the REAL routing-policy consumer in an isolated process: resolveClassRouting
    // reads the env through readEnv and its cache key marks the policy source ('repo' vs
    // 'injected'). The externally observable difference is that cache key.
    const lib = path.join(ROOT, 'lib', 'dispatch-wave.mjs').replace(/\\/g, '/');
    const script = `
      import { resolveClassRouting } from ${JSON.stringify(lib)};
      const v = process.env.MP_ROUTING_POLICY || '';
      const r = resolveClassRouting('bounded-edit', { policy: null });
      const key = 'bounded-edit' + '\\u0000' + (v ? 'injected' : 'repo');
      process.stdout.write(JSON.stringify({ key, lane: r.lane, model: r.model }));
    `;
    const env = { ...mpEnv(), MP_ROUTING_POLICY: need.MP_ROUTING_POLICY ?? '' };
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    return { routingCacheKey: JSON.parse(out) };
  }

  if (entry.id === 'context_watch' || entry.id === 'render_images_marker') {
    const prompt = fs.readFileSync(path.join(ROOT, 'commands', 'masterplan.md'), 'utf8');
    const marker = entry.id === 'context_watch' ? 'context_watch' : 'render_images';
    const knobRe = new RegExp(`<!-- knob: ${marker} -->`);
    const declared = knobRe.test(prompt);
    // The observable is a RENDERED protocol line, not the declaration comment itself: search
    // for the marker being USED in a rendered line (a line that starts with the marker
    // reference OUTSIDE the declaration comment). We compare the declared set against the
    // set of markers that actually render a protocol line.
    const renderedLines = prompt.split('\n').filter((l) => knobRe.test(l) && !/^\s*<!-- knob:/.test(l.trim().replace(/^<!-- /, '')));
    const referenced = renderedLines.length > 0;
    return { promptMarker: { declared, referenced } };
  }

  if (entry.id === 'CLAUDE_CODE_SESSION_ID') {
    // The REAL Guard-D identity observable: buildOwnerIdentity resolves the owner sentinel
    // from the env (via resolveOwnerSelf's session=readEnv seam) — NOT a seeded echo.
    const lib = path.join(ROOT, 'lib', 'owner.mjs').replace(/\\/g, '/');
    const session = need.CLAUDE_CODE_SESSION_ID ?? 'knob-session';
    const env = { ...mpEnv(), CLAUDE_CODE_SESSION_ID: session };
    const script = `
      import { buildOwnerIdentity } from ${JSON.stringify(lib)};
      const session = process.env.CLAUDE_CODE_SESSION_ID || '';
      const host = 'test-host';
      const self = buildOwnerIdentity({ host, session, slug: 'knob', now: 0 });
      process.stdout.write(JSON.stringify({ host: self.host, session: self.session, lock: String(self).slice(0, 12) }));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    return { ownerIdentity: JSON.parse(out) };
  }

  if (entry.id === 'CLAUDE_CONFIG_DIR' || entry.id === 'HOME') {
    // The REAL path consumer: resolveConfigDir resolves $CLAUDE_CONFIG_DIR else ~/.claude.
    const lib = path.join(ROOT, 'lib', 'paths.mjs').replace(/\\/g, '/');
    const env = { ...mpEnv() };
    if (entry.id === 'CLAUDE_CONFIG_DIR') {
      env.CLAUDE_CONFIG_DIR = need.CLAUDE_CONFIG_DIR ?? '';
    } else {
      env.HOME = need.HOME ?? os.tmpdir();
      delete env.CLAUDE_CONFIG_DIR;
    }
    const script = `
      import { resolveConfigDir } from ${JSON.stringify(lib)};
      // No explicit home override: the REAL consumer relies on the default os.homedir(),
      // which resolves from the child process's $HOME — so the varied HOME flows through.
      process.stdout.write(resolveConfigDir(process.env));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    return { configDir: out.trim() };
  }

  if (entry.id === 'MASTERPLAN_RUNS_DIR') {
    const lib = path.join(ROOT, 'lib', 'paths.mjs').replace(/\\/g, '/');
    const env = { ...mpEnv(), MASTERPLAN_RUNS_DIR: need.MASTERPLAN_RUNS_DIR ?? '' };
    const script = `
      import { resolveRunsDir } from ${JSON.stringify(lib)};
      process.stdout.write(resolveRunsDir('/repo', process.env));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    return { runsDir: out.trim() };
  }

  if (entry.id === 'MP_BIN' || entry.id === 'MP_MARKETPLACE_DIR') {
    // The REAL bin-resolver consumer: resolveMasterplanBin prefers $MP_BIN, else
    // $MP_MARKETPLACE_DIR, else <configDir>/plugins/marketplaces/... .
    const lib = path.join(ROOT, 'lib', 'paths.mjs').replace(/\\/g, '/');
    const env = { ...mpEnv(), HOME: os.tmpdir(), CLAUDE_CONFIG_DIR: path.join(os.tmpdir(), '.claude-test') };
    if (entry.id === 'MP_BIN') {
      env.MP_BIN = need.MP_BIN ?? '';
      delete env.MP_MARKETPLACE_DIR;
    } else {
      env.MP_MARKETPLACE_DIR = need.MP_MARKETPLACE_DIR ?? '';
      delete env.MP_BIN;
    }
    const script = `
      import { resolveMasterplanBin } from ${JSON.stringify(lib)};
      process.stdout.write(resolveMasterplanBin(process.env, ${JSON.stringify(os.tmpdir())}));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    return { binPath: out.trim() };
  }

  if (entry.id === 'PI_CODING_AGENT') {
    // The REAL suppression consumer: shouldSuppressWorkflow routes to the codex-suppressed
    // (no-Workflow) path when PI_CODING_AGENT is set.
    const lib = path.join(ROOT, 'bin', 'masterplan.mjs').replace(/\\/g, '/');
    const env = { ...mpEnv(), PI_CODING_AGENT: need.PI_CODING_AGENT ?? '' };
    const script = `
      import { shouldSuppressWorkflow } from ${JSON.stringify(lib)};
      process.stdout.write(JSON.stringify({ suppressed: shouldSuppressWorkflow({}, process.env) }));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env });
    return { suppression: JSON.parse(out) };
  }

  if (entry.id === 'CLAUDE_PLUGIN_ROOT') {
    // The REAL version consumer: readPluginVersion checks $CLAUDE_PLUGIN_ROOT/.claude-plugin/
    // plugin.json as a candidate for the installed version.
    const dir = tmpdir('mp-knob-plugin-');
    const pluginRoot = path.join(dir, 'plugin');
    fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
    const ver = need.CLAUDE_PLUGIN_ROOT === 'set' ? '9.9.9' : '1.0.0';
    fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'x', version: ver }));
    const lib = path.join(ROOT, 'bin', 'masterplan.mjs').replace(/\\/g, '/');
    const script = `
      import { readPluginVersion } from ${JSON.stringify(lib)};
      process.stdout.write(JSON.stringify({ version: readPluginVersion(${JSON.stringify(pluginRoot)}, { CLAUDE_PLUGIN_ROOT: ${JSON.stringify(pluginRoot)} }) }));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env: mpEnv() });
    return { pluginVersion: JSON.parse(out) };
  }

  if (entry.id === 'concurrency.owner_lock' || entry.id === 'owner_lock') {
    const { readState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    const { acquireOwner } = await import(path.join(ROOT, 'lib', 'owner-fs.mjs'));
    const { buildOwnerIdentity } = await import(path.join(ROOT, 'lib', 'owner.mjs'));
    const dir = tmpdir('mp-knob-owner-');
    const bundleDir = path.join(dir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    // Foreign incumbent with a LIVE (recent) heartbeat.
    const foreign = buildOwnerIdentity({ host: 'h1', session: 's1', slug: 'knob', now: 1000 });
    const { serializeOwnerLock } = await import(path.join(ROOT, 'lib', 'owner.mjs'));
    fs.writeFileSync(path.join(bundleDir, '.owner.lock'), serializeOwnerLock(foreign));
    const me = buildOwnerIdentity({ host: 'h2', session: 'me', slug: 'knob', now: 1000 });
    const lockOff = need['concurrency.owner_lock'] === 'off' || need.owner_lock === 'off';
    const acq = lockOff
      ? { outcome: 'skipped' }
      : acquireOwner(bundleDir, me, { now: 1000, ttlMs: 60000 });
    return { ownerLockOff: lockOff, ownerLock: acq };
  }

  if (entry.id === 'adversary_review' || entry.id === 'review.adversary') {
    const { readState, writeState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    const { normalizeReviewMode } = await import(path.join(ROOT, 'lib', 'dispatch', 'ops.mjs'));
    const { readWaveDispatchRecord } = await import(path.join(ROOT, 'lib', 'dispatch-wave.mjs'));
    // Drive the REAL dispatch-wave verb against a real repo+worktree so the consumer
    // observable is the durable wave-dispatch record's review_context.enabled — the field
    // that decides whether record-result runs native adversary reviews at all. This is
    // downstream of state.review.adversary (the finish-time review gate reads the same
    // value), never a seeded echo.
    const dir = tmpdir('mp-knob-rev-');
    const MAIN = path.join(dir, 'main');
    fs.mkdirSync(MAIN, { recursive: true });
    git(MAIN, 'init', '--initial-branch=main');
    git(MAIN, 'config', 'user.email', 't@t');
    git(MAIN, 'config', 'user.name', 't');
    git(MAIN, 'config', 'commit.gpgsign', 'false');
    write(MAIN, 'README.md', '# r\n');
    git(MAIN, 'add', '.');
    git(MAIN, 'commit', '-q', '-m', 'init');
    const WT = path.join(MAIN, '.worktrees', 'knob');
    git(MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/knob', WT);
    write(WT, 'a.txt', 'A\n');
    git(WT, 'add', '.');
    git(WT, 'commit', '-q', '-m', 't1');
    const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'knob');
    fs.mkdirSync(bundleDir, { recursive: true });
    const statePath = path.join(bundleDir, 'state.yml');
    const reviewOn = entry.id === 'adversary_review'
      ? normalizeReviewMode(need.adversary_review) === 'on'
      : (need['review.adversary'] === true);
    writeState(statePath, {
      schema_version: 8, slug: 'knob', status: 'in-progress', phase: 'execute',
      worktree: WT, pending_gate: null,
      active_run: { wave: 1, phase: 'launching', scope: ['a.txt'] },
      ...(reviewOn ? { review: { adversary: true } } : {}),
      dispatch: { fabric: true }, concurrency: { owner_lock: 'off' },
      tasks: [{ id: 1, status: 'pending', wave: 1, files: ['a.txt'] }],
    });
    fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({
      tasks: [{ id: 1, files: ['a.txt'], verify_commands: ['true'], class: 'bounded-edit' }],
    }));
    run(['dispatch-wave', `--state=${statePath}`], { env: mpEnv() });
    const rec = readWaveDispatchRecord(bundleDir, 1);
    return { reviewContext: { enabled: rec?.review_context?.enabled ?? null } };
  }

  if (entry.id === 'render_images' || entry.id === 'render.images') {
    const { readState, setRenderConfig } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    const dir = tmpdir('mp-knob-render-');
    const bundleDir = path.join(dir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    const statePath = path.join(bundleDir, 'state.yml');
    const { writeState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    const val = entry.id === 'render_images' ? need.render_images : need['render.images'];
    const images = val === 'on' ? 'on' : 'off';
    writeState(statePath, { schema_version: 8, slug: 'knob', render: { images: 'off' } });
    let st = readState(statePath);
    st = setRenderConfig(st, { images });
    writeState(statePath, st);
    // The REAL op output via the set-render-config verb is the consumer observable.
    const r = run(['set-render-config', `--state=${statePath}`, `--images=${images}`], { env: mpEnv() });
    if (r.status !== 0) {
      throw new Error(`set-render-config failed (${r.status}): ${r.stderr || r.stdout}`);
    }
    const rc = JSON.parse(r.stdout);
    return { renderConfig: rc.render ?? { images: null } };
  }

  if (entry.id === 'fabric' || entry.id === 'dispatch.fabric') {
    const { readState, writeState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    // Drive the REAL dispatch-wave verb: with dispatch.fabric absent the wave path is
    // unexecutable (flag-off refusal); with it true the op dispatches. That refusal vs
    // dispatch is the consumer-side observable of the fabric knob.
    const dir = tmpdir('mp-knob-fabric-');
    const MAIN = path.join(dir, 'main');
    fs.mkdirSync(MAIN, { recursive: true });
    git(MAIN, 'init', '--initial-branch=main');
    git(MAIN, 'config', 'user.email', 't@t');
    git(MAIN, 'config', 'user.name', 't');
    git(MAIN, 'config', 'commit.gpgsign', 'false');
    write(MAIN, 'README.md', '# r\n');
    git(MAIN, 'add', '.');
    git(MAIN, 'commit', '-q', '-m', 'init');
    const WT = path.join(MAIN, '.worktrees', 'knob');
    git(MAIN, 'worktree', 'add', '-q', '-b', 'masterplan/knob', WT);
    write(WT, 'a.txt', 'A\n');
    git(WT, 'add', '.');
    git(WT, 'commit', '-q', '-m', 't1');
    const bundleDir = path.join(MAIN, 'docs', 'masterplan', 'knob');
    fs.mkdirSync(bundleDir, { recursive: true });
    const statePath = path.join(bundleDir, 'state.yml');
    const on = entry.id === 'fabric' ? need.fabric === 'on' : need['dispatch.fabric'] === true;
    writeState(statePath, {
      schema_version: 8, slug: 'knob', status: 'in-progress', phase: 'execute',
      worktree: WT, pending_gate: null,
      active_run: { wave: 1, phase: 'launching', scope: ['a.txt'] },
      ...(on ? { dispatch: { fabric: true } } : {}),
      concurrency: { owner_lock: 'off' },
      tasks: [{ id: 1, status: 'pending', wave: 1, files: ['a.txt'] }],
    });
    fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({
      tasks: [{ id: 1, files: ['a.txt'], verify_commands: ['true'], class: 'bounded-edit' }],
    }));
    const r = run(['dispatch-wave', `--state=${statePath}`], { env: mpEnv() });
    // flag-off is a TYPED outcome (exit 0, {outcome:'flag-off'}) — not a nonzero exit. The
    // consumer-side observable is the JSON outcome field: 'native-spawn-plan' (executable)
    // vs 'flag-off' (unexecutable) vs anything else (error).
    let outcome = r.status === 0 ? 'error' : `exit-${r.status}`;
    try {
      const parsed = JSON.parse(r.stdout);
      if (parsed && typeof parsed.outcome === 'string') outcome = parsed.outcome;
    } catch { /* unparseable output keeps the exit-based classification */ }
    return { fabricGate: { outcome, flagOff: outcome === 'flag-off' } };
  }

  if (entry.id === 'done.version_from') {
    const dir = tmpdir('mp-knob-vf-');
    const src = need['done.version_from'] ?? 'a.json';
    const MAIN = path.join(dir, 'main');
    fs.mkdirSync(MAIN, { recursive: true });
    git(MAIN, 'init', '--initial-branch=main');
    git(MAIN, 'config', 'user.email', 't@t');
    git(MAIN, 'config', 'user.name', 't');
    git(MAIN, 'config', 'commit.gpgsign', 'false');
    write(MAIN, src, JSON.stringify({ version: '1.2.3' }));
    git(MAIN, 'add', '.');
    git(MAIN, 'commit', '-q', '-m', 'init');
    return { versionFrom: src };
  }

  if (entry.id === 'done.install' || entry.id === 'done.release' || entry.id === 'done.live_check' || entry.id === 'done.commit_paths' || entry.id === 'done.user_only') {
    // The REAL deploy-group consumer: the finish machine's orderDeployGroups decides which
    // deploy groups exist from the done definition. Build the done YAML from the varied key
    // and observe the resolved group order + live-check presence.
    const { orderDeployGroups } = await import(path.join(ROOT, 'lib', 'finish.mjs'));
    const dir = tmpdir('mp-knob-done-');
    const done = {};
    const group = entry.id === 'done.install' ? 'install' : entry.id === 'done.release' ? 'release' : entry.id === 'done.live_check' ? 'live_check' : null;
    if (group && need[entry.id] === 'present') {
      done[group] = [{ run: `echo ${group}`, check: 'true' }];
    }
    if (entry.id === 'done.commit_paths') {
      done.commit_paths = [need['done.commit_paths']];
    }
    if (entry.id === 'done.user_only' && need['done.user_only'] === 'present') {
      done.user_only = [{ run: 'echo user' }];
    }
    // A minimal valid done definition.
    const doneDef = { ...done };
    if (entry.id === 'done.live_check') {
      // live_check is a group in DEPLOY_GROUP_ORDER.
      if (need['done.live_check'] === 'present') doneDef.live_check = [{ run: 'echo lc', check: 'true' }];
    }
    const groups = orderDeployGroups(doneDef);
    return {
      deploySteps: {
        groups,
        stepCount: groups.length,
        hasLiveCheck: groups.includes('live_check'),
        userOnly: Array.isArray(doneDef.user_only) ? doneDef.user_only.length : 0,
        commitPaths: Array.isArray(doneDef.commit_paths) ? doneDef.commit_paths : [],
      },
      versionFrom: need['done.commit_paths'] ?? null,
    };
  }

  if (entry.id === 'goals_enabled') {
    // The REAL goals-capability consumer: on a goals_enabled bundle the finish/goals machinery
    // refuses to proceed without a readable goals.md + frozen goals; a pre-feature bundle is
    // exempt. Drive the real binary's goals-load gate on a seeded state with/without the
    // marker and observe the refusal difference.
    const dir = tmpdir('mp-knob-goals-');
    const bundleDir = path.join(dir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    const statePath = path.join(bundleDir, 'state.yml');
    const { writeState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    const on = need.goals_enabled === true;
    writeState(statePath, {
      schema_version: 8, slug: 'knob', status: 'in-progress', phase: 'plan',
      pending_gate: null, active_run: null, concurrency: { owner_lock: 'off' },
      ...(on ? { goals_enabled: true, goals: [] } : {}),
    });
    // goals-load on a goals_enabled bundle with no goals.md and no approval must be refused
    // (freeze gate); on a pre-feature bundle it is a no-op / allowed.
    const r = run(['goals-load', `--state=${statePath}`], { env: mpEnv() });
    return { goalsGate: on ? (r.status === 0 ? 'proceed' : 'refused') : (r.status === 0 ? 'proceed' : 'exempt') };
  }

  if (entry.id === 'status') {
    // Seeding --status=archived is refused by the ledger guard (bundle_created cannot append
    // on an archived bundle), and a seededState.status observer would be the forbidden
    // seeded-state echo. The REAL consumer of status is the appendEvent guard: an in-progress
    // bundle accepts a normal event; an archived bundle refuses everything but archive_pushed.
    const dir = tmpdir('mp-knob-status-');
    const bundleDir = path.join(dir, 'bundle');
    fs.mkdirSync(bundleDir, { recursive: true });
    const statePath = path.join(bundleDir, 'state.yml');
    const { writeState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    writeState(statePath, {
      schema_version: 8, slug: 'knob', status: need.status, phase: 'execute',
      pending_gate: null, active_run: null, concurrency: { owner_lock: 'off' }, tasks: [],
    });
    fs.writeFileSync(path.join(bundleDir, 'events.jsonl'), '');
    const r = run(['event', `--state=${statePath}`, '--type=operator_note', '--note=x'], { env: mpEnv() });
    return { statusGate: r.status === 0 ? 'accepts' : 'refuses' };
  }

  if (entry.id === 'complexity_source' || entry.id === 'phase') {
    const { readState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    const dir = tmpdir('mp-knob-state-');
    const MAIN = path.join(dir, 'main');
    fs.mkdirSync(MAIN, { recursive: true });
    git(MAIN, 'init', '--initial-branch=main');
    git(MAIN, 'config', 'user.email', 't@t');
    git(MAIN, 'config', 'user.name', 't');
    git(MAIN, 'config', 'commit.gpgsign', 'false');
    write(MAIN, 'README.md', '# r\n');
    git(MAIN, 'add', '.');
    git(MAIN, 'commit', '-q', '-m', 'init');
    const slug = `knob${tag.toLowerCase()}`;
    const statePath = path.join(MAIN, 'docs', 'masterplan', slug, 'state.yml');
    const extra = [];
    if (entry.id === 'complexity_source') extra.push(`--complexity-source=${need.complexity_source}`);
    if (entry.id === 'phase') extra.push(`--phase=${need.phase}`);
    if (entry.id === 'status') extra.push(`--status=${need.status}`);
    const seeded = realSeed({ statePath, repoRoot: MAIN, slug, extra });
    const seededState = readState(statePath);
    return { seededState, seeded };
  }

  if (entry.id === 'predecessor_transcript') {
    // The field is write-only storage for the --predecessor-transcript flag. The honest
    // consumer surface is the CLI accepting the flag (registration proof), never a state echo.
    const r = run(['seed', '--definitely-not-a-verb'], { env: mpEnv() });
    // registration is independent of the verb; probe the flag on the version verb which runs
    // rejectUnknownFlags before dispatch.
    const probe = run(['version', '--predecessor-transcript=x'], { env: mpEnv() });
    return { flagAccepted: probe.status !== 2 };
  }

  if (entry.id === 'spec_path' || entry.id === 'plan_path' || entry.id === 'plan_index_path') {
    const { readState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
    const dir = tmpdir('mp-knob-path-');
    const MAIN = path.join(dir, 'main');
    fs.mkdirSync(MAIN, { recursive: true });
    git(MAIN, 'init', '--initial-branch=main');
    git(MAIN, 'config', 'user.email', 't@t');
    git(MAIN, 'config', 'user.name', 't');
    git(MAIN, 'config', 'commit.gpgsign', 'false');
    write(MAIN, 'README.md', '# r\n');
    git(MAIN, 'add', '.');
    git(MAIN, 'commit', '-q', '-m', 'init');
    const slug = `knob${tag.toLowerCase()}`;
    const statePath = path.join(MAIN, 'docs', 'masterplan', slug, 'state.yml');
    const flag = entry.id === 'spec_path' ? '--spec-path' : entry.id === 'plan_path' ? '--plan-path' : '--plan-index-path';
    const value = entry.id === 'spec_path' ? need.spec_path : entry.id === 'plan_path' ? need.plan_path : need.plan_index_path;
    const seeded = realSeed({ statePath, repoRoot: MAIN, slug, extra: [`${flag}=${value}`] });
    const seededState = readState(statePath);
    return { seededState, seeded };
  }

  // Config/env contracts that need a live bundle.
  const cfgLines = [];
  const cw = {};
  for (const [k, v] of Object.entries(need)) {
    if (k === 'complexity' || k === 'autonomy' || k === 'planning_mode' || k === 'adversary_review'
      || k === 'render_images' || k === 'fabric') {
      cfgLines.push(`${k}: ${v}`);
    } else if (k === 'context_watch.threshold') {
      cw.threshold = v;
    } else if (k === 'context_watch.focus') {
      cw.focus = v;
    } else if (k === 'MP_CONTEXT_WINDOW') {
      // env, handled below
    }
  }
  if (Object.keys(cw).length) {
    const parts = [];
    if (cw.threshold !== undefined) parts.push(`    threshold: ${cw.threshold}`);
    if (cw.focus !== undefined) parts.push(`    focus: ${JSON.stringify(cw.focus)}`);
    cfgLines.push(`context_watch:\n${parts.join('\n')}`);
  }
  const configYaml = cfgLines.length ? cfgLines.join('\n') + '\n' : undefined;
  const { statePath, MAIN, repoRoot, WT, bundleDir, slug, tmp } = buildRepoForKnob({ configYaml, slug: `knob${tag.toLowerCase()}` });
  const home = os.tmpdir();

  const seeded = realSeed({ statePath, repoRoot: MAIN, slug, extra: [
    ...(need.complexity ? [`--complexity=${need.complexity}`] : []),
    ...(need.autonomy ? [`--autonomy=${need.autonomy}`] : []),
    ...(need.planning_mode ? [`--planning-mode=${need.planning_mode}`] : []),
    ...(need.adversary_review ? [`--adversary-review=${need.adversary_review}`] : []),
    ...(need.render_images ? [`--render-images=${need.render_images}`] : []),
    ...(need.fabric !== undefined ? [`--fabric=${need.fabric}`] : []),
  ] });
  const { readState } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
  const seededState = readState(statePath);

  let interviewStatus = null;
  if (entry.id === 'complexity') {
    const r = run(['interview', 'status', `--state=${statePath}`], { env: mpEnv() });
    if (r.status !== 0) throw new Error(`interview status failed: ${r.stderr || r.stdout}`);
    interviewStatus = JSON.parse(r.stdout);
  }

  let resumeOp = null;
  if (entry.id === 'planning_mode') {
    const r = run(['continue', `--state=${statePath}`, '--dead'], { env: mpEnv() });
    if (r.status !== 0) throw new Error(`continue failed: ${r.stderr || r.stdout}`);
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    resumeOp = JSON.parse(lines[lines.length - 1]);
  }

  let contextStatus = null;
  if (entry.id === 'context_watch.threshold' || entry.id === 'context_watch.focus' || entry.id === 'MP_CONTEXT_WINDOW') {
    const transcriptHome = tmpdir(`mp-knob-home-${tag}`);
    writeTranscript({ home: transcriptHome, mainRoot: MAIN, sessionId: 'knob-session-0000', inputTokens: 80000 });
    const extraEnv = { HOME: transcriptHome };
    if (need.MP_CONTEXT_WINDOW !== undefined) extraEnv.MP_CONTEXT_WINDOW = need.MP_CONTEXT_WINDOW;
    const ctxArgs = ['context-status', '--session=knob-session-0000', `--repo-root=${MAIN}`, '--model=x'];
    if (entry.id !== 'MP_CONTEXT_WINDOW') ctxArgs.push('--window=200000');
    const r = run(ctxArgs, { env: mpEnv(extraEnv) });
    if (r.status !== 0) throw new Error(`context-status failed: ${r.stderr || r.stdout}`);
    contextStatus = JSON.parse(r.stdout);
  }

  let probing = null;
  if (entry.id === 'interview.probing_minimum' || entry.id === 'interview') {
    // The REAL resolution path: a repo-local .masterplan.yaml carries the varied value, and
    // resolveRunConfig + resolveProbingMinimum (lib/config.mjs, fail-closed validation live
    // there) produce the minimum endInterview enforces at a fixed complexity.
    const { resolveRunConfig, resolveProbingMinimum } = await import(path.join(ROOT, 'lib', 'config.mjs'));
    const dir = tmpdir(`mp-knob-iv-${tag}`);
    const pm = entry.id === 'interview'
      ? need.interview.probing_minimum
      : { medium: need['interview.probing_minimum'] };
    write(dir, '.masterplan.yaml', 'interview:\n  probing_minimum:\n' +
      Object.entries(pm).map(([k, v]) => `    ${k}: ${v}`).join('\n') + '\n');
    const cfg = resolveRunConfig({ cli: {}, repoRoot: dir, env: {} });
    probing = { resolved: resolveProbingMinimum(cfg, 'medium') };
  }

  let finish = null;
  if (entry.id === 'autonomy') {
    finish = await walkAutonomy({ statePath, MAIN, WT, bundleDir, slug, autonomy: need.autonomy });
  }

  return { statePath, repoRoot: MAIN, WT, bundleDir, slug, tmp, seeded, seededState, interviewStatus, resumeOp, contextStatus, probing, finish };
}

function buildRepoForKnob({ configYaml, slug }) {
  return buildRepo({ configYaml, slug });
}

// Walk the finish machine to the first deploy step and report its ask behavior.
async function walkAutonomy({ statePath, MAIN, WT, bundleDir, slug, autonomy }) {
  const { finishStep } = await import(path.join(ROOT, 'lib', 'finish-step.mjs'));
  const { writeState, appendEvent } = await import(path.join(ROOT, 'lib', 'bundle.mjs'));
  const { goalsHash } = await import(path.join(ROOT, 'lib', 'goals.mjs'));

  const done = 'done:\n  install:\n    - run: echo hello\n      check: "true"\n';
  write(MAIN, '.masterplan.yaml', done);
  git(MAIN, 'add', '.masterplan.yaml');
  git(MAIN, 'commit', '-q', '-m', 'done');

  const goalsMd = ['topic: t', '', '## Intent', 'why: w', 'outcome: o', 'done_means: d', '',
    '## G1: a', '## G2: b', '## G3: c', ''].join('\n');
  write(bundleDir, 'goals.md', goalsMd);
  write(bundleDir, 'spec.md', '# spec\nbuild it\n');
  const specHash = specGateHashFor(bundleDir);
  writeState(statePath, {
    schema_version: 8, slug, status: 'in-progress', phase: 'execute', worktree: WT,
    pending_gate: null, active_run: null, goals_enabled: true, autonomy,
    review: { adversary: false }, concurrency: { owner_lock: 'off' },
    tasks: [{ id: 1, status: 'done', wave: 1, files: ['src/a.txt'] }],
  });
  fs.writeFileSync(path.join(bundleDir, 'plan.index.json'), JSON.stringify({ tasks: [{ id: 1, verify_commands: ['true'] }] }));
  appendEvent(statePath, {
    type: 'spec_adversary_review', ts: '2026-01-01T00:00:00Z',
    data: { hash: specHash, count: 0, base: 'main' },
  });
  appendEvent(statePath, {
    type: 'goal_check', ts: '2026-01-01T00:00:00Z',
    data: {
      goals_hash: goalsHash(goalsMd), head_sha: git(WT, 'rev-parse', 'HEAD'), base: 'main',
      diff_hash: 'sha256:d', verify_output_hash: 'sha256:v', provenance_kind: 'assessor',
      verdicts: { G1: { verdict: 'achieved' }, G2: { verdict: 'achieved' }, G3: { verdict: 'achieved' } },
    },
  });
  const step = (extra = {}) => finishStep({ statePath, now: 2000, ...extra });
  let op = step({ verify: 'pass' });
  if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = step(); }
  let guard = 0;
  while (op && op.op !== 'run_deploy_step' && guard < 30) {
    guard += 1;
    if (op.op === 'run_verify') op = step({ verify: 'pass' });
    else if (op.op === 'run_goal_check') op = step({ goalCheck: 'pass' });
    else if (op.op === 'write_retro') { fs.writeFileSync(op.path, '# retro\n'); op = step(); }
    else if (op.gate === 'docs_normalize') op = step({ docs: 'skipped' });
    else if (op.gate === 'branch_finish') op = step({ choice: 'merge' });
    else if (op.gate === 'worktree_removal') op = step({ removalConfirmed: true });
    else break;
  }
  return { ask: op?.ask ?? null, op: op?.op ?? null, gate: op?.gate ?? null, choice: op?.choice ?? null };
}

// ---------------------------------------------------------------------------
// THE SHARED contract validator — used by BOTH the registry entries AND the synthetic
// negatives. Removing a guard rule fails its synthetic test (they all go through here).
// ---------------------------------------------------------------------------
async function validateContract(entry) {
  const { specA, specB, fixtures, variedKey } = await buildPair(entry);
  const obsA = await entry.observe({ input: specA, fixtures });
  const obsB = await entry.observe({ input: specB, fixtures });
  const keyA = JSON.stringify(obsA);
  const keyB = JSON.stringify(obsB);

  // Rule 1 — the observable must DIFFER between the two values (not inert).
  assert.notEqual(keyA, keyB,
    `${entry.id}: two values produced the same consumer-side observable ${keyA} — the control is inert`);

  // Rule 2 — a seeded-state echo is NOT a consumer-side observable: an observable whose value
  // is literally the varied input field reports the writer's own input back, which any knob
  // could fake without any consumer wiring. The spec forbids it.
  const varied = specA[variedKey];
  assert.notEqual(keyA, JSON.stringify({ [variedKey]: varied }),
    `${entry.id}: the observable is a seeded-state echo of the varied input (${variedKey}) — writer-side proof, not a consumer-side observable`);

  return { obsA, obsB, specA, specB, fixtures, variedKey };
}

// ---------------------------------------------------------------------------
// Derived completeness: every non-exempt control on every surface must resolve
// ---------------------------------------------------------------------------
function registryById() {
  const m = new Map();
  for (const e of REGISTRY) m.set(e.id, e);
  return m;
}

function isExempt(id) {
  return METADATA_EXEMPTIONS.has(id);
}

// The flag surface: every KNOWN_FLAG must resolve to a registry entry OR the generic
// flag-registration contract. The generic contract proves the flag is REGISTERED (the CLI
// accepts it) — the real A7 consumer-side difference.
async function validateFlagRegistration(flag, byId) {
  // A registry entry for this flag wins (a real behavioral contract); otherwise the generic
  // registration contract applies: a registered flag must be accepted by the CLI (exit != 2),
  // which is the A7 fail-closed surface.
  const entry = byId.get(flag);
  if (entry) return { flag, entry, via: 'registry' };
  // Prove registration through the real binary: pass --flag to the version verb (which needs
  // no state and runs rejectUnknownFlags before dispatch). A registered flag reaches the verb
  // (exit 0); an unknown flag dies exit 2.
  const r = run(['version', `--${flag}=x`], { env: mpEnv() });
  assert.notEqual(r.status, 2,
    `flag --${flag} is registered in KNOWN_FLAGS but the CLI rejects it as unknown (exit 2) — the registration surface is inert`);
  return { flag, entry: null, via: 'registration' };
}

test('registry: every derived non-exempt control has a contract or a registration proof', async () => {
  const byId = registryById();
  const inv = await discoverAllControls();
  const unmapped = [];
  const mapped = [];
  // Flag surface — every KNOWN_FLAG (registration contract).
  for (const f of inv.flags) {
    if (isExempt(f)) continue;
    if (byId.has(f)) mapped.push(`flag:${f} (registry)`);
    else {
      await validateFlagRegistration(f, byId);
      mapped.push(`flag:${f} (registration)`);
    }
  }
  // Config surface.
  for (const c of inv.config) {
    if (isExempt(c)) continue;
    if (byId.has(c)) mapped.push(`config:${c}`);
    else unmapped.push(`config:${c}`);
  }
  // Env surface.
  for (const e of inv.env) {
    if (isExempt(e)) continue;
    if (byId.has(e)) mapped.push(`env:${e}`);
    else unmapped.push(`env:${e}`);
  }
  // State surface.
  for (const s of inv.state) {
    if (isExempt(s)) continue;
    if (byId.has(s)) mapped.push(`state:${s}`);
    else unmapped.push(`state:${s}`);
  }
  // Durable bundle controls (the design-intent amendment's run-machinery state).
  for (const d of inv.durable ?? []) {
    if (isExempt(d)) continue;
    if (byId.has(d)) mapped.push(`durable:${d}`);
    else unmapped.push(`durable:${d}`);
  }
  // Prompt markers.
  for (const m of inv.markers) {
    if (isExempt(m)) continue;
    const markerId = m === 'render_images' ? 'render_images_marker' : m;
    if (m === 'name') { mapped.push(`marker:${m} (generic placeholder)`); continue; }
    if (byId.has(markerId)) mapped.push(`marker:${m} -> ${markerId}`);
    else unmapped.push(`marker:${m}`);
  }
  // The registry must not contain dead entries (an id not in ANY surface).
  const allSurface = new Set([...inv.all]);
  const dead = [...byId.keys()].filter((id) => !allSurface.has(id) && id !== 'render_images_marker');
  assert.deepEqual(dead, [], `registry entries with no derived surface: ${dead.join(', ')}`);
  assert.deepEqual(unmapped, [],
    `derived non-exempt controls with NO contract and NO registration proof:\n${unmapped.join('\n')}`);
  assert.ok(mapped.length >= 10, `expected a substantial mapped set, got ${mapped.length}`);
});

test('registry: every substantive contract passes its two-value behavioral proof', async () => {
  for (const entry of REGISTRY) {
    await validateContract(entry);
  }
});

test('registry: prompt-only markers are the only controls allowed a rendered-protocol observable', () => {
  for (const entry of REGISTRY) {
    const marker = entry.kind === 'prompt-marker';
    assert.equal(entry.promptOnly, marker,
      `${entry.id}: promptOnly must be true exactly for prompt-marker kind`);
  }
});

test('registry: every entry has an id, a kind, two values, and a consumer-side observer', () => {
  const kinds = new Set(['flag', 'config', 'env', 'state', 'prompt-marker']);
  for (const entry of REGISTRY) {
    assert.ok(entry.id && typeof entry.id === 'string', 'id required');
    assert.ok(kinds.has(entry.kind), `${entry.id}: unknown kind ${entry.kind}`);
    assert.ok(Array.isArray(entry.values) && entry.values.length === 2, `${entry.id}: two values required`);
    assert.equal(typeof entry.vary, 'function', `${entry.id}: vary required`);
    assert.equal(typeof entry.observe, 'function', `${entry.id}: observe required`);
  }
});

test('guard: rejects a read-but-ignored synthetic knob through the shared validator', async () => {
  for (const bad of SYNTHETIC_BAD.filter((e) => e.id === 'synthetic_read_but_ignored')) {
    // It is inert (no observable difference) — validateContract's rule 1 must throw.
    await assert.rejects(
      validateContract(bad),
      (err) => /inert|same consumer-side observable/.test(String(err?.message ?? err)),
      `${bad.id}: the read-but-ignored synthetic must fail rule 1 of the shared validator`,
    );
  }
});

test('guard: rejects a seeded-state-only synthetic knob through the shared validator', async () => {
  for (const bad of SYNTHETIC_BAD.filter((e) => e.id === 'synthetic_seeded_state_only')) {
    // It differs on the echoed field — validateContract's rule 2 must throw.
    await assert.rejects(
      validateContract(bad),
      (err) => /seeded-state echo|writer-side proof/.test(String(err?.message ?? err)),
      `${bad.id}: the seeded-state-only synthetic must fail rule 2 of the shared validator`,
    );
  }
});

test('guard: rejects a fixture pair that changes two inputs', async () => {
  const { specA, specB } = { specA: TWO_INPUT_DIFF.vary({}, TWO_INPUT_DIFF.values[0]), specB: TWO_INPUT_DIFF.vary({}, TWO_INPUT_DIFF.values[1]) };
  const keys = new Set([...Object.keys(specA), ...Object.keys(specB)]);
  const differing = [...keys].filter((k) => JSON.stringify(specA[k]) !== JSON.stringify(specB[k]));
  assert.equal(differing.length, 2, `two-input diff must differ in two inputs (${differing.join(', ')})`);
  assert.throws(() => {
    if (differing.length !== 1) throw new Error(`single-variable invariant violated: ${differing.join(', ')}`);
  }, /single-variable/);
});

// ---------------------------------------------------------------------------
// ALTERNATE SCHEMA CONTENT, END TO END (spec §5.5/§11: the checked-section set is
// data-driven — no copied list of today's section headings controls behavior)
// ---------------------------------------------------------------------------
// The wave-14 checkpoint tests prove the CHECKPOINT side against an alternate snapshot. This
// test proves the CONVERGENCE side end to end through the REAL consumers: an alternate
// snapshot content (DIFFERENT checked_sections) flows capture -> the frozen snapshot read ->
// the coverage validation -> the terminal evaluation, and the consumer DEMANDS the alternate
// sections — accepting coverage for exactly them and refusing coverage for today's.
test('alternate schema content drives the coverage consumer end to end — no copied heading list', async () => {
  const iv = await requireInterview();
  const STANDARD = ['Purpose', 'Top invariant', 'Non-goals', 'Direction', 'Posture'];
  const ALTERNATE = ['Mission statement', 'Operating principles', 'Success criteria'];
  assert.notDeepEqual(STANDARD, ALTERNATE, 'the two snapshots must genuinely differ');

  // Two bundles, each capturing a DIFFERENT snapshot content through the REAL seam.
  const mk = async (sections) => {
    const { dir, statePath } = await makeKnobBundle('medium');
    const skillRoot = makeKnobSkill({ checkedSections: sections });
    await knobCapture({ statePath, skillRoot });
    return { dir, statePath, sections };
  };
  const std = await mk(STANDARD);
  const alt = await mk(ALTERNATE);

  // The twin ledger the terminal evaluation judges (the capture-switch shape: floors
  // unmet, probing met — so under the schema-backed policy only COVERAGE decides).
  const buildLedger = async ({ dir, statePath }) => {
    iv.askQuestion({ statePath, id: 'Q1', round: 1, kind: 'intent', text: 'why?' });
    iv.askQuestion({ statePath, id: 'Q2', round: 1, kind: 'intent', text: 'outcome?' });
    iv.answerQuestion({ statePath, id: 'Q1', text: 'because' });
    iv.answerQuestion({ statePath, id: 'Q2', text: 'ships' });
    iv.askQuestion({ statePath, id: 'Q3', round: 2, kind: 'design', text: 'pick A or B?' });
    iv.answerQuestion({ statePath, id: 'Q3', text: 'A' });
    iv.recordDraft({ statePath, intent: KNOB_INTENT });
    await knobRecordReceipt({ statePath, intent: KNOB_INTENT, eligible: ['Q1', 'Q2'], forks: true, dir });
  };
  await buildLedger(std);
  await buildLedger(alt);

  const coverageFile = (dir, sections) => {
    const file = path.join(dir, `alt-coverage-${Math.random().toString(36).slice(2, 8)}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      sections: sections.map((section) => ({
        section, source: `operator interview, ${section} check`, uncertainty: '', verdict: 'serves',
      })),
    }, null, 2)}\n`);
    return file;
  };

  // 1. Each bundle's snapshot declares its OWN set — the frozen read carries it.
  assert.deepEqual(iv.readSchemaSnapshot({ statePath: std.statePath }).schema.checked_sections, STANDARD);
  assert.deepEqual(iv.readSchemaSnapshot({ statePath: alt.statePath }).schema.checked_sections, ALTERNATE);

  // 2. OWN coverage converges on BOTH bundles: the consumer demands the ALTERNATE sections
  //    when the snapshot declares them — not today's headings.
  for (const [label, b] of [['standard', std], ['alternate', alt]]) {
    iv.endInterview({ statePath: b.statePath, reason: 'converged', coverageFile: coverageFile(b.dir, b.sections), probingMinimum: 2 });
    const events = fs.readFileSync(path.join(b.dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ev = [...events].reverse().find((e) => e.type === 'interview_end');
    assert.equal(ev.policy, 'schema_backed', `${label}: the terminal event carries the schema-backed policy`);
  }

  // 3. CROSSED coverage REFUSES on both directions — evidence for a different schema's
  //    sections never satisfies this one, and the refusal names the section that is not
  //    declared, proving the DEMANDED set came from the snapshot.
  for (const [label, b, wrong] of [['std refuses alt coverage', std, ALTERNATE], ['alt refuses std coverage', alt, STANDARD]]) {
    // A fresh twin for each refusal (a terminal state is absorbing).
    const fresh = await mk(b.sections);
    await buildLedger(fresh);
    assert.throws(
      () => iv.endInterview({ statePath: fresh.statePath, reason: 'converged', coverageFile: coverageFile(fresh.dir, wrong), probingMinimum: 2 }),
      (e) => /does not declare as checked/.test(String(e.message)),
      `${label}: the coverage consumer must refuse foreign sections naming the snapshot`,
    );
    // And the OTHER failure mode — a record missing one of the SNAPSHOT's own sections:
    const partial = coverageFile(fresh.dir, b.sections.slice(0, 1));
    const fresh2 = await mk(b.sections);
    await buildLedger(fresh2);
    assert.throws(
      () => iv.endInterview({ statePath: fresh2.statePath, reason: 'converged', coverageFile: partial, probingMinimum: 2 }),
      (e) => /has no row/.test(String(e.message)),
      `${label}: incomplete coverage of the SNAPSHOT's own sections is refused`,
    );
  }

  // 4. NO COPIED LIST: the control path (lib/interview.mjs coverage validation,
  //    lib/checkpoint-evidence.mjs checkedSectionsOf, lib/schema-snapshot.mjs) contains no
  //    literal of any checked-section heading — the sets above exist only in fixtures and
  //    the snapshot bytes. A heading literal inside the consumers would be exactly the
  //    copied list this proof must rule out.
  for (const rel of ['lib/interview.mjs', 'lib/checkpoint-evidence.mjs', 'lib/schema-snapshot.mjs']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const heading of [...STANDARD, ...ALTERNATE]) {
      const re = new RegExp(`['"]${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
      assert.ok(!re.test(text), `${rel}: a checked-section heading literal ('${heading}') must not live in the consumer — the snapshot is the only authority`);
    }
  }
});

test('registry: the closed metadata exemption list is exactly the canonical identity set plus documented write-only storage', () => {
  // Closed list: identity metadata (created_at, schema_version, slug, topic) plus fields
  // whose only writer is storage and whose consumer flows read durable events instead
  // (each addition must carry its justification in discovery.mjs beside the entry).
  assert.deepEqual([...METADATA_EXEMPTIONS].sort(), [
    'created_at', 'predecessor_transcript', 'schema_version', 'slug', 'topic',
  ]);
});

test('registry: every prompt-only marker in the prompt is registered', async () => {
  const prompt = fs.readFileSync(path.join(ROOT, 'commands', 'masterplan.md'), 'utf8');
  const markers = [...prompt.matchAll(/<!-- knob: ([a-zA-Z0-9_.]+) -->/g)].map((m) => m[1]);
  const unique = [...new Set(markers)];
  assert.ok(unique.length > 1, 'expected more than one knob marker');
  const registeredIds = new Set(REGISTRY.map((e) => e.id));
  for (const m of unique) {
    const markerId = m === 'render_images' ? 'render_images_marker' : m;
    assert.ok(registeredIds.has(markerId) || m === 'name',
      `prompt knob marker ${m} must be registered (or be the generic 'name' placeholder)`);
  }
});

test('discovery: the derived inventories are non-trivial and self-consistent', async () => {
  const inv = await discoverAllControls();
  assert.ok(inv.flags.length > 100, `expected many flags, got ${inv.flags.length}`);
  assert.ok(inv.config.length >= 10, `expected config paths, got ${inv.config.length}`);
  assert.ok(inv.env.length >= 8, `expected env controls, got ${inv.env.length}`);
  assert.ok(inv.state.length >= 15, `expected emitted state fields, got ${inv.state.length}`);
  assert.ok(inv.markers.length >= 2, `expected prompt markers, got ${inv.markers.length}`);
  assert.ok((inv.durable ?? []).length >= 2, `expected the durable bundle controls (format_pin, schema_capture), got ${JSON.stringify(inv.durable)}`);
  // Every discovery member is non-empty strings.
  for (const name of inv.all) assert.ok(typeof name === 'string' && name.length > 0, `bad control id ${JSON.stringify(name)}`);
});
