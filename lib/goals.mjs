import { createHash } from 'node:crypto';

/**
 * lib/goals.mjs — Pure Goal Tracking Core
 *
 * This module provides the pure parse, validate, cross-check, and diff logic
 * for the masterplan goal tracking system. It mirrors the purity of lib/gate-review.mjs.
 *
 * CONSTRAINTS:
 * - NO fs, NO process, NO clock.
 * - node:crypto (createHash) is permitted for canonical hashing because it is pure/deterministic.
 * - Only pure functions operating on strings/objects.
 * - All file/git reads live in the bin layer (CD-7).
 *
 * ARCHITECTURE:
 * - parseGoals / validateGoals: Validate a SINGLE goals.md document.
 * - validateAmendment: Requires the OLD goal set to enforce renumbering/removal-vs-tombstone rules.
 * - crossCheckGoals: Pure derived-cache cross-check between md, state, and event logs.
 * - amendmentDiff: Pure helper to generate change records for goal_amended events.
 * - goalsHash: Canonical identity of a goal set.
 * - waiverKey: Re-arm tuple (goals hash + HEAD + base diff hash).
 * - validateUserApprovalReceipt: Pure validator for a user-approval receipt.
 * - validateGoalCheckReceipt: Anti-fabrication validator for record-goal-check.
 * - validateGoalWaiver: goal_waived event schema + pure validator.
 *
 * EXPORTS:
 * - parseGoals
 * - validateGoals
 * - validateAmendment
 * - crossCheckGoals
 * - amendmentDiff
 * - goalsHash
 * - GOAL_VERDICTS
 * - waiverKey
 * - validateUserApprovalReceipt
 * - validateGoalCheckReceipt
 * - validateGoalWaiver
 */

// ---------------------------------------------------------------------------
// parseGoals
// ---------------------------------------------------------------------------

/**
 * Parses a raw goals.md text string into a structured object.
 *
 * Format Rules:
 * - Header: Text following a line starting with `topic:` (case-insensitive) until a blank line
 *   or the first goal heading. This becomes `topicSeed`.
 * - Goals: Sections starting with `## G<number>: <statement>`.
 * - Keys: `signal:`, `evidence:`, `tombstone_reason:`, `tombstone_at:`.
 *
 * @param {string} goalsMdText - The raw content of goals.md.
 * @returns {{topicSeed: string, goals: Array<{id: string, text: string, signal: string, tombstone?: object}>}}
 */
export function parseGoals(goalsMdText) {
  if (typeof goalsMdText !== 'string') {
    return { topicSeed: '', goals: [] };
  }

  const lines = goalsMdText.split('\n');
  const topicSeedLines = [];
  let collectingTopic = false;
  const goals = [];
  let currentGoal = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // 1. Start collecting topic seed
    if (currentGoal === null && goals.length === 0 && /^topic:/i.test(trimmedLine)) {
      collectingTopic = true;
      const afterTopic = trimmedLine.replace(/^topic:/i, '').trim();
      if (afterTopic) {
        topicSeedLines.push(afterTopic);
      }
      continue;
    }

    // 2. Continue collecting topic seed
    if (collectingTopic) {
      if (trimmedLine === '' || /^##\s+G\d+:/i.test(trimmedLine)) {
        collectingTopic = false;
        // If it's a goal heading, fall through to goal handling below
        if (/^##\s+G\d+:/i.test(trimmedLine)) {
          // fall through
        } else {
          continue;
        }
      } else {
        topicSeedLines.push(trimmedLine);
        continue;
      }
    }

    // 3. Goal heading
    const goalHeadingMatch = trimmedLine.match(/^##\s+(G\d+):\s*(.*)$/);
    if (goalHeadingMatch) {
      if (currentGoal) {
        goals.push(currentGoal);
      }
      const id = goalHeadingMatch[1];
      const text = goalHeadingMatch[2].trim();
      currentGoal = {
        id,
        text,
        signal: '',
      };
      continue;
    }

    // 4. Key/value
    if (currentGoal) {
      const kvMatch = trimmedLine.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim();

        if (key === 'signal') {
          currentGoal.signal = value;
        } else if (key === 'tombstone_reason') {
          if (!currentGoal.tombstone) {
            currentGoal.tombstone = {};
          }
          currentGoal.tombstone.reason = value;
        } else if (key === 'tombstone_at') {
          if (!currentGoal.tombstone) {
            currentGoal.tombstone = {};
          }
          currentGoal.tombstone.amended_at = value;
        }
        // evidence and unknown keys are ignored
      }
    }
  }

  // Push the final currentGoal
  if (currentGoal) {
    goals.push(currentGoal);
  }

  // Set topicSeed
  const topicSeed = topicSeedLines.join('\n').trim();

  // Clean each goal: delete tombstone if absent or incomplete
  const cleanedGoals = goals.map(g => {
    const goal = { ...g };
    if (!goal.tombstone || (!goal.tombstone.reason && !goal.tombstone.amended_at)) {
      delete goal.tombstone;
    }
    return goal;
  });

  return { topicSeed, goals: cleanedGoals };
}

// ---------------------------------------------------------------------------
// validateGoals
// ---------------------------------------------------------------------------

/**
 * Validates a single goals document structure.
 *
 * @param {{topicSeed: string, goals: Array} | Array} input - Parsed object or bare goals array.
 * @returns {{ok: boolean, error?: string}}
 */
export function validateGoals(input) {
  // Normalize input to goals array
  let goals;
  if (Array.isArray(input)) {
    goals = input;
  } else if (input && typeof input === 'object' && Array.isArray(input.goals)) {
    goals = input.goals;
  } else {
    return { ok: false, error: 'Input must be a goals array or an object with a goals array.' };
  }

  // Rule: goals must be an array
  if (!Array.isArray(goals)) {
    return { ok: false, error: 'Goals must be an array.' };
  }

  // Rule: At least one ACTIVE goal
  const activeGoals = goals.filter(g => !g.tombstone);
  if (activeGoals.length === 0) {
    return { ok: false, error: 'There must be at least one active (non-tombstoned) goal.' };
  }

  // Rule: Unique IDs
  const ids = goals.map(g => g.id);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    return { ok: false, error: `Duplicate goal IDs found: ${[...new Set(duplicates)].join(', ')}` };
  }

  // Validate each goal
  const allowedSignals = ['test', 'command', 'artifact', 'docs'];

  for (const goal of goals) {
    // ID format
    if (!/^G\d+$/.test(goal.id)) {
      return { ok: false, error: `Goal ID "${goal.id}" must match format G<number>.` };
    }

    // Text non-empty
    if (typeof goal.text !== 'string' || goal.text.trim() === '') {
      return { ok: false, error: `Goal "${goal.id}" must have a non-empty text statement.` };
    }

    if (goal.tombstone) {
      // Tombstoned Goal Rules
      if (typeof goal.tombstone !== 'object') {
        return { ok: false, error: `Goal "${goal.id}" tombstone must be an object.` };
      }
      if (typeof goal.tombstone.reason !== 'string' || goal.tombstone.reason.trim() === '') {
        return { ok: false, error: `Goal "${goal.id}" tombstone must have a non-empty reason.` };
      }
      if (typeof goal.tombstone.amended_at !== 'string' || goal.tombstone.amended_at.trim() === '') {
        return { ok: false, error: `Goal "${goal.id}" tombstone must have a non-empty amended_at timestamp.` };
      }
      // Exempt from signal check
    } else {
      // Active Goal Rules
      const signal = goal.signal || '';
      if (!allowedSignals.includes(signal)) {
        return { ok: false, error: `Goal "${goal.id}" signal "${signal}" is invalid. Allowed classes: ${allowedSignals.join(', ')}.` };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// validateAmendment
// ---------------------------------------------------------------------------

/**
 * Validates an amendment from oldGoals to newGoals.
 *
 * @param {Array} oldGoals - The previous goals array.
 * @param {Array} newGoals - The new goals array.
 * @returns {{ok: boolean, error?: string}}
 */
export function validateAmendment(oldGoals, newGoals) {
  // First, validate the new document itself
  const newDocValidation = validateGoals(newGoals);
  if (!newDocValidation.ok) {
    return newDocValidation;
  }

  const oldIds = new Set(oldGoals.map(g => g.id));
  const newIds = new Set(newGoals.map(g => g.id));

  // Rule: Every old ID must still be present in newGoals (active or tombstoned)
  for (const id of oldIds) {
    if (!newIds.has(id)) {
      return { ok: false, error: `Goal "${id}" was removed. Removal must become a tombstone, not a deletion.` };
    }
  }

  // Rule: Renumbering rejected
  // Find max numeric ID in oldGoals
  const oldNumericIds = oldGoals.map(g => parseInt(g.id.replace('G', ''), 10));
  const maxOldNumericId = oldNumericIds.length > 0 ? Math.max(...oldNumericIds) : 0;

  for (const id of newIds) {
    if (!oldIds.has(id)) {
      // This is a brand-new goal
      const newNumericId = parseInt(id.replace('G', ''), 10);
      if (newNumericId <= maxOldNumericId) {
        return { ok: false, error: `Goal "${id}" is a new goal but its number (${newNumericId}) is not strictly greater than the max old number (${maxOldNumericId}). IDs must never be renumbered.` };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// crossCheckGoals
// ---------------------------------------------------------------------------

/**
 * Cross-checks goals from three sources: md, state, and events.
 *
 * @param {Array|object} a - First argument: either an array (positional) or an object with {mdGoals, stateGoals, eventGoals}.
 * @param {Array} [b] - Second argument: stateGoals (positional form).
 * @param {Array} [c] - Third argument: eventGoals (positional form).
 * @returns {{ok: boolean, error?: string}}
 */
export function crossCheckGoals(a, b, c) {
  let mdGoals, stateGoals, eventGoals;

  // Detect call form:
  // - If first arg is an array (or null/undefined) OR more than one argument was passed,
  //   treat the three arguments positionally as (mdGoals, stateGoals, eventGoals).
  // - Otherwise, destructure the first argument as {mdGoals, stateGoals, eventGoals}.
  if (arguments.length > 1 || Array.isArray(a) || a == null) {
    mdGoals = a;
    stateGoals = b;
    eventGoals = c;
  } else {
    mdGoals = a.mdGoals;
    stateGoals = a.stateGoals;
    eventGoals = a.eventGoals;
  }
  // Helper to canonicalize a goal
  const canonicalize = (goal) => {
    if (!goal) return null;
    return {
      id: goal.id,
      text: goal.text,
      signal: goal.signal || '',
      tombstone: goal.tombstone ? { reason: goal.tombstone.reason, amended_at: goal.tombstone.amended_at } : null
    };
  };

  // Helper to create an ID-keyed map
  const createMap = (goals) => {
    const map = new Map();
    if (Array.isArray(goals)) {
      for (const goal of goals) {
        const canon = canonicalize(goal);
        if (canon) {
          map.set(canon.id, canon);
        }
      }
    }
    return map;
  };

  const mdMap = createMap(mdGoals);
  const stateMap = createMap(stateGoals);
  const eventMap = createMap(eventGoals);

  // Collect all unique IDs
  const allIds = new Set([...mdMap.keys(), ...stateMap.keys(), ...eventMap.keys()]);

  for (const id of allIds) {
    const mdGoal = mdMap.get(id);
    const stateGoal = stateMap.get(id);
    const eventGoal = eventMap.get(id);

    // Check if ID exists in all maps
    const sourcesMissing = [];
    if (!mdGoal) sourcesMissing.push('md');
    if (!stateGoal) sourcesMissing.push('state');
    if (!eventGoal) sourcesMissing.push('event');

    if (sourcesMissing.length > 0) {
      return { ok: false, error: `Goal "${id}" is missing in: ${sourcesMissing.join(', ')}.` };
    }

    // Compare canonical shapes
    // JSON stringify for deep comparison
    const mdStr = JSON.stringify(mdGoal);
    const stateStr = JSON.stringify(stateGoal);
    const eventStr = JSON.stringify(eventGoal);

    const sourcesDiverging = [];
    if (mdStr !== stateStr) sourcesDiverging.push('md vs state');
    if (mdStr !== eventStr) sourcesDiverging.push('md vs event');
    if (stateStr !== eventStr) sourcesDiverging.push('state vs event');

    if (sourcesDiverging.length > 0) {
      return { ok: false, error: `Goal "${id}" diverges across sources: ${sourcesDiverging.join('; ')}.` };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// amendmentDiff
// ---------------------------------------------------------------------------

/**
 * Generates a diff of changes between old and new goals.
 *
 * @param {Array} oldGoals
 * @param {Array} newGoals
 * @returns {Array<{id: string, change: string, old: object|null, new: object|null}>}
 */
export function amendmentDiff(oldGoals, newGoals) {
  const changes = [];
  const oldMap = new Map(oldGoals.map(g => [g.id, g]));
  const newMap = new Map(newGoals.map(g => [g.id, g]));

  // Helper to extract text/signal
  const extract = (goal) => ({
    text: goal.text,
    signal: goal.signal || ''
  });

  // Process new goals
  for (const newGoal of newGoals) {
    const id = newGoal.id;
    const oldGoal = oldMap.get(id);

    if (!oldGoal) {
      // Added
      changes.push({
        id,
        change: 'added',
        old: null,
        new: extract(newGoal)
      });
    } else {
      // Exists in both
      const isTombstonedNew = !!newGoal.tombstone;
      const isTombstonedOld = !!oldGoal.tombstone;

      if (!isTombstonedOld && isTombstonedNew) {
        // Tombstoned
        changes.push({
          id,
          change: 'tombstoned',
          old: extract(oldGoal),
          new: extract(newGoal)
        });
      } else {
        // Check for modification
        const oldExtract = extract(oldGoal);
        const newExtract = extract(newGoal);
        
        if (oldExtract.text !== newExtract.text || oldExtract.signal !== newExtract.signal) {
          changes.push({
            id,
            change: 'modified',
            old: oldExtract,
            new: newExtract
          });
        }
        // Unchanged goals are omitted
      }
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// goalsHash — canonical identity of a goal set
// ---------------------------------------------------------------------------

/** Verdict enum for a per-goal assessment. Structurally blocks drift (G-D). */
export const GOAL_VERDICTS = ['achieved', 'partial', 'missed'];

function sha256Hex(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/**
 * Canonical hash of a goals document, keyed over the PARSED+canonicalized shape
 * (so incidental whitespace/formatting does not change identity, but any real
 * goal add/remove/tombstone/text/signal change does). Used to key goals_frozen /
 * goal_amended events and to re-arm the spec gate + split-brain checks.
 *
 * @param {string|{topicSeed:string, goals:Array}} goalsMdText - raw goals.md text OR a parsed object.
 * @returns {string} `sha256:<hex>`
 */
export function goalsHash(goalsMdText) {
  const parsed =
    goalsMdText && typeof goalsMdText === 'object' && Array.isArray(goalsMdText.goals)
      ? goalsMdText
      : parseGoals(typeof goalsMdText === 'string' ? goalsMdText : '');
  const canonGoals = (parsed.goals || [])
    .map((g) => ({
      id: g.id,
      text: typeof g.text === 'string' ? g.text.trim() : '',
      signal: g.signal || '',
      tombstone: g.tombstone
        ? { reason: g.tombstone.reason || '', amended_at: g.tombstone.amended_at || '' }
        : null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const canonical = JSON.stringify({ topicSeed: (parsed.topicSeed || '').trim(), goals: canonGoals });
  return `sha256:${sha256Hex(canonical)}`;
}

// ---------------------------------------------------------------------------
// waiverKey — re-arm tuple (goals hash + HEAD + base diff hash)
// ---------------------------------------------------------------------------

/**
 * Canonical waiver-key tuple. Any later commit (headSha change) OR amendment
 * (goalsHash change) OR diff change yields a different key, so a waiver keyed on
 * the old tuple no longer matches — this is what invalidates a stale waiver.
 *
 * @param {{goalsHash:string, headSha:string, baseDiffHash:string}} t
 * @returns {string|null} `"<goalsHash>|<headSha>|<baseDiffHash>"`, or null if any part missing.
 */
export function waiverKey({ goalsHash, headSha, baseDiffHash } = {}) {
  const parts = [goalsHash, headSha, baseDiffHash].map((x) => (typeof x === 'string' ? x : ''));
  if (parts.some((p) => p === '')) return null;
  return parts.join('|');
}

// ---------------------------------------------------------------------------
// validateUserApprovalReceipt — pure validator for a user-approval receipt
// ---------------------------------------------------------------------------

/**
 * Validates a user-approval receipt. Binds the EXACT goals hash (load/waive: the
 * current hash; amend: old+new), carries question/answer/ts, and rejects replay
 * against a different hash or a different purpose.
 *
 * @param {object} approval
 * @param {{goalsHash?:string, purpose?:string, oldGoalsHash?:string}} expected
 * @returns {{ok:boolean, error?:string, normalized?:object}}
 */
export function validateUserApprovalReceipt(approval, expected = {}) {
  const fail = (error) => ({ ok: false, error });
  if (!approval || typeof approval !== 'object' || Array.isArray(approval)) {
    return fail('approval receipt must be a JSON object');
  }
  const { goalsHash: gh, purpose, oldGoalsHash } = expected;
  if (approval.attested_by !== 'user') {
    return fail("approval.attested_by must be 'user'");
  }
  if (typeof approval.purpose !== 'string' || approval.purpose.trim() === '') {
    return fail('approval.purpose must be a non-empty string');
  }
  if (typeof purpose === 'string' && purpose !== '' && approval.purpose !== purpose) {
    return fail(
      `approval.purpose ${JSON.stringify(approval.purpose)} != expected ${JSON.stringify(purpose)} (replay/wrong-purpose)`
    );
  }
  if (typeof approval.goals_hash !== 'string' || approval.goals_hash.trim() === '') {
    return fail('approval.goals_hash must be a non-empty string');
  }
  if (typeof gh === 'string' && gh !== '' && approval.goals_hash !== gh) {
    return fail('approval.goals_hash does not bind the current goals hash (replay/stale approval)');
  }
  if (typeof oldGoalsHash === 'string' && oldGoalsHash !== '') {
    if (approval.old_goals_hash !== oldGoalsHash) {
      return fail('approval.old_goals_hash does not bind the prior goals hash (replay/stale amendment approval)');
    }
  }
  for (const k of ['question', 'answer', 'ts']) {
    if (typeof approval[k] !== 'string' || approval[k].trim() === '') {
      return fail(`approval.${k} must be a non-empty string`);
    }
  }
  return {
    ok: true,
    normalized: {
      attested_by: 'user',
      purpose: approval.purpose,
      goals_hash: approval.goals_hash,
      old_goals_hash: approval.old_goals_hash ?? null,
      question: approval.question,
      answer: approval.answer,
      ts: approval.ts,
    },
  };
}

// ---------------------------------------------------------------------------
// validateGoalCheckReceipt — anti-fabrication validator for record-goal-check
// ---------------------------------------------------------------------------

/**
 * Validates a goal-check receipt. Mirrors validateGateReceipt in lib/gate-review.mjs:
 * the receipt must echo the EXACT goals hash + HEAD SHA + base..HEAD diff hash the
 * guard recomputed, pin verify_output_hash (hash of the run_verify output the
 * assessor consumed) and the dispatch-time clean-worktree status, give a per-goal
 * verdict over EVERY non-tombstoned goal (valid enum + non-empty evidence), and
 * carry provenance in EXACTLY ONE of two shapes:
 *   - assessor:      dispatch_id + model + output_tokens(>0) + ts
 *   - user-attested: {attested_by:'user', approval_receipt} binding the full tuple
 *                    (never accepted silently — returned as provenance_kind:'user').
 * Rejects missing/unknown/stale/fabricated receipts.
 *
 * @param {object} receipt
 * @param {{goalsHash:string, headSha:string, baseDiffHash:string, verifyOutputHash?:string, clean?:boolean, goals?:Array}} expected
 * @returns {{ok:boolean, error?:string, provenance_kind?:string, normalized?:object}}
 */
export function validateGoalCheckReceipt(receipt, expected = {}) {
  const fail = (error) => ({ ok: false, error });
  const { goalsHash: gh, headSha, baseDiffHash, verifyOutputHash, clean, goals } = expected;
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return fail('receipt must be a JSON object');
  }

  // 1. Full tuple binding (stale goals / later commit / changed diff all re-arm).
  if (receipt.goals_hash !== gh) {
    return fail('receipt.goals_hash does not echo the current goals hash (stale/amended goals — re-run the goal check)');
  }
  if (receipt.head_sha !== headSha) {
    return fail('receipt.head_sha does not echo the current HEAD (a later commit — re-run the goal check)');
  }
  if (receipt.base_diff_hash !== baseDiffHash) {
    return fail('receipt.base_diff_hash does not echo the recomputed base..HEAD diff hash (stale/changed diff — re-run the goal check)');
  }

  // 2. verify_output_hash (plan-review finding 3) — pin the run_verify output the assessor consumed.
  if (typeof receipt.verify_output_hash !== 'string' || receipt.verify_output_hash.trim() === '') {
    return fail('receipt.verify_output_hash must be a non-empty string (hash of the run_verify output the assessor consumed)');
  }
  if (typeof verifyOutputHash === 'string' && receipt.verify_output_hash !== verifyOutputHash) {
    return fail('receipt.verify_output_hash does not match the run_verify output hash the recorder recomputed');
  }

  // 3. Dispatch-time clean-worktree status.
  if (receipt.clean !== true) {
    return fail('receipt.clean must be true — the assessor must have run against a clean worktree');
  }
  if (typeof clean === 'boolean' && receipt.clean !== clean) {
    return fail('receipt.clean does not match the dispatch-time clean status the recorder recomputed');
  }

  // 4. Per-goal verdicts over every non-tombstoned goal.
  const activeGoals = Array.isArray(goals) ? goals.filter((g) => g && !g.tombstone) : [];
  const verdicts = receipt.verdicts;
  if (!verdicts || typeof verdicts !== 'object' || Array.isArray(verdicts)) {
    return fail('receipt.verdicts must be an object keyed by goal id');
  }
  for (const g of activeGoals) {
    const v = verdicts[g.id];
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return fail(`receipt.verdicts is missing goal "${g.id}"`);
    }
    if (!GOAL_VERDICTS.includes(v.verdict)) {
      return fail(`receipt.verdicts["${g.id}"].verdict ${JSON.stringify(v.verdict)} is not one of ${GOAL_VERDICTS.join('/')}`);
    }
    if (typeof v.evidence !== 'string' || v.evidence.trim() === '') {
      return fail(`receipt.verdicts["${g.id}"].evidence must be a non-empty string`);
    }
  }
  for (const id of Object.keys(verdicts)) {
    if (!activeGoals.some((g) => g.id === id)) {
      return fail(`receipt.verdicts contains unknown goal "${id}" (fabricated verdict)`);
    }
  }

  // 5. Provenance — EXACTLY ONE of two shapes.
  if (typeof receipt.ts !== 'string' || receipt.ts.trim() === '') {
    return fail('receipt.ts must be a non-empty string');
  }
  let provenance_kind;
  if (receipt.attested_by === 'user') {
    provenance_kind = 'user';
    const ar = validateUserApprovalReceipt(receipt.approval_receipt, { goalsHash: gh, purpose: 'goal_check' });
    if (!ar.ok) {
      return fail(`user-attested goal check requires a valid approval_receipt: ${ar.error}`);
    }
  } else {
    provenance_kind = 'assessor';
    for (const k of ['dispatch_id', 'model']) {
      if (typeof receipt[k] !== 'string' || receipt[k].trim() === '') {
        return fail(`receipt.${k} must be a non-empty string (assessor provenance)`);
      }
    }
    const tokens = receipt.output_tokens ?? receipt.completion_tokens ?? receipt.tokens;
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
      return fail('receipt.output_tokens (assessor provenance) must be a finite number > 0');
    }
  }

  return {
    ok: true,
    provenance_kind,
    normalized: {
      goals_hash: gh,
      head_sha: headSha,
      base_diff_hash: baseDiffHash,
      verify_output_hash: receipt.verify_output_hash,
      clean: true,
      verdicts,
      provenance_kind,
      ts: receipt.ts,
    },
  };
}

// ---------------------------------------------------------------------------
// validateGoalWaiver — goal_waived event schema + pure validator
// ---------------------------------------------------------------------------

/**
 * Validates a goal_waived event/record. Keyed to the FULL check tuple
 * (goals hash + HEAD + base + diff hash): a per-goal reason for each waived goal
 * plus a user-approval receipt binding the same tuple. Any later commit or
 * amendment moves the tuple, so a stale/replayed waiver is rejected.
 *
 * @param {object} waiver
 * @param {{goalsHash:string, headSha:string, base:string, diffHash:string, goals?:Array}} expected
 * @returns {{ok:boolean, error?:string, normalized?:object}}
 */
export function validateGoalWaiver(waiver, expected = {}) {
  const fail = (error) => ({ ok: false, error });
  const { goalsHash: gh, headSha, base, diffHash, goals } = expected;
  if (!waiver || typeof waiver !== 'object' || Array.isArray(waiver)) {
    return fail('waiver must be a JSON object');
  }
  if (waiver.goals_hash !== gh) {
    return fail('waiver.goals_hash does not bind the current goals hash (stale/replayed waiver — amendment invalidates it)');
  }
  if (waiver.head_sha !== headSha) {
    return fail('waiver.head_sha does not bind the current HEAD (a later commit invalidates the waiver)');
  }
  if (waiver.base !== base) {
    return fail('waiver.base does not bind the current base ref (stale/replayed waiver)');
  }
  if (waiver.diff_hash !== diffHash) {
    return fail('waiver.diff_hash does not bind the recomputed base..HEAD diff hash (stale/replayed waiver)');
  }
  const reasons = waiver.reasons;
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) {
    return fail('waiver.reasons must be an object keyed by goal id');
  }
  const waivedIds = Object.keys(reasons);
  if (waivedIds.length === 0) {
    return fail('waiver.reasons must waive at least one goal');
  }
  const validIds = new Set(Array.isArray(goals) ? goals.map((g) => g && g.id) : []);
  for (const id of waivedIds) {
    if (Array.isArray(goals) && !validIds.has(id)) {
      return fail(`waiver.reasons references unknown goal "${id}"`);
    }
    if (typeof reasons[id] !== 'string' || reasons[id].trim() === '') {
      return fail(`waiver.reasons["${id}"] must be a non-empty reason string`);
    }
  }
  const ar = validateUserApprovalReceipt(waiver.approval, { goalsHash: gh, purpose: 'goal_waive' });
  if (!ar.ok) {
    return fail(`waiver requires a valid user approval receipt: ${ar.error}`);
  }
  return {
    ok: true,
    normalized: {
      goals_hash: gh,
      head_sha: headSha,
      base,
      diff_hash: diffHash,
      reasons,
      key: waiverKey({ goalsHash: gh, headSha, baseDiffHash: diffHash }),
    },
  };
}
