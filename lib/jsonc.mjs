/**
 * lib/jsonc.mjs — string-aware JSONC parsing.
 *
 * Two production readers of agent-dispatch's `dispatch-policy.jsonc`
 * (lib/dispatch-wave.mjs and lib/doctor/adversary-lane-health.mjs) each carried
 * their own comment stripper built from the pair
 *
 *     .replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
 *
 * which only removes comments that occupy a WHOLE line. A trailing comment —
 * valid JSONC, and the natural way to annotate a route —
 *
 *     "dispatch-sol-edit": "gpt-5.6-sol", // why this lane exists
 *
 * survives the strip and makes JSON.parse throw. Both call sites catch and
 * fall back to an empty value, so the failure is SILENT: dispatch-wave hands
 * every task `agent: null`, and the doctor reports the adversary lane as having
 * no backends configured. Neither says why.
 *
 * A sibling variant elsewhere used `/\/\/.*$/gm` — `//` ANYWHERE, not just at
 * line start — which additionally truncates any string containing `//`, such as
 * an `api_base` URL, mid-literal.
 *
 * Both hazards were latent (the policy file happens to contain neither today),
 * which is exactly why they warranted fixing rather than waiting: the first
 * inline comment or endpoint URL added to that file would have degraded wave
 * dispatch with no error surfaced. Swept 2026-08-05.
 *
 * This is a local implementation rather than an import: agent-dispatch owns the
 * canonical `parseJsonc` (packages/core/policy.mjs) but lives in a separate
 * repo that masterplan reaches only through the `agent-dispatch` CLI, so a
 * module import would create a source dependency that neither repo declares.
 */

/**
 * Strip JSONC comments, preserving comment-like sequences inside string
 * literals, then drop trailing commas.
 *
 * @param {string} text
 * @returns {string} JSON-parseable text
 */
export function stripJsonc(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      // A backslash escapes the next character, including a quote — consume both
      // so an escaped quote does not appear to close the string.
      if (ch === '\\') { out += next ?? ''; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      // Space-fill rather than splice: a spliced-out comment joins its neighbours,
      // so malformed input like {"n":1/*x*/2} would become the VALID {"n":12}
      // instead of being rejected. Matches the canonical agent-dispatch parser.
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' || text[i] === '\r' ? text[i] : ' ';
        i++;
      }
      if (i >= text.length) throw new SyntaxError('Unterminated block comment in JSONC input');
      i++;
      out += '  ';
      continue;
    }
    out += ch;
  }
  return stripTrailingCommas(out);
}

/**
 * Remove commas that immediately precede a `}` or `]`, skipping string literals.
 *
 * A plain `out.replace(/,(\s*[}\]])/g, '$1')` also rewrites the INSIDE of string
 * values: `{ "s": "a, ]" }` became `{ "s": "a ]" }`, silently corrupting data
 * rather than failing. Caught by test/jsonc.test.mjs. This mirrors the
 * string-aware approach agent-dispatch's canonical parser already uses.
 *
 * @param {string} text
 * @returns {string}
 */
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue; // drop the comma, keep the whitespace
    }
    out += ch;
  }
  return out;
}

/**
 * Parse JSONC text (line comments, block comments, trailing commas).
 *
 * @param {string} text
 * @returns {unknown}
 */
export function parseJsonc(text) {
  if (typeof text !== 'string') throw new TypeError('parseJsonc expected a string');
  return JSON.parse(stripJsonc(text));
}
