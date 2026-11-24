// lib/doctor/resume-brief-hook.mjs — doctor check: the fleet SessionStart hook must invoke
// resume-brief with --repo-root.
//
// External surface: /srv/workflows/hooks/policy.toml (the fleet hook policy). The check reads
// that file when present and looks for a `session_start` rule whose command invokes
// `resume-brief` with `--repo-root`. PASS when such a rule exists; WARN when the file exists
// but no rule matches, or the rule's command lacks `--repo-root`; SKIP (no warning) when the
// policy file is absent.
//
// The production path is a module constant. Tests supply a fixture path through the check's
// internal options object (opts.policyPath) — never a new environment variable or CLI knob.
import fs from 'node:fs';

const ID = 'resume-brief-hook';
const PROD_POLICY_PATH = '/srv/workflows/hooks/policy.toml';

// Strip TOML comments: '#' outside double-quoted basic strings (with '\' escapes)
// and single-quoted literal strings (no escaping).
function stripComments(rawLine) {
  let line = '';
  let quote = null;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (quote === '"') {
      if (ch === '\\') {
        line += ch;
        if (i + 1 < rawLine.length) {
          line += rawLine[i + 1];
          i++;
        }
        continue;
      }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '#') break;
    }
    line += ch;
  }
  return line;
}

// Split a shell command into whitespace-separated tokens, respecting double-quoted
// groups (quotes are stripped from the token content).
function tokenizeCommand(cmd) {
  const tokens = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === '#' && !inQuotes && (current === '' || /[;&|(]$/.test(current))) {
      break; // unquoted `#` at a token boundary (whitespace or a control operator) starts a shell comment
    } else if (/\s/.test(ch) && !inQuotes) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

// Strict TOML basic string starting at s[start] === '"'.
// Supports standard TOML escapes (\", \\, \b, \f, \n, \r, \t, \uXXXX, \UXXXXXXXX)
// and rejects unknown escapes or surrogate/out-of-range Unicode scalars with null.
const TOML_BASIC_ESCAPES = {
  '"': '"',
  '\\': '\\',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function parseTomlBasicString(s, start) {
  if (s[start] !== '"') return null;
  let i = start + 1;
  let str = '';
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 >= s.length) return null;
      const n = s[i + 1];
      if (Object.prototype.hasOwnProperty.call(TOML_BASIC_ESCAPES, n)) {
        str += TOML_BASIC_ESCAPES[n];
        i += 2;
        continue;
      }
      if (n === 'u' || n === 'U') {
        const len = n === 'u' ? 4 : 8;
        const hex = s.slice(i + 2, i + 2 + len);
        if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) return null;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
        str += String.fromCodePoint(cp);
        i += 2 + len;
        continue;
      }
      return null;
    }
    if (ch === '"') return { value: str, next: i + 1 };
    const code = ch.charCodeAt(0);
    if ((code >= 0x00 && code <= 0x08) || (code >= 0x0a && code <= 0x1f) || code === 0x7f) return null;
    str += ch;
    i++;
  }
  return null;
}

// TOML string array: double-quoted basic strings (strict TOML escapes), single-quoted
// literal strings (no escaping), and optional trailing comma. Enforces strict TOML array
// grammar (commas required between elements; no leading/repeated commas; no trailing junk
// after ']'). Returns null when the value is not a valid array of strings.
function parseTomlStringArray(valuePart) {
  const s = String(valuePart ?? '').trim();
  if (!s.startsWith('[')) return null;
  const out = [];
  let i = 1;
  const skipWs = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  while (i < s.length) {
    skipWs();
    if (i >= s.length) return null;
    if (s[i] === ']') {
      i++;
      skipWs();
      return i === s.length ? out : null;
    }
    if (s[i] === '"') {
      const parsed = parseTomlBasicString(s, i);
      if (!parsed) return null;
      out.push(parsed.value);
      i = parsed.next;
    } else if (s[i] === "'") {
      i++;
      let str = '';
      let closed = false;
      while (i < s.length) {
        if (s[i] === "'") { i++; closed = true; break; }
        str += s[i];
        i++;
      }
      if (!closed) return null;
      out.push(str);
    } else {
      return null;
    }
    skipWs();
    if (i >= s.length) return null;
    if (s[i] === ',') {
      i++;
      continue;
    }
    if (s[i] === ']') {
      i++;
      skipWs();
      return i === s.length ? out : null;
    }
    return null;
  }
  return null;
}

function hasClosingBracketOutsideQuotes(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === '"') {
      if (ch === '\\') { i++; continue; }
      if (ch === '"') quote = null;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
    } else {
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ']') return true;
    }
  }
  return false;
}

// Extract the `command` of every `[rules.<name>]` or `[delegate.<name>]` table whose `events`
// include session_start (the real fleet policy shape). Supports both string `command = "..."`
// and argv array `command = ["...", ...]` (single- or double-quoted, trailing commas,
// one line or many). Only those tables and their commands matter;
// anything else in the file is ignored.
function sessionStartCommands(text) {
  const rules = [];
  let current = null;
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const line = stripComments(rawLine);
    const trimmed = line.trim();
    if (!trimmed) { i++; continue; }
    // rule or delegate header: [rules.<name>] or [delegate.<name>]
    const headerMatch = trimmed.match(/^\[(?:rules|delegate)\.[A-Za-z0-9_.-]+\]$/);
    if (headerMatch) {
      if (current) rules.push(current);
      current = { events: [], command: null };
      i++;
      continue;
    }
    // any other [...] header ends the current rule
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (current) rules.push(current);
      current = null;
      i++;
      continue;
    }
    if (!current) { i++; continue; }
    // events line: parse TOML string array
    if (/^events(?:\s|=|$)/.test(trimmed)) {
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        let valuePart = trimmed.slice(eq + 1).trim();
        // if the array spans multiple lines, keep appending until we see the closing ']'
        while (!hasClosingBracketOutsideQuotes(valuePart) && i + 1 < lines.length) {
          i++;
          const nextLine = stripComments(lines[i]);
          valuePart += ' ' + nextLine.trim();
        }
        const arr = parseTomlStringArray(valuePart);
        if (arr) current.events.push(...arr);
      }
      i++;
      continue;
    } else if (/^command(?:\s|=|$)/.test(trimmed)) {
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        let valuePart = trimmed.slice(eq + 1).trim();
        if (valuePart.startsWith('[')) {
          while (!hasClosingBracketOutsideQuotes(valuePart) && i + 1 < lines.length) {
            i++;
            const nextLine = stripComments(lines[i]);
            valuePart += ' ' + nextLine.trim();
          }
          const arr = parseTomlStringArray(valuePart);
          if (arr) current.command = arr;
        } else if (valuePart.startsWith('"')) {
          const parsed = parseTomlBasicString(valuePart, 0);
          if (parsed && parsed.next === valuePart.length) {
            current.command = parsed.value;
          }
        } else {
          const sq = valuePart.match(/^'([^']*)'$/);
          if (sq) {
            current.command = sq[1];
          }
        }
      }
      i++;
      continue;
    }
    i++;
  }
  if (current) rules.push(current);
  // return commands of rules whose events include 'session_start' and have a command
  return rules
    .filter((r) => r.command !== null && r.events.includes('session_start'))
    .map((r) => r.command);
}

export function check(repoRoot, opts = {}) {
  const policyPath = opts.policyPath ?? PROD_POLICY_PATH;

  let text;
  try {
    text = fs.readFileSync(policyPath, 'utf8');
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      return [{
        id: ID, severity: 'WARN',
        summary: `fleet hook policy file present but unreadable (${err.code || err.message}); resume-brief wiring not inspected`,
        fix: `make ${policyPath} readable by the doctor`,
      }];
    }
    // No policy file — the hook is simply not wired. SKIP without a warning: there is nothing
    // to be incomplete about on a host that has not opted into the fleet hook system.
    return [{ id: ID, severity: 'SKIP', summary: 'no fleet hook policy file (resume-brief SessionStart hook not wired)', fix: null }];
  }

  const commands = sessionStartCommands(text).map((c) => (Array.isArray(c) ? c : tokenizeCommand(c)));
  // "Invokes resume-brief" means the verb token is the command itself or immediately follows the
  // masterplan binary (`mp`, `.../mp`, `.../masterplan.mjs`) — an echoed or quoted mention is not a hook.
  const invokesResumeBrief = (tokens) => tokens.some((t, i) =>
    t === 'resume-brief' && (i === 0 || /(^|\/)(mp|masterplan\.mjs)$/.test(tokens[i - 1])));
  const resumeBrief = commands.filter(invokesResumeBrief);

  if (resumeBrief.some((tokens) => tokens.some((t) => t === '--repo-root' || t.startsWith('--repo-root=')))) {
    return [{ id: ID, severity: 'PASS', summary: 'SessionStart hook invokes resume-brief with --repo-root', fix: null }];
  }

  if (resumeBrief.length > 0) {
    return [{
      id: ID, severity: 'WARN',
      summary: 'SessionStart hook invokes resume-brief without --repo-root',
      fix: `add --repo-root=. to the resume-brief command array in the [delegate.masterplan_resume_brief] table in ${policyPath}`,
    }];
  }

  return [{
    id: ID, severity: 'WARN',
    summary: 'no SessionStart hook rule invokes resume-brief',
    fix: `add a [delegate.masterplan_resume_brief] table with events = ["session_start"] and command = ["/home/ras/.local/bin/mp", "resume-brief", "--repo-root=."] to ${policyPath}`,
  }];
}
