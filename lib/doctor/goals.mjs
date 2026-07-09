/**
 * lib/doctor/goals.mjs
 *
 * Masterplan v8 doctor check: goal-tracking consistency (spec §9).
 *
 * SKIP/PASS boundary:
 *   - Non-goals bundles and pre-feature bundles (no capability/goal events, no marker)
 *     are silently skipped via inferGoalsCapability.
 *   - PASS is returned when at least one goals-capable bundle exists and all are consistent.
 *   - SKIP is returned when no goals-capable bundles are found.
 *
 * Semantics:
 *   - WARN: past brainstorm without freeze, hash mismatch, uncovered post-plan amendment.
 *   - ERROR: archived run lacking valid check or covering waivers.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveRunsDir, bundleArtifacts } from '../paths.mjs';
import { parseState, inferGoalsCapability } from '../bundle.mjs';
import { goalsHash, validateGoalCheckReceipt, validateGoalWaiver } from '../goals.mjs';
import { validatePlanIndex } from '../plan-merge.mjs';

const ID = 'goals';

/**
 * Synchronous doctor check.
 * @param {string} repoRoot
 * @param {object} opts
 * @returns {Array<{ id: string, severity: 'PASS'|'WARN'|'ERROR'|'SKIP', summary: string, fix: string|null }>}
 */
export function check(repoRoot, opts = {}) {
  const runsDir = resolveRunsDir(repoRoot, opts);
  let slugs = [];
  try {
    slugs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    // absent/unreadable runs dir → zero slugs
  }

  const findings = [];
  let capableCount = 0;

  for (const slug of slugs) {
    try {
      const artifacts = bundleArtifacts(repoRoot, slug, opts);
      const statePath = artifacts.state;
      const eventsPath = artifacts.events;
      const goalsMdPath = path.join(path.dirname(statePath), 'goals.md');

      // Read state
      let state;
      try {
        state = parseState(fs.readFileSync(statePath, 'utf8'));
      } catch {
        continue; // parse failure → skip bundle
      }

      // Read events
      const events = readEvents(eventsPath);

      // Read goals.md
      let goalsMdText = null;
      try {
        goalsMdText = fs.readFileSync(goalsMdPath, 'utf8');
      } catch {
        // absent/unreadable
      }

      // Determine capability
      const cap = inferGoalsCapability(events);
      const capable = cap.enabled || state.goals_enabled === true;
      if (!capable) {
        continue;
      }
      capableCount++;

      // --- Checks for goals-enabled bundle ---

      // a. WARN: past brainstorm with no goals_frozen
      if (state.phase && state.phase !== 'brainstorm') {
        const hasFrozen = events.some((e) => e.type === 'goals_frozen');
        if (!hasFrozen) {
          findings.push({
            id: ID,
            severity: 'WARN',
            summary: `bundle ${slug}: past brainstorm (phase ${state.phase}) but goals were never frozen (no goals_frozen event)`,
            fix: `run '/masterplan' to freeze goals before planning, or 'goals-load' to (re)capture them`,
          });
        }
      }

      // b. WARN: goals.md hash mismatch vs events
      const frozen = lastFrozenGoalsHash(events);
      if (frozen != null && goalsMdText != null) {
        const computed = goalsHash(goalsMdText);
        if (computed !== frozen) {
          findings.push({
            id: ID,
            severity: 'WARN',
            summary: `bundle ${slug}: goals.md hash does not match the frozen goals hash in events (direct edit or stale cache)`,
            fix: `restore goals.md to the frozen content or run 'goals-amend' to record the change (also hard-blocked at plan/finish transitions)`,
          });
        }
      }

      // c. WARN: post-plan amendment leaves a goal uncovered in plan index
      const hasAmendment = events.some((e) => e.type === 'goal_amended');
      if (hasAmendment) {
        const planIndexPath = path.join(path.dirname(statePath), 'plan.index.json');
        let parsedIndex = null;
        try {
          parsedIndex = JSON.parse(fs.readFileSync(planIndexPath, 'utf8'));
        } catch {
          // absent/unreadable/unparseable → skip this check
        }
        if (parsedIndex != null) {
          const activeGoals = (state.goals || []).filter((g) => g && !g.tombstone);
          const result = validatePlanIndex(parsedIndex, activeGoals);
          if (!result.ok && result.errors && Array.isArray(result.errors)) {
            const hasUncovered = result.errors.some((err) =>
              typeof err === 'string' && /is not covered by any task/.test(err)
            );
            if (hasUncovered) {
              findings.push({
                id: ID,
                severity: 'WARN',
                summary: `bundle ${slug}: a post-plan goal amendment left a goal uncovered in plan.index.json`,
                fix: `re-run planning / validate-plan-index so every active goal is cited by at least one task`,
              });
            }
          }
        }
      }

      // d. ERROR: archived run without valid check or covering waivers
      if (state.status === 'archived') {
        const activeGoals = (state.goals || []).filter((g) => g && !g.tombstone);
        const frozenHash = lastFrozenGoalsHash(events);

        // Find last goal_check. evData() returns event.data only, which DROPS the event-level `ts` AND
        // leaves provenance nested (record-goal-check stores data.provenance = {attested_by, approval_receipt}
        // or {dispatch_id, model, output_tokens}). validateGoalCheckReceipt expects both `receipt.ts` and a
        // FLAT receipt (attested_by/approval_receipt at top level). Reconstruct that shape from the stored
        // event so a receipt recorded by `mp record-goal-check` re-validates cleanly instead of ERRORing
        // (observed: every archived goals-enabled bundle with a recorded goal_check doctor-ERRORed).
        const checkEvents = events.filter((e) => e.type === 'goal_check');
        const lastCheckEvent = checkEvents.length > 0 ? checkEvents[checkEvents.length - 1] : null;
        const lastCheckData = lastCheckEvent ? evData(lastCheckEvent) : null;
        const lastCheck = lastCheckData
          ? { ...lastCheckData, ts: lastCheckEvent.ts ?? lastCheckData.ts, ...(lastCheckData.provenance || {}) }
          : null;

        let validCheck = false;
        if (lastCheck) {
          const receiptResult = validateGoalCheckReceipt(lastCheck, {
            goalsHash: frozenHash ?? lastCheck.goals_hash,
            headSha: lastCheck.head_sha,
            baseDiffHash: lastCheck.base_diff_hash,
            goals: activeGoals,
          });
          if (receiptResult.ok === true) {
            validCheck = true;
          }
        }

        let validWaiver = false;
        if (!validCheck) {
          const waiverEvents = events.filter((e) => e.type === 'goal_waived');
          const lastWaiverEvent = waiverEvents.length > 0 ? waiverEvents[waiverEvents.length - 1] : null;
          const lastWaiver = lastWaiverEvent ? { ...evData(lastWaiverEvent), ts: lastWaiverEvent.ts ?? evData(lastWaiverEvent).ts } : null;
          if (lastWaiver) {
            const waiverResult = validateGoalWaiver(lastWaiver, {
              goalsHash: frozenHash ?? lastWaiver.goals_hash,
              headSha: lastWaiver.head_sha,
              base: lastWaiver.base,
              diffHash: lastWaiver.diff_hash,
              goals: activeGoals,
            });
            if (waiverResult.ok === true) {
              // Check every active goal id is present as a key in waiver.reasons
              const reasons = lastWaiver.reasons;
              if (reasons && typeof reasons === 'object') {
                const allCovered = activeGoals.every((g) => g && g.id in reasons);
                if (allCovered) {
                  validWaiver = true;
                }
              }
            }
          }
        }

        if (!validCheck && !validWaiver) {
          findings.push({
            id: ID,
            severity: 'ERROR',
            summary: `bundle ${slug}: archived goals-enabled run has neither a valid goal_check receipt nor covering waivers at final HEAD`,
            fix: `re-open the run and run the goal assessor (record-goal-check) or record covering goal waivers before archiving`,
          });
        }
      }
    } catch {
      // Any unexpected error in per-bundle processing → skip that bundle
    }
  }

  if (findings.length === 0) {
    if (capableCount === 0) {
      return [{ id: ID, severity: 'SKIP', summary: 'no goals-enabled bundles to check', fix: null }];
    }
    return [{ id: ID, severity: 'PASS', summary: 'all goals-enabled bundles have consistent goal state', fix: null }];
  }

  return findings;
}

/**
 * Read events from a JSONL file.
 * @param {string} eventsPath
 * @returns {Array<object>}
 */
function readEvents(eventsPath) {
  let content;
  try {
    content = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return [];
  }
  const records = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip unparseable lines
    }
  }
  return records;
}

/**
 * Extract data payload from an event record.
 * @param {object} rec
 * @returns {object}
 */
function evData(rec) {
  return rec.data && typeof rec.data === 'object' ? rec.data : rec;
}

/**
 * Find the last frozen/amended goals hash from events.
 * @param {Array<object>} events
 * @returns {string|null}
 */
function lastFrozenGoalsHash(events) {
  let result = null;
  for (const rec of events) {
    if (rec.type === 'goals_frozen' || rec.type === 'goal_amended') {
      const d = evData(rec);
      let hash = null;
      if (rec.type === 'goal_amended') {
        hash = d.new_hash ?? d.new_goals_hash ?? d.goals_hash ?? d.hash;
      } else {
        hash = d.goals_hash ?? d.hash;
      }
      if (hash && typeof hash === 'string' && hash.length > 0) {
        result = hash;
      }
    }
  }
  return result;
}
