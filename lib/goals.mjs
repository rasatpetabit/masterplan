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
 * - Header (block form): `topic: |` collects VERBATIM to the first goal heading, keeping
 *   interior blank lines and relative indentation. Used to anchor the run to the user's
 *   original request in full; the bare form above truncates at the first blank line and
 *   flattens indentation, which silently loses most of a multi-paragraph ask.
 * - Goals: Sections starting with `## G<number>: <statement>`.
 * - Keys: `signal:`, `evidence:`, `tombstone_reason:`, `tombstone_at:`.
 *
 * @param {string} goalsMdText - The raw content of goals.md.
 * @returns {{topicSeed: string, goals: Array<{id: string, text: string, signal: string, tombstone?: object}>}}
 */
export function parseGoals(goalsMdText, opts = {}) {
  // `legacy: true` disables the block form, reproducing the pre-block parser exactly. Used only
  // by legacyGoalsHash() to detect a bundle whose stored hash predates the block form.
  const legacy = opts.legacy === true;
  // `preCodeMask: true` reproduces the parser as it read documents BEFORE code masking and the
  // H1 Intent boundary existed. Used only by preCodeMaskGoalsHash() to detect a bundle whose
  // stored hash predates that change; never by a live parse.
  const preCodeMask = opts.preCodeMask === true;
  if (typeof goalsMdText !== 'string') {
    return { topicSeed: '', goals: [] };
  }

  // Complete line terminators, so a CRLF document does not leave a CR on every captured line.
  const lines = goalsMdText.split(/\r\n|\n|\r/);
  // Code is not content. A goals document may quote markdown as an EXAMPLE — an `outcome:`
  // inside a fence is a sample, not the run's intent — and reading one as content would let an
  // example become the bar the finish measures against. Masking here, with the SAME mask every
  // other reader of this document uses, is what stops the parse and any quotation of it from
  // describing different documents.
  const isCode = preCodeMask ? new Array(lines.length).fill(false) : codeLineMask(lines);
  const topicSeedLines = [];
  let collectingTopic = false;
  const goals = [];
  let currentGoal = null;
  let intent = null;
  let intentOutcomeLine = null;
  let collectingIntent = false;

  for (let i = 0; i < lines.length; i++) {
    if (isCode[i]) continue;
    const line = lines[i];
    const trimmedLine = line.trim();

    // 1. Start collecting topic seed
    if (currentGoal === null && goals.length === 0 && /^topic:/i.test(trimmedLine)) {
      const afterTopic = trimmedLine.replace(/^topic:/i, '').trim();

      // Block form `topic: |` — collect verbatim to the first goal heading. Opt-in on an
      // exact `|` precisely so the bare form below keeps byte-identical semantics: every
      // pre-existing bundle parses the same and its goalsHash — which canonicalizes
      // topicSeed — does not move, so no in-flight goal_check/goal_waived receipt is voided.
      if (afterTopic === '|' && !legacy) {
        // Terminate only on an UNINDENTED goal heading (no .trim() here). A real `## G1:` is a
        // markdown H2 and always sits at column 0; an indented one is quoted prose inside the
        // request. Trimming first would let `  ## G1: for example` truncate the anchor AND leak
        // a phantom goal into the outer parser — corrupting the very thing this block protects.
        let j = i + 1;
        for (; j < lines.length && !/^##\s+(G\d+:|Intent\s*$)/i.test(lines[j]); j++) { /* scan */ } // v2: an unindented `## Intent` heading also ends the anchor
        topicSeedLines.push(...dedentBlock(lines.slice(i + 1, j)));
        i = j - 1; // resume on the goal heading (the loop's i++ steps onto it)
        continue;
      }

      collectingTopic = true;
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

    // 2.5 Intent section
    if (collectingIntent) {
      // Stop collecting when we hit any new heading. An H1 ends the block as surely as an H2:
      // content under a later `# Notes` is outside the Intent section, and reading it as an
      // intent field would attribute someone's prose to the run's declared outcome.
      if ((preCodeMask ? /^##\s+/i : /^#{1,2}\s+/i).test(trimmedLine)) {
        collectingIntent = false;
        // fall through to the normal heading handling below
      } else {
        // Parse intent lines
        const intentKv = trimmedLine.match(/^(\w+):\s*(.*)$/);
        if (intentKv) {
          const key = intentKv[1];
          const value = intentKv[2].trim();
          if (key === 'why') {
            intent.why = value;
          } else if (key === 'outcome') {
            intent.outcome = value;
            // The RAW source line beside the parsed value. Anything that wants to quote the
            // operator's own words takes it from here rather than re-scanning the document:
            // a second scanner is a second set of lexical rules, and the two drift silently.
            // Assignment order gives last-wins within the block, exactly like `outcome` itself.
            // It rides OUTSIDE `intent` so that object's shape — which callers deep-compare and
            // the goals hash is keyed over — is unchanged.
            intentOutcomeLine = line;
          } else if (key === 'done_means') {
            intent.done_means = value;
          }
          // anti_goals: line has no value; we ignore it here
        } else if (trimmedLine.startsWith('- ')) {
          intent.anti_goals.push(trimmedLine.slice(2).trim());
        }
        continue;
      }
    }

    // 3. Intent heading
    if (/^##\s+Intent\s*$/i.test(trimmedLine)) {
      collectingIntent = true;
      intent = { why: '', outcome: '', anti_goals: [], done_means: '' };
      intentOutcomeLine = null; // a new Intent block starts with no outcome of its own
      continue;
    }

    // 4. Goal heading
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

    // 5. Key/value
    if (currentGoal) {
      const kvMatch = trimmedLine.match(/^(\w+):\s*(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim();

        if (key === 'signal') {
          currentGoal.signal = value;
        } else if (key === 'evidence') {
          // Captured, not dropped: goalsHash covers it. `evidence` is what actually
          // PROVES a goal met, so leaving it outside goal identity let an acceptance
          // criterion be rewritten or weakened while every goal_check receipt, waiver
          // and spec-gate arming stayed valid against the old, stricter bar.
          currentGoal.evidence = value;
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
        // unknown keys are ignored
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

  const version = intent ? 2 : 1;
  return { topicSeed, goals: cleanedGoals, intent, intentOutcomeLine, version };
}

/**
 * Strips surrounding blank lines from a `topic: |` block and removes its common indent, so
 * the seed is the user's text rather than an artifact of how deeply the block sat in
 * goals.md. Interior blank lines survive — they are what the bare form loses.
 *
 * @param {string[]} rawLines - Block body, verbatim.
 * @returns {string[]} Dedented lines.
 */
function dedentBlock(rawLines) {
  // Drop the CR of a CRLF file. The bare form gets this free via trim(); without it the same
  // anchor text would hash differently depending on the line endings goals.md happens to use.
  rawLines = rawLines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));

  let start = 0;
  let end = rawLines.length;
  while (start < end && rawLines[start].trim() === '') start++;
  while (end > start && rawLines[end - 1].trim() === '') end--;
  const body = rawLines.slice(start, end);
  if (body.length === 0) return [];

  let indent = Infinity;
  for (const line of body) {
    if (line.trim() === '') continue; // blank lines must not drag the common indent to 0
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (!Number.isFinite(indent)) indent = 0;

  return body.map((line) => (line.trim() === '' ? '' : line.slice(indent)));
}

/**
 * The hash this document would have had under the pre-block-form parser, or null if the block
 * form is not in use (in which case the two parsers agree and there is nothing to detect).
 *
 * `topic: |` was ALREADY valid input before the block form existed: the old parser treated `|`
 * as ordinary seed text, yielding a seed beginning with "|". So any bundle that happened to use
 * that spelling parses differently now, moving its goalsHash and breaking every goal_check /
 * goal_waived receipt keyed to it. Committed bundles were checked and none are affected, but
 * in-flight bundles cannot be enumerated — hence this detector, so callers can fail loudly with
 * a migration path instead of silently re-hashing someone's frozen goals.
 *
 * @param {string} goalsMdText
 * @returns {string|null} legacy hash, or null when the block form is absent
 */
export function legacyGoalsHash(goalsMdText) {
  if (typeof goalsMdText !== 'string') return null;
  if (!/^\s*topic:\s*\|\s*$/im.test(goalsMdText)) return null;
  return goalsHash(parseGoals(goalsMdText, { legacy: true }));
}

/**
 * The hash this document had under the PRE-CODE-MASK parser, or null when the two agree.
 *
 * Masking code and ending the Intent block at an H1 are corrections, but they are also a
 * normalization change: a goals.md that quotes markdown in a fence parsed differently before,
 * so re-deriving its hash now would silently void every goal_check and goal_waived receipt
 * keyed to the stored one. This is the same hazard `legacyGoalsHash` guards for the `topic: |`
 * block form, and it is detected the same way — by parsing BOTH ways and comparing.
 *
 * Returns null when the document hashes identically under both parsers, which is the case for
 * every goals.md that does not quote parser-looking text.
 */
export function preCodeMaskGoalsHash(goalsMdText) {
  if (typeof goalsMdText !== 'string') return null;
  const before = goalsHash(parseGoals(goalsMdText, { preCodeMask: true }));
  return before === goalsHash(parseGoals(goalsMdText)) ? null : before;
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

  // v2 intent validation (only when intent is present)
  const intent = input && input.intent;
  if (intent) {
    const problems = [];
    if (typeof intent.why !== 'string' || intent.why.trim() === '') {
      problems.push('Intent.why must be a non-empty string');
    }
    if (typeof intent.outcome !== 'string' || intent.outcome.trim() === '') {
      problems.push('Intent.outcome must be a non-empty string');
    }
    if (typeof intent.done_means !== 'string' || intent.done_means.trim() === '') {
      problems.push('Intent.done_means must be a non-empty string');
    }
    if (!Array.isArray(intent.anti_goals) || intent.anti_goals.some((x) => typeof x !== 'string')) {
      problems.push('Intent.anti_goals must be a list of strings');
    }
    if (goals.length < 3 || goals.length > 5) {
      problems.push(`v2 goals.md must declare 3 to 5 outcome goals (found ${goals.length})`);
    }
    if (problems.length > 0) {
      return { ok: false, error: problems.join('; ') };
    }
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
      // v2 (Intent block present): signal/evidence are optional — an absent signal is fine, an
      // invalid non-empty one is still rejected. v1 keeps requiring a signal class.
      if (!(intent && signal === '') && !allowedSignals.includes(signal)) {
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
 * @param {Array|{topicSeed: string, goals: Array}} oldGoals - The previous goals.
 * @param {Array|{topicSeed: string, goals: Array}} newGoals - The new goals.
 * @param {{anchorSeed?: string}} [opts] - `anchorSeed` is the event-backed original topic seed
 *   (from the `anchor_captured` event). When supplied, the amendment is checked against IT
 *   rather than against the previous document, so the anchor cannot be walked away from one
 *   amendment at a time. Omit it and the previous document's seed is used instead.
 * @returns {{ok: boolean, error?: string}}
 */
export function validateAmendment(oldGoals, newGoals, opts = {}) {
  // First, validate the new document itself
  const newDocValidation = validateGoals(newGoals);
  if (!newDocValidation.ok) {
    return newDocValidation;
  }

  // Callers pass either a bare array or a parsed {topicSeed, goals} document.
  const seedOf = (doc) => (Array.isArray(doc) || !doc ? undefined : doc.topicSeed);
  const goalsOf = (doc) => (Array.isArray(doc) ? doc : (doc?.goals ?? []));

  // Rule: the anchor is immutable. It is the run's record of what was originally asked for,
  // so the loop that reshapes goals must not be able to reshape the thing it is judged against.
  const newSeed = seedOf(newGoals);
  const expectedSeed = opts.anchorSeed ?? seedOf(oldGoals);
  if (typeof newSeed === 'string' && typeof expectedSeed === 'string' && newSeed !== expectedSeed) {
    return {
      ok: false,
      error: 'The topic seed (the original request this run is anchored to) changed. It is immutable: '
        + 'amendments may add or tombstone goals, never restate the ask. If the request genuinely '
        + 'changed, start a new run or record an approved re-anchor.',
    };
  }

  // Intent change detection: an amended intent is a real change that must re-arm the spec gate.
  const normalizeIntent = (doc) => {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
    const i = doc.intent;
    if (!i) return null;
    return { why: i.why, outcome: i.outcome, anti_goals: i.anti_goals, done_means: i.done_means };
  };
  const intentChanged = JSON.stringify(normalizeIntent(oldGoals)) !== JSON.stringify(normalizeIntent(newGoals));

  oldGoals = goalsOf(oldGoals);
  newGoals = goalsOf(newGoals);

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

  return intentChanged ? { ok: true, changed: true, reason: 'intent amended' } : { ok: true };
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

// The final assessment's answer to "does this do what you meant?" (§6.2). Distinct
// from GOAL_VERDICTS: goals are judged individually, intent as a whole.
export const INTENT_VERDICTS = ['met', 'partial', 'missed'];

function sha256Hex(str) {
  return createHash('sha256').update(String(str), 'utf8').digest('hex');
}

/**
 * Canonical hash of a goals document, keyed over the PARSED+canonicalized shape
 * (so incidental whitespace/formatting does not change identity, but any real
 * goal add/remove/tombstone/text/signal/EVIDENCE change does). Used to key
 * goals_frozen / goal_amended events and to re-arm the spec gate + split-brain checks.
 *
 * `evidence` is inside the hash as of 2026-08-05. It was excluded, which meant the
 * hash keying every goal_check receipt, every waiver and the spec-gate re-arm was
 * blind to changes in the criteria that actually PROVE a goal met — an acceptance
 * bar could be rewritten or weakened with every receipt staying valid. Caught by a
 * cross-vendor adversarial review of the dispatch-consolidation bundle, and
 * reproduced there: amending a goal from "true" to "NOT MET" returned `idempotent`
 * with an unchanged hash and no goal_amended event.
 *
 * BREAKING: including evidence advances the hash for every existing bundle, so
 * goal_check receipts and waivers issued under the old hash no longer validate.
 * That is the intended consequence — they were issued against criteria that could
 * since have changed without trace, so they were never safe to honour.
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
      evidence: typeof g.evidence === 'string' ? g.evidence.trim() : '',
      tombstone: g.tombstone
        ? { reason: g.tombstone.reason || '', amended_at: g.tombstone.amended_at || '' }
        : null,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  let canonical = JSON.stringify({ topicSeed: (parsed.topicSeed || '').trim(), goals: canonGoals });
  if (parsed.intent) {
    canonical += `\nintent.why=${parsed.intent.why || ''}`;
    canonical += `\nintent.outcome=${parsed.intent.outcome || ''}`;
    canonical += `\nintent.anti_goals=${Array.isArray(parsed.intent.anti_goals) ? parsed.intent.anti_goals.join('\n') : ''}`;
    canonical += `\nintent.done_means=${parsed.intent.done_means || ''}`;
  }
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
  const {
    goalsHash: gh, headSha, baseDiffHash, verifyOutputHash, clean, goals,
    // Final-assessment bindings (§6.2). Absent for the implementation assessment
    // and for v1 receipts, whose shapes are unchanged.
    final, deployBaseSha, deployChainHash, liveCheckDigest,
  } = expected;
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

  // 4b. Final-assessment bindings. The assessor runs twice; only the final run —
  //     after the live check, over the deployed base — carries the deploy tuple and
  //     the intent verdict. Both directions are enforced: a final receipt must bind
  //     all three and return a verdict, and an implementation/v1 receipt must NOT
  //     return an intent verdict, which would be a fabricated post-live judgement.
  if (final === true) {
    const bindings = [
      ['deploy_base_sha', deployBaseSha],
      ['deploy_chain_hash', deployChainHash],
      ['live_check_digest', liveCheckDigest],
    ];
    // The recorder supplies what the receipt must echo. An unbound expectation is a
    // WIRING defect, not a receipt defect: accepting the caller's own value here would
    // let the assessor's claim validate itself.
    const unbound = bindings.filter(([, want]) => typeof want !== 'string' || want.trim() === '').map(([k]) => k);
    if (unbound.length) {
      return fail(`final goal check is unbound: the recorder supplied no ${unbound.join(', ')} for the receipt to echo (finish must bind these, never accept caller-provided values)`);
    }
    for (const [key, want] of bindings) {
      if (typeof receipt[key] !== 'string' || receipt[key].trim() === '') {
        return fail(`receipt.${key} must be a non-empty string on a final assessment`);
      }
      if (receipt[key] !== want) {
        return fail(`receipt.${key} does not echo the ${key} the recorder bound (stale or foreign final assessment — re-run the final check)`);
      }
    }
    const iv = receipt.intent_verdict;
    if (!iv || typeof iv !== 'object' || Array.isArray(iv)) {
      return fail('receipt.intent_verdict must be an object on a final assessment');
    }
    if (!INTENT_VERDICTS.includes(iv.verdict)) {
      return fail(`receipt.intent_verdict.verdict ${JSON.stringify(iv.verdict)} is not one of ${INTENT_VERDICTS.join('/')}`);
    }
    if (typeof iv.evidence !== 'string' || iv.evidence.trim() === '') {
      return fail('receipt.intent_verdict.evidence must be a non-empty string');
    }
  } else if (receipt.intent_verdict !== undefined) {
    return fail('receipt.intent_verdict is returned only by the final assessment — an implementation assessment carrying one is fabricated');
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
      ...(final === true ? {
        final: true,
        deploy_base_sha: deployBaseSha,
        deploy_chain_hash: deployChainHash,
        live_check_digest: liveCheckDigest,
        intent_verdict: receipt.intent_verdict,
      } : {}),
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

// ---------------------------------------------------------------------------
// goals-load gate: interview exit + Assumptions-table coverage (§5.4, §11, N15)
// ---------------------------------------------------------------------------

/**
 * The only interview exits a goals-load may proceed from. `waived` is admitted
 * only as a DURABLE exit (an `interview_waived` event in the ledger) — a caller
 * asserting a waiver it cannot show is refused like an open interview.
 */
export const INTERVIEW_EXITS = ['converged', 'exhausted', 'critic_off', 'waived'];

/**
 * Validates the interview terminal state a goals-load is proceeding from.
 *
 * The caller supplies the bundle replay (`replayInterview`'s result, or any
 * object carrying the same three fields) rather than a state path, so this stays
 * a pure function over already-derived facts and the CLI owns the file read.
 *
 * @param {{terminal:?string, terminalReason:?string, reopened?:boolean, events?:Array}} replay
 * @returns {{ok:boolean, exit?:string, error?:string, code?:string}}
 */
export function validateInterviewExit(replay) {
  const fail = (code, error) => ({ ok: false, code, error });
  if (!replay || typeof replay !== 'object' || Array.isArray(replay)) {
    return fail('interview_replay_invalid', 'interview replay must be an object (pass replayInterview()\'s result)');
  }
  // A reopen is refused whatever else the replay claims. In a real replay an `interview_end`
  // after the reopen clears this flag, so the two cannot both be set — but this is a pure
  // function over caller-supplied facts, and trusting `terminal` over `reopened` would let a
  // reopened interview load goals.
  if (replay.reopened === true) {
    return fail('interview_reopened', `the interview was reopened${replay.terminal ? ` (and claims terminal ${JSON.stringify(replay.terminal)})` : ''} — end or waive it again before loading goals`);
  }
  const exit = replay.terminal;
  if (!exit) {
    return fail('interview_open', 'the interview is still open — end it (converged/exhausted/critic_off) or waive it before loading goals');
  }
  if (!INTERVIEW_EXITS.includes(exit)) {
    return fail('interview_exit_invalid', `interview exit ${JSON.stringify(exit)} is not one of ${INTERVIEW_EXITS.join('/')}`);
  }
  if (exit === 'waived') {
    // Durability is what separates a waiver from a claim, so the ledger must be BOTH readable
    // and carrying the event. An absent or malformed event list is not evidence of a waiver —
    // treating it as "nothing to check" would make the durability requirement opt-out.
    if (!Array.isArray(replay.events)) {
      return fail('interview_waiver_not_durable', 'a waived exit requires the ledger events to check for a durable interview_waived event; none were supplied');
    }
    if (!replay.events.some((e) => e && e.type === 'interview_waived')) {
      return fail('interview_waiver_not_durable', 'a waived exit requires a durable interview_waived event in the ledger');
    }
  }
  return { ok: true, exit, reason: replay.terminalReason ?? null };
}

const ASSUMPTIONS_HEADING = /^#{1,6}\s+.*\bassumptions\b/i;
const MD_HEADING = /^#{1,6}\s+/;

const DELIMITER_CELL = /^:?-{2,}:?$/;
// Markdown indentation is measured in COLUMNS, and a tab advances to the next 4-column stop.
// Counting characters instead lets a single leading tab — four columns, an indented code block
// by Markdown's own rule — read as one character of whitespace, so a tab-indented example
// stays "content" and can be quoted back as the run's declared outcome.
function indentColumns(line) {
  let col = 0;
  for (const ch of String(line)) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else return col;
  }
  return col; // a blank line: never code on its own
}

/**
 * Which lines of a markdown document are CODE rather than content.
 *
 * Code is not content: a fenced or indented block may quote markdown as an EXAMPLE — this
 * project's own documents quote markdown in several places — and Markdown renders that as
 * code. Reading an example as content lets it satisfy a gate, or lets a sample `outcome:` be
 * quoted as the run's actual intent.
 *
 * Exported so every reader of a goals or spec document masks code the SAME way. Two
 * hand-maintained scanners drift, and the drift is invisible until one of them quotes an
 * example back to the operator as though it were the real thing.
 *
 * @param {string[]} lines
 * @returns {boolean[]} parallel to `lines`; true where the line is inside a code block
 */
export function codeLineMask(lines) {
  // Literal spaces only: `\s` also matches a TAB, and a tab is a full indentation step, so a
  // tab-indented fence marker is code rather than a fence opener.
  const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  const isCode = new Array(lines.length).fill(false);
  // The OPEN fence's marker character and length, both of which matter: a fence closes only on
  // the same character, at least as long, with nothing but whitespace after it. Collapsing
  // every fence to three backticks lets a ```text line inside a ````markdown block read as the
  // closer — and everything after it, examples included, stops being masked.
  let open = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = FENCE.exec(lines[i]);
    if (open) {
      isCode[i] = true; // the closing fence line is itself code
      if (m && m[1][0] === open.char && m[1].length >= open.len && m[2].trim() === '') open = null;
      continue;
    }
    if (m) { open = { char: m[1][0], len: m[1].length }; isCode[i] = true; continue; }
    if (indentColumns(lines[i]) >= 4) isCode[i] = true; // indented code block
  }
  return isCode;
}


/**
 * Collects the row ids of the spec's Assumptions table: the first cell of each data
 * row of the FIRST real Markdown table under the first `Assumptions` heading.
 *
 * "Real table" is load-bearing. Collecting any pipe-prefixed line would let a mention
 * in prose, or a row of some unrelated later table in the same section, satisfy the
 * coverage `validateAssumptionsCoverage` exists to enforce — so a header row followed
 * by a delimiter row must be found, and collection stops where that table ends.
 *
 * @param {string} specText
 * @returns {Set<string>}
 */
export function specAssumptionIds(specText) {
  const ids = new Set();
  if (typeof specText !== 'string') return ids;
  const lines = specText.split(/\r?\n/);
  const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const isPipeRow = (line) => line.trim().startsWith('|');
  const isDelimiterRow = (line) => {
    const cells = cellsOf(line);
    return cells.length > 0 && cells.every((c) => DELIMITER_CELL.test(c));
  };
  const isCode = codeLineMask(lines);

  let inSection = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (isCode[i]) continue;
    if (MD_HEADING.test(line)) {
      // A later heading ends the section; only the FIRST Assumptions heading opens one.
      if (inSection) break;
      if (ASSUMPTIONS_HEADING.test(line)) inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (!isPipeRow(line) || isDelimiterRow(line)) continue;
    const next = lines[i + 1];
    if (next === undefined || isCode[i + 1] || !isPipeRow(next) || !isDelimiterRow(next)) continue; // not a table header
    for (let j = i + 2; j < lines.length; j += 1) {
      const rowLine = lines[j];
      if (isCode[j] || !isPipeRow(rowLine) || isDelimiterRow(rowLine)) break; // the table ended
      // Strip markdown emphasis/code fences a hand-edited table may carry.
      const id = (cellsOf(rowLine)[0] ?? '').replace(/[`*_]/g, '').trim();
      if (id) ids.add(id);
    }
    break; // the first table under the heading is THE Assumptions table
  }
  return ids;
}

/**
 * The ids an `interview_end` event owes the Assumptions table. `unknowns` are
 * `{id, ...}` objects; `misclassified` is a list of ids; `contradictions` has
 * carried both shapes, so both are accepted and anything without an id is
 * reported rather than silently dropped.
 *
 * @param {object} endEvent
 * @returns {{ids:string[], unidentified:number}}
 */
export function assumedIdsFromEnd(endEvent) {
  const ids = [];
  let unidentified = 0;
  for (const key of ['unknowns', 'contradictions', 'misclassified']) {
    const list = endEvent && Array.isArray(endEvent[key]) ? endEvent[key] : [];
    for (const item of list) {
      const id = typeof item === 'string' ? item : (item && typeof item === 'object' ? item.id : null);
      if (typeof id === 'string' && id.trim() !== '') ids.push(id.trim());
      else unidentified += 1;
    }
  }
  return { ids: [...new Set(ids)], unidentified };
}

/**
 * Refuses (`assumed_row_missing`) when any id an `exhausted` interview_end event
 * lists has no row in the spec's Assumptions table. The event stays the durable
 * record of all three lists, so a lagging table is caught rather than lost (§5.4).
 *
 * Exits other than `exhausted` owe no rows and pass trivially.
 *
 * @param {{endEvent:?object, specText:?string, exit?:string}} input
 * @returns {{ok:boolean, error?:string, code?:string, missing?:string[], required?:string[]}}
 */
export function validateAssumptionsCoverage({ endEvent, specText, exit } = {}) {
  const fail = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });
  const reason = exit ?? (endEvent && endEvent.reason);
  if (reason !== 'exhausted') return { ok: true, required: [], missing: [] };
  if (!endEvent || typeof endEvent !== 'object' || Array.isArray(endEvent)) {
    return fail('interview_end_missing', 'an exhausted exit requires its interview_end event to check the Assumptions table against');
  }
  const { ids, unidentified } = assumedIdsFromEnd(endEvent);
  if (unidentified > 0) {
    return fail('assumed_id_missing', `the interview_end event lists ${unidentified} unresolved item(s) with no id — every unknown/contradiction/misclassified entry needs an id to be checkable against the Assumptions table`);
  }
  if (ids.length === 0) return { ok: true, required: [], missing: [] };
  if (typeof specText !== 'string' || specText.trim() === '') {
    return fail('spec_unreadable', 'the spec text is required to check the Assumptions table for an exhausted exit', { required: ids });
  }
  const present = specAssumptionIds(specText);
  const missing = ids.filter((id) => !present.has(id));
  if (missing.length) {
    return fail(
      'assumed_row_missing',
      `the exhausted interview owes an Assumptions row for ${missing.join(', ')} — every remaining unknown, contradiction and misclassified entry is written as an assumed row before the design is presented`,
      { required: ids, missing },
    );
  }
  return { ok: true, required: ids, missing: [] };
}

/**
 * The whole goals-load gate: a permitted interview exit, and — on `exhausted` —
 * an Assumptions table that covers every id the terminal event listed.
 *
 * The terminal event is taken from the replay's own ledger and cannot be supplied by the
 * caller: an explicit event would let a stale or emptied one mask ids the durable event lists,
 * which is precisely the coverage this gate exists to enforce.
 *
 * @param {{replay:object, specText?:string}} input
 * @returns {{ok:boolean, error?:string, code?:string, exit?:string, assumed?:string[]}}
 */
export function validateGoalsLoadGate({ replay, specText } = {}) {
  const gate = validateInterviewExit(replay);
  if (!gate.ok) return gate;
  const events = replay && Array.isArray(replay.events) ? replay.events : null;
  // An exhausted exit owes rows; with no readable ledger there is no event to check them
  // against, and validateAssumptionsCoverage refuses on the null rather than passing.
  const ev = events ? ([...events].reverse().find((e) => e && e.type === 'interview_end') ?? null) : null;
  const cover = validateAssumptionsCoverage({ endEvent: ev, specText, exit: gate.exit });
  if (!cover.ok) return cover;
  return { ok: true, exit: gate.exit, reason: gate.reason ?? null, assumed: cover.required ?? [] };
}
