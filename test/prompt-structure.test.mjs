// test/prompt-structure.test.mjs — T2.3 structural guard: the prompt no longer contains the
// sequences `mp continue` / `mp sweep` absorbed. The 818-line v8 prompt was the spec; once an
// increment moves a transaction into code, the prose MUST go with it — a resurrected reference
// here means someone re-taught the LLM a transaction the subcommand already owns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = fs.readFileSync(path.join(ROOT, 'commands', 'masterplan.md'), 'utf8');

// Sequences absorbed into mp continue / mp sweep (T2.3). `(?<![-a-z])re-decide` avoids the
// legitimate word "pre-decided"; the rest are exact-enough literals.
const ABSORBED = [
  'prepare-wave', // routing + dispatch prep → continueRun
  'backfill-waves', // wave backfill → continueRun (durable, internal)
  'worktree reconcile', // sweep classification+execution → mp sweep
  '`mp worktree plan', // create-or-reuse planning → ensureWorktree
  'surface_gate', // gate re-render → the §2 ask:'gate' op
  'dispatch_wave', // launch prep → the dispatch_fabric op
  'recover_plan_run', // plan-run recovery → continueRun probe/reap path
  /(?<![-a-z])re-decide/, // the per-turn decide loop → the §2 trampoline
  // T2.4 — sequences absorbed into mp finish-step (lib/finish-step.mjs):
  'mp finish-status', // the WT snapshot (head/porcelain/branches flags) → finishStep's own git
  'record-verification', // verified-at-SHA record → --verify-passed
  'adversary-review-status', // the durable review re-entry guard → sha-keyed event scan in finishStep
  'set-worktree-disposition', // the old static-map write → dispositionAfterTeardown in --choice
  '--type=adversary_review', // the event is emitted by finishStep (--review-done/skipped), not mp event
  '--type=branch_finish', // ditto — the --choice transaction events internally
];

for (const seq of ABSORBED) {
  const name = typeof seq === 'string' ? seq : seq.source;
  test(`prompt no longer references absorbed sequence: ${name}`, () => {
    const hit = typeof seq === 'string' ? prompt.includes(seq) : seq.test(prompt);
    assert.equal(hit, false, `commands/masterplan.md still mentions "${name}" — that sequence lives in code now`);
  });
}

test('prompt teaches the replacements (mp continue trampoline + mp sweep)', () => {
  assert.ok(prompt.includes('mp continue'), 'the §2 trampoline contract must name mp continue');
  assert.ok(prompt.includes('mp sweep'), 'the session sweep must name mp sweep');
  // The op table is the contract's load-bearing surface — every typed op must be taught.
  for (const op of ['dispatch_fabric', 'dispatch_plan', 'run_skill', "ask:'gate'",
    "ask:'owner-blocked'", "ask:'legacy-refused'", "ask:'waves-unbackfillable'", "reason:'wait'"]) {
    assert.ok(prompt.includes(op), `op table missing ${op}`);
  }
});

test('prompt teaches the finish trampoline (mp finish-step op table, T2.4)', () => {
  assert.ok(prompt.includes('mp finish-step'), 'the §2c contract must name mp finish-step');
  for (const op of ['run_verify', 'write_retro', 'run_adversary_review', "gate:'branch_finish'",
    "gate:'verification_failed'", "gate:'docs_normalize'", "kind:'push_pr'", "reason:'archived'",
    "reason:'retro_done'"]) {
    assert.ok(prompt.includes(op), `§2c op table missing ${op}`);
  }
  // The answer flags ARE the resolution surface — each must be taught or a gate dead-ends.
  for (const flag of ['--verify-passed', '--verify-failed', '--review-done', '--review-skipped',
    '--docs-normalized', '--docs-skipped', '--choice=', '--pushed', '--removal-force', '--retro-only']) {
    assert.ok(prompt.includes(flag), `§2c answer flag missing ${flag}`);
  }
});

test('prompt teaches the goal-tracking contract (typed ops, gate, capture verb + finish flags)', () => {
  // The §2c goal ops + the goals gate are the load-bearing goal-tracking surface — each must be taught.
  for (const op of ['run_goal_check', "gate:'goals_unmet'", 'run_goals_capture']) {
    assert.ok(prompt.includes(op), `goal-tracking op/gate missing ${op}`);
  }
  // The goals-capture verb freezes the run's goals — without it a goals-enabled bundle can't be armed.
  assert.ok(prompt.includes('mp goals-load'), 'the goals-capture contract must name mp goals-load');
  // The goal-check answer flags ARE the resolution surface — each must be taught or the goal gate dead-ends.
  // A1 (2026-08-30): the engine vocabulary (GOALS_CHOICES = fix|waiver|abort in lib/finish-step.mjs) — the
  // former --goals-met/--goals-unmet/--goals-waived/--waiver-reason/--manual-verdict were never read by
  // bin (a silently-dead gate); bin now threads --goal-check / --goals-choice into finishStep's ctx.
  for (const flag of ['--goal-check=failed', '--goals-choice=fix', '--goals-choice=waiver', '--goals-choice=abort', 'mp record-goal-check']) {
    assert.ok(prompt.includes(flag), `goal-check answer flag missing ${flag}`);
  }
});

test('prompt teaches the intent-to-completion dispatch contracts (critic blocks, assessor modes, binding fields)', () => {
  // The critic dispatch must be taught to pass VERBATIM question/answer text (via the replay
  // ledger), not a budget summary — the whole point of the fresh-context critic is that it
  // judges the operator's actual words, which a round/asked/answered roll-up cannot carry.
  // The block is parsed BOUNDED (between the §2f step-4 heading and the step-5 heading) so a
  // deletion anywhere else in the document cannot satisfy it.
  const start = prompt.indexOf('4. **Draft + critic round**');
  const end = prompt.indexOf('5. **Convergence and exit.**');
  assert.ok(start !== -1 && end > start, 'the §2f draft+critic round anchor must exist — update the structure test anchors');
  const criticSection = prompt.slice(start, end);
  // Exactly ONE dispatch paragraph: the block containing the three quoted-data blocks.
  const dispatchMentions = criticSection.match(/dispatch \*\*`mp-intent-critic`\*\*/g) ?? [];
  assert.equal(dispatchMentions.length, 1, `the critic dispatch block must appear exactly once in the §2f round, got ${dispatchMentions.length}`);
  assert.ok(criticSection.includes('mp-intent-critic'), 'the critic must be dispatched by its bare registered name');
  assert.ok(criticSection.includes('mp interview replay'), 'the critic contract must name mp interview replay (the verbatim ledger source)');
  assert.ok(criticSection.includes('mp interview critic'), 'the critic receipt must be recorded through mp interview critic');
  assert.ok(criticSection.includes('question and answer TEXT'), 'the critic dispatch block must carry question and answer text, not only a budget summary');
  // The three ordered quoted-data blocks, in order: seed topic, replay ledger, intent draft.
  // The order matters — the block names them (a), (b), (c) and the reviewer must not reorder.
  const blocks = ['(a) the verbatim seed topic', '(b) the verbatim interview', '(c) the current intent draft'];
  const positions = blocks.map((b) => criticSection.indexOf(b));
  assert.ok(positions.every((p) => p !== -1), `a quoted-data block is missing from the critic dispatch: ${JSON.stringify(blocks)}`);
  assert.ok(positions[0] < positions[1] && positions[1] < positions[2], 'the three critic quoted-data blocks must appear in (a) seed-topic, (b) replay-ledger, (c) intent-draft order');
  // The replay-derived ledger block must carry question AND answer text (not a budget roll-up).
  assert.ok(criticSection.includes('every question, answer, withdrawal, draft, and critic receipt in order'), 'the replay ledger block must enumerate question AND answer text');
  // The assessor runs in two governed modes; each mode's binding fields are taught.
  // Mode names and binding fields are pinned AT THE ROW (finding 2): the pre-disposition
  // assessor row must name `implementation` mode AND the verify-output payload, and the
  // final-mode row must name `final` mode AND the binding tuple — whole-document includes()
  // would pass if those words moved anywhere else, so constrain to the §2c rows.
  const c2c = prompt.indexOf('## 2c');
  const c2d = prompt.indexOf('## 2d');
  assert.ok(c2c !== -1 && c2d > c2c, 'the §2c/§2d anchors must exist — update the structure test anchors');
  const c2 = prompt.slice(c2c, c2d);
  const goalCheckRow = c2.split('\n').find((l) => l.includes('run_goal_check'));
  const finalCheckRow = c2.split('\n').find((l) => l.includes('run_final_check'));
  assert.ok(goalCheckRow, 'the §2c run_goal_check row must exist');
  assert.ok(finalCheckRow, 'the §2c run_final_check row must exist');
  assert.ok(goalCheckRow.includes('`implementation` mode'), 'the run_goal_check row must name `implementation` mode (the pre-disposition assessor)');
  assert.ok(goalCheckRow.includes('verify'), 'the run_goal_check row must supply the verify output to the implementation-mode assessor');
  assert.ok(finalCheckRow.includes('`final` mode'), 'the run_final_check row must name `final` mode');
  for (const field of ['deploy_base_sha', 'deploy_chain_hash', 'live_check_digest']) {
    assert.ok(finalCheckRow.includes(field), `the final-mode binding field ${field} must be in the run_final_check row`);
  }
  assert.ok(prompt.includes('mp record-goal-check --final'), 'the final assessment must be recorded via mp record-goal-check --final');
  // The intent-rejection successor contract: a required --successor and the required_successor event.
  assert.ok(prompt.includes('--successor'), 'the intent-rejection --successor flag must be taught');
  assert.ok(prompt.includes('required_successor'), 'the required_successor obligation must be taught');
  // Named terminal interview states are the absorbing exit contract.
  for (const t of ['converged', 'exhausted', 'critic_off']) {
    assert.ok(prompt.includes(t), `interview terminal state ${t} must be taught`);
  }
});

// Intent-to-completion flow anchors that the bootstrap stage and the seed overlap check require.
test('prompt teaches the seed overlap review and the bootstrap-stage sequencing', () => {
  assert.ok(prompt.includes('overlap.review'), 'the seed-time overlap review must be taught');
  assert.ok(prompt.includes('mp runs list'), 'runs list must be taught as the overlap-review inventory source');
  assert.ok(prompt.includes('bootstrap-v10.mjs'), 'the bootstrap driver must be taught by its script path');
  assert.ok(/bootstrap-v10\.mjs.*arm/s.test(prompt), 'the bootstrap arm -> run -> record loop must be taught');
  assert.ok(prompt.includes('required_successor'), 'the pre-finish required_successor handoff must be taught');
  assert.ok(prompt.includes('mp context-status'), 'the turn-close measured-context command must be taught');
  // Bootstrap-stage ORDER (finding 6): the stage section must teach the sequencing that
  // makes it a release gate — surfaces_live completes BEFORE mp finish; arm gate + record
  // gate execute inside branch_finish handling BEFORE --choice=merge; the required_successor
  // handoff (pinned v9 mp event) is recorded before mp finish. Whole-document word-distance
  // checks cannot pin order, so assert each pair's relative position within the stage section.
  const stage = prompt.slice(prompt.indexOf('## 10 — Bootstrap stage'));
  assert.ok(stage.includes('## 10 — Bootstrap stage'), 'the bootstrap-stage section must exist');
  // Normalize whitespace so a line-wrapped phrase (e.g. "before\n     `mp finish` begins")
  // matches the anchor it was written as.
  const flatStage = stage.replace(/\s+/g, ' ');
  const ordered = [
    ['through `surfaces_live`', 'before `mp finish` begins'],
    ['arm --step=gate', 'record --step=gate'],
    ['record --step=gate', '--choice=merge'],
    ['through `surfaces_live`', 'required_successor'],
  ];
  for (const [before, after] of ordered) {
    const b = flatStage.indexOf(before);
    const a = flatStage.indexOf(after);
    assert.ok(b !== -1, `bootstrap stage must teach "${before}"`);
    assert.ok(a !== -1, `bootstrap stage must teach "${after}"`);
    assert.ok(b < a, `bootstrap stage must sequence "${before}" before "${after}"`);
  }
  // The required_successor handoff must go through the pinned v9 mp event (the installed
  // 9.10.0 runs this stage) — not a repo-relative binary.
  assert.ok(stage.includes('mp event'), 'the required_successor handoff must be recorded through mp event');
  // Knob-marker inventory (finding 6): enumerate every `<!-- knob: NAME -->` marker and assert
  // each names a prompt-only control, and there is MORE than one (a single marker would pass
  // the old includes() check while every other prompt-only control went undeclared).
  const knobs = [...prompt.matchAll(/<!-- knob: ([a-zA-Z0-9_.]+) -->/g)].map((m) => m[1]);
  const uniqueKnobs = [...new Set(knobs)];
  assert.ok(uniqueKnobs.length > 1, `expected more than one knob marker, found ${uniqueKnobs.length}: ${uniqueKnobs.join(', ')}`);
  for (const knob of uniqueKnobs) {
    assert.ok(knob.length > 0, 'every knob marker must name a control');
    // The marker must resolve to a control the doc introduces — each named control must appear
    // in prose (the knob declaration names a control; the inventory guard resolves it).
    assert.match(prompt, new RegExp(knob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `knob ${knob} must be referenced in the prompt`);
  }
});

test('deliberate survivors stay (teardown recorder, plan marker, legacy import)', () => {
  // These mp verbs were NOT absorbed — their disappearance would mean an over-zealous scrub.
  // mp promote-run was deliberately retired from the prompt in E1 (2026-08-30): it remains
  // implemented in bin for mid-flight L2 recovery only (see bin-masterplan.test.mjs), but is no
  // longer taught as a live launch step — the fabric path never promotes.
  for (const keep of ['mp worktree record', 'mp set-active-run',
    'mp migrate-bundle', 'mp record-result']) {
    assert.ok(prompt.includes(keep), `expected surviving reference: ${keep}`);
  }
});

test('wave review docs point to the native review seam and contain no local review-engine contract', () => {
  const files = [
    'docs/internals/wave-dispatch.md',
    'docs/internals/task-verification.md',
    'docs/conventions/adversarial-review-failure-policy.md',
    'commands/masterplan.md',
  ];
  const text = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  assert.match(text, /adversary class|native review/i);
  assert.match(text, /run_native_reviews|--reviews-file/);
  assert.doesNotMatch(text, /REVIEW_DIFF_MAX_BYTES|segmentDiffPayload|reviewer count is 1 \(not a panel\)/);
});
