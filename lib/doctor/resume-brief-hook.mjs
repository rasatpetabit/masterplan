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

// Strip comments: '#' at line start or preceded by whitespace, outside double quotes.
// A backslash inside double quotes escapes the next character (so an escaped quote
// does not toggle the quote state).
function stripComments(rawLine) {
  let line = '';
  let inQuotes = false;
  for (let i = 0; i < rawLine.length; i++) {
    const ch = rawLine[i];
    if (ch === '\\' && inQuotes) {
      // escaped character: keep both backslash and next char, skip next
      line += ch;
      if (i + 1 < rawLine.length) {
        line += rawLine[i + 1];
        i++; // skip next
      }
      continue;
    }
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === '#' && !inQuotes && (i === 0 || /\s/.test(rawLine[i - 1]))) {
      break;
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

// Extract the `command` of every `[rules.<name>]` table whose `events` include session_start
// (the real fleet policy shape). Only those rules and their command strings matter; anything
// else in the file is ignored.
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
    // rule header: [rules.<name>]
    const headerMatch = trimmed.match(/^\[rules\.[A-Za-z0-9_.-]+\]$/);
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
    // events line: collect every "quoted" string inside the brackets
    if (trimmed.startsWith('events')) {
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        let valuePart = trimmed.slice(eq + 1).trim();
        // if the array spans multiple lines, keep appending until we see the closing ']'
        while (!valuePart.includes(']') && i + 1 < lines.length) {
          i++;
          const nextLine = stripComments(lines[i]);
          valuePart += ' ' + nextLine.trim();
        }
        const re = /"([^"]*)"/g;
        let m;
        while ((m = re.exec(valuePart)) !== null) {
          current.events.push(m[1]);
        }
      }
      i++;
      continue;
    } else if (trimmed.startsWith('command')) {
      const eq = trimmed.indexOf('=');
      if (eq !== -1) {
        const valuePart = trimmed.slice(eq + 1).trim();
        const m = valuePart.match(/^"((?:[^"\\]|\\.)*)"$/);
        if (m) {
          // unescape \" and \\
          let cmd = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          current.command = cmd;
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

  const commands = sessionStartCommands(text);
  // "Invokes resume-brief" means the verb token is the command itself or immediately follows the
  // masterplan binary (`mp`, `.../mp`, `.../masterplan.mjs`) — an echoed or quoted mention is not a hook.
  const invokesResumeBrief = (tokens) => tokens.some((t, i) =>
    t === 'resume-brief' && (i === 0 || /(^|\/)(mp|masterplan\.mjs)$/.test(tokens[i - 1])));
  const resumeBrief = commands.filter((c) => invokesResumeBrief(tokenizeCommand(c)));

  if (resumeBrief.some((c) => tokenizeCommand(c).some((t) => t === '--repo-root' || t.startsWith('--repo-root=')))) {
    return [{ id: ID, severity: 'PASS', summary: 'SessionStart hook invokes resume-brief with --repo-root', fix: null }];
  }

  if (resumeBrief.length > 0) {
    return [{
      id: ID, severity: 'WARN',
      summary: 'SessionStart hook invokes resume-brief without --repo-root',
      fix: `add --repo-root to the resume-brief command in the [rules.resume_brief] table in ${policyPath}`,
    }];
  }

  return [{
    id: ID, severity: 'WARN',
    summary: 'no SessionStart hook rule invokes resume-brief',
    fix: `add a [rules.resume_brief] table with events = ["session_start"] and command = "node <installed mp> resume-brief --repo-root=$CWD" to ${policyPath}`,
  }];
}
