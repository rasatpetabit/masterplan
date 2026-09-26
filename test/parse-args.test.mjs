// test/parse-args.test.mjs — R9-36: the space form of a VALUE_FLAG.
//
// parseArgs accepted only `--k=v` for valued flags; `--flag` alone (and any
// following token) became boolean true. So `mp resume-brief --repo-root <dir>`
// passed a boolean where a path was expected and crashed. A fixed VALUE_FLAGS
// set now consumes the next token as the value, and only when that token exists
// and does not itself start with `--`. Every other flag keeps today's behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('R9-36: --repo-root --other leaves repo-root true and --other a flag', () => {
  const { positional, flags } = parseArgs(['--repo-root', '--other']);
  assert.equal(flags['repo-root'], true);
  assert.equal(flags.other, true);
  assert.deepEqual(positional, []);
});

test('R9-36: --repo-root with nothing after it stays true', () => {
  const { flags } = parseArgs(['--repo-root']);
  assert.equal(flags['repo-root'], true);
});

test('R9-36: --repo-root=<dir> keeps working unchanged', () => {
  const { flags } = parseArgs(['--repo-root=/tmp/x']);
  assert.equal(flags['repo-root'], '/tmp/x');
});
