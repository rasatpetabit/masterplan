// test/parse-args.test.mjs — R9-36: the space form of a VALUE_FLAG.
//
// parseArgs accepted only `--k=v` for valued flags; `--flag` alone (and any
// following token) became boolean true. So `mp resume-brief --repo-root <dir>`
// passed a boolean where a path was expected and crashed. A fixed VALUE_FLAGS
// set now consumes the next token as the value, and only when that token exists
// and does not itself start with `--`. Every other flag keeps today's behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bin/masterplan.mjs';

const BIN = fileURLToPath(new URL('../bin/masterplan.mjs', import.meta.url));

test('R9-36: resume-brief --repo-root <dir> resolves the same as --repo-root=<dir>', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-r9-36-'));
  try {
    const eq = execFileSync('node', [BIN, 'resume-brief', `--repo-root=${dir}`, '--porcelain'], {
      encoding: 'utf8',
    });
    const space = execFileSync('node', [BIN, 'resume-brief', '--repo-root', dir, '--porcelain'], {
      encoding: 'utf8',
    });
    assert.deepEqual(JSON.parse(space), JSON.parse(eq));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('R9-36: a boolean flag followed by a positional stays boolean + positional', () => {
  const { positional, flags } = parseArgs(['--porcelain', 'some-positional']);
  assert.equal(flags.porcelain, true);
  assert.deepEqual(positional, ['some-positional']);
});

// R9-47: a VALUE_FLAG with no value used to stay boolean true. need() only
// rejects undefined, so resume-brief then threw a path type error and
// context-status could exit 0 reporting "unsupported". A missing or empty
// value is a usage error at the one place every verb is parsed.
function runCli(args) {
  const r = spawnSync('node', [BIN, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

test('R9-47: resume-brief --repo-root with no value is a usage error', () => {
  const r = runCli(['resume-brief', '--repo-root']);
  assert.equal(r.status, 2, `expected usage exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /--repo-root needs a value: --repo-root <dir> or --repo-root=<dir>/);
});

test('R9-47: context-status --repo-root followed by a flag is a usage error', () => {
  const r = runCli(['context-status', '--repo-root', '--porcelain']);
  assert.equal(r.status, 2, `expected usage exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /--repo-root needs a value: --repo-root <dir> or --repo-root=<dir>/);
});

test('R9-36: --repo-root=<dir> keeps working unchanged', () => {
  const { flags } = parseArgs(['--repo-root=/tmp/x']);
  assert.equal(flags['repo-root'], '/tmp/x');
});

// Issue #28: core path/selector value flags accept space-separated `--flag <value>`
// identically to `--flag=<value>` and fail cleanly via R9-47 when left valueless.
test('Issue #28: parseArgs parses space-separated VALUE_FLAGS identically to = form', () => {
  const space = parseArgs(['--state', '/tmp/a/state.yml', '--phase', 'plan']);
  const eq = parseArgs(['--state=/tmp/a/state.yml', '--phase=plan']);
  assert.deepEqual(space, eq);
  assert.equal(space.flags.state, '/tmp/a/state.yml');
  assert.equal(space.flags.phase, 'plan');

  const allSpace = parseArgs([
    '--repo-root', '/tmp/repo',
    '--state', '/tmp/repo/state.yml',
    '--phase', 'execute',
    '--plan-index', '/tmp/repo/plan.index.json',
    '--fragments', '/tmp/repo/frags.json',
    '--out', '/tmp/repo/out.json',
    '--slug', 'my-slug',
    '--wave', '2',
  ]);
  const allEq = parseArgs([
    '--repo-root=/tmp/repo',
    '--state=/tmp/repo/state.yml',
    '--phase=execute',
    '--plan-index=/tmp/repo/plan.index.json',
    '--fragments=/tmp/repo/frags.json',
    '--out=/tmp/repo/out.json',
    '--slug=my-slug',
    '--wave=2',
  ]);
  assert.deepEqual(allSpace, allEq);
});

test('Issue #28: mp set-phase --state <path> --phase plan matches --state=<path> --phase=plan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-issue28-'));
  try {
    const statePath = path.join(dir, 'state.yml');
    fs.writeFileSync(statePath, 'schema_version: 6.0\nslug: demo\nphase: brainstorm\nstatus: in-progress\ntasks: []\n');
    const eq = runCli(['set-phase', `--state=${statePath}`, '--phase=plan', '--force']);
    assert.equal(eq.status, 0, eq.stderr);
    fs.writeFileSync(statePath, 'schema_version: 6.0\nslug: demo\nphase: brainstorm\nstatus: in-progress\ntasks: []\n');
    const space = runCli(['set-phase', '--state', statePath, '--phase', 'plan', '--force']);
    assert.equal(space.status, 0, space.stderr);
    assert.deepEqual(JSON.parse(space.stdout), JSON.parse(eq.stdout));
    assert.equal(JSON.parse(space.stdout).phase, 'plan');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Issue #28: R9-47 rejects bare/valueless --state and --phase with usage exit 2 (not cannot read state file: true)', () => {
  const r1 = runCli(['status', '--state']);
  assert.equal(r1.status, 2, `expected exit 2, got ${r1.status}: ${r1.stderr}`);
  assert.match(r1.stderr, /--state needs a value/);
  assert.doesNotMatch(r1.stderr, /cannot read state file: true/);

  const r2 = runCli(['set-phase', '--state', '--phase=plan']);
  assert.equal(r2.status, 2, `expected exit 2, got ${r2.status}: ${r2.stderr}`);
  assert.match(r2.stderr, /--state needs a value/);
  assert.doesNotMatch(r2.stderr, /cannot read state file: true/);

  const r3 = runCli(['set-phase', '--state=/tmp/x/state.yml', '--phase=']);
  assert.equal(r3.status, 2, `expected exit 2, got ${r3.status}: ${r3.stderr}`);
  assert.match(r3.stderr, /--phase needs a value/);
});
