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
import { goalsHash, parseGoals, validateGoalCheckReceipt, validateGoalWaiver } from '../goals.mjs';
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
        state = {};
      }

      // Read events
      const events = readEvents(eventsPath);
      const droppedEventLines = readEventsDropped(eventsPath);

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

      // --- E12: fail-closed diagnosis, never silent drop -----------------
      // A goals-capable bundle whose state.yml is unparseable/structural ({}
      // with no slug — parseState tolerates garbage into an empty object rather
      // than throwing) cannot have its archived status / receipts assessed.
      // Without this, a tampered or corrupted state.yml silently escapes the
      // ERROR-severity audit and can even drive a green PASS. Diagnose it
      // explicitly instead.
      if (typeof state.slug !== 'string' || state.slug.trim() === '') {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle ${slug}: state.yml is malformed or unreadable (missing slug) — goals audit cannot assess archived-run receipts; bundle excluded from the PASS path`,
          fix: `restore a valid state.yml (schema_version, slug, status, phase) or repair the corrupted file`,
        });
        continue;
      }

      // Malformed events: unparseable lines were dropped from the event log the
      // capability inference and receipt checks run over. Surface it so an
      // incomplete audit is never mistaken for a clean one.
      if (droppedEventLines > 0) {
        findings.push({
          id: ID,
          severity: 'WARN',
          summary: `bundle ${slug}: events.jsonl contains ${droppedEventLines} unparseable line(s) — goal capability/receipt audit may be incomplete`,
          fix: `repair the malformed events.jsonl lines so the goal lifecycle can be fully audited`,
        });
      }

      // --- Exemption: abandoned archived brainstorm shell -----------------
      // A goals-enabled bundle that was archived straight out of brainstorm
      // with zero tasks, zero active goals, and no execution events has
      // nothing to assess — a goal_check receipt would be dishonest. Treat it
      // as abandoned and skip it entirely (does not count as a goals-enabled
      // bundle). The completed-run case — phase past brainstorm, or any
      // tasks/goals/execution events — still requires a receipt below.
      if (state.status === 'archived') {
        const activeGoals = (state.goals || []).filter((g) => g && !g.tombstone);
        const hasTasks = Array.isArray(state.tasks) && state.tasks.length > 0;
        const isBrainstormShell = state.phase === 'brainstorm' && !hasTasks && activeGoals.length === 0;
        if (isBrainstormShell) {
          const executed = events.some((e) =>
            ['goals_frozen', 'goal_check', 'goal_waived', 'execute', 'execute-complete',
             'phase_transition', 'plan_loaded', 'wave_dispatch'].includes(e.type)
          );
          if (!executed) {
            continue; // abandoned shell — nothing to assess, not goals-capable
          }
        }
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
        let planIndexMalformed = false;
        try {
          parsedIndex = JSON.parse(fs.readFileSync(planIndexPath, 'utf8'));
        } catch (e) {
          // E12: distinguish absent (normal for pre-plan bundles) from malformed
          // (a post-amendment bundle that cannot have its uncovered-goal check run
          // must not silently skip that check).
          if (!(e && e.code === 'ENOENT')) {
            planIndexMalformed = true;
          }
        }
        if (planIndexMalformed) {
          findings.push({
            id: ID,
            severity: 'WARN',
            summary: `bundle ${slug}: plan.index.json is unparseable — post-plan amendment uncovered-goal check cannot run`,
            fix: `repair plan.index.json so the amendment's goal coverage can be verified`,
          });
        } else if (parsedIndex != null) {
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
        // goals.md is the same authoritative source record-goal-check validates. Older/in-flight
        // bundles can legitimately have a null or stale state.goals cache; validating the stored
        // receipt against that cache makes a real receipt impossible to re-validate. Fall back to
        // state only when goals.md is absent — an empty parse must stay empty/fail closed.
        const receiptGoals = goalsMdText != null ? parseGoals(goalsMdText).goals : (state.goals || []);
        const activeGoals = receiptGoals.filter((g) => g && !g.tombstone);
        const frozenHash = lastFrozenGoalsHash(events);

        // Find last goal_check. evData() returns event.data only, which DROPS the event-level `ts` AND
        // leaves provenance nested (record-goal-check stores data.provenance = {attested_by, approval_receipt}
        // or {dispatch_id, model, output_tokens}). validateGoalCheckReceipt expects both `receipt.ts` and a
        // FLAT receipt (attested_by/approval_receipt at top level). Reconstruct that shape from the stored
        // event so a receipt recorded by `mp record-goal-check` re-validates cleanly instead of ERRORing
        // (observed: every archived goals-enabled bundle with a recorded goal_check doctor-ERRORed).
        const checkEvents = events.filter((e) => e.type === 'goal_check');
        const waiverEvents = events.filter((e) => e.type === 'goal_waived');

        // Newest-first scan for a STRUCTURALLY VALID receipt. Selecting only the
        // last event lets an invalid trailing receipt (e.g. a cleanup stub with
        // placeholder provenance) shadow an earlier valid user-attested check.
        let validCheck = false;
        for (let i = checkEvents.length - 1; i >= 0; i--) {
          const ev = checkEvents[i];
          const data = evData(ev);
          const check = data
            ? { ...data, ts: ev.ts ?? data.ts, ...(data.provenance || {}) }
            : null;
          if (!check) continue;
          const receiptResult = validateGoalCheckReceipt(check, {
            goalsHash: frozenHash ?? check.goals_hash,
            headSha: check.head_sha,
            baseDiffHash: check.base_diff_hash,
            goals: activeGoals,
          });
          if (receiptResult.ok === true) {
            validCheck = true;
            break;
          }
        }

        let validWaiver = false;
        if (!validCheck) {
          for (let i = waiverEvents.length - 1; i >= 0; i--) {
            const ev = waiverEvents[i];
            const data = evData(ev);
            const waiver = data ? { ...data, ts: ev.ts ?? data.ts } : null;
            if (!waiver) continue;
            const waiverResult = validateGoalWaiver(waiver, {
              goalsHash: frozenHash ?? waiver.goals_hash,
              headSha: waiver.head_sha,
              base: waiver.base,
              diffHash: waiver.diff_hash,
              goals: activeGoals,
            });
            if (waiverResult.ok === true) {
              // Check every active goal id is present as a key in waiver.reasons
              const reasons = waiver.reasons;
              if (reasons && typeof reasons === 'object') {
                const allCovered = activeGoals.every((g) => g && g.id in reasons);
                if (allCovered) {
                  validWaiver = true;
                  break;
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
    } catch (err) {
      // E12: narrow the broad per-bundle catch — an unexpected error must be
      // surfaced as an explicit ERROR naming the bundle, never a silent skip
      // (which let a bundle drop out of the ERROR-severity audit).
      findings.push({
        id: ID,
        severity: 'ERROR',
        summary: `bundle ${slug}: doctor goals check failed unexpectedly — ${err instanceof Error ? err.message : String(err)}`,
        fix: `investigate the per-bundle error above so the goals audit covers this bundle`,
      });
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
 * Count unparseable (non-empty) lines in a JSONL events file. Used by the
 * E12 malformed-events diagnosis so an event log that dropped lines (and thus
 * may under-report goal capability / receipts) is surfaced rather than read
 * as a clean audit.
 * @param {string} eventsPath
 * @returns {number}
 */
function readEventsDropped(eventsPath) {
  let content;
  try {
    content = fs.readFileSync(eventsPath, 'utf8');
  } catch {
    return 0;
  }
  let dropped = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      JSON.parse(trimmed);
    } catch {
      dropped++;
    }
  }
  return dropped;
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
