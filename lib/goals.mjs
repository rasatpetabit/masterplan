/**
 * lib/goals.mjs — Pure Goal Tracking Core
 *
 * This module provides the pure parse, validate, cross-check, and diff logic
 * for the masterplan goal tracking system. It mirrors the purity of lib/gate-review.mjs.
 *
 * CONSTRAINTS:
 * - NO fs, NO process, NO clock, NO imports.
 * - Only pure functions operating on strings/objects.
 * - All file/git reads live in the bin layer (CD-7).
 *
 * ARCHITECTURE:
 * - parseGoals / validateGoals: Validate a SINGLE goals.md document.
 * - validateAmendment: Requires the OLD goal set to enforce renumbering/removal-vs-tombstone rules.
 * - crossCheckGoals: Pure derived-cache cross-check between md, state, and event logs.
 * - amendmentDiff: Pure helper to generate change records for goal_amended events.
 *
 * EXPORTS:
 * - parseGoals
 * - validateGoals
 * - validateAmendment
 * - crossCheckGoals
 * - amendmentDiff
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
