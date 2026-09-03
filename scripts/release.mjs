#!/usr/bin/env node
// scripts/release.mjs — release surface for masterplan wave task 42.
//
// Validates the release version, refuses version files that were not already
// bumped (it never bumps them itself), inserts and commits only a missing
// CHANGELOG release header, creates an annotated tag, replays idempotently
// when its tag already points at HEAD, and fails for a foreign tag.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parseArgs(argv) {
  let version = null;
  let repo = process.cwd();
  for (const arg of argv) {
    if (arg.startsWith('--version=')) {
      version = arg.slice('--version='.length);
    } else if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (version === null) {
    console.error('usage: node scripts/release.mjs --version=V [--repo=<path>]');
    process.exit(2);
  }
  return { version, repo };
}

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function readJson(repo, file) {
  return JSON.parse(readFileSync(join(repo, file), 'utf8'));
}

function main() {
  const { version, repo } = parseArgs(process.argv.slice(2));

  if (!VERSION_RE.test(version)) {
    console.error(`invalid version: ${version}`);
    process.exit(2);
  }

  // 1. Check every version-bearing file that exists.
  const versionFiles = [
    { file: 'package.json', get: (j) => [j.version] },
    { file: '.claude-plugin/plugin.json', get: (j) => [j.version] },
    { file: '.claude-plugin/marketplace.json', get: (j) => [j.version, j.plugins && j.plugins[0] && j.plugins[0].version] },
    { file: '.codex-plugin/plugin.json', get: (j) => [j.version] },
    { file: 'README.md', get: (text) => { const m = text.match(/Current release: \*\*v([^*]+)\*\*/); return m ? [m[1]] : []; } },
  ];
  const mismatches = [];
  for (const { file, get } of versionFiles) {
    const full = join(repo, file);
    if (!existsSync(full)) continue;
    let values;
    try {
      if (file.endsWith('.json')) {
        values = get(JSON.parse(readFileSync(full, 'utf8')));
      } else {
        values = get(readFileSync(full, 'utf8'));
      }
    } catch {
      mismatches.push(`${file}=malformed`);
      continue;
    }
    if (values.length === 0) {
      mismatches.push(`${file}=missing`);
      continue;
    }
    for (const v of values) {
      if (v === undefined) {
        mismatches.push(`${file}=missing`);
      } else if (v !== version) {
        mismatches.push(`${file}=${v}`);
      }
    }
  }
  if (mismatches.length > 0) {
    for (const m of mismatches) {
      console.error(`version files not bumped: ${m}`);
    }
    process.exit(1);
  }

  // 2. Refuse if any path is dirty.
  const status = git(repo, ['status', '--porcelain']);
  const dirty = status.split('\n').filter(Boolean).map((line) => line.slice(3));
  if (dirty.length > 0) {
    console.error(`dirty paths: ${dirty.join(', ')}`);
    process.exit(1);
  }

  // 3. Tag checks.
  let tagExists = false;
  try {
    git(repo, ['rev-parse', '--verify', `refs/tags/v${version}`]);
    tagExists = true;
  } catch {
    tagExists = false;
  }
  if (tagExists) {
    const head = git(repo, ['rev-parse', 'HEAD']);
    const tagCommit = git(repo, ['rev-parse', `refs/tags/v${version}^{commit}`]);
    const tagType = git(repo, ['cat-file', '-t', `refs/tags/v${version}`]);
    const committedChangelog = git(repo, ['show', 'HEAD:CHANGELOG.md']);
    const headerRe = new RegExp(`^## \\[${escapeRegExp(version)}\\]( |$)|^## ${escapeRegExp(version)}( |$)`, 'm');
    if (tagCommit === head && tagType === 'tag' && headerRe.test(committedChangelog)) {
      console.error('already released');
      console.log(JSON.stringify({ version, tag: `v${version}`, sha: head, changelog_commit: null }));
      process.exit(0);
    }
    console.error('foreign tag');
    process.exit(1);
  }

  // 4. Insert a missing CHANGELOG release header (matching the file's style).
  const changelogPath = join(repo, 'CHANGELOG.md');
  const changelog = readFileSync(changelogPath, 'utf8');
  const headerRe = new RegExp(`^## \\[${escapeRegExp(version)}\\]( |$)|^## ${escapeRegExp(version)}( |$)`, 'm');
  let changelogCommit = null;
  if (!headerRe.test(changelog)) {
    const today = new Date().toISOString().slice(0, 10);
    const header = `## [${version}] — ${today}\n\n`;
    const releaseHeaderRe = /^## \[[^\]]+\] — \d{4}-\d{2}-\d{2}/m;
    const match = changelog.match(releaseHeaderRe);
    const updated = match
      ? changelog.slice(0, match.index) + header + changelog.slice(match.index)
      : changelog + '\n' + header;
    writeFileSync(changelogPath, updated);
    git(repo, ['add', 'CHANGELOG.md']);
    git(repo, ['commit', '-m', `release: v${version}`]);
    changelogCommit = git(repo, ['rev-parse', 'HEAD']);
  }

  const head = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['tag', '-a', `v${version}`, '-m', `v${version}`]);

  console.log(JSON.stringify({ version, tag: `v${version}`, sha: head, changelog_commit: changelogCommit }));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

main();
