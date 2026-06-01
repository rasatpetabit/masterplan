// lib/doctor/coord-drift.mjs — v8 doctor check: coordination state drift for GitHub-coordinated runs.
//
// External surface: <repoRoot>/docs/masterplan/*/state.yml (coordination object).
// Plan-scoped + pure over the filesystem (no gh, no network, no host state):
//   - SKIP when no run bundle carries a `coordination` state object.
//   - For each coordinated bundle, emits WARN findings for:
//     1. **Done-but-open issues**: task is `done` in state.tasks but issue_map.status is still
//        open/claimed/pr-open (not merged) — reconciliation write-back missed.
//     2. **Orphan claims**: issue_map entry has status `claimed` with no PR (pr is null/undefined)
//        — the follower died after claiming, before opening a PR; manual reclaim needed.
//     3. **issue_map drift vs plan**: task IDs present in issue_map but absent from state.tasks,
//        or tasks in the plan (state.tasks) with no issue_map entry but wave already published.
//     4. **published_waves drift**: waves referenced in issue_map entries whose wave field doesn't
//        appear in published_waves, flagging a mismatch between wave-publish records and the map.
//   - PASS (one finding) when all coordinated bundles are clean.
//
// opts is unused (no host state), kept for signature parity with other check modules.
import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState } from '../bundle.mjs';

const ID = 'coord-drift';

export function check(repoRoot) {
  const runsDir = resolveRunsDir(repoRoot, {});
  let slugs;
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }
  if (slugs.length === 0) {
    return [{ id: ID, severity: 'SKIP', summary: 'no run bundles under docs/masterplan', fix: null }];
  }

  const findings = [];
  let anyCoordinated = false;

  for (const slug of slugs) {
    const statePath = bundleArtifacts(repoRoot, slug, {}).state;
    let state;
    try {
      const text = fs.readFileSync(statePath, 'utf8');
      state = parseState(text);
    } catch {
      continue; // unreadable state.yml — state-schema.mjs owns that error
    }

    // Only process bundles with a coordination object (coordinated run).
    const coord = state.coordination;
    if (!coord || typeof coord !== 'object' || Array.isArray(coord)) continue;
    anyCoordinated = true;

    const issueMap = (coord.issue_map && typeof coord.issue_map === 'object' && !Array.isArray(coord.issue_map))
      ? coord.issue_map : {};
    const publishedWaves = Array.isArray(coord.published_waves) ? coord.published_waves : [];

    // Index state.tasks by id (string-normalized) for drift checks.
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const taskById = new Map(tasks.map((t) => [String(t.id), t]));
    const planTaskIds = new Set(tasks.map((t) => String(t.id)));

    // Check 1: done-but-still-open / orphan claims / map-level drift.
    const publishedWaveSet = new Set(publishedWaves.map(String));

    for (const [taskIdStr, entry] of Object.entries(issueMap)) {
      const entryStatus = entry?.status ?? null;
      const hasPr = entry?.pr != null;
      const issueNum = entry?.issue ?? null;

      // 1a. Orphan claim: status is 'claimed' but no PR (follower died before opening PR).
      if (entryStatus === 'claimed' && !hasPr) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: task ${taskIdStr} issue #${issueNum ?? '?'} is mp:claimed with no PR (orphan claim — follower may have died)`,
          fix: `re-label issue #${issueNum ?? '?'} from mp:claimed back to mp:open to allow another follower to claim it (manual reclaim)`,
        });
      }

      // 1b. Done-but-still-open: local task is done but issue_map does not record merged.
      const localTask = taskById.get(taskIdStr);
      if (localTask?.status === 'done' && entryStatus !== 'merged' && entryStatus !== 'closed') {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: task ${taskIdStr} is locally done but issue_map status is '${entryStatus ?? 'unset'}' (expected merged/closed)`,
          fix: `run \`mp reconcile-integration\` or manually update the coordination issue_map via \`mp set-coord\` to record the merge`,
        });
      }

      // 1c. issue_map references a task_id not in the plan.
      if (!planTaskIds.has(taskIdStr)) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: issue_map entry for task ${taskIdStr} has no matching task in state.tasks (plan/map drift)`,
          fix: `verify whether the plan was rebased without updating the coordination issue_map; re-run \`mp publish\` to resync`,
        });
      }
    }

    // Check 2: plan tasks in already-published waves with no issue_map entry.
    const issueMapIds = new Set(Object.keys(issueMap));
    for (const task of tasks) {
      const idStr = String(task.id);
      const waveStr = String(task.wave);
      // Only flag if the task's wave is already in published_waves AND no issue_map entry exists.
      if (publishedWaveSet.has(waveStr) && !issueMapIds.has(idStr)) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: task ${idStr} (wave ${task.wave}) is in a published wave but has no issue_map entry`,
          fix: `the task may have been added to the plan after wave ${task.wave} was published; re-run \`mp publish\` to create its GitHub issue`,
        });
      }
    }

    // Check 3: issue_map entries whose wave (from entry.wave) is not in published_waves.
    for (const [taskIdStr, entry] of Object.entries(issueMap)) {
      if (entry?.wave == null) continue; // wave not recorded — skip this sub-check
      const entryWaveStr = String(entry.wave);
      if (!publishedWaveSet.has(entryWaveStr)) {
        findings.push({
          id: ID, severity: 'WARN',
          summary: `bundle ${slug}: task ${taskIdStr} issue_map records wave ${entry.wave} but that wave is absent from published_waves`,
          fix: `run \`mp publish\` to reconcile published_waves with the issue_map; the coordination state may be partially written`,
        });
      }
    }
  }

  // SKIP (not PASS) when no coordinated bundle exists — exit 0 guaranteed on the live repo.
  if (!anyCoordinated) {
    return [{ id: ID, severity: 'SKIP', summary: 'no coordinated run bundles found', fix: null }];
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'all coordinated run bundles are drift-free', fix: null }];
  }
  return findings;
}
