// lib/amend.mjs — pure writer for the `## Amendments` section of plan.md (F2, planf3-ideas).
//
// The `mp amend-plan` bin verb (bin/masterplan.mjs) owns ALL fs / clock / event / render I/O; this
// module is a PURE writer mirroring lib/goals.mjs / lib/gate-review.mjs purity — NO fs, NO process,
// NO clock, NO imports. Given the current plan.md text, a single-line summary, an optional (possibly
// multiline) detail body, the ISO date (injected by the bin — purity: no clock here), and the
// bundle's archived flag, it returns either a refusal { ok:false, error } or
// { ok:true, planText:<new text>, event:{ type:'plan_amended', summary } }.
//
// Section / escaping scheme (chosen so the render subsystem — lib/plan-merge.mjs — can parse the
// block UNAMBIGUOUSLY):
//   • The section heading is exactly `## Amendments` (AMENDMENTS_HEADING / AMENDMENTS_HEADING_RE).
//   • Each entry is a level-3 heading `### <ISO date> — <summary>` (em dash U+2014), newest LAST.
//   • Detail lines beginning with `#` are escaped with a leading backslash on write
//     (escapeDetailLine) so a detail line can NEVER be mistaken for an entry heading (`###`) or a
//     section boundary heading (`#` / `##`); the renderer reverses this with unescapeDetailLine.
//   • The section runs from `## Amendments` to the next level-1/level-2 heading (`# ` / `## `) or EOF.

// The canonical Amendments section heading.
export const AMENDMENTS_HEADING = '## Amendments';

// Matches the amendments section heading line (whole line).
export const AMENDMENTS_HEADING_RE = /^##\s+Amendments\s*$/;

// Matches an entry heading `### <date> — <summary>`; group 1 = date, group 2 = summary.
export const AMENDMENT_ENTRY_RE = /^###\s+(.+?)\s+—\s+(.*)$/;

// A level-1 or level-2 heading line — the boundary that ends the amendments section (NOT `###`).
const SECTION_BOUNDARY_RE = /^#{1,2} \S/;

// Escape a single detail line: prefix a backslash to any line beginning with `#` so it can't be
// parsed as a heading inside the amendments block. Reversible via unescapeDetailLine.
export function escapeDetailLine(line) {
  return /^#/.test(line) ? '\\' + line : line;
}

// Reverse escapeDetailLine: strip a single leading backslash before a `#`.
export function unescapeDetailLine(line) {
  return /^\\#/.test(line) ? line.slice(1) : line;
}

// Escape a whole (possibly multiline) detail body line-by-line.
export function escapeDetail(detail) {
  return String(detail).split('\n').map(escapeDetailLine).join('\n');
}

function buildEntry(date, summary, escapedDetail) {
  const head = `### ${date} — ${summary}`;
  return escapedDetail === '' ? head : `${head}\n${escapedDetail}`;
}

/**
 * Pure amend-plan writer.
 *
 * @param {object} input
 * @param {string|null|undefined} input.planText  current plan.md content (null/undefined == absent)
 * @param {string} input.summary                  single-line, non-empty, no leading `#`
 * @param {string} [input.detail]                 optional, may be multiline (`#` lines escaped on write)
 * @param {string} input.date                     ISO date string, injected by the bin (no clock here)
 * @param {boolean} [input.archived]              true == bundle archived (refuse)
 * @returns {{ok:true, planText:string, event:{type:'plan_amended', summary:string}} | {ok:false, error:string}}
 */
export function amendPlan({ planText, summary, detail = '', date, archived = false } = {}) {
  const fail = (error) => ({ ok: false, error });

  // Preconditions: the run must be open and have a plan to amend.
  if (archived === true) return fail('refusing to amend: the bundle is archived (the run is closed)');
  if (typeof planText !== 'string') return fail('refusing to amend: plan.md is absent (nothing to amend)');

  // Summary hygiene — a bad summary would corrupt the heading structure the renderer parses.
  if (typeof summary !== 'string' || summary.trim() === '') {
    return fail('refusing to amend: summary must be a non-empty single line');
  }
  if (/[\r\n]/.test(summary)) {
    return fail('refusing to amend: summary must be a single line (no newlines)');
  }
  const trimmedSummary = summary.trim();
  if (trimmedSummary.startsWith('#')) {
    return fail('refusing to amend: summary must not begin with `#` (would corrupt the heading structure)');
  }

  if (typeof date !== 'string' || date.trim() === '') {
    return fail('refusing to amend: an ISO date is required');
  }

  // Escape detail; drop trailing whitespace/blank lines so entries stay tightly spaced.
  const rawDetail = detail == null ? '' : detail;
  const escapedDetail = escapeDetail(rawDetail).replace(/\s*$/, '');

  const entry = buildEntry(date.trim(), trimmedSummary, escapedDetail);

  let newText;
  const lines = planText.split('\n');
  const headingIdx = lines.findIndex((l) => AMENDMENTS_HEADING_RE.test(l));

  if (headingIdx === -1) {
    // First use — create the section at EOF (one blank line separating it from prior content).
    const base = planText.replace(/\s*$/, '');
    newText = (base === '' ? '' : base + '\n\n') + `${AMENDMENTS_HEADING}\n\n${entry}\n`;
  } else {
    // Append newest-last: find the section end (next level-1/2 heading or EOF), then step back past
    // trailing blank lines so the new entry lands right after the last existing one.
    let end = lines.length;
    for (let k = headingIdx + 1; k < lines.length; k++) {
      if (SECTION_BOUNDARY_RE.test(lines[k])) { end = k; break; }
    }
    let insertAt = end;
    while (insertAt - 1 > headingIdx && lines[insertAt - 1].trim() === '') insertAt--;
    lines.splice(insertAt, 0, '', ...entry.split('\n'));
    newText = lines.join('\n');
  }
  // Normalize to a single trailing newline.
  newText = newText.replace(/\s*$/, '') + '\n';

  return { ok: true, planText: newText, event: { type: 'plan_amended', summary: trimmedSummary } };
}
