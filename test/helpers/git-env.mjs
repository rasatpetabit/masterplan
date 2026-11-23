import { execFileSync, spawnSync } from 'node:child_process';
import { gitEnv } from '../../lib/config.mjs';

export function isolatedGitEnv(overrides = {}) {
  return gitEnv(overrides, process.env, { stripIndex: true });
}

export function runGit(dir, args, opts = {}) {
  return String(execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: isolatedGitEnv(opts.env),
    ...opts,
  })).trim();
}

export function spawnGit(dir, args, opts = {}) {
  return spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: isolatedGitEnv(opts.env),
    ...opts,
  });
}
