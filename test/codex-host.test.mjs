// test/codex-host.test.mjs — Codex-host detection + shell-trap recovery.
// Pure functions (signals/input injected); the `$masterplan` shell-trap
// normalization is a correctness invariant carried from v7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectHost, normalizeResumeHint, CODEX_ENTRYPOINT } from '../lib/dispatch/index.mjs';

test('detectHost: no signals -> not codex', () => {
  const h = detectHost({});
  assert.equal(h.isCodex, false);
  assert.deepEqual(h.reasons, []);
});
test('detectHost: agent-id signal', () => {
  const h = detectHost({ agentIsCodex: true });
  assert.equal(h.isCodex, true);
  assert.ok(h.reasons.includes('agent-id'));
});
test('detectHost: native-tools signal (apply_patch/update_plan/request_user_input)', () => {
  const h = detectHost({ codexNativeTools: true });
  assert.equal(h.isCodex, true);
  assert.ok(h.reasons.includes('native-tools'));
});
test('detectHost: AGENTS.md alone is corroborating only -> NOT codex (2026-07-15 false-positive fix)', () => {
  const h = detectHost({ agentsMdPresent: true });
  assert.equal(h.isCodex, false);
  assert.deepEqual(h.reasons, ['agents-md']);
});
test('detectHost: multiple signals -> all reasons, ordered', () => {
  const h = detectHost({ agentIsCodex: true, codexNativeTools: true, agentsMdPresent: true });
  assert.equal(h.isCodex, true);
  assert.deepEqual(h.reasons, ['agent-id', 'native-tools', 'agents-md']);
});
test('detectHost: agents-md + a strong signal -> codex, agents-md still reported', () => {
  const h = detectHost({ codexNativeTools: true, agentsMdPresent: true });
  assert.equal(h.isCodex, true);
  assert.deepEqual(h.reasons, ['native-tools', 'agents-md']);
});

test('normalizeResumeHint: $masterplan next -> chat form + recovery event', () => {
  const r = normalizeResumeHint('$masterplan next');
  assert.equal(r.recovered, true);
  assert.equal(r.command, 'Use masterplan next');
  assert.equal(r.event, 'shell_invocation_trap_recovered');
});
test('normalizeResumeHint: bare masterplan token', () => {
  assert.equal(normalizeResumeHint('masterplan').command, 'Use masterplan');
});
test('normalizeResumeHint: /masterplan form', () => {
  assert.equal(normalizeResumeHint('/masterplan next').command, 'Use masterplan next');
});
test('normalizeResumeHint: recovers args from a Codex shell transcript (stops at the tag)', () => {
  const t = '<user_shell_command><command>$masterplan execute docs/x/state.yml</command> next: command not found';
  assert.equal(normalizeResumeHint(t).command, 'Use masterplan execute docs/x/state.yml');
});
test('normalizeResumeHint: strips a same-line "command not found" tail', () => {
  assert.equal(normalizeResumeHint('$masterplan next: command not found').command, 'Use masterplan next');
});
test('normalizeResumeHint: unrecoverable input -> recovered false', () => {
  const r = normalizeResumeHint('hello there');
  assert.equal(r.recovered, false);
  assert.equal(r.command, null);
  assert.equal(r.event, null);
});
test('normalizeResumeHint: NEVER emits a raw $masterplan or /masterplan (Codex mangles both)', () => {
  for (const inp of ['$masterplan next', '/masterplan finish', 'masterplan status foo']) {
    const c = normalizeResumeHint(inp).command;
    assert.ok(!c.includes('$masterplan') && !c.includes('/masterplan'), `leaked raw token: ${c}`);
    assert.ok(c.startsWith(CODEX_ENTRYPOINT));
  }
});