// lib/doctor/stale-codex-task.mjs — v8 doctor check (ports v7 #49, stale Codex background task).
//
// User-scoped: reads <homeDir>/.claude/plugins/data/*/state/*/jobs/*.json.
// For each job file: if status is non-terminal (not completed/done/cancelled/failed/error) AND
// startedAt is older than 24 hours relative to opts.now → WARN. Surfaces runaway background
// workers before they become multi-day orphans.
//
// Terminal set (from v7 #49): completed, done, cancelled, failed, error.
// A job with missing/empty status is skipped (treated as not-a-job-entry).
// SKIP when the plugins/data dir does not exist (codex job tracking not in use).
// PASS when no stale jobs are found.
// opts.homeDir and opts.now are injectable for tests.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ID = 'stale-codex-task';
const TERMINAL = new Set(['completed', 'done', 'cancelled', 'failed', 'error']);
const DAY_MS = 86_400_000;

export function check(repoRoot, opts = {}) {
  const homeDir = opts.homeDir ?? os.homedir();
  const now = opts.now ?? Date.now();
  const dataRoot = path.join(homeDir, '.claude', 'plugins', 'data');

  // SKIP if the data dir doesn't exist.
  try {
    const st = fs.statSync(dataRoot);
    if (!st.isDirectory()) {
      return [{ id: ID, severity: 'SKIP', summary: 'no plugin data directory (codex job tracking not in use)', fix: null }];
    }
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no plugin data directory (codex job tracking not in use)', fix: null }];
  }

  const findings = [];

  // Walk data/*/state/*/jobs/*.json
  let plugins;
  try { plugins = fs.readdirSync(dataRoot); } catch { plugins = []; }

  for (const plugin of plugins) {
    const stateDir = path.join(dataRoot, plugin, 'state');
    let runs;
    try { runs = fs.readdirSync(stateDir); } catch { continue; }
    for (const run of runs) {
      const jobsDir = path.join(stateDir, run, 'jobs');
      let jobs;
      try { jobs = fs.readdirSync(jobsDir); } catch { continue; }
      for (const jobFile of jobs) {
        if (!jobFile.endsWith('.json')) continue;
        const jobPath = path.join(jobsDir, jobFile);
        let job;
        try { job = JSON.parse(fs.readFileSync(jobPath, 'utf8')); } catch { continue; }

        const status = job.status ?? '';
        if (!status || TERMINAL.has(status)) continue;

        const startedRaw = job.startedAt;
        if (!startedRaw) continue;
        const startedMs = typeof startedRaw === 'number' ? startedRaw : Date.parse(startedRaw);
        if (Number.isNaN(startedMs)) continue;

        const ageMs = now - startedMs;
        if (ageMs > DAY_MS) {
          const ageH = Math.floor(ageMs / 3_600_000);
          const jobId = job.id ?? path.basename(jobFile, '.json');
          findings.push({
            id: ID, severity: 'WARN',
            summary: `${jobId}: codex task stuck in '${status}' for ${ageH}h`,
            fix: `cancel the task: check codex companion scripts or remove ${jobPath}`,
          });
        }
      }
    }
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'no stale codex background tasks', fix: null }];
  }
  return findings;
}
