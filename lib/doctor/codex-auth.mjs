// lib/doctor/codex-auth.mjs — v8 doctor check (ports v7 #39, Codex auth health).
//
// User-scoped: ignores repoRoot, reads <homeDir>/.codex/auth.json. Auth-mode-aware — a healthy
// ChatGPT auth (auth_mode 'chatgpt' + a refresh_token) short-circuits to PASS, because Codex
// auto-refreshes the id_token on every invocation, so its exp is NOT a health signal for that
// mode (this is the same cosmetic-shape gate v7's CC-2 banner uses). Otherwise it decodes the
// JWT exp claim(s) and warns on expired / expiring-soon / stale-refresh. `now` is injectable
// (opts.now, ms) so the expiry math is deterministic in tests; homeDir is injectable likewise.
// Absent auth.json -> SKIP (Codex simply isn't installed — not a failure). This is WARN-only:
// stale codex auth degrades the optional review path, it never breaks a masterplan run.
import fs from 'node:fs';
import path from 'node:path';

const ID = 'codex-auth';
const DAY = 86400; // seconds
const FIX = 'run `codex login` to refresh credentials';

// Decode a JWT's exp claim (seconds). Returns null when the token isn't a decodable JWT.
function decodeExp(jwt) {
  try {
    const payload = String(jwt).split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

export function check(repoRoot, opts = {}) {
  const homeDir = opts.homeDir ?? process.env.HOME;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const authPath = path.join(homeDir ?? '', '.codex', 'auth.json');

  let auth;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return [{ id: ID, severity: 'SKIP', summary: 'codex not installed (~/.codex/auth.json absent)', fix: null }];
  }

  const tokens = auth.tokens ?? auth;
  if (auth.auth_mode === 'chatgpt' && tokens.refresh_token) {
    return [{ id: ID, severity: 'PASS', summary: 'codex ChatGPT auth healthy (auto-refreshes id_token per invocation)', fix: null }];
  }

  const findings = [];
  for (const name of ['id_token', 'access_token']) {
    const tok = tokens[name];
    if (!tok) continue;
    const exp = decodeExp(tok);
    if (exp === null) {
      findings.push({ id: ID, severity: 'WARN', summary: `codex ${name}: cannot decode exp claim`, fix: FIX });
    } else if (nowSec > exp) {
      findings.push({ id: ID, severity: 'WARN', summary: `codex ${name} expired ${Math.floor((nowSec - exp) / DAY)}d ago`, fix: FIX });
    } else if (exp - nowSec < DAY) {
      findings.push({ id: ID, severity: 'WARN', summary: `codex ${name} expires in <24h`, fix: FIX });
    }
  }

  // Stale refresh (non-chatgpt only): last_refresh older than 30d is a soft warning.
  const lastRefresh = auth.last_refresh ?? tokens.last_refresh;
  if (lastRefresh) {
    const t = Date.parse(lastRefresh);
    if (!Number.isNaN(t)) {
      const ageDays = (nowSec - Math.floor(t / 1000)) / DAY;
      if (ageDays > 30) {
        findings.push({ id: ID, severity: 'WARN', summary: `codex last_refresh ${Math.floor(ageDays)}d ago (> 30d)`, fix: 'consider running `codex login` to refresh' });
      }
    }
  }

  if (findings.length === 0) {
    return [{ id: ID, severity: 'PASS', summary: 'codex auth tokens valid (not expired/expiring)', fix: null }];
  }
  return findings;
}
