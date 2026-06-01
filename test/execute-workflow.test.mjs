// test/execute-workflow.test.mjs — behavior tests for the L2 within-session engine (build step 4).
//
// The engine is a Workflow-tool SCRIPT, not a module: it runs under the Workflow runtime against the
// injected agent()/pipeline()/parallel()/phase()/log()/args/budget globals, and ends with a top-level
// `return`. Plain `import` can't load it (the bare `return` is a SyntaxError at module scope, and
// `export const meta` is module-only). So we run it in-process the way the runtime does — strip the ES
// `export` keyword, wrap the source in an AsyncFunction (whose body legally hosts both `return` and the
// stripped `const meta`), and inject faithful mocks of the runtime globals.
//
// PRIMARY REGRESSION (parity-dogfood step 8 cutover-blocker): the `Workflow` TOOL boundary delivers
// object `args` JSON-STRINGIFIED, so the script's `args` global is a STRING, not an object. A 0-agent
// probe confirmed this empirically. Before the fix, the engine read `args?.tasks === undefined` →
// tasks=[] → an empty wave on EVERY tool-launched (i.e. production) run. The engine now normalizes a
// string `args` via JSON.parse, staying robust to BOTH launch paths (tool string + in-script object).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'execute.workflow.js');
const SRC = readFileSync(ENGINE, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// Faithful mocks of the Workflow runtime globals:
//   pipeline(items, ...stages) threads (prevResult, originalItem, index) through each stage per item
//   agent(prompt, opts) returns the (schema-validated, here mocked) digest object
//   parallel(thunks) awaits all; budget exposes spent()/remaining()
function runEngine(args, { agentImpl } = {}) {
  const body = SRC.replace(/export\s+const/g, 'const');
  const fn = new AsyncFunction('args', 'budget', 'agent', 'pipeline', 'parallel', 'phase', 'log', body);
  const calls = { agent: 0, agentPrompts: [] };
  const defaultDigest = async () => ({ task_id: 0, status: 'done', files_changed: ['x.mjs'], summary: 'mock' });
  const agent = agentImpl ?? defaultDigest;
  const wrappedAgent = async (prompt, opts) => {
    calls.agent++;
    calls.agentPrompts.push({ prompt, opts });
    return agent(prompt, opts);
  };
  const pipeline = async (items, ...stages) => {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      let r = items[i];
      for (const s of stages) r = await s(r, items[i], i);
      out.push(r);
    }
    return out;
  };
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  return fn(args, budget, wrappedAgent, pipeline, parallel, () => {}, () => {}).then((result) => ({ result, calls }));
}

const WAVE1 = [
  { id: 1, description: 'greet', files: ['src/greet.mjs'], verify_commands: [], target: 'inline', reason: 'judgment' },
  { id: 2, description: 'farewell', files: ['src/farewell.mjs'], verify_commands: [], target: 'inline', reason: 'judgment' },
];

// --- PRIMARY REGRESSION: the cutover-blocker path ---
test('string args (Workflow-tool boundary) → non-empty wave dispatched', async () => {
  // This is EXACTLY what the Workflow tool hands the script: object args, JSON-stringified.
  const args = JSON.stringify({
    wave: 1, tasks: WAVE1, baseline: [], repoRoot: '/tmp/x', review: 'off',
    implAgentType: 'general-purpose', implModel: 'sonnet',
  });
  const { result, calls } = await runEngine(args);
  assert.equal(result.summary.total, 2, 'string args MUST yield total=2 (was 0 before the fix → empty wave)');
  assert.equal(result.summary.done, 2);
  assert.equal(calls.agent, 2, 'both implementers dispatched');
  assert.equal(result.summary.reviewOn, false);
  // The seam reads (implAgentType/implModel) must survive normalization too, not just the core fields.
  assert.equal(calls.agentPrompts[0].opts.agentType, 'general-purpose', 'seam agentType read from normalized args');
  assert.equal(calls.agentPrompts[0].opts.model, 'sonnet', 'seam model read from normalized args');
});

// --- the OTHER launch path must still work (no regression) ---
test('object args (in-script workflow() path) → identical non-empty wave', async () => {
  const args = { wave: 1, tasks: WAVE1, baseline: ['src/greet.mjs'], repoRoot: '/tmp/x', review: 'off' };
  const { result, calls } = await runEngine(args);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.done, 2);
  assert.equal(calls.agent, 2);
  assert.deepEqual(result.baseline, ['src/greet.mjs'], 'baseline echoed back unchanged for the D6 diff');
});

// --- the legitimate empty-wave path is preserved (NOT confused with the bug) ---
test('undefined args → well-formed empty result, nothing dispatched', async () => {
  const { result, calls } = await runEngine(undefined);
  assert.equal(result.summary.total, 0);
  assert.equal(calls.agent, 0, 'an empty wave dispatches no agents');
  assert.ok(Array.isArray(result.tasks) && result.tasks.length === 0);
  assert.ok(Array.isArray(result.baseline));
});

test('string "{}" args → empty result, no throw', async () => {
  const { result, calls } = await runEngine('{}');
  assert.equal(result.summary.total, 0);
  assert.equal(calls.agent, 0);
});

// --- fail-loud invariant: a malformed launch must throw, NEVER silently empty-wave ---
test('malformed string args → throws (fail-loud, not a silent zero-task wave)', async () => {
  await assert.rejects(() => runEngine('{not valid json'), /JSON|Unexpected|token/i);
});

// --- SCOPED-DIFF HARDENING: the reviewer is handed a pre-built, path-filtered diff, never told to
//     free-roam the working tree (which holds unrelated sibling-task + user dirty files → verdict
//     pollution). reviewerPrompt now emits an EXACT `git diff -- <quoted files>` and a "review ONLY
//     this" instruction; the old "find the wave's changes" free-roam phrasing is gone. ---
test('review ON → reviewer prompt carries a pre-built scoped diff, not a free-roam git instruction', async () => {
  const agentImpl = async (prompt, opts) => {
    // Reviewer calls return text (ignored — we assert on the PROMPT). Implementer calls return a
    // task-specific digest so the scoped diff is built from real, per-task file lists.
    if (opts.phase === 'Review') return 'NOTE — mock. verdict: clean';
    const isTask1 = /task 1\b/.test(prompt);
    return {
      task_id: isTask1 ? 1 : 2,
      status: 'done',
      files_changed: isTask1 ? ['src/greet.mjs'] : ['src/farewell.mjs', "src/o'brien.mjs"],
      summary: 'mock',
    };
  };
  const args = { wave: 1, tasks: WAVE1, baseline: [], repoRoot: '/tmp/x', review: 'on' };
  const { result, calls } = await runEngine(args, { agentImpl });
  assert.equal(result.summary.reviewOn, true);
  assert.equal(result.summary.reviewed, 2, 'both done tasks reviewed');

  const reviewPrompts = calls.agentPrompts.filter((c) => c.opts.phase === 'Review').map((c) => c.prompt);
  assert.equal(reviewPrompts.length, 2, 'one reviewer dispatch per done task');
  const joined = reviewPrompts.join('\n---\n');

  // (a) the pre-built, path-filtered diff command — single file
  assert.ok(joined.includes(`git diff -- 'src/greet.mjs'`), 'task 1 reviewer gets a scoped diff of its file');
  // (b) multi-file + a single-quote in the path is shell-escaped (injection-safe)
  assert.ok(joined.includes(`git diff -- 'src/farewell.mjs' 'src/o'\\''brien.mjs'`), 'multi-file + odd name single-quote-escaped');
  // (c) the pollution trigger is GONE
  assert.ok(!/find the wave's changes/.test(joined), "the old free-roam 'find the changes' instruction is removed");
  // (d) reviewer confined to the diff and warned off a whole-tree diff
  assert.ok(/review ONLY its output/i.test(joined), 'reviewer confined to the scoped diff');
  assert.ok(/Do NOT run a bare `git diff`/i.test(joined), 'reviewer warned off the whole-tree diff');
});

test('review ON + no declared files → reviewer prompt falls back to an explicit UNSCOPED note', async () => {
  const agentImpl = async (prompt, opts) => {
    if (opts.phase === 'Review') return 'NOTE — mock. verdict: clean';
    return { task_id: 1, status: 'done', files_changed: [], summary: 'mock' };
  };
  const args = { wave: 1, tasks: [WAVE1[0]], baseline: [], repoRoot: '/tmp/x', review: 'on' };
  const { calls } = await runEngine(args, { agentImpl });
  const review = calls.agentPrompts.find((c) => c.opts.phase === 'Review');
  assert.ok(review, 'reviewer dispatched for the done task');
  assert.ok(/UNSCOPED/.test(review.prompt), 'no file list → explicit UNSCOPED caveat');
  assert.ok(!/git diff --/.test(review.prompt), 'no scoped diff command emitted when there are no files');
});
