// test/refs-preservation.test.mjs — cross-cutting FIELD-PRESERVATION guard.
//
// Proves the unknown top-level state keys `refs` and `render` survive UNTOUCHED
// through every state-transform writer path in lib/bundle.mjs. This is a TEST-ONLY
// guard: no writer edit is needed. serializeState (lib/bundle.mjs) emits every
// Object.entries(obj) key, and every transform returns `{ ...state, <field> }`, so
// unknown keys round-trip for free — this file locks that invariant in.
//
// EQUIVALENCE NOTE: the serialize->parse round-trip below stands in for the
// sweep / archive / continue-reconcile writers. Those paths persist state via the
// SAME serializeState (lib/bundle.mjs) that emits ALL keys, and every state
// transform spreads `{ ...state }`. If that architectural invariant ever breaks,
// the spread-based writers under direct test here (markTask, setReviewConfig,
// setRenderConfig, setCodexConfig, setWorktreeDisposition, rebasePaths) break
// identically — so the round-trip stand-in is representative of the whole class.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeState,
  parseState,
  markTask,
  setReviewConfig,
  setRenderConfig,
  setCodexConfig,
  setWorktreeDisposition,
  rebasePaths,
} from '../lib/bundle.mjs';

// Representative opaque payloads for the two unknown keys. The render payload
// carries an extra `diagrams` facet beyond `images` so setRenderConfig's
// merge-update can be shown to preserve sibling facets.
const REFS = { back: [{ repo: '/srv/dev/repo', slug: 'origin-run' }], forward: [] };
const RENDER = { images: 'off', diagrams: 'on' };

function baseState() {
  return {
    schema_version: 9,
    slug: 'run-under-test',
    status: 'in-progress',
    phase: 'execute',
    spec_path: '/old/root/docs/masterplan/run/spec.md',
    plan_path: '/old/root/docs/masterplan/run/plan.md',
    plan_index_path: '/old/root/docs/masterplan/run/plan.index.json',
    worktree: '/old/root/.worktrees/run',
    tasks: [{ id: 1, status: 'pending', wave: 1, files: ['a.mjs'] }],
    refs: structuredClone(REFS),
    render: structuredClone(RENDER),
  };
}

test('markTask (task update) preserves refs and render untouched', () => {
  const next = markTask(baseState(), 1, 'done');
  assert.equal(next.tasks[0].status, 'done');
  assert.deepEqual(next.refs, REFS);
  assert.deepEqual(next.render, RENDER);
});

test('setReviewConfig preserves refs and render untouched', () => {
  const next = setReviewConfig(baseState(), { adversary: false });
  assert.deepEqual(next.review, { adversary: false });
  assert.deepEqual(next.refs, REFS);
  assert.deepEqual(next.render, RENDER);
});

test('set-render-config (setRenderConfig) preserves refs and merge-updates render', () => {
  const next = setRenderConfig(baseState(), { images: 'on' });
  // refs (the unrelated unknown key) is untouched.
  assert.deepEqual(next.refs, REFS);
  // render is the field this writer owns: images flips, sibling facet survives.
  assert.deepEqual(next.render, { images: 'on', diagrams: 'on' });
});

test('setCodexConfig preserves refs and render untouched', () => {
  const next = setCodexConfig(baseState(), { routing: 'off', review: false });
  assert.deepEqual(next.codex, { routing: 'off', review: false });
  assert.deepEqual(next.refs, REFS);
  assert.deepEqual(next.render, RENDER);
});

test('setWorktreeDisposition preserves refs and render untouched', () => {
  const next = setWorktreeDisposition(baseState(), 'removed_after_merge');
  assert.equal(next.worktree_disposition, 'removed_after_merge');
  assert.deepEqual(next.refs, REFS);
  assert.deepEqual(next.render, RENDER);
});

test('rebasePaths preserves refs and render untouched', () => {
  const next = rebasePaths(baseState(), '/old/root', '/new/root');
  assert.equal(next.spec_path, '/new/root/docs/masterplan/run/spec.md');
  assert.equal(next.worktree, '/new/root/.worktrees/run');
  assert.deepEqual(next.refs, REFS);
  assert.deepEqual(next.render, RENDER);
});

test('serialize->parse round-trip (stands in for sweep/archive/continue-reconcile) preserves refs and render', () => {
  // See EQUIVALENCE NOTE in the file header: serializeState emits every key, so
  // this round-trip is representative of every serialize-backed persistence path.
  const roundTripped = parseState(serializeState(baseState()));
  assert.deepEqual(roundTripped.refs, REFS);
  assert.deepEqual(roundTripped.render, RENDER);
});
