/**
 * test/plan-work-item.test.mjs — a planning fan-out work item must be routable.
 *
 * Discovered 2026-08-07 during the hindsight-fix run: every subsystem planner was
 * rejected with `Task descriptor requires a non-empty repo`, so parallel planning
 * could not dispatch at all (8/8 work items failed).
 *
 * buildPlanWorkItem is written against the NATIVE SPAWN DESCRIPTOR contract, where
 * `repo` remains REQUIRED on every descriptor as the locus/identity field — the
 * write grant is NOT what it declares; read-only enforcement is `read_only` plus
 * the routing policy's writes:false role.
 *
 * These tests pin both halves: the descriptor is routable, AND it still declares
 * itself read-only with no write-scope fields.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPlanWorkItem } from '../lib/continue.mjs';
import fs from 'node:fs';
const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/dispatch-map.json', import.meta.url), 'utf8'));

const SUBSYSTEM = {
  key: 'server',
  title: 'Server',
  description: 'the API surface',
  spec_refs: ['§2'],
  files_hint: ['src/server.mjs'],
};

const OPTS = {
  roots: ['/repo', '/repo/docs/masterplan/demo/spec.md'],
  specPath: '/repo/docs/masterplan/demo/spec.md',
  repoRoot: '/repo',
  policy: fixture,
};

describe('buildPlanWorkItem', () => {
  it('carries a non-empty repo — the descriptor is rejected without it', () => {
    const item = buildPlanWorkItem(SUBSYSTEM, OPTS);
    assert.equal(typeof item.repo, 'string');
    assert.ok(item.repo.length > 0, 'repo must be non-empty (normalizeDescriptor)');
    assert.equal(item.repo, OPTS.repoRoot);
  });

  it('carries C1 plan intent and no model', () => {
    const item = buildPlanWorkItem(SUBSYSTEM, OPTS);
    assert.equal(item.phase, 'plan');
    assert.equal(item.usecase, fixture.phases.plan);
    assert.equal(item.agent, 'judge');
    assert.equal(Object.hasOwn(item, 'model'), false);
  });

  it('still declares read-only and no write-scope fields', () => {
    const item = buildPlanWorkItem(SUBSYSTEM, OPTS);
    assert.equal(item.read_only, true, 'read_only IS the capability declaration');
    assert.ok(!('files' in item), 'a read-only planner must not declare a write file set');
    assert.ok(!('worktree' in item), 'a read-only planner must not declare a worktree');
  });

  it('carries the brief under both the brief and task aliases', () => {
    const item = buildPlanWorkItem(SUBSYSTEM, OPTS);
    assert.ok(item.brief.includes('server'), 'brief must name the subsystem');
    assert.equal(item.task, item.brief, 'descriptor-required brief alias');
  });

  it('passes the normalizeDescriptor contract for native spawn descriptors', () => {
    // Mirrors the native spawn descriptor normalize step. Reproduced
    // rather than imported so this suite does not depend on a sibling repo checkout.
    const normalizeDescriptor = (d) => {
      if (d == null || typeof d !== 'object' || Array.isArray(d)) {
        throw new Error('Task descriptor must be an object');
      }
      if (typeof d.phase !== 'string' || typeof d.usecase !== 'string') {
        throw new Error('Task descriptor requires C1 intent');
      }
      if (typeof d.repo !== 'string' || d.repo.length === 0) {
        throw new Error('Task descriptor requires a non-empty repo');
      }
      return d;
    };
    assert.doesNotThrow(() => normalizeDescriptor(buildPlanWorkItem(SUBSYSTEM, OPTS)));
  });
});
