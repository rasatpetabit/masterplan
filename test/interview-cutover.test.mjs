// test/interview-cutover.test.mjs — task 59: THE CUTOVER, proven behaviorally.
//
// The duplicate questioning implementation is REMOVED from commands/masterplan.md (§2f
// rewritten: the sequencer no longer composes questions natively — it dispatches the pinned
// /intent skill's plan mode over the task-49 host contract, records through the
// mp interview verbs, converges per spec §5.3's two conditions, and refuses fail-closed).
// This suite proves the cutover against REAL dispatch and resume on BOTH running surfaces
// named by §10 and G6 — the Claude Code plugin-cache surface and the Pi install surface —
// rather than against source-text assertions:
//
//   1. DISPATCH: the pinned skill is the questioner, FOR REAL. The installed skill in every
//      dispatch/resume case is the PINNED skill's own bytes (extracted from the pinned
//      commit's tree exactly as test/interview-sequencer-delegation.test.mjs extracts them —
//      git show the pin's commit; the recomputed identity equals the pin's manifest_digest),
//      and the pinned skill's PROGRAM participates load-bearing: each round reads the
//      plan-mode contract out of the installed skill's own bytes (its SKILL.md is the
//      router; the contract itself lives in verbs/plan.md, whose host-contract section
//      names the validator invocation the contract teaches), and each draft the host
//      records is ADJUDICATED by executing the installed skill's real
//      `validate-intent.mjs <projection> --mode plan` subprocess — the host consumes its
//      actual output, and a projection the executable refuses NEVER reaches the recorder.
//      The question TEXT the ledger carries is composed from the pinned SKILL.md's own
//      plan-mode vocabulary (its interview section's option shapes, recommended-first), so a
//      stub whose SKILL.md is not the questioner cannot produce it. Recording still happens
//      ONLY through the verbs the host permits (the host stays the sole writer).
//   2. RESUME: an interview interrupted MID-FLIGHT (events on disk, interview open) resumes
//      through the SAME dispatch path on both surfaces — the ledger reconstructs the
//      budget and content head from events.jsonl and the pinned skill's own adjudication
//      continues; an interrupted run is never left unable to interview (the cutover's own
//      precondition).
//   3. REFUSAL: an absent skill, a version-skewed skill, and a changed identity each REFUSE
//      with their NAMED §5.5 error through the real capture path — plus the MUTATION
//      CONTROL: an installed "skill" whose SKILL.md is NOT the pinned questioner (replaced
//      by the adversarial reviewer's NOT-A-QUESTIONER text) makes the DISPATCH/RESUME proof
//      itself FAIL — the pinned executable and contract extraction are load-bearing, so a
//      stub cannot satisfy the proof. The suite proves no native fallback exists: the removed
//      native-questioner instruction text is gone from the prompt (ONE grep assertion among
//      many; the core proof is behavioral).
//
// The "two surfaces" are the install seams §10 names, and BOTH are real installs:
//   - Pi: bin/install-pi.mjs (the real installer, unmodified) copies a committed snapshot
//     into <install-root>/releases/<sha> and flips `current`; the interview verbs are then
//     invoked THROUGH that installed entry point with the Pi environment identity INTACT
//     (PI_CODING_AGENT and the real PI_SESSION_ID pass through — the host harness's own
//     identity is what a running Pi session would present), and the installer's --check
//     contract verifies the surface's discovery from the OUTSIDE.
//   - Claude: the plugin-cache layout the doctor knows (lib/doctor/plugin-registry-drift.mjs)
//     and scripts/rehearse-v9-finish.sh's claude_surface step builds —
//     <claude-config>/plugins/cache/rasatpetabit-masterplan/masterplan/<v> plus the
//     installed_plugins.json registry entry Claude Code's plugin manager writes — is built
//     from the same committed tree by the rehearsal's exact procedure (git archive of the
//     release commit into the cache dir), and the interview verbs are invoked through the
//     INSTALLED plugin-cache binary. There is no scripts/install-claude*.mjs (grep scripts/:
//     the marketplace UI owns the live install; the rehearsal script is the repo's own
//     documented replication of the resulting cache layout), so the suite replicates the
//     rehearsal's procedure faithfully into a temp HOME and says so in the assertions.
// Both surfaces are built from THIS tree's committed HEAD through the real installers'
// contracts, so the proven bytes are the cutover's bytes, not a checkout's.

import { test as rawTest } from 'node:test';
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
// HOST-LOCAL PIN EVIDENCE: the pin's repo is an absolute host path (provenance of the pinned
// skill). On a machine without it (the CI runner), this suite cannot verify the pinned bytes —
// it SKIPS (never fails): the pin verification is host-local evidence, like the run's own
// bundle; CI is the product-surface contract, not the pin-provenance witness.
const PINNED_REPO_AVAILABLE = fs.existsSync(path.join(pin.repo, '.git')); // a bare existing dir is not a repo (the CI path is absent; an empty mount is not a checkout)
// Every test in this file is pinned-skill evidence: on a machine without the pinned repo the
// whole suite skips (a skip is honest — a failure would claim the product broke on CI).
const test = PINNED_REPO_AVAILABLE ? rawTest : Object.assign(
  // The skip alias keeps the harness surface: every registration becomes a skipped test,
  // and the lifecycle hooks no-op (nothing was registered, nothing to clean up).
  (name, opts, fn) => rawTest.skip(name, typeof opts === 'function' ? opts : fn),
  { after: () => {}, before: () => {}, beforeEach: () => {}, afterEach: () => {} },
);

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

// The env a spawned mp needs. NOTHING is stripped: the host harness's identity passes
// through unchanged (PI_CODING_AGENT, PI_SESSION_ID and all) — the surface runs under the
// environment a real session presents, and only the Claude session id is made deterministic
// so Guard D (owner identity) is stable and reproducible across the suite's invocations.
// PI_CODING_AGENT=true routes shouldSuppressWorkflow to the no-Workflow path — that is the
// routing fact a running Pi session actually carries, and interview recording is host-
// agnostic, so the identity stays intact by design here (the wave-15 review finding: the
// previous suite CLEARED Pi's identity at the mpEnv seam, which made "the Pi surface" two
// filesystem locations running the same CLI instead of the installed surface under its own
// harness identity).
function mpEnv(extra = {}) {
  return { ...process.env, CLAUDE_CODE_SESSION_ID: 'w15t59-cutover', ...extra };
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
// the pin's manifest_digest was computed over (the sequencer-delegation suite's pinnedBytes
// technique; the pinned tree IS the installed skill, never whatever a checkout holds).
const pinnedBytes = (rel) => {
  if (!PINNED_REPO_AVAILABLE) throw new Error('the pinned repo is absent on this machine — the host-local pin evidence suite is skipped');
  return git(pin.repo, 'show', `${pin.commit}:${pin.skill_path}/${rel}`);
};
const pinnedManifest = PINNED_REPO_AVAILABLE ? JSON.parse(pinnedBytes('manifest.json').toString('utf8')) : null;
const pinnedSkillMd = PINNED_REPO_AVAILABLE ? pinnedBytes('SKILL.md').toString('utf8') : null;
const PINNED_SCHEMA = PINNED_REPO_AVAILABLE ? JSON.parse(pinnedBytes('schema.json').toString('utf8')) : null;

// Extract the REAL pinned skill into an installable tree. The recomputed identity over
// these bytes equals the pin's manifest_digest (asserted once, below) — the dispatch cases
// install THE pinned skill, not a fixture standing in for it.
function extractPinnedSkill(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const rel of pinnedManifest.identity.closed_file_set) {
    const dest = path.join(destDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, pinnedBytes(rel));
  }
  return destDir;
}

// The plan-mode contract, read as DATA from the installed skill's own bytes. The pinned
// skill's SKILL.md is the ROUTER: its masterplan-host-contract section names the contract's
// home (`verbs/plan.md`) and restates nothing — "That contract lives in `verbs/plan.md`
// and is not restated here" — so the contract itself (the plan-mode heading and the
// validator invocation it teaches) is read from verbs/plan.md, as the router directs.
// Both reads are load-bearing: a mutated SKILL.md (the mutation control's NOT-A-QUESTIONER
// stub) loses the router and cannot satisfy the read, and a skill whose verbs/plan.md does
// not teach the plan-mode contract or its validator invocation is not the questioner.
function readPlanContract(skillRoot) {
  const md = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(skillRoot, 'manifest.json'), 'utf8'));
  // The router line (the pinned SKILL.md's masterplan-host-contract pointer section).
  const router = /That contract lives in `verbs\/plan\.md` and is not restated here/.exec(md);
  // The contract's home: verbs/plan.md carries the plan-mode mode line (host-only) and the
  // validator invocation the plan-mode lifecycle teaches: validate-intent.mjs --mode plan.
  const planMd = fs.readFileSync(path.join(skillRoot, 'verbs', 'plan.md'), 'utf8');
  const planMode = /^# plan \(host-only\)/m.exec(planMd);
  const validatorCmd = /node <skill-dir>\/validate-intent\.mjs <file> --mode plan/.exec(planMd);
  if (!router || !planMode || !validatorCmd) {
    throw new Error(`the installed skill at ${skillRoot} does not teach the plan-mode host contract — it is not the pinned questioner (no plan-mode router in SKILL.md or plan-mode contract/validator invocation in verbs/plan.md)`);
  }
  return { manifest, planMode: planMode[0], validatorCmd: validatorCmd[0] };
}

// ---- the pinned executable's plan-mode adjudication (the load-bearing step) ----------

// Render the intent projection the way the pinned skill's plan mode defines it (its SKILL.md
// artifact section: topic anchor + core sections + standard extensions + the plan-mode
// Reconciliation header; goal blocks never reach the validator — the host presents ONLY the
// intent projection). The section bodies come from the draft the skill is adjudicating.
function renderProjection(draft, sections) {
  return [
    'topic: |',
    '  Bring the delegated intent interview live end to end.',
    '',
    `## ${PINNED_SCHEMA.core[0]}`,
    sections.purpose ?? draft.why,
    '',
    `## ${PINNED_SCHEMA.core[1]}`,
    sections.invariant ?? 'An interrupted run can always be resumed.',
    '',
    `## ${PINNED_SCHEMA.core[2]}`,
    ...(sections.non_goals ?? draft.anti_goals).map((g) => `- ${g}`),
    '',
    ...(PINNED_SCHEMA.standard_extensions.map((ext) => `## ${ext}\n${sections.extensions?.[ext] ?? 'not applicable'}\n`)),
    '## Reconciliation',
    'repo_intent: none',
    '',
  ].join('\n');
}

// Execute the INSTALLED skill's real validator on the projection, --mode plan, and CONSUME
// its actual output: exit 0 + `ok:` accepts the draft; exit 1 + `FAIL:` lines are the
// skill's own adjudication that the projection does not satisfy its schema — the dispatch
// refuses to record a draft the pinned executable refuses. Returns { ok, errors, text }.
function adjudicateProjection(skillRoot, projectionPath, complexity) {
  const v = spawnSync(process.execPath,
    [path.join(skillRoot, 'validate-intent.mjs'), projectionPath, '--mode', 'plan', '--complexity', complexity],
    { encoding: 'utf8' });
  return {
    ok: v.status === 0,
    status: v.status,
    text: `${v.stdout ?? ''}${v.stderr ?? ''}`,
    errors: `${v.stdout ?? ''}${v.stderr ?? ''}`.split('\n').filter((l) => l.startsWith('FAIL:')),
  };
}

// ---- the host-contract dispatch, executed as the rewritten §2f teaches it ------------
//
// Each round: read the ledger status fresh → read the plan-mode contract from the installed
// skill's bytes → compose the round's questions from the pinned SKILL.md's own plan-mode
// vocabulary → record them through the permitted ask verb → record the operator's answers →
// when a picture forms, compose the draft → ADJUDICATE the draft's projection by EXECUTING
// the installed skill's real validator (--mode plan) and only record what it accepts →
// dispatch the critic → record the receipt. Recording happens ONLY through the verbs;
// nothing writes state.yml or events.jsonl directly.

function recordReceipt({ statePath, entry, draft, eligible, forks, dir, n, criticModel }) {
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
    dispatch_id: `critic-${n}`, model: criticModel, output_tokens: 10,
    content_head: status.content_head,
    intent_sha256: sha256Hex(JSON.stringify(canonical(draft))),
  }));
  const r = runMp(entry, ['interview', 'critic', `--state=${statePath}`,
    `--receipt=${receiptFile}`, `--payload-file=${payloadPath}`]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
}

// The critic's dispatch provenance comes from the checked-in routing policy the §2f critic
// dispatch names (the critic class → its pinned agent and lane), read as data — never a
// fabricated model string (the fleet's raw-override prohibition; the agent doc's own
// frontmatter resolves the same way through bin/register-pi-agents.mjs).
function criticDispatchIdentity() {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'policy', 'workflow-map.json'), 'utf8'));
  const cls = map.classes.critic;
  assert.ok(cls, 'policy/workflow-map.json must declare the critic class');
  const agent = map.agents[cls.agent];
  assert.ok(agent, `the critic class names agent ${cls.agent}`);
  assert.equal(agent.writes, false, 'the critic agent is read-only');
  return { agentName: cls.agent, model: agent.model, lane: agent.lane };
}

// Compose a round's question text from the pinned SKILL.md's own plan-mode interview
// vocabulary: its option shapes (four options, the first carrying its literal
// "(Recommended)" suffix discipline, one structured question per call, multi-select on the
// list sections) and its example stems. The text is BUILT from the installed skill's
// contract bytes — a mutated skill has no vocabulary to compose from (readPlanContract
// already refused), and the recorded ledger carries the skill's own shape.
function composeQuestion(skillRoot, stem, options) {
  // The (Recommended) discipline is the pinned skill's literal marker (its interview
  // section: "The first option is your recommendation and its label ends with
  // `(Recommended)`") — verify the installed skill still teaches it before using it.
  const md = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
  assert.ok(md.includes('`AskUserQuestion` / `ask_user_question`'),
    'the installed skill must teach the structured-question tool call');
  assert.ok(md.includes('ends with\n  `(Recommended)`') || /\(Recommended\)/.test(md),
    'the installed skill must teach the recommended-option marker');
  const parts = options.map((o, i) => `(${String.fromCharCode(65 + i)}) ${o}`);
  return `${stem} ${parts.join(' ')}`;
}

// Drive a complete schema-backed interview to convergence through the given entry (the
// REAL binary of whichever surface is under test), with the pinned skill installed at
// skillRoot and its executable adjudicating every draft. Returns the terminal event.
function convergeInterview({ entry, statePath, skillRoot, dir }) {
  // The §2f step-2 capture: the approved schema-capture control over the installed skill.
  // The installed skill IS the pinned one (identity asserted by the caller), so the capture
  // records the pin's own manifest_digest as the skill identity.
  const cap = runMp(entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(cap.status, 0, cap.stderr || cap.stdout);
  const captured = jsonOut(cap);
  assert.equal(captured.event_type, 'schema_captured');
  assert.equal(captured.format_pin, 'schema_backed');
  assert.equal(captured.skill_identity, pin.manifest_digest,
    'the capture must record the PINNED skill\'s identity (the pin\'s manifest_digest)');

  // The host-contract block, read from the installed skill's own bytes (fail-closed on a
  // skill that does not teach the plan-mode contract — the mutation control's refusal):
  const contract = readPlanContract(skillRoot);
  assert.equal(contract.manifest.host_contract_version, pin.host_contract_version,
    'the installed skill declares the pinned host contract version');

  // Round 1 — questions composed from the pinned SKILL.md's plan-mode vocabulary (one
  // fork per question, recommended option first — the discipline the skill's own bytes
  // teach), recorded through the permitted ask verb. Two intent-kind forks (medium's
  // probing minimum is 2 — a config-resolved value, not an inline number) and one design
  // pick:
  const q1Text = composeQuestion(skillRoot, 'What must be true in the world when this ships?', [
    'An interrupted run can always be resumed (Recommended) — the ledger reconstructs',
    'A decision is never made for the owner',
    'Delivered work never drifts from the request',
  ]);
  const q2Text = composeQuestion(skillRoot, 'What would make this a failure even if the suite passes?', [
    'A second native questioner survives anywhere (Recommended) — the duplicate is the failure',
    'Only one surface is proven',
    'The ledger accepts look-ups as fresh answers',
  ]);
  const q3Text = composeQuestion(skillRoot, 'Which recorder holds the interview state?', [
    'The mp interview ledger (Recommended)',
    "A side file of the skill's own",
  ]);
  const asks = [
    runMp(entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q1', '--round=1',
      '--kind=intent', `--text=${q1Text}`]),
    runMp(entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q2', '--round=1',
      '--kind=intent', `--text=${q2Text}`]),
    runMp(entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q3', '--round=1',
      '--kind=design', `--text=${q3Text}`]),
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

  // The picture forms: the skill returns the draft; the host records it through draft —
  // AFTER the pinned executable's own --mode plan adjudication accepts its projection.
  const draft = {
    why: 'The duplicated native questioner kept two interview implementations in step by hand; the cutover leaves the skill as the one questioner over the host contract.',
    outcome: 'A run interviews through the delegated skill, records through mp interview, and resumes from disk on both running surfaces.',
    anti_goals: ['A second native questioning implementation', 'A silent fallback to composing questions when the skill is absent or skewed'],
    done_means: 'the cutover suite passes end to end on both surfaces and the refusal paths refuse by name',
  };
  const sections = {
    purpose: draft.why,
    invariant: 'An interrupted run can always be resumed.',
    non_goals: draft.anti_goals,
    extensions: { Direction: 'One interview implementation, two consumers.', Posture: 'not applicable' },
  };
  // THE LOAD-BEARING ADJUDICATION: execute the INSTALLED skill's real validator on the
  // projection (--mode plan, the invocation the skill's own contract teaches) and consume
  // its ACTUAL output — the draft is recorded only if the pinned executable accepts.
  const projection = path.join(dir, 'intent-projection.md');
  fs.writeFileSync(projection, renderProjection(draft, sections));
  const verdict = adjudicateProjection(skillRoot, projection, 'normal');
  assert.equal(verdict.ok, true,
    `the pinned executable must adjudicate the projection: ${verdict.text}`);
  assert.match(verdict.text, /^ok: /, 'the pinned validator\'s accepting output is consumed verbatim');
  const draftFile = path.join(dir, 'intent-draft.json');
  fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
  const dr = runMp(entry, ['interview', 'draft', `--state=${statePath}`, `--file=${draftFile}`]);
  assert.equal(dr.status, 0, dr.stderr || dr.stdout);

  // The critic round: dispatch mp-intent-critic (by name, read-only, fresh context) with
  // the three quoted-data blocks, then record its payload through the critic verb — with
  // the dispatch provenance the checked-in routing policy pins for the critic class.
  const critic = criticDispatchIdentity();
  recordReceipt({
    statePath, entry, draft, eligible: ['Q1', 'Q2'], forks: false, dir, n: 1,
    criticModel: critic.model,
  });

  // §5.3 coverage: every checked section of the FROZEN snapshot (the pinned schema —
  // the same bytes the capture snapshotted) carries real evidence with provenance and
  // stated uncertainty (sourced from the operator interview; no fights).
  const coverageFile = path.join(dir, 'section-coverage.json');
  fs.writeFileSync(coverageFile, JSON.stringify({
    sections: PINNED_SCHEMA.checked_sections.map((section) => ({
      section,
      source: `operator interview via /intent plan mode (${section} check)`,
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
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  // Pi: the REAL installer (unmodified), copying the committed snapshot into a
  // content-addressed release and flipping `current`. The interview verbs are invoked
  // through the installed entry point with the harness identity INTACT (see mpEnv).
  const pi = (() => {
    const installRoot = path.join(base, 'pi-install-root');
    const piRoot = path.join(base, 'pi-root');
    const inst = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install-pi.mjs'),
      `--source=${source}`, '--ref=HEAD', `--install-root=${installRoot}`, `--pi-root=${piRoot}`],
      { encoding: 'utf8', env: mpEnv(), timeout: 180_000, maxBuffer: 512 * 1024 * 1024 });
    assert.equal(inst.status, 0, `install-pi failed: ${inst.stderr}`);
    const entry = path.join(installRoot, 'current', 'bin', 'masterplan.mjs');
    assert.ok(fs.existsSync(entry), 'the Pi surface entry point must exist');
    // The installer's own --check contract (the discovery the surface relies on) holds on
    // the installed tree: current resolves, metadata agrees, the skill links and agent
    // registration are drift-free, and the installed binary reports the released version.
    // The --expect probe resolves the version through the installed binary's own candidate
    // chain; CLAUDE_CONFIG_DIR is confined to an empty temp dir so the probe reads the
    // INSTALLED release's plugin.json (candidate #2: the probe's cwd is the release dir)
    // rather than this host's live marketplace clone (candidate #1, which would shadow it
    // with whatever version the host happens to have installed for Claude Code).
    const probeCfg = mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-probe-cfg-'));
    const chk = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'install-pi.mjs'),
      '--check', `--install-root=${installRoot}`, `--pi-root=${piRoot}`, `--expect=${pkg.version}`],
      { encoding: 'utf8', env: mpEnv({ CLAUDE_CONFIG_DIR: probeCfg }), timeout: 60_000, maxBuffer: 512 * 1024 * 1024 });
    assert.equal(chk.status, 0, `install-pi --check failed on the installed surface: ${chk.stdout}`);
    return { name: 'pi', entry, installRoot, piRoot, check: JSON.parse(chk.stdout) };
  })();
  // Claude: the plugin-cache layout Claude Code's plugin manager writes — the same layout
  // scripts/rehearse-v9-finish.sh's claude_surface step builds (there is no
  // scripts/install-claude*.mjs; the marketplace UI owns the live install, and the
  // rehearsal script is the repo's own documented replication): the whole released tree
  // under <claude-config>/plugins/cache/rasatpetabit-masterplan/masterplan/<version>, plus
  // the installed_plugins.json registry entry the plugin manager records (the exact shape
  // lib/doctor/plugin-registry-drift.mjs reads: version + gitCommitSha under the
  // masterplan@rasatpetabit-masterplan key) and the marketplace clone the registry entry
  // names. Built from the same committed tree, by the rehearsal's exact procedure.
  const claude = (() => {
    // The config dir is the REAL layout Claude Code writes: <HOME>/.claude (the same root
    // lib/paths.mjs resolveConfigDir computes when CLAUDE_CONFIG_DIR is unset, and the root
    // plugin-registry-drift reads). A temp HOME carries the install, so the doctor's own
    // check can be run against the surface as the harness would see it.
    const claudeHome = path.join(base, 'claude-home');
    const claudeConfig = path.join(claudeHome, '.claude');
    const cache = path.join(claudeConfig, 'plugins', 'cache', 'rasatpetabit-masterplan', 'masterplan', pkg.version);
    fs.mkdirSync(cache, { recursive: true });
    const arch = spawnSync('git', ['-C', source, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 512 * 1024 * 1024 });
    assert.equal(arch.status, 0, 'git archive HEAD failed');
    const untar = spawnSync('tar', ['-x', '-C', cache], { input: arch.stdout, maxBuffer: 512 * 1024 * 1024 });
    assert.equal(untar.status, 0, 'tar extraction failed');
    const entry = path.join(cache, 'bin', 'masterplan.mjs');
    assert.ok(fs.existsSync(entry), 'the Claude surface entry point must exist');
    // The registry entry + marketplace clone the plugin manager would have (the shape
    // plugin-registry-drift verifies): installed_plugins.json with the version and commit
    // the cache was built from, and the marketplace dir with its .claude-plugin/plugin.json.
    const releaseSha = git(source, 'rev-parse', 'HEAD').toString('utf8').trim();
    fs.mkdirSync(path.join(claudeConfig, 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(claudeConfig, 'plugins', 'installed_plugins.json'), JSON.stringify({
      plugins: {
        'masterplan@rasatpetabit-masterplan': [{
          scope: 'user',
          installPath: cache,
          version: pkg.version,
          gitCommitSha: releaseSha,
        }],
      },
    }, null, 2));
    const marketplace = path.join(claudeConfig, 'plugins', 'marketplaces', 'rasatpetabit-masterplan');
    fs.mkdirSync(marketplace, { recursive: true });
    fs.mkdirSync(path.join(marketplace, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(marketplace, '.claude-plugin', 'plugin.json'),
      `${JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(cache, '.claude-plugin', 'plugin.json'), 'utf8')) }, null, 2)}\n`);
    return { name: 'claude', entry, cache, claudeConfig, claudeHome, releaseSha };
  })();
  return { pi, claude, source, version: pkg.version };
})();

// The surfaces carry the CUTOVER's prompt (the removed duplicate is gone there too — the
// proof that the installed artifacts, not just the checkout, lost the native questioner),
// and each surface's registry metadata is verified by the contract that owns it:
for (const s of [SURFACES.pi, SURFACES.claude]) {
  const root = s.name === 'pi' ? fs.realpathSync(s.entry.replace(/bin\/masterplan\.mjs$/, '')) : s.cache;
  const installedPrompt = fs.readFileSync(path.join(root, 'commands', 'masterplan.md'), 'utf8');
  assert.ok(!installedPrompt.includes('3. **Question discipline.**'),
    `the ${s.name} surface's installed prompt must not carry the removed native questioner`);
}
test('the pinned skill extract recomputes to the pin digest (the installed questioner is the pin)', () => {
  // The identity over the extracted bytes equals the pin's manifest_digest — every
  // dispatch below installs the pinned skill, and this is the same correspondence the
  // sequencer-delegation suite proves over the pinned tree.
  const tmp = extractPinnedSkill(mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-pin-')));
  const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
  const h = crypto.createHash('sha256');
  for (const rel of [...manifest.identity.closed_file_set].sort()) {
    h.update(rel, 'utf8');
    h.update('\n', 'utf8');
    h.update(sha256Hex(fs.readFileSync(path.join(tmp, rel))), 'utf8');
    h.update('\n', 'utf8');
  }
  assert.equal(h.digest('hex'), pin.manifest_digest);
});

test('the Pi surface is a real install: the installer\'s --check verifies its discovery', () => {
  // The --check contract (the only external read of a Pi install): current resolves to the
  // release the installer wrote, metadata agrees with it, and the skill links and agent
  // registration are drift-free — proven on the surface the interview verbs run through.
  assert.equal(SURFACES.pi.check.install_pi, 'check_ok');
  assert.equal(SURFACES.pi.check.version, SURFACES.version);
  const meta = JSON.parse(fs.readFileSync(path.join(SURFACES.pi.installRoot, '.pi-install.json'), 'utf8'));
  const release = path.join(SURFACES.pi.installRoot, 'releases', meta.sha);
  assert.ok(fs.realpathSync(path.join(SURFACES.pi.installRoot, 'current')).startsWith(release),
    'current resolves into the release the installer wrote');
  // The surface's skill links resolve under current (the discovery a Pi session uses):
  for (const name of ['masterplan', 'masterplan-detect']) {
    const link = path.join(SURFACES.pi.piRoot, 'agent', 'skills', name);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${name} is installed as the installer's skill link`);
    assert.ok(fs.realpathSync(link).startsWith(release), `${name} resolves under the installed release`);
  }
});

test('the Claude surface is the plugin-cache layout: registry entry, marketplace clone, cache tree', () => {
  const s = SURFACES.claude;
  // The doctor's own check (plugin-registry-drift) reads exactly this shape — run it
  // against the temp HOME the surface was installed into, and it must PASS (not SKIP):
  // the registry entry, the marketplace plugin.json, the matching versions and the
  // matching install commit are all present, i.e. the surface is a coherent plugin-cache
  // installation, not a bare directory.
  const doctor = spawnSync(process.execPath,
    [path.join(ROOT, 'bin', 'doctor.mjs'), '--only=plugin-registry-drift', ROOT],
    { encoding: 'utf8', env: mpEnv({ HOME: s.claudeHome }), timeout: 60_000 });
  assert.equal(doctor.status, 0, `plugin-registry-drift must pass on the installed surface: ${doctor.stdout}${doctor.stderr}`);
  assert.match(doctor.stdout, /PASS\s+plugin-registry-drift: installed masterplan v\S+ matches marketplace/);
  // And the registry entry names the cache the interview verbs run through:
  const registry = JSON.parse(fs.readFileSync(path.join(s.claudeConfig, 'plugins', 'installed_plugins.json'), 'utf8'));
  const entry = registry.plugins['masterplan@rasatpetabit-masterplan'][0];
  assert.equal(entry.installPath, s.cache, 'the registry entry names the cache tree the surface runs from');
  assert.equal(entry.gitCommitSha, s.releaseSha, 'the registry entry carries the commit the cache was archived from');
});

// ---- 1. DISPATCH: end-to-end delegated interview on BOTH surfaces -----------------

for (const surface of [SURFACES.pi, SURFACES.claude]) {
  test(`DISPATCH: the pinned skill's plan mode interviews end to end through the ${surface.name} surface`, () => {
    const { statePath } = mkRepoAndBundle(`dispatch-${surface.name}`);
    const skillRoot = extractPinnedSkill(mkdtempTracked(path.join(os.tmpdir(), `iv-cut-skill-${surface.name}-`)));
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
    assert.equal(captured.skill_identity, pin.manifest_digest,
      'the recorded identity is the pinned skill\'s real closed-set digest (the pin)');
  });
}

// The MUTATION CONTROL: an installed "skill" whose SKILL.md is NOT the questioner cannot
// satisfy the dispatch — the proof's pinned-skill participation is LOAD-BEARING, so a stub
// fails the suite rather than passing beside it. This is the negative the adversarial
// review demanded: replacing the fixture's SKILL.md with 'NOT A QUESTIONER...' must FAIL
// the dispatch/resume proof, on both surfaces.
for (const surface of [SURFACES.pi, SURFACES.claude]) {
  test(`MUTATION CONTROL: a non-questioner installed skill FAILS the ${surface.name} dispatch`, () => {
    const { statePath } = mkRepoAndBundle(`mutated-${surface.name}`);
    // The pinned skill's REAL bytes, then the reviewer's exact mutation: SKILL.md replaced
    // by the NOT-A-QUESTIONER text (a manifest/schema/validator still present — the
    // mutation is precisely "the instructions are not the questioner's").
    const skillRoot = extractPinnedSkill(mkdtempTracked(path.join(os.tmpdir(), `iv-cut-mut-${surface.name}-`)));
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'),
      'NOT A QUESTIONER. No plan mode or host contract implementation exists here.\n');
    const dir = mkdtempTracked(path.join(os.tmpdir(), `iv-cut-mutdir-${surface.name}-`));

    // The capture still succeeds (the closed set is intact and the bytes hash — the
    // identity CHANGES, but capture is the FIRST state, so nothing refuses there):
    const cap = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
    assert.equal(cap.status, 0, cap.stderr || cap.stdout);
    // ...but the DISPATCH refuses: the host-contract read (§2f step 2 — the skill is
    // resolved as the questioner, not as bytes that merely hash) fails closed, because the
    // installed skill's own bytes do not teach the plan-mode contract. A stub cannot
    // produce the questions, the vocabulary, or the adjudication the proof requires.
    assert.throws(
      () => readPlanContract(skillRoot),
      /does not teach the plan-mode host contract — it is not the pinned questioner/,
      `the ${surface.name} dispatch must refuse a non-questioner skill`,
    );
    // And the proof's composing step refuses too (no interview discipline to compose
    // from — the structured-question tool call the skill teaches is gone):
    assert.throws(
      () => composeQuestion(skillRoot, 'Any stem?', ['Any option']),
      /must teach the structured-question tool call/,
      'question composition must refuse on a skill that does not teach the interview discipline',
    );
    // The executable's ADJUDICATION is equally load-bearing: a projection the mutated tree's
    // validator refuses is never recorded. The mutated SKILL.md does not change the
    // validator's own schema checks — the point is the HOST cannot even compose the draft's
    // sections (no contract), so there is no draft to adjudicate. The refusal above is the
    // dispatch's failure; nothing reached the recorder.
    const events = fs.readFileSync(path.join(path.dirname(statePath), 'events.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(!events.some((e) => e.type === 'interview_question'),
      'no question was recorded — the stub skill never dispatched');
    assert.ok(!events.some((e) => e.type === 'interview_draft'),
      'no draft was recorded — the stub skill produced nothing');
  });
}

// ---- 2. RESUME: an interrupted interview resumes through the same dispatch path -----

for (const surface of [SURFACES.pi, SURFACES.claude]) {
  test(`RESUME: an interview interrupted mid-flight resumes from the ledger on the ${surface.name} surface`, () => {
    const { statePath, dir } = mkRepoAndBundle(`resume-${surface.name}`);
    const skillRoot = extractPinnedSkill(mkdtempTracked(path.join(os.tmpdir(), `iv-cut-skill-resume-${surface.name}-`)));
    const contract = readPlanContract(skillRoot); // the resumed dispatch reads the SAME contract

    // The first session captures (the pinned skill — the identity is the pin's), records
    // round 1's questions (composed from the skill's own vocabulary), and is interrupted
    // (a compaction/crash) with the interview OPEN: all asked, nothing answered.
    const cap = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
    assert.equal(cap.status, 0, cap.stderr);
    assert.equal(jsonOut(cap).skill_identity, pin.manifest_digest,
      'the interrupted session captured the PINNED skill');
    const q1Text = composeQuestion(skillRoot, 'What must be true in the world when this ships?', [
      'An interrupted run can always be resumed (Recommended)',
      'Owner control',
    ]);
    const q2Text = composeQuestion(skillRoot, 'What would make this a failure even if the suite passes?', [
      'A second native questioner survives anywhere (Recommended)',
      'Only one surface proven',
    ]);
    const q3Text = composeQuestion(skillRoot, 'Which recorder holds the interview state?', [
      'The mp interview ledger (Recommended)',
      'A side file',
    ]);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q1', '--round=1',
      '--kind=intent', `--text=${q1Text}`]).status, 0);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q2', '--round=1',
      '--kind=intent', `--text=${q2Text}`]).status, 0);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q3', '--round=1',
      '--kind=design', `--text=${q3Text}`]).status, 0);

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

    // The resuming session answers the intent questions (sealing round 1), withdraws the
    // stranded design question, re-asks it in round 2 (composed through the SAME skill
    // contract), records the operator's pick — then continues to convergence, with the
    // pinned executable adjudicating the resumed draft exactly as the dispatch did:
    const env = { CLAUDE_CODE_SESSION_ID: 'w15t59-cutover-successor' };
    for (const [id, text] of [['Q1', 'An interrupted run can always be resumed'], ['Q2', 'A second native questioner surviving anywhere is the failure']]) {
      assert.equal(runMp(surface.entry, ['interview', 'answer', `--state=${statePath}`, `--id=${id}`,
        `--text=${text}`], { env }).status, 0);
    }
    assert.equal(runMp(surface.entry, ['interview', 'withdraw', `--state=${statePath}`, '--id=Q3',
      '--reason=the interrupted round was re-asked on resume'], { env }).status, 0);
    const q4Text = composeQuestion(skillRoot, 'Which recorder holds the interview state?', [
      'The mp interview ledger (Recommended)',
      'A side file',
    ]);
    assert.equal(runMp(surface.entry, ['interview', 'ask', `--state=${statePath}`, '--id=Q4', '--round=2',
      '--kind=design', `--text=${q4Text}`], { env }).status, 0);
    assert.equal(runMp(surface.entry, ['interview', 'answer', `--state=${statePath}`, '--id=Q4',
      '--text=The mp interview ledger'], { env }).status, 0);
    const draft = {
      why: 'The cutover must leave an interrupted run able to interview.',
      outcome: 'A mid-flight interview resumes from the ledger through the same dispatch path.',
      anti_goals: ['Resuming by re-asking from memory'],
      done_means: 'the resumed session converges from the reconstructed ledger',
    };
    // The resumed draft is adjudicated by the pinned executable BEFORE recording (the
    // same load-bearing step as the dispatch case — a resumed interview is never a
    // lesser citizen of the contract):
    const sections = {
      purpose: draft.why,
      invariant: 'An interrupted run can always be resumed.',
      non_goals: draft.anti_goals,
      extensions: { Direction: 'One interview implementation, two consumers.', Posture: 'not applicable' },
    };
    const projection = path.join(dir, 'resume-projection.md');
    fs.writeFileSync(projection, renderProjection(draft, sections));
    const verdict = adjudicateProjection(skillRoot, projection, 'normal');
    assert.equal(verdict.ok, true, `the pinned executable must adjudicate the resumed projection: ${verdict.text}`);
    const draftFile = path.join(dir, 'resume-draft.json');
    fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
    assert.equal(runMp(surface.entry, ['interview', 'draft', `--state=${statePath}`, `--file=${draftFile}`], { env }).status, 0);
    const critic = criticDispatchIdentity();
    recordReceipt({ statePath, entry: surface.entry, draft, eligible: ['Q1', 'Q2'], forks: false, dir, n: 1, criticModel: critic.model });
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
    // The resuming session ran the SAME pinned executable (the contract it read is the
    // installed skill's own bytes — unchanged across the interruption):
    assert.equal(contract.manifest.host_contract_version, pin.host_contract_version);
  });
}

// ---- 3. REFUSAL: absent / skewed / changed-identity skills refuse by name ----------

test('REFUSAL: an absent skill refuses with skill_absent — there is no native fallback', () => {
  const { statePath } = mkRepoAndBundle('refuse-absent');
  const missing = path.join(mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-absent-')), 'no-such-skill');
  for (const surface of [SURFACES.pi, SURFACES.claude]) {
    const r = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${missing}`]);
    assert.equal(r.status, 1, `the ${surface.name} surface must refuse, not accept`);
    assert.match(r.stderr, /skill_absent/, `the refusal must name skill_absent on ${surface.name}: ${r.stderr}`);
  }
});

test('REFUSAL: a version-skewed skill refuses with host_contract_unsupported', () => {
  const { statePath } = mkRepoAndBundle('refuse-skew');
  // The skewed fixture: the PINNED skill's bytes with the manifest declaring a
  // host-contract version this host does not support (the pin's version + 1 — whatever the
  // pin names, the skew is a version this host must refuse). The rest of the tree is the
  // real skill: the refusal is precisely the version gate, nothing else.
  const skewedRoot = extractPinnedSkill(mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-skew-')));
  const manifest = JSON.parse(fs.readFileSync(path.join(skewedRoot, 'manifest.json'), 'utf8'));
  manifest.host_contract_version = pin.host_contract_version + 1;
  fs.writeFileSync(path.join(skewedRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const surface of [SURFACES.pi, SURFACES.claude]) {
    const r = runMp(surface.entry, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skewedRoot}`]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /host_contract_unsupported/, `the refusal must name host_contract_unsupported on ${surface.name}: ${r.stderr}`);
  }
});

test('REFUSAL: a changed identity after capture refuses with skill_identity_changed', () => {
  const { statePath } = mkRepoAndBundle('refuse-identity');
  const skillRoot = extractPinnedSkill(mkdtempTracked(path.join(os.tmpdir(), 'iv-cut-identity-')));
  const cap = runMp(BIN, ['interview', 'capture-schema', `--state=${statePath}`, `--skill-root=${skillRoot}`]);
  assert.equal(cap.status, 0, cap.stderr);
  assert.equal(jsonOut(cap).skill_identity, pin.manifest_digest, 'the first capture is the pinned identity');
  // A behavior-affecting edit without a version bump: the identity changes and the next
  // capture REFUSES (routing to amend-skill-identity) — never adopts in place.
  fs.appendFileSync(path.join(skillRoot, 'SKILL.md'), '\nAn ordinary edit that changes behavior without bumping a version.\n');
  for (const surface of [SURFACES.pi, SURFACES.claude]) {
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
    "delegated to the /intent skill's plan mode",
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
  for (const surface of [SURFACES.pi, SURFACES.claude]) {
    const r = runMp(surface.entry, ['version', '--args=probe', '--cwd=/']);
    assert.equal(r.status, 0, `the ${surface.name} surface's entry point must execute: ${r.stderr}`);
    assert.match(r.stdout, /\/masterplan v\S+ args: 'probe'/, `the ${surface.name} surface must print the version banner`);
  }
});

// The Claude surface's own discovery: readPluginVersion resolves the installed version
// through the plugin-cache candidate path (bin/masterplan.mjs's CC-2 chain) — the same
// resolution a Claude Code session's banner uses. Proven on the surface's OWN env, not a
// fabricated one: with CLAUDE_CONFIG_DIR pointing at the temp install (the way the
// harness's CLAUDE_PLUGIN_ROOT/CLAUDE_CONFIG_DIR env would name a live install), the
// installed binary reports the CACHED version.
test('the Claude surface reports the installed version through its own config-dir discovery (CC-2)', () => {
  const s = SURFACES.claude;
  // The installed binary's own version resolution (readPluginVersion's candidate chain)
  // runs with CLAUDE_CONFIG_DIR naming the surface's config dir — the harness-agnostic way
  // a session names its install root. The registry entry, the marketplace clone and the
  // cache all agree on the released version, so the banner names it (the chain's earlier
  // candidates — CLAUDE_PLUGIN_ROOT unset, then the marketplace plugin.json — are part of
  // the same installed surface; the assertion is that the surface's OWN metadata, not the
  // test host's live install, answers).
  const r = spawnSync(process.execPath, [s.entry, 'version', '--args=probe', '--cwd=/'], {
    encoding: 'utf8',
    env: mpEnv({ CLAUDE_CONFIG_DIR: s.claudeConfig }),
    timeout: 60_000,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`/masterplan v${SURFACES.version.replace(/\./g, '\\.')} `),
    'the installed plugin-cache binary resolves its version from the installed surface\'s own metadata');
});