/**
 * lib/retro-goals.mjs — Pure retro goal-verdict table renderer
 *
 * Constraints:
 * - Pure functions only; no fs, no process, no clock.
 * - Reuses goal parsing/model from lib/goals.mjs.
 * - Unit-testable; deterministic output based on input.
 */

import { parseGoals, GOAL_VERDICTS } from './goals.mjs';
import { classifyCompletion } from './finish.mjs';

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

// ---------------------------------------------------------------------------
// Completion + archive-push summary (task 30): derived from DURABLE state + events.
// ---------------------------------------------------------------------------

/**
 * The run's completion class, read from durable state exactly as §7.4 writes it at archive.
 *
 * This is a thin RE-EXPORT of the canonical lib/finish.mjs classifyCompletion — the archive
 * guard's own classifier — so the retro renderer and the archive can never disagree (adversary
 * r1 finding 2: the previous hand-maintained copy was a define-once violation).
 *
 * @param {object} [state] - The bundle state (durable).
 * @returns {string} 'complete' | 'merged' | 'incomplete:<reason>' | 'legacy'
 */
export const classifyCompletionForRetro = classifyCompletion;

/**
 * The archive publication state, read from durable events: `archive_pushed {sha}` is the ONE
 * event that flips a local archive to pushed: yes; a `pushed: yes` claim before it would
 * pretend to a visibility the archive does not have (the §7.2 push_archive contract, and the
 * same rule `runs list` / `status` enforce). `archive_push_skipped {reason}` records a decline.
 *
 * @param {Array} [events] - The parsed event log (same shape renderRetroGoals consumes).
 * @returns {{ pushed: 'yes'|'no', sha: string|null, declined: string|null }}
 */
export function archivePushedState(events = []) {
  const evs = Array.isArray(events) ? events : [];
  // Adversary r1 finding 3: FIRST terminal answer is authoritative. A scan forward that takes
  // the first archive_pushed / archive_push_skipped matches the wave-7 conflict rule (the first
  // terminal answer on the ledger wins; a later opposite-type record is a contradiction the
  // writer already refuses). The previous implementation selected the latest of each type and
  // always let archive_pushed win, so an authoritative earlier decline followed by a later
  // pushed record would render pushed: yes — the exact reversal the conflict rule forbids.
  for (const e of evs) {
    if (e && e.type === 'archive_pushed') {
      return {
        pushed: 'yes',
        sha: typeof e.sha === 'string' ? e.sha : null,
        declined: null,
      };
    }
    if (e && e.type === 'archive_push_skipped') {
      return {
        pushed: 'no',
        sha: null,
        declined: typeof e.reason === 'string' ? e.reason : null,
      };
    }
  }
  return { pushed: 'no', sha: null, declined: null };
}

/**
 * Renders the durable completion + archive-push summary block for retro.md.
 *
 * Pure and deterministic: derives the completion class from state.completion (as §7.4 writes
 * it at archive) and the pushed state from the archive_pushed / archive_push_skipped events,
 * so a local archive without an archive_pushed event is visibly `pushed: no`.
 *
 * @param {object} input
 * @param {object} [input.state] - The bundle state.
 * @param {Array} [input.events] - The parsed event log.
 * @returns {string} The rendered markdown block (no trailing newline), or '' when there is no
 *   state to render.
 */
export function renderRetroSummary(input = {}) {
  const { state, events } = input;
  if (!state || typeof state !== 'object') return '';

  const completion = classifyCompletionForRetro(state);
  const pub = archivePushedState(events);

  const lines = ['## Completion', ''];
  if (completion === 'legacy') {
    lines.push('**Completion:** legacy (pre-v10 archive with no completion class)');
  } else {
    lines.push(`**Completion:** ${completion}`);
  }
  if (pub.pushed === 'yes') {
    lines.push(`**Pushed to origin:** yes${pub.sha ? ` (${pub.sha.slice(0, 12)})` : ''}`);
  } else if (pub.declined) {
    lines.push(`**Pushed to origin:** no (declined: ${escapeCell(pub.declined)})`);
  } else {
    lines.push('**Pushed to origin:** no');
  }

  return lines.join('\n');
}

/**
 * Idempotently upsert the `## Completion` block into an existing retro.md body (adversary
 * r1 finding 1's write-side counterpart to renderRetroSummary).
 *
 * The `write_retro` op runs BEFORE disposition/deployment/completion/archive/push, so the retro
 * the shell creates at that point has no completion block (the renderer needs state.completion
 * and the archive_pushed events, neither of which exist yet). The machine therefore re-upserts
 * this block IN PLACE after archive and again after the push_archive answer lands — updating the
 * EXISTING retro.md's `## Completion` section (or appending it) without touching the goal
 * verdict table above it.
 *
 * Idempotent: an existing `## Completion` block (to the next `## ` or `### ` heading, or EOF) is
 * replaced wholesale; absent, the block is appended. Re-entry after a crash re-upserts the same
 * block to the same bytes, so it never duplicates. A body with no such block gains it at the
 * end, matching the write-if-absent creation rule (the machine never creates the file here — it
 * only updates one the shell wrote).
 *
 * @param {string} [retroText] - The current retro.md body (may be '' or absent → append-only).
 * @param {object} input - The same input renderRetroSummary accepts ({state, events}).
 * @returns {string} The updated retro.md body (the block, replaced or appended, with a
 *   single trailing newline). Returns retroText unchanged when there is no state to render.
 */
export function upsertRetroCompletion(retroText, input = {}) {
  const block = renderRetroSummary(input);
  if (block === '') return retroText ?? '';
  const body = retroText ?? '';
  const blockText = `${block}\n`;
  // Line-based, deterministic: locate the `## Completion` heading line, drop the block it heads
  // (through the next `## `/`### ` heading or EOF), then rebuild with the fresh block.
  const lines = body.split('\n');
  let headingIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^## Completion\s*$/.test(lines[i])) { headingIdx = i; break; }
  }
  if (headingIdx === -1) {
    // Append. Markdown headings need a blank line before them.
    let sep;
    if (body === '') sep = '';
    else if (body.endsWith('\n\n')) sep = '';
    else if (body.endsWith('\n')) sep = '\n';
    else sep = '\n\n';
    return `${body}${sep}${blockText}`;
  }
  // Remove the old block and any immediately surrounding blank lines so the rebuild is stable.
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^(##|###) /.test(lines[i])) { endIdx = i; break; }
  }
  // Drop blank lines just inside the block region (between the heading and the next heading).
  const blockRegion = lines.slice(headingIdx, endIdx);
  const nonBlankBlock = blockRegion.filter((l) => l.trim() !== '');
  const removed = [...nonBlankBlock, ...lines.slice(endIdx)];
  // Rebuild: prefix (trimmed of trailing blanks) + blank + block + blank + suffix.
  const prefix = lines.slice(0, headingIdx);
  while (prefix.length && prefix[prefix.length - 1].trim() === '') prefix.pop();
  const suffix = lines.slice(endIdx);
  while (suffix.length && suffix[0].trim() === '') suffix.shift();
  const prefixText = prefix.join('\n');
  const suffixText = suffix.join('\n');
  const out = [
    prefixText,
    '',
    blockText.trimEnd(),
    '',
    suffixText,
  ].filter((seg, i, arr) => !(seg === '' && (i === 0 || i === arr.length - 1 || arr[i - 1] === ''))).join('\n') + '\n';
  // The filter above keeps a single blank separator between non-empty sections; a leading or
  // trailing blank is dropped; consecutive blanks are collapsed to one.
  return out;
}

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
