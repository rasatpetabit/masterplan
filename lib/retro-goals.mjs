/**
 * lib/retro-goals.mjs — Pure retro completion/archive-push summary renderer
 *
 * Historical name (kept: the module is imported from lib/finish-step.mjs at the two §2c
 * milestones): the per-goal verdict table that used to live beside these helpers is gone —
 * the enumerated goal blocks are removed, and the retro renders the run's completion class
 * and push state, which are derived from durable state + events alone.
 *
 * Constraints:
 * - Pure functions only; no fs, no process, no clock.
 * - Reuses the completion classifier from lib/finish.mjs.
 * - Unit-testable; deterministic output based on input.
 */

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
 * @param {Array} [events] - The parsed event log.
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
