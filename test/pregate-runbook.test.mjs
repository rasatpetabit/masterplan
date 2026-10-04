// Execute only mocked gate recipes: never publication, installation or activation.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const document = fs.readFileSync(new URL('../docs/handoffs/2026-10-01-p07-task8-pregate-evidence.md', import.meta.url), 'utf8');
const gates = document.slice(document.indexOf('## Exact gate runbook'));
const blocks = [...gates.matchAll(/```bash\n([\s\S]*?)```/g)].map(match => match[1]);

function probe(recipe, setup, suiteReached = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-gate-refusal-'));
  try {
    // All commands that could mutate, read host metadata, or launch code are shell
    // stubs. Even env/source are stubbed; no gateway profile or credential is read.
    const stubs = `
source() { :; }
cat() { :; }
cp() { :; }
rm() { :; }
mkdir() { :; }
mktemp() { printf '%s\\n' "$ROOT/home"; }
env() { printf 'suite-called\\n' > "$ROOT/suite"; return 23; }
node() { printf 'node-called\\n' >> "$ROOT/consequential"; }
git() {
  case "$*" in
    *rev-parse*) printf '%s\\n' aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    *cat-file*) printf '%s\\n' tag ;;
    *' add '*|*' commit '*|*' push '*) printf 'git-called\\n' >> "$ROOT/consequential" ;;
  esac
}
`;
    const result = spawnSync('bash', ['--noprofile', '--norc', '-c', stubs + setup + '\n' + recipe], {
      env: { PATH: '/usr/bin:/bin', ROOT: root }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(root, 'suite')), suiteReached, 'probe must reach the intended validation boundary');
    assert.equal(fs.existsSync(path.join(root, 'consequential')), false, 'failed validation must stop consequential commands');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('pre-gate recipes each establish an independent fail-closed context', () => {
  assert.ok(blocks.length >= 8);
  for (const block of blocks) assert.match(block, /^\(\nset -euo pipefail\n/, block.split('\n')[0]);
});
test('release recipe stops before staging, commit and tag on suite failure', () => {
  const recipe = blocks.find(block => block.includes('release: v$VERSION'));
  assert.ok(recipe);
  probe(recipe, 'export RELEASE_WORKTREE="$ROOT" VERSION=synthetic W="$ROOT" WORKFLOWS_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', true);
});
test('publication identity recipe refuses mismatched and missing identities', () => {
  const recipe = blocks.find(block => block.includes('push origin'));
  assert.ok(recipe);
  assert.doesNotMatch(recipe, /install-pi/, 'installation must be a separately executable authorized gate');
  probe(recipe, 'export PREVIOUS_REF=old PREVIOUS_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb PREVIOUS_SOURCE="$ROOT" RELEASE_TAG=new RELEASE_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb RELEASE_SOURCE="$ROOT"');
  probe(recipe, '');
});
test('joint conductor readiness stays unresolved pending exact cancellation proof', () => {
  assert.match(document, /conductor cancellation source\/proof dependency is \*\*UNRESOLVED\*\*/);
  assert.match(document, /masterplan-only/);
  assert.doesNotMatch(document, /\*\*Source ready;/);
});
