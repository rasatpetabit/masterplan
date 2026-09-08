// test/resume-brief.test.mjs — active-run brief resolution and rendering.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveResumeBrief,
  renderResumeBrief,
  projectObligations,
} from '../lib/resume-brief.mjs';

// Every fixture here builds a tree under os.tmpdir(); without this they accumulate across
// runs and fill a shared /tmp. Registered on creation, removed once when the file finishes.
const FIXTURE_TMPDIRS = [];
function mkdtempTracked(prefix) {
  const dir = fs.mkdtempSync(prefix);
  FIXTURE_TMPDIRS.push(dir);
  return dir;
}
after(() => {
  for (const d of FIXTURE_TMPDIRS) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* already gone */ }
  }
});

function makeRepo() {
  return mkdtempTracked(path.join(os.tmpdir(), 'resume-brief-'));
}

function yaml(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${item}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  return lines.join('\n') + '\n';
}

function writeBundle(
  repoRoot,
  slug,
  {
    status = 'in-progress',
    phase = 'deploy',
    gates = [],
    predecessor,
    events = [],
    goalsOutcome,
  } = {}
) {
  const dir = path.join(repoRoot, 'docs', 'masterplan', slug);
  fs.mkdirSync(dir, { recursive: true });
  const state = { schema_version: 9, slug, status, phase, tasks: [] };
  if (gates.length) state.pending_gate = JSON.stringify({ id: gates[0], opened_at: '2026-01-01T00:00:00Z' });
  if (predecessor) state.predecessor = predecessor;
  fs.writeFileSync(path.join(dir, 'state.yml'), yaml(state));
  const evs = [
    { type: 'bundle_created', slug, ts: '2026-01-01T00:00:00Z' },
    ...events,
  ];
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    evs.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  if (goalsOutcome != null) {
    fs.writeFileSync(
      path.join(dir, 'goals.md'),
      `topic: |\n  t\n\noutcome: stale\n\n## Intent\nwhy: w\noutcome: ${goalsOutcome}\nanti_goals:\n- x\ndone_means: d\n\n## G1: a\n\n## G2: b\n\n## G3: c\n`
    );
  }
}

test('zero active bundles produce no output', () => {
  const repo = makeRepo();
  const brief = resolveResumeBrief({ repoRoot: repo });
  assert.equal(renderResumeBrief(brief), '');
});

test('archived bundles are not active', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', { status: 'archived', phase: 'archive' });
  const brief = resolveResumeBrief({ repoRoot: repo });
  assert.equal(brief.active.length, 0);
  assert.equal(renderResumeBrief(brief), '');
});

test('one active bundle renders five durable lines', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', {
    phase: 'deploy',
    gates: ['deploy_base'],
    goalsOutcome: 'all goals met',
  });
  const brief = resolveResumeBrief({ repoRoot: repo });
  const lines = renderResumeBrief(brief).split('\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'slug: run-a');
  assert.equal(lines[1], 'phase: deploy');
  assert.equal(lines[2], 'gate: deploy_base');
  assert.equal(lines[3], 'outcome: all goals met');
  assert.match(lines[4], /^next: node bin\/masterplan\.mjs continue --state=.*run-a[\/\\]state\.yml$/);
});

test('v1 goals.md without Intent block renders outcome none', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', { phase: 'deploy' });
  const dir = path.join(repo, 'docs', 'masterplan', 'run-a');
  fs.writeFileSync(path.join(dir, 'goals.md'), '# Goals\noutcome: some\n');
  const brief = resolveResumeBrief({ repoRoot: repo });
  const lines = renderResumeBrief(brief).split('\n');
  assert.equal(lines[3], 'outcome: none');
});

test('several active bundles render one summary line each', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', { phase: 'deploy' });
  writeBundle(repo, 'run-b', { phase: 'goals' });
  const brief = resolveResumeBrief({ repoRoot: repo });
  const lines = renderResumeBrief(brief).split('\n').sort();
  assert.equal(lines.length, 2);
  assert.equal(lines[0], 'run-a: deploy (in-progress)');
  assert.equal(lines[1], 'run-b: goals (in-progress)');
});

test('open obligation renders before active lines with the seed command', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', {
    phase: 'deploy',
    events: [
      {
        type: 'required_successor',
        slug: 'run-b',
        reason: 'handoff',
        ts: '2026-01-01T00:00:01Z',
      },
    ],
  });
  const brief = resolveResumeBrief({ repoRoot: repo });
  const lines = renderResumeBrief(brief).split('\n');
  assert.match(lines[0], /^obligation: run-b \(required by run-a\)$/);
  assert.equal(
    lines[1],
    '  node bin/masterplan.mjs seed --slug=run-b --predecessor=run-a'
  );
  assert.equal(lines[2], 'slug: run-a');
});

test('obligation discharged when successor names predecessor in state', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', {
    phase: 'deploy',
    events: [
      {
        type: 'required_successor',
        slug: 'run-b',
        reason: 'handoff',
        ts: '2026-01-01T00:00:01Z',
      },
    ],
  });
  writeBundle(repo, 'run-b', { phase: 'deploy', predecessor: 'run-a' });
  assert.equal(projectObligations({ repoRoot: repo }).length, 0);
  const text = renderResumeBrief(resolveResumeBrief({ repoRoot: repo }));
  assert.doesNotMatch(text, /obligation: run-b/);
});

test('obligation discharged when successor names predecessor in bundle_created event', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', {
    phase: 'deploy',
    events: [
      {
        type: 'required_successor',
        slug: 'run-b',
        reason: 'handoff',
        ts: '2026-01-01T00:00:01Z',
      },
    ],
  });
  writeBundle(repo, 'run-b', {
    phase: 'deploy',
    events: [
      {
        type: 'bundle_created',
        slug: 'run-b',
        predecessor: 'run-a',
        ts: '2026-01-01T00:00:02Z',
      },
    ],
  });
  assert.equal(projectObligations({ repoRoot: repo }).length, 0);
});

test('same-slug bundle without predecessor link does not discharge', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', {
    phase: 'deploy',
    events: [
      {
        type: 'required_successor',
        slug: 'run-b',
        reason: 'handoff',
        ts: '2026-01-01T00:00:01Z',
      },
    ],
  });
  writeBundle(repo, 'run-b', { phase: 'deploy' }); // no predecessor link
  const obligations = projectObligations({ repoRoot: repo });
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].slug, 'run-b');
  assert.equal(obligations[0].source, 'run-a');
});

test('unreadable state.yml is not active and appears in warnings', () => {
  const repo = makeRepo();
  const dir = path.join(repo, 'docs', 'masterplan', 'run-a');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.yml'), 'not: [valid\n');
  const brief = resolveResumeBrief({ repoRoot: repo });
  assert.equal(brief.active.length, 0);
  assert.equal(renderResumeBrief(brief), '');
  assert.ok(brief.warnings.some((w) => w.path && w.path.includes('run-a')));
});

test('bundle_created with different slug does not discharge obligation', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', {
    phase: 'deploy',
    events: [
      {
        type: 'required_successor',
        slug: 'run-b',
        reason: 'handoff',
        ts: '2026-01-01T00:00:01Z',
      },
    ],
  });
  const dir = path.join(repo, 'docs', 'masterplan', 'run-b');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'state.yml'),
    yaml({ schema_version: 9, slug: 'run-b', status: 'in-progress', phase: 'deploy', tasks: [] })
  );
  const evs = [
    { type: 'bundle_created', slug: 'run-b', ts: '2026-01-01T00:00:02Z' },
    { type: 'bundle_created', slug: 'run-c', predecessor: 'run-a', ts: '2026-01-01T00:00:03Z' },
  ];
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    evs.map((e) => JSON.stringify(e)).join('\n') + '\n'
  );
  const obligations = projectObligations({ repoRoot: repo });
  assert.equal(obligations.length, 1);
  assert.equal(obligations[0].slug, 'run-b');
});

test('repo path with space quotes the state path', () => {
  const base = makeRepo();
  const repo = path.join(base, 'my repo');
  fs.mkdirSync(repo, { recursive: true });
  writeBundle(repo, 'run-a', { phase: 'deploy' });
  const brief = resolveResumeBrief({ repoRoot: repo });
  const lines = renderResumeBrief(brief).split('\n');
  assert.equal(lines.length, 5);
  assert.match(lines[4], /^next: node bin\/masterplan\.mjs continue --state='.*run-a[\/\\]state\.yml'$/);
});

test('a slugless bundle_created event does not discharge an obligation', () => {
  const repo = makeRepo();
  writeBundle(repo, 'run-a', { phase: 'deploy', events: [{ type: 'required_successor', slug: 'run-b', reason: 'handoff', ts: '2026-01-01T00:00:01Z' }] });
  const dir = path.join(repo, 'docs', 'masterplan', 'run-b');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'state.yml'), yaml({ schema_version: 9, slug: 'run-b', status: 'in-progress', phase: 'deploy', tasks: [] }));
  fs.writeFileSync(path.join(dir, 'events.jsonl'), JSON.stringify({ type: 'bundle_created', predecessor: 'run-a' }) + '\n');
  assert.equal(projectObligations({ repoRoot: repo }).length, 1);
});
