// test/plan-workflow.test.mjs — behavior tests for the L2 within-session PLANNING engine.
//
// Sibling of execute-workflow.test.mjs. The engine is a Workflow-tool SCRIPT (not a module): it ends
// with a top-level `return` and uses `export const meta`, neither legal at module scope. So we run it
// the way the runtime does — strip the ES `export` keyword, wrap the source in an AsyncFunction, and
// inject faithful mocks of the runtime globals (here: args/budget/agent/parallel/phase/log — this
// engine uses parallel(), not pipeline()).
//
// PRIMARY REGRESSION (same class as the execute engine's cutover-blocker): the `Workflow` TOOL boundary
// delivers object `args` JSON-STRINGIFIED, so the script's `args` global is a STRING. Without the
// JSON.parse seam the engine reads `subsystems === undefined` → an empty fan-out on every real run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', 'workflows', 'plan.workflow.js');
const SRC = readFileSync(ENGINE, 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function runEngine(args, { agentImpl } = {}) {
  const body = SRC.replace(/export\s+const/g, 'const');
  const fn = new AsyncFunction('args', 'budget', 'agent', 'parallel', 'phase', 'log', body);
  const calls = { agent: 0, agentPrompts: [] };
  // Default drafter echoes a one-task fragment for the subsystem it was asked about.
  const defaultFragment = async (prompt, opts) => {
    const key = (opts?.label ?? 'draft:?').replace(/^draft:/, '');
    return { key, tasks: [{ key: `${key}.t1`, description: `do ${key}`, files: [`${key}.js`], verify_commands: [`test ${key}`] }] };
  };
  const agent = agentImpl ?? defaultFragment;
  const wrappedAgent = async (prompt, opts) => {
    calls.agent++;
    calls.agentPrompts.push({ prompt, opts });
    return agent(prompt, opts);
  };
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t()));
  const budget = { total: null, spent: () => 0, remaining: () => Infinity };
  return fn(args, budget, wrappedAgent, parallel, () => {}, () => {}).then((result) => ({ result, calls }));
}

const SUBS = [
  { key: 'auth', title: 'Auth', description: 'login + sessions' },
  { key: 'api', title: 'API', description: 'REST surface' },
];

// --- PRIMARY REGRESSION: string args (the Workflow-tool boundary) ---
test('string args (Workflow-tool boundary) → fan-out drafts every subsystem', async () => {
  const { result, calls } = await runEngine(JSON.stringify({ subsystems: SUBS }));
  assert.equal(calls.agent, 2);                       // one drafter per subsystem
  assert.equal(result.subsystems.length, 2);
  assert.deepEqual(result.subsystems.map((f) => f.key).sort(), ['api', 'auth']);
});

test('object args (in-script workflow() path) also work', async () => {
  const { result } = await runEngine({ subsystems: SUBS });
  assert.equal(result.subsystems.length, 2);
});

test('empty subsystems → empty fragment set, no drafters dispatched', async () => {
  const { result, calls } = await runEngine(JSON.stringify({ subsystems: [] }));
  assert.equal(calls.agent, 0);
  assert.deepEqual(result.subsystems, []);
});

test('a drafter returning null is dropped, never faked', async () => {
  const agentImpl = async (_p, opts) => (opts.label === 'draft:auth' ? null : { key: 'api', tasks: [] });
  const { result } = await runEngine(JSON.stringify({ subsystems: SUBS }), { agentImpl });
  assert.equal(result.subsystems.length, 1);
  assert.equal(result.subsystems[0].key, 'api');     // the missing subsystem is absent, not invented
});

test('engine never returns ids or waves (those are the merge step\'s job)', async () => {
  const { result } = await runEngine(JSON.stringify({ subsystems: SUBS }));
  for (const frag of result.subsystems) {
    for (const t of frag.tasks) {
      assert.equal(t.id, undefined, 'fragment task must not carry a global id');
      assert.equal(t.wave, undefined, 'fragment task must not carry a wave');
    }
  }
});
