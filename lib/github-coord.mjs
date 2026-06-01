// lib/github-coord.mjs — pure coordination logic for GitHub-based fan-out (§7.3).
//
// All ten functions are PURE: no fs, no network, no LLM. Shell supplies gh/git JSON;
// these compute the decisions. Follows the L1 convention: deterministic, zero-LLM-token,
// unit-tested (design goals 2/3).
//
// Serialization: machine-readable metadata is JSON wrapped in HTML-comment sentinels
// so it survives gh's issue body verbatim but stays invisible in rendered markdown:
//
//   <!-- mp-coord-meta
//   { ...JSON... }
//   mp-coord-meta -->
//
// Label state-machine edges (§7.3 / §8):
//   open → claimed       (follower picks up a task)
//   claimed → open       (release — follower died, orphan reclaim)
//   claimed → pr-open    (follower opens PR)
//   pr-open → closed     (lead merges + GitHub closes)
//
// All other transitions (incl. self-loops, claimed→closed, pr-open→open) return false.
// closed is terminal; nothing exits it.

// ---------------------------------------------------------------------------
// Sentinels — unique, regex-safe
// ---------------------------------------------------------------------------
const META_OPEN = '<!-- mp-coord-meta';
const META_CLOSE = 'mp-coord-meta -->';

// ---------------------------------------------------------------------------
// A1 — Serialization / deserialization
// ---------------------------------------------------------------------------

/**
 * issueBodyForTask(task, opts) → string
 *
 * Produces the GitHub issue body for a single plan task.  The body has:
 *   - A human title line (used for display, NOT for dedup — the metadata key is)
 *   - The machine-readable JSON metadata block in HTML-comment sentinels
 *   - A human-readable task summary (files + verify commands)
 *
 * task: { id, description, files?, verify_commands?, deps? }
 * opts: { contractRef, integrationBranch, baseSha, planHash, runSlug, wave? }
 *
 * Returns: string — the full issue body
 */
export function issueBodyForTask(task, opts = {}) {
  if (!task || task.id == null) throw new Error('issueBodyForTask: task.id is required');
  const { contractRef, integrationBranch, baseSha, planHash, runSlug, wave } = opts;
  if (!runSlug) throw new Error('issueBodyForTask: opts.runSlug is required');

  const meta = {
    run_slug: String(runSlug),
    task_id: String(task.id),
    plan_hash: planHash != null ? String(planHash) : null,
    base_sha: baseSha != null ? String(baseSha) : null,
    wave: wave != null ? Number(wave) : null,
    files: Array.isArray(task.files) ? task.files : [],
    verify_commands: Array.isArray(task.verify_commands) ? task.verify_commands : [],
    deps: Array.isArray(task.deps) ? task.deps : [],
    contract_ref: contractRef != null ? String(contractRef) : null,
    integration_branch: integrationBranch != null ? String(integrationBranch) : null,
  };

  const title = `T${task.id}: ${task.description ?? '(no description)'}`;
  const filesLine =
    meta.files.length > 0 ? `**Files:** ${meta.files.join(', ')}` : '**Files:** (none declared)';
  const verifySummary =
    meta.verify_commands.length > 0
      ? meta.verify_commands.map((c) => `- \`${c}\``).join('\n')
      : '_(none)_';

  return [
    `## ${title}`,
    '',
    META_OPEN,
    JSON.stringify(meta),
    META_CLOSE,
    '',
    filesLine,
    '',
    '**Verify commands:**',
    verifySummary,
  ].join('\n');
}

/**
 * parseIssueBody(body) → meta object (snake_case)
 *
 * Extracts and parses the JSON metadata block from an issue body.
 * Throws if the block is absent or malformed (fail-loud — §9).
 *
 * Returns: { run_slug, task_id, plan_hash, base_sha, wave, files, verify_commands, deps,
 *             contract_ref, integration_branch }
 */
export function parseIssueBody(body) {
  if (typeof body !== 'string') throw new Error('parseIssueBody: body must be a string');
  const start = body.indexOf(META_OPEN);
  const end = body.indexOf(META_CLOSE, start);
  if (start === -1 || end === -1) {
    throw new Error('parseIssueBody: no mp-coord-meta block found in body');
  }
  const raw = body.slice(start + META_OPEN.length, end).trim();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`parseIssueBody: malformed JSON in metadata block: ${e.message}`);
  }
  // Normalize — be lenient on extra fields but ensure the shape the callers expect.
  return {
    run_slug: parsed.run_slug != null ? String(parsed.run_slug) : null,
    task_id: parsed.task_id != null ? String(parsed.task_id) : null,
    plan_hash: parsed.plan_hash != null ? String(parsed.plan_hash) : null,
    base_sha: parsed.base_sha != null ? String(parsed.base_sha) : null,
    wave: parsed.wave != null ? Number(parsed.wave) : null,
    files: Array.isArray(parsed.files) ? parsed.files : [],
    verify_commands: Array.isArray(parsed.verify_commands) ? parsed.verify_commands : [],
    deps: Array.isArray(parsed.deps) ? parsed.deps : [],
    contract_ref: parsed.contract_ref != null ? String(parsed.contract_ref) : null,
    integration_branch: parsed.integration_branch != null ? String(parsed.integration_branch) : null,
  };
}

// ---------------------------------------------------------------------------
// A1 — Deduplication
// ---------------------------------------------------------------------------

/**
 * dedupKey(parsed) → string
 *
 * Stable, human-readable dedup key for a parsed metadata object.
 * Format: "<run_slug>#<task_id>"
 */
export function dedupKey(parsed) {
  const slug = parsed?.run_slug ?? '';
  const id = parsed?.task_id ?? '';
  return `${slug}#${id}`;
}

/**
 * findDuplicates(issues) → Array<Array<issue>>
 *
 * Given an array of issue objects `{ body, ...rest }`, groups those whose
 * parsed metadata yields the same dedupKey.  Returns ONLY groups of size > 1
 * (the conflicting pairs/tuples the shell should fail-loud on).
 * Does NOT throw — stays pure; caller decides how to surface.
 *
 * Issues with an unparseable body (no metadata block) are silently skipped —
 * they are not masterplan-managed issues.
 */
export function findDuplicates(issues) {
  if (!Array.isArray(issues)) return [];
  const groups = new Map();
  for (const issue of issues) {
    let meta;
    try {
      meta = parseIssueBody(issue.body ?? '');
    } catch {
      continue; // not a managed issue
    }
    const key = dedupKey(meta);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(issue);
  }
  return Array.from(groups.values()).filter((g) => g.length > 1);
}

// ---------------------------------------------------------------------------
// A2 — Label state machine
// ---------------------------------------------------------------------------

// Valid edges: from → Set<to>
const TRANSITIONS = new Map([
  ['open', new Set(['claimed'])],
  ['claimed', new Set(['open', 'pr-open'])],
  ['pr-open', new Set(['closed'])],
  // closed is terminal
]);

/**
 * canTransition(from, to) → boolean
 *
 * Returns true iff the label transition is permitted by the state machine.
 * All unrecognised states and backwards edges return false.
 */
export function canTransition(from, to) {
  const targets = TRANSITIONS.get(from);
  return targets != null && targets.has(to);
}

// ---------------------------------------------------------------------------
// A2b — issue_map.status vocabulary (DISTINCT from the GitHub label machine above)
// ---------------------------------------------------------------------------
//
// Two related-but-separate status lifecycles share string values; do not conflate them:
//
//   1. GitHub LABEL lifecycle (TRANSITIONS / canTransition, above) — the `mp:*` labels
//      ON the issue:  open → claimed → pr-open → closed.  `closed` is the only terminal
//      label (GitHub closes the issue when the lead merges the PR); there is no `mp:merged`
//      label.
//
//   2. Local issue_map[task].status lifecycle (THIS) — the lead's local mirror in
//      state.coordination.issue_map:  open → claimed → pr-open → merged [→ closed].
//      The reconcile write-back (orchestrator §7 / G9) records `merged` once a PR lands;
//      `closed` is also accepted as terminal for runs that mirror GitHub's closed state.
//      Nothing in the implemented flow writes local `closed`, so `merged` is the de-facto
//      terminal — which is why BOTH must count as terminal. Treating only `closed` as
//      terminal deadlocks the publish↔follow hand-off (a fully-followed wave never becomes
//      "publishable", so wave N+1 is blocked forever).
//
// Single source of truth for both consumers: the publish preflight
// (`coord-status --fail-if-unpublishable`) and the doctor coord-drift check.

export const ISSUE_MAP_STATUSES = ['open', 'claimed', 'pr-open', 'merged', 'closed'];

const TERMINAL_ISSUE_STATUSES = new Set(['merged', 'closed']);

/**
 * isTerminalIssueStatus(status) → boolean
 *
 * True iff the issue_map entry is in a terminal state (`merged` or `closed`) for
 * publish-advance purposes. The publish preflight and the doctor drift check share this
 * so the terminal definition can never drift between them.
 */
export function isTerminalIssueStatus(status) {
  return TERMINAL_ISSUE_STATUSES.has(status);
}

/**
 * isValidIssueStatus(status) → boolean
 *
 * True iff `status` is a recognised issue_map.status value. Guards `update-issue-map`
 * against typos (`merged` → `merge`) that would otherwise silently write a never-terminal
 * status and re-introduce the publish↔follow deadlock.
 */
export function isValidIssueStatus(status) {
  return ISSUE_MAP_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// A3 — Claim settlement
// ---------------------------------------------------------------------------

/**
 * validateClaimSettle(issueAfterReread, myActor, existingPrsForTask) → 'won' | 'lost'
 *
 * The tightened single-assignee + no-existing-PR settle rule (§8/BLOCKER-3):
 *   won  iff:
 *     - assignees contains exactly myActor (sole assignee, possibly idempotent re-claim)
 *     - current label set includes 'mp:claimed' and does NOT include 'mp:open'
 *     - existingPrsForTask (open PRs for this task) is empty
 *   lost otherwise.
 *
 * issueAfterReread: { assignees: string[], labels: string[], ... }
 * myActor: string  (the follower's GitHub login)
 * existingPrsForTask: Array<any>  (open PRs already filed for this task)
 */
export function validateClaimSettle(issueAfterReread, myActor, existingPrsForTask) {
  if (!issueAfterReread || typeof myActor !== 'string' || !myActor) {
    return 'lost';
  }
  const assignees = issueAfterReread.assignees ?? [];
  const labels = issueAfterReread.labels ?? [];
  const prs = Array.isArray(existingPrsForTask) ? existingPrsForTask : [];

  // Single-assignee: exactly [myActor]
  if (assignees.length !== 1 || assignees[0] !== myActor) return 'lost';
  // Label must be claimed (mp:claimed present, mp:open absent)
  const hasClaimed = labels.includes('mp:claimed');
  const hasOpen = labels.includes('mp:open');
  if (!hasClaimed || hasOpen) return 'lost';
  // No existing open PR
  if (prs.length > 0) return 'lost';
  return 'won';
}

// ---------------------------------------------------------------------------
// A4 — Claimable unit selection
// ---------------------------------------------------------------------------

/**
 * selectClaimableUnits(issues, mergedTaskIds, planIndexDeps) → Array<issue>
 *
 * Returns the subset of `issues` that are currently claimable:
 *   - label includes 'mp:open' (not claimed or closed)
 *   - all declared deps are satisfied (all ∈ mergedTaskIds, as strings)
 *
 * File-disjointness is a plan-build property (§6) — NOT computed here.
 * This function returns all open, dep-satisfied issues; callers may pick one.
 *
 * issues: array of { body, labels: string[], ... }
 * mergedTaskIds: string[] | number[]  — task IDs already merged/done
 * planIndexDeps: Map<string, string[]> | null  — optional: task_id → dep task_ids[]
 *   If null, deps are taken from the parsed issue body.
 */
export function selectClaimableUnits(issues, mergedTaskIds, planIndexDeps) {
  if (!Array.isArray(issues)) return [];
  const doneIds = new Set((mergedTaskIds ?? []).map(String));

  return issues.filter((issue) => {
    const labels = issue.labels ?? [];
    if (!labels.includes('mp:open')) return false;

    let deps;
    if (planIndexDeps != null) {
      let meta;
      try {
        meta = parseIssueBody(issue.body ?? '');
      } catch {
        return false;
      }
      deps = planIndexDeps.get(meta.task_id) ?? [];
    } else {
      let meta;
      try {
        meta = parseIssueBody(issue.body ?? '');
      } catch {
        return false;
      }
      deps = meta.deps ?? [];
    }

    // All deps must be in doneIds
    return deps.every((d) => doneIds.has(String(d)));
  });
}

// ---------------------------------------------------------------------------
// A5 — Wave ordering
// ---------------------------------------------------------------------------

/**
 * nextWaveToPublish(issuesByWave) → number | null
 *
 * Given a map of `{ waveN: { issues: [issue], allMerged: bool } }`, returns the
 * wave number that is next to publish, or null if the current wave is not fully
 * merged.
 *
 * Rules (§8):
 *   - Wave N+1 can only be published after ALL wave-N issues are merged/closed.
 *   - The "next" wave is the lowest wave number not yet published/started, if
 *     and only if every lower wave is fully merged.
 *   - If any wave has unmerged issues, returns null.
 *
 * issuesByWave: { [waveNum]: { issues: Array<{labels: string[]}>, allMerged: bool } }
 *
 * This is intentionally simple: the shell provides `allMerged` (derived from gh
 * data). The function just checks ordering and returns the next unpublished wave.
 *
 * Alternatively: issuesByWave can be an object keyed by wave number (as strings or
 * numbers) with { issues, allMerged }. The function finds the max wave in the object,
 * verifies all waves ≤ max are fully merged, and returns max+1 (or the first unpublished).
 *
 * Returns: wave number (int) to publish next, or null.
 */
export function nextWaveToPublish(issuesByWave) {
  if (!issuesByWave || typeof issuesByWave !== 'object') return null;
  const keys = Object.keys(issuesByWave);
  if (keys.length === 0) return 0; // no waves published yet → start at 0

  const waveNums = keys.map(Number).sort((a, b) => a - b);

  // Every published wave must be fully merged before we can advance
  for (const w of waveNums) {
    const entry = issuesByWave[w];
    if (!entry || !entry.allMerged) return null;
  }

  // All published waves are fully merged → next wave is maxWave + 1
  return waveNums[waveNums.length - 1] + 1;
}

// ---------------------------------------------------------------------------
// A6 — Integration reconciliation
// ---------------------------------------------------------------------------

/**
 * reconcileIntegration(localState, ghIssues) → Array<action>
 *
 * Pure-state reconciliation (§7.2 step 3 / §14.4 idempotent resume).
 * Compares lead's local state vs GitHub issue state and returns the ordered
 * list of write-back actions the shell must execute.
 *
 * localState: {
 *   tasks: [{ id, status }],
 *   coordination: { issue_map: { [task_id]: { issue, pr, merge_sha, status } } }
 * }
 * ghIssues: Array<{ number, labels: string[], body, state: 'open'|'closed',
 *                   pr?: { merged: bool, merge_sha?: string, number: int } }>
 *
 * Returns array of action objects (never mutates inputs):
 *   { action: 'mark_done', task_id, merge_sha, issue, pr }   — merged on GH but not locally done
 *   { action: 'surface',   task_id, issue, reason }          — locally done but not merged on GH
 *
 * Idempotent: applying the mark_done actions to localState and re-running
 * produces zero additional mark_done actions (fixpoint property).
 */
export function reconcileIntegration(localState, ghIssues) {
  if (!localState || !Array.isArray(ghIssues)) return [];

  const tasks = Array.isArray(localState.tasks) ? localState.tasks : [];
  const issueMap = localState.coordination?.issue_map ?? {};

  // Index local tasks by id (string-normalized)
  const taskById = new Map(tasks.map((t) => [String(t.id), t]));

  // Index gh issues by their task_id (from parsed body)
  const ghByTaskId = new Map();
  for (const ghIssue of ghIssues) {
    let meta;
    try {
      meta = parseIssueBody(ghIssue.body ?? '');
    } catch {
      continue;
    }
    if (meta.task_id != null) {
      ghByTaskId.set(String(meta.task_id), ghIssue);
    }
  }

  const actions = [];

  // Check each issue-map entry for drift
  for (const [taskIdStr, entry] of Object.entries(issueMap)) {
    const localTask = taskById.get(taskIdStr);
    const ghIssue = ghByTaskId.get(taskIdStr);

    const localDone = localTask?.status === 'done';
    // GitHub-merged: the issue has a PR that's merged, indicated by ghIssue.pr?.merged
    // OR by the issue being closed and having a recorded merge_sha
    const ghMerged =
      ghIssue != null &&
      (ghIssue.pr?.merged === true ||
        (ghIssue.state === 'closed' && entry.merge_sha != null));

    if (ghMerged && !localDone) {
      // Merged on GitHub but not yet recorded locally → emit write-back action
      const mergeSha = ghIssue.pr?.merge_sha ?? entry.merge_sha ?? null;
      actions.push({
        action: 'mark_done',
        task_id: taskIdStr,
        merge_sha: mergeSha,
        issue: entry.issue,
        pr: entry.pr,
      });
    } else if (localDone && !ghMerged) {
      // Locally done but not merged on GitHub → surface the discrepancy
      actions.push({
        action: 'surface',
        task_id: taskIdStr,
        issue: entry.issue,
        reason: 'locally-done-but-not-merged',
      });
    }
    // If both agree (both done or both pending): no action needed
  }

  return actions;
}

// ---------------------------------------------------------------------------
// A7 — Merge batch planning
// ---------------------------------------------------------------------------

/**
 * mergeBatchPlan(readyPrs) → Array<{ pr, recheckBefore: boolean }>
 *
 * Given an array of ready-to-merge PR objects, returns an ordered merge plan
 * with re-check markers (§5/§6). The first PR in the batch does NOT need a
 * re-check (it's already been checked); every subsequent PR must be re-checked
 * for mergeability after the preceding merge advanced the integration branch.
 *
 * readyPrs: Array<{ number, task_id, ... }> — ordered by task_id ascending
 * Returns: Array<{ pr: <readyPr>, recheckBefore: boolean }>
 *
 * Does not throw on empty input — returns [].
 */
export function mergeBatchPlan(readyPrs) {
  if (!Array.isArray(readyPrs) || readyPrs.length === 0) return [];

  // Stable ordering: sort by task_id numerically (string-normalized, then numeric)
  const sorted = [...readyPrs].sort((a, b) => {
    const aId = Number(a.task_id ?? a.number ?? 0);
    const bId = Number(b.task_id ?? b.number ?? 0);
    return aId - bId;
  });

  return sorted.map((pr, i) => ({
    pr,
    recheckBefore: i > 0, // first PR already checked; each subsequent needs a fresh check
  }));
}
