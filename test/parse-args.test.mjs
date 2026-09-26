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
