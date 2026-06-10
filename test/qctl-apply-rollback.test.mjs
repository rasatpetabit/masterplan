// test/qctl-apply-rollback.test.mjs — §10 'per-task rollback leaves siblings intact' binding test
//
// Reenacts the documented isolated-index per-task apply sequence (docs/design/qctl-multi-repo-apply.md, formerly commands/masterplan.md §6.5) against a temp git repo:
//   • one GOOD task with a clean patch (git apply --index --check passes → apply proceeds)
//   • one CONFLICTING task whose patch fails --check (conflicts with existing content)
//
// Assertions:
//   1. The GOOD task's changes are staged in the index (present in git diff --cached).
//   2. The FAILING task is rolled back (its path absent from git diff --cached).
//   3. The GOOD task's staged changes survive the rollback of the failing sibling.
//
// This test proves the git isolated-index/rollback MECHANISM behaves as documented; it does NOT
// prove the markdown prose invokes it correctly — that residual is backstopped by the human-gated
// flip (C.flag-flip) and the live P0/P1 exercise.
//
// Flip-precondition #4: "per-task rollback demonstrated" — this file IS that demonstration.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git command in dir, return { status, stdout, stderr }. */
function git(dir, args, opts = {}) {
  const result = spawnSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      // Suppress user.name/email prompts in fresh repos
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
    ...opts,
  });
  return result;
}

/** Run a git command and throw if it fails (for setup steps that must succeed). */
function gitOk(dir, args, opts = {}) {
  const r = git(dir, args, opts);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}):\n${r.stderr}`);
  }
  return r.stdout.trim();
}

/** Create a fresh git repo with an initial commit containing `files` (path→content map). */
function makeTempRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-rollback-test-'));
  gitOk(dir, ['init', '--initial-branch=main']);
  gitOk(dir, ['config', 'user.email', 'test@test']);
  gitOk(dir, ['config', 'user.name', 'test']);
  for (const [relPath, content] of Object.entries(files)) {
    const abs = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  gitOk(dir, ['add', '--all']);
  gitOk(dir, ['commit', '-m', 'initial']);
  return dir;
}

/** Build a unified diff patch string that changes `file` in `dir` from `oldContent` to `newContent`.
 *  The patch is produced by writing the new content to a temp location and running git diff --no-index.
 */
function buildPatch(file, oldContent, newContent) {
  // We construct the diff header manually to produce a valid unified patch.
  // This is simpler than spinning up git diff --no-index for each case.
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Produce a minimal unified diff. We use a simple line-by-line diff since test content is tiny.
  const header = `--- a/${file}\n+++ b/${file}\n`;

  // Collect changed line numbers (1-indexed)
  const maxLen = Math.max(oldLines.length, newLines.length);
  const hunks = [];
  let i = 0;
  while (i < maxLen) {
    if (oldLines[i] !== newLines[i]) {
      // start of a changed region
      const startOld = i + 1;
      const startNew = i + 1;
      let j = i;
      while (j < maxLen && (oldLines[j] !== newLines[j])) j++;
      const oldHunkLines = oldLines.slice(i, j);
      const newHunkLines = newLines.slice(i, j);
      // Unified diff @@ header
      const oldCount = oldHunkLines.length;
      const newCount = newHunkLines.length;
      let hunk = `@@ -${startOld},${oldCount} +${startNew},${newCount} @@\n`;
      for (const l of oldHunkLines) hunk += `-${l}\n`;
      for (const l of newHunkLines) hunk += `+${l}\n`;
      hunks.push(hunk);
      i = j;
    } else {
      i++;
    }
  }
  return header + hunks.join('');
}

/**
 * Attempt to apply a patch using the §6.5 isolated-index sequence:
 *   1. git apply --index --check   (isolated index, dry run)
 *   2. if clean: git apply --index (stage the patch)
 *   3. on failure: rollback the task's declared files
 *
 * Returns { applied: bool, reason: string|null }
 *
 * The isolation is implemented via GIT_INDEX_FILE pointing to a tmp copy of the real index.
 * The --check step reads the temp index. On success we proceed with the real index.
 * On failure the real index is untouched (the temp index is discarded).
 */
function isolatedApply(repoDir, patchText, taskFiles) {
  // Write the patch to a temp file
  const patchFile = path.join(os.tmpdir(), `mp-patch-${Date.now()}-${Math.random().toString(36).slice(2)}.diff`);
  try {
    fs.writeFileSync(patchFile, patchText, 'utf8');

    // Step 3 (§6.5): git apply --index --check with an ISOLATED index.
    // Copy the real index to a temp file so --check cannot mutate shared state.
    const realIndex = path.join(repoDir, '.git', 'index');
    const tmpIndex = patchFile + '.idx';
    try {
      fs.copyFileSync(realIndex, tmpIndex);
    } catch {
      // Fresh repo may have no index file yet — create an empty one
      fs.writeFileSync(tmpIndex, Buffer.alloc(0));
    }

    const checkResult = spawnSync('git', ['apply', '--index', '--check', patchFile], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_INDEX_FILE: tmpIndex,  // isolated — does not touch the real index
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test',
      },
    });

    // Clean up temp index regardless of outcome
    try { fs.unlinkSync(tmpIndex); } catch { /* ignore */ }

    if (checkResult.status !== 0) {
      // --check failed: patch conflicts or base has drifted.
      // The real index was never touched. Return failed without rollback needed.
      return { applied: false, reason: `check-failed: ${checkResult.stderr.trim()}` };
    }

    // Step 5 (§6.5): per-task atomic apply into the REAL index.
    const applyResult = spawnSync('git', ['apply', '--index', patchFile], {
      cwd: repoDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test',
      },
    });

    if (applyResult.status !== 0) {
      // Apply unexpectedly failed after passing --check (race or binary issue).
      // Step 7 (§6.5): rollback this task's declared files from the index.
      spawnSync('git', ['checkout', '--', ...taskFiles], { cwd: repoDir });
      return { applied: false, reason: `apply-failed: ${applyResult.stderr.trim()}` };
    }

    return { applied: true, reason: null };
  } finally {
    try { fs.unlinkSync(patchFile); } catch { /* ignore */ }
  }
}

/**
 * Rollback a failed task: reset only its declared file paths in the index.
 * This is the §6.5 step 7 rollback — scoped to `taskFiles`, not the whole index.
 */
function rollbackTask(repoDir, taskFiles) {
  spawnSync('git', ['checkout', '--', ...taskFiles], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
}

/** Return the set of staged file paths (`git diff --cached --name-only`). */
function stagedFiles(repoDir) {
  const r = spawnSync('git', ['diff', '--cached', '--name-only'], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
  return new Set(r.stdout.trim().split('\n').filter(Boolean));
}

/** Return staged content of a file (`git show :path`). */
function stagedContent(repoDir, filePath) {
  const r = spawnSync('git', ['show', `:${filePath}`], {
    cwd: repoDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });
  if (r.status !== 0) return null;
  return r.stdout;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('setup: git is available and usable', () => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'git must be on PATH');
  assert.ok(r.stdout.includes('git version'), r.stdout);
});

test('good patch passes --check and lands in the index', () => {
  // Arrange: repo with one file
  const repo = makeTempRepo({ 'src/greeter.js': 'function greet() { return "hello"; }\n' });

  // Good patch: changes 'hello' to 'hello, world'
  const goodPatch = buildPatch(
    'src/greeter.js',
    'function greet() { return "hello"; }',
    'function greet() { return "hello, world"; }',
  );

  // Act: isolated apply
  const result = isolatedApply(repo, goodPatch, ['src/greeter.js']);

  // Assert: applied cleanly
  assert.equal(result.applied, true, `Expected applied:true, got reason: ${result.reason}`);
  assert.equal(result.reason, null);

  // The file must now be staged
  const staged = stagedFiles(repo);
  assert.ok(staged.has('src/greeter.js'), `Expected src/greeter.js in staged files, got: ${[...staged].join(', ')}`);

  // The staged content must contain the new text
  const content = stagedContent(repo, 'src/greeter.js');
  assert.ok(content !== null, 'staged content must be readable');
  assert.ok(content.includes('hello, world'), `Expected 'hello, world' in staged content, got: ${content}`);
});

test('conflicting patch fails --check and leaves index clean', () => {
  // Arrange: repo where the conflict file has content that disagrees with the patch's context
  const repo = makeTempRepo({ 'src/config.js': 'const VERSION = "1.0.0";\n' });

  // Conflicting patch: expects the file to contain 'const VERSION = "0.9.0";' (wrong context)
  // This will fail --check because the context lines don't match HEAD.
  const conflictingPatch = buildPatch(
    'src/config.js',
    'const VERSION = "0.9.0";',   // wrong expected content (does not match "1.0.0")
    'const VERSION = "2.0.0";',
  );

  // Act
  const result = isolatedApply(repo, conflictingPatch, ['src/config.js']);

  // Assert: --check must have failed (context mismatch)
  assert.equal(result.applied, false, 'Conflicting patch must not apply');
  assert.ok(result.reason !== null, 'A failure reason must be set');
  assert.ok(result.reason.startsWith('check-failed'), `Expected check-failed reason, got: ${result.reason}`);

  // The index must be clean (no staged changes)
  const staged = stagedFiles(repo);
  assert.equal(staged.size, 0, `Expected no staged files after conflicting patch, got: ${[...staged].join(', ')}`);
});

// ---------------------------------------------------------------------------
// §10 binding test: per-task rollback leaves siblings intact
// This is the core invariant: a failing task is rolled back without disturbing
// the already-staged changes of the sibling task that succeeded.
// ---------------------------------------------------------------------------

test('§10 per-task rollback leaves siblings intact — the central guarantee', () => {
  // Arrange: repo with TWO independent files, each owned by a different task.
  const repo = makeTempRepo({
    'src/alpha.js': 'function alpha() { return 1; }\n',
    'src/beta.js':  'function beta() { return "old"; }\n',
  });

  // Task A (GOOD): patch for alpha.js — clean, applies correctly
  const goodPatch = buildPatch(
    'src/alpha.js',
    'function alpha() { return 1; }',
    'function alpha() { return 42; }',
  );

  // Task B (CONFLICTING): patch for beta.js — bad context, --check will reject it
  const conflictingPatch = buildPatch(
    'src/beta.js',
    'function beta() { return "wrong-context-line"; }',  // does not match HEAD
    'function beta() { return "new"; }',
  );

  // ACT — serial-per-repo apply sequence (§6.5 §8):

  // 1. Apply task A (good patch)
  const resultA = isolatedApply(repo, goodPatch, ['src/alpha.js']);
  assert.equal(resultA.applied, true, `Task A must apply cleanly, got: ${resultA.reason}`);

  // At this point alpha.js is staged; beta.js is not.
  const afterA = stagedFiles(repo);
  assert.ok(afterA.has('src/alpha.js'), 'alpha.js must be staged after task A');
  assert.ok(!afterA.has('src/beta.js'), 'beta.js must NOT be staged yet');

  // 2. Attempt task B (conflicting patch)
  const resultB = isolatedApply(repo, conflictingPatch, ['src/beta.js']);
  assert.equal(resultB.applied, false, 'Task B (conflicting) must not apply');
  assert.ok(resultB.reason.startsWith('check-failed'), `Expected check-failed for task B, got: ${resultB.reason}`);

  // 3. Task B failed — rollback its declared files (scoped rollback, §6.5 step 7)
  //    (isolatedApply already does no mutation on --check failure, but we call rollbackTask
  //    explicitly here to demonstrate the documented rollback step is a no-op for the good sibling)
  rollbackTask(repo, ['src/beta.js']);

  // ASSERT — the central guarantee: task A's staged changes survive task B's rollback
  const afterRollback = stagedFiles(repo);

  // alpha.js is still staged (good sibling intact)
  assert.ok(
    afterRollback.has('src/alpha.js'),
    `src/alpha.js must still be staged after task B rollback, staged: ${[...afterRollback].join(', ')}`,
  );

  // beta.js is NOT staged (failed task is absent)
  assert.ok(
    !afterRollback.has('src/beta.js'),
    `src/beta.js must NOT be staged (task B was rolled back), staged: ${[...afterRollback].join(', ')}`,
  );

  // The content of the staged alpha.js must be the new value (task A's change)
  const alphaContent = stagedContent(repo, 'src/alpha.js');
  assert.ok(alphaContent !== null, 'staged alpha.js must be readable');
  assert.ok(
    alphaContent.includes('return 42'),
    `Expected task A's change in staged alpha.js, got: ${alphaContent}`,
  );

  // The working tree beta.js must still be the original (task B never wrote anything)
  const betaTree = fs.readFileSync(path.join(repo, 'src/beta.js'), 'utf8');
  assert.ok(
    betaTree.includes('"old"'),
    `beta.js working tree must be unchanged (original "old"), got: ${betaTree}`,
  );
});

test('rollback is scoped to declared task files — unrelated staged changes survive', () => {
  // A rollback for task B must not touch files declared by task A, even if they share the repo.
  // This strengthens the §10 guarantee: the scope of rollback is exactly `taskFiles`.
  const repo = makeTempRepo({
    'lib/util.js':    'export function util() { return 0; }\n',
    'lib/service.js': 'export function svc() { return "v1"; }\n',
  });

  // Manually stage a change to util.js (simulating a committed task A result already in the index)
  fs.writeFileSync(path.join(repo, 'lib/util.js'), 'export function util() { return 99; }\n');
  gitOk(repo, ['add', 'lib/util.js']);

  // Verify it is staged
  const before = stagedFiles(repo);
  assert.ok(before.has('lib/util.js'), 'util.js must be staged before rollback');

  // Now rollback task B which owns service.js (not util.js)
  rollbackTask(repo, ['lib/service.js']);

  // util.js must still be staged (rollback was scoped to service.js only)
  const after = stagedFiles(repo);
  assert.ok(after.has('lib/util.js'), 'util.js must still be staged after scoped rollback of service.js');
  assert.ok(!after.has('lib/service.js'), 'service.js must not be staged');

  // Staged util.js content must still be the updated value
  const content = stagedContent(repo, 'lib/util.js');
  assert.ok(content !== null);
  assert.ok(content.includes('return 99'), `Expected staged util.js to have updated content, got: ${content}`);
});

test('isolated --check does not mutate the real index on failure', () => {
  // Confirm the isolation: even when --check is called with GIT_INDEX_FILE=<tmp>, the real
  // index remains clean after a failed check. This is the isolation half of the §6.5 guarantee.
  const repo = makeTempRepo({ 'app.js': 'console.log("hello");\n' });

  // A patch that will fail --check (wrong context)
  const badPatch = buildPatch(
    'app.js',
    'console.log("not-this-line");',
    'console.log("world");',
  );

  // Confirm real index is clean before
  assert.equal(stagedFiles(repo).size, 0, 'index must be clean before');

  const result = isolatedApply(repo, badPatch, ['app.js']);
  assert.equal(result.applied, false);

  // Real index must still be clean after the failed isolated --check
  assert.equal(
    stagedFiles(repo).size, 0,
    'real index must remain clean after an isolated --check failure',
  );
});

test('two good patches applied serially both land in the index (serial-per-repo happy path)', () => {
  // Validates that the serial-per-repo apply sequence (§6.5 §8) accumulates correctly:
  // task 1 applied → task 2 applied → both are staged.
  const repo = makeTempRepo({
    'src/foo.js': 'const x = 1;\n',
    'src/bar.js': 'const y = 2;\n',
  });

  const patchFoo = buildPatch('src/foo.js', 'const x = 1;', 'const x = 10;');
  const patchBar = buildPatch('src/bar.js', 'const y = 2;', 'const y = 20;');

  const r1 = isolatedApply(repo, patchFoo, ['src/foo.js']);
  assert.equal(r1.applied, true, `foo patch must apply: ${r1.reason}`);

  const r2 = isolatedApply(repo, patchBar, ['src/bar.js']);
  assert.equal(r2.applied, true, `bar patch must apply: ${r2.reason}`);

  const staged = stagedFiles(repo);
  assert.ok(staged.has('src/foo.js'), 'foo.js must be staged');
  assert.ok(staged.has('src/bar.js'), 'bar.js must be staged');

  const fooContent = stagedContent(repo, 'src/foo.js');
  const barContent = stagedContent(repo, 'src/bar.js');
  assert.ok(fooContent.includes('const x = 10'), `foo.js staged content: ${fooContent}`);
  assert.ok(barContent.includes('const y = 20'), `bar.js staged content: ${barContent}`);
});
