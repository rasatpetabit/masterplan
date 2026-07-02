/**
 * lib/retro-goals.mjs — Pure retro goal-verdict table renderer
 *
 * Constraints:
 * - Pure functions only; no fs, no process, no clock.
 * - Reuses goal parsing/model from lib/goals.mjs.
 * - Unit-testable; deterministic output based on input.
 */

import { parseGoals, GOAL_VERDICTS } from './goals.mjs';

/**
 * Returns the data object of the last event of the specified type.
 * Handles both canonical wrapped events (`{type, ts, data:{...}}`) and flattened/pre-parsed test records.
 *
 * @param {Array} events - The event log.
 * @param {string} type - The event type to search for.
 * @returns {object|null} The data object of the last matching event, or null.
 */
export function latestEventData(events, type) {
  if (!Array.isArray(events)) return null;

  let lastData = null;

  for (const ev of events) {
    // Match on top-level type field
    if (ev && ev.type === type) {
      // Prefer ev.data if it is a non-null object; otherwise fall back to ev itself
      if (ev.data && typeof ev.data === 'object') {
        lastData = ev.data;
      } else {
        lastData = ev;
      }
    }
  }

  return lastData;
}

/**
 * Escapes a value for safe inclusion in a markdown table cell.
 * Coerces to string, replaces `|` with `\|`, collapses whitespace runs to single space, trims.
 * Undefined/null returns `—`.
 *
 * @param {*} value - The value to escape.
 * @returns {string} The escaped string.
 */
export function escapeCell(value) {
  if (value === undefined || value === null) {
    return '—';
  }

  let s = String(value);

  // Replace pipe characters
  s = s.replace(/\|/g, '\\|');

  // Collapse any run of newline/CR/tab/space whitespace into a single space
  s = s.replace(/[\n\r\t ]+/g, ' ');

  return s.trim();
}

/**
 * Renders the mandatory per-goal verdict table for retro.md.
 *
 * @param {object} input - The input object.
 * @param {boolean} input.goalsEnabled - Bundle-level capability marker.
 * @param {Array} [input.goals] - Goal model array.
 * @param {string} [input.goalsMd] - Markdown string to parse if goals array is missing/empty.
 * @param {Array} [input.events] - Event log.
 * @returns {string} The rendered markdown section.
 */
export function renderRetroGoals(input) {
  const { goalsEnabled, goals, goalsMd, events } = input;

  // If goals are not enabled, return empty string (no section)
  if (!goalsEnabled) {
    return '';
  }

  // Resolve goals list
  let resolvedGoals = [];

  if (Array.isArray(goals) && goals.length > 0) {
    resolvedGoals = goals;
  } else if (goalsMd) {
    const parsed = parseGoals(goalsMd);
    if (Array.isArray(parsed.goals) && parsed.goals.length > 0) {
      resolvedGoals = parsed.goals;
    }
  }

  // Determine latest goal_check and goal_waived events
  const checkEvent = latestEventData(events, 'goal_check');
  const waivedEvent = latestEventData(events, 'goal_waived');

  // Extract verdicts map: keyed by goal id -> {verdict, evidence}
  const verdictsMap = (checkEvent && checkEvent.verdicts) ? checkEvent.verdicts : {};

  // Extract waiver reasons map: keyed by goal id -> reason string
  const waiverReasonsMap = (waivedEvent && waivedEvent.reasons) ? waivedEvent.reasons : {};

  // Split goals into active and tombstoned
  const activeGoals = [];
  const tombstonedGoals = [];

  for (const goal of resolvedGoals) {
    if (goal.tombstone) {
      tombstonedGoals.push(goal);
    } else {
      activeGoals.push(goal);
    }
  }

  // Build the output parts
  const parts = [];

  // Heading
  parts.push('## Goal verdicts');
  parts.push('');

  // Edge case: Zero goals total
  if (activeGoals.length === 0 && tombstonedGoals.length === 0) {
    parts.push('_No goals were recorded for this run._');
    return parts.join('\n');
  }

  // Render table if there are active goals
  if (activeGoals.length > 0) {
    // Table Header
    parts.push('| Goal | Statement | Verdict | Evidence | Waiver |');
    parts.push('| --- | --- | --- | --- | --- |');

    // Table Rows
    for (const goal of activeGoals) {
      const id = goal.id;
      const text = goal.text;

      // Verdict
      let verdictRaw = '—';
      const vEntry = verdictsMap[id];
      if (vEntry && vEntry.verdict && GOAL_VERDICTS.includes(vEntry.verdict)) {
        verdictRaw = vEntry.verdict;
      }

      // Evidence
      let evidenceRaw = '—';
      if (vEntry && vEntry.evidence !== undefined && vEntry.evidence !== null) {
        evidenceRaw = vEntry.evidence;
      }

      // Waiver
      let waiverRaw = '—';
      if (waiverReasonsMap[id] !== undefined) {
        waiverRaw = `waived: ${waiverReasonsMap[id]}`;
      }

      // Escape cells
      // Note: The defaults (em dashes) are set BEFORE escaping.
      // escapeCell handles the actual string content.
      const cellId = escapeCell(id);
      const cellText = escapeCell(text);
      const cellVerdict = escapeCell(verdictRaw);
      const cellEvidence = escapeCell(evidenceRaw);
      const cellWaiver = escapeCell(waiverRaw);

      parts.push(`| ${cellId} | ${cellText} | ${cellVerdict} | ${cellEvidence} | ${cellWaiver} |`);
    }
  }

  // Append tombstoned goals section if present
  if (tombstonedGoals.length > 0) {
    parts.push('');
    parts.push('### Tombstoned goals');

    for (const goal of tombstonedGoals) {
      const id = goal.id;
      const reason = goal.tombstone.reason;

      let reasonStr = '(no reason recorded)';
      if (reason !== undefined && reason !== null) {
        // Escape the reason with whitespace-collapsing, keep inline
        reasonStr = escapeCell(reason);
      }

      parts.push(`- **${id}** — ${reasonStr}`);
    }
  }

  // Join with \n, no trailing newline
  return parts.join('\n');
}
