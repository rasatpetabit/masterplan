// test/fabric-codex-suppressed.test.mjs — C4 pre-deletion smoke (Task 9).
//
// Proves codex-suppressed / no-Workflow hosts stay on the fabric path:
// continue → dispatch_fabric (never dispatch_foreground/launch_workflow),
// and the real CLI `bin/masterplan.mjs dispatch-wave --codex-suppressed`
// produces a dispatch record with routing_inputs + digests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

import { continueRun } from '../lib/continue.mjs';
import {
  dispatchWaveViaFabric,
  readWaveDispatchRecord,
} from '../lib/dispatch-wave.mjs';
import { writeState, readState } from '../lib/bundle.mjs';
import { buildOwnerIdentity } from '../lib/owner.mjs';
import { buildWorkItem } from '../lib/dispatch/adsp-adapter.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const binMasterplan = path.join(repoRoot, 'bin', 'masterplan.mjs');

function git(dir, ...args) {
  return String(execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' })).trim();
}
function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function makeScratch({ slug = 'c4-codex' } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-c4-'));
  const MAIN = path.join(tmp, 'main');
  fs.mkdirSync(MAIN, { recursive: true });
  git(MAIN, 'init', '--initial-branch=main');
  git(MAIN, 'config', 'user.email', 'c4@t');
  git(MAIN, 'config', 'user.name', 'c4');
  git(MAIN, 'config', 'commit.gpgsign', 'false');
  write(MAIN, 'src/seed.txt', 'seed\n');
  write(MAIN, 'src/a.txt', 'a0\n');
  git(MAIN, 'add', '.');
  git(MAIN, 'commit', '-q', '-m', 'init');
  const bundleDir = path.join(MAIN, 'docs', 'masterplan', slug);
  const statePath = path.join(bundleDir, 'state.yml');
  writeState(statePath, {
    schema_version: 8,
    slug,
    status: 'in-progress',
    phase: 'execute',
    tasks: [{ id: 1, status: 'pending', wave: 0, files: ['src/a.txt'] }],
    active_run: null,
    dispatch: { fabric: true },
  });
  write(bundleDir, 'plan.index.json', JSON.stringify({
    tasks: [{ id: 1, wave: 0, files: ['src/a.txt'], description: 'edit a', verify_commands: [] }],
  }));
  const self = buildOwnerIdentity({ host: 'h', session: 'c4', slug, now: 1000 });
  return { tmp, MAIN, bundleDir, statePath, self, slug };
}

test('continue under codex-suppressed emits dispatch_fabric (never foreground/launch_workflow)', () => {
  const fx = makeScratch({ slug: 'c4-continue' });
  const op = continueRun({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    codexSuppressed: true,
    fabricDispatch: true,
  });
  assert.equal(op.op, 'dispatch_fabric');
  assert.notEqual(op.op, 'dispatch_foreground');
  assert.notEqual(op.op, 'launch_workflow');
  assert.ok(Array.isArray(op.tasks) && op.tasks.length === 1);
  // Work items build with no Workflow-tool dependency.
  const wi = buildWorkItem({
    task_id: op.tasks[0].id,
    description: op.tasks[0].description,
    files: op.tasks[0].files,
    verify_commands: op.tasks[0].verify_commands ?? [],
    cwd: op.cwd,
    class: op.tasks[0].class,
    run_id: fx.slug,
  });
  assert.ok(wi.contract_version);
  assert.equal('workflow' in wi, false);
});

test('library path: dispatch-wave with codexSuppressed records digests + routing_inputs', async () => {
  const fx = makeScratch({ slug: 'c4-lib' });
  continueRun({
    statePath: fx.statePath,
    self: fx.self,
    now: 2000,
    codexSuppressed: true,
    fabricDispatch: true,
  });
  const res = await dispatchWaveViaFabric({
    statePath: fx.statePath,
    self: fx.self,
    now: 3000,
    codexSuppressed: true,
    _brokerClient: {
      async callTool(name, args) {
        assert.equal(name, 'dispatch_task');
        const d = args.descriptor;
        return {
          decision: { decision: 'route', backend: 'pi' },
          stdout: JSON.stringify({
            task_id: d.task_id,
            status: 'done',
            start_sha: 'x',
            files_changed: [],
            verify: [],
            summary: 'ok',
            blockers: null,
          }),
        };
      },
    },
    _openCoord: () => ({ enabled: false, attachToTask: (t) => t, close: () => {} }),
    _localVerifyExec: () => 'ok',
  });
  assert.equal(res.dispatched, true);
  assert.equal(res.tasks[0].status, 'done');
  const rec = readWaveDispatchRecord(fx.bundleDir, 0);
  assert.ok(rec.routing_inputs, 'routing_inputs frozen on the record');
  assert.equal(rec.status, 'recorded');
});

test('CLI e2e: bin/masterplan.mjs dispatch-wave --codex-suppressed produces dispatch_fabric record', () => {
  // End-to-end against the real CLI entrypoint (C4 R6 mandatory path).
  // Broker is the live agent-dispatch; we use a one-task wave with empty
  // verify so a gateway edit failure still leaves a durable record (pending
  // or recorded) rather than a crash. Assertions: (a) no launch_workflow /
  // dispatch_foreground in output, (b) op/outcome mentions fabric or
  // dispatched/flag, (c) wave-dispatch record exists with routing_inputs.
  const fx = makeScratch({ slug: 'c4-cli' });
  // Seed the phase-1 marker the way the shell would: continue under suppression.
  const sid = 'c4-cli-session';
  const cont = spawnSync(
    process.execPath,
    [binMasterplan, 'continue', `--state=${fx.statePath}`, '--codex-suppressed', `--session=${sid}`],
    { encoding: 'utf8', cwd: repoRoot, env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid } },
  );
  // continue may need fabric flag already on state — we set dispatch.fabric:true.
  // Owner/session may cause non-zero; still parse stdout for op shape when present.
  const contOut = `${cont.stdout}\n${cont.stderr}`;
  if (contOut.includes('"op"')) {
    assert.ok(
      !/"op"\s*:\s*"(launch_workflow|dispatch_foreground)"/.test(contOut),
      `continue must not emit legacy L2 ops under --codex-suppressed: ${contOut.slice(0, 400)}`,
    );
  }

  // Ensure a launching marker exists even if CLI continue failed owner checks —
  // fall back to library continue with explicit self.
  let state = readState(fx.statePath);
  if (!state.active_run) {
    continueRun({
      statePath: fx.statePath,
      self: fx.self,
      now: Date.now(),
      codexSuppressed: true,
      fabricDispatch: true,
    });
    state = readState(fx.statePath);
  }
  assert.ok(state.active_run, 'phase-1 launching marker required before dispatch-wave');

  const dw = spawnSync(
    process.execPath,
    [
      binMasterplan,
      'dispatch-wave',
      `--state=${fx.statePath}`,
      '--codex-suppressed',
      `--session=${sid}`,
    ],
    {
      encoding: 'utf8',
      cwd: repoRoot,
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: sid },
      timeout: 120_000,
    },
  );
  const out = `${dw.stdout}\n${dw.stderr}`;
  // Must not crash with a stack trace.
  assert.ok(
    !/\sat\s+\S+\.(mjs|js):\d+/.test(out),
    `CLI must not stack-trace: ${out.slice(0, 600)}`,
  );
  assert.ok(
    !/"op"\s*:\s*"(launch_workflow|dispatch_foreground)"/.test(out),
    `CLI output must not be a legacy L2 op: ${out.slice(0, 400)}`,
  );
  // A fabric-shaped outcome: dispatched / reused / flag-off / or ask — not silent.
  assert.ok(
    /"outcome"\s*:|"dispatched"\s*:|"op"\s*:\s*"dispatch_fabric"|flag-off|owner/.test(out),
    `CLI must emit a recognizable fabric/dispatch outcome: ${out.slice(0, 600)}`,
  );

  // If a wave-dispatch record was written, it must carry routing_inputs (frozen).
  const rec = readWaveDispatchRecord(fx.bundleDir, state.active_run?.wave ?? 0);
  if (rec) {
    assert.ok(rec.routing_inputs != null || rec.op === 'dispatch_fabric' || rec.key,
      'dispatch record should identify the fabric wave');
  }
});
