#!/usr/bin/env node
// bin/install-pi.mjs — copy-based Pi install for masterplan.
//
// Pi has no plugin manager; the historical install was a symlink into the dev
// tree, which the fleet's production-boundary policy prohibits (a live pointer
// into a half-edited tree). This installer is the deliberate alternative: it
// copies an EXACT COMMITTED snapshot (git archive — never dirty working-tree
// bytes) into a content-addressed release dir and atomically flips `current`.
//
// Layout:
//   <install-root>/releases/<git-sha>/    full snapshot of the release commit
//   <install-root>/current                symlink -> releases/<sha> (atomic swap)
//   <install-root>/.pi-install.json       {version, sha, ref, source, installed_at}
//   <pi-root>/agent/skills/masterplan     symlink -> current/skills/masterplan
//   <pi-root>/agent/skills/masterplan-detect  likewise
//
// Agents are registered from the staged release via bin/register-pi-agents.mjs
// (runRegister), BEFORE `current` is switched — a registration failure aborts
// the install without touching the live link.
//
// Usage:
//   node bin/install-pi.mjs [--ref=<ref>] [--source=<repo>]
//                           [--install-root=<dir>] [--pi-root=<dir>] [--force]
//   node bin/install-pi.mjs --check [--install-root=<dir>] [--pi-root=<dir>]
//
// --check is read-only: verifies current resolves, metadata agrees, skill
// links resolve under current, and agent registration is drift-free.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runRegister } from './register-pi-agents.mjs';

const INSTALL_META = '.pi-install.json';
const RELEASES_DIR = 'releases';
const CURRENT_LINK = 'current';
const SKILL_NAMES = ['masterplan', 'masterplan-detect'];

// Paths a valid release snapshot MUST carry. Fail closed if any is missing —
// a half-snapshot install would break the skill's resolution chain silently.
const REQUIRED_PATHS = [
  'commands/masterplan.md',
  'bin/masterplan.mjs',
  'bin/doctor.mjs',
  'bin/register-pi-agents.mjs',
  'lib/bundle.mjs',
  'agents',
  'skills/masterplan/SKILL.md',
  'skills/masterplan-detect/SKILL.md',
  'policy/workflow-map.json',
  'package.json',
];

function die(msg, code = 2) {
  process.stderr.write(`install-pi: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { check: false, force: false, ref: 'HEAD', source: null, installRoot: null, piRoot: null };
  for (const arg of argv) {
    if (arg === '--check') { opts.check = true; continue; }
    if (arg === '--force') { opts.force = true; continue; }
    const m = arg.match(/^--(ref|source|install-root|pi-root)=(.+)$/);
    if (m) {
      const key = { ref: 'ref', source: 'source', 'install-root': 'installRoot', 'pi-root': 'piRoot' }[m[1]];
      opts[key] = m[2];
      continue;
    }
    die(`unknown option: ${arg}`, 2);
  }
  return opts;
}

function defaultSource() {
  // The repo this script is installed in (bin/ sits at the repo root).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const r = spawnSync('git', ['-C', path.join(here, '..'), 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) die(`--source not given and ${here} is not inside a git repo`, 2);
  return r.stdout.trim();
}

function resolveSha(source, ref) {
  const r = spawnSync('git', ['-C', source, 'rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' });
  if (r.status !== 0) die(`cannot resolve ref '${ref}' to a commit in ${source}\n${r.stderr.trim()}`, 1);
  return r.stdout.trim();
}

function validateSnapshot(dir) {
  const missing = REQUIRED_PATHS.filter((p) => !fs.existsSync(path.join(dir, p)));
  if (missing.length) die(`snapshot failed validation — missing: ${missing.join(', ')}`, 1);
}

function readMeta(installRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(installRoot, INSTALL_META), 'utf8'));
  } catch {
    return null;
  }
}

function ensureSkillLink(piRoot, installRoot, name, force) {
  const linkPath = path.join(piRoot, 'agent', 'skills', name);
  const target = path.join(installRoot, CURRENT_LINK, 'skills', name);
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let note = 'unchanged';
  // lstat to see through broken symlinks (existsSync follows and misses them)
  let st = null;
  try { st = fs.lstatSync(linkPath); } catch { st = null; }
  if (!st) {
    fs.symlinkSync(target, linkPath);
    note = 'created';
  } else if (st.isSymbolicLink()) {
    const cur = fs.readlinkSync(linkPath);
    if (cur !== target) {
      fs.unlinkSync(linkPath);
      fs.symlinkSync(target, linkPath);
      note = `repointed (was ${cur})`;
    }
  } else {
    if (!force) die(`${linkPath} is a regular ${st.isFile() ? 'file' : 'directory'}, not a symlink — refusing to replace without --force`, 1);
    fs.rmSync(linkPath, { recursive: true });
    fs.symlinkSync(target, linkPath);
    note = 'replaced (--force)';
  }
  return { linkPath, target, note };
}

function install(opts) {
  const source = opts.source ?? defaultSource();
  const sha = resolveSha(source, opts.ref);
  const installRoot = opts.installRoot ?? path.join(process.env.HOME ?? '/root', '.local', 'share', 'masterplan');
  const piRoot = opts.piRoot ?? path.join(process.env.HOME ?? '/root', '.pi');
  const releaseDir = path.join(installRoot, RELEASES_DIR, sha);
  const currentPath = path.join(installRoot, CURRENT_LINK);

  // Idempotency: already the live release -> verify links + registration, done.
  let currentTarget = null;
  try {
    if (fs.lstatSync(currentPath).isSymbolicLink()) currentTarget = fs.readlinkSync(currentPath);
  } catch { /* no current link yet */ }
  if (currentTarget === path.join(RELEASES_DIR, sha) || currentTarget === releaseDir) {
    for (const name of SKILL_NAMES) ensureSkillLink(piRoot, installRoot, name, opts.force);
    const reg = runRegister({ agentsDir: path.join(releaseDir, 'agents'), targetDir: path.join(piRoot, 'agent', 'agents'), check: false });
    if (reg.drift > 0) die(`registration drift after relink:\n${reg.report.join('\n')}`, 1);
    process.stdout.write(JSON.stringify({ install_pi: 'idempotent', sha, release: releaseDir, registration: { written: reg.written, removed: reg.removed } }) + '\n');
    return;
  }

  if (fs.existsSync(releaseDir)) {
    // Snapshot already staged by a previous interrupted run — validate and reuse.
    validateSnapshot(releaseDir);
  } else {
    // Stage INSIDE the install root so the final rename stays on one filesystem.
    fs.mkdirSync(path.join(installRoot, RELEASES_DIR), { recursive: true });
    const staging = fs.mkdtempSync(path.join(installRoot, `.staging-${sha.slice(0, 12)}-`));
    try {
      const arch = spawnSync('git', ['-C', source, 'archive', '--format=tar', sha], { maxBuffer: 512 * 1024 * 1024 });
      if (arch.status !== 0) die(`git archive failed for ${sha}:\n${arch.stderr.toString().trim()}`, 1);
      const untar = spawnSync('tar', ['-x', '-C', staging], { input: arch.stdout });
      if (untar.status !== 0) die(`tar extraction failed:\n${untar.stderr.toString().trim()}`, 1);
      validateSnapshot(staging);
      fs.renameSync(staging, releaseDir);
    } finally {
      if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  // Register agents from the staged release BEFORE switching current — a
  // failure here aborts with the live install untouched.
  const reg = runRegister({ agentsDir: path.join(releaseDir, 'agents'), targetDir: path.join(piRoot, 'agent', 'agents'), check: false });
  if (reg.drift > 0) die(`registration from staged release failed:\n${reg.report.join('\n')}`, 1);

  // Atomic current swap: temp symlink + rename over.
  if (fs.existsSync(currentPath) && !fs.lstatSync(currentPath).isSymbolicLink()) {
    if (!opts.force) die(`${currentPath} exists and is not a symlink — refusing to replace without --force`, 1);
    fs.rmSync(currentPath, { recursive: true });
  }
  const tmpLink = `${currentPath}.tmp-${process.pid}`;
  try { fs.unlinkSync(tmpLink); } catch { /* absent */ }
  fs.symlinkSync(path.join(RELEASES_DIR, sha), tmpLink); // relative target: keeps the install dir relocatable
  fs.renameSync(tmpLink, currentPath);

  const links = SKILL_NAMES.map((name) => ensureSkillLink(piRoot, installRoot, name, opts.force));

  const pkg = JSON.parse(fs.readFileSync(path.join(releaseDir, 'package.json'), 'utf8'));
  fs.writeFileSync(
    path.join(installRoot, INSTALL_META),
    JSON.stringify({ version: pkg.version, sha, ref: opts.ref, source, installed_at: new Date().toISOString() }, null, 2) + '\n',
    'utf8',
  );

  process.stdout.write(JSON.stringify({
    install_pi: 'installed',
    sha,
    version: pkg.version,
    release: releaseDir,
    current: fs.realpathSync(currentPath),
    links: links.map((l) => `${path.basename(l.linkPath)}: ${l.note}`),
    registration: { written: reg.written, removed: reg.removed },
  }) + '\n');
}

function check(opts) {
  const installRoot = opts.installRoot ?? path.join(process.env.HOME ?? '/root', '.local', 'share', 'masterplan');
  const piRoot = opts.piRoot ?? path.join(process.env.HOME ?? '/root', '.pi');
  const problems = [];
  if (!fs.existsSync(installRoot)) {
    process.stdout.write(JSON.stringify({ install_pi: 'check_failed', problems: [`install root missing: ${installRoot}`] }) + '\n');
    process.exit(1);
  }
  const currentPath = path.join(installRoot, CURRENT_LINK);

  let releaseDir = null;
  try {
    if (!fs.lstatSync(currentPath).isSymbolicLink()) problems.push(`${currentPath} is not a symlink`);
    else releaseDir = fs.realpathSync(currentPath);
  } catch {
    problems.push(`${currentPath} missing`);
  }

  const meta = readMeta(installRoot);
  if (!meta) problems.push(`${INSTALL_META} missing`);
  else if (releaseDir && path.basename(releaseDir) !== meta.sha) problems.push(`current (${path.basename(releaseDir)}) disagrees with ${INSTALL_META} sha (${meta.sha})`);

  if (releaseDir) {
    try { validateSnapshot(releaseDir); } catch (e) { problems.push(`release snapshot invalid: ${e.message}`); }
    for (const name of SKILL_NAMES) {
      const linkPath = path.join(piRoot, 'agent', 'skills', name);
      try {
        const st = fs.lstatSync(linkPath);
        if (!st.isSymbolicLink()) problems.push(`${linkPath} is not a symlink`);
        else {
          const resolved = fs.realpathSync(linkPath);
          if (!resolved.startsWith(fs.realpathSync(installRoot) + path.sep)) {
            problems.push(`${linkPath} resolves OUTSIDE the install root: ${resolved}`);
          }
        }
      } catch {
        problems.push(`${linkPath} missing`);
      }
    }
    const reg = runRegister({ agentsDir: path.join(releaseDir, 'agents'), targetDir: path.join(piRoot, 'agent', 'agents'), check: true });
    if (reg.drift > 0) problems.push(`agent registration drift ${reg.drift}:\n  ${reg.report.filter((l) => l.startsWith('DRIFT')).join('\n  ')}`);
  }

  if (problems.length) {
    process.stdout.write(JSON.stringify({ install_pi: 'check_failed', problems }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ install_pi: 'check_ok', version: meta?.version, sha: meta?.sha, release: releaseDir }) + '\n');
}

const opts = parseArgs(process.argv.slice(2));
if (opts.check) check(opts);
else install(opts);
