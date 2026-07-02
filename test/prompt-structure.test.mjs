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
  'dispatch_wave', // launch prep → the launch_workflow op
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
  for (const op of ['launch_workflow', 'dispatch_foreground', 'probe', 'run_skill', "ask:'gate'",
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
  for (const flag of ['--goals-met', '--goals-unmet', '--goals-waived', '--waiver-reason', '--manual-verdict']) {
    assert.ok(prompt.includes(flag), `goal-check answer flag missing ${flag}`);
  }
});

test('deliberate survivors stay (teardown recorder, plan marker, legacy import)', () => {
  // These mp verbs were NOT absorbed — their disappearance would mean an over-zealous scrub.
  for (const keep of ['mp worktree record', 'mp set-active-run', 'mp promote-active-run',
    'mp migrate-bundle', 'mp record-result']) {
    assert.ok(prompt.includes(keep), `expected surviving reference: ${keep}`);
  }
});
