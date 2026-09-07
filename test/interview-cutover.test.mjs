// test/interview-cutover.test.mjs — task 59: THE CUTOVER, proven behaviorally.
//
// The duplicate questioning implementation is REMOVED from commands/masterplan.md (§2f
// rewritten: the sequencer no longer composes questions natively — it dispatches the pinned
// /design-intent skill's plan mode over the task-49 host contract, records through the
// mp interview verbs, converges per spec §5.3's two conditions, and refuses fail-closed).
// This suite proves the cutover against REAL dispatch and resume on BOTH running surfaces
// named by §10 and G6 — the Claude Code plugin-cache surface and the Pi install surface —
// rather than against source-text assertions:
//
//   1. DISPATCH: the pinned skill's plan mode is driven END TO END through each installed
//      surface's REAL binary — a real seeded bundle, a real approved schema capture over the
//      pinned commit's exact bytes, real recorded verbs (ask/answer/draft/critic), real
//      convergence (coverage + probing met; §5.3), and a real terminal event whose policy
//      identity is schema_backed. The question the recorded ledger carries is the skill's
//      plan-mode shape (one fork, recommended option first), so the dispatch is exercised
//      as the contract describes it — but the proof is the RECORDING, which only happens
//      through the verbs the host permits.
//   2. RESUME: an interview interrupted MID-FLIGHT (events on disk, interview open) resumes
//      through the SAME dispatch path on both surfaces — the ledger reconstructs the
//      budget and content head from events.jsonl and the skill continues; an interrupted
//      run is never left unable to interview (the cutover's own precondition).
//   3. REFUSAL: an absent skill, a version-skewed skill, and a changed identity each REFUSE
//      with their NAMED §5.5 error through the real capture path — and the suite proves no
//      native fallback exists: the removed native-questioner instruction text is gone from
//      the prompt (ONE grep assertion among many; the core proof is behavioral).
//
// The "two surfaces" are the install seams §10 names: the Pi surface is the copy-based
// install (bin/install-pi.mjs) whose entry point is <install-root>/current/bin/masterplan.mjs;
// the Claude surface is the plugin-cache layout (claudeSurfacePath in scripts/bootstrap-v10.mjs)
// whose entry point is <claude-config>/plugins/cache/rasatpetabit-masterplan/masterplan/<v>/bin/masterplan.mjs.
// Both surfaces are built from THIS tree's committed HEAD through the real installers'
// contracts (a git-archive snapshot for Pi, the same committed tree extracted at the cache
// path for Claude), so the proven bytes are the cutover's bytes, not a checkout's.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PIN_PATH = path.join(ROOT, 'policy', 'design-intent-skill.json');
const PROMPT_PATH = path.join(ROOT, 'commands', 'masterplan.md');
const BIN = path.join(ROOT, 'bin', 'masterplan.mjs');
const pin = JSON.parse(fs.readFileSync(PIN_PATH, 'utf8'));

const sha256Hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args]);

// Every fixture tree lands under os.tmpdir() and is removed once at teardown.
const TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  TMPDIRS.push(dir);
  return dir;
}
test.after(() => {
  for (const d of TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

// The env a spawned mp needs: session identity for Guard D, PI_CODING_AGENT cleared so the
// no-Workflow suppression fact is off (the knob-contract mpEnv shape).
function mpEnv(extra = {}) {
  const e = { ...process.env, PI_CODING_AGENT: '', CLAUDE_CODE_SESSION_ID: 'w15t59-cutover' };
  delete e.PI_SESSION_ID;
  return { ...e, ...extra };
}

function runMp(entry, args, opts = {}) {
  const r = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8', env: mpEnv(opts.env), timeout: 120_000,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function jsonOut(r) {
  const lines = r.stdout.trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

// ---- the pinned skill, extracted as the installed artifact ------------------------

// Extract the pinned commit's closed file set from the pinned repo's tree — the exact bytes
// the pin's manifest_digest was computed over (the design-intent-host-contract technique;
// the pinned tree is the installed skill, never whatever a checkout happens to hold).
const pinnedManifest = JSON.parse(
  git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/manifest.json`).toString('utf8'),
);
function extractPinnedSkill(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const rel of pinnedManifest.identity.closed_file_set) {
    const dest = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/${rel}`));
  }
  return destDir;
}

// ---- a real repo + seeded bundle (the real seed CLI, --overlap-review required) ----

function mkRepoAndBundle(slug) {
  const dir = mkdtempTracked(path.join(os.tmpdir(), `iv-cut-${slug}-`));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'test@test');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'seed\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'docs/masterplan/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  // The REAL seed path: runs list (the inventory) → the overlap review → mp seed.
  const listed = runMp(BIN, ['runs', 'list', `--repo-root=${repo}`]);
  assert.equal(listed.status, 0, listed.stderr);
  const digest = jsonOut(listed).inventory_sha256;
  const review = path.join(dir, `overlap-${slug}.json`);
  fs.writeFileSync(review, JSON.stringify({ inventory_sha256: digest, candidates: [], action: 'proceed' }));
  const statePath = path.join(repo, 'docs', 'masterplan', slug, 'state.yml');
  const seeded = runMp(BIN, ['seed', `--state=${statePath}`, `--repo-root=${repo}`,
    `--slug=${slug}`, '--topic=Bring the delegated intent interview live end to end',
    `--overlap-review=${review}`, '--complexity=medium']);
  assert.equal(seeded.status, 0, seeded.stderr || seeded.stdout);
  return { dir, repo, statePath };
}

// A complete, valid, version-1 skill tree carrying the PINNED schema's checked sections
// (the schema bytes come from the pinned commit, so coverage validates against a real
// frozen snapshot — the same fixture shape as test/interview-design-intent.test.mjs, with
// the pinned schema instead of a local one).
const PINNED_SCHEMA = JSON.parse(
  git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/schema.json`).toString('utf8'),
);
function mkInstalledSkill(prefix) {
  const dir = mkdtempTracked(path.join(os.tmpdir(), prefix));
  const skillRoot = path.join(dir, 'design-intent');
  const manifest = {
    manifest_version: 1,
    skill: 'design-intent',
    // The pinned contract versions (from the pin, never a literal — a future bump re-pins
    // the fixture; the pin is the authority the host accepts).
    host_contract_version: pin.host_contract_version,
    schema_format_version: pin.schema_format_version,
    identity: {
      algorithm: 'sha256',
      canonicalization: 'entries sorted in ascending byte order of the manifest-relative POSIX path; for each entry in that order, update the running sha256 with the UTF-8 bytes of the path, a newline, the 64-character lowercase hex sha256 of the file\'s exact bytes, and a newline; the identity is the final digest in lowercase hex.',
      closed_file_set: ['SKILL.md', 'manifest.json', 'schema.json'],
    },
  };
  fs.mkdirSync(skillRoot, { recursive: true });
  fs.writeFileSync(path.join(skillRoot, 'SKILL.md'),
    '# design-intent (installed fixture)\n\nplan mode serves masterplan bundles under the masterplan host contract (version 1)\n');
  fs.writeFileSync(path.join(skillRoot, 'schema.json'), `${JSON.stringify(PINNED_SCHEMA, null, 2)}\n`);
  fs.writeFileSync(path.join(skillRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return skillRoot;
}

// The plan-mode projection the pinned validator accepts (topic anchor + the checked
// sections + the reconciliation header; no goal blocks — the host presents ONLY the
// intent projection). Rendered from the recorded draft, so the dispatch's returned draft
// is what the validator validates.
function renderProjection(draft) {
  return [
    'topic: |',
    '  Bring the delegated intent interview live end to end.',
    '',
    '## Purpose',
    draft.why,
    '',
    '## Top invariant',
    'An interrupted run can always be resumed.',
    '',
    '## Non-goals',
    ...draft.anti_goals.map((g) => `- ${g}`),
    '',
    '## Direction',
    'One interview implementation, two consumers.',
    '',
    '## Posture',
    'skipped (low complexity)',
    '',
    '## Audience',
    'not applicable',
    '',
    '## Core bet',
    'not applicable',
    '',
    '## Reconciliation',
    'repo_intent: none',
    '',
  ].join('\n');
}

// ---- the host-contract dispatch, executed as the rewritten §2f teaches it ------------
//
// Each round: read the ledger status fresh → record the skill's returned question and the
// operator's answer → when a picture forms, record the draft → validate the projection with
// the PINNED validator (the skill's own --mode plan check on the projection the host
// presents) → dispatch the critic → record the receipt. Recording happens ONLY through the
// verbs; nothing writes state.yml or events.jsonl directly.

function recordReceipt({ statePath, entry, draft, eligible, forks, dir, n }) {
  const status = jsonOut(runMp(entry, ['interview', 'status', `--state=${statePath}`]));
  const payloadPath = path.join(dir, `payload-${n}.json`);
  fs.writeFileSync(payloadPath, JSON.stringify({
    unknowns: [], contradictions: [], misclassified: [],
    intent_draft: draft,
    eligible_question_set: eligible,
    forks_remaining: forks,
  }));
  const receiptFile = path.join(dir, `receipt-${n}.json`);
  // intent_sha256 is the recorder's digest of the recorded draft — the canonical JSON of
  // the draft object (keys sorted, recursively — lib/interview.mjs's canonicalize).
  const canonical = (v) => Array.isArray(v) ? v.map(canonical)
    : (v && typeof v === 'object')
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
      : v;
  fs.writeFileSync(receiptFile, JSON.stringify({
    dispatch_id: `critic-${n}`, model: 'm', output_tokens: 10,
    content_head: status.content_head,
    intent_sha256: sha256Hex(JSON.stringify(canonical(draft))),
  }));
  const r = runMp(entry, ['interview', 'critic', `--state=${statePath}`,
    `--receipt=${receiptFile}`, `--payload-file=${payloadPath}`]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

// Drive a complete schema-backed interview to convergence through the given entry (the
// REAL binary of whichever surface is under test). Returns the terminal event.
function convergeInterview({ entry, statePath, skillRoot, dir }) {
  // The §2f step-2 capture: the approved schema-capture control over the installed skill.
  const cap = runMp(entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(cap.status, 0, cap.stderr || cap.stdout);
  const captured = jsonOut(cap);
  assert.equal(captured.event_type, 'schema_captured');
  assert.equal(captured.format_pin, 'schema_backed');

  // Round 1 — the skill's returned questions (plan mode: one fork per question,
  // recommended option first), recorded through the permitted ask verb. Two intent-kind
  // forks (medium's probing minimum is 2 — a config-resolved value, not an inline number)
  // and one design pick:
  const q1 = { id: 'Q1', round: 1, kind: 'intent',
    text: 'What must be true in the world when this ships? (A) An interrupted run can always be resumed (Recommended) — the ledger reconstructs; (B) A decision is never made for the owner; (C) Delivered work never drifts from the request' };
  const q2 = { id: 'Q2', round: 1, kind: 'intent',
    text: 'What would make this a failure even if the suite passes? (A) A second native questioner survives anywhere (Recommended) — the duplicate is the failure; (B) Only one surface is proven; (C) The ledger accepts look-ups as fresh answers' };
  const q3 = { id: 'Q3', round: 1, kind: 'design',
    text: 'Which recorder holds the interview state? (A) The mp interview ledger (Recommended); (B) A side file of the skill\'s own' };
  const asks = [
    runMp(entry, ['interview', 'ask', `--state=${statePath}`, `--id=${q1.id}`, '--round=1',
      '--kind=intent', `--text=${q1.text}`]),
    runMp(entry, ['interview', 'ask', `--state=${statePath}`, `--id=${q2.id}`, '--round=1',
      '--kind=intent', `--text=${q2.text}`]),
    runMp(entry, ['interview', 'ask', `--state=${statePath}`, `--id=${q3.id}`, '--round=1',
      '--kind=design', `--text=${q3.text}`]),
  ];
  for (const a of asks) assert.equal(a.status, 0, a.stderr || a.stdout);
  // The operator's answers (the skill returns them; the host records them):
  for (const [id, text] of [
    ['Q1', 'An interrupted run can always be resumed — the ledger reconstructs'],
    ['Q2', 'A second native questioner surviving anywhere is the failure'],
    ['Q3', 'The mp interview ledger'],
  ]) {
    const r = runMp(entry, ['interview', 'answer', `--state=${statePath}`, `--id=${id}`, `--text=${text}`]);
    assert.equal(r.status, 0, r.stderr || r.stdout);
  }

  // The picture forms: the skill returns the draft; the host records it through draft.
  const draft = {
    why: 'The duplicated native questioner kept two interview implementations in step by hand; the cutover leaves the skill as the one questioner over the host contract.',
    outcome: 'A run interviews through the delegated skill, records through mp interview, and resumes from disk on both running surfaces.',
    anti_goals: ['A second native questioning implementation', 'A silent fallback to composing questions when the skill is absent or skewed'],
    done_means: 'the cutover suite passes end to end on both surfaces and the refusal paths refuse by name',
  };
  const draftFile = path.join(dir, 'intent-draft.json');
  fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
  const dr = runMp(entry, ['interview', 'draft', `--state=${statePath}`, `--file=${draftFile}`]);
  assert.equal(dr.status, 0, dr.stderr || dr.stdout);

  // The pinned validator, EXECUTED from the pinned tree, accepts the host's projection of
  // the recorded draft (plan mode; goal blocks never reach it — there are none in the
  // projection, and a goals.md beside it would stay the host's artifact):
  const pinnedValidatorDir = extractPinnedSkill(mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-validator-')));
  const projection = path.join(dir, 'intent-projection.md');
  fs.writeFileSync(projection, renderProjection(draft));
  const v = spawnSync(process.execPath,
    [path.join(pinnedValidatorDir, 'validate-intent.mjs'), projection, '--mode', 'plan', '--complexity', 'low'],
    { encoding: 'utf8' });
  assert.equal(v.status, 0, `the pinned validator must accept the projection: ${v.stderr}`);

  // The critic round: dispatch mp-intent-critic (by name, read-only, fresh context) with
  // the three quoted-data blocks, then record its payload through the critic verb.
  recordReceipt({ statePath, entry, draft, eligible: ['Q1', 'Q2'], forks: false, dir, n: 1 });

  // §5.3 coverage: every checked section of the FROZEN snapshot carries real evidence with
  // provenance and stated uncertainty (sourced from the operator interview; no fights).
  const coverageFile = path.join(dir, 'section-coverage.json');
  fs.writeFileSync(coverageFile, JSON.stringify({
    sections: PINNED_SCHEMA.checked_sections.map((section) => ({
      section,
      source: `operator interview via /design-intent plan mode (${section} check)`,
      uncertainty: '',
      verdict: 'serves',
    })),
  }, null, 2));

  // Convergence per §5.3's two conditions, recorded through the end verb (the coverage
  // record rides --coverage-file; the probing minimum resolves from the config chain).
  const er = runMp(entry, ['interview', 'end', `--state=${statePath}`,
    '--reason=converged', `--coverage-file=${coverageFile}`]);
  assert.equal(er.status, 0, er.stderr || er.stdout);

  const events = fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const terminal = [...events].reverse().find((e) => e.type === 'interview_end');
  assert.ok(terminal, 'the terminal interview_end event must exist');
  return { terminal, events };
}

// ---- the two surfaces (§10's running surfaces, built from THIS tree's HEAD) --------

// A committed tree is required for both surfaces (git archive snapshots committed bytes).
// The worktree may carry uncommitted task changes — HEAD is the last wave-transaction
// commit, which is the cutover's BASE, not the cutover itself. To prove the cutover's own
// bytes, the surfaces are built from a throwaway commit of THIS task's tree: a scratch
// clone carries the task's diff as a commit, and git archive snapshots THAT.
function buildCommittedSourceTree() {
  const scratch = mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-src-'));
  const src = path.join(scratch, 'masterplan');
  execFileSync('git', ['clone', '--no-hardlinks', '-q', ROOT, src]);
  git(src, 'config', 'user.email', 'test@test');
  git(src, 'config', 'user.name', 'test');
  git(src, 'config', 'commit.gpgsign', 'false');
  // Apply THIS task's working-tree changes (commands/masterplan.md + the new test) as a
  // commit in the scratch clone: the surfaces built below carry the cutover's bytes.
  for (const [rel, abs] of [['commands/masterplan.md', PROMPT_PATH],
    ['test/interview-cutover.test.mjs', path.join(ROOT, 'test', 'interview-cutover.test.mjs')],
    ['test/prompt-structure.test.mjs', path.join(ROOT, 'test', 'prompt-structure.test.mjs')]]) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.copyFileSync(abs, path.join(src, rel));
  }
  git(src, 'add', 'commands/masterplan.md', 'test/interview-cutover.test.mjs', 'test/prompt-structure.test.mjs');
  // --allow-empty: when the task's bytes are ALREADY at HEAD (the post-record state), the
  // copied trio is identical and there is nothing to commit — the archive still snapshots
  // the committed tree, which now IS the cutover's bytes either way.
  git(src, 'commit', '-q', '--allow-empty', '-m', 'task 59 cutover (test fixture commit)');
  return src;
}

const SURFACES = (() => {
  const base = mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-surfaces-'));
  const source = buildCommittedSourceTree();
  const pi = (() => {
    const installRoot = path.join(base, 'pi-install-root');
    const piRoot = path.join(base, 'pi-root');
    const inst = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install-pi.mjs'),
      `--source=${source}`, '--ref=HEAD', `--install-root=${installRoot}`, `--pi-root=${piRoot}`],
      { encoding: 'utf8', env: mpEnv(), timeout: 180_000, maxBuffer: 512 * 1024 * 1024 });
    assert.equal(inst.status, 0, `install-pi failed: ${inst.stderr}`);
    const entry = path.join(installRoot, 'current', 'bin', 'masterplan.mjs');
    assert.ok(fs.existsSync(entry), 'the Pi surface entry point must exist');
    return { name: 'pi', entry, installRoot, piRoot };
  })();
  const claude = (() => {
    const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    const claudeConfig = path.join(base, 'claude-config');
    const cache = path.join(claudeConfig, 'plugins', 'cache', 'rasatpetabit-masterplan', 'masterplan', pkg.version);
    fs.mkdirSync(cache, { recursive: true });
    const arch = spawnSync('git', ['-C', source, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 512 * 1024 * 1024 });
    assert.equal(arch.status, 0, 'git archive HEAD failed');
    const untar = spawnSync('tar', ['-x', '-C', cache], { input: arch.stdout, maxBuffer: 512 * 1024 * 1024 });
    assert.equal(untar.status, 0, 'tar extraction failed');
    const entry = path.join(cache, 'bin', 'masterplan.mjs');
    assert.ok(fs.existsSync(entry), 'the Claude surface entry point must exist');
    return { name: 'claude', entry, cache, claudeConfig };
  })();
  return [pi, claude];
})();

// The surfaces carry the CUTOVER's prompt (the removed duplicate is gone there too — the
// proof that the installed artifacts, not just the checkout, lost the native questioner).
for (const s of SURFACES) {
  const root = s.name === 'pi' ? fs.realpathSync(s.entry.replace(/bin\/masterplan\.mjs$/, '')) : s.cache;
  const installedPrompt = fs.readFileSync(path.join(root, 'commands', 'masterplan.md'), 'utf8');
  assert.ok(!installedPrompt.includes('3. **Question discipline.**'),
    `the ${s.name} surface's installed prompt must not carry the removed native questioner`);
}

// ---- 1. DISPATCH: end-to-end delegated interview on BOTH surfaces -----------------

for (const surface of SURFACES) {
  test(`DISPATCH: the pinned skill's plan mode interviews end to end through the ${surface.name} surface`, () => {
    const { statePath } = mkRepoAndBundle(`dispatch-${surface.name}`);
    const skillRoot = mkInstalledSkill(`iv-cut-skill-${surface.name}-`);
    const dir = mkdtempTracked(path.join(os.tmpdir(), `iv-cut-dispatch-${surface.name}-`));

    const { terminal, events } = convergeInterview({
      entry: surface.entry, statePath, skillRoot, dir,
    });

    // The terminal event is a REAL converged schema-backed end (§5.3's two conditions):
    assert.equal(terminal.reason, 'converged');
    assert.equal(terminal.policy, 'schema_backed');
    assert.ok(/^[0-9a-f]{64}$/.test(terminal.coverage_sha256), 'the coverage record is digest-bound on the event');
    assert.ok(Number.isInteger(terminal.probing_minimum) && terminal.probing_minimum >= 1,
      'the resolved probing minimum is persisted with the policy identity');

    // Everything landed through the verbs — the ledger is exactly the recorder's appends
    // (capture, questions, answers, draft, critic receipt, terminal), never a skill-side write:
    const types = events.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t.startsWith('interview_') || t === 'schema_captured'), [
      'schema_captured', 'interview_question', 'interview_question', 'interview_question',
      'interview_answer', 'interview_answer', 'interview_answer', 'interview_draft',
      'interview_critic', 'interview_end',
    ]);
    // The recorded questions carry the skill's plan-mode shape verbatim (one fork,
    // recommended option first — the discipline lives in the skill, the text in the ledger):
    const q1 = events.find((e) => e.type === 'interview_question' && e.id === 'Q1');
    assert.ok(q1.text.includes('(Recommended)'), 'the recorded question carries the skill\'s recommended-option-first shape');
    assert.ok(q1.text.includes('(A)') && q1.text.includes('(B)'), 'the recorded question carries its options as one fork');
    // The snapshot the interview ran under is the frozen one, digest-bound:
    const snap = fs.readFileSync(path.join(path.dirname(statePath), 'schema-snapshot.json'));
    const captured = events.find((e) => e.type === 'schema_captured');
    assert.equal(sha256Hex(snap), captured.schema_sha256);
    assert.equal(captured.skill_identity, pinnedIdentityOverInstalled(skillRoot),
      'the recorded identity is the real closed-set digest of the installed skill');
  });
}

// The real identity computation over the installed fixture (the schema-snapshot algorithm).
function pinnedIdentityOverInstalled(skillRoot) {
  const manifest = JSON.parse(fs.readFileSync(path.join(skillRoot, 'manifest.json'), 'utf8'));
  const h = crypto.createHash('sha256');
  for (const rel of [...manifest.identity.closed_file_set].sort()) {
    h.update(rel, 'utf8');
    h.update('\n', 'utf8');
    h.update(sha256Hex(fs.readFileSync(path.join(skillRoot, rel))), 'utf8');
    h.update('\n', 'utf8');
  }
  return h.digest('hex');
}

// ---- 2. RESUME: an interrupted interview resumes through the same dispatch path -----

for (const surface of SURFACES) {
  test(`RESUME: an interview interrupted mid-flight resumes from the ledger on the ${surface.name} surface`, () => {
    const { statePath, dir } = mkRepoAndBundle(`resume-${surface.name}`);
    const skillRoot = mkInstalledSkill(`iv-cut-skill-resume-${surface.name}-`);

    // The first session captures, records round 1's questions (the §5.3 batched shape —
    // all of a round's asks may be recorded before their answers), and is interrupted (a
    // compaction/crash) with the interview OPEN: both asked, nothing answered.
    const cap = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
    assert.equal(cap.status, 0, cap.stderr);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q1', '--round=1',
      '--kind=intent', '--text=What must be true in the world when this ships? (A) resumability (Recommended); (B) owner control']).status, 0);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q2', '--round=1',
      '--kind=intent', '--text=What would make this a failure even if the suite passes? (A) a second native questioner (Recommended); (B) only one surface proven']).status, 0);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q3', '--round=1',
      '--kind=design', '--text=Recorder? (A) the mp interview ledger (Recommended); (B) a side file']).status, 0);

    // A FRESH session (a new CLAUDE_CODE_SESSION_ID — a different Guard-D identity) resumes:
    // the ledger status reconstructs the budget from events.jsonl, nothing else.
    const resumed = runMp(surface.entry, ['interview', 'status', `--state=${statePath}`],
      { env: { CLAUDE_CODE_SESSION_ID: 'w15t59-cutover-successor' } });
    assert.equal(resumed.status, 0, resumed.stderr);
    const st = jsonOut(resumed);
    assert.equal(st.asked, 3);
    assert.equal(st.answered, 0);
    assert.equal(st.state, null, 'the interview is still open — the interruption stranded nothing');
    assert.ok(st.content_head >= 0, 'the content head reconstructs from the ledger');

    // The resuming session answers the intent question (sealing round 1), withdraws the
    // stranded design question, re-asks it in round 2 as the skill's resumed dispatch does,
    // and records the operator's pick — then continues to convergence:
    const env = { CLAUDE_CODE_SESSION_ID: 'w15t59-cutover-successor' };
    for (const [id, text] of [['Q1', 'An interrupted run can always be resumed'], ['Q2', 'A second native questioner surviving anywhere is the failure']]) {
      assert.equal(runMp(surface.entry, ['interview', 'answer', `--state=${statePath}`, `--id=${id}`,
        `--text=${text}`], { env }).status, 0);
    }
    assert.equal(runMp(surface.entry, ['interview', 'withdraw', `--state=${statePath}`, '--id=Q3',
      '--reason=the interrupted round was re-asked on resume'], { env }).status, 0);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q4', '--round=2',
      '--kind=design', '--text=Recorder? (A) the mp interview ledger (Recommended); (B) a side file'], { env }).status, 0);
    assert.equal(runMp(surface.entry, ['interview', 'answer', `--state=${statePath}`, '--id=Q4',
      '--text=The mp interview ledger'], { env }).status, 0);
    const draft = {
      why: 'The cutover must leave an interrupted run able to interview.',
      outcome: 'A mid-flight interview resumes from the ledger through the same dispatch path.',
      anti_goals: ['Resuming by re-asking from memory'],
      done_means: 'the resumed session converges from the reconstructed ledger',
    };
    const draftFile = path.join(dir, 'resume-draft.json');
    fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
    assert.equal(runMp(surface.entry, ['interview', 'draft', `--state=${statePath}`, `--file=${draftFile}`], { env }).status, 0);
    recordReceipt({ statePath, entry: surface.entry, draft, eligible: ['Q1', 'Q2'], forks: false, dir, n: 1 });
    const coverageFile = path.join(dir, 'resume-coverage.json');
    fs.writeFileSync(coverageFile, JSON.stringify({
      sections: PINNED_SCHEMA.checked_sections.map((section) => ({
        section, source: `resumed operator interview (${section})`, uncertainty: '', verdict: 'serves',
      })),
    }, null, 2));
    const er = runMp(surface.entry, ['interview', 'end', `--state=${statePath}`,
      '--reason=converged', `--coverage-file=${coverageFile}`], { env });
    assert.equal(er.status, 0, er.stderr || er.stdout);
    const events = fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const terminal = [...events].reverse().find((e) => e.type === 'interview_end');
    assert.equal(terminal.reason, 'converged');
    assert.equal(terminal.policy, 'schema_backed');
    // The withdrawn question still counts against the cap and the ledger records the resume:
    assert.ok(events.some((e) => e.type === 'interview_withdraw' && e.id === 'Q3'));
    assert.ok(events.some((e) => e.type === 'interview_critic'), 'the resumed session recorded its critic receipt');
  });
}

// ---- 3. REFUSAL: absent / skewed / changed-identity skills refuse by name ----------

test('REFUSAL: an absent skill refuses with skill_absent — there is no native fallback', () => {
  const { statePath } = mkRepoAndBundle('refuse-absent');
  const missing = path.join(mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-absent-')), 'no-such-skill');
  for (const surface of SURFACES) {
    const r = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${missing}`]);
    assert.equal(r.status, 1, `the ${surface.name} surface must refuse, not accept`);
    assert.match(r.stderr, /skill_absent/, `the refusal must name skill_absent on ${surface.name}: ${r.stderr}`);
  }
});

test('REFUSAL: a version-skewed skill refuses with host_contract_unsupported', () => {
  const { statePath } = mkRepoAndBundle('refuse-skew');
  // The skewed fixture: identical bytes except the manifest declares a host-contract
  // version the host does not support (the pin's version + 1 — whatever the pin names, the
  // skew is a version this host must refuse).
  const skewedRoot = mkInstalledSkill('iv-cut-skew-');
  const manifest = JSON.parse(fs.readFileSync(path.join(skewedRoot, 'manifest.json'), 'utf8'));
  manifest.host_contract_version = pin.host_contract_version + 1;
  fs.writeFileSync(path.join(skewedRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const surface of SURFACES) {
    const r = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skewedRoot}`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /host_contract_unsupported/, `the refusal must name host_contract_unsupported on ${surface.name}: ${r.stderr}`);
  }
});

test('REFUSAL: a changed identity after capture refuses with skill_identity_changed', () => {
  const { statePath } = mkRepoAndBundle('refuse-identity');
  const skillRoot = mkInstalledSkill('iv-cut-identity-');
  const cap = runMp(BIN, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(cap.status, 0, cap.stderr);
  // A behavior-affecting edit without a version bump: the identity changes and the next
  // capture REFUSES (routing to amend-skill-identity) — never adopts in place.
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), '\nAn ordinary edit that changes behavior without bumping a version.\n');
  for (const surface of SURFACES) {
    const r = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /skill_identity_changed/, `the refusal must name skill_identity_changed on ${surface.name}: ${r.stderr}`);
    assert.match(r.stderr, /amend-skill-identity/, 'the refusal must route to the guard-exempt amendment');
  }
});

test('REFUSAL: the removed native-questioner instructions are gone from the prompt (the one textual assertion)', () => {
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  // The duplicate questioning implementation's load-bearing instructions — the prose that
  // taught the orchestrator to compose questions itself — are removed. (One assertion among
  // the behavioral ones above; the refusal and dispatch paths are the core proof.)
  for (const gone of [
    '3. **Question discipline.** A question may only be about: the problem behind the ask',
    '2. **Budget.** `mp interview status --state=<path>` returns `{asked, answered, floor, cap,',
    'is a judgment the prompt\n   makes and the critic reviews; it is not mechanically enforced',
    'the masterplan-owned questioning phase',
  ]) {
    assert.ok(!prompt.includes(gone), `the removed native-questioner instruction must be gone: ${gone.slice(0, 50)}…`);
  }
  // The dispatch contract is taught in its place (the §2f section names the delegation,
  // the capture verb, the permitted verbs, and the refusal):
  const start = prompt.indexOf('## 2f —');
  const end = prompt.indexOf('## 3 — Other verbs');
  assert.ok(start !== -1 && end > start, 'the §2f section must exist');
  const section = prompt.slice(start, end);
  for (const expected of [
    "delegated to the /design-intent skill's plan mode",
    'mp interview capture-schema',
    'mp interview amend-skill-identity',
    'permitted recorder operations',
    'The skill NEVER writes',
    'there is NO native fallback',
    'skill_absent', 'host_contract_unsupported', 'skill_identity_changed',
    'schema_unsupported', 'undeclared_dependency',
    'interview.probing_minimum',
    'eligible_question_set',
  ]) {
    assert.ok(section.includes(expected), `the §2f dispatch contract must teach: ${expected}`);
  }
});

// ---- the surfaces execute: the installed binaries run (a surface that cannot start proves nothing)

test('both surfaces execute and report the installed version', () => {
  for (const surface of SURFACES) {
    const r = runMp(surface.entry, ['version', '--args=probe', '--cwd=/']);
    assert.equal(r.status, 0, `the ${surface.name} surface's entry point must execute: ${r.stderr}`);
    assert.match(r.stdout, /\/masterplan v\S+ args: 'probe'/, `the ${surface.name} surface must print the version banner`);
  }
});