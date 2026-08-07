#!/usr/bin/env node
// Minimal agent-dispatch serve-mcp stub: answers initialize + tools/call(dispatch_review)
// with a canonical reject record. Used by bin-level native-review ordering tests.
import readline from 'node:readline';

const rejectRecord = {
  final_verdict: 'reject',
  findings: [{ severity: 'high', summary: 'introduces a data race' }],
  blocking_findings: [{ summary: 'introduces a data race', proof: 'data race' }],
  summary: 'blocking data race',
  harness: {
    degraded: false, timed_out: false, stalled: false,
    deadline_exceeded: false, regions_unreviewed: 0, extraction_degraded: false,
  },
};

const cmd = process.argv[2];
if (cmd !== 'serve-mcp') {
  process.stderr.write(`fake-broker: unknown command ${cmd}\n`);
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch { return; }
  if (msg.method === 'notifications/initialized') return;
  if (msg.id == null) return;
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-broker', version: '0' } },
    }) + '\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    const payload = name === 'dispatch_review' ? rejectRecord : { error: `unexpected tool ${name}` };
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: msg.id,
    error: { code: -32601, message: `Method not found: ${msg.method}` },
  }) + '\n');
});
