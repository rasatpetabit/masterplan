// lib/dispatch/host.mjs — Codex-host dual-targeting, minimized (build step 1; Resolved #6).
//
// detectHost / normalizeResumeHint. The `$masterplan` shell-trap normalization is a
// CORRECTNESS invariant carried from v7
// (v7 parts/codex-host.md — attic hedge deleted when Residual 3B's foreground-sequential
// dispatch landed; see tag v8.1.0-pre-cruft-removal for the text). The bespoke codex_host_perf_guard is dropped in favor of the
// Workflow tool's native `budget`. The /goal bridge stays a shell responsibility (it calls
// Codex-native goal tools at runtime); this module is pure (signals/input injected, no I/O).

// The Codex-safe way to surface a resume hint: NEVER `$masterplan` or `/masterplan` (Codex's
// shell-command mode mangles both — `$masterplan` expands as a variable, `/...` is "not found").
// Always the natural-chat form.
export const CODEX_ENTRYPOINT = 'Use masterplan';

// `signals` are gathered by the shell from its runtime context + file presence:
//   agentIsCodex     — the session identifies the agent as Codex
//   codexNativeTools — Codex-native tools exposed (apply_patch / update_plan / request_user_input)
//   agentsMdPresent  — an AGENTS.md compatibility map is present
export function detectHost(signals = {}) {
  const reasons = [];
  if (signals.agentIsCodex) reasons.push('agent-id');
  if (signals.codexNativeTools) reasons.push('native-tools');
  if (signals.agentsMdPresent) reasons.push('agents-md');
  return { isCodex: reasons.length > 0, reasons };
}

// Matches a masterplan invocation token (optionally shell-trapped as `$masterplan` / `/masterplan`)
// and captures the trailing args, stopping at a newline or transcript tag.
const MP_TOKEN_RE = /(?:^|[\s$/])masterplan\b[ \t]*([^\n<]*)/i;

// Normalize a raw, possibly shell-trapped masterplan invocation into the chat form
// `Use masterplan <args>`. In Codex shell mode `$masterplan next` / `masterplan next` fail as
// "command not found"; we recover the args so the normal verb router can proceed.
export function normalizeResumeHint(input = '') {
  const m = String(input).match(MP_TOKEN_RE);
  if (!m) return { recovered: false, command: null, event: null };
  const args = (m[1] ?? '')
    .replace(/\s*:?\s*command not found.*$/i, '') // drop a same-line shell-error tail
    .trim();
  const command = args ? `${CODEX_ENTRYPOINT} ${args}` : CODEX_ENTRYPOINT;
  return { recovered: true, command, event: 'shell_invocation_trap_recovered' };
}
