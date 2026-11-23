import { execFileSync, spawnSync } from 'node:child_process';
import { gitEnv } from '../../lib/config.mjs';

export function isolatedGitEnv(overrides = {}) {
  return gitEnv(overrides, process.env, { stripIndex: true });
}

export function runGit(dir, args, opts = {}) {
  const env = opts.env
    ? gitEnv({}, opts.env, { stripIndex: true })
    : isolatedGitEnv();
  return String(execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    ...opts,
    env,
  })).trim();
}

export function spawnGit(dir, args, opts = {}) {
  const env = opts.env
    ? gitEnv({}, opts.env, { stripIndex: true })
    : isolatedGitEnv();
  return spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    ...opts,
    env,
  });
}
